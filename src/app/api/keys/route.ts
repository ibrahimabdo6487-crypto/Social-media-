import { addKey, listKeys, maskKey } from "@/lib/keys";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const keys = await listKeys();
  return Response.json({ keys: keys.map(({ api_key, ...k }) => ({ ...k, masked: maskKey(api_key) })) });
}
export async function POST(req: Request) {
  const b = await req.json().catch(() => ({}));
  const provider = b.provider, key = String(b.api_key ?? "").trim();
  if (!["kie", "cometapi"].includes(provider) || !key) return Response.json({ error: "المزود والمفتاح مطلوبان" }, { status: 400 });
  const r = await addKey(provider, key, String(b.label ?? ""));
  if ("duplicate" in r) return Response.json({ error: "هذا المفتاح مضاف مسبقًا لنفس المزود" }, { status: 409 });
  return Response.json({ id: r.id }, { status: 201 });
}
