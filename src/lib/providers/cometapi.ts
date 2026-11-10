// CometAPI — صور متزامنة (OpenAI images) وفيديو عبر مهام غير متزامنة.
// ملاحظة: أشكال CometAPI لم تُختبر حيًا (الشبكة محجوبة أثناء البناء) — راجع api.cometapi.com عند الحاجة.
import type { ProviderAdapter } from "./types";
import { jfetch } from "./http";
import { ProviderError } from "../keys";

const BASE = "https://api.cometapi.com";
const auth = (k: string) => ({ Authorization: `Bearer ${k}`, "Content-Type": "application/json" });

export const cometapi: ProviderAdapter = {
  id: "cometapi",
  async createImageSync(key, model, input) {
    const body: Record<string, unknown> = { model, prompt: input.prompt, n: 1 };
    if (input.aspect_ratio && input.aspect_ratio !== "auto") body.size = input.aspect_ratio;
    if (input.output_format) body.output_format = input.output_format;
    const r = await jfetch(`${BASE}/v1/images/generations`, { method: "POST", headers: auth(key), body: JSON.stringify(body), timeoutMs: 120000 });
    const urls = (r?.data ?? []).map((x: any) => x.url || (x.b64_json ? `data:image/png;base64,${x.b64_json}` : null)).filter(Boolean);
    if (!urls.length) throw new ProviderError(502, "cometapi: no image in response");
    return { urls };
  },
  async createTask(key, model, input) {
    const r = await jfetch(`${BASE}/v1/videos`, { method: "POST", headers: auth(key), body: JSON.stringify({ model, ...input }) });
    const id = r?.id || r?.data?.id || r?.task_id;
    if (!id) throw new ProviderError(502, "cometapi: no task id in response");
    return { providerTaskId: String(id) };
  },
  async checkTask(key, id) {
    const r = await jfetch(`${BASE}/v1/videos/${encodeURIComponent(id)}`, { headers: auth(key) });
    const st = String(r?.status ?? r?.data?.status ?? "").toLowerCase();
    if (/complete|succe/.test(st)) {
      const u = r?.video_url || r?.url || r?.data?.url || r?.data?.video_url;
      return u ? { status: "completed", urls: [u], progress: 100 } : { status: "failed", error: "no video url" };
    }
    if (/fail|error|cancel/.test(st)) return { status: "failed", error: String(r?.error?.message || r?.error || "failed") };
    return { status: "processing", progress: Number(r?.progress ?? 10) };
  },
};
