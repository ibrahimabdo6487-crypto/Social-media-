// طبقة Turso: كل شيء يُخزَّن هنا (المهام، أجزاء المصادر، الفيديو الناتج)
const { createClient } = require("@libsql/client");
let _c = null, _schema = null;
function db() {
  if (!_c) _c = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
  return _c;
}
function ensureSchema() {
  if (!_schema) {
    _schema = db().batch([
      `CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL, progress INTEGER DEFAULT 0, error TEXT,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, size INTEGER, duration REAL, resolution TEXT)`,
      `CREATE TABLE IF NOT EXISTS sources (job_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, url TEXT, name TEXT,
        size INTEGER, mime TEXT, PRIMARY KEY (job_id, seq))`,
      `CREATE TABLE IF NOT EXISTS source_chunks (job_id TEXT NOT NULL, seq INTEGER NOT NULL, chunk INTEGER NOT NULL, data BLOB NOT NULL,
        PRIMARY KEY (job_id, seq, chunk))`,
      `CREATE TABLE IF NOT EXISTS output_chunks (job_id TEXT NOT NULL, chunk INTEGER NOT NULL, data BLOB NOT NULL,
        PRIMARY KEY (job_id, chunk))`,
    ], "write").catch((e) => { _schema = null; throw e; });
  }
  return _schema;
}
module.exports = { db, ensureSchema };
