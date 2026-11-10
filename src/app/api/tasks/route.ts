import { listRecentTasks, taskStats } from "@/lib/turso";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [tasks, stats] = await Promise.all([listRecentTasks(30), taskStats()]);
  // لا نكشف رسائل الانتظار الداخلية للمفاتيح؛ الواجهة تعرض فقط عدد المحاولات
  return Response.json({
    stats,
    tasks: tasks.map((t) => ({
      id: t.id, type: t.type, status: t.status, progress: t.progress, model: t.model, prompt: t.prompt.slice(0, 120),
      created_at: t.created_at, result_urls: t.result_urls, attempts: t.attempts.length,
      error: t.status === "failed" ? t.error_message : null,
    })),
  });
}
