const { addonBuilder } = require('stremio-addon-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { MovieDb } = require('moviedb-promise');
require('dotenv').config();

// 1. Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
// Use user-specified model
const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });

// 2. Initialize TMDB
const tmdb = new MovieDb(process.env.TMDB_API_KEY || '');

// SYSTEM INSTRUCTION
const SYSTEM_INSTRUCTION = "You are a sophisticated movie critic and database expert. You MUST return valid, raw JSON without Markdown formatting (no ```json blocks). Never explain your choices, just return data.";

// 3. Define Manifest
const manifest = {
    id: 'com.gemini.smart.search',
    version: '1.2.1',
    name: 'Gemini AI Search',
    description: "Multi-context AI recommendations: Time of day, Reddit hits, and Random surprises.",
    types: ['movie', 'series'],
    resources: ['catalog', 'meta'],
    catalogs: [
        // Search
        {
            type: 'movie',
            id: 'gemini_search_movie',
            name: 'Gemini Movies: Search',
            extra: [{ name: 'search', isRequired: true }]
        },
        {
            type: 'series',
            id: 'gemini_search_series',
            name: 'Gemini Series: Search',
            extra: [{ name: 'search', isRequired: true }]
        },
        // Time Context
        {
            type: 'movie',
            id: 'gemini_time_context',
            name: 'Gemini Movies: Day & Night',
            extra: []
        },
        {
            type: 'series',
            id: 'gemini_time_context',
            name: 'Gemini Series: Day & Night',
            extra: []
        },
        // Reddit Trending
        {
            type: 'series',
            id: 'gemini_reddit_trending',
            name: 'Reddit Favorites: Series',
            extra: []
        },
        {
            type: 'movie',
            id: 'gemini_reddit_trending',
            name: 'Reddit Favorites: Movies',
            extra: []
        },
        // Surprise
        {
            type: 'movie',
            id: 'gemini_surprise',
            name: 'Surprise Movies',
            extra: []
        },
        {
            type: 'series',
            id: 'gemini_surprise',
            name: 'Surprise Series',
            extra: []
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

// 6. Implement Catalog Handler
builder.defineCatalogHandler(async ({ type, id, extra }) => {
    console.log(`[CATALOG] Request:`, { type, id, extra });

    // Define helper label
    const itemLabel = type === 'movie' ? 'movies' : 'TV shows';

    // Dynamic Catalog Logic
    let prompt = '';
    const query = extra.search.toLowerCase();

    // Define triggers
    const movieKeywords = ['movie', 'film', 'cinema'];
    const seriesKeywords = ['series', 'show', 'tv', 'season', 'episode'];

    // Check intent
    const wantsMovies = movieKeywords.some(w => query.includes(w));
    const wantsSeries = seriesKeywords.some(w => query.includes(w));

    switch (id) {
        case 'gemini_search_movie':


            // If I want series ONLY, and this request is for movies -> BLOCK IT
            if (wantsSeries && !wantsMovies && type === 'movie') {
                console.log(`[OPTIMIZATION] Skipping Movie request for series-focused query: "${extra.search}"`);
                return { metas: [] };
            }

            // Universal search logic
            console.log(`Processing search query: ${extra.search} for type: ${type}`);

            prompt = `${SYSTEM_INSTRUCTION} 
            The user is searching for **${itemLabel}**. Use the query "${extra.search}" as a semantic guide.
            If it is a mood (e.g., 'sad sci-fi'), find ${itemLabel} that match the atmosphere. 
            If it is a plot description, find the closest matches. 
            Return 10 ${itemLabel}.
            Return a strictly valid JSON array of objects with "title" and "year".
            Example: [{"title": "Interstellar", "year": "2014"}]`;

            return await handleGeminiRequest(prompt, type);

        case 'gemini_search_series':

            // If I want movies ONLY, and this request is for series -> BLOCK IT
            if (wantsMovies && !wantsSeries && type === 'movie') {
                console.log(`[OPTIMIZATION] Skipping Series request for movie-focused query: "${extra.search}"`);
                return { metas: [] };
            }

            // Universal search logic
            console.log(`Processing search query: ${extra.search} for type: ${type}`);

            prompt = `${SYSTEM_INSTRUCTION} 
            The user is searching for **${itemLabel}**. Use the query "${extra.search}" as a semantic guide.
            If it is a mood (e.g., 'sad sci-fi'), find ${itemLabel} that match the atmosphere. 
            If it is a plot description, find the closest matches. 
            Return 10 ${itemLabel}.
            Return a strictly valid JSON array of objects with "title" and "year".
            Example: [{"title": "Interstellar", "year": "2014"}]`;

            return await handleGeminiRequest(prompt, type);

        case 'gemini_time_context':
            const hour = new Date().getHours();
            let context = '';

            if (hour < 12) {
                context = `It is morning. Focus on 'Brain Food' or 'High Energy'. Genres: energetic animated ${itemLabel} or sitcoms/documentaries. Suggest 10 ${itemLabel}.`;
            } else if (hour < 18) {
                context = `It is afternoon. Focus on 'Escapism'. Genres: adventure or comedy ${itemLabel}. Suggest 10 ${itemLabel}.`;
            } else {
                context = `It is evening/night. Focus on 'Immersion' or 'Tension'. Genres: thriller, horror, or complex drama ${itemLabel}. Suggest 10 ${itemLabel}.`;
            }

            console.log(`[TIME] Hour: ${hour} -> Context: ${context}`);
            prompt = `${SYSTEM_INSTRUCTION} The current time is ${hour}:00. ${context}
            Return a strictly valid JSON array of objects with "title" and "year".`;
            break;

        case 'gemini_reddit_trending':
            if (type === 'movie') {
                prompt = `${SYSTEM_INSTRUCTION} Act as a data analyst for r/movies and r/TrueFilm. 
                Identify 10 movies that have high engagement, 'Weekly Discussion' activity, or are frequently recommended. 
                Mix current hits with one 'Hidden Gem'.
                Return a strictly valid JSON array of objects with "title" and "year".`;
            } else {
                prompt = `${SYSTEM_INSTRUCTION} Act as a data analyst for r/television. 
                Identify 10 TV shows that have high engagement, 'Weekly Discussion' activity, or are frequently recommended. 
                Mix current hits with one 'Hidden Gem'.
                Return a strictly valid JSON array of objects with "title" and "year".`;
            }
            break;

        case 'gemini_surprise':
            // Random Niche Genre
            let genres = [];
            if (type === 'movie') {
                genres = ['Cyberpunk', '80s Slashers', 'Space Opera', 'Whodunit', 'Dystopian', 'Spaghetti Western', 'Cosmic Horror', 'French New Wave'];
            } else {
                genres = ['Miniseries', 'Korean Drama', 'Sitcoms', 'Space Opera', 'Dystopian', 'Procedural Dramas', 'Mockumentaries'];
            }

            const genre = genres[Math.floor(Math.random() * genres.length)];
            console.log(`[SURPRISE] Selected Genre: ${genre}`);

            prompt = `${SYSTEM_INSTRUCTION} Recommend 10 distinct ${itemLabel} for the sub-genre '${genre}'.
            Return a strictly valid JSON array of objects with "title" and "year".`;
            break;

        default:
            // Fallback
            return { metas: [] };
    }

    return await handleGeminiRequest(prompt, type);
});

// Helper to run the Gemini -> TMDB pipeline
async function handleGeminiRequest(prompt, itemType) {
    try {
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();

        console.log(`[GEMINI] Raw Response:`, text);
        const suggestions = parseGeminiResponse(text);

        if (!Array.isArray(suggestions)) {
            return { metas: [] };
        }

        if (!process.env.TMDB_API_KEY) {
            console.error("TMDB_API_KEY is missing.");
            return { metas: [] };
        }

        const metaPromises = suggestions.map(async (item) => {
            const filledItem = await getTmdbItem(item.title, item.year, itemType);
            if (filledItem) {
                console.log(`[MATCH] Gemini suggested "${item.title} (${item.year})" -> Found TMDB ID: ${filledItem.tmdbId}`);
                return filledItem;
            } else {
                console.log(`[MISS] Could not resolve "${item.title} (${item.year})"`);
                return null;
            }
        });

        const metas = (await Promise.all(metaPromises)).filter(m => m !== null);
        return { metas: metas };

    } catch (error) {
        console.error("Error in Gemini request:", error);
        return { metas: [] };
    }
}

// 7. Implement Meta Handler
builder.defineMetaHandler(async ({ type, id }) => {
    console.log(`[META] Request:`, { type, id });

    if ((type === 'movie' || type === 'series') && id.startsWith('tt')) {
        const itemType = type === 'movie' ? 'movie' : 'TV show';
        const prompt = `${SYSTEM_INSTRUCTION} You are an API. I will give you an IMDB ID '${id}'. 
        Return a JSON object with: 
        - 'name'
        - 'description' (3 sentences max)
        - 'cast' (top 3 names)
        - 'rating' (approximate 1-10 score)
        If you do not strictly recognize the ID, return { 'error': 'Unknown ID' }.
        
        Return strictly valid JSON. Do not include any extra text.`;

        try {
            const result = await model.generateContent(prompt);
            const response = await result.response;
            const text = response.text();
            const parsed = parseGeminiResponse(text);

            if (parsed && !parsed.error) {
                // Format for Stremio
                return {
                    meta: {
                        id: id,
                        type: type,
                        name: parsed.name,
                        description: parsed.description,
                        cast: parsed.cast,
                        imdbRating: parsed.rating
                    }
                };
            } else {
                return { meta: { id, type, name: 'Details not available' } };
            }
        } catch (error) {
            console.error("Meta error", error);
            return { meta: { id, type, name: 'Error' } };
        }
    }

    return { meta: { id, type, name: 'Unknown' } };
});

module.exports = builder.getInterface();
