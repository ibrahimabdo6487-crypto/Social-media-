// اختبار e2e محلي ضد خادم التطوير + المزودين الوهميين
const B = "http://localhost:3100"; let ok = 0, bad = 0;
const check = (n, c, extra = "") => { (c ? ok++ : bad++); console.log(c ? "✅" : "❌", n, c ? "" : extra); };
const post = (p, b) => fetch(B + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
let id = 0;
async function rpc(method, params) {
  const r = await fetch(B + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  const t = await r.text(); const line = t.split("\n").filter((l) => l.startsWith("data:")).pop(); return JSON.parse(line ? line.slice(5) : t);
}
const call = async (name, args) => (await rpc("tools/call", { name, arguments: args })).result;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function poll(tid) { for (let i = 0; i < 20; i++) { const r = await call("get_task", { task_id: tid }); if (!r.content[0].text.startsWith("⏳")) return r; await sleep(2000); } }

await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } });
const tools = (await rpc("tools/list")).result.tools;
check("5 tools", tools.length === 5, tools.map((t) => t.name));
const mv = tools.find((t) => t.name === "merge_videos").inputSchema.properties;
check("merge schema max 10, no fps", mv.urls.maxItems === 10 && !mv.fps && !mv.resolution);

let r = await call("generate_image", { prompt: "x", wait_seconds: 0 });
check("no_keys message", r.isError && r.content[0].text.includes("لا توجد مفاتيح نشطة"));

// ترتيب الإضافة: خاطئ ← مستنزف ← صحيح
for (const [k, l] of [["BAD-KEY-0000000000", "bad"], ["BROKE-KEY-000000000", "broke"], ["GOOD-KEY-1234567890", "good"]]) { await post("/api/keys", { provider: "kie", api_key: k, label: l }); await sleep(20); }
const dup = await fetch(B + "/api/keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "kie", api_key: "GOOD-KEY-1234567890" }) });
check("duplicate rejected", dup.status === 409);

r = await call("generate_image", { prompt: "قطة", wait_seconds: 30 });
const txt = r.content[0].text; console.log(txt);
check("image completed after failover", txt.includes("✅") && txt.includes("https://cdn.example/"));
check("no key/balance leak", !/key|مفتاح|رصيد|credit|Insufficient|Invalid/i.test(txt));

const keys = (await (await fetch(B + "/api/keys")).json()).keys;
const st = Object.fromEntries(keys.map((k) => [k.label, k.status]));
check("bad→disabled, broke→exhausted, good→active", st.bad === "disabled" && st.broke === "exhausted" && st.good === "active", JSON.stringify(st));
check("keys masked", keys.every((k) => k.masked.includes("••••") && !k.api_key));

r = await call("generate_video", { prompt: "v", wait_seconds: 0 });
const m = r.content[0].text.match(/task_id: (\S+)/); check("video returns task_id", !!m, r.content[0].text);
const done = await poll(m[1]); check("video via get_task", done.content[0].text.includes(".mp4"), done.content[0].text);
const vid1 = m[1];
r = await call("generate_video", { prompt: "v2", wait_seconds: 0 }); const vid2 = r.content[0].text.match(/task_id: (\S+)/)[1]; await poll(vid2);

r = await call("merge_videos", { urls: ["https://a/1.mp4"] });
check("merge rejects 1 clip", r.isError && r.content[0].text.includes("مقطعَين على الأقل") || r.isError);
r = await rpc("tools/call", { name: "merge_videos", arguments: { urls: Array(11).fill("https://a/1.mp4") } });
check("merge rejects 11 (schema)", !!r.error || r.result?.isError);
r = await call("merge_videos", { task_ids: [vid1, vid2], wait_seconds: 40 });
console.log(r.content[0].text);
check("merge by task_ids", r.content[0].text.includes("✅ تم دمج") && r.content[0].text.includes("24 ساعة"));

r = await call("list_media", { limit: 10 }); check("list_media", r.content[0].text.includes("[merge]"));
r = await call("get_task", { task_id: "nope" }); check("unknown task error", r.isError);

// كل المفاتيح فاشلة → تبقى processing ثم تكتمل عند توفر مفتاح
await post("/api/keys", { provider: "kie", api_key: "x" }); // لا شيء
console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
