// src/app/mcp/route.ts — خادم MCP على بروتوكول Streamable HTTP
// SDK الرسمي فقط (McpServer + WebStandardStreamableHTTPServerTransport) — لا JSON-RPC يدوي.
// النقل القياسي Web (Request/Response) يطابق App Router مباشرة — بلا جسور Node.
// وضع stateless (بلا جلسات في الذاكرة) مع ردود JSON — الأنسب لبيئة serverless: كل طلب مستقل تمامًا.
import { NextRequest } from "next/server";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { canonicalizeModel } from "@/lib/models";
import { formatTaskMessage, listMediaMessage, refreshTask, runGeneration, runMerge } from "@/lib/generation";
import { getKeyPool, listRecentTasks } from "@/lib/turso";
import type { ProgressNotify } from "@/lib/generation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------- تعليمات الخادم لعميل الذكاء الاصطناعي (المواصفة 9) ----------
const SERVER_INSTRUCTIONS = `خادم توليد وسائط بالذكاء الاصطناعي (صور/فيديو/دمج) — كل الردود بالعربية.
الأدوات الخمس:
- generate_image: توليد صورة من وصف نصي (الموديل المدمج gpt-image-2-6/flare-text-to-image).
- generate_video: توليد فيديو بأسلوب Grok Imagine مع صوت متزامن أصلي (الموديل المدمج grok-imagine-video-1-5-preview).
- merge_videos: دمج 2–10 مقاطع بالترتيب المطلوب في MP4 واحد عالي الجودة — عبر روابط مباشرة و/أو task_ids لمهام صور/فيديو مكتملة.
- get_task: متابعة أي مهمة غير مكتملة كل ~10 ثوانٍ حتى تكتمل.
- list_media: عرض الوسائط المخزنة (روابط فقط — لا ملفات على هذا السيرفر).
نمط العمل: التوليد غير متزامن — إذا لم تكتمل المهمة ضمن نافذة الرد فالرد يذكر task_id؛ تابع بـ get_task كل ~10 ثوانٍ حتى تكتمل ثم قدّم الرابط للمستخدم.
ملاحظات: روابط وسائط التوليد تبقى على بنية المزود؛ ملفات الدمج تُحذف من خدمة الدمج بعد ~24 ساعة فقدم الرابط للمستخدم فورًا. أسماء الموديلات مثبتة — لا تختلق أسماء أخرى.`;

// ---------- بناء الخادم والأدوات الخمس ----------

function toolResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError };
}

// إشعارات تقدم حية إذا زوّد العميل الطلب بـ _meta.progressToken
function notifyFor(extra: unknown, total = 100): ProgressNotify | undefined {
  const meta = (extra as { _meta?: { progressToken?: string | number } })?._meta;
  const token = meta?.progressToken;
  if (token === undefined) return undefined;
  return async (progress, message) => {
    try {
      const sender = (extra as { sendNotification?: (n: unknown) => Promise<void> }).sendNotification;
      await sender?.({
        method: "notifications/progress",
        params: { progressToken: token, progress, total, message },
      });
    } catch { /* وضع JSON لا ينقل الإشعارات — تجاهل بهدوء */ }
  };
}

