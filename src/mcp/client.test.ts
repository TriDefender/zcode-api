import { describe, it, expect } from "bun:test";
import { McpClient, McpAuthError, glmMcpEndpoint } from "./client.js";

function sse(data: unknown, extraHeaders: Record<string, string> = {}): Response {
  const body = `id:1\nevent:message\ndata:${JSON.stringify(data)}\n\n`;
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=UTF-8", ...extraHeaders },
  });
}

function mockFetch(responses: Response[]): typeof fetch {
  let i = 0;
  const fn = async (_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    return responses[Math.min(i++, responses.length - 1)];
  };
  return fn as unknown as typeof fetch;
}

describe("McpClient", () => {
  it("captures Mcp-Session-Id from initialize and reuses it", async () => {
    const seenHeaders: Record<string, string>[] = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      seenHeaders.push(Object.fromEntries(headers.entries()));
      return sse({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "x", version: "0" } } }, { "mcp-session-id": "sess-123" });
    }) as unknown as typeof fetch;
    const c = new McpClient({ url: "https://x/mcp", apiKey: "k", fetchImpl });
    await c.initialize();
    await c.listTools();
    expect(seenHeaders.length).toBeGreaterThanOrEqual(2);
    expect(seenHeaders[0]["mcp-session-id"]).toBeUndefined();
    expect(seenHeaders[1]["mcp-session-id"]).toBe("sess-123");
  });

  it("parses tools/list SSE response", async () => {
    const fetchImpl = mockFetch([
      sse({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05" } }, { "mcp-session-id": "s" }),
      new Response("", { status: 200 }),
      sse({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "web_search_prime", inputSchema: { type: "object" } }] } }),
    ]);
    const c = new McpClient({ url: "https://x/mcp", apiKey: "k", fetchImpl });
    const tools = await c.listTools();
    expect(tools[0].name).toBe("web_search_prime");
  });

  it("parses tools/call content[] result", async () => {
    const fetchImpl = mockFetch([
      sse({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05" } }, { "mcp-session-id": "s" }),
      new Response("", { status: 200 }),
      sse({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "hello" }], isError: false } }),
    ]);
    const c = new McpClient({ url: "https://x/mcp", apiKey: "k", fetchImpl });
    const r = await c.callTool("f", {});
    expect(r.content[0]).toEqual({ type: "text", text: "hello" });
    expect(r.isError).toBe(false);
  });

  it("throws McpAuthError on GLM auth envelope (HTTP 200 + {success:false})", async () => {
    const fetchImpl = (async (): Promise<Response> => {
      return new Response(JSON.stringify({ code: 1001, msg: "no Authorization", success: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const c = new McpClient({ url: "https://x/mcp", apiKey: "bad", fetchImpl });
    expect(c.initialize()).rejects.toBeInstanceOf(McpAuthError);
  });

  it("tolerates empty body on notifications/initialized", async () => {
    const fetchImpl = mockFetch([
      sse({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05" } }, { "mcp-session-id": "s" }),
      new Response("", { status: 200 }),
    ]);
    const c = new McpClient({ url: "https://x/mcp", apiKey: "k", fetchImpl });
    await expect(c.initialize()).resolves.toBeUndefined();
  });
});

describe("glmMcpEndpoint", () => {
  it("builds the zai endpoint", () => {
    expect(glmMcpEndpoint("zai", "web_search_prime")).toBe("https://api.z.ai/api/mcp/web_search_prime/mcp");
  });
  it("builds the bigmodel endpoint", () => {
    expect(glmMcpEndpoint("bigmodel", "zread")).toBe("https://open.bigmodel.cn/api/mcp/zread/mcp");
  });
});
