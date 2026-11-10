// منسّق التوليد: التبديل التسلسلي بين المفاتيح دون توقف المهمة
import { getTask, insertTask, updateTask, type TaskRow, type Attempt } from "./turso";
import { getKeyPool, getKey, recordKeyUse, classifyProviderError, ProviderError, KEY_PROBLEM_RE, maskKey, type ApiKeyRow } from "./keys";
import { resolveModel, type ModelDef, type MediaType } from "./models";
import { PROVIDERS } from "./providers";
import { refreshMergeTask } from "./merger";

export type ProgressFn = (percent: number, message: string) => void | Promise<void>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const COOLDOWN_MS = 45_000; // تهدئة إعادة المحاولة عندما تفشل كل المفاتيح
const WAIT_MARK = "بانتظار توفر مفتاح صالح…"; // رسالة داخلية فقط — لا تصل للعميل

const nowIso = () => new Date().toISOString();

/** يبني معطيات المزود من معطيات أداة MCP */
export function buildInput(type: MediaType, a: Record<string, any>): Record<string, unknown> {
  if (type === "image") {
    const res = a.resolution ?? "1K";
    const input: Record<string, unknown> = {
      prompt: a.prompt, aspect_ratio: a.aspect_ratio ?? "auto", resolution: res, output_format: a.output_format ?? "png",
    };
    if (res === "1K") input.background = a.background ?? "auto"; // background يُطبَّق عند 1K فقط
    return input;
  }
  const input: Record<string, unknown> = {
    prompt: a.prompt, aspect_ratio: a.aspect_ratio ?? "auto", resolution: a.resolution ?? "480p",
    duration: a.duration ?? 8, enable_audio: a.enable_audio ?? true,
  };
  if (a.image_url) input.image_urls = [a.image_url];
  return input;
}

/**
 * يجرّب مفاتيح المزودين بترتيب الإضافة حتى ينجح إنشاء المهمة.
 * skipKeyIds: مفاتيح استُبعدت للتو (فشلت في منتصف المهمة).
 * يعيد "started" | "completed" (صور متزامنة) | "waiting" (كل المفاتيح فشلت، تبقى processing) | "failed" (خطأ معطيات)
 */
export async function startOnPool(task: TaskRow, def: ModelDef, skipKeyIds: string[] = []): Promise<"started" | "completed" | "waiting" | "failed"> {
  const pool = (await getKeyPool(def.providers)).filter((k) => !skipKeyIds.includes(k.id));
  const input = task.params as Record<string, unknown>;
  for (const key of pool) {
    const adapter = PROVIDERS[key.provider];
    const model = def.providerModel[key.provider];
    const att = (ok: boolean, cls?: string, err?: string): Attempt => ({
      provider: key.provider, keyId: key.id, keyLabel: key.label || maskKey(key.api_key), ok, errorClass: cls, error: err?.slice(0, 200), at: nowIso(),
    });
    try {
      if (def.type === "image" && adapter.createImageSync) {
        const { urls } = await adapter.createImageSync(key.api_key, model, input);
        await recordKeyUse(key.id, true);
        await updateTask(task.id, { provider: key.provider, key_id: key.id, status: "completed", progress: 100, result_urls: urls, error_message: null, addAttempt: att(true) });
        return "completed";
      }
      const { providerTaskId } = await adapter.createTask(key.api_key, model, input, def.type as "image" | "video");
      await recordKeyUse(key.id, true);
      await updateTask(task.id, { provider: key.provider, provider_task_id: providerTaskId, key_id: key.id, status: "processing", progress: 5, error_message: null, addAttempt: att(true) });
      return "started";
    } catch (e) {
      const pe = e instanceof ProviderError ? e : new ProviderError(599, (e as Error).message);
      const cls = classifyProviderError(pe.status, pe.message);
      await recordKeyUse(key.id, false, cls, pe.message);
      await updateTask(task.id, { addAttempt: att(false, cls, pe.message) });
      if (cls === "params") {
        // خطأ معطيات: تبديل المفاتيح لن يحلّه → فشل نهائي
        await updateTask(task.id, { status: "failed", error_message: pe.message });
        return "failed";
      }
      // disabled / exhausted / provider / temporary → المفتاح التالي فورًا
    }
  }
  await updateTask(task.id, { status: "processing", provider_task_id: null, error_message: WAIT_MARK });
  return "waiting";
}

