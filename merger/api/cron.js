const { handler, json } = require("../lib/util");
const S = require("../lib/storage");
module.exports = handler(["GET"], async (req, res) => json(res, 200, { deleted: await S.deleteExpired() }));
