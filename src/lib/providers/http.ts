import { ProviderError } from "../keys";
// طلب JSON موحد: أي فشل يُرمى كـ ProviderError ليُصنَّف. أخطاء الشبكة/المهلة = 599 (مؤقتة)
export async function jfetch(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), init.timeoutMs ?? 30000);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: ctl.signal });
  } catch (e) {
    throw new ProviderError(599, `network: ${(e as Error).message}`);
  } finally { clearTimeout(t); }
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* ليس JSON */ }
  const bodyCode = body && typeof body.code === "number" ? body.code : undefined;
  if (!res.ok) throw new ProviderError(res.status, (body?.msg || body?.message || body?.error?.message || text || res.statusText).toString().slice(0, 300));
  // kie.ai يرد 200 HTTP مع code داخلي مختلف عند الخطأ
  if (bodyCode !== undefined && bodyCode !== 200) throw new ProviderError(bodyCode, String(body.msg || body.message || "provider error").slice(0, 300));
  return body;
}
