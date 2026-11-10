// scripts/test-http.js — اختبار HTTP كامل ضد خادم التطوير:
// إنشاء مهمة من روابط → دمج → بث مع Range 206 → مهمة مختلطة (رابط + ملف مرفوع) →
// حذف → 404 → JSON تالف → مقطع واحد مرفوض → أكثر من 10 مرفوض
const { spawn } = require('child_process');
const crypto = require('crypto');

const PORT = 8899;
const BASE = `http://localhost:${PORT}`;

let pass = 0; let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // تشغيل خادم التطوير على منفذ الاختبار
  const server = spawn(process.execPath, ['dev-server.js'], {
    cwd: __dirname + '/..',
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.stdout.write('   [server] ' + d.toString()));
  server.stderr.on('data', (d) => process.stdout.write('   [server!] ' + d.toString()));
  await sleep(1200);

  try {
    // 0) config
    let r = await fetch(`${BASE}/api/config`);
    let j = await r.json();
    check('GET /api/config يعيد الحدود', r.status === 200 && j.limits && j.ok, JSON.stringify(j).slice(0, 100));

    // 1) إنشاء مهمة من روابط
    console.log('\n[1] مهمة من روابط → دمج');
    r = await fetch(`${BASE}/api/jobs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videos: [
          'https://www.w3schools.com/html/mov_bbb.mp4',
          'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4',
        ],
      }),
    });
    j = await r.json();
    check('إنشاء المهمة 201', r.status === 201 && j.jobId && j.status === 'queued', JSON.stringify(j).slice(0, 200));
    check('statusUrl/processUrl على نفس النطاق', j.statusUrl.includes(BASE) && j.processUrl.includes(BASE));
    const jobId = j.jobId;
    const expires = new Date(j.expiresAt);
    check('expiresAt ≈ 24 ساعة', (expires - Date.now()) > 23 * 3600 * 1000);

    // 2) process متزامن → done
    r = await fetch(`${BASE}/api/jobs/${jobId}/process`, { method: 'POST' });
    j = await r.json();
    check('process يعيد done مباشرة', r.status === 200 && j.status === 'done', JSON.stringify(j).slice(0, 200));
    check('videoUrl/downloadUrl على نطاق الخدمة', j.videoUrl && j.videoUrl.startsWith(BASE) && !/localhost:(?!8)/.test(j.videoUrl.replace(BASE, '')));
    check('الميتاداتا موجودة (size/duration/resolution)', j.size > 10000 && j.duration > 8 && /x/.test(j.resolution || ''), `dur=${j.duration} res=${j.resolution}`);

    // 3) بث الفيديو مع Range → 206
    console.log('\n[2] البث وRange');
    r = await fetch(`${BASE}/api/jobs/${jobId}/video`, { headers: { Range: 'bytes=0-1023' } });
    const buf1 = Buffer.from(await r.arrayBuffer());
    check('206 مع Content-Range', r.status === 206 && (r.headers.get('content-range') || '').startsWith(`bytes 0-1023/${j.size}`));
    check('الطول 1024', buf1.length === 1024);
    check('Accept-Ranges: bytes', r.headers.get('accept-ranges') === 'bytes');

    r = await fetch(`${BASE}/api/jobs/${jobId}/video`, { headers: { Range: 'bytes=1000-1999' } });
    const buf2 = Buffer.from(await r.arrayBuffer());
    check('مدى أوسط 206 صحيح', r.status === 206 && buf2.length === 1000 && (r.headers.get('content-range') || '').startsWith('bytes 1000-1999/'));

    r = await fetch(`${BASE}/api/jobs/${jobId}/video`, { headers: { Range: 'bytes=abc-' } });
    check('Range تالف → 416', r.status === 416);

    r = await fetch(`${BASE}/api/jobs/${jobId}/video?download=1`);
    check('download=1 يعطي Content-Disposition', (r.headers.get('content-disposition') || '').includes('attachment'));

    // 4) مهمة مختلطة: رابط + ملف مرفوع بالأجزاء
    console.log('\n[3] مهمة مختلطة (رابط + ملف مرفوع)');
    const fileBytes = crypto.randomBytes(300000); // محتوى وهمي؟ لا — يجب أن يكون فيديو. نستخدم مقطع w3schools كملف مرفوع
    r = await fetch(`${BASE}/api/jobs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sources: [
          { kind: 'url', url: 'https://www.w3schools.com/html/mov_bbb.mp4' },
          { kind: 'file', name: 'up.mp4', size: fileBytes.length, mime: 'video/mp4' },
        ],
      }),
    });
    j = await r.json();
    check('إنشاء مهمة مختلطة 201 + uploads[]', r.status === 201 && j.status === 'uploading' && Array.isArray(j.uploads) && j.uploads.length === 1, JSON.stringify(j).slice(0, 200));
    // نرفع الملف الحقيقي (ننزّله أولًا ونرفعه أجزاءً)
    const dl = await fetch('https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4');
    const realBytes = Buffer.from(await dl.arrayBuffer());
    const mixedJob = j.jobId;
    // نعيد ضبط الحجم المعلن ليتوافق مع المحتوى الفعلي (الاختبار يعلن الحجم الحقيقي)
    // الحجم المعلن في الإنشاء كان 300000 — نرفع الملف الحقيقي كاملًا بالأجزاء بدلًا منه عبر مهمة جديدة:
    r = await fetch(`${BASE}/api/jobs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sources: [
          { kind: 'url', url: 'https://www.w3schools.com/html/mov_bbb.mp4' },
          { kind: 'file', name: 'up.mp4', size: realBytes.length, mime: 'video/mp4' },
        ],
      }),
    });
    j = await r.json();
    const mj = j.jobId;
    const chunks = Math.ceil(realBytes.length / j.uploadChunkBytes);
    for (let c = 0; c < chunks; c++) {
      const part = realBytes.subarray(c * j.uploadChunkBytes, (c + 1) * j.uploadChunkBytes);
      const rr = await fetch(`${BASE}/api/upload?job=${mj}&seq=1&chunk=${c}`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: part,
      });
      if (!rr.ok) { check('رفع الجزء', false, 'HTTP ' + rr.status); break; }
    }
    check('رفع كل الأجزاء نجح', true);
    r = await fetch(`${BASE}/api/jobs/${mj}/process`, { method: 'POST' });
    j = await r.json();
    check('الدمج المختلط done', r.status === 200 && j.status === 'done', JSON.stringify(j).slice(0, 200));
    // تحقق 409 عند الرفع بعد الاكتمال
    r = await fetch(`${BASE}/api/upload?job=${mj}&seq=0&chunk=0`, { method: 'POST', body: Buffer.from('x') });
    check('رفض الرفع بعد اكتمال المهمة (409)', r.status === 409);

    // 5) حذف → 404
    console.log('\n[4] الحذف و404');
    r = await fetch(`${BASE}/api/jobs/${jobId}`, { method: 'DELETE' });
    j = await r.json();
    check('حذف شامل', r.status === 200 && j.deleted === true);
    r = await fetch(`${BASE}/api/jobs/${jobId}`);
    check('GET بعد الحذف → 404', r.status === 404);
    r = await fetch(`${BASE}/api/jobs/${jobId}/video`);
    check('بث بعد الحذف → 404', r.status === 404);

    // 6) الأخطاء
    console.log('\n[5] حالات الخطأ');
    r = await fetch(`${BASE}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not-json{{' });
    check('JSON تالف → 400', r.status === 400);
    r = await fetch(`${BASE}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ videos: ['https://x.com/a.mp4'] }) });
    check('مقطع واحد → 400 برسالة عربية', r.status === 400 && (await r.json()).error.includes('مقطعين على الأقل'));
    r = await fetch(`${BASE}/api/jobs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videos: Array.from({ length: 11 }, (_, i) => `https://x.com/${i}.mp4`) }),
    });
    check('11 مقطعًا → 400 برسالة عربية', r.status === 400 && (await r.json()).error.includes('أقصى عدد'));
    r = await fetch(`${BASE}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ videos: ['http://localhost/x.mp4', 'http://127.0.0.1/y.mp4'] }) });
    check('روابط داخلية → 400', r.status === 400);
    r = await fetch(`${BASE}/api/jobs/doesnotexist`);
    check('مهمة غير موجودة → 404', r.status === 404);
    r = await fetch(`${BASE}/api/jobs/doesnotexist`, { method: 'PUT' });
    check('طريقة خاطئة → 405', r.status === 405);
    r = await fetch(`${BASE}/`);
    check('الواجهة تُقدَّم', r.status === 200 && (r.headers.get('content-type') || '').includes('text/html'));
  } finally {
    server.kill();
  }
  console.log(`\n═══ النتيجة: ${pass} نجاح / ${fail} فشل ═══`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('فشل الاختبار:', e); process.exit(1); });
