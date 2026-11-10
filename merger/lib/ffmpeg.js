// محرك الدمج: ffprobe → توحيد عبر filter_complex → concat → H.264 CRF18 + AAC
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const C = require("./config");

// ثنائيات ffmpeg قد تفقد صلاحية التنفيذ في الاستضافة → ننسخها إلى /tmp بصلاحية 755 عند الحاجة
function ensureExecutable(bin) {
  try { fs.accessSync(bin, fs.constants.X_OK); return bin; } catch { /* انسخ */ }
  const dst = path.join("/tmp", "bin-" + path.basename(bin));
  if (!fs.existsSync(dst)) { fs.copyFileSync(bin, dst); fs.chmodSync(dst, 0o755); }
  return dst;
}
function binPath(name) {
  if (process.env[name.toUpperCase() + "_PATH"]) return process.env[name.toUpperCase() + "_PATH"];
  try {
    const p = name === "ffmpeg" ? require("ffmpeg-static") : require("ffprobe-static").path;
    if (p && fs.existsSync(p)) return ensureExecutable(p);
  } catch { /* لا يوجد */ }
  return name; // من PATH
}
const FFMPEG = () => binPath("ffmpeg");
const FFPROBE = () => binPath("ffprobe");

function run(bin, args, { onStdout } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args);
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; onStdout && onStdout(d.toString()); });
    p.stderr.on("data", (d) => { err = (err + d).slice(-4000); });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error("ffmpeg/ffprobe failed: " + err.split("\n").slice(-4).join(" ").trim()))));
  });
}

async function probe(file) {
  const out = await run(FFPROBE(), ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file]);
  const j = JSON.parse(out);
  const v = (j.streams || []).find((s) => s.codec_type === "video");
  if (!v) throw new Error("الملف لا يحتوي على مسار فيديو صالح");
  const hasAudio = (j.streams || []).some((s) => s.codec_type === "audio");
  const dur = Number(j.format?.duration || v.duration || 0);
  if (!(dur > 0)) throw new Error("تعذّر تحديد مدة الفيديو");
  let rot = Math.abs(Number(v.tags?.rotate || v.side_data_list?.find((x) => x.rotation)?.rotation || 0)) % 180;
  let w = Number(v.width), h = Number(v.height);
  if (rot === 90) [w, h] = [h, w];
  return { width: w, height: h, duration: dur, hasAudio };
}
const even = (n) => Math.max(2, Math.floor(n / 2) * 2);

// أكبر دقة بين المدخلات (حد أقصى 1920×1080، أبعاد زوجية)
function targetSize(infos) {
  let w = Math.max(...infos.map((i) => i.width)), h = Math.max(...infos.map((i) => i.height));
  const s = Math.min(1, 1920 / w, 1080 / h);
  return { w: even(w * s), h: even(h * s) };
}

async function mergeFiles(files, outFile, onProgress = () => {}) {
  const infos = [];
  for (const f of files) infos.push(await probe(f));
  const total = infos.reduce((a, i) => a + i.duration, 0);
  if (total > C.MAX_TOTAL_DURATION_SEC) throw new Error(`مجموع مدد المقاطع (${Math.round(total)} ث) يتجاوز الحد ${C.MAX_TOTAL_DURATION_SEC} ث`);
  const { w, h } = targetSize(infos);

  const args = ["-y", "-hide_banner", "-nostdin"];
  files.forEach((f) => args.push("-i", f));
  // مصدر بلا صوت → مسار صامت anullsrc بنفس مدته
  const silentIdx = {};
  let next = files.length;
  infos.forEach((inf, i) => { if (!inf.hasAudio) { args.push("-f", "lavfi", "-t", inf.duration.toFixed(3), "-i", "anullsrc=r=44100:cl=stereo"); silentIdx[i] = next++; } });

  const parts = [];
  infos.forEach((inf, i) => {
    parts.push(`[${i}:v:0]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1,format=yuv420p[v${i}]`);
    const src = inf.hasAudio ? `[${i}:a:0]` : `[${silentIdx[i]}:a:0]`;
    parts.push(`${src}aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=${inf.duration.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
  });
  parts.push(infos.map((_, i) => `[v${i}][a${i}]`).join("") + `concat=n=${files.length}:v=1:a=1[v][a]`);
  args.push("-filter_complex", parts.join(";"), "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-crf", "18", "-preset", C.FFMPEG_PRESET, "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", outFile);

  let buf = "";
  await run(FFMPEG(), args, {
    onStdout: (s) => {
      buf += s;
      const m = [...buf.matchAll(/out_time_us=(\d+)/g)].pop();
      if (m) onProgress(Math.min(1, Number(m[1]) / 1e6 / total));
      if (buf.length > 5000) buf = buf.slice(-1000);
    },
  });
  const size = fs.statSync(outFile).size;
  if (size > C.OUTPUT_MAX_BYTES) throw new Error(`حجم الناتج (${Math.round(size / 1048576)}MB) يتجاوز الحد ${Math.round(C.OUTPUT_MAX_BYTES / 1048576)}MB`);
  const outInfo = await probe(outFile);
  return { size, duration: outInfo.duration, resolution: `${outInfo.width}x${outInfo.height}`, inputs: infos };
}
module.exports = { probe, mergeFiles, targetSize, FFMPEG, FFPROBE };
