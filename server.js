const express = require('express');
const { getRouter } = require('stremio-addon-sdk');
const makeAddon = require('./addon');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 7000;

// Serve static files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Root redirect to config
app.get('/', (req, res) => {
    res.redirect('/configure.html');
});

// Dynamic Addon Route
// Stremio will call /:config/manifest.json, /:config/catalog/..., etc.
app.use('/:config', (req, res, next) => {
    const configStr = req.params.config;

    // Check if accessing static file (favicon, etc) to avoid error
    if (configStr.includes('.')) {
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
        console.error("Failed to load addon config:", e.message);
        res.status(500).send('Invalid Configuration');
    }
});

app.listen(PORT, () => {
    console.log(`Addon server running on http://localhost:${PORT}`);
    console.log(`Configure at: http://localhost:${PORT}/configure.html`);
});
