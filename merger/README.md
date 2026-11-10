# خدمة دمج الفيديو v2 — Video Merger API

دمج 2–10 مقاطع فيديو في **MP4 واحد عالي الجودة (H.264 + AAC، CRF 18، 30fps، حتى 1080p)** عبر
**ffmpeg داخل دوال Vercel** (Node.js خالص CommonJS — بلا Next.js/React/خطوة بناء)،
مع تخزين الناتج في **Turso (libSQL)** كأجزاء Blob بحجم 2MB لكل صف.

النطاق العام: المخرجات تُقدَّم عبر هذا النطاق فقط — لا روابط داخلية/خاصة أبدًا.

## API (بلا توثيق — CORS مفتوح)

| Method | Endpoint | الوظيفة |
|---|---|---|
| `POST` | `/api/jobs` | إنشاء مهمة — `{"videos":[…]}` أو `{"sources":[{"kind":"url","url":…},{"kind":"file","name":…,"size":…,"mime":…}]}` |
| `POST` | `/api/upload?job=&seq=&chunk=` | رفع أجزاء الملفات (ثنائي ≤4MB، `application/octet-stream`) |
| `POST` | `/api/jobs/<id>/process` | تنفيذ الدمج كاملًا (متزامن) → JSON النتيجة مباشرة |
| `GET` | `/api/jobs/<id>` | الحالة + التقدم (0–100) + الرابط عند الاكتمال |
| `GET` | `/api/jobs/<id>/video` | بث الناتج بدعم `Range` (206) — `?download=1` للتحميل |
| `DELETE` | `/api/jobs/<id>` | حذف فوري شامل (المهمة + المصادر + الناتج) |
| `GET` | `/api/config` | الحدود العامة + version |
| `GET` | `/api/cron` | حذف المهام المنتهية (مجدول يومي عبر `vercel.json`) |

كل الأخطاء بصيغة `{"error":"رسالة عربية واضحة"}`.

حالات المهمة: `queued` → (`uploading`) → `processing` → `done` | `failed`.

## مثال سريع

```bash
# 1) إنشاء مهمة من روابط
curl -X POST https://<merger>/api/jobs -H "Content-Type: application/json" \
  -d '{"videos":["https://example.com/a.mp4","https://example.com/b.mp4"]}'
# → {"jobId":"…","status":"queued","statusUrl":"…","processUrl":"…","expiresAt":"…"}

# 2) تنفيذ الدمج (متزامن — قد يستغرق حتى 300 ثانية)
curl -X POST https://<merger>/api/jobs/<jobId>/process
# → {"status":"done","videoUrl":"https://<merger>/api/jobs/<jobId>/video","size":…,"duration":…,"resolution":"1280x720"}

# 3) البث/التحميل
curl -H "Range: bytes=0-1023" https://<merger>/api/jobs/<jobId>/video -o part1.bin
curl https://<merger>/api/jobs/<jobId>/video?download=1 -o merged.mp4
```

الواجهة العربية الكاملة (سحب وإفلات، ترتيب، رفع أجزاء، شريط تقدم حي، عدّاد 24 ساعة، استئناف عبر `#job=<id>`) على الصفحة الرئيسية `public/index.html`.

## الحدود (قابلة للضبط عبر متغيرات البيئة)

| المتغير | الافتراضي | المعنى |
|---|---|---|
| `MAX_SOURCES` | 10 | أقصى عدد مقاطع |
| `SOURCE_MAX_MB` | 200 | حد حجم كل مصدر (يُفرَض أثناء التنزيل بايت ببايت) |
| `OUTPUT_MAX_MB` | 150 | حد حجم الناتج |
| `MAX_TOTAL_DURATION_SEC` | 600 | مجموع مدد المقاطع |
| `FFMPEG_PRESET` | medium | سرعة/جودة الترميز |
| `PORT` | 8787 | منفذ خادم التطوير المحلي |

نطاق التقدم أثناء المعالجة: **0–40** سحب/تجميع المصادر · **40–90** ترميز ffmpeg · **95–100** حفظ الناتج في Turso.

## سلوكيات مضمونة

- **مصدر بلا صوت** → مسار صامت `anullsrc` بنفس مدته (لا يفشل الدمج أبدًا بسبب الصوت).
- **توحيد إجباري**: scale + pad إلى أكبر أبعاد المدخلات (زوجية)، fps=30، `setsar=1`، `format=yuv420p` — ثم `concat=n:v=1:a=1` بالترتيب المطلوب.
- `+faststart` دائمًا — الناتج يعمل فورًا في المتصفحات وتطبيقات الهاتف.
- تجاوز أي حد = **فشل واضح برسالة عربية** (`{"error":…}` + حالة `failed`) وليس انهيارًا.
- استئناف من 404/`error` بلا `status` → فشل نهائي فوري (تحليل دفاعي حسب المواصفة 7.2)؛ أخطاء شبكتنا فقط لا توقف الاستطلاع.
- **حذف كسول + مجدول**: كل الملفات تُحذف تلقائيًا بعد **24 ساعة** (عند كل إنشاء + `/api/cron` يوميًا)، وتُحذف أجزاء المصادر فور نجاح الدمج.
- بث `Range` من Turso بالصفحات (8 صفوف = 16MB لكل استعلام) — بلا تحميل كامل في الذاكرة، وأخطاء 416/206 قياسية.

## التشغيل المحلي

```bash
cp .env.example .env   # املأ TURSO_DATABASE_URL و TURSO_AUTH_TOKEN
npm install
npm start              # خادم تطوير يحاكي Vercel: يحلّل المسارات الديناميكية إلى req.query ويقدّم public/
npm test               # وحدات (دمج ffmpeg حقيقي + sha256 للتخزين) ثم HTTP كامل
```

## النشر على Vercel

1. **Root Directory** = `merger` (يكتشف «Other» تلقائيًا).
2. متغيرات البيئة: `TURSO_DATABASE_URL`، `TURSO_AUTH_TOKEN`.
3. `vercel.json` مرفق مسبقًا: `maxDuration=300`، ذاكرة 3009MB، ومجدول `/api/cron` يومي.

## التخزين

- `jobs` — المهمة (الحالة، التقدم، الميتاداتا، `expires_at`)
- `sources` — المصادر (url أو ملف + حجم/نوع)
- `source_chunks` — أجزاء الملفات المرفوعة (2MB/صف، تُحذف بعد نجاح الدمج)
- `output_chunks` — الناتج النهائي (2MB/صف، يُبثّ مباشرة بدعم Range)

لا يُخزَّن أي ملف على القرص سوى ملفات مؤقتة على `/tmp` أثناء المعالجة وتُنظَّف دائمًا.
