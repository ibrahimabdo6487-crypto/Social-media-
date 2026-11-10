// أدوات HTTP مشتركة: CORS مفتوح + أخطاء {"error"} + قراءة الجسم
const dns = require("node:dns").promises;
const net = require("node:net");

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");
}
function json(res, code, obj) {
  cors(res);
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}
const fail = (res, code, msg) => json(res, code, { error: msg });
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

// غلاف: OPTIONS + تحقق الطريقة + التقاط الأخطاء
const handler = (methods, fn) => async (req, res) => {
  try {
    if (req.method === "OPTIONS") { cors(res); res.statusCode = 204; return res.end(); }
    if (!methods.includes(req.method)) { res.setHeader("Allow", methods.join(", ")); return fail(res, 405, "الطريقة غير مسموحة"); }
    await fn(req, res);
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof HttpError) return fail(res, e.code, e.message);
    console.error(e);
    fail(res, 500, "خطأ داخلي: " + (e.message || e));
  }
};
async function readBody(req, limit) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw new HttpError(413, "حجم الطلب أكبر من المسموح"); chunks.push(c); }
  return Buffer.concat(chunks);
}
async function readJson(req) {
  const b = await readBody(req, 1024 * 1024);
  try { return b.length ? JSON.parse(b.toString("utf8")) : {}; } catch { throw new HttpError(400, "JSON تالف"); }
}
const origin = (req) => {
  const proto = req.headers["x-forwarded-proto"] || "http";
  return `${proto}://${req.headers["x-forwarded-host"] || req.headers.host}`;
};

// حماية SSRF: نرفض الروابط التي تحل إلى عناوين داخلية/خاصة (ALLOW_PRIVATE_URLS=1 للاختبار المحلي فقط)
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const l = ip.toLowerCase();
  return l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80") || l.startsWith("::ffff:127.") || l.startsWith("::ffff:10.") || l.startsWith("::ffff:192.168.");
}
async function assertPublicUrl(u) {
  let url; try { url = new URL(u); } catch { throw new Error("رابط غير صالح"); }
  if (!/^https?:$/.test(url.protocol)) throw new Error("الرابط يجب أن يكون http/https");
  if (process.env.ALLOW_PRIVATE_URLS === "1") return url;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => { throw new Error("تعذّر حل اسم النطاق"); });
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error("الرابط يشير إلى عنوان داخلي غير مسموح");
  return url;
}
module.exports = { cors, json, fail, HttpError, handler, readBody, readJson, origin, assertPublicUrl };
