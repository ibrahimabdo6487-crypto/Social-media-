// مزود kie.ai وخدمة دمج وهميان للاختبار المحلي فقط
import http from "node:http";
const tasks = new Map(); const jobs = new Map();
const send = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
const body = (req) => new Promise((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(d ? JSON.parse(d) : {})); });
http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x"); const auth = req.headers.authorization || "";
  if (u.pathname === "/api/v1/jobs/createTask") {
    if (auth.includes("BAD")) return send(res, 401, { code: 401, msg: "Invalid API key" });
    if (auth.includes("BROKE")) return send(res, 200, { code: 402, msg: "Insufficient credits" });
    const b = await body(req); const id = "t" + (tasks.size + 1); tasks.set(id, { n: 0, model: b.model, key: auth });
    return send(res, 200, { code: 200, data: { taskId: id } });
  }
  if (u.pathname === "/api/v1/jobs/recordInfo") {
    const t = tasks.get(u.searchParams.get("taskId")); if (!t) return send(res, 200, { code: 404, msg: "no task" });
    t.n++;
    if (t.n < 2) return send(res, 200, { code: 200, data: { state: "generating" } });
    const ext = t.model.includes("video") ? "mp4" : "png";
    return send(res, 200, { code: 200, data: { state: "success", resultJson: JSON.stringify({ resultUrls: [`https://cdn.example/${u.searchParams.get("taskId")}.${ext}`] }) } });
  }
  if (u.pathname === "/api/config") return send(res, 200, { maxSources: 10 });
  if (u.pathname === "/api/jobs" && req.method === "POST") { const b = await body(req); const id = "job" + (jobs.size + 1); jobs.set(id, { n: 0, done: false, v: b.videos }); return send(res, 200, { jobId: id, status: "queued" }); }
  const m = u.pathname.match(/^\/api\/jobs\/(\w+)(\/process)?$/);
  if (m) { const j = jobs.get(m[1]); if (!j) return send(res, 404, { error: "not found" });
    if (m[2]) { await new Promise((r) => setTimeout(r, 1500)); j.done = true; return send(res, 200, { status: "done", videoUrl: `http://localhost:4010/${m[1]}/video` }); }
    return send(res, 200, j.done ? { status: "done", progress: 100, videoUrl: `http://localhost:4010/${m[1]}/video` } : { status: "queued", progress: 0.3 }); }
  send(res, 404, { error: "x" });
}).listen(4010, () => console.log("mock on 4010"));
