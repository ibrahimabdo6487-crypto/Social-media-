"use client";

// لوحة الإدارة العربية: مفاتيح API (ترتيب تسلسلي) + متابعة المهام الحية + إعدادات الربط الجاهزة للنسخ
import { useCallback, useEffect, useRef, useState } from "react";

type Health = {
  healthy: boolean;
  turso: { healthy: boolean; schema: boolean };
  merger: { healthy: boolean; configured: boolean; base: string | null };
  keys: { total: number; active: number; exhausted: number; disabled: number; providers: Record<string, number> };
  tasks: { total: number; completed: number; failed: number; processing: number };
  errors?: string[];
};

type KeyRow = {
  id: string; provider: string; label: string; masked: string; status: string;
  usage_count: number; success_count: number; fail_count: number;
  last_used_at: string | null; last_checked_at: string | null; last_error: string | null; created_at: string;
};

type TaskRow = {
  id: string; provider: string | null; model: string; type: string; prompt: string;
  status: string; progress: number; error_message: string | null;
  result_urls_json: string | null; created_at: string; updated_at: string;
};

const STATUS_CHIP: Record<string, string> = {
  active: "bg-emerald-500/10 text-emerald-300 border-emerald-500/40",
  exhausted: "bg-amber-500/10 text-amber-300 border-amber-500/40",
  disabled: "bg-rose-500/10 text-rose-300 border-rose-500/40",
  completed: "bg-emerald-500/10 text-emerald-300 border-emerald-500/40",
  processing: "bg-sky-500/10 text-sky-300 border-sky-500/40",
  failed: "bg-rose-500/10 text-rose-300 border-rose-500/40",
};

