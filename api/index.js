const { getRouter } = require("stremio-addon-sdk");
const addonInterface = require("../addon");

const router = getRouter(addonInterface);

module.exports = function (req, res) {
    // Vercel serverless request handler
    router(req, res, function (err) {
        if (err) {
            console.error(err);
            res.status(500).send({ error: "Internal Server Error", details: err.message });
        }
    });
};
