// صياغة الردود العربية الجاهزة للعرض
import type { TaskRow } from "./turso";

export function formatTask(t: TaskRow): { text: string; isError: boolean } {
  if (t.status === "completed") {
    const urls = t.result_urls;
    if (t.type === "image") {
      const lines = ["✅ تم توليد الصورة بنجاح", ""];
      urls.forEach((u) => { lines.push(`![image](${u})`, `الرابط المباشر: ${u}`, ""); });
      return { text: lines.join("\n").trim(), isError: false };
    }
    const head = t.type === "merge" ? "✅ تم دمج المقاطع بنجاح" : "✅ تم توليد الفيديو بنجاح";
    const lines = [head, "", ...urls.map((u) => `الرابط المباشر: ${u}`)];
    if (t.type === "merge") lines.push("", "⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.");
    return { text: lines.join("\n"), isError: false };
  }
  if (t.status === "failed") return { text: `❌ فشلت المهمة: ${t.error_message ?? "سبب غير معروف"}`, isError: true };
  // جارية: لا نكشف أي شيء عن المفاتيح/الرصيد
  return { text: `⏳ المهمة قيد المعالجة — task_id: ${t.id}\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`, isError: false };
}
