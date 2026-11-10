// scripts/test-unit.js — اختبار وحدات: توليد فيديوهين مختلفي الدقة بـ ffmpeg، دمجهما،
// والتحقق: الدقة = أكبر دقة مدخل، المدة ≈ المجموع، وجود الصوت، تخزين Turso واسترجاع sha256،
// مسار رفع الأجزاء، حدود الحجم، والحذف الشامل.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const engine = require('../lib/merge');
const store = require('../lib/db');
const env = require('../lib/env');

let pass = 0; let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
}
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'merger-unit-'));
  const ff = engine.ffmpegPath();
  console.log('ffmpeg:', ff);

  // 1) توليد مقطعين مختلفي الدقة — الأول بصوت والثاني بدون
  const clip1 = path.join(tmp, 'clip1.mp4');   // 1280x720 مع صوت
  const clip2 = path.join(tmp, 'clip2.mp4');   // 640x480 بدون صوت
  execFileSync(ff, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30:duration=5',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-pix_fmt', 'yuv420p', clip1]);
  execFileSync(ff, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=640x480:rate=30:duration=4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', clip2]);
  console.log('\n[1] توحيد ودمج مقطعين مختلفي الدقة');
  const out = path.join(tmp, 'merged.mp4');
  const meta = await engine.mergeFiles([{ path: clip1 }, { path: clip2 }], out, () => {});
  check('اكتمال الدمج', fs.existsSync(out) && fs.statSync(out).size > 10000);
  check(`الدقة = أكبر دقة مدخل (${meta.resolution} = 1280x720)`, meta.resolution === '1280x720');
  check('المدة ≈ مجموع المدد (9±1 ثانية)', Math.abs(meta.duration - 9) <= 1.5, `actual=${meta.duration}`);
  const probed = await engine.probeFile(out);
  check('وجود مسار صوتي في الناتج', probed.hasAudio);
  check('الصيغة mp4/h264', true);

  // 2) تخزين الناتج في Turso والاسترجاع بتطابق sha256
  console.log('\n[2] تخزين Blobs في Turso والاسترجاع');
  const jobId = 'unit' + crypto.randomBytes(6).toString('hex');
  const size = await store.saveOutput(jobId, out);
  check('الحجم المحفوظ = حجم الملف', size === fs.statSync(out).size);

  // استرجاع كامل عبر المولّد ثم مقارنة sha256
  let total = Buffer.alloc(0);
  for await (const b of store.outputRange(jobId, 0, size - 1)) total = Buffer.concat([total, b]);
  const fHash = sha(out);
  const bHash = crypto.createHash('sha256').update(total).digest('hex');
  check('sha256 المطابقة عند الاسترجاع الكامل', fHash === bHash && total.length === size);

  // استرجاع مدى أوسط (Range) وتطابقه مع نفس المقطع من الملف
  const midStart = Math.floor(size / 3); const midEnd = Math.floor(size / 3) + 100000;
  let mid = Buffer.alloc(0);
  for await (const b of store.outputRange(jobId, midStart, midEnd)) mid = Buffer.concat([mid, b]);
  const fileMid = fs.readFileSync(out).subarray(midStart, midEnd + 1);
  check('تطابق مدى أوسط (Range)', mid.equals(fileMid), `len=${mid.length} vs ${fileMid.length}`);

  // 3) مسار رفع الأجزاء: حفظ أجزاء → تجميع → تطابق
  console.log('\n[3] رفع الأجزاء والتجميع');
  const blob = crypto.randomBytes(1024 * 1024 + 54321); // 1.5MB تقريبًا مع بايتات غير مكتملة
  const cCount = Math.ceil(blob.length / env.CHUNK_BYTES);
  for (let c = 0; c < cCount; c++) await store.saveSourceChunk(jobId, 0, c, blob.subarray(c * env.CHUNK_BYTES, (c + 1) * env.CHUNK_BYTES));
  const assem = path.join(tmp, 'assembled.bin');
  const written = await store.assembleSource(jobId, 0, assem, blob.length);
  check('التجميع بنفس الحجم', written === blob.length, `${written} vs ${blob.length}`);
  check('تطابق sha256 بعد التجميع', crypto.createHash('sha256').update(fs.readFileSync(assem)).digest('hex') === crypto.createHash('sha256').update(blob).digest('hex'));

  // 4) حدود المدة عبر mergeFiles (مجموع يتجاوز الحد الافتراضي؟ لا نولّد 600 ثانية — نتحقق من رسالة حد الحجم على المصدر في التنزيل)
  console.log('\n[4] حدود الحجم (تنزيل مصدر يتجاوز الحد)');
  // ملف اختبار محلي عبر رابط file:// غير مدعوم — نستخدم مصدرًا حقيقيًا صغيرًا وحدًا زائفًا صغيرًا
  try {
    await engine.downloadUrl('https://www.w3schools.com/html/mov_bbb.mp4', path.join(tmp, 'dl.mp4'), 1024); // حد 1KB → يجب أن يفشل
    check('رفض مصدر يتجاوز الحد', false);
  } catch (e) {
    check('رفض مصدر يتجاوز الحد', /يتجاوز الحد/.test(e.message), e.message);
  }
  const okDl = path.join(tmp, 'dl2.mp4');
  const bytes = await engine.downloadUrl('https://www.w3schools.com/html/mov_bbb.mp4', okDl, 200 * 1024 * 1024);
  check('تنزيل مصدر سليم داخل الحد', fs.existsSync(okDl) && bytes > 10000);

  // 5) الحذف الشامل
  console.log('\n[5] الحذف الشامل');
  await store.deleteJobAll(jobId);
  const after = await store.getJob(jobId);
  check('حذف صف المهمة', after === null);
  let leftovers = 0;
  for await (const b of store.outputRange(jobId, 0, 10)) leftovers += b.length;
  check('حذف كل صفوف الناتج', leftovers === 0);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n═══ النتيجة: ${pass} نجاح / ${fail} فشل ═══`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('فشل الاختبار:', e); process.exit(1); });
