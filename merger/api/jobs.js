// api/jobs.js — POST /api/jobs : إنشاء مهمة دمج (روابط أو ملفات تُرفع لاحقًا بالأجزاء)
const crypto = require('crypto');
const store = require('../lib/db');
const { preflight, method, readJson, err, json, sqliteTime, isPublicHttpUrl } = require('../lib/http');
const env = require('../lib/env');

module.exports = async (req, res) => {
  if (preflight(req, res)) return;
  if (!method(req, res, ['POST'])) return;
  try {
    await store.ensureSchema();
    await store.cleanupExpired(); // حذف كسول للمهام المنتهية

    const body = await readJson(req);
    if (body === null) return err(res, 400, 'جسم الطلب JSON تالف');

    // قبول {"videos": [...]} أو {"sources": [{kind, url|name, size, mime}, ...]}
    let sources = [];
    if (Array.isArray(body.videos)) {
      sources = body.videos.map((u) => ({ kind: 'url', url: String(u || '').trim() }));
    } else if (Array.isArray(body.sources)) {
      sources = body.sources.map((s) => ({
        kind: s && s.kind === 'file' ? 'file' : 'url',
        url: s ? String(s.url || '').trim() : '',
        name: s ? String(s.name || '').slice(0, 200) : '',
        size: s && Number.isFinite(Number(s.size)) ? Number(s.size) : null,
        mime: s ? String(s.mime || '').slice(0, 100) : '',
      }));
    } else {
      return err(res, 400, 'المعامل مطلوب: videos (مصفوفة روابط) أو sources (مصفوفة مصادر)');
    }

    if (sources.length < 2) return err(res, 400, 'الدمج يحتاج مقطعين على الأقل. مرّر urls أو sources بمقطعين أو أكثر.');
    if (sources.length > env.MAX_SOURCES) return err(res, 400, `أقصى عدد مقاطع للدمج هو ${env.MAX_SOURCES} (الخدمة تقبل ${env.MAX_SOURCES} مقاطع كحد أقصى).`);

    const sourceMaxBytes = env.SOURCE_MAX_MB * 1024 * 1024;
    let hasFiles = false;
    for (const s of sources) {
      if (s.kind === 'url') {
        if (!s.url || !isPublicHttpUrl(s.url)) return err(res, 400, `الرابط غير صالح أو غير عام: ${s.url || '(فارغ)'}`);
      } else {
        hasFiles = true;
        if (!s.name) return err(res, 400, 'كل مصدر ملف يحتاج name');
        if (!s.size || s.size <= 0) return err(res, 400, `الملف ${s.name} يحتاج حجمًا صحيحًا (size)`);
        if (s.size > sourceMaxBytes) return err(res, 413, `الملف ${s.name} يتجاوز الحد المسموح (${env.SOURCE_MAX_MB}MB لكل مصدر)`);
      }
    }

    const id = crypto.randomBytes(8).toString('hex');
    const expiresAt = sqliteTime(env.RETENTION_HOURS * 3600 * 1000);
    const status = hasFiles ? 'uploading' : 'queued';
    await store.insertJob({ id, status, expiresAt }, sources);

    const origin = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers['x-forwarded-host'] || req.headers.host || 'localhost'}`;
    const out = {
      jobId: id,
      status,
      statusUrl: `${origin}/api/jobs/${id}`,
      processUrl: `${origin}/api/jobs/${id}/process`,
      expiresAt: new Date(Date.now() + env.RETENTION_HOURS * 3600 * 1000).toISOString(),
      uploadChunkBytes: 4 * 1024 * 1024,
    };
    if (hasFiles) {
      out.uploads = sources.map((s, i) => (s.kind === 'file' ? {
        seq: i,
        uploadUrl: `${origin}/api/upload?job=${id}&seq=${i}&chunk={chunk}`,
        name: s.name,
        size: s.size,
        chunks: Math.ceil(s.size / out.uploadChunkBytes),
      } : null)).filter(Boolean);
    }
    return json(res, 201, out);
  } catch (e) {
    return err(res, 500, e.message || 'خطأ داخلي غير متوقع');
  }
};
