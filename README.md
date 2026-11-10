# مولّد الوسائط — خادم MCP لتوليد الصور والفيديو ودمج المقاطع

خادم **MCP** (بروتوكول Streamable HTTP) يعرض **5 أدوات** يستدعيها أي عميل ذكاء اصطناعي
(ChatGPT Connectors / Claude Desktop / Cursor / Windsurf / Cline / GPT Agents SDK)،
مع **لوحة إدارة عربية** لإدارة مفاتيح API ومتابعة المهام حيًا وعرض إعدادات الربط جاهزة للنسخ.

المستودع يحوي مشروعين ينشران معًا على Vercel:

| المسار | المشروع | الوصف |
|---|---|---|
| الجذر | **مولّد الوسائط (Next.js)** | خادم MCP على `/mcp` + لوحة إدارة + تخزين المهام والمفاتيح في Turso |
| `merger/` | **خدمة دمج الفيديو v2 (Node.js خالص)** | دمج 2–10 مقاطع عبر ffmpeg داخل دوال Vercel + تخزين الناتج في Turso |

---

## المزايا الأساسية (قواعد لا تُخرَق)

1. **بلا تخزين وسائط على السيرفر** — لا تُنزَّل أي صورة/فيديو إلى سيرفرنا أبدًا؛ نخزّن **روابط النتائج فقط** في قاعدة البيانات.
2. **تبديل تسلسلي صارم للمفاتيح** — المفاتيح تُجرَّب بترتيب إضافتها (الأول ضُيف يُجرَّب أولًا) مع تبديل تلقائي فوري عند أي خطأ أو نفاد رصيد **دون توقف المهمة**: تُستأنف نفس المهمة بنفس `task_id` على المفتاح التالي، ونموذج الذكاء الاصطناعي **لا يرى أخطاء المفاتيح أو الرصيد أبدًا**.
3. **توليد غير متزامن** — الأداة تعيد `task_id` فورًا مع نافذة انتظار قصيرة تبث تقدمًا حيًا، ويُتابع بأداة `get_task` كل ~10 ثوانٍ.
4. **الموديلات مثبتة** — صور: `gpt-image-2-6/flare-text-to-image` · فيديو: `grok-imagine-video-1-5-preview` (بصوت متزامن أصلي).

## الأدوات الخمس على `/mcp`

| الأداة | الوظيفة |
|---|---|
| `generate_image` | توليد صورة من وصف نصي (نسبة أبعاد، دقة 1K/2K/4K، خلفية، صيغة) |
| `generate_video` | توليد فيديو بأسلوب Grok Imagine بصوت متزامن (مدة 1–15 ث، أول إطار اختياري) |
| `merge_videos` | دمج 2–10 مقاطع (روابط مباشرة و/أو task_ids لمهام مكتملة) في MP4 واحد CRF 18 |
| `get_task` | متابعة أي مهمة كل ~10 ثوانٍ حتى الاكتمال |
| `list_media` | عرض الوسائط المخزنة (روابط فقط) مع تصفية |

أمثلة ردود الأدوات (كلها بالعربية):

```
✅ تم توليد الصورة بنجاح
![image](https://tempfile.aiquickdraw.com/.../xxx.png)
الرابط المباشر: https://tempfile.aiquickdraw.com/.../xxx.png

⏳ المهمة قيد المعالجة — task_id: <uuid>
تابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.

✅ تم دمج المقاطع بنجاح
الرابط المباشر: https://<merger>/api/jobs/<id>/video
⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.
```

> خطأ موديل غير معروف أو معطيات غير صالحة يظهر للنموذج مباشرة (توقف فوري — تبديل المفاتيح لا يصلحه)، أما أخطاء المفاتيح/الرصيد فتُستبدل تلقائيًا بالاستئناف على المفتاح التالي.

---

## المتغيرات البيئية (التطبيق الرئيسي)

| المتغير | إلزامي | الوصف |
|---|---|---|
| `TURSO_DATABASE_URL` | ✅ | رابط قاعدة Turso مثل `libsql://…` |
| `TURSO_AUTH_TOKEN` | ✅ | توكيد Turso (صلاحية كتابة) |
| `MERGER_API_BASE` | ✅ للدمج | عنوان نشر خدمة الدمج `https://<merger>.vercel.app` |
| `MCP_ACCESS_TOKEN` | اختياري | إن ضُبط: يلزم `Authorization: Bearer <token>` على `/mcp` |
| `KIE_IMAGE_MODEL` / `KIE_VIDEO_MODEL` | اختياري | تجاوز اسم موديل kie (الافتراضي مثبت من المواصفة) |
| `COMETAPI_IMAGE_MODEL` / `COMETAPI_VIDEO_MODEL` | اختياري | تجاوز اسم موديل CometAPI |

انظر `.env.example`. **لا تضع أي مفتاح مزود في متغيرات البيئة** — المفاتيح تُدار من اللوحة وتُخزن في القاعدة وتظهر مخفية (`abc1234••••••••wxyz`) دائمًا.

---

## التشغيل المحلي

