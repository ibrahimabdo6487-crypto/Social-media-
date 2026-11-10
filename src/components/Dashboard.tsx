"use client";
import { useCallback, useEffect, useState } from "react";

type Key = { id: string; provider: string; label: string; masked: string; status: string; usage_count: number; success_count: number; fail_count: number; last_error: string | null };
type Task = { id: string; type: string; status: string; progress: number; model: string; prompt: string; created_at: string; result_urls: string[]; attempts: number; error: string | null };
type Health = { ok: boolean; database: string; authRequired: boolean; merger: { healthy: boolean } };

const statusCls: Record<string, string> = {
  active: "bg-emerald-500/20 text-emerald-300", exhausted: "bg-amber-500/20 text-amber-300", disabled: "bg-gray-500/30 text-gray-300",
  completed: "bg-emerald-500/20 text-emerald-300", failed: "bg-red-500/20 text-red-300", processing: "bg-sky-500/20 text-sky-300", pending: "bg-sky-500/20 text-sky-300",
};
const statusAr: Record<string, string> = { completed: "مكتملة", failed: "فاشلة", processing: "قيد المعالجة", pending: "قيد الانتظار" };
const typeAr: Record<string, string> = { image: "صورة", video: "فيديو", merge: "دمج" };
const TOOLS: [string, string][] = [
  ["generate_image", "توليد صورة من وصف نصي"], ["generate_video", "توليد فيديو بصوت متزامن"], ["merge_videos", "دمج عدة مقاطع في فيديو واحد"],
  ["get_task", "تتبع أي مهمة حتى الاكتمال"], ["list_media", "استرجاع الوسائط المخزنة"],
];

const Card = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="rounded-2xl border border-white/10 bg-white/5 p-5 mb-6"><h2 className="text-lg font-bold mb-4">{title}</h2>{children}</section>
);
const Badge = ({ s, text }: { s: string; text?: string }) => <span className={`px-2 py-0.5 rounded-full text-xs ${statusCls[s] ?? ""}`}>{text ?? s}</span>;

