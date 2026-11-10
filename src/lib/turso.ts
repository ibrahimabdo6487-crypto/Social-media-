// src/lib/turso.ts — عميل Turso واحد + المخطط + عمليات المهام والمفاتيح
// كل الاتصال عبر HTTP (libsql) — مناسب للـ serverless بلا ملفات SQLite محلية
import { createClient, type Client, InValue } from "@libsql/client";

let _client: Client | null = null;
let _schema: Promise<void> | null = null;

export function getDb(): Client {
  if (!_client) {
    const url = process.env.TURSO_DATABASE_URL;
    const token = process.env.TURSO_AUTH_TOKEN;
    if (!url || !token) {
      throw new Error("متغيرا البيئة TURSO_DATABASE_URL و TURSO_AUTH_TOKEN إلزاميان");
    }
    _client = createClient({ url, authToken: token });
  }
  return _client;
}

export async function ensureSchema(): Promise<void> {
  if (!_schema) {
    _schema = (async () => {
      const c = getDb();
      await c.executeMultiple(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          provider TEXT,
          provider_task_id TEXT,
          key_id TEXT,
          model TEXT NOT NULL,
          type TEXT NOT NULL,
          prompt TEXT DEFAULT '',
          params_json TEXT DEFAULT '{}',
          status TEXT NOT NULL,
          progress INTEGER DEFAULT 0,
          result_urls_json TEXT,
          error_message TEXT,
          attempts_json TEXT DEFAULT '[]',
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          completed_at TEXT
        );
        CREATE TABLE IF NOT EXISTS api_keys (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          label TEXT DEFAULT '',
          api_key TEXT NOT NULL,
          status TEXT DEFAULT 'active',
          usage_count INTEGER DEFAULT 0,
          success_count INTEGER DEFAULT 0,
          fail_count INTEGER DEFAULT 0,
          last_used_at TEXT,
          last_checked_at TEXT,
          last_error TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );
      `);
    })();
    _schema.catch(() => { _schema = null; }); // فشل → المحاولة القادمة تعيد الإنشاء
  }
  await _schema;
}

export async function dbHealthy(): Promise<boolean> {
  try { await getDb().execute("SELECT 1"); return true; } catch { return false; }
}

// ---------- المهام ----------

export interface TaskAttempt {
  provider: string; keyId: string; keyLabel: string;
  ok: boolean; errorClass?: string; error?: string; at: string;
}

export interface TaskRow {
  id: string; provider: string | null; provider_task_id: string | null; key_id: string | null;
  model: string; type: string; prompt: string; params_json: string; status: string;
  progress: number; result_urls_json: string | null; error_message: string | null;
  attempts_json: string; created_at: string; updated_at: string; completed_at: string | null;
}

export async function insertTask(t: {
  id: string; model: string; type: string; prompt: string; params_json?: string; status?: string;
}): Promise<void> {
  await ensureSchema();
  await getDb().execute({
    sql: `INSERT INTO tasks (id, model, type, prompt, params_json, status, progress) VALUES (?, ?, ?, ?, ?, ?, 0)`,
    args: [t.id, t.model, t.type, t.prompt, t.params_json ?? "{}", t.status ?? "processing"],
  });
}

function mapTask(r: Record<string, unknown>): TaskRow {
  return {
    id: String(r.id), provider: (r.provider as string) ?? null,
    provider_task_id: (r.provider_task_id as string) ?? null, key_id: (r.key_id as string) ?? null,
    model: String(r.model), type: String(r.type), prompt: String(r.prompt ?? ""),
    params_json: String(r.params_json ?? "{}"), status: String(r.status),
    progress: Number(r.progress ?? 0),
    result_urls_json: (r.result_urls_json as string) ?? null,
    error_message: (r.error_message as string) ?? null,
    attempts_json: String(r.attempts_json ?? "[]"),
    created_at: String(r.created_at), updated_at: String(r.updated_at),
    completed_at: (r.completed_at as string) ?? null,
  };
}

export async function getTask(id: string): Promise<TaskRow | null> {
  await ensureSchema();
  const r = await getDb().execute({ sql: "SELECT * FROM tasks WHERE id = ?", args: [id] });
  return r.rows[0] ? mapTask(r.rows[0] as unknown as Record<string, unknown>) : null;
}

// تحديث جزئي + إلحاق محاولة جديدة + ضبط completed_at تلقائيًا عند الاكتمال
// (provider_task_id و key_id يقبلان null لمسحهما عند إعادة إنشاء المهمة على مفتاح آخر)
export async function updateTask(id: string, patch: {
  provider?: string; provider_task_id?: string | null; key_id?: string | null; status?: string;
  progress?: number; result_urls_json?: string; error_message?: string; attempt?: TaskAttempt;
}): Promise<void> {
  await ensureSchema();
  const c = getDb();
  const current = await c.execute({ sql: "SELECT attempts_json, status FROM tasks WHERE id = ?", args: [id] });
  if (!current.rows[0]) return;
  const attempts: TaskAttempt[] = JSON.parse(String(current.rows[0].attempts_json ?? "[]"));
  if (patch.attempt) attempts.push(patch.attempt);

  const sets: string[] = ["attempts_json = ?", "updated_at = datetime('now')"];
  const args: InValue[] = [JSON.stringify(attempts)];
  if (patch.provider !== undefined) { sets.push("provider = ?"); args.push(patch.provider); }
  if (patch.provider_task_id !== undefined) { sets.push("provider_task_id = ?"); args.push(patch.provider_task_id); }
  if (patch.key_id !== undefined) { sets.push("key_id = ?"); args.push(patch.key_id); }
  if (patch.status !== undefined) { sets.push("status = ?"); args.push(patch.status); }
  if (patch.progress !== undefined) { sets.push("progress = ?"); args.push(patch.progress); }
  if (patch.result_urls_json !== undefined) { sets.push("result_urls_json = ?"); args.push(patch.result_urls_json); }
  if (patch.error_message !== undefined) { sets.push("error_message = ?"); args.push(patch.error_message); }
  if (patch.status === "completed") { sets.push("completed_at = datetime('now')", "progress = 100"); }
  args.push(id);
  await c.execute({ sql: `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, args });
}

export async function listRecentTasks(
  limit: number,
  filter: { type?: string; status?: string } = {},
): Promise<TaskRow[]> {
  await ensureSchema();
  const where: string[] = []; const args: InValue[] = [];
  if (filter.type) { where.push("type = ?"); args.push(filter.type); }
  if (filter.status) { where.push("status = ?"); args.push(filter.status); }
  args.push(limit);
  const r = await getDb().execute({
    sql: `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, id DESC LIMIT ?`,
    args,
  });
  return r.rows.map((x) => mapTask(x as unknown as Record<string, unknown>));
}

export async function taskStats(): Promise<{ total: number; completed: number; failed: number; processing: number }> {
  await ensureSchema();
  const r = await getDb().execute({
    sql: `SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing
      FROM tasks`,
  });
  const x = r.rows[0] ?? {};
  return {
    total: Number(x.total ?? 0), completed: Number(x.completed ?? 0),
    failed: Number(x.failed ?? 0), processing: Number(x.processing ?? 0),
  };
}

// ---------- المفاتيح ----------

export interface KeyRow {
  id: string; provider: string; label: string; api_key: string; status: string;
  usage_count: number; success_count: number; fail_count: number;
  last_used_at: string | null; last_checked_at: string | null; last_error: string | null; created_at: string;
}

function mapKey(r: Record<string, unknown>): KeyRow {
  return {
    id: String(r.id), provider: String(r.provider), label: String(r.label ?? ""),
    api_key: String(r.api_key), status: String(r.status),
    usage_count: Number(r.usage_count ?? 0), success_count: Number(r.success_count ?? 0),
    fail_count: Number(r.fail_count ?? 0),
    last_used_at: (r.last_used_at as string) ?? null,
    last_checked_at: (r.last_checked_at as string) ?? null,
    last_error: (r.last_error as string) ?? null, created_at: String(r.created_at),
  };
}

// قلب النظام: الترتيب تسلسلي صارم بترتيب الإضافة — ليس round-robin وليس «الأقل استخدامًا»
// المستنزف (exhausted) يبقى في القائمة؛ الاستثناء الوحيد للإستبعاد هو disabled اليدوي
export async function getKeyPool(providers: string[]): Promise<KeyRow[]> {
  await ensureSchema();
  const placeholders = providers.map(() => "?").join(", ");
  const r = await getDb().execute({
    sql: `SELECT * FROM api_keys WHERE status != 'disabled' AND provider IN (${placeholders}) ORDER BY created_at ASC, id ASC`,
    args: providers,
  });
  return r.rows.map((x) => mapKey(x as unknown as Record<string, unknown>));
}

export async function listKeys(): Promise<KeyRow[]> {
  await ensureSchema();
  const r = await getDb().execute({ sql: "SELECT * FROM api_keys ORDER BY created_at ASC, id ASC", args: [] });
  return r.rows.map((x) => mapKey(x as unknown as Record<string, unknown>));
}

export async function insertKey(provider: string, apiKey: string, label: string): Promise<string> {
  await ensureSchema();
  const id = crypto.randomUUID();
  await getDb().execute({
    sql: "INSERT INTO api_keys (id, provider, label, api_key) VALUES (?, ?, ?, ?)",
    args: [id, provider, label, apiKey],
  });
  return id;
}

export async function findDuplicateKey(provider: string, apiKey: string): Promise<boolean> {
  await ensureSchema();
  const r = await getDb().execute({
    sql: "SELECT 1 FROM api_keys WHERE provider = ? AND api_key = ? LIMIT 1",
    args: [provider, apiKey],
  });
  return r.rows.length > 0;
}

export async function setKeyStatus(id: string, status: string): Promise<void> {
  await ensureSchema();
  await getDb().execute({ sql: "UPDATE api_keys SET status = ? WHERE id = ?", args: [status, id] });
}

export async function deleteKey(id: string): Promise<void> {
  await ensureSchema();
  await getDb().execute({ sql: "DELETE FROM api_keys WHERE id = ?", args: [id] });
}

// تحديث عدّادات المفتاح بعد كل محاولة (نجاح أو فشل) — دائمًا
export async function noteKeyUse(
  keyId: string, ok: boolean, opts: { error?: string; status?: string } = {},
): Promise<void> {
  await ensureSchema();
  const c = getDb();
  await c.execute({
    sql: `UPDATE api_keys SET
      usage_count = usage_count + 1,
      success_count = success_count + ?,
      fail_count = fail_count + ?,
      last_used_at = datetime('now'),
      last_checked_at = datetime('now'),
      last_error = ?
      ${opts.status ? ", status = ?" : ""}
      WHERE id = ?`,
    args: [
      ok ? 1 : 0, ok ? 0 : 1, opts.error ?? null,
      ...(opts.status ? [opts.status] : []), keyId,
    ],
  });
}
