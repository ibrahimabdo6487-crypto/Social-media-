// إعادة إنتاج مستقلة: WebStandardStreamableHTTPServerTransport مع Web Request خالص
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

const transport = new WebStandardStreamableHTTPServerTransport({
  sessionIdGenerator: undefined,
  enableJsonResponse: true,
  onerror: (e) => console.error("TRANSPORT ERROR STACK:", e?.stack || e),
});
const server = new McpServer({ name: "t", version: "1.0.0" });
await server.connect(transport);

const req = new Request("http://localhost/mcp", {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
  body: JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "probe", version: "1.0" } },
  }),
});
const res = await transport.handleRequest(req);
console.log("STATUS:", res.status);
console.log("BODY:", (await res.text()).slice(0, 400));
process.exit(0);