export default function Dashboard() {
  const [tab, setTab] = useState<"keys" | "tasks" | "connect">("keys");
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch("/api/health");
        const j = await r.json();
        if (alive) setHealth(j);
      } catch { /* تجاهل */ }
    };
    tick();
    const t = setInterval(tick, 10000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  return (
    <main className="max-w-5xl mx-auto px-4 py-8">
      <header className="flex items-center justify-between gap-3 mb-7">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl grid place-items-center text-2xl bg-gradient-to-br from-cyan-500/20 to-violet-500/20 border border-ink-line">🎛️</div>
          <div>
            <h1 className="text-xl font-extrabold bg-gradient-to-l from-cyan-300 to-violet-300 bg-clip-text text-transparent">
              مولّد الوسائط — خادم MCP
            </h1>
            <p className="text-xs text-slate-400">توليد صور وفيديو ودمج مقاطع عبر تبديل تسلسلي صارم للمفاتيح — بلا تخزين ملفات، روابط فقط</p>
          </div>
        </div>
        <HealthBadge health={health} />
      </header>

      <nav className="flex gap-2 mb-5">
        {([["keys", "🔑 المفاتيح"], ["tasks", "📋 المهام"], ["connect", "🔗 الربط والاتصال"]] as const).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`px-4 py-2 rounded-xl text-sm font-bold border transition ${
              tab === k
                ? "bg-gradient-to-l from-cyan-500/20 to-violet-500/20 border-cyan-400/50 text-white"
                : "border-ink-line text-slate-400 hover:text-white hover:border-cyan-400/40"
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === "keys" && <KeysTab health={health} />}
      {tab === "tasks" && <TasksTab />}
      {tab === "connect" && <ConnectTab />}
    </main>
  );
}

function HealthBadge({ health }: { health: Health | null }) {
  if (!health) return <span className="chip border-ink-line text-slate-400">جارٍ فحص الجهوزية…</span>;
  if (!health.healthy) {
    return <span className="chip bg-rose-500/10 text-rose-300 border-rose-500/40">⚠️ القاعدة غير متصلة — راجع متغيرات البيئة</span>;
  }
  const mergerTxt = health.merger.configured
    ? health.merger.healthy ? "الدمج متصل" : "الدمج غير متصل"
    : "الدمج غير مضبوط (MERGER_API_BASE)";
  return (
    <div className="flex flex-col items-end gap-1">
      <span className="chip bg-emerald-500/10 text-emerald-300 border-emerald-500/40">● الخدمة جاهزة — Turso متصل</span>
      <span className={`chip ${health.merger.healthy ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/40" : "bg-amber-500/10 text-amber-300 border-amber-500/40"}`}>
        {mergerTxt}
      </span>
    </div>
  );
}

/* ---------------- تبويب المفاتيح ---------------- */

function KeysTab({ health }: { health: Health | null }) {
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [provider, setProvider] = useState("kie");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/keys");
      const j = await r.json();
      if (j.keys) setKeys(j.keys);
    } catch { /* تجاهل */ }
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, [load]);

  const add = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/keys", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_key: apiKey, label }),
      });
      const j = await r.json();
      if (r.ok) { setMsg({ text: "✅ " + (j.message ?? "تمت الإضافة"), ok: true }); setApiKey(""); setLabel(""); }
      else setMsg({ text: "❌ " + (j.error ?? "فشل الإضافة"), ok: false });
      await load();
    } finally { setBusy(false); }
  };

  const toggle = async (k: KeyRow) => {
    await fetch(`/api/keys/${k.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: k.status === "disabled" ? "active" : "disabled" }),
    });
    await load();
  };
  const del = async (k: KeyRow) => {
    if (!confirm(`حذف المفتاح ${k.masked} نهائيًا؟`)) return;
    await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
    await load();
  };

  return (
    <section className="space-y-5">
      <div className="rounded-2xl border border-ink-line bg-ink-card/60 p-5">
        <h2 className="font-bold text-sm mb-2">🔑 إضافة مفتاح API لمزود</h2>
        <p className="text-xs text-slate-400 leading-6 mb-4">
          المفاتيح تُجرَّب بترتيب إضافتها الصارم (الأول ضُيف → يُجرَّب أولًا) مع تبديل تلقائي فوري عند أي خطأ أو نفاد رصيد دون توقف المهمة.
          المفتاح المستنزف رصيده يبقى في القائمة والقاعدة، والمفتاح المرفوض توثيقه يُعلَّم disabled تلقائيًا.
        </p>
        <div className="grid md:grid-cols-[130px_1fr_1fr_auto] gap-2">
          <select value={provider} onChange={(e) => setProvider(e.target.value)}
            className="bg-[#0b1120] border border-ink-line rounded-xl px-3 py-2 text-sm outline-none focus:border-cyan-400">
            <option value="kie">kie.ai</option>
            <option value="cometapi">cometapi</option>
          </select>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="وسم (اختياري) — مثل: رئيسي"
            className="bg-[#0b1120] border border-ink-line rounded-xl px-3 py-2 text-sm outline-none focus:border-cyan-400" />
          <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} type="password" placeholder="الصق مفتاح API الكامل هنا"
            className="bg-[#0b1120] border border-ink-line rounded-xl px-3 py-2 text-sm outline-none focus:border-cyan-400" />
          <button onClick={add} disabled={busy || !apiKey}
            className="px-5 py-2 rounded-xl font-bold text-sm bg-gradient-to-l from-cyan-400 to-violet-400 text-[#08101f] disabled:opacity-40">
            {busy ? "…" : "+ إضافة"}
          </button>
        </div>
        {msg && <p className={`mt-3 text-xs ${msg.ok ? "text-emerald-300" : "text-rose-300"}`}>{msg.text}</p>}
      </div>

      <div className="rounded-2xl border border-ink-line bg-ink-card/60 overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-[#0b1120] text-slate-400">
            <tr>
              <th className="p-3 text-right">#</th><th className="p-3 text-right">المزود</th>
              <th className="p-3 text-right">الوسم</th><th className="p-3 text-right">المفتاح</th>
              <th className="p-3 text-right">الحالة</th><th className="p-3 text-right">استخدام/نجاح/فشل</th>
              <th className="p-3 text-right">آخر خطأ</th><th className="p-3 text-right">إجراءات</th>
            </tr>
          </thead>
          <tbody>
            {keys.length === 0 && (
              <tr><td colSpan={8} className="p-6 text-center text-slate-500">لا مفاتيح بعد — أضف مفتاحًا أعلاه ليبدأ التوليد</td></tr>
            )}
            {keys.map((k, i) => (
              <tr key={k.id} className="border-t border-ink-line/60">
                <td className="p-3 font-bold text-cyan-300">{i + 1}</td>
                <td className="p-3">{k.provider}</td>
                <td className="p-3">{k.label || "—"}</td>
                <td className="p-3 font-mono" dir="ltr">{k.masked}</td>
                <td className="p-3"><span className={`chip ${STATUS_CHIP[k.status] ?? ""}`}>{k.status}</span></td>
                <td className="p-3 font-mono">{k.usage_count}/{k.success_count}/{k.fail_count}</td>
                <td className="p-3 text-rose-300/80 max-w-48 truncate" title={k.last_error ?? ""}>{k.last_error || "—"}</td>
                <td className="p-3 space-x-1 whitespace-nowrap">
                  <button onClick={() => toggle(k)} className="px-2 py-1 rounded-lg border border-ink-line text-slate-300 hover:border-cyan-400 hover:text-white">
                    {k.status === "disabled" ? "تفعيل" : "تعطيل"}
                  </button>
                  <button onClick={() => del(k)} className="px-2 py-1 rounded-lg border border-rose-500/40 text-rose-300 hover:bg-rose-500/10">حذف</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {health && (
        <p className="text-xs text-slate-500">
          الحالة الآن: {health.keys.active} نشط · {health.keys.exhausted} مستنزف · {health.keys.disabled} معطَّل —
          مزودون: {Object.entries(health.keys.providers).map(([p, c]) => `${p} (${c})`).join(" · ") || "—"}
        </p>
      )}
    </section>
  );
}

/* ---------------- تبويب المهام ---------------- */

function TasksTab() {
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [stats, setStats] = useState<Health["tasks"] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const r = await fetch("/api/tasks?limit=20");
        const j = await r.json();
        if (j.tasks) setTasks(j.tasks);
        if (j.stats) setStats(j.stats);
      } catch { /* تجاهل */ }
    };
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  return (
    <section className="space-y-4">
      <div className="grid grid-cols-4 gap-2">
        {[["الكل", stats?.total], ["مكتملة", stats?.completed], ["جارية", stats?.processing], ["فاشلة", stats?.failed]].map(([label, v]) => (
          <div key={String(label)} className="rounded-xl border border-ink-line bg-ink-card/60 p-3 text-center">
            <div className="text-lg font-extrabold text-cyan-300">{v ?? 0}</div>
            <div className="text-[11px] text-slate-400">{label}</div>
          </div>
        ))}
      </div>

      <div className="rounded-2xl border border-ink-line bg-ink-card/60 overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-[#0b1120] text-slate-400">
            <tr>
              <th className="p-3 text-right">النوع</th><th className="p-3 text-right">الموديل</th>
              <th className="p-3 text-right">الوصف</th><th className="p-3 text-right">الحالة</th>
              <th className="p-3 text-right">التقدم</th><th className="p-3 text-right">المزود</th>
              <th className="p-3 text-right">آخر تحديث</th>
            </tr>
          </thead>
          <tbody>
            {tasks.length === 0 && (
              <tr><td colSpan={7} className="p-6 text-center text-slate-500">لا مهام بعد — استدعِ الأدوات من عميل MCP أو جرّب من تبويب الربط</td></tr>
            )}
            {tasks.map((t) => (
              <tr key={t.id} className="border-t border-ink-line/60 cursor-pointer hover:bg-[#0b1120]/60"
                onClick={() => setExpanded(expanded === t.id ? null : t.id)}>
                <td className="p-3">{t.type === "image" ? "🖼️ صورة" : t.type === "video" ? "🎬 فيديو" : "🔗 دمج"}</td>
                <td className="p-3 font-mono" dir="ltr">{t.model}</td>
                <td className="p-3 max-w-56 truncate">{t.prompt || "—"}</td>
                <td className="p-3"><span className={`chip ${STATUS_CHIP[t.status] ?? ""}`}>{t.status}</span></td>
                <td className="p-3">
                  <div className="flex items-center gap-2">
                    <div className="w-20 h-1.5 rounded-full bg-[#0b1120] overflow-hidden">
                      <div className="bar-fill h-full" style={{ width: `${t.progress}%` }} />
                    </div>
                    <span className="font-mono text-slate-400">{t.progress}%</span>
                  </div>
                </td>
                <td className="p-3">{t.provider || "—"}</td>
                <td className="p-3 text-slate-400">{t.updated_at}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {expanded && tasks.filter((t) => t.id === expanded).map((t) => (
        <div key={t.id} className="rounded-2xl border border-ink-line bg-[#0b1120] p-4 text-xs space-y-2">
          <div><span className="text-slate-400">task_id: </span><code className="font-mono text-cyan-300" dir="ltr">{t.id}</code></div>
          {t.result_urls_json && JSON.parse(t.result_urls_json).length > 0 && (
            <div className="space-y-1">
              <span className="text-slate-400">الروابط:</span>
              {JSON.parse(t.result_urls_json).map((u: string) => (
                <a key={u} href={u} target="_blank" rel="noreferrer" className="block text-cyan-300 underline break-all" dir="ltr">{u}</a>
              ))}
            </div>
          )}
          {t.error_message && <div className="text-rose-300">خطأ: {t.error_message}</div>}
          <div className="text-slate-500">أُنشئت {t.created_at} — حُدِّثت {t.updated_at}</div>
        </div>
      ))}
      <p className="text-[11px] text-slate-500">اضغط أي صف لعرض المعرف والروابط والتفاصيل — التحديث حي كل 5 ثوانٍ.</p>
    </section>
  );
}

/* ---------------- تبويب الربط ---------------- */

const TOOLS = ["generate_image", "generate_video", "merge_videos", "get_task", "list_media"];

function ConnectTab() {
  const base = typeof window !== "undefined" ? window.location.origin : "";
  const url = `${base}/mcp`;
  const token = "";
  const authLine = token ? `, "Authorization": "Bearer ${token}"` : "";

  const configs: Array<[string, string]> = [
    ["Cursor / Windsurf / Cline (mcp.json)", JSON.stringify({
      mcpServers: { "media-generator": { url, headers: { Authorization: "Bearer <MCP_ACCESS_TOKEN — إن ضبطته>" } } },
    }, null, 2)],
    ["Claude Desktop (claude_desktop_config.json)", JSON.stringify({
      mcpServers: { "media-generator": { type: "http", url } },
    }, null, 2)],
    ["ChatGPT Connectors", JSON.stringify({
      server_name: "media-generator", url, auth: token ? "bearer" : "none",
    }, null, 2)],
  ];

  return (
    <section className="space-y-4">
      <div className="rounded-2xl border border-ink-line bg-ink-card/60 p-5 space-y-3">
        <h2 className="font-bold text-sm">🔗 رابط خادم MCP</h2>
        <div className="flex items-center gap-2">
          <code className="flex-1 bg-[#0b1120] border border-ink-line rounded-xl px-3 py-2.5 text-sm text-cyan-300 break-all" dir="ltr">{url}</code>
          <button onClick={() => navigator.clipboard.writeText(url)} className="px-4 py-2.5 rounded-xl border border-ink-line text-slate-300 hover:border-cyan-400 hover:text-white text-xs font-bold">نسخ</button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {TOOLS.map((t) => (
            <span key={t} className="chip bg-violet-500/10 text-violet-300 border-violet-500/40" dir="ltr">{t}</span>
          ))}
        </div>
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 text-amber-200 text-xs p-3 leading-6">
          ⚠️ ملاحظات مهمة: التوليد غير متزامن — تابع المهام بـ get_task كل ~10 ثوانٍ · أسماء الموديلات مثبتة ولا تُخترع غيرها · روابط الدمج تُحذف بعد ~24 ساعة فقدّمها للمستخدم فورًا · نماذج الذكاء الاصطناعي لا ترى أخطاء المفاتيح أو الرصيد أبدًا (التبديل التسلسلي داخل الخادم).
        </div>
      </div>

      {configs.map(([title, json]) => (
        <div key={title} className="rounded-2xl border border-ink-line bg-ink-card/60 p-5">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-bold text-slate-300">{title}</h3>
            <button onClick={() => navigator.clipboard.writeText(json)} className="text-[11px] px-3 py-1.5 rounded-lg border border-ink-line text-slate-400 hover:text-white hover:border-cyan-400">نسخ</button>
          </div>
          <pre className="bg-[#0b1120] border border-ink-line rounded-xl p-3 text-[11px] overflow-x-auto" dir="ltr"><code>{json}</code></pre>
        </div>
      ))}

      <p className="text-[11px] text-slate-500 leading-6">
        إن ضبطت MCP_ACCESS_TOKEN على الخادم أضف ترويسة Authorization: Bearer في كل عميل. حالة الخدمة الحية تظهر في ترويسة الصفحة، وتفاصيل القاعدة والدمج عبر <code dir="ltr">GET /api/health</code>.
      </p>
    </section>
  );
}
