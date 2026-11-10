// lib/http.js — مساعدات HTTP مشتركة لدوال Vercel وخادم التطوير
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
}

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

function err(res, status, message) {
  json(res, status, { error: message });
}

// OPTIONS المفتوح لكل النقاط (CORS)
function preflight(req, res) {
  if (req.method === 'OPTIONS') { setCors(res); res.statusCode = 204; res.end(); return true; }
  setCors(res);
  return false;
}

function method(req, res, allowed) {
  if (!allowed.includes(req.method)) {
    err(res, 405, 'طريقة HTTP غير مسموحة لهذه النقطة');
    return false;
  }
  return true;
}

// قراءة جسم الطلب: Vercel قد يوفره محللًا مسبقًا (نص/كائن/Buffer) أو نقرأ التدفق بأنفسنا
async function readRaw(req) {
  if (req.body === undefined || req.body === null) {
    const chunks = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks);
  }
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body, 'utf8');
  return Buffer.from(JSON.stringify(req.body), 'utf8');
}

async function readJson(req) {
  const buf = await readRaw(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch (_) { return null; }
}

// وقت بصيغة SQLite UTC لمقارنات expires_at مع datetime('now')
function sqliteTime(msAhead = 0) {
  return new Date(Date.now() + msAhead).toISOString().slice(0, 19).replace('T', ' ');
}

// رفض النطاقات الداخلية/المحلية — المصادر يجب أن تكون روابط عامة مباشرة
function isPublicHttpUrl(u) {
  try {
    const x = new URL(u);
    if (x.protocol !== 'http:' && x.protocol !== 'https:') return false;
    const h = x.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
      const [a, b] = h.split('.').map(Number);
      if (a === 127 || a === 10 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)) return false;
    }
    if (h === '[::1]' || h.startsWith('[')) return false;
    return true;
  } catch (_) { return false; }
}

module.exports = { setCors, json, err, preflight, method, readRaw, readJson, sqliteTime, isPublicHttpUrl };
