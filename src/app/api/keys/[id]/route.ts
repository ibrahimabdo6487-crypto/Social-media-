// src/app/api/keys/[id]/route.ts — تعطيل/تفعيل/حذف مفتاح
// المفتاح المعطَّل يدويًا (disabled) هو الاستثناء الوحيد المُستبعد من القائمة التسلسلية
import { NextRequest, NextResponse } from "next/server";
import { deleteKey, setKeyStatus } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as { status?: string } | null;
  const status = String(body?.status ?? "");
  if (!["active", "disabled"].includes(status)) {
    return NextResponse.json({ error: "الحالة المسموحة: active أو disabled فقط (exhausted يُدار تلقائيًا — فعِّله بـ active)" }, { status: 400 });
  }
  try {
    await setKeyStatus(id, status);
    return NextResponse.json({ ok: true, id, status });
  } catch (e) {
    return NextResponse.json({ error: `فشل تحديث المفتاح: ${(e as Error).message}` }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    await deleteKey(id);
    return NextResponse.json({ ok: true, id, deleted: true });
  } catch (e) {
    return NextResponse.json({ error: `فشل حذف المفتاح: ${(e as Error).message}` }, { status: 500 });
  }
}
