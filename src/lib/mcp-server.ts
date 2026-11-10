// تعريف خادم MCP: الأدوات الخمس
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runGeneration, refreshTask, type ProgressFn } from "./generation";
import { runMerge } from "./merger";
import { getTask, listRecentTasks } from "./turso";
import { formatTask } from "./format";

export const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" };

export const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

type Extra = { _meta?: { progressToken?: string | number }; sendNotification: (n: any) => Promise<void> };
const txt = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) });

// بث progress notifications كل ~3 ثوانٍ إن زوّد العميل progressToken
function progressFn(extra: Extra): ProgressFn {
  const token = extra._meta?.progressToken;
  return async (percent, message) => {
    if (token === undefined) return;
    try { await extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: percent, total: 100, message } }); } catch { /* */ }
  };
}

const ASPECT_IMG = ["auto","1:1","3:2","2:3","4:3","3:4","5:4","4:5","16:9","9:16","2:1","1:2","21:9","9:21","3:1","1:3"] as const;

export function createServer(): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });

  server.registerTool("generate_image", {
    description: "Generate an image with gpt-image-2-6/flare-text-to-image (automatic sequential failover across all active API keys). Returns the finished image URL if it completes within the wait window, otherwise a task_id — call get_task every ~10 seconds until completed, then show the URL and stop.",
    inputSchema: {
      prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
      model: z.enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"]).default("gpt-image-2-6/flare-text-to-image"),
      aspect_ratio: z.enum(ASPECT_IMG).default("auto"),
      resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
      background: z.enum(["auto", "transparent", "opaque"]).default("auto").describe("Only applied at 1K."),
      output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
      wait_seconds: z.number().int().min(0).max(240).default(90),
    },
  }, async (args, extra) => {
    const r = await runGeneration("image", args, progressFn(extra as unknown as Extra));
    if ("error" in r && r.error) return txt(r.error, true);
    const f = formatTask(r.task!); return txt(f.text, f.isError);
  });

  server.registerTool("generate_video", {
    description: "Generate a video with grok-imagine-video-1-5-preview (native synchronized audio, optional image-to-video). Video takes minutes: a short wait with live progress, then a task_id — follow with get_task every ~10 seconds.",
    inputSchema: {
      prompt: z.string().min(1).max(4096).describe("Scene description. Dialogue in the prompt is spoken in the video."),
      image_url: z.string().optional().describe("Optional public image URL as the first frame (image-to-video)."),
      model: z.enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"]).default("grok-imagine-video-1-5-preview"),
      aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto"),
      resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
      enable_audio: z.boolean().default(true),
      duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
      wait_seconds: z.number().int().min(0).max(240).default(25),
    },
  }, async (args, extra) => {
    const r = await runGeneration("video", args, progressFn(extra as unknown as Extra));
    if ("error" in r && r.error) return txt(r.error, true);
    const f = formatTask(r.task!); return txt(f.text, f.isError);
  });

  server.registerTool("merge_videos", {
    description: "Merge several clips into ONE final video in the given order. Pass 'urls' (public direct video URLs — e.g. from generate_video) or 'task_ids' (COMPLETED video tasks, resolved from the database in order — ideal after generating several clips). Merging is usually fast: a short wait with live progress, then a merge task_id — follow it with get_task. NOTE: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.",
    inputSchema: {
      urls: z.array(z.string()).min(2).max(10).optional().describe("Public direct video URLs (http/https) in merge order — the first clip starts the final video."),
      task_ids: z.array(z.string()).min(2).max(10).optional().describe("Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order."),
      wait_seconds: z.number().int().min(0).max(240).default(60),
    },
  }, async (args, extra) => {
    const all: string[] = [];
    const problems: string[] = [];
    for (const tid of args.task_ids ?? []) {
      const t = await getTask(tid);
      if (!t) problems.push(`- ${tid}: غير موجودة`);
      else if (t.type !== "video") problems.push(`- ${tid}: ليست مهمة فيديو`);
      else if (t.status !== "completed" || !t.result_urls.length) problems.push(`- ${tid}: لم تكتمل بعد`);
      else all.push(t.result_urls[0]);
    }
    all.push(...(args.urls ?? []));
    if (all.length < 2) return txt(["❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.", ...problems].join("\n"), true);
    if (problems.length) return txt(["❌ تعذّر حل بعض المعرّفات:", ...problems].join("\n"), true);
    const r = await runMerge(all, args.wait_seconds, progressFn(extra as unknown as Extra));
    if (r.error) return txt(r.error, true);
    const f = formatTask(r.task!); return txt(f.text, f.isError);
  });

  server.registerTool("get_task", {
    description: "Track any task by id — image/video generation AND merge (reads the Turso database and refreshes from the provider/service if still running). Poll every ~10 seconds; when completed you will find the result URLs — show them to the user and stop polling.",
    inputSchema: { task_id: z.string() },
  }, async ({ task_id }) => {
    const t = await getTask(task_id);
    if (!t) return txt(`❌ لا توجد مهمة بالمعرّف: ${task_id}`, true);
    const cur = await refreshTask(task_id);
    const f = formatTask(cur); return txt(f.text, f.isError);
  });

  server.registerTool("list_media", {
    description: "Latest images/videos/merges stored with their URLs from the database (no regeneration) — to recall previous results.",
    inputSchema: {
      type: z.enum(["image", "video", "merge"]).optional(),
      status: z.enum(["completed", "failed", "processing"]).optional(),
      limit: z.number().int().min(1).max(50).default(10),
    },
  }, async ({ type, status, limit }) => {
    const rows = await listRecentTasks(limit ?? 10, { type, status });
    if (!rows.length) return txt("لا توجد وسائط مخزنة بعد.");
    const lines = rows.map((t, i) => {
      const u = t.result_urls.length ? t.result_urls.join(" , ") : "—";
      return `${i + 1}. [${t.type}] ${t.status} — ${t.id}\n   ${t.prompt.slice(0, 80)}\n   ${u}`;
    });
    return txt(lines.join("\n"));
  });

  return server;
}
