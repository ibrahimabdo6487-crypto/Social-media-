// خادم تطوير محلي يحاكي Vercel: يحمّل .env ويحلّل المسارات الديناميكية إلى req.query
const fs = require("node:fs"), path = require("node:path"), http = require("node:http");
try { for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split("\n")) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(l); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {}
const routes = [];
(function scan(dir, base) {
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    if (fs.statSync(full).isDirectory()) { scan(full, base + "/" + f); continue; }
    if (!f.endsWith(".js")) continue;
    const route = base + (f === "index.js" ? "" : "/" + f.replace(/\.js$/, ""));
    const names = []; const re = new RegExp("^" + route.replace(/\[(\w+)\]/g, (_, n) => (names.push(n), "([^/]+)")) + "/?$");
    routes.push({ re, names, file: full, dyn: names.length });
  }
})(path.join(__dirname, "api"), "/api");
routes.sort((a, b) => a.dyn - b.dyn); // الثابت أولًا
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };
const port = Number(process.env.PORT || 3000);
http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  for (const r of routes) {
    const m = r.re.exec(u.pathname);
    if (!m) continue;
    req.query = Object.fromEntries(u.searchParams); r.names.forEach((n, i) => (req.query[n] = decodeURIComponent(m[i + 1])));
    return require(r.file)(req, res);
  }
  const f = path.join(__dirname, "public", u.pathname === "/" ? "index.html" : u.pathname);
  if (f.startsWith(path.join(__dirname, "public")) && fs.existsSync(f) && fs.statSync(f).isFile()) { res.setHeader("Content-Type", MIME[path.extname(f)] || "application/octet-stream"); return fs.createReadStream(f).pipe(res); }
  res.statusCode = 404; res.setHeader("Content-Type", "application/json"); res.end('{"error":"غير موجود"}');
}).listen(port, () => console.log("merger dev server on http://localhost:" + port));
