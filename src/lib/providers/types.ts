// src/lib/providers/types.ts — عقود المزودين وخطأ موحّد يُصنَّف لاحقًا في classifyProviderError
export class ProviderError extends Error {
  constructor(
    public status: number,      // رمز HTTP أو 0 لأخطاء الشبكة/التحليل
    message: string,
  ) { super(message); this.name = "ProviderError"; }
}

export interface ProviderTaskInput {
  model?: string;             // اسم الموديل كما يُرسل للمزود (أُضيف في تدفق generateImageSync)
  prompt: string;
  aspect_ratio?: string;
  resolution?: string;
  background?: string;
  output_format?: string;
  // فيديو
  image_url?: string;
  enable_audio?: boolean;
  duration?: number;
}

export type ProviderCheckResult = {
  status: "processing" | "completed" | "failed";
  urls?: string[];
  error?: string;
  progress?: number; // 0..100 تقديري
};

export interface ProviderAdapter {
  // مهمة غير متزامنة (فيديو، وصور بعض المزودين): تعيد معرّف المهمة لدى المزود
  createTask(key: string, model: string, input: ProviderTaskInput): Promise<{ providerTaskId: string }>;
  // صور متزامنة إن كان المزود يدعمها (تعيد النتيجة فورًا)
  createImageSync?(key: string, input: ProviderTaskInput): Promise<{ urls: string[] }>;
  // استعلام حالة مهمة جارية
  checkTask(key: string, providerTaskId: string): Promise<ProviderCheckResult>;
}
