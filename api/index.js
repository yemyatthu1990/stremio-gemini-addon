const addonInterface = require('../addon');
const { getRouter } = require('stremio-addon-sdk');

const router = getRouter(addonInterface);

module.exports = (req, res) => {
    router(req, res, (err) => {
        if (err) {
            console.error(err);
            res.status(500).send('Internal Server Error');
        }
    });
};
