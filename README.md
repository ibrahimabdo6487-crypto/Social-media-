# MCP Media Generator

خادم MCP لتوليد الصور والفيديو (kie.ai / CometAPI) ودمج المقاطع + لوحة إدارة عربية. Next.js + Turso.

## النشر على Vercel
1. اربط هذا المستودع في Vercel (Import Project).
2. أضف المتغيرات: `TURSO_DATABASE_URL` و `TURSO_AUTH_TOKEN` و `MERGER_API_BASE` (انظر `.env.example`).
3. Deploy. الجداول تُنشأ تلقائيًا عند أول طلب.
4. افتح الموقع ← أضف مفاتيح kie.ai من بطاقة «مدير المفاتيح» ← انسخ رابط `/mcp` إلى عميل MCP.

## نقاط مهمة
- المفاتيح تُجرَّب بترتيب الإضافة مع تبديل تلقائي صامت (انظر `src/lib/generation.ts`).
- `/mcp` يعمل بدون حالة (stateless) ليناسب serverless. `MCP_ACCESS_TOKEN` اختياري لحمايته.
- لوحة الإدارة و`/api/keys` بلا تسجيل دخول (حسب المواصفة) — لا تنشر الرابط علنًا.
- `MERGER_API_BASE` يجب أن يشير إلى خدمة الدمج (القسم 14 من البرومبت الأصلي).
- اختبار محلي: `node scripts/mock-services.mjs` ثم `TURSO_DATABASE_URL=file:/tmp/t.db KIE_API_BASE=http://localhost:4010 MERGER_API_BASE=http://localhost:4010 npm run dev -- -p 3100` ثم `node scripts/test-e2e.mjs`.
