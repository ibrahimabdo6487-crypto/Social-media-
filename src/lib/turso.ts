// طبقة Turso: عميل واحد + إنشاء المخطط عند أول وصول (بدون migrations)
import { createClient, type Client, type InValue } from "@libsql/client";

let _client: Client | null = null;
export function db(): Client {
  if (!_client) {
    _client = createClient({
      url: process.env.TURSO_DATABASE_URL!,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
  }
  return _client;
}

let schemaReady: Promise<void> | null = null;
export function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = db()
      .batch(
        [
          `CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY, provider TEXT, provider_task_id TEXT, key_id TEXT,
            model TEXT NOT NULL, type TEXT NOT NULL, prompt TEXT DEFAULT '',
            params_json TEXT DEFAULT '{}', status TEXT NOT NULL, progress INTEGER DEFAULT 0,
            result_urls_json TEXT, error_message TEXT, attempts_json TEXT DEFAULT '[]',
            created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
            completed_at TEXT)`,
          `CREATE TABLE IF NOT EXISTS api_keys (
            id TEXT PRIMARY KEY, provider TEXT NOT NULL, label TEXT DEFAULT '',
            api_key TEXT NOT NULL, status TEXT DEFAULT 'active', usage_count INTEGER DEFAULT 0,
            success_count INTEGER DEFAULT 0, fail_count INTEGER DEFAULT 0, last_used_at TEXT,
            last_checked_at TEXT, last_error TEXT, created_at TEXT DEFAULT (datetime('now')))`,
        ],
        "write"
      )
      .then(() => undefined)
      .catch((e) => {
        schemaReady = null;
        throw e;
      });
  }
  return schemaReady;
}

export async function dbHealthy(): Promise<boolean> {
  try {
    await ensureSchema();
    await db().execute("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

export type TaskStatus = "pending" | "processing" | "completed" | "failed";
export interface Attempt { provider: string; keyId: string; keyLabel: string; ok: boolean; errorClass?: string; error?: string; at: string }
export interface TaskRow {
  id: string; provider: string | null; provider_task_id: string | null; key_id: string | null;
  model: string; type: "image" | "video" | "merge"; prompt: string; params: Record<string, unknown>;
  status: TaskStatus; progress: number; result_urls: string[]; error_message: string | null;
  attempts: Attempt[]; created_at: string; updated_at: string; completed_at: string | null;
}

function rowToTask(r: Record<string, unknown>): TaskRow {
  const j = <T,>(v: unknown, d: T): T => { try { return v ? (JSON.parse(String(v)) as T) : d; } catch { return d; } };
  return {
    id: String(r.id), provider: (r.provider as string) ?? null, provider_task_id: (r.provider_task_id as string) ?? null,
    key_id: (r.key_id as string) ?? null, model: String(r.model), type: r.type as TaskRow["type"],
    prompt: String(r.prompt ?? ""), params: j(r.params_json, {}), status: r.status as TaskStatus,
    progress: Number(r.progress ?? 0), result_urls: j(r.result_urls_json, []),
    error_message: (r.error_message as string) ?? null, attempts: j(r.attempts_json, []),
    created_at: String(r.created_at), updated_at: String(r.updated_at), completed_at: (r.completed_at as string) ?? null,
  };
}

export async function insertTask(t: { id: string; model: string; type: string; prompt: string; params: unknown; provider?: string; status?: TaskStatus }) {
  await ensureSchema();
  await db().execute({
    sql: `INSERT INTO tasks (id, provider, model, type, prompt, params_json, status, progress) VALUES (?,?,?,?,?,?,?,0)`,
    args: [t.id, t.provider ?? null, t.model, t.type, t.prompt, JSON.stringify(t.params ?? {}), t.status ?? "pending"],
  });
}

export async function getTask(id: string): Promise<TaskRow | null> {
  await ensureSchema();
  const r = await db().execute({ sql: "SELECT * FROM tasks WHERE id = ?", args: [id] });
  return r.rows[0] ? rowToTask(r.rows[0] as unknown as Record<string, unknown>) : null;
}

export interface TaskPatch {
  provider?: string | null; provider_task_id?: string | null; key_id?: string | null;
  status?: TaskStatus; progress?: number; result_urls?: string[]; error_message?: string | null;
  addAttempt?: Attempt;
}
// patch جزئي: يضيف المحاولات إلى السجل ويضبط completed_at تلقائيًا عند الاكتمال
export async function updateTask(id: string, p: TaskPatch) {
  await ensureSchema();
  const sets: string[] = ["updated_at = datetime('now')"];
  const args: InValue[] = [];
  const set = (c: string, v: InValue) => { sets.push(`${c} = ?`); args.push(v); };
  if (p.provider !== undefined) set("provider", p.provider);
  if (p.provider_task_id !== undefined) set("provider_task_id", p.provider_task_id);
  if (p.key_id !== undefined) set("key_id", p.key_id);
  if (p.status !== undefined) {
    set("status", p.status);
    if (p.status === "completed" || p.status === "failed") sets.push("completed_at = datetime('now')");
  }
  if (p.progress !== undefined) set("progress", Math.max(0, Math.min(100, Math.round(p.progress))));
  if (p.result_urls !== undefined) set("result_urls_json", JSON.stringify(p.result_urls));
  if (p.error_message !== undefined) set("error_message", p.error_message);
  if (p.addAttempt) {
    const cur = await getTask(id);
    const list = [...(cur?.attempts ?? []), p.addAttempt].slice(-50);
    set("attempts_json", JSON.stringify(list));
  }
  args.push(id);
  await db().execute({ sql: `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, args });
}

export async function listRecentTasks(limit = 10, f: { type?: string; status?: string } = {}): Promise<TaskRow[]> {
  await ensureSchema();
  const where: string[] = []; const args: InValue[] = [];
  if (f.type) { where.push("type = ?"); args.push(f.type); }
  if (f.status) { where.push("status = ?"); args.push(f.status); }
  args.push(limit);
  const r = await db().execute({
    sql: `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`, args,
  });
  return r.rows.map((x) => rowToTask(x as unknown as Record<string, unknown>));
}

export async function taskStats() {
  await ensureSchema();
  const r = await db().execute(
    "SELECT COUNT(*) total, SUM(status='completed') completed, SUM(status='failed') failed, SUM(status IN ('pending','processing')) running FROM tasks"
  );
  const x = r.rows[0] as unknown as Record<string, number | null>;
  return { total: Number(x.total ?? 0), completed: Number(x.completed ?? 0), failed: Number(x.failed ?? 0), running: Number(x.running ?? 0) };
}
