// dev-server.js — خادم تطوير محلي يحاكي بيئة Vercel:
// يحلّل المسارات الديناميكية ويضعها في req.query، ويقدّم public/ كملفات ثابتة، ويدعم .env يدويًا
const http = require('http');
const fs = require('fs');
const path = require('path');

const env = require('./lib/env');
const PORT = Number(process.env.PORT) || 8787;
const PUBLIC = path.join(__dirname, 'public');

// نفس دوال Vercel الحقيقية
const routes = {
  jobs: require('./api/jobs'),
  upload: require('./api/upload'),
  jobId: require('./api/jobs/[id]'),
  process: require('./api/jobs/[id]/process'),
  video: require('./api/jobs/[id]/video'),
  config: require('./api/config'),
  cron: require('./api/cron'),
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  req.query = Object.fromEntries(u.searchParams);
  req.headers = req.headers; // يحافظ على التوقيع نفسه لدوال Vercel

  try {
    // 1) نقاط API — بما فيها المسارات الديناميكية (المعرف يوضع في req.query.id كما في Vercel)
    if (u.pathname === '/api/jobs' || u.pathname === '/api/jobs/') return await routes.jobs(req, res);
    if (u.pathname === '/api/upload') return await routes.upload(req, res);
    let m;
    if ((m = u.pathname.match(/^\/api\/jobs\/([^/]+)\/process$/))) { req.query.id = m[1]; return await routes.process(req, res); }
    if ((m = u.pathname.match(/^\/api\/jobs\/([^/]+)\/video$/))) { req.query.id = m[1]; return await routes.video(req, res); }
    if ((m = u.pathname.match(/^\/api\/jobs\/([^/]+)$/))) { req.query.id = m[1]; return await routes.jobId(req, res); }
    if (u.pathname === '/api/config') return await routes.config(req, res);
    if (u.pathname === '/api/cron') return await routes.cron(req, res);
    if (u.pathname.startsWith('/api/')) {
      res.statusCode = 404; res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ error: 'النقطة غير موجودة' }));
    }

    // 2) الملفات الثابتة من public/ (index.html في الجذر)
    let file = u.pathname === '/' ? '/index.html' : u.pathname;
    file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
    const full = path.join(PUBLIC, file);
    if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      res.statusCode = 404; res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end('404 Not Found');
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME[path.extname(full)] || 'application/octet-stream');
    fs.createReadStream(full).pipe(res);
  } catch (e) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: e.message || 'خطأ داخلي' }));
  }
});

server.listen(PORT, () => {
  console.log(`✅ خادم تطوير خدمة الدمج يعمل على http://localhost:${PORT}`);
  console.log(`   القاعدة: ${env.TURSO_DATABASE_URL ? 'مضبوطة' : '⚠️ TURSO_DATABASE_URL مفقود'}`);
});
