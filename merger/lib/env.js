// lib/env.js — تحميل .env يدويًا وقراءة الحدود العامة
// لا نستخدم dotenv: خادم التطوير ودوال Vercel يقرأان نفس الملف بهذه الطريقة البسيطة
const fs = require('fs');
const path = require('path');

function loadEnv() {
  const candidates = [
    path.join(__dirname, '..', '.env'),
    path.join(process.cwd(), '.env'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
          const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
          if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
        }
        break;
      }
    } catch (_) { /* تجاهل */ }
  }
}
loadEnv();

const num = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : d; };

module.exports = {
  TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL || '',
  TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN || '',
  // الحدود القابلة للضبط عبر متغيرات البيئة (الافتراضيات من المواصفة)
  MAX_SOURCES: num(process.env.MAX_SOURCES, 10),
  SOURCE_MAX_MB: num(process.env.SOURCE_MAX_MB, 200),
  OUTPUT_MAX_MB: num(process.env.OUTPUT_MAX_MB, 150),
  MAX_TOTAL_DURATION_SEC: num(process.env.MAX_TOTAL_DURATION_SEC, 600),
  FFMPEG_PRESET: process.env.FFMPEG_PRESET || 'medium',
  // كل صف Blob في Turso = 2MB (أقل من حد حجم الصف/الطلب في Turso)
  CHUNK_BYTES: 2 * 1024 * 1024,
  // كل الملفات تُحذف تلقائيًا بعد 24 ساعة
  RETENTION_HOURS: 24,
  VERSION: '1.0.0',
};
