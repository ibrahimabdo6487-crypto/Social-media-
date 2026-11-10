import { dbCheck } from "@/lib/turso";
import { MODELS } from "@/lib/models";
import { mergerBase, mergerHealthy } from "@/lib/merger";
import { mcpAuthRequired } from "@/lib/auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [dbr, mOk] = await Promise.all([dbCheck(), mergerHealthy()]);
  const dbOk = dbr.ok;
  return Response.json({
    ok: dbOk, database: dbOk ? "turso-connected" : "turso-disconnected", ...(dbOk ? {} : { databaseError: dbr.error }), mcpEndpoint: "/mcp",
    models: MODELS.map((m) => ({ canonical: m.canonical, type: m.type, providers: m.providers })),
    merger: { base: mergerBase(), healthy: mOk }, authRequired: mcpAuthRequired(),
  });
}