export default function Dashboard() {
  const [health, setHealth] = useState<Health | null>(null);
  const [keys, setKeys] = useState<Key[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [stats, setStats] = useState({ total: 0, completed: 0, failed: 0, running: 0 });
  const [provider, setProvider] = useState("kie");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [msg, setMsg] = useState("");
  const [origin, setOrigin] = useState("");
  const [tab, setTab] = useState(0);
  const [copied, setCopied] = useState("");

  const loadKeys = useCallback(async () => { try { setKeys((await (await fetch("/api/keys")).json()).keys ?? []); } catch {} }, []);
  const loadTasks = useCallback(async () => { try { const j = await (await fetch("/api/tasks")).json(); setTasks(j.tasks ?? []); if (j.stats) setStats(j.stats); } catch {} }, []);
  useEffect(() => {
    setOrigin(window.location.origin);
    fetch("/api/health").then((r) => r.json()).then(setHealth).catch(() => setHealth(null));
    loadKeys(); loadTasks();
    const t = setInterval(loadTasks, 5000);
    return () => clearInterval(t);
  }, [loadKeys, loadTasks]);

  async function add(e: React.FormEvent) {
    e.preventDefault(); setMsg("");
    const r = await fetch("/api/keys", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, label, api_key: apiKey }) });
    const j = await r.json();
    if (!r.ok) setMsg(j.error ?? "خطأ"); else { setApiKey(""); setLabel(""); loadKeys(); }
  }
  async function toggle(k: Key) { await fetch(`/api/keys/${k.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: k.status === "disabled" ? "active" : "disabled" }) }); loadKeys(); }
  async function del(k: Key) { if (confirm("حذف هذا المفتاح؟")) { await fetch(`/api/keys/${k.id}`, { method: "DELETE" }); loadKeys(); } }
  const copy = (id: string, text: string) => { navigator.clipboard?.writeText(text); setCopied(id); setTimeout(() => setCopied(""), 1500); };

  const mcpUrl = `${origin}/mcp`;
  const auth = health?.authRequired ? { headers: { Authorization: "Bearer <MCP_ACCESS_TOKEN>" } } : {};
  const cfgs = [
    { name: "ChatGPT / GPT Agents", json: { mcpServers: { "media-generator": { url: mcpUrl, ...auth } } }, note: "في ChatGPT: Settings → Connectors → Create → Custom MCP server وضع الرابط في «Server URL»." },
    { name: "Claude Desktop", json: { mcpServers: { "media-generator": { type: "http", url: mcpUrl, ...auth } } }, note: "ضعه في ملف claude_desktop_config.json." },
    { name: "Cursor / Windsurf / Cline", json: { mcpServers: { "media-generator": { url: mcpUrl, ...auth } } }, note: "ضعه في ملف mcp.json." },
  ];
  const cur = cfgs[tab], curText = JSON.stringify(cur.json, null, 2);

  return (
    <main className="max-w-5xl mx-auto p-4 md:p-8">
      <header className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <h1 className="text-2xl font-bold">🎬 MCP Media Generator</h1>
        <div className="flex gap-2">
          <span className={`px-3 py-1 rounded-full text-sm ${health?.ok ? "bg-emerald-500/20 text-emerald-300" : "bg-red-500/20 text-red-300"}`}>{health?.ok ? "Turso متصل" : "Turso غير متصل"}</span>
          <span className={`px-3 py-1 rounded-full text-sm ${health?.merger?.healthy ? "bg-emerald-500/20 text-emerald-300" : "bg-amber-500/20 text-amber-300"}`}>{health?.merger?.healthy ? "خدمة الدمج جاهزة" : "خدمة الدمج غير متاحة"}</span>
        </div>
      </header>

      <Card title="🔑 مدير المفاتيح">
        <p className="text-sm text-gray-300 mb-4">أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري تلقائي عند أي خطأ أو نفاد رصيد دون توقف.</p>
        <form onSubmit={add} className="flex flex-wrap gap-2 mb-4">
          <select value={provider} onChange={(e) => setProvider(e.target.value)} className="bg-slate-800 rounded-lg px-3 py-2"><option value="kie">kie.ai</option><option value="cometapi">CometAPI</option></select>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="تسمية (اختياري)" className="bg-slate-800 rounded-lg px-3 py-2 flex-1 min-w-32" />
          <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="المفتاح" type="password" dir="ltr" className="bg-slate-800 rounded-lg px-3 py-2 flex-[2] min-w-48" required />
          <button className="bg-sky-600 hover:bg-sky-500 rounded-lg px-4 py-2">إضافة</button>
        </form>
        {msg && <p className="text-red-300 text-sm mb-2">{msg}</p>}
        <ul className="space-y-2">
          {keys.length === 0 && <li className="text-gray-400 text-sm">لا توجد مفاتيح بعد.</li>}
          {keys.map((k, i) => (
            <li key={k.id} className="rounded-xl bg-slate-900/60 p-3 flex flex-wrap items-center gap-3 justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap"><span className="text-gray-400 text-sm">#{i + 1}</span><b>{k.provider === "kie" ? "kie.ai" : "CometAPI"}</b>{k.label && <span className="text-gray-300">{k.label}</span>}<Badge s={k.status} /></div>
                <div dir="ltr" className="text-left font-mono text-sm text-gray-300">{k.masked}</div>
                <div className="text-xs text-gray-400">استخدام {k.usage_count} · نجاح {k.success_count} · فشل {k.fail_count}{k.last_error ? ` · آخر خطأ: ${k.last_error}` : ""}</div>
              </div>
              <div className="flex gap-2">
                <button onClick={() => toggle(k)} className="px-3 py-1 rounded-lg bg-slate-700 text-sm">{k.status === "disabled" ? "تنشيط" : "تعطيل"}</button>
                <button onClick={() => del(k)} className="px-3 py-1 rounded-lg bg-red-600/70 text-sm">حذف</button>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="📋 لوحة المهام">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
          {([["إجمالي", stats.total], ["مكتملة", stats.completed], ["فاشلة", stats.failed], ["جارية", stats.running]] as const).map(([l, n]) => (
            <div key={l} className="rounded-xl bg-slate-900/60 p-3 text-center"><div className="text-2xl font-bold">{n}</div><div className="text-xs text-gray-400">{l}</div></div>
          ))}
        </div>
        <ul className="space-y-2">
          {tasks.length === 0 && <li className="text-gray-400 text-sm">لا توجد مهام بعد.</li>}
          {tasks.map((t) => (
            <li key={t.id} className="rounded-xl bg-slate-900/60 p-3">
              <div className="flex items-center gap-2 flex-wrap"><b>{typeAr[t.type] ?? t.type}</b><Badge s={t.status} text={statusAr[t.status] ?? t.status} /><span className="text-xs text-gray-400" dir="ltr">{t.model}</span><span className="text-xs text-gray-500 ms-auto">{t.created_at} · محاولات {t.attempts}</span></div>
              <div className="text-sm text-gray-300 mt-1 truncate">{t.prompt}</div>
              {(t.status === "processing" || t.status === "pending") && <div className="h-1.5 bg-slate-700 rounded mt-2"><div className="h-1.5 bg-sky-500 rounded" style={{ width: `${t.progress}%` }} /></div>}
              {t.error && <div className="text-red-300 text-sm mt-1">{t.error}</div>}
              {t.result_urls.length > 0 && <div className="flex gap-2 mt-2 flex-wrap">{t.result_urls.map((u, i) => <a key={i} href={u} target="_blank" rel="noreferrer" className="px-3 py-1 rounded-lg bg-sky-700 text-sm">فتح النتيجة {t.result_urls.length > 1 ? i + 1 : ""}</a>)}</div>}
            </li>
          ))}
        </ul>
      </Card>

      <Card title="🔌 ربط السيرفر">
        <div className="flex gap-2 mb-4"><input readOnly dir="ltr" value={mcpUrl} className="flex-1 bg-slate-800 rounded-lg px-3 py-2 font-mono text-sm" /><button onClick={() => copy("url", mcpUrl)} className="bg-sky-600 rounded-lg px-4">{copied === "url" ? "تم ✓" : "نسخ"}</button></div>
        <div className="flex gap-2 mb-2 flex-wrap">{cfgs.map((c, i) => <button key={c.name} onClick={() => setTab(i)} className={`px-3 py-1 rounded-lg text-sm ${tab === i ? "bg-sky-600" : "bg-slate-700"}`}>{c.name}</button>)}</div>
        <pre dir="ltr" className="bg-slate-950 rounded-xl p-3 text-left text-sm overflow-x-auto">{curText}</pre>
        <div className="flex items-center justify-between mt-2 gap-2"><p className="text-sm text-gray-300">{cur.note}</p><button onClick={() => copy("cfg", curText)} className="bg-slate-700 rounded-lg px-3 py-1 text-sm shrink-0">{copied === "cfg" ? "تم ✓" : "نسخ JSON"}</button></div>
        <div className="flex flex-wrap gap-2 mt-4">{TOOLS.map(([n, d]) => <span key={n} className="rounded-full bg-slate-800 px-3 py-1 text-sm"><code dir="ltr">{n}</code> — {d}</span>)}</div>
        <p className="mt-4 text-sm rounded-xl bg-amber-500/10 text-amber-200 p-3">الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابَع تلقائيًا بـ get_task كل 10 ثوانٍ — وعند اكتمال المهمة يُعرض الرابط في الدردشة ويتوقف. أثناء الانتظار يُبَث تقدم حي (Progress notifications) حتى لا تنقطع العملية.</p>
      </Card>
    </main>
  );
}
