const { handler, json, readBody, HttpError } = require("../lib/util");
const C = require("../lib/config");
const S = require("../lib/storage");

module.exports = handler(["POST"], async (req, res) => {
  const { job, seq, chunk } = req.query;
  const s = Number(seq), k = Number(chunk);
  if (!job || !Number.isInteger(s) || s < 0 || !Number.isInteger(k) || k < 0) throw new HttpError(400, "المعاملات job و seq و chunk مطلوبة");
  const j = await S.getJob(String(job));
  if (!j) throw new HttpError(404, "المهمة غير موجودة");
  if (j.status !== "uploading") throw new HttpError(409, "المهمة لا تقبل رفعًا في حالتها الحالية");
  const src = (await S.getSources(String(job))).find((x) => Number(x.seq) === s);
  if (!src || src.kind !== "file") throw new HttpError(404, "المصدر غير موجود أو ليس ملفًا");
  const body = await readBody(req, C.UPLOAD_CHUNK_BYTES + 1024);
  if (!body.length) throw new HttpError(400, "الجزء فارغ");
  await S.putUploadChunk(String(job), s, k, body);
  const uploaded = await S.sourceUploadedBytes(String(job), s);
  if (uploaded > Number(src.size)) throw new HttpError(413, "الحجم المرفوع يتجاوز الحجم المعلن");
  json(res, 200, { ok: true, uploaded, size: Number(src.size) });
});
