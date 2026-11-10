# موقع دمج الفيديوهات (Video Merger) — Vercel

Node.js (CommonJS) + دوال Vercel Serverless + Turso + ffmpeg-static. بلا Next.js ولا خطوة بناء.

## النشر على Vercel
1. Import لنفس المستودع، ثم **Root Directory = `merger`** و Framework Preset = **Other**.
2. المتغيرات: `TURSO_DATABASE_URL` و `TURSO_AUTH_TOKEN` (إلزاميان) + اختياريًا `MAX_SOURCES=10`, `SOURCE_MAX_MB=200`, `OUTPUT_MAX_MB=150`, `MAX_TOTAL_DURATION_SEC=600`, `FFMPEG_PRESET=medium`.
3. Deploy. الجداول تُنشأ تلقائيًا. رابط المشروع هو قيمة `MERGER_API_BASE` في مشروع MCP.

## API (بدون تسجيل دخول، CORS مفتوح)
| Method | Endpoint | الوظيفة |
|---|---|---|
| POST | `/api/jobs` | `{"videos":[...]}` أو `{"sources":[{"kind":"url","url":..},{"kind":"file","name":..,"size":..,"mime":..}]}` → 201 |
| POST | `/api/upload?job=<id>&seq=<n>&chunk=<k>` | جزء ثنائي ≤4MB (`application/octet-stream`) |
| POST | `/api/jobs/<id>/process` | دمج متزامن → `{"status":"done","videoUrl",...}` (202 لو قيد المعالجة) |
| GET | `/api/jobs/<id>` | الحالة والتقدم |
| GET | `/api/jobs/<id>/video` | بث بدعم Range، و`?download=1` |
| DELETE | `/api/jobs/<id>` | حذف فوري |
| GET | `/api/config` | الحدود |
| GET | `/api/cron` | حذف المنتهية (مجدول يوميًا) |

```bash
curl -X POST https://<domain>/api/jobs -H 'Content-Type: application/json' -d '{"videos":["https://.../1.mp4","https://.../2.mp4"]}'
curl -X POST https://<domain>/api/jobs/<jobId>/process
curl -L -o merged.mp4 "https://<domain>/api/jobs/<jobId>/video?download=1"
```

## الحدود
الملفات تُحذف بعد 24 ساعة · 10 مقاطع · 200MB لكل مصدر · 150MB ناتج · 600 ثانية إجمالي. على Vercel: الدالة 300 ثانية كحد أقصى، والطلب ≈4.5MB (لذلك الرفع أجزاء 4MB)، والقاعدة المجانية في Turso مساحتها محدودة.

## اختبار محلي
`npm i && npm run test:unit` ثم `ALLOW_PRIVATE_URLS=1 TURSO_DATABASE_URL=file:/tmp/m.db PORT=3200 npm run dev` وفي نافذة أخرى `npm run test:http`. يلزم وجود ffmpeg (يأتي من ffmpeg-static).
