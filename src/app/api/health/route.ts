// src/app/api/health/route.ts — فحص الجهوزية: القاعدة، المخطط، خدمة الدمج، المفاتيح، الإحصاءات
import { NextResponse } from "next/server";
import { dbHealthy, ensureSchema, listKeys, taskStats } from "@/lib/turso";
import { mergerConfigured, mergerHealthy } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  let tursoOk = false;
  let schemaOk = false;
  const err: string[] = [];
  try { tursoOk = await dbHealthy(); } catch (e) { err.push(`turso: ${(e as Error).message}`); }
  try { await ensureSchema(); schemaOk = true; } catch (e) { err.push(`schema: ${(e as Error).message}`); }

  const configured = mergerConfigured();
  let mergerOk = false;
  try { mergerOk = configured ? await mergerHealthy() : false; } catch { mergerOk = false; }

  let keys = { total: 0, active: 0, exhausted: 0, disabled: 0, providers: {} as Record<string, number> };
  let tasks = { total: 0, completed: 0, failed: 0, processing: 0 };
  try {
    const k = await listKeys();
    keys = {
      total: k.length,
      active: k.filter((x) => x.status === "active").length,
      exhausted: k.filter((x) => x.status === "exhausted").length,
      disabled: k.filter((x) => x.status === "disabled").length,
      providers: k.reduce<Record<string, number>>((acc, x) => { acc[x.provider] = (acc[x.provider] ?? 0) + 1; return acc; }, {}),
    };
    tasks = await taskStats();
  } catch (e) { err.push(`stats: ${(e as Error).message}`); }

  const healthy = tursoOk && schemaOk;
  return NextResponse.json({
    healthy,
    turso: { healthy: tursoOk, schema: schemaOk, engine: "libsql HTTP (Turso)" },
    merger: { healthy: mergerOk, configured, base: configured ? mergerBasePublic() : null },
    keys,
    tasks,
    mode: "sequential-keys + async-tasks + merger-v2",
    errors: err.length ? err : undefined,
  }, { status: healthy ? 200 : 503 });
}

function mergerBasePublic(): string {
  try { return new URL(process.env.MERGER_API_BASE || "").origin; } catch { return ""; }
}
