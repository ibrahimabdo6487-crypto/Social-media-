// src/lib/generation.ts — منسّق التوليد مع التبديل التسلسلي الصارم للمفاتيح + خدمة الدمج
// القواعد الذهبية المنفذة هنا:
// 1) روابط فقط — لا تنزيل أي وسائط إلى السيرفر أبدًا
// 2) ترتيب المفاتيح تسلسلي بترتيب الإضافة (created_at ASC, id ASC)
// 3) لا توقف عند نفاد رصيد: انتقال تلقائي للمفتاح التالي واستئناف نفس المهمة بنفس task_id
// 4) نموذج الذكاء الاصطناعي لا يرى أخطاء مفاتيح/رصيد أبدًا
// 5) مهمة فشلت على كل المفاتيح تبقى processing وتُعاد محاولتها مع كل get_task (تهدئة ~45 ثانية)
import { randomUUID } from "crypto";
import {
  insertTask, getTask, updateTask, getKeyPool, noteKeyUse,
  type KeyRow, type TaskRow, type TaskAttempt,
} from "./turso";
import { MERGE_MODEL, type ModelDef, type ProviderId } from "./models";
import { classifyProviderError, keyStatusForClass, keyLabel } from "./keys";
import { kieAdapter } from "./providers/kie";
import { cometapiAdapter } from "./providers/cometapi";
import type { ProviderAdapter, ProviderTaskInput } from "./providers/types";
import { createMergeJob, processMergeJob, getMergeJob, mergerConfigured } from "./merger";

const ADAPTERS: Record<ProviderId, ProviderAdapter> = { kie: kieAdapter, cometapi: cometapiAdapter };

export type ProgressNotify = (percent: number, message: string) => Promise<void> | void;

const COOLDOWN_MS = 45_000; // تهدئة بين محاولات إعادة الإنشاء حتى لا نضغط المزودين

// ---------- الإنشاء مع التبديل التسلسلي ----------

interface CreateOutcome {
  ok: boolean;
  noKeys?: boolean;        // لا مفاتيح نشطة أصلًا
  paramsError?: string;    // خطأ معطيات — توقف فورًا (التبديل لن يحلّه)
  usedKey?: KeyRow;        // المفتاح الذي ربطته المهمة (للاستعلام لاحقًا)
  message?: string;        // رسالة عربية آمنة للفشل النهائي
}

async function tryCreateOnPool(
  taskId: string, modelDef: ModelDef, type: "image" | "video",
  params: Record<string, unknown>, prompt: string,
): Promise<CreateOutcome> {
  const pool = await getKeyPool(modelDef.providers);
  if (!pool.length) return { ok: false, noKeys: true };

  for (const key of pool) {
    const adapter = ADAPTERS[key.provider as ProviderId];
    if (!adapter) continue; // مزود غير معروف في السجل — تجاوز
    const providerModel = modelDef.providerModel[key.provider as ProviderId];
    const input: ProviderTaskInput = { ...params, model: providerModel, prompt };
    try {
      if (type === "image" && adapter.createImageSync) {
        // صور متزامنة فورية (CometAPI) — اكتملت بنفس الإنشاء
        const { urls } = await adapter.createImageSync(key.api_key, input);
        await updateTask(taskId, {
          provider: key.provider, key_id: key.id, status: "completed",
          result_urls_json: JSON.stringify(urls), progress: 100,
        });
        await noteKeyUse(key.id, true);
        return { ok: true, usedKey: key };
      }
      const { providerTaskId } = await adapter.createTask(key.api_key, providerModel, input);
      await updateTask(taskId, { provider: key.provider, provider_task_id: providerTaskId, key_id: key.id });
      await noteKeyUse(key.id, true);
      return { ok: true, usedKey: key };
    } catch (e) {
      const err = e as Error & { status?: number };
      const status = typeof err.status === "number" ? err.status : 400;
      const cls = classifyProviderError(status, err.message ?? "");
      const attempt: TaskAttempt = {
        provider: key.provider, keyId: key.id, keyLabel: keyLabel(key),
        ok: false, errorClass: cls, error: (err.message ?? "").slice(0, 300), at: new Date().toISOString(),
      };
      // عدّادات المفتاح وحالته تُحدَّث دائمًا (disabled فقط هو المُستثنى من القائمة لاحقًا)
      await noteKeyUse(key.id, false, { error: attempt.error, status: keyStatusForClass(cls) });
      await updateTask(taskId, { attempt });

      if (cls === "params") {
        // خطأ معطيات → توقف فورًا: تبديل المفاتيح لن يحل خطأ معطيات
        const msg = `❌ فشلت المهمة: المعطيات مرفوضة من المزود (${(err.message ?? "").slice(0, 160)}). صحّح المعطيات وأعد المحاولة.`;
        await updateTask(taskId, { status: "failed", error_message: msg });
        return { ok: false, paramsError: msg };
      }
      // disabled/exhausted/provider/temporary → انتقل للمفتاح التالي دون توقف
    }
  }
  // فشل الإنشاء على كل المفاتيح — المهمة تبقى processing «بانتظار توفر مفتاح صالح»
  await updateTask(taskId, {
    provider_task_id: null, key_id: null,
    error_message: "بانتظار توفر مفتاح صالح…",
  });
  return { ok: false };
}

