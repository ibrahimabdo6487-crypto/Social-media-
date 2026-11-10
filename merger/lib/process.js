// تنفيذ الدمج كاملًا: سحب المصادر → ترميز → حفظ في Turso
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const C = require("./config");
const S = require("./storage");
const { mergeFiles } = require("./ffmpeg");
const { assertPublicUrl } = require("./util");

async function downloadTo(url, dest) {
  let cur = url;
  for (let hop = 0; hop < 5; hop++) {
    await assertPublicUrl(cur); // نتحقق من كل تحويلة أيضًا
    const r = await fetch(cur, { redirect: "manual", signal: AbortSignal.timeout(120000) });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) { cur = new URL(r.headers.get("location"), cur).toString(); continue; }
    if (!r.ok) throw new Error(`Download failed (HTTP ${r.status})`);
    const declared = Number(r.headers.get("content-length") || 0);
    if (declared > C.SOURCE_MAX_BYTES) throw new Error(`حجم المصدر يتجاوز الحد ${Math.round(C.SOURCE_MAX_BYTES / 1048576)}MB`);
    let n = 0;
    const guard = new Transform({ transform(chunk, _e, cb) { n += chunk.length; n > C.SOURCE_MAX_BYTES ? cb(new Error(`حجم المصدر يتجاوز الحد ${Math.round(C.SOURCE_MAX_BYTES / 1048576)}MB`)) : cb(null, chunk); } });
    await pipeline(Readable.fromWeb(r.body), guard, fs.createWriteStream(dest));
    return;
  }
  throw new Error("تحويلات كثيرة جدًا للرابط");
}

async function processJob(id) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "merge-"));
  try {
    const sources = await S.getSources(id);
    const files = [];
    // 0–40%: سحب المصادر
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      const dest = path.join(dir, `src${i}`);
      if (s.kind === "url") {
        try { await downloadTo(String(s.url), dest); } catch (e) { throw new Error(`المصدر ${i + 1}: ${e.message}`); }
      } else {
        const ws = fs.createWriteStream(dest);
        await S.readSourceChunks(id, i, (b) => new Promise((res, rej) => ws.write(b, (e) => (e ? rej(e) : res()))));
        await new Promise((r) => ws.end(r));
      }
      files.push(dest);
      await S.updateJob(id, { progress: Math.round(((i + 1) / sources.length) * 40) });
    }
    // 40–90%: الترميز
    const out = path.join(dir, "out.mp4");
    let last = 0;
    const meta = await mergeFiles(files, out, (f) => {
      const p = 40 + Math.round(f * 50);
      if (p > last) { last = p; S.updateJob(id, { progress: p }).catch(() => {}); }
    });
    // حفظ الناتج صفوفًا 2MB
    const fd = await fsp.open(out, "r");
    try {
      let chunk = 0;
      for (let pos = 0; pos < meta.size; ) {
        const len = Math.min(meta.size - pos, C.ROW_BYTES * 4); // 8MB لكل batch
        const b = Buffer.alloc(len);
        await fd.read(b, 0, len, pos);
        chunk += await S.putOutputRows(id, chunk, b);
        pos += len;
      }
    } finally { await fd.close(); }
    await S.deleteSourceChunks(id); // الناتج فقط هو المطلوب
    await S.updateJob(id, { status: "done", progress: 100, size: meta.size, duration: meta.duration, resolution: meta.resolution, error: null });
    return true;
  } catch (e) {
    await S.updateJob(id, { status: "failed", error: String(e.message || e).slice(0, 500) }).catch(() => {});
    return false;
  } finally {
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {}); // تنظيف /tmp
  }
}
module.exports = { processJob };