export async function runGeneration(type: "image" | "video", args: Record<string, any>, onProgress?: ProgressFn) {
  const def = resolveModel(args.model, type);
  if (!def) return { error: `❌ موديل غير معروف: ${args.model}` };
  const pool = await getKeyPool(def.providers);
  if (!pool.length) return { error: `❌ لا توجد مفاتيح نشطة لخدمة ${def.canonical}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.` };

  const id = crypto.randomUUID();
  // نسجّل المهمة قبل أي نداء خارجي
  await insertTask({ id, model: def.canonical, type, prompt: String(args.prompt ?? ""), params: buildInput(type, args), status: "pending" });
  const task = (await getTask(id))!;
  await startOnPool(task, def);

  const waitMs = (args.wait_seconds ?? (type === "image" ? 90 : 25)) * 1000;
  const t0 = Date.now();
  let cur = (await getTask(id))!;
  while (cur.status === "processing" || cur.status === "pending") {
    if (Date.now() - t0 >= waitMs) break;
    await sleep(3000);
    cur = await refreshTask(id);
    await onProgress?.(cur.progress, `قيد التوليد… ${cur.progress}%`);
  }
  return { task: cur };
}

/** يحدّث مهمة جارية حيًا من المزود/الخدمة مع منطق إعادة المحاولة والتبديل */
export async function refreshTask(id: string): Promise<TaskRow> {
  let task = await getTask(id);
  if (!task) throw new Error("not found");
  if (task.status === "completed" || task.status === "failed") return task;
  if (task.type === "merge") return refreshMergeTask(task);

  const def = resolveModel(task.model, task.type as MediaType);
  if (!def) return task;

  // لا يوجد provider_task_id: المهمة تنتظر مفتاحًا صالحًا → أعد المحاولة بعد التهدئة
  if (!task.provider_task_id) {
    const last = task.attempts[task.attempts.length - 1];
    if (!last || Date.now() - Date.parse(last.at) > COOLDOWN_MS) await startOnPool(task, def);
    return (await getTask(id))!;
  }

  const key = task.key_id ? await getKey(task.key_id) : null;
  if (!key || key.status === "disabled") {
    // المفتاح حُذف/عُطّل أثناء المهمة → أعد إنشاءها على المفتاح التالي بنفس task_id
    await updateTask(id, { provider_task_id: null });
    await startOnPool({ ...task, provider_task_id: null }, def, key ? [key.id] : []);
    return (await getTask(id))!;
  }

  try {
    const r = await PROVIDERS[key.provider].checkTask(key.api_key, task.provider_task_id);
    if (r.status === "completed") {
      await updateTask(id, { status: "completed", progress: 100, result_urls: r.urls ?? [], error_message: null });
    } else if (r.status === "failed") {
      if (KEY_PROBLEM_RE.test(r.error ?? "")) {
        // فشل مفتاح/رصيد في المنتصف: علّمه وأكمل على التالي بصمت
        const cls = classifyProviderError(/401|unauthor/i.test(r.error!) ? 401 : 402, r.error!);
        await recordKeyUse(key.id, false, cls, r.error);
        await updateTask(id, { provider_task_id: null, addAttempt: { provider: key.provider, keyId: key.id, keyLabel: key.label || maskKey(key.api_key), ok: false, errorClass: cls, error: r.error?.slice(0, 200), at: nowIso() } });
        await startOnPool({ ...task, provider_task_id: null }, def, [key.id]);
      } else {
        await updateTask(id, { status: "failed", error_message: r.error ?? "فشل التوليد" });
      }
    } else {
      await updateTask(id, { progress: Math.max(task.progress, r.progress ?? task.progress) });
    }
  } catch (e) {
    const pe = e instanceof ProviderError ? e : new ProviderError(599, (e as Error).message);
    const cls = classifyProviderError(pe.status, pe.message);
    if (cls === "disabled" || cls === "exhausted") {
      await recordKeyUse(key.id, false, cls, pe.message);
      await updateTask(id, { provider_task_id: null });
      await startOnPool({ ...task, provider_task_id: null }, def, [key.id]);
    }
    // أخطاء مؤقتة: نبقي المهمة processing ونعيد الاستعلام لاحقًا
  }
  return (await getTask(id))!;
}

export type { ApiKeyRow };
