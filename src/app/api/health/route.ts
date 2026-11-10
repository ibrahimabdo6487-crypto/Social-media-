import { dbHealthy } from "@/lib/turso";
import { MODELS } from "@/lib/models";
import { mergerBase, mergerHealthy } from "@/lib/merger";
import { mcpAuthRequired } from "@/lib/auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [dbOk, mOk] = await Promise.all([dbHealthy(), mergerHealthy()]);
  return Response.json({
    ok: dbOk, database: dbOk ? "turso-connected" : "turso-disconnected", mcpEndpoint: "/mcp",
    models: MODELS.map((m) => ({ canonical: m.canonical, type: m.type, providers: m.providers })),
    merger: { base: mergerBase(), healthy: mOk }, authRequired: mcpAuthRequired(),
  });
}