```bash
# 1) التطبيق الرئيسي (Next.js)
cp .env.example .env.local   # ثم املأ القيم الحقيقية
npm install
npm run build && npm start   # يعمل على http://localhost:3000

# 2) خدمة الدمج (اختياري محليًا — للدمج فقط)
cd merger
cp .env.example .env         # ثم املأ TURSO_*
npm install
npm start                    # خادم تطوير يحاكي Vercel على http://localhost:8787
```

ثم ضع `MERGER_API_BASE=http://localhost:8787` في `.env.local` للتطبيق الرئيسي.

### اختبار MCP سريع بـ curl

```bash
curl -X POST http://localhost:3000/mcp -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'

curl -X POST http://localhost:3000/mcp -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

### الاختبارات

```bash
# خدمة الدمج: وحدات + HTTP كامل (Range، حدود، حذف، رفع أجزاء)
cd merger && npm test

# التطبيق الرئيسي: e2e عبر بروتوكول MCP (صورة/فيديو/دمج/تبديل تسلسلي) — يحتاج خادمين يعملان
KIE_KEY=<مفتاحك> node scripts/mcp_e2e.js
```

---

## النشر على Vercel (مشروعان من مستودع واحد)

### 1) خدمة الدمج أولًا

1. Vercel → **Add New Project** → اختر هذا المستودع.
2. في **Root Directory** اختر `merger` (سيكتشف «Other» تلقائيًا).
3. Environment Variables:
   - `TURSO_DATABASE_URL` = رابط Turso
   - `TURSO_AUTH_TOKEN` = توكيد Turso
4. Deploy — سيُنشأ رابط مثل `https://<اسم-المشروع>.vercel.app`.
5. (تم مسبقًا) `merger/vercel.json` يضبط `maxDuration=300` وذاكرة 3009MB ومجدول `/api/cron` يوميًا لحذف المنتهيات.

### 2) التطبيق الرئيسي

1. Vercel → **Add New Project** → نفس المستودع (مرة أخرى) — Root Directory = الجذر (يكتشف Next.js تلقائيًا).
2. Environment Variables:
   - `TURSO_DATABASE_URL` و `TURSO_AUTH_TOKEN` (نفس القيم)
   - `MERGER_API_BASE` = **رابط مشروع الدمج من الخطوة 1**
3. Deploy.

### 3) إضافة مفاتيح المزود

افتح لوحة الإدارة `https://<مشروع-الرئيسي>.vercel.app` → تبويب **المفاتيح** → أضف مفتاح `kie.ai` (أو `cometapi`). الترتيب التسلسلي يتبع وقت الإضافة.

> ملاحظة حدود خطة Vercel Hobby: مدة الدالة حتى 300 ثانية مع Fluid Compute — الدمج الطويل (10 مقاطع كبيرة) قد يقترب من الحد؛ خفّض عدد المقاطع أو رقِّ الخطة.

---

## فحص الجهوزية

`GET /api/health` يعيد حالة كل شيء:

```json
{
  "healthy": true,
  "turso": { "healthy": true, "schema": true },
  "merger": { "healthy": true, "configured": true, "base": "https://…" },
  "keys": { "total": 2, "active": 1, "exhausted": 0, "disabled": 1 },
  "tasks": { "total": 5, "completed": 3, "failed": 0, "processing": 2 },
  "mode": "sequential-keys + async-tasks + merger-v2"
}
```

## إعدادات ربط العملاء

كلها جاهزة للنسخ في اللوحة (تبويب **الربط والاتصال**): Cursor/Windsurf/Cline (`mcp.json`)، Claude Desktop، ChatGPT Connectors — كلها تشير إلى `https://<نطاقك>/mcp`.

## البنية

```
├─ src/
│  ├─ app/mcp/route.ts            ← خادم MCP (SDK الرسمي، وضع stateless JSON)
│  ├─ app/api/health|keys|tasks   ← نقاط لوحة الإدارة
│  ├─ app/page.tsx                ← اللوحة العربية (مفاتيح/مهام/ربط)
│  └─ lib/
│     ├─ turso.ts                 ← العميل + المخطط + عمليات المهام/المفاتيح
│     ├─ keys.ts                  ← تصنيف الأخطاء (exhausted/disabled/params/…) + maskKey
│     ├─ models.ts                ← سجل الموديلات والأسماء القانونية
│     ├─ generation.ts            ← منسّق التبديل التسلسلي + نافذة الانتظار + الدمج
│     ├─ merger.ts                ← عميل خدمة الدمج v2 (تحليل حالة دفاعي)
│     └─ providers/kie.ts|cometapi.ts ← محولات المزودين (أشكال مقاسة فعليًا)
├─ merger/                        ← خدمة الدمج (Node خالص — انظر merger/README.md)
└─ scripts/mcp_e2e.js             ← اختبار e2e عبر بروتوكول MCP
```

## ملاحظات أمان

- مفاتيح المزودين تُخزن في Turso ولا تظهر إلا مخفية في اللوحة والسجلات (`maskKey`).
- `.env*` في `.gitignore` من اليوم الأول — لا مفاتيح في المستودع.
- روابط النتائج تبقى على بنية المزود (aiquickdraw/kie) أو خدمة الدمج؛ نطاق الخدمة لا يفصح أي شيء داخلي.
