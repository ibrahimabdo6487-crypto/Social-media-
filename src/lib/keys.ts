// src/lib/keys.ts — تصنيف الأخطاء وإخفاء المفاتيح (قلب نظام التبديل التسلسلي)
import type { KeyRow } from "./turso";

export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

// ترتيب الفحص مقصود (المواصفة 4.2):
// 1) نفاد الرصيد بالرسالة قبل فحص 400 — بعض المزودين يرسلونه بحالة 400 أو حتى 200
// 2) مفتاح مرفوض (401/403 أو رسالة توثيق)
// 3) 402 → مستنزف
// 4) موديل غير مدعوم
// 5) 400/422 → معطيات (توقف فورًا — تبديل المفاتيح لا يصلحها)
// 6) الباقي (429/5xx/شبكة) → مؤقت
export function classifyProviderError(status: number, message: string): ErrorClass {
  const m = (message || "").toLowerCase();
  if (/insufficient|quota|balance|credit|out of credits|exhausted|充值|no enough/.test(m)) return "exhausted";
  if (status === 401 || status === 403 || /invalid api key|invalid token|unauthorized|forbidden|authentication|apikey/.test(m)) return "disabled";
  if (status === 402) return "exhausted";
  if ([400, 404, 422].includes(status) && /model not found|unsupported model|no such model|does not exist/.test(m)) return "provider";
  if (status === 400 || status === 422) return "params";
  return "temporary";
}

// الإجراء المقترح على المفتاح حسب الفئة — disabled هو الحالة الوحيدة المُعلَّمة مطلقًا
// (exhausted تبقى في القاعدة والقائمة ولا تُستبعد من الترتيب)
export function keyStatusForClass(cls: ErrorClass): string | undefined {
  if (cls === "disabled") return "disabled";
  if (cls === "exhausted") return "exhausted";
  return undefined;
}

// إخفاء المفتاح إلزامي في كل الاستجابات والسجلات — لا يُعاد المفتاح الكامل أبدًا
export function maskKey(k: string): string {
  if (k.length <= 8) return k.slice(0, 3) + "•••";
  return `${k.slice(0, 7)}••••••••${k.slice(-4)}`;
}

export function keyLabel(key: KeyRow): string {
  return key.label ? `${key.provider}:${key.label}` : `${key.provider}:${maskKey(key.api_key)}`;
}