// نمط مشكلات مفتاح/رصيد في رسالة فشل منتصف المهمة — يفعّل الاستئناف على المفتاح التالي
function looksLikeKeyOrBalanceError(msg: string, status = 200): boolean {
  const cls = classifyProviderError(status, msg);
  return cls === "disabled" || cls === "exhausted";
}

// ---------- التوليد (صورة/فيديو) ----------

export async function runGeneration(opts: {
  type: "image" | "video";
  modelDef: ModelDef;
  prompt: string;
  params: Record<string, unknown>;
  waitSeconds: number;
  notify?: ProgressNotify;
}): Promise<TaskRow> {
  const { type, modelDef, prompt, params, waitSeconds, notify } = opts;
  const taskId = randomUUID();

  // سجّل المهمة قبل أي نداء خارجي — تبقى قابلة للتتبع حتى لو انقطع الاتصال
  await insertTask({ id: taskId, model: modelDef.canonical, type, prompt, params_json: JSON.stringify(params), status: "processing" });

  let created = await tryCreateOnPool(taskId, modelDef, type, params, prompt);
  if (created.paramsError) return (await getTask(taskId))!;
  if (created.noKeys) {
    await updateTask(taskId, { error_message: `بانتظار توفر مفتاح صالح لخدمة ${modelDef.canonical}…` });
    return (await getTask(taskId))!;
  }

  let usedKey = created.usedKey;
  let lastCreateAt = Date.now();
  const deadline = Date.now() + waitSeconds * 1000;

  while (Date.now() < deadline) {
    await sleep(3000);
    const row = await getTask(taskId);
    if (!row) break;
    if (row.status === "completed") return row;

    // فشل الإنشاء على كل المفاتيح → إعادة محاولة بعد تهدئة 45 ثانية
    if (!row.provider_task_id) {
      if (Date.now() - lastCreateAt >= COOLDOWN_MS) {
        created = await tryCreateOnPool(taskId, modelDef, type, params, prompt);
        lastCreateAt = Date.now();
        if (created.paramsError) return (await getTask(taskId))!;
        usedKey = created.usedKey ?? usedKey;
        if (created.ok) await notify?.(5, "بدأ التوليد على مفتاح متاح…");
      }
      continue;
    }

    // فحص حالة المهمة لدى المزود بالمفتاح المرتبط
    if (!usedKey) break;
    const adapter = ADAPTERS[usedKey.provider as ProviderId];
    if (!adapter) break;
    try {
      const chk = await adapter.checkTask(usedKey.api_key, row.provider_task_id);
      if (chk.status === "completed" && chk.urls?.length) {
        await updateTask(taskId, { status: "completed", result_urls_json: JSON.stringify(chk.urls), progress: 100 });
        await noteKeyUse(usedKey.id, true);
        return (await getTask(taskId))!;
      }
      if (chk.status === "failed") {
        const msg = chk.error ?? "";
        if (looksLikeKeyOrBalanceError(msg)) {
          // فشل منتصف المهمة بسبب مفتاح/رصيد → أعد إنشاء نفس المهمة بنفس task_id على المفتاح التالي
          await updateTask(taskId, { provider_task_id: null, key_id: null, error_message: "بانتظار توفر مفتاح صالح…" });
          created = await tryCreateOnPool(taskId, modelDef, type, params, prompt);
          lastCreateAt = Date.now();
          if (created.paramsError) return (await getTask(taskId))!;
          usedKey = created.usedKey ?? usedKey;
          continue;
        }
        // فشل حقيقي (سياسة/معطيات) — رسالة آمنة للعرض
        await updateTask(taskId, { status: "failed", error_message: `فشل التوليد لدى المزود: ${msg.slice(0, 200)}` });
        return (await getTask(taskId))!;
      }
      const pct = Math.min(95, Math.max(5, chk.progress ?? 0));
      await updateTask(taskId, { progress: pct });
      await notify?.(pct, "قيد التوليد…");
    } catch (e) {
      const err = e as Error & { status?: number };
      const cls = classifyProviderError(err.status ?? 400, err.message ?? "");
      if (cls === "disabled" || cls === "exhausted") {
        await noteKeyUse(usedKey.id, false, { error: (err.message ?? "").slice(0, 200), status: keyStatusForClass(cls) });
        await updateTask(taskId, { attempt: { provider: usedKey.provider, keyId: usedKey.id, keyLabel: keyLabel(usedKey), ok: false, errorClass: cls, error: (err.message ?? "").slice(0, 300), at: new Date().toISOString() } });
        await updateTask(taskId, { provider_task_id: null, key_id: null, error_message: "بانتظار توفر مفتاح صالح…" });
        created = await tryCreateOnPool(taskId, modelDef, type, params, prompt);
        lastCreateAt = Date.now();
        if (created.paramsError) return (await getTask(taskId))!;
        usedKey = created.usedKey ?? usedKey;
      }
      // temporary → استمر بالاستعلام حتى انتهاء النافذة
    }
  }
  // انتهت النافذة — أعد المهمة processing مع task_id والعميل يتابع بـ get_task
  return (await getTask(taskId))!;
}

