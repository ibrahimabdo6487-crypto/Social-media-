// الحدود العامة — كلها قابلة للضبط بمتغيرات البيئة
const num = (k, d) => (Number(process.env[k]) > 0 ? Number(process.env[k]) : d);
module.exports = {
  VERSION: "1.0.0",
  MAX_SOURCES: num("MAX_SOURCES", 10),
  SOURCE_MAX_BYTES: num("SOURCE_MAX_MB", 200) * 1024 * 1024,
  OUTPUT_MAX_BYTES: num("OUTPUT_MAX_MB", 150) * 1024 * 1024,
  MAX_TOTAL_DURATION_SEC: num("MAX_TOTAL_DURATION_SEC", 600),
  FFMPEG_PRESET: process.env.FFMPEG_PRESET || "medium",
  TTL_MS: 24 * 3600 * 1000,
  ROW_BYTES: 2 * 1024 * 1024, // حد صف Turso عبر HTTP
  UPLOAD_CHUNK_BYTES: 4 * 1024 * 1024, // حد طلب Vercel ≈ 4.5MB
  READ_PAGE_ROWS: 8,
};
