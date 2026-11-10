// api/jobs/[id]/video.js — GET /api/jobs/<id>/video : بث الناتج MP4 بدعم Range (206)
// نحوّل صفوف Blobs إلى تدفق مع تقليم أول/آخر جزء حسب المدى المطلوب — بلا تحميل كامل في الذاكرة
const { Readable } = require('stream');
const store = require('../../../lib/db');
const { preflight, method, err } = require('../../../lib/http');

module.exports = async (req, res) => {
  if (preflight(req, res)) return;
  if (!method(req, res, ['GET'])) return;
  try {
    await store.ensureSchema();
    const id = req.query.id;
    const job = await store.getJob(id);
    if (!job) return err(res, 404, 'مهمة الدمج غير موجودة');
    if (job.status !== 'done') return err(res, 409, 'الناتج غير جاهز بعد — الحالة الحالية: ' + job.status);

    const size = Number(job.size) || 0;
    if (!size) return err(res, 404, 'لا يوجد ناتج محفوظ لهذه المهمة');

    // تحليل ترويسة Range: bytes=start-end | bytes=start- | bytes=-suffix
    let start = 0; let end = size - 1; let partial = false;
    const range = req.headers.range;
    if (range) {
      const m = String(range).match(/^bytes=(\d*)-(\d*)$/);
      if (!m) { res.statusCode = 416; res.setHeader('Content-Range', `bytes */${size}`); return res.end(); }
      if (m[1] === '' && m[2] !== '') { start = Math.max(0, size - Number(m[2])); end = size - 1; }
      else { start = Number(m[1] || 0); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
      if (start > end || start >= size) { res.statusCode = 416; res.setHeader('Content-Range', `bytes */${size}`); return res.end(); }
      partial = !(start === 0 && end === size - 1);
    }

    res.statusCode = partial ? 206 : 200;
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', String(end - start + 1));
    res.setHeader('Cache-Control', 'no-store');
    if (partial) res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    if (req.query.download === '1') {
      res.setHeader('Content-Disposition', `attachment; filename="merged-${id}.mp4"`);
    }

    const stream = Readable.from(store.outputRange(id, start, end), { highWaterMark: 1024 * 1024 });
    stream.pipe(res);
    stream.on('error', () => { try { res.destroy(); } catch (_) { /* تجاهل */ } });
  } catch (e) {
    return err(res, 500, e.message || 'خطأ في بث الفيديو');
  }
};

module.exports.config = { api: { bodyParser: false } };
