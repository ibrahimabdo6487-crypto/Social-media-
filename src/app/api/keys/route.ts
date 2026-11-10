// src/app/api/keys/route.ts — إدارة مفاتيح المزودين (لوحة الإدارة)
// المفاتيح تُخزن في قاعدة Turso وتُخفى دائمًا في كل الاستجابات (maskKey) — لا تُعاد كاملة أبدًا
import { NextRequest, NextResponse } from "next/server";
import { ensureSchema, findDuplicateKey, insertKey, listKeys } from "@/lib/turso";
import { maskKey } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROVIDERS = ["kie", "cometapi"];

function maskRow(k: Awaited<ReturnType<typeof listKeys>>[number]) {
  return {
    id: k.id, provider: k.provider, label: k.label, masked: maskKey(k.api_key),
    status: k.status, usage_count: k.usage_count, success_count: k.success_count,
    fail_count: k.fail_count, last_used_at: k.last_used_at, last_checked_at: k.last_checked_at,
    last_error: k.last_error, created_at: k.created_at,
  };
}

export async function GET() {
  try {
    await ensureSchema();
    const keys = await listKeys();
    return NextResponse.json({ keys: keys.map(maskRow) });
  } catch (e) {
    return NextResponse.json({ error: `فشل جلب المفاتيح: ${(e as Error).message}` }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureSchema();
    const body = (await req.json().catch(() => null)) as { provider?: string; api_key?: string; label?: string } | null;
    const provider = String(body?.provider ?? "").trim();
    const apiKey = String(body?.api_key ?? "").trim();
    const label = String(body?.label ?? "").trim().slice(0, 80);

    if (!PROVIDERS.includes(provider)) {
      return NextResponse.json({ error: "المزود غير معروف — القيم المسموحة: kie أو cometapi" }, { status: 400 });
    }
    if (!apiKey || apiKey.length < 8) {
      return NextResponse.json({ error: "المفتاح قصير أو فارغ — الصق المفتاح الكامل كما هو" }, { status: 400 });
    }
    if (await findDuplicateKey(provider, apiKey)) {
      return NextResponse.json({ error: "هذا المفتاح موجود مسبقًا لنفس المزود — لن يُضَف مكررًا" }, { status: 409 });
    }
    const id = await insertKey(provider, apiKey, label);
    return NextResponse.json({ ok: true, id, message: "تمت إضافة المفتاح — الترتيب التسلسلي يتبع وقت الإضافة" }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: `فشل إضافة المفتاح: ${(e as Error).message}` }, { status: 500 });
  }
}
