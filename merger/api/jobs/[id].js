// api/jobs/[id].js — GET /api/jobs/<id> : الحالة والتقدم والرابط عند الاكتمال — DELETE: حذف شامل
const store = require('../../lib/db');
const { preflight, method, err, json } = require('../../lib/http');

module.exports = async (req, res) => {
  if (preflight(req, res)) return;
  if (!method(req, res, ['GET', 'DELETE'])) return;
  try {
    await store.ensureSchema();
    const id = req.query.id;
    const row = await store.getJob(id);
    if (!row) return err(res, 404, 'مهمة الدمج غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)');

    if (req.method === 'DELETE') {
      await store.deleteJobAll(id);
      return json(res, 200, { deleted: true, jobId: id });
    }

    // دفاعي: رد بـ error بلا status يعامل فورًا كمهمة فاشلة
    const out = store.jobPublic(row, origin(req));
    return json(res, 200, out);
  } catch (e) {
    return err(res, 500, e.message || 'خطأ داخلي غير متوقع');
  }
};

function origin(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}
