// نظام المفاتيح المتسلسلة + تصنيف أخطاء المزودين
import { db, ensureSchema } from "./turso";
import type { ProviderId } from "./models";

export interface ApiKeyRow {
  id: string; provider: ProviderId; label: string; api_key: string;
  status: "active" | "exhausted" | "disabled"; usage_count: number; success_count: number;
  fail_count: number; last_used_at: string | null; last_checked_at: string | null;
  last_error: string | null; created_at: string;
}

export class ProviderError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// إخفاء المفتاح دائمًا: أول 7 + •••••••• + آخر 4 (القصير: أول 3 + ••••)
export function maskKey(k: string): string {
  if (k.length < 14) return k.slice(0, 3) + "••••";
  return k.slice(0, 7) + "••••••••" + k.slice(-4);
}

export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

// تصنيف موحد. نفاد الرصيد يُفحص قبل 400 لأن بعض المزودين يرسله بحالة 400
export function classifyProviderError(status: number, message: string): ErrorClass {
  const m = (message || "").toLowerCase();
  if (status === 401 || status === 403 || /invalid api key|unauthorized|forbidden|authentication/.test(m)) return "disabled";
  if (status === 402 || /insufficient|quota|balance|credit|out of credits|exhausted|充值/.test(m)) return "exhausted";
  if ([400, 404, 422].includes(status) && /model not found|unsupported model|model.*not.*support/.test(m)) return "provider";
  if (status === 400 || status === 422) return "params";
  return "temporary"; // 429 / 5xx / شبكة / timeout
}

// نمط «مشكلة مفتاح/رصيد» لفشل منتصف المهمة (نصوص يعلنها المزود)
export const KEY_PROBLEM_RE = /insufficient|balance|credit|quota|402|401|unauthorized|exhausted|充值/i;

const norm = (r: Record<string, unknown>) => r as unknown as ApiKeyRow;

// الترتيب التسلسلي الصارم: الأقدم إضافةً أولًا. exhausted يبقى في القائمة
export async function getKeyPool(providers: ProviderId[]): Promise<ApiKeyRow[]> {
  await ensureSchema();
  const ph = providers.map(() => "?").join(",");
  const r = await db().execute({
    sql: `SELECT * FROM api_keys WHERE status != 'disabled' AND provider IN (${ph}) ORDER BY created_at ASC, id ASC`,
    args: providers,
  });
  return r.rows.map((x) => norm(x as unknown as Record<string, unknown>));
}

export async function getKey(id: string): Promise<ApiKeyRow | null> {
  await ensureSchema();
  const r = await db().execute({ sql: "SELECT * FROM api_keys WHERE id = ?", args: [id] });
  return r.rows[0] ? norm(r.rows[0] as unknown as Record<string, unknown>) : null;
}

export async function listKeys(): Promise<ApiKeyRow[]> {
  await ensureSchema();
  const r = await db().execute("SELECT * FROM api_keys ORDER BY created_at ASC, id ASC");
  return r.rows.map((x) => norm(x as unknown as Record<string, unknown>));
}

export async function addKey(provider: ProviderId, apiKey: string, label = ""): Promise<{ id: string } | { duplicate: true }> {
  await ensureSchema();
  const dup = await db().execute({ sql: "SELECT id FROM api_keys WHERE provider = ? AND api_key = ?", args: [provider, apiKey] });
  if (dup.rows.length) return { duplicate: true };
  const id = crypto.randomUUID();
  // created_at بدقة الميلي ثانية لضمان ثبات ترتيب الإضافة
  await db().execute({
    sql: "INSERT INTO api_keys (id, provider, label, api_key, created_at) VALUES (?,?,?,?, strftime('%Y-%m-%d %H:%M:%f','now'))",
    args: [id, provider, label, apiKey],
  });
  return { id };
}

export async function setKeyStatus(id: string, status: "active" | "disabled" | "exhausted", lastError?: string) {
  await ensureSchema();
  await db().execute({
    sql: "UPDATE api_keys SET status = ?, last_error = COALESCE(?, last_error), last_checked_at = datetime('now') WHERE id = ?",
    args: [status, lastError ?? null, id],
  });
}

export async function deleteKey(id: string) {
  await ensureSchema();
  await db().execute({ sql: "DELETE FROM api_keys WHERE id = ?", args: [id] });
}

// تحديث عدّادات المفتاح بعد كل محاولة (نجاح أو فشل)
export async function recordKeyUse(id: string, ok: boolean, cls?: ErrorClass, error?: string) {
  await ensureSchema();
  let status: string | null = null;
  if (!ok && cls === "disabled") status = "disabled";
  else if (!ok && cls === "exhausted") status = "exhausted";
  else if (ok) status = "active"; // نجح فعليًا → أعد تنشيطه إن كان exhausted سابقًا
  await db().execute({
    sql: `UPDATE api_keys SET usage_count = usage_count + 1,
          success_count = success_count + ?, fail_count = fail_count + ?,
          last_used_at = datetime('now'), last_checked_at = datetime('now'),
          last_error = ?, status = COALESCE(?, status) WHERE id = ?`,
    args: [ok ? 1 : 0, ok ? 0 : 1, ok ? null : (error ?? "").slice(0, 300), status, id],
  });
}
