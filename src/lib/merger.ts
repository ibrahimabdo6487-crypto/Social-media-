// src/lib/merger.ts — عميل خدمة دمج الفيديو v2 (MERGER_API_BASE)
// بلا مفاتيح أو توثيق — تحليل حالة دفاعي حسب المواصفة 7.2
const BASE = (process.env.MERGER_API_BASE || "").replace(/\/+$/, "");

export function mergerConfigured(): boolean {
  return !!BASE;
}

export function mergerBase(): string {
  return BASE;
}

export async function mergerHealthy(): Promise<boolean> {
  if (!mergerConfigured()) return false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${BASE}/api/config`, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

export async function createMergeJob(urls: string[]): Promise<{ jobId: string; status: string }> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videos: urls }),
    });
  } catch (e) {
    throw new Error(`فشل الاتصال بخدمة الدمج: ${(e as Error).message}`);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || !body.jobId) {
    throw new Error(`رفضت خدمة الدمج إنشاء المهمة: ${String(body.error ?? `HTTP ${res.status}`)}`);
  }
  return { jobId: String(body.jobId), status: String(body.status ?? "queued") };
}

// تنفيذ الدمج — يُطلق مرة واحدة فقط (القفل في منسّق التوليد)
export async function processMergeJob(jobId: string): Promise<void> {
  try {
    await fetch(`${BASE}/api/jobs/${encodeURIComponent(jobId)}/process`, { method: "POST" });
  } catch { /* الاستطلاع لاحقًا يكشف الحالة النهائية */ }
}

export interface MergeJobStatus {
  status: "queued" | "uploading" | "processing" | "done" | "failed";
  progress: number;
  videoUrl?: string;
  downloadUrl?: string;
  error?: string;
  expiresAt?: string;
}

const DONE = new Set(["done", "completed", "complete", "success", "succeeded", "finished"]);
const FAILED = new Set(["error", "failed", "failure", "cancelled", "canceled"]);

export async function getMergeJob(jobId: string): Promise<MergeJobStatus> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/jobs/${encodeURIComponent(jobId)}`);
  } catch (e) {
    // أخطاء شبكتنا نحن = مؤقتة → الاستمرار بالاستعلام (المواصفة 7.3.5)
    return { status: "processing", progress: 0, error: `network: ${(e as Error).message}` };
  }
  if (res.status === 404) {
    // 404 → فشل نهائي: المهمة حُذفت أو انتهت صلاحيتها (24 ساعة)
    return { status: "failed", progress: 0, error: "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)" };
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const raw = String(body.status ?? "").toLowerCase();

  // دفاعي: رد فيه error بلا status → فاشل فورًا
  if (!raw && body.error) {
    return { status: "failed", progress: 0, error: String(body.error) };
  }

  let progress = Number(body.progress ?? 0);
  if (progress > 0 && progress <= 1) progress = Math.round(progress * 100); // يأتي أحيانًا كسرًا

  if (DONE.has(raw)) {
    const videoUrl = String(body.videoUrl ?? "") || String(body.downloadUrl ?? "") || `${BASE}/api/jobs/${jobId}/video`;
    return {
      status: "done", progress: 100,
      videoUrl,
      downloadUrl: String(body.downloadUrl ?? "") || `${videoUrl}?download=1`,
      expiresAt: body.expiresAt ? String(body.expiresAt) : undefined,
    };
  }
  if (FAILED.has(raw)) {
    return { status: "failed", progress, error: String(body.error ?? "فشل الدمج لدى الخدمة") };
  }
  // 4xx/5xx معلنة بجسم error = فشل نهائي فوري
  if (!res.ok && body.error) {
    return { status: "failed", progress, error: String(body.error) };
  }
  return { status: "processing", progress };
}