// ---------- استئناف/تحديث المهمة (get_task) ----------

export async function refreshTask(taskId: string, notify?: ProgressNotify): Promise<TaskRow | null> {
  const row = await getTask(taskId);
  if (!row) return null;
  if (row.status !== "processing") return row;

  if (row.type === "merge") return refreshMergeTask(row, notify);

  const modelDef = row.model ? require_model(row.model) : null;
  if (!modelDef) {
    await updateTask(taskId, { status: "failed", error_message: "موديل غير معروف في سجل الموديلات" });
    return (await getTask(taskId))!;
  }

  const params = JSON.parse(row.params_json || "{}") as Record<string, unknown>;

  if (!row.provider_task_id) {
    // لم يبدأ التوليد بعد (بانتظار مفتاح) — أعد المحاولة بعد التهدئة
    const last = lastAttemptAt(row);
    if (Date.now() - last >= COOLDOWN_MS) {
      const created = await tryCreateOnPool(taskId, modelDef, "video" === row.type ? "video" : "image", params, row.prompt);
      if (created.paramsError) return (await getTask(taskId))!;
    }
    return (await getTask(taskId))!;
  }

  // مهمة جارية لدى المزود — حدّث حية
  const keyId = row.key_id;
  const pool = await getKeyPool(modelDef.providers);
  const usedKey = pool.find((k) => k.id === keyId) ?? pool[0];
  if (!usedKey) return row;
  const adapter = ADAPTERS[usedKey.provider as ProviderId];
  if (!adapter) return row;

  try {
    const chk = await adapter.checkTask(usedKey.api_key, row.provider_task_id);
    if (chk.status === "completed" && chk.urls?.length) {
      await updateTask(taskId, { status: "completed", result_urls_json: JSON.stringify(chk.urls), progress: 100 });
    } else if (chk.status === "failed") {
      const msg = chk.error ?? "";
      if (looksLikeKeyOrBalanceError(msg)) {
        await updateTask(taskId, { provider_task_id: null, key_id: null, error_message: "بانتظار توفر مفتاح صالح…" });
      } else {
        await updateTask(taskId, { status: "failed", error_message: `فشل التوليد لدى المزود: ${msg.slice(0, 200)}` });
      }
    } else {
      const pct = Math.min(95, Math.max(5, chk.progress ?? row.progress));
      await updateTask(taskId, { progress: pct });
      await notify?.(pct, "قيد التوليد…");
    }
  } catch (e) {
    const err = e as Error & { status?: number };
    const cls = classifyProviderError(err.status ?? 400, err.message ?? "");
    if (cls === "disabled" || cls === "exhausted") {
      await noteKeyUse(usedKey.id, false, { error: (err.message ?? "").slice(0, 200), status: keyStatusForClass(cls) });
      await updateTask(taskId, { provider_task_id: null, key_id: null, error_message: "بانتظار توفر مفتاح صالح…" });
    }
  }
  return (await getTask(taskId))!;
}

