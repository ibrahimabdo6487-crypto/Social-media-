// بث الناتج من Turso بدعم Range (206 + Content-Range) و ?download=1
const { handler, HttpError, cors } = require("../../../lib/util");
const S = require("../../../lib/storage");

module.exports = handler(["GET"], async (req, res) => {
  const id = String(req.query.id);
  const job = await S.getJob(id);
  if (!job || Number(job.expires_at) < Date.now()) throw new HttpError(404, "المهمة غير موجودة أو انتهت صلاحيتها");
  if (job.status !== "done") throw new HttpError(409, "الفيديو غير جاهز بعد");
  const size = Number(job.size);
  let start = 0, end = size - 1, code = 200;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (m && (m[1] || m[2])) {
    if (m[1] === "") { start = Math.max(0, size - Number(m[2])); }
    else { start = Number(m[1]); if (m[2]) end = Math.min(size - 1, Number(m[2])); }
    if (start > end || start >= size) { cors(res); res.statusCode = 416; res.setHeader("Content-Range", `bytes */${size}`); return res.end(); }
    code = 206;
  }
  cors(res);
  res.statusCode = code;
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Length", String(end - start + 1));
  res.setHeader("Cache-Control", "private, max-age=3600");
  if (code === 206) res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
  if (req.query.download) res.setHeader("Content-Disposition", `attachment; filename="merged-${id}.mp4"`);
  await S.streamOutputRange(id, start, end, (b) => new Promise((r) => (res.write(b) ? r() : res.once("drain", r))));
  res.end();
});
