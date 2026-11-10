// اختبار وحدات: دمج حقيقي بـ ffmpeg + تخزين Turso (ملف libSQL محلي) + حدود + حذف
process.env.TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL || "file:/tmp/mu.db";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { mergeFiles, probe, FFMPEG } = require("../lib/ffmpeg");
const S = require("../lib/storage"), C = require("../lib/config");
const { db, ensureSchema } = require("../lib/db");
let ok = 0, bad = 0;
const check = (n, c, x = "") => { c ? ok++ : bad++; console.log(c ? "✅" : "❌", n, c ? "" : x); };
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-"));
  const gen = (name, size, dur, audio) => {
    const f = path.join(dir, name);
    const a = audio ? ["-f", "lavfi", "-i", `sine=frequency=440:duration=${dur}`] : [];
    execFileSync(FFMPEG(), ["-y", "-v", "error", "-f", "lavfi", "-i", `testsrc=size=${size}:rate=25:duration=${dur}`, ...a, "-c:v", "libx264", "-pix_fmt", "yuv420p", ...(audio ? ["-c:a", "aac"] : []), f]);
    return f;
  };
  const v1 = gen("a.mp4", "320x240", 3, true), v2 = gen("b.mp4", "640x360", 2, false); // الثاني بلا صوت
  const out = path.join(dir, "out.mp4");
  let maxP = 0;
  const m = await mergeFiles([v1, v2], out, (p) => (maxP = Math.max(maxP, p)));
  const pi = await probe(out);
  check("الدمج اكتمل", fs.existsSync(out) && m.size > 0);
  check("الدقة = أكبر دقة مدخل (640x360)", m.resolution === "640x360", m.resolution);
  check("المدة ≈ مجموع المدد (5ث)", Math.abs(m.duration - 5) < 0.4, m.duration);
  check("الصوت موجود (رغم مصدر صامت)", pi.hasAudio);
  check("تقدم الترميز يُقرأ", maxP > 0.5, maxP);

  await ensureSchema();
  // تخزين الناتج في Turso وتطابق sha256
  const id = "unit" + crypto.randomBytes(3).toString("hex");
  await S.createJob(id, [{ kind: "url", url: "https://x/1.mp4" }]);
  const data = fs.readFileSync(out);
  // نكبّره لتجاوز 2MB ولاختبار التقليم: نكرر المحتوى
  const big = Buffer.concat([data, crypto.randomBytes(5 * 1024 * 1024)]);
  await S.putOutputRows(id, 0, big);
  const chunks = []; await S.streamOutputRange(id, 0, big.length - 1, (b) => chunks.push(b));
  const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
  check("استرجاع Turso بتطابق sha256", sha(Buffer.concat(chunks)) === sha(big));
  const rs = 2 * 1024 * 1024 - 100, re = 4 * 1024 * 1024 + 50; const rc = []; await S.streamOutputRange(id, rs, re, (b) => rc.push(b));
  check("مدى Range عبر الصفوف يطابق", sha(Buffer.concat(rc)) === sha(big.subarray(rs, re + 1)));

  // رفع الأجزاء
  const up = "unit" + crypto.randomBytes(3).toString("hex");
  await S.createJob(up, [{ kind: "file", name: "a.mp4", size: big.length, mime: "video/mp4" }]);
  for (let k = 0, off = 0; off < big.length; k++, off += C.UPLOAD_CHUNK_BYTES) await S.putUploadChunk(up, 0, k, big.subarray(off, off + C.UPLOAD_CHUNK_BYTES));
  check("حجم المرفوع = المعلن", (await S.sourceUploadedBytes(up, 0)) === big.length);
  const got = []; await S.readSourceChunks(up, 0, (b) => got.push(b));
  check("قراءة المصدر المرفوع بتطابق sha256", sha(Buffer.concat(got)) === sha(big));

  // حدود الحجم والمدة
  const saved = C.MAX_TOTAL_DURATION_SEC; C.MAX_TOTAL_DURATION_SEC = 2;
  let err = ""; try { await mergeFiles([v1, v2], out); } catch (e) { err = e.message; } C.MAX_TOTAL_DURATION_SEC = saved;
  check("حد المدة الإجمالية يفشل برسالة", /يتجاوز الحد/.test(err), err);
  const so = C.OUTPUT_MAX_BYTES; C.OUTPUT_MAX_BYTES = 1000; err = "";
  try { await mergeFiles([v1, v2], out); } catch (e) { err = e.message; } C.OUTPUT_MAX_BYTES = so;
  check("حد حجم الناتج يفشل برسالة", /حجم الناتج/.test(err), err);

  // الحذف الشامل
  for (const j of [id, up]) await S.deleteJob(j);
  const cnt = async (t, col) => Number((await db().execute({ sql: `SELECT COUNT(*) n FROM ${t} WHERE ${col} IN (?,?)`, args: [id, up] })).rows[0].n);
  const left = (await cnt("jobs", "id")) + (await cnt("sources", "job_id")) + (await cnt("source_chunks", "job_id")) + (await cnt("output_chunks", "job_id"));
  check("الحذف الشامل يمسح كل الصفوف", left === 0, left);
  // انتهاء الصلاحية
  const ex = "unit" + crypto.randomBytes(3).toString("hex"); await S.createJob(ex, [{ kind: "url", url: "https://x/1.mp4" }]);
  await db().execute({ sql: "UPDATE jobs SET expires_at=1 WHERE id=?", args: [ex] });
  check("deleteExpired يحذف المنتهية", (await S.deleteExpired()) >= 1 && !(await S.getJob(ex)));
  console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
