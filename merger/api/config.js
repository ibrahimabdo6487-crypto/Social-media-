// api/config.js — GET /api/config : الحدود العامة + الإصدار + جهوزية القاعدة (فحص الجهوزية)
const store = require('../lib/db');
const { preflight, method, json } = require('../lib/http');
const env = require('../lib/env');

module.exports = async (req, res) => {
  if (preflight(req, res)) return;
  if (!method(req, res, ['GET'])) return;
  const healthy = await store.dbHealthy();
  return json(res, 200, {
    ok: true,
    version: env.VERSION,
    database: healthy ? 'turso-connected' : 'turso-unreachable',
    limits: {
      maxSources: env.MAX_SOURCES,
      sourceMaxMB: env.SOURCE_MAX_MB,
      outputMaxMB: env.OUTPUT_MAX_MB,
      maxTotalDurationSec: env.MAX_TOTAL_DURATION_SEC,
      uploadChunkBytes: 4 * 1024 * 1024,
      blobChunkBytes: env.CHUNK_BYTES,
      retentionHours: env.RETENTION_HOURS,
    },
    output: { format: 'mp4 (H.264 + AAC)', quality: 'CRF 18', fps: 30, fixed: true },
  });
};
