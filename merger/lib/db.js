// lib/db.js — طبقة Turso: العميل، المخطط، تخزين Blobs المجزأة (2MB لكل صف)، عمليات المهام
const { createClient } = require('@libsql/client');
const fs = require('fs');
const env = require('./env');

let _client = null;
let _schema = null; // وعد يمنع تكرار إنشاء المخطط

function db() {
  if (!_client) {
    if (!env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN) {
      throw new Error('متغيرا البيئة TURSO_DATABASE_URL و TURSO_AUTH_TOKEN إلزاميان');
    }
    _client = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
  }
  return _client;
}

async function ensureSchema() {
  if (!_schema) {
    _schema = (async () => {
      const c = db();
      await c.executeMultiple(`
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'queued',
          progress INTEGER DEFAULT 0,
          sources_json TEXT NOT NULL DEFAULT '[]',
          error TEXT,
          size INTEGER,
          duration REAL,
          resolution TEXT,
          expires_at TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS sources (
          job_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          kind TEXT NOT NULL,
          url TEXT,
          name TEXT,
          size INTEGER,
          mime TEXT,
          PRIMARY KEY (job_id, seq)
        );
        CREATE TABLE IF NOT EXISTS source_chunks (
          job_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          chunk INTEGER NOT NULL,
          data BLOB NOT NULL,
          PRIMARY KEY (job_id, seq, chunk)
        );
        CREATE TABLE IF NOT EXISTS output_chunks (
          job_id TEXT NOT NULL,
          chunk INTEGER NOT NULL,
          data BLOB NOT NULL,
          PRIMARY KEY (job_id, chunk)
        );
      `);
    })();
    _schema.catch(() => { _schema = null; }); // فشل → المحاولة التالية تعيد الإنشاء
  }
  await _schema;
}

async function dbHealthy() {
  try { await db().execute('SELECT 1'); return true; } catch (_) { return false; }
}

// ---------- عمليات المهام ----------

