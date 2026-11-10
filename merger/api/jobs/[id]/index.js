const { handler, json, origin, HttpError } = require("../../../lib/util");
const S = require("../../../lib/storage");
const { jobView } = require("../../../lib/view");

module.exports = handler(["GET", "DELETE"], async (req, res) => {
  const id = String(req.query.id);
  if (req.method === "DELETE") {
    const n = await S.deleteJob(id);
    if (!n) throw new HttpError(404, "المهمة غير موجودة");
    return json(res, 200, { ok: true, deleted: id });
  }
  const job = await S.getJob(id);
  if (!job || Number(job.expires_at) < Date.now()) throw new HttpError(404, "المهمة غير موجودة أو انتهت صلاحيتها");
  json(res, 200, jobView(job, origin(req)));
});
