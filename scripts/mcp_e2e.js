// scripts/mcp_e2e.js — اختبار e2e حقيقي عبر بروتوكول MCP ضد الخادم المحلي
// يغطي معايير القبول: tools/list، صورة e2e، تبديل تسلسلي (مفتاح فاشل أولًا ثم الحقيقي)،
// فيديو عبر get_task كل 10 ثوانٍ، دمج e2e، list_media — بلا أي مفاتيح أو أخطاء داخلية في الردود.
const fs = require("fs");

const BASE = process.env.BASE || "http://localhost:3000";
const REAL_KEY = (process.env.KIE_KEY || fs.readFileSync("/tmp/kiekey", "utf8")).trim();
const FAKE_KEY = "kiefake0000000000000000000000000f4il"; // مفتاح فاشل عمدًا للتحقق من التبديل التسلسلي

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let rpcId = 0;
async function mcp(method, params) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; }
  catch { return { status: res.status, body: null, text }; }
}

function resultText(r) {
  const item = r?.body?.result?.content?.[0];
  return item?.text ?? "";
}

async function main() {
  console.log("═══ 0) تجهيز المفاتيح: مفتاح فاشل أولًا ثم الحقيقي (الترتيب التسلسلي) ═══");
  let r = await fetch(`${BASE}/api/keys`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "kie", api_key: FAKE_KEY, label: "فاشل-للاختبار" }),
  });
  check("إضافة مفتاح فاشل (الأول بالترتيب)", r.status === 201);
  await sleep(1100); // فرق واضح في created_at لضبط الترتيب التسلسلي
  r = await fetch(`${BASE}/api/keys`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "kie", api_key: REAL_KEY, label: "الرئيسي" }),
  });
  check("إضافة المفتاح الحقيقي (الثاني بالترتيب)", r.status === 201);

  console.log("\n═══ 1) initialize + tools/list ═══");
  const init = await mcp("initialize", {
    protocolVersion: "2025-03-26", capabilities: {},
    clientInfo: { name: "e2e-test", version: "1.0.0" },
  });
  check("initialize ينجح ويعيد serverInfo", init.status === 200 && init.body?.result?.serverInfo?.name === "media-generator", JSON.stringify(init.body).slice(0, 150));
  await mcp("notifications/initialized", {});
  const tl = await mcp("tools/list", {});
  const names = (tl.body?.result?.tools ?? []).map((t) => t.name);
  check("tools/list يعرض الأدوات الخمس", ["generate_image", "generate_video", "merge_videos", "get_task", "list_media"].every((x) => names.includes(x)), names.join(","));

  console.log("\n═══ 2) generate_image e2e + التبديل التسلسلي (الفاشل → معطل → الحقيقي ينجح) ═══");
  const t0 = Date.now();
  const img = await mcp("tools/call", { name: "generate_image", arguments: {
    prompt: "a red apple on a wooden table, realistic photo", wait_seconds: 90,
  } });
  const imgText = resultText(img);
  const imgUrl = (imgText.match(/https?:\/\/[^\s)\]]+/g) || [])[0];
  check("الصورة اكتملت برابط عام", img.status === 200 && imgText.includes("✅") && !!imgUrl && !imgText.includes("❌"), imgText.slice(0, 200));
  check("المدة داخل النافذة (<95s)", Date.now() - t0 < 95000, `${Math.round((Date.now() - t0) / 1000)}s`);
  if (imgUrl) {
    const head = await fetch(imgUrl, { method: "HEAD" }).catch(() => null);
    check("رابط الصورة قابل للجلب (HTTP 200)", !!head && head.status === 200);
  }
  // التبديل التسلسلي: المفتاح الفاشل أصبح disabled والمهمة اكتملت على الحقيقي
  const keysRes = await (await fetch(`${BASE}/api/keys`)).json();
  const fakeKey = keysRes.keys.find((k) => k.label === "فاشل-للاختبار");
  const realKey = keysRes.keys.find((k) => k.label === "الرئيسي");
  check("المفتاح الفاشل معلَّم disabled تلقائيًا", fakeKey?.status === "disabled", fakeKey?.status);
  check("المفتاح الفاشل سُجل استخدام فاشل له", fakeKey?.fail_count >= 1);
  check("المفتاح الحقيقي نشط وسجل نجاحًا", realKey?.status === "active" && realKey?.success_count >= 1);
  check("لا مفاتيح أو أرصدة في نص الرد للنموذج", !/api[_\s]?key|balance|رصيد|مفتاح.*(مرفوض|خطأ)/i.test(imgText), "");

  console.log("\n═══ 3) generate_video e2e عبر get_task كل 10 ثوانٍ ═══");
  const vid = await mcp("tools/call", { name: "generate_video", arguments: {
    prompt: "a red apple rotating slowly on a wooden table, cinematic", duration: 6, wait_seconds: 25,
  } });
  const vidText = resultText(vid);
  let taskId = (vidText.match(/task_id:\s*([a-f0-9-]+)/) || [])[1];
  check("الفيديو رد بمهمة قيد المعالجة أو اكتمل", vid.status === 200 && (vidText.includes("⏳") || vidText.includes("✅")), vidText.slice(0, 150));
  if (!taskId && vidText.includes("✅")) {
    // اكتمل فورًا ضمن النافذة — لا حاجة للمتابعة
    check("الفيديو اكتمل ضمن نافذة الرد", true);
  } else {
    let done = false, lastText = "";
    for (let i = 0; i < 60 && !done; i++) {
      await sleep(10000);
      const g = await mcp("tools/call", { name: "get_task", arguments: { task_id: taskId } });
      lastText = resultText(g);
      if (lastText.includes("✅")) done = true;
      if (lastText.includes("❌")) break;
      process.stdout.write(`   استطلاع ${i + 1}: ${lastText.split("\n")[0]}\n`);
    }
    check("الفيديو اكتمل عبر get_task برابط صالح", done && /https?:\/\//.test(lastText), lastText.slice(0, 200));
    if (done) {
      const vUrl = (lastText.match(/https?:\/\/[^\s)\]]+/g) || [])[0];
      const head = await fetch(vUrl, { method: "HEAD" }).catch(() => null);
      check("رابط الفيديو قابل للجلب (HTTP 200)", !!head && head.status === 200);
    }
  }

  console.log("\n═══ 4) merge_videos e2e عبر خدمة الدمج ═══");
  const mg = await mcp("tools/call", { name: "merge_videos", arguments: {
    urls: [
      "https://www.w3schools.com/html/mov_bbb.mp4",
      "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4",
    ],
    wait_seconds: 180,
  } });
  const mgText = resultText(mg);
  const mUrl = (mgText.match(/https?:\/\/[^\s)\]]+/g) || [])[0];
  check("الدمج اكتمل برابط", mg.status === 200 && mgText.includes("✅") && !!mUrl, mgText.slice(0, 220));
  check("تنبيه 24 ساعة موجود", mgText.includes("24 ساعة"));
  if (mUrl && mUrl.includes("/api/jobs/") && mUrl.includes("localhost:8787")) {
    const head = await fetch(mUrl, { method: "GET", headers: { Range: "bytes=0-99" } }).catch(() => null);
    check("رابط الدمج يعمل (206 على نطاق الخدمة)", !!head && head.status === 206, `status=${head?.status}`);
  } else if (mUrl) {
    const head = await fetch(mUrl, { method: "GET", headers: { Range: "bytes=0-99" } }).catch(() => null);
    check("رابط الدمج قابل للجلب", !!head && head.status === 200, `status=${head?.status}`);
  }

  console.log("\n═══ 5) list_media + get_task لمهمة غير موجودة ═══");
  const lm = await mcp("tools/call", { name: "list_media", arguments: { limit: 10 } });
  check("list_media يعرض الوسائط", lm.status === 200 && resultText(lm).includes("أحدث الوسائط"));
  const g404 = await mcp("tools/call", { name: "get_task", arguments: { task_id: "not-exists-000" } });
  check("get_task لمهمة غير موجودة → خطأ واضح", g404.status === 200 && resultText(g404).includes("لا توجد مهمة"));

  console.log(`\n═══ النتيجة: ${pass} نجاح / ${fail} فشل ═══`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("فشل الاختبار:", e); process.exit(1); });