function lastAttemptAt(row: TaskRow): number {
  try {
    const attempts = JSON.parse(row.attempts_json || "[]") as TaskAttempt[];
    if (attempts.length) {
      const t = Date.parse(attempts[attempts.length - 1].at);
      if (Number.isFinite(t)) return t;
    }
  } catch { /* تجاهل */ }
  return Date.parse(row.updated_at || "") || 0;
}

function require_model(name: string): ModelDef | null {
  // تجنب الاستيراد الدائري: استعلام مباشر من السجل
  const { MODELS } = require("./models") as typeof import("./models");
  return MODELS.find((m) => m.canonical === name) ?? null;
}

// ---------- الدمج ----------

// قفل في الذاكرة: process يُطلق مرة واحدة فقط لكل مهمة (حتى لا يتزامن مع get_task)
const processInFlight = new Set<string>();

export async function runMerge(input: {
  urls?: string[];
  task_ids?: string[];
  waitSeconds?: number;
  notify?: ProgressNotify;
}): Promise<{ task: TaskRow | null; error?: string }> {
  const { urls = [], task_ids = [], waitSeconds = 60, notify } = input;

  // تحقق صارم بعد جمع الروابط: ≥2 و ≤10 وكلها روابط مباشرة عامة
  const resolved: string[] = [];
  const failedRefs: string[] = [];
  for (const tid of task_ids) {
    const t = await getTask(String(tid));
    if (!t || t.status !== "completed" || !t.result_urls_json) {
      failedRefs.push(`${tid} (${!t ? "غير موجودة" : t.status})`);
      continue;
    }
    const u = JSON.parse(t.result_urls_json) as string[];
    if (u.length) resolved.push(u[0]);
  }
  if (failedRefs.length) {
    return { task: null, error: `❌ لا يمكن الدمج: مهام مُشار إليها غير مكتملة — ${failedRefs.join("، ")}. أكملها بـ get_task أولًا.` };
  }

  const all = [...resolved, ...urls.map(String)];
  if (all.length < 2) {
    return { task: null, error: "❌ الدمج يحتاج مقطعين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة." };
  }
  if (all.length > 10) {
    return { task: null, error: "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى)." };
  }
  for (const u of all) {
    if (!/^https?:\/\//i.test(u) || /localhost|127\.0\.0\.1|192\.168\.|10\.\d|172\.(1[6-9]|2\d|3[01])\.|169\.254|\[::1\]/i.test(u)) {
      return { task: null, error: `❌ رابط غير مباشر أو غير عام: ${u.slice(0, 120)} — الدمج يحتاج روابط http/https عامة مباشرة.` };
    }
  }
  if (!mergerConfigured()) {
    return { task: null, error: "❌ خدمة الدمج غير مضبوطة — اضبط متغير البيئة MERGER_API_BASE بعنوان خدمة الدمج المنشورة ثم أعد المحاولة." };
  }

  const taskId = randomUUID();
  await insertTask({ id: taskId, model: MERGE_MODEL, type: "merge", prompt: `دمج ${all.length} مقاطع`, params_json: JSON.stringify({ urls: all }), status: "processing" });

  try {
    const job = await createMergeJob(all);
    await updateTask(taskId, { provider: "merger", provider_task_id: job.jobId });
    if (!processInFlight.has(job.jobId)) {
      processInFlight.add(job.jobId);
      // إطلاق خلفي بمرة واحدة — الاستطلاع يكشف النتيجة
      processMergeJob(job.jobId).finally(() => processInFlight.delete(job.jobId));
    }
  } catch (e) {
    await updateTask(taskId, { status: "failed", error_message: (e as Error).message.slice(0, 300) });
    return { task: (await getTask(taskId))! };
  }

  const deadline = Date.now() + waitSeconds * 1000;
  while (Date.now() < deadline) {
    await sleep(3000);
    const row = await getTask(taskId);
    if (!row?.provider_task_id) break;
    const st = await getMergeJob(row.provider_task_id);
    if (st.status === "done" && st.videoUrl) {
      await updateTask(taskId, { status: "completed", result_urls_json: JSON.stringify([st.videoUrl]), progress: 100 });
      return { task: (await getTask(taskId))! };
    }
    if (st.status === "failed") {
      // خطأ معلن من الخدمة = فشل نهائي فوري — لا إعادة محاولة
      await updateTask(taskId, { status: "failed", error_message: (st.error ?? "فشل الدمج").slice(0, 300) });
      return { task: (await getTask(taskId))! };
    }
    const pct = Math.min(95, Math.max(2, st.progress));
    await updateTask(taskId, { progress: pct });
    await notify?.(pct, "قيد الدمج…");
  }
  return { task: (await getTask(taskId))! };
}

