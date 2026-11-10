// عمليات المهام والتخزين على Turso (blobs مقسّمة إلى صفوف 2MB)
const { db, ensureSchema } = require("./db");
const C = require("./config");

const now = () => Date.now();
const iso = (ms) => new Date(ms).toISOString();
const toBuf = (v) => (Buffer.isBuffer(v) ? v : Buffer.from(v instanceof ArrayBuffer ? new Uint8Array(v) : v));

async function createJob(id, sources) {
  await ensureSchema();
  const hasFile = sources.some((s) => s.kind === "file");
  const t = now();
  const stmts = [{ sql: "INSERT INTO jobs (id,status,progress,created_at,expires_at) VALUES (?,?,0,?,?)", args: [id, hasFile ? "uploading" : "queued", t, t + C.TTL_MS] }];
  sources.forEach((s, i) => stmts.push({ sql: "INSERT INTO sources (job_id,seq,kind,url,name,size,mime) VALUES (?,?,?,?,?,?,?)", args: [id, i, s.kind, s.url || null, s.name || null, s.size || null, s.mime || null] }));
  await db().batch(stmts, "write");
  return { status: hasFile ? "uploading" : "queued", expiresAt: iso(t + C.TTL_MS) };
}
async function getJob(id) {
  await ensureSchema();
  const r = await db().execute({ sql: "SELECT * FROM jobs WHERE id=?", args: [id] });
  return r.rows[0] || null;
}
async function getSources(id) {
  const r = await db().execute({ sql: "SELECT * FROM sources WHERE job_id=? ORDER BY seq", args: [id] });
  return r.rows;
}
async function updateJob(id, p) {
  const keys = Object.keys(p);
  await db().execute({ sql: `UPDATE jobs SET ${keys.map((k) => k + "=?").join(",")} WHERE id=?`, args: [...keys.map((k) => p[k]), id] });
}
// انتقال ذري إلى processing (مرة واحدة فقط)
async function claimProcessing(id) {
  const r = await db().execute({ sql: "UPDATE jobs SET status='processing', progress=0, error=NULL WHERE id=? AND status IN ('queued','uploading')", args: [id] });
  return r.rowsAffected === 1;
}
// يخزّن جزء رفع (≤4MB) كصفوف ≤2MB؛ فهرس الصف = chunk*2 + sub
async function putUploadChunk(id, seq, chunk, buf) {
  const stmts = [];
  for (let off = 0, sub = 0; off < buf.length; off += C.ROW_BYTES, sub++) {
    stmts.push({ sql: "INSERT OR REPLACE INTO source_chunks (job_id,seq,chunk,data) VALUES (?,?,?,?)", args: [id, seq, chunk * 2 + sub, buf.subarray(off, off + C.ROW_BYTES)] });
  }
  await db().batch(stmts, "write");
}
async function sourceUploadedBytes(id, seq) {
  const r = await db().execute({ sql: "SELECT COALESCE(SUM(LENGTH(data)),0) n FROM source_chunks WHERE job_id=? AND seq=?", args: [id, seq] });
  return Number(r.rows[0].n);
}
// يقرأ مصدرًا مرفوعًا تدفقيًا (صفحات 8 صفوف) ويمرّر كل جزء إلى write
async function readSourceChunks(id, seq, write) {
  let from = 0;
  for (;;) {
    const r = await db().execute({ sql: "SELECT chunk,data FROM source_chunks WHERE job_id=? AND seq=? AND chunk>=? ORDER BY chunk LIMIT ?", args: [id, seq, from, C.READ_PAGE_ROWS] });
    if (!r.rows.length) break;
    for (const row of r.rows) await write(toBuf(row.data));
    from = Number(r.rows[r.rows.length - 1].chunk) + 1;
  }
}
async function putOutputRows(id, startChunk, buf) {
  const stmts = [];
  for (let off = 0, i = 0; off < buf.length; off += C.ROW_BYTES, i++) {
    stmts.push({ sql: "INSERT OR REPLACE INTO output_chunks (job_id,chunk,data) VALUES (?,?,?)", args: [id, startChunk + i, buf.subarray(off, off + C.ROW_BYTES)] });
  }
  await db().batch(stmts, "write");
  return stmts.length;
}
// قراءة مدى من الناتج (للـ Range): نقلّم أول/آخر صف
async function streamOutputRange(id, start, end, write) {
  const first = Math.floor(start / C.ROW_BYTES), last = Math.floor(end / C.ROW_BYTES);
  for (let from = first; from <= last; from += C.READ_PAGE_ROWS) {
    const to = Math.min(last, from + C.READ_PAGE_ROWS - 1);
    const r = await db().execute({ sql: "SELECT chunk,data FROM output_chunks WHERE job_id=? AND chunk>=? AND chunk<=? ORDER BY chunk", args: [id, from, to] });
    for (const row of r.rows) {
      const base = Number(row.chunk) * C.ROW_BYTES;
      const b = toBuf(row.data);
      await write(b.subarray(Math.max(0, start - base), Math.min(b.length, end - base + 1)));
    }
  }
}
async function deleteSourceChunks(id) { await db().execute({ sql: "DELETE FROM source_chunks WHERE job_id=?", args: [id] }); }
// حذف شامل في batch واحد
async function deleteJob(id) {
  await ensureSchema();
  const r = await db().batch([
    { sql: "DELETE FROM output_chunks WHERE job_id=?", args: [id] },
    { sql: "DELETE FROM source_chunks WHERE job_id=?", args: [id] },
    { sql: "DELETE FROM sources WHERE job_id=?", args: [id] },
    { sql: "DELETE FROM jobs WHERE id=?", args: [id] },
  ], "write");
  return r[3].rowsAffected;
}
async function deleteExpired() {
  await ensureSchema();
  const r = await db().execute({ sql: "SELECT id FROM jobs WHERE expires_at < ?", args: [now()] });
  for (const row of r.rows) await deleteJob(String(row.id));
  return r.rows.length;
}
module.exports = { iso, createJob, getJob, getSources, updateJob, claimProcessing, putUploadChunk, sourceUploadedBytes, readSourceChunks, putOutputRows, streamOutputRange, deleteSourceChunks, deleteJob, deleteExpired };
