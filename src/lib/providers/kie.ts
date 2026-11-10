// kie.ai — Jobs API الموحد
import type { ProviderAdapter } from "./types";
import { jfetch } from "./http";
import { ProviderError } from "../keys";

const BASE = (process.env.KIE_API_BASE || "https://api.kie.ai") + "/api/v1/jobs"; // KIE_API_BASE للاختبار المحلي فقط
const auth = (k: string) => ({ Authorization: `Bearer ${k}`, "Content-Type": "application/json" });

export const kie: ProviderAdapter = {
  id: "kie",
  async createTask(key, model, input) {
    const r = await jfetch(`${BASE}/createTask`, { method: "POST", headers: auth(key), body: JSON.stringify({ model, input }) });
    const id = r?.data?.taskId;
    if (!id) throw new ProviderError(502, "kie: no taskId in response");
    return { providerTaskId: String(id) };
  },
  async checkTask(key, taskId) {
    const r = await jfetch(`${BASE}/recordInfo?taskId=${encodeURIComponent(taskId)}`, { headers: auth(key) });
    const d = r?.data ?? {};
    const state = String(d.state ?? "").toLowerCase();
    if (state === "success") {
      // resultJson نص JSON داخل JSON → parse ثانٍ
      let urls: string[] = [];
      try { urls = JSON.parse(d.resultJson || "{}").resultUrls ?? []; } catch { /* */ }
      if (!urls.length) return { status: "failed", error: "no result urls" };
      return { status: "completed", urls, progress: 100 };
    }
    if (state === "fail") return { status: "failed", error: String(d.failMsg || d.failCode || "generation failed") };
    const prog = state === "generating" ? 50 : state === "queuing" ? 15 : 5;
    return { status: "processing", progress: prog };
  },
};
