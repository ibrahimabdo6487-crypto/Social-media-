// api/jobs/[id]/process.js — POST /api/jobs/<id>/process : تنفيذ الدمج كاملًا (متزامن)
// سحب المصادر (0–40) ← ترميز ffmpeg (40–90) ← حفظ الناتج في Turso (100)
const fs = require('fs');
const path = require('path');
const os = require('os');
const store = require('../../../lib/db');
const { preflight, method, err, json } = require('../../../lib/http');
const engine = require('../../../lib/merge');
const env = require('../../../lib/env');

module.exports = async (req, res) => {
  if (preflight(req, res)) return;
  if (!method(req, res, ['POST'])) return;
  const id = req.query.id;
  try {
    await store.ensureSchema();
    const job = await store.getJob(id);
    if (!job) return err(res, 404, 'مهمة الدمج غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)');
    if (job.status === 'processing') {
      // طلب متزامن أثناء معالجة فعالة → 202 مع التقدم الحالي
      return json(res, 202, { status: 'processing', jobId: id, progress: job.progress || 0 });
    }
    if (job.status === 'done') {
      return json(res, 200, donePayload(store.jobPublic(job, origin(req))));
    }
    if (job.status === 'failed') {
      return err(res, 409, `المهمة فاشلة ولا يمكن معالجتها: ${job.error || 'خطأ غير معروف'}`);
    }

    await store.updateJob(id, { status: 'processing', progress: 0, error: null });
    const sources = JSON.parse(job.sources_json || '[]');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `merge-${id}-`));
    try {
      const n = sources.length;
      const localFiles = [];
      const sourceMaxBytes = env.SOURCE_MAX_MB * 1024 * 1024;

      for (let i = 0; i < n; i++) {
        const s = sources[i];
        const f = path.join(tmpDir, `src_${String(i).padStart(2, '0')}.bin`);
        if (s.kind === 'url') {
          // سحب مصدر رابط مع فرض حد الحجم أثناء التنزيل + تقدم 0–40
          await engine.downloadUrl(s.url, f, sourceMaxBytes, (frac) => {
            store.updateJob(id, { progress: Math.round(((i + frac) / n) * 40) }).catch(() => {});
          });
        } else {
          // تجميع مصدر مرفوع من أجزائه المخزنة في Turso
          const written = await store.assembleSource(id, i, f, s.size);
          if (written > sourceMaxBytes) throw new Error(`الملف ${s.name || i} يتجاوز الحد المسموح (${env.SOURCE_MAX_MB}MB لكل مصدر)`);
          if (s.size && Math.abs(written - s.size) > 1024) {
            throw new Error(`الملف ${s.name || i} غير مكتمل (${written} بايت مرفوعة من ${s.size}) — أعد رفع الأجزاء الناقصة`);
          }
          await store.updateJob(id, { progress: Math.round(((i + 1) / n) * 40) });
        }
        localFiles.push({ path: f });
      }

      const outPath = path.join(tmpDir, 'merged.mp4');
      const meta = await engine.mergeFiles(localFiles, outPath, (p) => {
        store.updateJob(id, { progress: Math.max(40, Math.min(90, p)) }).catch(() => {});
      });

      const size = fs.statSync(outPath).size;
      if (size > env.OUTPUT_MAX_MB * 1024 * 1024) {
        throw new Error(`حجم الناتج (${(size / 1048576).toFixed(1)}MB) يتجاوز الحد المسموح (${env.OUTPUT_MAX_MB}MB)`);
      }

      await store.updateJob(id, { progress: 95 });
      await store.saveOutput(id, outPath);
      // بعد نجاح الدمج نحذف أجزاء المصادر فقط — الناتج هو المطلوب
      await store.deleteSourceChunks(id);
      await store.updateJob(id, {
        status: 'done', progress: 100,
        size, duration: meta.duration, resolution: meta.resolution, error: null,
      });
      const fresh = await store.getJob(id);
      return json(res, 200, donePayload(store.jobPublic(fresh, origin(req))));
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* تنظيف /tmp دائمًا */ }
    }
  } catch (e) {
    try { await store.updateJob(id, { status: 'failed', error: e.message || 'فشل الدمج' }); } catch (_) { /* تجاهل */ }
    return err(res, 500, e.message || 'فشل الدمج');
  }
};

function donePayload(pub) {
  return {
    status: 'done',
    jobId: pub.jobId,
    videoUrl: pub.videoUrl,
    downloadUrl: pub.downloadUrl,
    size: pub.size,
    duration: pub.duration,
    resolution: pub.resolution,
    expiresAt: pub.expiresAt,
  };
}

function origin(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

module.exports.config = { api: { bodyParser: false, maxDuration: 300 } };
