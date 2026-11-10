const { handler, json } = require("../lib/util");
const C = require("../lib/config");
module.exports = handler(["GET"], async (req, res) => json(res, 200, {
  version: C.VERSION, maxSources: C.MAX_SOURCES, sourceMaxMB: C.SOURCE_MAX_BYTES / 1048576, outputMaxMB: C.OUTPUT_MAX_BYTES / 1048576,
  maxTotalDurationSec: C.MAX_TOTAL_DURATION_SEC, uploadChunkBytes: C.UPLOAD_CHUNK_BYTES, ttlHours: C.TTL_MS / 3600000,
}));
