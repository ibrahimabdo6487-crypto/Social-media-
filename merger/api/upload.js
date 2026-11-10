// api/upload.js — POST /api/upload?job=&seq=&chunk= : رفع أجزاء الملفات (ثنائي ≤4MB)
// نقرأ التدفق الخام بأنفسنا (bodyParser=false على Vercel) حتى لا يتلف الثنائي
const store = require('../lib/db');
const { preflight, method, err, json } = require('../lib/http');
const env = require('../lib/env');

module.exports = async (req, res) => {
  if (preflight(req, res)) return;
  if (!method(req, res, ['POST'])) return;
  try {
    await store.ensureSchema();
    const jobId = String(req.query.job || '');
    const seq = parseInt(req.query.seq, 10);
    const chunk = parseInt(req.query.chunk, 10);
    if (!jobId || !Number.isInteger(seq) || seq < 0 || !Number.isInteger(chunk) || chunk < 0) {
      return err(res, 400, 'معاملات الرفع مطلوبة: job و seq و chunk');
    }
    const job = await store.getJob(jobId);
    if (!job) return err(res, 404, 'مهمة الدمج غير موجودة');
    if (job.status !== 'uploading' && job.status !== 'processing') {
      return err(res, 409, `حالة المهمة (${job.status}) لا تسمح بالرفع`);
    }

    // قراءة الجسم الخام بحد 4MB + هامش
    const MAX = 4 * 1024 * 1024 + 65536;
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX) return err(res, 413, 'حجم الجزء يتجاوز 4MB — قسّم الملف إلى أجزاء أصغر');
      chunks.push(Buffer.from(c));
    }
    const buf = Buffer.concat(chunks);
    if (!buf.length) return err(res, 400, 'جسم الطلب فارغ — أرسل الجزء الثنائي كما هو (application/octet-stream)');

    await store.saveSourceChunk(jobId, seq, chunk, buf);
    return json(res, 200, { ok: true, jobId, seq, chunk, bytes: buf.length });
  } catch (e) {
    return err(res, 500, e.message || 'فشل حفظ الجزء');
  }
};

// إيقاف المحلل التلقائي للجسم على Vercel — التدفق الخام ضروري للثنائي
module.exports.config = { api: { bodyParser: false } };
