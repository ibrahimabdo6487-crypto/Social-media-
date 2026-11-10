const { handler, json, origin, HttpError } = require("../../../lib/util");
const C = require("../../../lib/config");
const S = require("../../../lib/storage");
const { jobView } = require("../../../lib/view");
const { processJob } = require("../../../lib/process");

module.exports = handler(["POST"], async (req, res) => {
  const id = String(req.query.id);
  const job = await S.getJob(id);
  if (!job) throw new HttpError(404, "المهمة غير موجودة");
  if (job.status === "done") return json(res, 200, jobView(job, origin(req)));
  if (job.status === "processing") return json(res, 202, jobView(job, origin(req)));
  if (job.status === "failed") throw new HttpError(409, `المهمة فشلت سابقًا: ${job.error || ""}`);
  // تأكد أن كل الملفات المرفوعة مكتملة
  for (const s of await S.getSources(id)) {
    if (s.kind === "file" && (await S.sourceUploadedBytes(id, Number(s.seq))) !== Number(s.size)) throw new HttpError(409, `رفع الملف "${s.name}" غير مكتمل`);
  }
  if (!(await S.claimProcessing(id))) return json(res, 202, jobView(await S.getJob(id), origin(req)));
  await processJob(id);
  const fresh = await S.getJob(id);
  if (fresh.status === "failed") return json(res, 500, { error: fresh.error });
  json(res, 200, jobView(fresh, origin(req)));
});
