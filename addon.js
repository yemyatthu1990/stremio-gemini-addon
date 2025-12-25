const { addonBuilder } = require('stremio-addon-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { MovieDb } = require('moviedb-promise');
require('dotenv').config();

// 1. Initialize Gemini & Model Pool
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// Model Rotation Pool (Prioritize by Rate Limit/RPM)
const MODEL_POOL = [
    "gemini-2.5-flash-lite", // High RPM
    "gemini-2.5-flash",           // Medium RPM
    "gemini-3-flash"            // Fallback
];

// 2. Initialize TMDB
const tmdb = new MovieDb(process.env.TMDB_API_KEY || '');

// SYSTEM INSTRUCTION
const SYSTEM_INSTRUCTION = "You are a sophisticated movie critic and database expert. You MUST return valid, raw JSON without Markdown formatting (no ```json blocks). Never explain your choices, just return data.";

// 3. Define Manifest (SEARCH ONLY)
const manifest = {
    id: 'com.gemini.smart.search',
    version: '1.5.0',
    name: 'Gemini AI Search',
    description: "AI-powered Search for Movies & Series. Zero-idle resource usage.",
    types: ['movie', 'series'],
    resources: ['catalog', 'meta'],
    catalogs: [
        {
            type: 'movie',
            id: 'gemini_search',
            name: 'AI Search: Movies',
            extra: [
                { name: 'search', isRequired: true, options: [] }
            ]
        },
        {
            type: 'series',
            id: 'gemini_search',
            name: 'AI Search: Series',
            extra: [
                { name: 'search', isRequired: true, options: [] }
            ]
        }
    ]
};

const builder = new addonBuilder(manifest);

// 4. Helper to parse Gemini JSON output
function parseGeminiResponse(text) {
    try {
        let cleanedText = text.replace(/```json/g, '').replace(/```/g, '').replace(/\n/g, '').trim();
        return JSON.parse(cleanedText);
    } catch (e) {
        console.error("Failed to parse Gemini response:", text);
        return [];
    }
}

// 5. Helper function for TMDB Search
async function getTmdbItem(title, year, type) {
    try {
        console.log(`[TMDB] Looking up '${title}' (Year: ${year}) Type: ${type}`);

        if (type === 'movie') {
            const safeYear = year ? year.toString().substring(0, 4) : undefined;
            const searchRes = await tmdb.searchMovie({ query: title, year: safeYear });

            if (!searchRes.results || searchRes.results.length === 0) {
                console.log(`[TMDB] No results found for '${title}'`);
                return null;
            }

            const item = searchRes.results[0];
            const externalIds = await tmdb.movieExternalIds({ id: item.id });

            if (!externalIds.imdb_id) return null;

            return {
                id: externalIds.imdb_id,
                type: 'movie',
                name: item.title,
                poster: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null,
                description: item.overview,
                releaseInfo: item.release_date ? item.release_date.split('-')[0] : year,
                tmdbId: item.id
            };
        } else {
            // RELAXED SEARCH: Do NOT filter by year for Series (AI often gets ranges wrong)
            const searchRes = await tmdb.searchTv({ query: title });

            if (!searchRes.results || searchRes.results.length === 0) {
                console.log(`[TMDB] No results found for '${title}'`);
                return null;
            }

            const item = searchRes.results[0];
            const externalIds = await tmdb.tvExternalIds({ id: item.id });

            if (!externalIds.imdb_id) return null;

            return {
                id: externalIds.imdb_id,
                type: 'series',
                name: item.name,
                poster: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null,
                description: item.overview,
                releaseInfo: item.first_air_date ? item.first_air_date.split('-')[0] : year,
                tmdbId: item.id
            };
        }
    } catch (e) {
        console.log(`[TMDB ERROR] ${title} (${year}) [${type}]:`, e.message);
        return null;
    }
}

async function getTmdbMeta(type, imdbId) {
    try {
        // 1. Resolve IMDb ID to TMDB ID
        const findRes = await tmdb.find({ id: imdbId, external_source: 'imdb_id' });
        // console.log(`[META] Finding TMDB ID for ${imdbId} (${type})`);

        let tmdbId, item;

        if (type === 'movie' && findRes.movie_results.length > 0) {
            tmdbId = findRes.movie_results[0].id;
            item = await tmdb.movieInfo({ id: tmdbId, append_to_response: 'credits,videos' });
        } else if (type === 'series' && findRes.tv_results.length > 0) {
            tmdbId = findRes.tv_results[0].id;
            item = await tmdb.tvInfo({ id: tmdbId, append_to_response: 'credits,videos,external_ids' });
        } else {
            console.warn(`[META] No TMDB ID found for ${imdbId}`);
            return null;
        }

        // 2. Map to Stremio Meta
        const releaseYear = (item.release_date || item.first_air_date || '').split('-')[0];
        const cast = (item.credits?.cast || []).slice(0, 10).map(c => c.name);
        const genres = (item.genres || []).map(g => g.name);

        return {
            id: imdbId,
            type: type,
            name: item.title || item.name,
            poster: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null,
            background: item.backdrop_path ? `https://image.tmdb.org/t/p/original${item.backdrop_path}` : null,
            description: item.overview,
            releaseInfo: releaseYear,
            genres: genres,
            cast: cast,
            imdbRating: item.vote_average ? item.vote_average.toFixed(1) : undefined
        };
    } catch (e) {
        console.error(`[META ERROR] Failed to fetch TMDB meta for ${imdbId}:`, e.message);
        return null;
    }
}

// 6. Generate Content with Model Rotation
async function generateWithRetry(prompt) {
    for (const modelName of MODEL_POOL) {
        try {
            // console.log(`[GEMINI] Attempting generation with model: ${modelName}`);
            const model = genAI.getGenerativeModel({ model: modelName });
            const result = await model.generateContent(prompt);
            const response = await result.response;
            const text = response.text();

            // If successful, return text
            console.log(`[GEMINI] Success (${modelName})`);
            return text;

        } catch (error) {
            const isQuotaError = error.message.includes('429') || error.message.includes('Quota') || error.message.includes('Too Many Requests');

            if (isQuotaError) {
                console.warn(`[LIMIT] Model ${modelName} exhausted/rate-limited. Switching...`);
                continue; // Try next model
            } else {
                console.error(`[GEMINI ERROR] ${modelName} failed with non-quota error:`, error.message);
                // For critical errors, maybe still try next model? For now, continue safer.
                continue;
            }
        }
    }

    console.error("[FATAL] All models in pool exhausted or failed.");
    return null;
}

// 7. Implement Catalog Handler (SEARCH ONLY)
builder.defineCatalogHandler(async ({ type, id, extra }) => {
    console.log(`[CATALOG] Request:`, { type, id, extra });

    if (!extra || !extra.search) {
        throw new Error('No search query provided');
    }

    // CLEAN THE INPUT: Remove .json extensions and URL parameters Stremio might append
    let cleanQuery = extra.search;
    if (cleanQuery.includes('.json')) {
        cleanQuery = cleanQuery.split('.json')[0];
    }
    // Update the extra object so the rest of the logic uses the clean version
    extra.search = cleanQuery;

    const query = extra.search.toLowerCase();
    const itemLabel = type === 'movie' ? 'movies' : 'TV shows';

    // SMART FILTER: Optimization
    const movieKeywords = ['movie', 'film', 'cinema'];
    const seriesKeywords = ['series', 'show', 'tv', 'season', 'episode'];

    const wantsMovies = movieKeywords.some(w => query.includes(w));
    const wantsSeries = seriesKeywords.some(w => query.includes(w));
    console.log(`[OPTIMIZATION] wantsMovies: ${wantsMovies}, wantsSeries: ${wantsSeries}`);
    // Block logic
    if (wantsMovies && !wantsSeries && type === 'series') {
        console.log(`[OPTIMIZATION] Skipping Series request for movie-focused query: "${extra.search}"`);
        return {
            metas: []
        };
    }
    if (wantsSeries && !wantsMovies && type === 'movie') {
        console.log(`[OPTIMIZATION] Skipping Movie request for series-focused query: "${extra.search}"`);
        return {
            metas: []
        };
    }

    // Prepare Prompt
    console.log(`Processing search query: ${extra.search} for type: ${type}`);
    const prompt = `${SYSTEM_INSTRUCTION} 
    The user is searching for **${itemLabel}**. Use the query "${extra.search}" as a semantic guide.
    If it is a mood (e.g., 'sad sci-fi'), find ${itemLabel} that match the atmosphere. 
    If it is a plot description, find the closest matches. 
    Return 10 ${itemLabel}.
    Return a strictly valid JSON array of objects with "title" and "year".
    Example: [{"title": "Interstellar", "year": "2014"}]`;

    // Execute with Retry
    const text = await generateWithRetry(prompt);

    if (!text) {
        return {
            metas: []
        };
    }

    const suggestions = parseGeminiResponse(text);

    if (!Array.isArray(suggestions)) {
        return {
            metas: []
        };
    }

    if (!process.env.TMDB_API_KEY) {
        console.error("TMDB_API_KEY is missing.");
        throw new Error('Configuration Error: TMDB_API_KEY missing');
    }

    // Resolve TMDB
    const metaPromises = suggestions.map(async (item) => {
        const filledItem = await getTmdbItem(item.title, item.year, type);
        if (filledItem) {
            console.log(`[MATCH] Gemini suggested "${item.title} (${item.year})" -> Found TMDB ID: ${filledItem.tmdbId}`);
            return filledItem;
        } else {
            console.log(`[MISS] Could not resolve "${item.title} (${item.year})"`);
            return null;
        }
    });

    const metas = (await Promise.all(metaPromises)).filter(m => m !== null);

    if (!metas || metas.length === 0) {
        return {
            metas: []
        };
    }

    return { metas: metas };
});

// 8. Implement Meta Handler
// 8. Implement Meta Handler
builder.defineMetaHandler(async ({ type, id }) => {
    // console.log(`[META] Request for ${type} ${id}`);

    if (!id.startsWith('tt')) {
        return { meta: null };
    }

    try {
        const meta = await getTmdbMeta(type, id);
        if (meta) {
            return { meta };
        } else {
            // If we couldn't find it, throwing error is safer for Stremio to fallback or show error
            // But returning null meta is also spec compliant for "not found"
            return { meta: null };
        }
    } catch (e) {
        console.error(`[META FATAL] ${e.message}`);
        throw e;
    }
});

module.exports = builder.getInterface();
