export function mcpAuthRequired(): boolean { return !!process.env.MCP_ACCESS_TOKEN; }
export function checkMcpAuth(req: Request): boolean {
  const tok = process.env.MCP_ACCESS_TOKEN;
  if (!tok) return true;
  return req.headers.get("authorization") === `Bearer ${tok}`;
}
