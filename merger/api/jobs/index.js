const crypto = require("node:crypto");
const { handler, json, readJson, origin, HttpError, assertPublicUrl } = require("../../lib/util");
const C = require("../../lib/config");
const S = require("../../lib/storage");

module.exports = handler(["POST"], async (req, res) => {
  const body = await readJson(req);
  let sources = [];
  if (Array.isArray(body.videos)) sources = body.videos.map((u) => ({ kind: "url", url: u }));
  else if (Array.isArray(body.sources)) sources = body.sources;
  else throw new HttpError(400, "أرسل videos (قائمة روابط) أو sources");
  if (sources.length < 1) throw new HttpError(400, "القائمة فارغة: أضف مقطعًا واحدًا على الأقل");
  if (sources.length > C.MAX_SOURCES) throw new HttpError(400, `أقصى عدد مقاطع هو ${C.MAX_SOURCES}`);
  const clean = [];
  for (const s of sources) {
    if (s && s.kind === "file") {
      const size = Number(s.size);
      if (!s.name || !(size > 0)) throw new HttpError(400, "مصدر الملف يحتاج name و size صحيحين");
      if (size > C.SOURCE_MAX_BYTES) throw new HttpError(413, `حجم الملف يتجاوز الحد ${Math.round(C.SOURCE_MAX_BYTES / 1048576)}MB`);
      clean.push({ kind: "file", name: String(s.name).slice(0, 200), size, mime: String(s.mime || "").slice(0, 100) });
    } else {
      const u = typeof s === "string" ? s : s && s.url;
      if (typeof u !== "string") throw new HttpError(400, "مصدر غير صالح");
      try { await assertPublicUrl(u); } catch (e) { throw new HttpError(400, `${e.message}: ${u}`); }
      clean.push({ kind: "url", url: u });
    }
  }
  S.deleteExpired().catch(() => {}); // تنظيف كسول
  const id = crypto.randomBytes(8).toString("hex");
  const { status, expiresAt } = await S.createJob(id, clean);
  const base = origin(req);
  const out = { jobId: id, status, statusUrl: `${base}/api/jobs/${id}`, processUrl: `${base}/api/jobs/${id}/process`, expiresAt };
  const files = clean.map((s, i) => ({ s, i })).filter((x) => x.s.kind === "file");
  if (files.length) {
    out.uploads = files.map(({ s, i }) => ({ seq: i, name: s.name, size: s.size, uploadUrl: `${base}/api/upload?job=${id}&seq=${i}` }));
    out.uploadChunkBytes = C.UPLOAD_CHUNK_BYTES;
  }
  json(res, 201, out);
});