function jobPublic(row, origin) {
  // صياغة الاستجابة العامة للمهمة — videoUrl دائمًا على نطاقنا (لا نطاقات داخلية)
  const base = origin || '';
  const o = {
    jobId: row.id,
    status: row.status,
    progress: typeof row.progress === 'number' ? row.progress : Number(row.progress) || 0,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
  if (row.status === 'done') {
    o.videoUrl = `${base}/api/jobs/${row.id}/video`;
    o.downloadUrl = `${base}/api/jobs/${row.id}/video?download=1`;
    o.size = row.size; o.duration = row.duration; o.resolution = row.resolution;
  }
  if (row.error) o.error = row.error;
  return o;
}

async function getJob(id) {
  await ensureSchema();
  const r = await db().execute({ sql: 'SELECT * FROM jobs WHERE id = ?', args: [id] });
  return r.rows[0] || null;
}

async function insertJob(job, sources) {
  await ensureSchema();
  const c = db();
  const statements = [{ sql: 'INSERT INTO jobs (id, status, progress, sources_json, expires_at) VALUES (?, ?, 0, ?, ?)', args: [job.id, job.status, JSON.stringify(sources), job.expiresAt] }];
  sources.forEach((s, i) => statements.push({
    sql: 'INSERT INTO sources (job_id, seq, kind, url, name, size, mime) VALUES (?, ?, ?, ?, ?, ?, ?)',
    args: [job.id, i, s.kind, s.url || null, s.name || null, s.size || null, s.mime || null],
  }));
  await c.batch(statements, 'write');
}

async function updateJob(id, patch) {
  await ensureSchema();
  const sets = []; const args = [];
  for (const k of ['status', 'progress', 'error', 'size', 'duration', 'resolution']) {
    if (patch[k] !== undefined) { sets.push(`${k} = ?`); args.push(patch[k]); }
  }
  if (!sets.length) return;
  sets.push("updated_at = datetime('now')");
  args.push(id);
  await db().execute({ sql: `UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`, args });
}

async function deleteJobAll(id) {
  await ensureSchema();
  await db().batch([
    { sql: 'DELETE FROM output_chunks WHERE job_id = ?', args: [id] },
    { sql: 'DELETE FROM source_chunks WHERE job_id = ?', args: [id] },
    { sql: 'DELETE FROM sources WHERE job_id = ?', args: [id] },
    { sql: 'DELETE FROM jobs WHERE id = ?', args: [id] },
  ], 'write');
}

// حذف أجزاء المصادر بعد نجاح الدمج — الناتج فقط هو ما نحتفظ به
async function deleteSourceChunks(id) {
  await ensureSchema();
  await db().execute({ sql: 'DELETE FROM source_chunks WHERE job_id = ?', args: [id] });
}

async function listExpiredJobs() {
  await ensureSchema();
  const r = await db().execute({ sql: "SELECT id FROM jobs WHERE expires_at <= datetime('now')", args: [] });
  return r.rows.map((x) => x.id);
}

// حذف كسول للمهام المنتهية — يُستدعى عند كل إنشاء/دمج وعبر /api/cron
async function cleanupExpired() {
  const ids = await listExpiredJobs();
  for (const id of ids) { try { await deleteJobAll(id); } catch (_) { /* التالي */ } }
  return ids.length;
}

// ---------- تخزين Blobs (2MB لكل صف) ----------

async function saveSourceChunk(jobId, seq, chunk, buf) {
  await ensureSchema();
  await db().execute({
    sql: 'INSERT INTO source_chunks (job_id, seq, chunk, data) VALUES (?, ?, ?, ?) ON CONFLICT(job_id, seq, chunk) DO UPDATE SET data = excluded.data',
    args: [jobId, seq, chunk, buf],
  });
}

// تجميع مصدر مرفوع من أجزائه إلى ملف على /tmp (قراءة صفحية 8 صفوف = 16MB بالاستعلام)
async function assembleSource(jobId, seq, filePath, expectedSize) {
  await ensureSchema();
  const ws = fs.createWriteStream(filePath);
  let written = 0; let chunkIdx = 0;
  const PAGE = 8;
  for (;;) {
    const r = await db().execute({
      sql: 'SELECT chunk, data FROM source_chunks WHERE job_id = ? AND seq = ? AND chunk >= ? ORDER BY chunk LIMIT ?',
      args: [jobId, seq, chunkIdx, PAGE],
    });
    if (!r.rows.length) break;
    for (const row of r.rows) {
      const buf = Buffer.from(row.data);
      await new Promise((res, rej) => { ws.write(buf, (e) => (e ? rej(e) : res())); });
      written += buf.length;
      chunkIdx = Number(row.chunk) + 1;
    }
    if (r.rows.length < PAGE) break;
    if (expectedSize && written > expectedSize + 1024) throw new Error('حجم الملف المرفوع يختلف عن المعلن');
  }
  await new Promise((res, rej) => ws.end((e) => (e ? rej(e) : res())));
  return written;
}

// حفظ ملف الناتج كأجزاء 2MB في output_chunks ثم إرجاع الحجم
async function saveOutput(jobId, filePath) {
  await ensureSchema();
  const size = fs.statSync(filePath).size;
  const c = db();
  const statements = [];
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(env.CHUNK_BYTES);
  let chunk = 0;
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, env.CHUNK_BYTES, chunk * env.CHUNK_BYTES);
      if (n <= 0) break;
      const slice = n === env.CHUNK_BYTES ? buf : buf.subarray(0, n);
      statements.push({ sql: 'INSERT INTO output_chunks (job_id, chunk, data) VALUES (?, ?, ?)', args: [jobId, chunk, Buffer.from(slice)] });
      if (statements.length >= 8) { await c.batch(statements, 'write'); statements.length = 0; }
      chunk += 1;
    }
  } finally { fs.closeSync(fd); }
  if (statements.length) await c.batch(statements, 'write');
  return size;
}

// مولّد يقرأ مدى بايتات [start..end] من output_chunks صفحةً صفحة (لبث Range دون تحميل كامل)
async function* outputRange(jobId, start, end) {
  await ensureSchema();
  const PAGE = 8;
  let chunkIdx = Math.floor(start / env.CHUNK_BYTES);
  let pos = chunkIdx * env.CHUNK_BYTES;
  for (;;) {
    const r = await db().execute({
      sql: 'SELECT chunk, data FROM output_chunks WHERE job_id = ? AND chunk >= ? ORDER BY chunk LIMIT ?',
      args: [jobId, chunkIdx, PAGE],
    });
    if (!r.rows.length) return;
    for (const row of r.rows) {
      const buf = Buffer.from(row.data);
      const rowStart = pos; const rowEnd = pos + buf.length - 1;
      const s = Math.max(start, rowStart); const e = Math.min(end, rowEnd);
      if (s <= e) yield buf.subarray(s - rowStart, e - rowStart + 1);
      pos = rowEnd + 1;
      chunkIdx = Number(row.chunk) + 1;
    }
    if (r.rows.length < PAGE || pos > end) return;
  }
}

module.exports = {
  db, ensureSchema, dbHealthy,
  getJob, insertJob, updateJob, deleteJobAll, deleteSourceChunks, cleanupExpired, jobPublic,
  saveSourceChunk, assembleSource, saveOutput, outputRange,
};
