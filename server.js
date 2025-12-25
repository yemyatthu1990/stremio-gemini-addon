const addonInterface = require('./addon');
const { serveHTTP } = require('stremio-addon-sdk');

serveHTTP(addonInterface, { port: process.env.PORT || 7000 });
console.log("Manifest URL: http://127.0.0.1:7000/manifest.json?v=" + Date.now());
