// عميل Video Merger API v2 (بلا مفاتيح) — النواتج تبقى على خدمة الدمج 24 ساعة فقط
import { getTask, insertTask, updateTask, type TaskRow } from "./turso";
import type { ProgressFn } from "./generation";

export const mergerBase = () => (process.env.MERGER_API_BASE || "").replace(/\/+$/, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// قفل في الذاكرة: نفّذ process مرة واحدة فقط لكل مهمة
const processInFlight = new Set<string>();

const DONE = /^(done|completed|complete|success|succeeded|finished)$/;
const FAIL = /^(error|failed|failure|cancelled)$/;

export async function mergerHealthy(): Promise<boolean> {
  if (!mergerBase()) return false;
  try {
    const r = await fetch(`${mergerBase()}/api/config`, { signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch { return false; }
}

interface Parsed { state: "processing" | "completed" | "failed" | "missing"; progress: number; url?: string; error?: string }

function parseStatus(httpStatus: number, body: any, jobId: string): Parsed {
  if (httpStatus === 404) return { state: "missing", progress: 0 };
  // أي HTTP معلن بخطأ أو جسم فيه error بلا status = فشل نهائي
  if (httpStatus >= 400 || (body?.error && !body?.status)) return { state: "failed", progress: 0, error: String(body?.error || `HTTP ${httpStatus}`) };
  const st = String(body?.status ?? "").toLowerCase();
  let p = Number(body?.progress ?? 0);
  if (p > 0 && p <= 1) p *= 100; // كسر 0..1
  if (DONE.test(st)) {
    const url = body.videoUrl || body.downloadUrl || `${mergerBase()}/api/jobs/${jobId}/video`;
    return { state: "completed", progress: 100, url };
  }
  if (FAIL.test(st)) return { state: "failed", progress: p, error: String(body?.error || "فشل الدمج") };
  return { state: "processing", progress: p };
}

async function callProcess(jobId: string) {
  // blocking ~10–15 ثانية؛ يعمل خلفيًا ومرة واحدة. فشله المعلن يُلتقط من GET /api/jobs
  if (processInFlight.has(jobId)) return;
  processInFlight.add(jobId);
  try {
    const r = await fetch(`${mergerBase()}/api/jobs/${jobId}/process`, { method: "POST", signal: AbortSignal.timeout(120000) });
    const body = await r.json().catch(() => ({}));
    if (r.status >= 400) {
      const tid = jobIdToTask.get(jobId);
      if (tid) await updateTask(tid, { status: "failed", error_message: String(body?.error || `HTTP ${r.status}`) });
    } else if (r.status === 200 && DONE.test(String(body?.status))) {
      const tid = jobIdToTask.get(jobId);
      if (tid) await updateTask(tid, { status: "completed", progress: 100, result_urls: [body.videoUrl || body.downloadUrl || `${mergerBase()}/api/jobs/${jobId}/video`] });
    }
  } catch { /* خطأ شبكتنا: مؤقت، يستمر الاستعلام */ }
  finally { processInFlight.delete(jobId); }
}
const jobIdToTask = new Map<string, string>();

export async function runMerge(urls: string[], waitSeconds = 60, onProgress?: ProgressFn): Promise<{ error?: string; task?: TaskRow }> {
  if (urls.length < 2) return { error: "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة." };
  if (urls.length > 10) return { error: "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى)." };
  if (!urls.every((u) => /^https?:\/\//i.test(u))) return { error: "❌ كل روابط الدمج يجب أن تكون روابط http/https مباشرة وعامة." };
  if (!mergerBase()) return { error: "❌ خدمة الدمج غير مهيأة (MERGER_API_BASE)." };

  const id = crypto.randomUUID();
  await insertTask({ id, model: "video-merger", type: "merge", provider: "merger", prompt: `دمج ${urls.length} مقاطع`, params: { urls }, status: "pending" });

  try {
    const r = await fetch(`${mergerBase()}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videos: urls }), signal: AbortSignal.timeout(30000) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || !body.jobId) {
      await updateTask(id, { status: "failed", error_message: String(body?.error || `HTTP ${r.status}`) });
      return { task: (await getTask(id))! };
    }
    await updateTask(id, { provider_task_id: body.jobId, status: "processing", progress: 5 });
    jobIdToTask.set(body.jobId, id);
    void callProcess(body.jobId);
  } catch (e) {
    // تعذر الإنشاء بسبب شبكتنا: تبقى processing وتُستأنف عبر get_task
    await updateTask(id, { status: "processing", error_message: (e as Error).message });
  }

  const t0 = Date.now();
  let cur = (await getTask(id))!;
  while (cur.status === "processing" && Date.now() - t0 < waitSeconds * 1000) {
    await sleep(3000);
    cur = await refreshMergeTask(cur);
    await onProgress?.(cur.progress, `قيد الدمج… ${cur.progress}%`);
  }
  return { task: cur };
}

export async function refreshMergeTask(task: TaskRow): Promise<TaskRow> {
  if (task.status !== "processing" && task.status !== "pending") return task;
  const jobId = task.provider_task_id;
  if (!jobId) {
    // لم يُنشأ الجوب بعد (انقطاع شبكة سابق) → أنشئه الآن
    const urls = (task.params as any).urls as string[];
    try {
      const r = await fetch(`${mergerBase()}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videos: urls }), signal: AbortSignal.timeout(30000) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || !body.jobId) { await updateTask(task.id, { status: "failed", error_message: String(body?.error || `HTTP ${r.status}`) }); }
      else { await updateTask(task.id, { provider_task_id: body.jobId, progress: 5 }); jobIdToTask.set(body.jobId, task.id); void callProcess(body.jobId); }
    } catch { /* مؤقت */ }
    return (await getTask(task.id))!;
  }
  jobIdToTask.set(jobId, task.id);
  try {
    const r = await fetch(`${mergerBase()}/api/jobs/${jobId}`, { signal: AbortSignal.timeout(15000) });
    const body = await r.json().catch(() => ({}));
    const p = parseStatus(r.status, body, jobId);
    if (p.state === "completed") await updateTask(task.id, { status: "completed", progress: 100, result_urls: [p.url!], error_message: null });
    else if (p.state === "failed") await updateTask(task.id, { status: "failed", error_message: p.error });
    else if (p.state === "missing") await updateTask(task.id, { status: "failed", error_message: "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)" });
    else {
      await updateTask(task.id, { progress: Math.max(task.progress, p.progress) });
      // لو لم يُنفَّذ process بعد (مثلًا في invocation سابق) فنفّذه الآن
      if (!processInFlight.has(jobId)) void callProcess(jobId);
    }
  } catch { /* خطأ شبكتنا: مؤقت */ }
  return (await getTask(task.id))!;
}
