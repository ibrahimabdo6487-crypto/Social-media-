import type { ProviderId } from "../models";
export interface CheckResult { status: "processing" | "completed" | "failed"; urls?: string[]; error?: string; progress?: number }
export interface ProviderAdapter {
  id: ProviderId;
  createTask(key: string, model: string, input: Record<string, unknown>, type: "image" | "video"): Promise<{ providerTaskId: string }>;
  createImageSync?(key: string, model: string, input: Record<string, unknown>): Promise<{ urls: string[] }>;
  checkTask(key: string, providerTaskId: string): Promise<CheckResult>;
}