function buildServer(): McpServer {
  const server = new McpServer(
    { name: "media-generator", version: "1.2.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  // 1) توليد صورة
  server.registerTool(
    "generate_image",
    {
      title: "توليد صورة",
      description:
        "توليد صورة من وصف نصي بالموديل المدمج gpt-image-2-6/flare-text-to-image. التوليد غير متزامن: إن لم تكتمل الصورة ضمن نافذة الرد فسيُذكر task_id — تابع بـ get_task كل ~10 ثوانٍ.",
      inputSchema: {
        prompt: z.string().min(1).max(4000).describe("وصف الصورة المطلوبة بالتفصيل"),
        model: z.string().max(120).optional().describe("اسم الموديل — اتركه فارغًا لاستخدام الموديل المدمج فقط"),
        aspect_ratio: z.enum(["auto", "1:1", "3:2", "2:3", "16:9", "9:16", "4:3", "3:4", "21:9"]).default("auto").describe("نسبة أبعاد الصورة"),
        resolution: z.enum(["1K", "2K", "4K"]).default("1K").describe("دقة الإخراج"),
        background: z.enum(["auto", "transparent", "opaque"]).default("auto").describe("خلفية الصورة"),
        output_format: z.enum(["png", "jpeg", "webp"]).default("png").describe("صيغة الملف"),
        wait_seconds: z.number().int().min(0).max(90).default(60).describe("كم ثانية تنتظر الاكتمال داخل هذا الرد قبل إعادة task_id"),
      },
    },
    async (args, extra) => {
      const modelDef = args.model ? canonicalizeModel(args.model) : canonicalizeModel("gpt-image-2-6/flare-text-to-image");
      if (!modelDef || modelDef.type !== "image") {
        return toolResult(`❌ موديل غير مدعوم لتوليد الصور: «${args.model}». الموديل المدمج هو gpt-image-2-6/flare-text-to-image — أرسل هذا الاسم حرفيًا أو اترك حقل model فارغًا.`, true);
      }
      const task = await runGeneration({
        type: "image", modelDef,
        prompt: args.prompt,
        params: { aspect_ratio: args.aspect_ratio, resolution: args.resolution, background: args.background, output_format: args.output_format },
        waitSeconds: args.wait_seconds,
        notify: notifyFor(extra),
      });
      // المواصفة 6.2: قائمة مفاتيح فارغة → رسالة no_keys صريحة
      if (task.status === "processing" && !task.provider_task_id) {
        const pool = await getKeyPool(modelDef.providers);
        if (!pool.length) {
          return toolResult(`❌ لا توجد مفاتيح نشطة لخدمة ${modelDef.canonical} — أضف مفتاحًا نشطًا في لوحة الإدارة (تبويب «المفاتيح») ثم أعد المحاولة، أو استعلم بـ get_task بعد إضافة المفتاح وسيستأنف نفس المهمة تلقائيًا (task_id: ${task.id}).`, true);
        }
      }
      const m = formatTaskMessage(task);
      return toolResult(m.text, m.isError);
    },
  );

  // 2) توليد فيديو
  server.registerTool(
    "generate_video",
    {
      title: "توليد فيديو",
      description:
        "توليد فيديو بأسلوب Grok Imagine مع صوت متزامن أصلي (حوار/مؤثرات/موسيقى) بالموديل المدمج grok-imagine-video-1-5-preview. يسمح بتمرير image_url كأول إطار. التوليد غير متزامن (دقائق) — إذا لم يكتمل فسيُذكر task_id، تابع بـ get_task كل ~10 ثوانٍ.",
      inputSchema: {
        prompt: z.string().min(1).max(4000).describe("وصف الفيديو المطلوب — المشهد، الحركة، الصوت المتوقع"),
        model: z.string().max(120).optional().describe("اسم الموديل — اتركه فارغًا لاستخدام الموديل المدمج فقط"),
        image_url: z.string().url().optional().describe("رابط صورة تُستخدم كأول إطار (اختياري)"),
        enable_audio: z.boolean().default(true).describe("توليد صوت متزامن أصلي مع الفيديو"),
        duration: z.number().int().min(1).max(15).default(8).describe("مدة الفيديو بالثواني"),
        aspect_ratio: z.enum(["auto", "1:1", "3:2", "2:3", "16:9", "9:16", "4:3", "3:4", "21:9"]).default("auto").describe("نسبة أبعاد الفيديو"),
        resolution: z.enum(["auto", "480p", "720p", "1080p"]).default("auto").describe("دقة الإخراج للفيديو (تختلف عن دقائق الصور 1K/2K/4K)"),
        wait_seconds: z.number().int().min(0).max(90).default(25).describe("كم ثانية تنتظر الاكتمال داخل هذا الرد قبل إعادة task_id"),
      },
    },
    async (args, extra) => {
      const modelDef = args.model ? canonicalizeModel(args.model) : canonicalizeModel("grok-imagine-video-1-5-preview");
      if (!modelDef || modelDef.type !== "video") {
        return toolResult(`❌ موديل غير مدعوم لتوليد الفيديو: «${args.model}». الموديل المدمج هو grok-imagine-video-1-5-preview — أرسل هذا الاسم حرفيًا أو اترك حقل model فارغًا.`, true);
      }
      const task = await runGeneration({
        type: "video", modelDef,
        prompt: args.prompt,
        params: {
          image_url: args.image_url, enable_audio: args.enable_audio,
          duration: args.duration, aspect_ratio: args.aspect_ratio, resolution: args.resolution,
        },
        waitSeconds: args.wait_seconds,
        notify: notifyFor(extra),
      });
      if (task.status === "processing" && !task.provider_task_id) {
        const pool = await getKeyPool(modelDef.providers);
        if (!pool.length) {
          return toolResult(`❌ لا توجد مفاتيح نشطة لخدمة ${modelDef.canonical} — أضف مفتاحًا نشطًا في لوحة الإدارة (تبويب «المفاتيح») ثم أعد المحاولة، أو استعلم بـ get_task بعد إضافة المفتاح وسيستأنف نفس المهمة تلقائيًا (task_id: ${task.id}).`, true);
        }
      }
      const m = formatTaskMessage(task);
      return toolResult(m.text, m.isError);
    },
  );

  // 3) دمج مقاطع
  server.registerTool(
    "merge_videos",
    {
      title: "دمج مقاطع فيديو",
      description:
        "دمج 2–10 مقاطع في MP4 واحد عالي الجودة وبالترتيب الممرَّر — عبر روابط مباشرة عامة و/أو task_ids لمهام توليد مكتملة (ترتيب الوصول هو ترتيب الدمج). الناتج MP4 (H.264 + AAC) بجودة CRF 18 حتى 1080p/30fps، ويُحذف بعد ~24 ساعة فقدّم الرابط للمستخدم فورًا.",
      inputSchema: {
        urls: z.array(z.string().url()).max(10).optional().describe("روابط مقاطع مباشرة عامة بالترتيب المطلوب"),
        task_ids: z.array(z.string()).max(10).optional().describe("معرفات مهام توليد مكتملة (تُستبدل روابط نتائجها بالترتيب)"),
        wait_seconds: z.number().int().min(0).max(300).default(60).describe("كم ثانية تنتظر اكتمال الدمج داخل هذا الرد"),
      },
    },
    async (args, extra) => {
      const r = await runMerge({
        urls: args.urls?.map(String),
        task_ids: args.task_ids?.map(String),
        waitSeconds: args.wait_seconds ?? 60,
        notify: notifyFor(extra),
      });
      if (r.error) return toolResult(r.error, true);
      const m = formatTaskMessage(r.task!);
      return toolResult(m.text, m.isError);
    },
  );

  // 4) متابعة مهمة
  server.registerTool(
    "get_task",
    {
      title: "متابعة مهمة",
      description:
        "متابعة مهمة توليد/دمج بمعرفها. إن لم تكتمل بعد سيحدّث هذا الطلب حالتها (بما فيها استئناف المهمة على مفتاح متاح عند فشل المفتاح السابق) — استعلم كل ~10 ثوانٍ حتى تكتمل.",
      inputSchema: {
        task_id: z.string().min(1).describe("معرف المهمة (task_id) كما ورد في رد الأداة السابقة"),
      },
    },
    async (args, extra) => {
      const task = await refreshTask(args.task_id, notifyFor(extra));
      if (!task) return toolResult("❌ لا توجد مهمة بهذا المعرّف — تحقق من task_id.", true);
      const m = formatTaskMessage(task);
      return toolResult(m.text, m.isError);
    },
  );

  // 5) قائمة الوسائط
  server.registerTool(
    "list_media",
    {
      title: "قائمة الوسائط",
      description: "عرض آخر الوسائط المخزنة (روابط فقط — لا تُنزَّل ملفات على هذا السيرفر) مع إمكانية التصفية بالنوع والحالة.",
      inputSchema: {
        type: z.enum(["image", "video", "merge"]).optional().describe("تصفية بالنوع"),
        status: z.enum(["completed", "failed", "processing"]).optional().describe("تصفية بالحالة"),
        limit: z.number().int().min(1).max(30).default(10).describe("أقصى عدد نتائج"),
      },
    },
    async (args) => {
      const tasks = await listRecentTasks(args.limit ?? 10, { type: args.type, status: args.status });
      return toolResult(listMediaMessage(tasks));
    },
  );

  return server;
}

// ---------- نقاط النقل ----------

function authOk(req: NextRequest): boolean {
  const token = process.env.MCP_ACCESS_TOKEN;
  if (!token) return true;
  return req.headers.get("authorization") === `Bearer ${token}`;
}

// التدفق المشترك لكل الطرق: نقل WebStandard بوضع stateless JSON
async function handleMcp(req: NextRequest): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // وضع stateless — بلا جلسات في الذاكرة (مناسب للـ serverless)
    enableJsonResponse: true,
  });
  // تسجيل مكدس أي خطأ داخلي للنقل (تشخيص) — حقل onerror يُضبط خارج التوقيع الرسمي
  (transport as unknown as { onerror?: (e: unknown) => void }).onerror =
    (e) => console.error("[mcp] transport error:", (e as Error)?.stack || e);
  const server = buildServer();
  try {
    await server.connect(transport);
    return await transport.handleRequest(req);
  } catch (e) {
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32603, message: `خطأ داخلي: ${(e as Error).message.slice(0, 200)}` }, id: null },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  if (!authOk(req)) {
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32001, message: "مصادقة مطلوبة: أرسل ترويسة Authorization: Bearer <MCP_ACCESS_TOKEN>" }, id: null },
      { status: 401 },
    );
  }
  return handleMcp(req);
}

// GET (دفق SSE) وDELETE (إنهاء جلسة) يُمرَّران للنقل القياسي — وضع stateless يرد بحسب المواصفة (405/204)
export async function GET(req: NextRequest) {
  if (!authOk(req)) {
    return Response.json({ jsonrpc: "2.0", error: { code: -32001, message: "مصادقة مطلوبة" }, id: null }, { status: 401 });
  }
  return handleMcp(req);
}

export async function DELETE(req: NextRequest) {
  if (!authOk(req)) {
    return Response.json({ jsonrpc: "2.0", error: { code: -32001, message: "مصادقة مطلوبة" }, id: null }, { status: 401 });
  }
  return handleMcp(req);
}
