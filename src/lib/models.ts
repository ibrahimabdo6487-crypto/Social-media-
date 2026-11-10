// src/lib/models.ts — سجل الموديلات: الأسماء القانونية، الصيغ البديلة، والمزودون القادرون على خدمتها
export type ProviderId = "kie" | "cometapi";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";

export interface ModelDef {
  canonical: string;              // الاسم كما يراه عميل MCP
  aliases: string[];              // صيغ بديلة نقبلها ونوحدّها (شرطات/نقاط)
  type: MediaType;
  providers: ProviderId[];        // تُجرَّب مفاتيح جميع المزودين بالترتيب
  providerModel: Record<ProviderId, string>; // اسم الموديل كما يُرسل لكل مزود
}

const envOverride = (name: string, fallback: string) => process.env[name] || fallback;

// الأسماء مثبتة كما في المواصفة، وقابلة للتجاوز بمتغيرات البيئة
export const MODELS: ModelDef[] = [
  {
    canonical: "gpt-image-2-6/flare-text-to-image",
    aliases: ["gpt-image-2.6/flare-text-to-image"],
    type: "image",
    providers: ["kie", "cometapi"],
    providerModel: {
      kie: envOverride("KIE_IMAGE_MODEL", "gpt-image-2-6/flare-text-to-image"),
      cometapi: envOverride("COMETAPI_IMAGE_MODEL", "gpt-image-2.6-flare-text-to-image"),
    },
  },
  {
    canonical: "grok-imagine-video-1-5-preview",
    aliases: ["grok-imagine-video-1.5-preview"],
    type: "video",
    providers: ["kie", "cometapi"],
    providerModel: {
      kie: envOverride("KIE_VIDEO_MODEL", "grok-imagine-video-1-5-preview"),
      cometapi: envOverride("COMETAPI_VIDEO_MODEL", "grok-imagine-video-1-5-preview"),
    },
  },
];

// توحيد الصيغ: شرطة/نقطة في رقم الإصدار — ثم مطابقة بالاسم القانوني
export function canonicalizeModel(name?: string): ModelDef | null {
  if (!name) return null;
  const norm = (s: string) => s.toLowerCase().replace(/(\d)[._](\d)/g, "$1-$2");
  const wanted = norm(name.trim());
  for (const m of MODELS) {
    if (m.canonical === name || norm(m.canonical) === wanted) return m;
    if (m.aliases.some((a) => a === name || norm(a) === wanted)) return m;
  }
  return null;
}

export function modelInfo(name: string): ModelDef | null {
  return MODELS.find((m) => m.canonical === name) ?? null;
}

// موديل الدمج ليس موديل توليد — نوع مهمته merge ومزوده خدمة الدمج
export const MERGE_MODEL = "video-merger";
