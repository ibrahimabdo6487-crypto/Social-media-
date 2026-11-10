// src/lib/providers/kie.ts — المزود الأساسي: kie.ai Jobs API الموحد
// الأشكال مقاسة فعليًا بنداءات حقيقية (createTask / recordInfo) وليست مخترعة
import { ProviderError, type ProviderAdapter, type ProviderTaskInput, type ProviderCheckResult } from "./types";

const BASE = "https://api.kie.ai/api/v1/jobs";

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
    throw new ProviderError(res.status, String(body.msg ?? body.message ?? text.slice(0, 300) ?? `HTTP ${res.status}`));
  }
  if (body.code !== undefined && Number(body.code) !== 200) {
    // بعض المزودين يرسلون نفاد الرصيد بحالة HTTP 200 وكود داخلي ≠ 200 — الرسالة تُصنَّف لاحقًا
    throw new ProviderError(Number(body.code) === 401 ? 401 : 400, String(body.msg ?? "unknown provider error"));
  }
  return body;
}

export const kieAdapter: ProviderAdapter = {
  async createTask(key: string, model: string, input: ProviderTaskInput) {
    const body = await callApi("/createTask", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, input: buildInput(input) }),
    });
    const data = body.data as { taskId?: string } | undefined;
    if (!data?.taskId) throw new ProviderError(400, "createTask: no taskId in response");
    return { providerTaskId: data.taskId };
  },

  async checkTask(key: string, providerTaskId: string): Promise<ProviderCheckResult> {
    const body = await callApi(`/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
    });
    const data = body.data as Record<string, unknown> | undefined;
    if (!data) throw new ProviderError(400, "recordInfo: no data");
    const state = String(data.state ?? "");
    // resultJson نص JSON داخل JSON — يحتاج JSON.parse ثانيًا (شكل حقيقي مقاس)
    let urls: string[] = [];
    if (typeof data.resultJson === "string" && data.resultJson) {
      try {
        const parsed = JSON.parse(data.resultJson) as { resultUrls?: string[] };
        urls = parsed.resultUrls ?? [];
      } catch { /* تجاهل */ }
    }
    if (state === "success") return { status: "completed", urls, progress: 100 };
    if (state === "fail") {
      return { status: "failed", error: String(data.failMsg ?? "unknown failure") };
    }
    // waiting | queuing | generating — تقدّم تقديري (kie لا يرسل رقمًا)
    const progress = state === "generating" ? 55 : state === "queuing" ? 15 : 5;
    return { status: "processing", progress };
  },
};

function buildInput(input: ProviderTaskInput): Record<string, unknown> {
  const o: Record<string, unknown> = { prompt: input.prompt };
  if (input.aspect_ratio && input.aspect_ratio !== "auto") o.aspect_ratio = input.aspect_ratio;
  // الصور: 1K/2K/4K — الفيديو: 480p/720p/1080p — auto يعني إرسال الإعداد الافتراضي للمزود
  if (input.resolution && input.resolution !== "auto") o.resolution = input.resolution;
  if (input.background && input.background !== "auto") o.background = input.background;
  if (input.output_format) o.output_format = input.output_format;
  // معطيات الفيديو
  if (input.image_url) o.image_url = input.image_url;
  if (input.enable_audio !== undefined) o.enable_audio = input.enable_audio;
  if (input.duration) o.duration = input.duration;
  return o;
}
