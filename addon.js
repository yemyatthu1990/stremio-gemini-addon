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

// 3. Define Manifest
const manifest = {
    id: 'com.gemini.smart.search',
    version: '1.2.0',
    name: 'Gemini AI Search',
    description: "Multi-context AI recommendations: Time of day, Reddit hits, and Random surprises.",
    types: ['movie', 'series'],
    resources: ['catalog', 'meta'],
    catalogs: [
        {
            type: 'movie',
            id: 'gemini_time_context',
            name: 'Gemini: Day & Night',
            extra: [{ name: 'search', isRequired: false }]
        },
        {
            type: 'series',
            id: 'gemini_reddit_trending',
            name: 'Reddit Favorites',
            extra: []
        },
        {
            type: 'movie',
            id: 'gemini_surprise',
            name: 'Gemini: Surprise Me',
            extra: []
        }
    ]
};

const builder = new addonBuilder(manifest);

// 4. Helper to parse Gemini JSON output
function parseGeminiResponse(text) {
    try {
        let cleanedText = text.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(cleanedText);
    } catch (e) {
        console.error("Failed to parse Gemini response:", text);
        return [];
    }
}

// 5. Helper function for TMDB Search
async function getTmdbItem(title, year, type) {
    try {
        if (type === 'movie') {
            const searchRes = await tmdb.searchMovie({ query: title, year: year });
            if (!searchRes.results || searchRes.results.length === 0) return null;

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
            const searchRes = await tmdb.searchTv({ query: title, first_air_date_year: year });
            if (!searchRes.results || searchRes.results.length === 0) return null;

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

    // Handle Search (Global fallback or attached to gemini_time_context)
    if (extra && extra.search) {
        // Universal search logic
        const itemType = type === 'movie' ? 'movie' : 'TV show';
        console.log(`Processing search query: ${extra.search} for type: ${type}`);

        const prompt = `You are a video metadata intelligence. Recommend 5 ${itemType} titles that match: "${extra.search}".
        Return a strictly valid JSON array of objects with "title" and "year".
        Example: [{"title": "${type === 'movie' ? 'Interstellar' : 'Dark'}", "year": "${type === 'movie' ? '2014' : '2017'}"}]`;

        return await handleGeminiRequest(prompt, type);
    }

    // Dynamic Catalog Logic
    let prompt = '';

    switch (id) {
        case 'gemini_time_context':
            const hour = new Date().getHours();
            let context = '';

            if (hour < 12) {
                context = "It is morning. Suggest 5 energetic animated movies or uplifting documentaries suitable for starting the day.";
            } else if (hour < 18) {
                context = "It is afternoon. Suggest 5 adventure or comedy movies to keep the energy up.";
            } else {
                context = "It is evening/night. Suggest 5 thriller, horror, or dark drama movies.";
            }

            console.log(`[TIME] Hour: ${hour} -> Context: ${context}`);
            prompt = `You are a smart assistant. The current time is ${hour}:00. ${context}
            Return a strictly valid JSON array of objects with "title" and "year".`;
            break;

        case 'gemini_reddit_trending':
            // Series only
            prompt = `Identify 5 TV series that are currently trending or are cult classics on the subreddit r/television. 
            Focus on high-engagement discussions.
            Return a strictly valid JSON array of objects with "title" and "year".`;
            break;

        case 'gemini_surprise':
            // Random Niche Genre
            const genres = ['Cyberpunk', '80s Slashers', 'Space Opera', 'Whodunit', 'Dystopian', 'Spaghetti Western', 'Cosmic Horror', 'French New Wave'];
            const genre = genres[Math.floor(Math.random() * genres.length)];
            console.log(`[SURPRISE] Selected Genre: ${genre}`);

            prompt = `Recommend 5 distinct movies for the specific sub-genre: ${genre}.
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
        const prompt = `Provide detailed metadata for the ${itemType} with IMDB ID '${id}'. 
        Return strictly valid JSON with:
        - "meta": {
            "id": "${id}",
            "type": "${type}",
            "name": "${itemType} Title",
            "description": "Full plot summary.",
            "releaseInfo": "Year",
            "cast": ["Actor 1", "Actor 2"],
            "background": "URL to a background image (optional)"
        }
        Do not include any extra text.`;

        try {
            const result = await model.generateContent(prompt);
            const response = await result.response;
            const text = response.text();
            const parsed = parseGeminiResponse(text);

            if (parsed && parsed.meta) {
                parsed.meta.type = type;
                return { meta: parsed.meta };
            } else {
                return { meta: { id, type, name: 'Details not available' } };
            }
        } catch (error) {
            return { meta: { id, type, name: 'Error' } };
        }
    }

    return { meta: { id, type, name: 'Unknown' } };
});

module.exports = builder.getInterface();
