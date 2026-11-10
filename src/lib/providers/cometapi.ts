// src/lib/providers/cometapi.ts — المزود الثاني: CometAPI (متوافق مع أشكال OpenAI)
// مقاس فعليًا: /v1/models و /v1/videos موجودان (401 invalid token بدل 404 Invalid URL)
// الصور متزامنة عبر /v1/images/generations (تعيد url أو b64_json فورًا)
// الفيديو غير متزامن عبر /v1/videos (إنشاء → GET حالة → محتوى)
import { ProviderError, type ProviderAdapter, type ProviderTaskInput, type ProviderCheckResult } from "./types";

const BASE = "https://api.cometapi.com";

async function callApi(path: string, init: RequestInit): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, init);
  } catch (e) {
    throw new ProviderError(0, `network error: ${(e as Error).message}`);
  }
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text); } catch { /* جسم غير JSON */ }
  if (!res.ok) {
    const errObj = (body.error ?? {}) as Record<string, unknown>;
    throw new ProviderError(res.status, String(errObj.message ?? body.message ?? text.slice(0, 300) ?? `HTTP ${res.status}`));
  }
  return body;
}

// تحويل نسبة الأبعاد إلى أبعاد OpenAI للفيديو (أقرب أبعاد مدعومة)
function videoSize(ar?: string, resolution?: string): string | undefined {
  if (!ar || ar === "auto") return undefined;
  const hd = resolution === "1080p" ? { w: 1440, h: 1080 } : resolution === "720p" ? { w: 1280, h: 720 } : { w: 720, h: 480 };
  const map: Record<string, [number, number]> = {
    "16:9": [hd.w, Math.round((hd.w * 9) / 16)],
    "9:16": [Math.round((hd.w * 9) / 16), hd.w],
    "1:1": [hd.w, hd.w],
    "3:2": [hd.w, Math.round((hd.w * 2) / 3)],
    "2:3": [Math.round((hd.w * 2) / 3), hd.w],
  };
  const m = map[ar];
  if (!m) return undefined;
  const even = (n: number) => n - (n % 2);
  return `${even(m[0])}x${even(m[1])}`;
}

export const cometapiAdapter: ProviderAdapter = {
  // صور متزامنة — النتيجة فورًا بلا مهمة
  async createImageSync(key: string, input: ProviderTaskInput) {
    const body = await callApi("/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: input.model, prompt: input.prompt, n: 1 }),
    });
    const data = body.data as Array<{ url?: string; b64_json?: string }> | undefined;
    if (!Array.isArray(data) || !data.length) throw new ProviderError(400, "images/generations: no data");
    const urls = data
      .map((d) => d.url ?? (d.b64_json ? `data:image/png;base64,${d.b64_json}` : null))
      .filter((u): u is string => !!u);
    if (!urls.length) throw new ProviderError(400, "images/generations: no urls");
    return { urls };
  },

  // فيديو غير متزامن
  async createTask(key: string, model: string, input: ProviderTaskInput) {
    const payload: Record<string, unknown> = {
      model,
      prompt: input.prompt + (input.image_url ? ` [first-frame: ${input.image_url}]` : ""),
      seconds: String(input.duration ?? 8),
    };
    const size = videoSize(input.aspect_ratio, input.resolution);
    if (size) payload.size = size;
    const body = await callApi("/v1/videos", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
    });
    const id = body.id ?? (body.data as Record<string, unknown> | undefined)?.id;
    if (!id) throw new ProviderError(400, "videos: no job id in response");
    return { providerTaskId: String(id) };
  },

  async checkTask(key: string, providerTaskId: string): Promise<ProviderCheckResult> {
    const body = await callApi(`/v1/videos/${encodeURIComponent(providerTaskId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
    });
    const status = String(body.status ?? "");
    if (status === "completed") {
      // رابط المحتوى الرسمي لدى المزود (يتطلب المفتاح للتنزيل — قيد موثق)
      return { status: "completed", urls: [`${BASE}/v1/videos/${providerTaskId}/content`], progress: 100 };
    }
    if (status === "failed") {
      const errObj = (body.error ?? {}) as Record<string, unknown>;
      return { status: "failed", error: String(errObj.message ?? "video generation failed") };
    }
    // queued | in_progress — تقدّم تقديري
    return { status: "processing", progress: status === "in_progress" ? 55 : 15 };
  },
};
