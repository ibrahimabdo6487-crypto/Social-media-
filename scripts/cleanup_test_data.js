// scripts/cleanup_test_data.js — تنظيف آثار الاختبار من قاعدة Turso
// يحذف: مهام الاختبار (tasks) + المفتاح الفاشل المؤقت — يُبقي المفتاح الحقيقي للاستخدام الإنتاجي
const { readFileSync } = require("fs");
const path = require("path");

// تحميل .env.local يدويًا (بدون تبعيات خارجية)
function loadEnv() {
  for (const p of [path.join(__dirname, "..", ".env.local"), path.join(__dirname, "..", "merger", ".env")]) {
    try {
      for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
      }
    } catch { /* تجاهل */ }
  }
}
loadEnv();

const { createClient } = require("@libsql/client");
const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function main() {
  // 1) حذف المفتاح الفاشل المؤقت (وسم الاختبار) إن وُجد
  const fake = await db.execute("SELECT id, label FROM api_keys WHERE label = 'فاشل-للاختبار'");
  for (const r of fake.rows) {
    await db.execute({ sql: "DELETE FROM api_keys WHERE id = ?", args: [r.id] });
    console.log("deleted fake key:", r.label);
  }

  // 2) مهام الاختبار: الصور المعلقة بطابور المزود + مهام الفيديو والدمج التجريبية
  // نحذف المهام التي أُنشئت خلال جولة الاختبار اليوم (تاريخ اليوم فقط) — ما عدا ما يقرر المستخدم إبقاءه
  const del = await db.execute(
    "DELETE FROM tasks WHERE created_at >= datetime('now', '-1 day')",
  );
  console.log("deleted test tasks rows:", del.rowsAffected);

  // 3) مهام الدمج التجريبية من الاختبارات المحلية لخدمة الدمج
  const jobs = await db.execute("SELECT id FROM jobs");
  console.log("remaining merger jobs (تجريبية محلية إن وجدت):", jobs.rows.length);
  if (jobs.rows.length) {
    const jdel = await db.execute("DELETE FROM jobs");
    console.log("deleted merger jobs:", jdel.rowsAffected);
  }
  await db.execute("DELETE FROM source_chunks");
  await db.execute("DELETE FROM output_chunks");
  await db.execute("DELETE FROM sources WHERE job_id NOT IN (SELECT id FROM jobs)");

  // 4) إعادة تفعيل المفتاح الحقيقي إن كان disabled من الاختبارات
  const react = await db.execute("UPDATE api_keys SET status = 'active' WHERE status != 'active' AND label = 'الرئيسي'");
  console.log("reactivated main key rows:", react.rowsAffected);

  const keys = await db.execute("SELECT label, provider, status, usage_count, success_count, fail_count FROM api_keys ORDER BY created_at");
  console.table(keys.rows.map((r) => ({ label: r.label, provider: r.provider, status: r.status })));
  const tasks = await db.execute("SELECT COUNT(*) AS c FROM tasks");
  console.log("tasks remaining:", tasks.rows[0].c);
}

main().then(() => { console.log("✅ cleanup done"); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); });
