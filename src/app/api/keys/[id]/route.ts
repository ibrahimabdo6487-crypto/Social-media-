import { deleteKey, setKeyStatus } from "@/lib/keys";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const b = await req.json().catch(() => ({}));
  if (!["active", "disabled"].includes(b.status)) return Response.json({ error: "حالة غير صالحة" }, { status: 400 });
  await setKeyStatus(id, b.status);
  return Response.json({ ok: true });
}
export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await deleteKey(id);
  return Response.json({ ok: true });
}