export async function refreshMergeTask(row: TaskRow, notify?: ProgressNotify): Promise<TaskRow> {
  const taskId = row.id;
  if (!row.provider_task_id) {
    await updateTask(taskId, { status: "failed", error_message: "مهمة الدمج لم تُنشأ لدى الخدمة" });
    return (await getTask(taskId))!;
  }
  const st = await getMergeJob(row.provider_task_id);
  if (st.status === "done" && st.videoUrl) {
    await updateTask(taskId, { status: "completed", result_urls_json: JSON.stringify([st.videoUrl]), progress: 100 });
  } else if (st.status === "failed") {
    await updateTask(taskId, { status: "failed", error_message: (st.error ?? "فشل الدمج").slice(0, 300) });
  } else {
    const pct = Math.min(95, Math.max(2, st.progress));
    await updateTask(taskId, { progress: pct });
    await notify?.(pct, "قيد الدمج…");
    // إن كانت لا تزال في الطابور ولم يُنفَّذ process بعد — نفّذه الآن (مرة واحدة)
    const jobId = row.provider_task_id;
    if (jobId && !processInFlight.has(jobId)) {
      processInFlight.add(jobId);
      processMergeJob(jobId).finally(() => processInFlight.delete(jobId));
    }
  }
  return (await getTask(taskId))!;
}

// ---------- الصياغة العربية للردود ----------

export function formatTaskMessage(t: TaskRow): { text: string; isError: boolean } {
  const urls = parseUrls(t);
  if (t.status === "completed") {
    if (t.type === "image") {
      const lines = ["✅ تم توليد الصورة بنجاح"];
      for (const u of urls) { lines.push(`![image](${u})`); lines.push(`الرابط المباشر: ${u}`); }
      return { text: lines.join("\n"), isError: false };
    }
    if (t.type === "video") {
      const lines = ["✅ تم توليد الفيديو بنجاح", ...urls.map((u) => `الرابط المباشر: ${u}`)];
      return { text: lines.join("\n"), isError: false };
    }
    // merge
    const lines = ["✅ تم دمج المقاطع بنجاح", ...urls.map((u) => `الرابط المباشر: ${u}`),
      "⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا."];
    return { text: lines.join("\n"), isError: false };
  }
  if (t.status === "failed") {
    return { text: `❌ فشلت المهمة: ${t.error_message ?? "سبب غير معروف"}`, isError: true };
  }
  return {
    text: `⏳ المهمة قيد المعالجة — task_id: ${t.id}\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`,
    isError: false,
  };
}

function parseUrls(t: TaskRow): string[] {
  try {
    const u = JSON.parse(t.result_urls_json ?? "[]") as string[];
    return Array.isArray(u) ? u : [];
  } catch { return []; }
}

export function listMediaMessage(tasks: TaskRow[]): string {
  if (!tasks.length) return "لا توجد وسائط مخزنة بعد بهذه المرشحات. ولّد صورة أو فيديو أولًا بـ generate_image / generate_video.";
  const icon = (t: TaskRow) => (t.type === "image" ? "🖼️" : t.type === "video" ? "🎬" : "🔗");
  const lines = tasks.map((t) => {
    const urls = parseUrls(t);
    const head = `${icon(t)} [${t.status}] ${t.type} · ${t.model}${t.prompt ? ` — «${t.prompt.slice(0, 60)}»` : ""} (${t.created_at})`;
    return urls.length ? `${head}\n${urls.map((u) => `- ${u}`).join("\n")}` : head;
  });
  return `أحدث الوسائط المخزنة (${tasks.length}):\n\n${lines.join("\n\n")}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
