// api/cron.js — GET /api/cron : حذف المهام المنتهية (مجدول يومي عبر vercel.json crons)
const store = require('../lib/db');
const { preflight, method, json, err } = require('../lib/http');

module.exports = async (req, res) => {
  if (preflight(req, res)) return;
  if (!method(req, res, ['GET'])) return;
  try {
    const deleted = await store.cleanupExpired();
    return json(res, 200, { ok: true, deleted, at: new Date().toISOString() });
  } catch (e) {
    return err(res, 500, e.message || 'فشل التنظيف التلقائي');
  }
};
