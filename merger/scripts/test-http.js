// اختبار HTTP كامل ضد خادم التطوير (شغّله مع ALLOW_PRIVATE_URLS=1 على المنفذ 3200)
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), http = require("node:http");
const { execFileSync } = require("node:child_process");
const { FFMPEG } = require("../lib/ffmpeg");
const B = process.env.BASE || "http://localhost:3200"; let ok = 0, bad = 0;
const check = (n, c, x = "") => { c ? ok++ : bad++; console.log(c ? "✅" : "❌", n, c ? "" : x); };
const jpost = (p, body, raw) => fetch(B + p, { method: "POST", headers: raw ? {} : { "content-type": "application/json" }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mh-"));
  const gen = (n, size, dur, audio) => { const f = path.join(dir, n); const a = audio ? ["-f", "lavfi", "-i", `sine=frequency=330:duration=${dur}`] : []; execFileSync(FFMPEG(), ["-y", "-v", "error", "-f", "lavfi", "-i", `testsrc=size=${size}:rate=25:duration=${dur}`, ...a, "-c:v", "libx264", "-pix_fmt", "yuv420p", ...(audio ? ["-c:a", "aac"] : []), f]); return f; };
  gen("a.mp4", "320x240", 2, true); gen("b.mp4", "480x270", 2, true);
  const st = http.createServer((q, r) => { if (q.url === "/forbidden.mp4") { r.statusCode = 403; return r.end(); } const f = path.join(dir, q.url.slice(1)); fs.existsSync(f) ? fs.createReadStream(f).pipe(r) : (r.statusCode = 404, r.end()); }).listen(4020);
  const U = (n) => `http://localhost:4020/${n}`;

  let r = await jpost("/api/jobs", { videos: [U("a.mp4"), U("b.mp4")] }); let j = await r.json();
  check("إنشاء مهمة من روابط → 201 queued", r.status === 201 && j.status === "queued" && j.jobId && j.processUrl, JSON.stringify(j));
  r = await jpost(`/api/jobs/${j.jobId}/process`); let d = await r.json();
  check("process → done + videoUrl", r.status === 200 && d.status === "done" && d.videoUrl && d.size > 0 && d.resolution === "480x270", JSON.stringify(d));
  r = await fetch(`${B}/api/jobs/${j.jobId}`); d = await r.json(); check("GET الحالة done", d.status === "done" && d.progress === 100);
  r = await fetch(`${B}/api/jobs/${j.jobId}/video`); const full = Buffer.from(await r.arrayBuffer());
  check("بث كامل 200 MP4", r.status === 200 && r.headers.get("accept-ranges") === "bytes" && full.length === d.size && full.subarray(4, 8).toString() === "ftyp");
  r = await fetch(`${B}/api/jobs/${j.jobId}/video`, { headers: { Range: "bytes=100-199" } }); const part = Buffer.from(await r.arrayBuffer());
  check("Range → 206 + Content-Range", r.status === 206 && r.headers.get("content-range") === `bytes 100-199/${d.size}` && part.equals(full.subarray(100, 200)));
  r = await fetch(`${B}/api/jobs/${j.jobId}/video?download=1`); check("download=1 → attachment", /attachment/.test(r.headers.get("content-disposition") || "")); await r.arrayBuffer();
  r = await fetch(`${B}/api/jobs/${j.jobId}/process`, { method: "POST" }); check("process مكرر على done → 200", r.status === 200); await r.arrayBuffer();

  // مهمة مختلطة: رابط + ملف مرفوع بأجزاء
  const file = fs.readFileSync(path.join(dir, "b.mp4"));
  r = await jpost("/api/jobs", { sources: [{ kind: "url", url: U("a.mp4") }, { kind: "file", name: "b.mp4", size: file.length, mime: "video/mp4" }] }); j = await r.json();
  check("مهمة مختلطة → uploading + uploads[]", r.status === 201 && j.status === "uploading" && j.uploads?.length === 1 && j.uploadChunkBytes === 4194304, JSON.stringify(j));
  r = await jpost(`/api/jobs/${j.jobId}/process`); check("process قبل اكتمال الرفع → 409", r.status === 409); await r.arrayBuffer();
  const half = Math.floor(file.length / 2);
  for (const [k, b] of [[0, file.subarray(0, half)], [1, file.subarray(half)]]) { r = await fetch(`${j.uploads[0].uploadUrl}&chunk=${k}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: b }); check(`رفع الجزء ${k}`, r.status === 200); await r.arrayBuffer(); }
  r = await jpost(`/api/jobs/${j.jobId}/process`); d = await r.json(); check("دمج مختلط done", r.status === 200 && d.status === "done", JSON.stringify(d));
  const mixedId = j.jobId;

  // فشل مصدر 403 → HTTP 500 + error
  r = await jpost("/api/jobs", { videos: [U("a.mp4"), U("forbidden.mp4")] }); j = await r.json();
  r = await jpost(`/api/jobs/${j.jobId}/process`); d = await r.json();
  check("مصدر يرفض التحميل → 500 + error", r.status === 500 && /403/.test(d.error), JSON.stringify(d));
  r = await fetch(`${B}/api/jobs/${j.jobId}`); d = await r.json(); check("GET يعرض failed", d.status === "failed" && d.error);

  // حماية SSRF (الخادم الحقيقي بدون ALLOW_PRIVATE) تُختبر في وحدة منفصلة؛ هنا تحقق المدخلات
  r = await fetch(`${B}/api/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: "{bad" }); check("JSON تالف → 400", r.status === 400); await r.arrayBuffer();
  r = await jpost("/api/jobs", { videos: [] }); check("قائمة فارغة → 400", r.status === 400); await r.arrayBuffer();
  r = await jpost("/api/jobs", { videos: Array(11).fill(U("a.mp4")) }); check("أكثر من 10 → 400", r.status === 400); await r.arrayBuffer();
  r = await jpost("/api/jobs", { videos: ["ftp://x/a.mp4"] }); check("بروتوكول غير http → 400", r.status === 400); await r.arrayBuffer();
  r = await jpost("/api/jobs", { sources: [{ kind: "file", name: "x.mp4", size: 999 * 1024 * 1024 }] }); check("ملف أكبر من الحد → 413", r.status === 413); await r.arrayBuffer();
  r = await fetch(`${B}/api/jobs`); check("GET على /api/jobs → 405", r.status === 405); await r.arrayBuffer();
  r = await fetch(`${B}/api/jobs/nope`); check("مهمة غير موجودة → 404", r.status === 404); await r.arrayBuffer();
  r = await fetch(`${B}/api/jobs`, { method: "OPTIONS" }); check("CORS مفتوح", r.headers.get("access-control-allow-origin") === "*");
  r = await fetch(`${B}/api/config`); d = await r.json(); check("/api/config", d.maxSources === 10 && d.version);

  // حذف شامل ثم 404
  r = await fetch(`${B}/api/jobs/${mixedId}`, { method: "DELETE" }); check("DELETE → 200", r.status === 200); await r.arrayBuffer();
  r = await fetch(`${B}/api/jobs/${mixedId}`); check("بعد الحذف → 404", r.status === 404); await r.arrayBuffer();
  r = await fetch(`${B}/api/cron`); d = await r.json(); check("/api/cron", r.status === 200 && "deleted" in d);
  st.close(); console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
