const { addonBuilder } = require('stremio-addon-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { MovieDb } = require('moviedb-promise');
require('dotenv').config();

// Global Helpers & Constants (Shared across all users)
const MODEL_POOL = [
    "gemini-flash-latest",
    "gemini-flash-lite-latest",
    "gemini-pro-latest",
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash-image-preview",
    "gemini-2.5-flash-image",
    "gemini-2.5-flash-preview-09-2025",
    "gemini-2.5-flash-lite-preview-09-2025",
    "gemini-3-pro-preview",
    "gemini-3-flash-preview",
    "gemini-2.0-flash-exp",
    "gemini-2.0-flash",
    "gemini-2.0-flash-001",
    "gemini-2.0-flash-lite-001",
    "gemini-2.0-flash-lite",
    "gemini-2.0-flash-lite-preview-02-05",
    "gemini-2.0-flash-lite-preview",
    "gemini-exp-1206",
    "gemini-2.5-flash-preview-tts",
    "gemini-2.5-pro-preview-tts",
    "gemma-3-1b-it",
    "gemma-3-4b-it",
    "gemma-3-12b-it",
    "gemma-3-27b-it",
    "gemma-3n-e4b-it",
    "gemma-3n-e2b-it",
    "gemini-robotics-er-1.5-preview",
    "gemini-2.5-computer-use-preview-10-2025",
    "deep-research-pro-preview-12-2025"
];

const SYSTEM_INSTRUCTION = "You are a sophisticated movie critic and database expert. You MUST return valid, raw JSON without Markdown formatting (no ```json blocks). Never explain your choices, just return data.";

// Global Cache Storage (Multi-Tenant)
// Key: Config Hash (Token), Value: User's Search Cache Map
const GLOBAL_USER_CACHES = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function parseGeminiResponse(text) {
    try {
        let cleanedText = text.replace(/```json/g, '').replace(/```/g, '').replace(/\n/g, '').trim();
        return JSON.parse(cleanedText);
    } catch (e) {
        console.error("Failed to parse Gemini response:", text);
        return [];
    }
}

/**
 * Dynamic Addon Factory
 * @param {Object} config - { tmdb: string, gemini: string[] }
 * @returns {Object} - Stremio Addon Interface
 */
function makeAddon(config) {
    const tmdbKey = config && config.tmdb;
    const apiKeys = config && config.gemini;

    // SKELETON MANIFEST (Fallback for Unconfigured State)
    if (!tmdbKey || !apiKeys || apiKeys.length === 0) {
        const skeletonManifest = {
            id: 'com.gemini.smart.search',
            version: '1.5.0',
            name: 'Gemini AI Search (Configure Me)',
            description: "Please configure this addon with your API keys to enable AI search.",
            types: ['movie', 'series'],
            resources: [], // No resources offered until configured
            catalogs: [], // No catalogs offered until configured
            behaviorHints: {
                configurable: true,
                configurationRequired: true
            }
        };
        const skeletonBuilder = new addonBuilder(skeletonManifest);
        return skeletonBuilder.getInterface();
    }

    // Initialize Clients for this User
    const tmdb = new MovieDb(tmdbKey);

    // Initialize Manifest
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
                    { name: 'search', isRequired: true, options: [] },
                    { name: 'skip', isRequired: false }
                ]
            },
            {
                type: 'series',
                id: 'gemini_search',
                name: 'AI Search: Series',
                extra: [
                    { name: 'search', isRequired: true, options: [] },
                    { name: 'skip', isRequired: false }
                ]
            }
        ],
        behaviorHints: {
            configurable: true,
            configurationRequired: !tmdbKey || apiKeys.length === 0
        }
    };

    const builder = new addonBuilder(manifest);

    // Scoped Cache for this user (based on TMDB Key as ID)
    if (!GLOBAL_USER_CACHES.has(tmdbKey)) {
        GLOBAL_USER_CACHES.set(tmdbKey, new Map());
    }
    const USER_CACHE = GLOBAL_USER_CACHES.get(tmdbKey);

    // Scoped Helpers
    async function getTmdbItem(title, year, type) {
        try {
            // console.log(`[TMDB] Looking up '${title}' (Year: ${year}) Type: ${type}`);
            if (type === 'movie') {
                const safeYear = year ? year.toString().substring(0, 4) : undefined;
                let searchRes = await tmdb.searchMovie({ query: title, year: safeYear });

                if (!searchRes.results || searchRes.results.length === 0) {
                    searchRes = await tmdb.searchMovie({ query: title });
                    if (!searchRes.results || searchRes.results.length === 0) {
                        // console.log(`[TMDB] No results found for '${title}'`);
                        return null;
                    }
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
                const searchRes = await tmdb.searchTv({ query: title });

                if (!searchRes.results || searchRes.results.length === 0) {
                    // console.log(`[TMDB] No results found for '${title}'`);
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
            const findRes = await tmdb.find({ id: imdbId, external_source: 'imdb_id' });
            let tmdbId, item;

            if (type === 'movie' && findRes.movie_results.length > 0) {
                tmdbId = findRes.movie_results[0].id;
                item = await tmdb.movieInfo({ id: tmdbId, append_to_response: 'credits,videos' });
            } else if (type === 'series' && findRes.tv_results.length > 0) {
                tmdbId = findRes.tv_results[0].id;
                item = await tmdb.tvInfo({ id: tmdbId, append_to_response: 'credits,videos,external_ids' });
            } else {
                return null;
            }

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
            console.error(`[META ERROR] Failed to fetch TMDB meta source for ${imdbId}:`, e.message);
            return null;
        }
    }

    async function generateWithRetry(prompt) {
        for (const modelName of MODEL_POOL) {
            for (const apiKey of apiKeys) {
                try {
                    const genAI = new GoogleGenerativeAI(apiKey);
                    const model = genAI.getGenerativeModel({ model: modelName });
                    // console.log(`[GEMINI] Attempting ${modelName} with key ...${apiKey.slice(-4)}`);
                    const result = await model.generateContent(prompt);
                    const response = await result.response;
                    const text = response.text();
                    // console.log(`[GEMINI] Success (${modelName})`);
                    return text;
                } catch (error) {
                    const isQuotaError = error.message.includes('429') || error.message.includes('Quota') || error.message.includes('Too Many Requests');
                    if (isQuotaError) {
                        console.warn(`[LIMIT] Key ...${apiKey.slice(-4)} exhausted on ${modelName}. Switching...`);
                        continue;
                    } else {
                        // console.error(`[GEMINI ERROR] ${modelName} / ...${apiKey.slice(-4)}: ${error.message}`);
                        continue;
                    }
                }
            }
        }
        console.error("[FATAL] All models/keys exhausted.");
        return null;
    }

    // --- Handlers ---

    builder.defineCatalogHandler(async ({ type, id, extra }) => {
        // console.log(`[CATALOG] Request:`, { type, id, extra });
        if (!extra || !extra.search) throw new Error('No search query provided');

        let cleanQuery = extra.search;
        if (cleanQuery.includes('.json')) cleanQuery = cleanQuery.split('.json')[0];
        extra.search = cleanQuery;

        const query = extra.search.toLowerCase();
        const itemLabel = type === 'movie' ? 'movies' : 'TV shows';
        const skip = extra.skip ? parseInt(extra.skip) : 0;
        const PAGE_SIZE = 20;

        // Optimization
        const movieKeywords = ['movie', 'film', 'cinema'];
        const seriesKeywords = ['series', 'show', 'tv', 'season', 'episode'];
        const wantsMovies = movieKeywords.some(w => query.includes(w));
        const wantsSeries = seriesKeywords.some(w => query.includes(w));

        if (wantsMovies && !wantsSeries && type === 'series') return { metas: [] };
        if (wantsSeries && !wantsMovies && type === 'movie') return { metas: [] };

        // Cache Logic
        const cacheKey = `${type}:${query}`;
        let cachedList = [];

        if (USER_CACHE.has(cacheKey)) {
            const cached = USER_CACHE.get(cacheKey);
            if (Date.now() - cached.timestamp < CACHE_TTL) {
                console.log(`[CACHE HIT] Using cached results for '${query}' (${type})`);
                cachedList = cached.items;
            } else {
                USER_CACHE.delete(cacheKey);
            }
        }

        if (cachedList.length === 0) {
            console.log(`[GEMINI] Processing search query: ${extra.search} for type: ${type}`);
            const prompt = `${SYSTEM_INSTRUCTION} 
            The user is searching for **${itemLabel}**. Use the query "${extra.search}" as a semantic guide.
            If it is a mood (e.g., 'sad sci-fi'), find ${itemLabel} that match the atmosphere. 
            If it is a plot description, find the closest matches. 
            Provide a comprehensive list of **20** recommendations. Prioritize relevance but ensure variety.
            Return a strictly valid JSON array of objects with "title" and "year".
            Limit to 20 items.
            Example: [{"title": "Interstellar", "year": "2014"}]`;

            const text = await generateWithRetry(prompt);
            if (!text) return { metas: [] };

            const suggestions = parseGeminiResponse(text);
            if (!Array.isArray(suggestions) || suggestions.length === 0) return { metas: [] };

            console.log(`[GEMINI] Generated ${suggestions.length} items. Caching...`);
            cachedList = suggestions;
            USER_CACHE.set(cacheKey, { timestamp: Date.now(), items: cachedList });
        }

        if (skip >= cachedList.length) return { metas: [] };

        const pageItems = cachedList.slice(skip, skip + PAGE_SIZE);
        // console.log(`[PAGINATION] Resolving items ${skip} to ${skip + PAGE_SIZE}`);

        const metaPromises = pageItems.map(async (item) => {
            return await getTmdbItem(item.title, item.year, type);
        });

        const metas = (await Promise.all(metaPromises)).filter(m => m !== null);
        if (!metas || metas.length === 0) return { metas: [] };
        return { metas: metas };
    });

    builder.defineMetaHandler(async ({ type, id }) => {
        if (!id.startsWith('tt')) return { meta: null };
        try {
            const meta = await getTmdbMeta(type, id);
            return { meta: meta || null };
        } catch (e) {
            console.error(`[META FATAL] ${e.message}`);
            throw e;
        }
    });

    return builder.getInterface();
}

module.exports = makeAddon;
