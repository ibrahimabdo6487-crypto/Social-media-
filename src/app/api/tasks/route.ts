// src/app/api/tasks/route.ts — قائمة المهام الأخيرة + الإحصاءات (لوحة المتابعة الحية)
import { NextRequest, NextResponse } from "next/server";
import { ensureSchema, listRecentTasks, taskStats } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    await ensureSchema();
    const type = req.nextUrl.searchParams.get("type") ?? undefined;
    const status = req.nextUrl.searchParams.get("status") ?? undefined;
    const limit = Math.min(30, Math.max(1, Number(req.nextUrl.searchParams.get("limit") ?? 20) || 20));
    const [tasks, stats] = await Promise.all([listRecentTasks(limit, { type, status }), taskStats()]);
    return NextResponse.json({ tasks, stats });
  } catch (e) {
    return NextResponse.json({ error: `فشل جلب المهام: ${(e as Error).message}` }, { status: 500 });
  }
}
