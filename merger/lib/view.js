const S = require("./storage");
// صياغة استجابة الحالة
function jobView(job, base) {
  const id = String(job.id);
  const v = { jobId: id, status: job.status, progress: Number(job.progress || 0), expiresAt: S.iso(Number(job.expires_at)) };
  if (job.status === "done") Object.assign(v, { videoUrl: `${base}/api/jobs/${id}/video`, downloadUrl: `${base}/api/jobs/${id}/video?download=1`, size: Number(job.size), duration: Number(job.duration), resolution: job.resolution });
  if (job.status === "failed") v.error = job.error || "فشل الدمج";
  return v;
}
module.exports = { jobView };
