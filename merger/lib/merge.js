// lib/merge.js — محرك الدمج: ffprobe لكل مصدر + توحيد عبر filter_complex + ترميز libx264 CRF 18
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const env = require('./env');

function ffmpegPath() {
  // ffmpeg-static يضع الثنائي بجانب الحزمة؛ نضمن صلاحية التنفيذ عبر النسخ إلى /tmp إن لزم
  const p = require('ffmpeg-static');
  return ensureExecutable(p);
}

function ffprobePath() {
  const m = require('ffprobe-static');
  const p = typeof m === 'string' ? m : (m.path || (m.default && m.default.path));
  return ensureExecutable(p);
}

// قد يفقد الثنائي صلاحية التنفيذ في الاستضافة — ننسخه إلى /tmp بصلاحية 755 عند الحاجة
function ensureExecutable(src) {
  try {
    fs.accessSync(src, fs.constants.X_OK);
    return src;
  } catch (_) {
    const dst = path.join(os.tmpdir(), path.basename(src) || 'ffmpeg-bin');
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, 0o755);
    return dst;
  }
}

function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 64 * 1024 * 1024, timeout: opts.timeoutMs || 280000 }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error((stderr || stdout || err.message || '').slice(-2000));
        e.killed = err.killed;
        reject(e);
      } else resolve({ stdout, stderr });
    });
  });
}

// ffprobe JSON: الدقة، معدل الإطارات، المدة، وجود صوت
async function probeFile(file) {
  const { stdout } = await run(ffprobePath(), [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ]);
  const info = JSON.parse(stdout);
  const v = (info.streams || []).find((s) => s.codec_type === 'video');
  const a = (info.streams || []).find((s) => s.codec_type === 'audio');
  if (!v) throw new Error('أحد المصادر لا يحتوي مسار فيديو صالح');
  const dur = parseFloat(info.format && info.format.duration || v.duration || '0') || 0;
  return {
    width: v.width, height: v.height,
    fps: v.avg_frame_rate && v.avg_frame_rate !== '0/0'
      ? evalFps(v.avg_frame_rate) : 30,
    duration: dur,
    hasAudio: !!a,
  };
}

function evalFps(r) {
  const [a, b] = String(r).split('/').map(Number);
  return b ? Math.round((a / b) * 100) / 100 : a;
}

// رابط تحميل المصدر إلى /tmp مع فرض حد الحجم أثناء التنزيل (معدّل بايتات)
async function downloadUrl(url, filePath, maxBytes, onProgress) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`فشل تنزيل المصدر (HTTP ${res.status}) — تأكد أن الرابط مباشر وعام`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len && len > maxBytes) throw new Error(`حجم المصدر يتجاوز الحد المسموح (${env.SOURCE_MAX_MB}MB لكل مصدر)`);
  const ws = fs.createWriteStream(filePath);
  let got = 0;
  for await (const chunk of res.body) {
    got += chunk.length;
    if (got > maxBytes) { ws.destroy(); throw new Error(`حجم المصدر يتجاوز الحد المسموح (${env.SOURCE_MAX_MB}MB لكل مصدر)`); }
    if (!ws.write(chunk)) await new Promise((r) => ws.once('drain', r));
    if (onProgress && len) onProgress(got / len);
  }
  await new Promise((r) => ws.end(r));
  if (got < 1024) throw new Error('المصدر فارغ أو غير قابل للتنزيل');
  return got;
}

// الدمج الفعلي: يوحّد كل المصادر ثم يرمّز الناتج مع تقرير تقدم (40→90 أثناء الترميز)
async function mergeFiles(files, outputPath, onProgress) {
  const probes = [];
  for (const f of files) probes.push(await probeFile(f.path));
  const totalDuration = probes.reduce((s, p) => s + p.duration, 0);
  if (totalDuration > env.MAX_TOTAL_DURATION_SEC) {
    throw new Error(`مجموع مدد المقاطع (${Math.round(totalDuration)} ثانية) يتجاوز الحد المسموح (${env.MAX_TOTAL_DURATION_SEC} ثانية)`);
  }

  // أكبر دقة بين المدخلات — بحد أقصى 1920×1080 وأبعاد زوجية
  const maxW = Math.min(1920, Math.max(...probes.map((p) => p.width)));
  const maxH = Math.min(1080, Math.max(...probes.map((p) => p.height)));
  const W = maxW - (maxW % 2); const H = maxH - (maxH % 2);

  const inputs = []; const filters = []; const concatLabels = [];
  let inputIdx = 0;
  const SAMPLE_RATE = 44100;

  probes.forEach((p, i) => {
    inputs.push('-i', files[i].path); // ملف المصدر المحلي على /tmp — الفيديو والصوت من نفس المدخل
    const vi = inputIdx;
    inputIdx += 1;
    filters.push(`[${vi}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1,format=yuv420p[v${i}]`);
    if (p.hasAudio) {
      filters.push(`[${vi}:a]aresample=${SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    } else {
      // مصدر بلا صوت → مدخل anullsrc صامت بنفس مدته بدل أن يفشل الدمج
      inputs.push('-f', 'lavfi', '-t', String(Math.max(p.duration, 0.1)), '-i', `anullsrc=channel_layout=stereo:sample_rate=${SAMPLE_RATE}`);
      const ai = inputIdx;
      inputIdx += 1;
      filters.push(`[${ai}:a]aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    }
    concatLabels.push(`[v${i}][a${i}]`);
  });

  const args = [
    '-y', '-nostdin',
    ...inputs,
    '-filter_complex', `${filters.join(';')};${concatLabels.join('')}concat=n=${probes.length}:v=1:a=1[vout][aout]`,
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-crf', '18', '-preset', env.FFMPEG_PRESET,
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', String(SAMPLE_RATE),
    '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats',
    outputPath,
  ];

  const ff = ffmpegPath();
  await new Promise((resolve, reject) => {
    const child = require('child_process').spawn(ff, args);
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const m = buf.match(/out_time_us=(\d+)/g);
      if (m && totalDuration > 0 && onProgress) {
        const us = Number(m[m.length - 1].split('=')[1]);
        const frac = Math.max(0, Math.min(1, us / 1e6 / totalDuration));
        onProgress(40 + Math.round(frac * 50)); // نافذة الترميز 40–90
      }
    });
    child.stderr.on('data', (d) => { if (buf.length < 200000) buf += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0
      ? resolve()
      : reject(new Error('فشل ترميز الفيديو النهائي (ffmpeg): ' + buf.slice(-1200).trim()))));
  });

  const outDur = (await probeFile(outputPath)).duration;
  return { width: W, height: H, resolution: `${W}x${H}`, duration: outDur, totalDuration };
}

module.exports = { ffmpegPath, ffprobePath, probeFile, downloadUrl, mergeFiles };
