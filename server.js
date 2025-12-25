const express = require('express');
const { getRouter } = require('stremio-addon-sdk');
const makeAddon = require('./addon');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 7000;

// Serve static files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// FORCE REDIRECT: Root -> /configure
app.get('/', (req, res) => {
    res.redirect('/configure');
});

// Serve Static Config Page
app.get('/configure', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'configure.html'));
});

// Dynamic Addon Route
// Stremio will call /:config/manifest.json, /:config/catalog/..., etc.
app.use('/:config', (req, res, next) => {
    const configStr = req.params.config;

    // Safety: If somehow 'configure' or other static paths match (unlikely due to order, but good practice)
    if (configStr === 'configure' || configStr === 'favicon.ico') {
        return next();
    }

    try {
        const jsonStr = atob(configStr);
        const config = JSON.parse(jsonStr);

        const addonInterface = makeAddon(config);
        const router = getRouter(addonInterface);

        router(req, res, () => {
            // If addon router doesn't handle it (404), fall through
            res.statusCode = 404;
            res.end();
        });
    } catch (e) {
        // console.error("Failed to load addon config:", e.message);
        // If decoding fails, it might be a normal 404 path, just 404 it or next()
        res.status(404).send('Not Found or Invalid Config');
    }
});

app.listen(PORT, () => {
    console.log(`Addon server running on http://localhost:${PORT}`);
    console.log(`Configure at: http://localhost:${PORT}/configure.html`);
});
