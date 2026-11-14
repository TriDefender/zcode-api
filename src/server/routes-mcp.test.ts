/**
 * Tests for the aggregated /mcp route: listing vs SSE-405, JSON-RPC surface
 * (initialize / tools/list / tools/call / batch / notifications), proxyApiKey
 * gating, plan gating, credential matrix, and DELETE session close — all
 * through the full fetch-handler dispatch.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { createFetchHandler } from "./server.js";
import { resetMcpAggregateCache } from "./routes-mcp.js";
import type { ProxyConfig, McpGatewayConfig } from "../config/types.js";
import { AuthManager } from "../auth/manager.js";
import type { Credential } from "../auth/types.js";

function makeConfig(overrides: Partial<ProxyConfig> = {}, mcpGateway: McpGatewayConfig = { enabled: true, upstreamOrigin: "https://zcode.test" }): ProxyConfig {
  return {
    server: { port: 0, host: "127.0.0.1" },
    auth: {},
    provider: "zai",
    plan: "coding-plan",
    providers: {
      zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
      bigmodel: { anthropicBase: "https://open.bigmodel.cn/api/anthropic", openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
    },
    defaultModel: "glm-4.6",
    models: ["glm-4.6"],
    identity: { appVersion: "test-1.0.0", sourceTitle: "cli", refererOrigin: "https://zcode.z.ai" },
    clientIdentity: { mode: "observe", ttlSeconds: 900, maxSessions: 1024 },
    responses: { enabled: true, storeMaxEntries: 1000, storeTtlMs: 86400000 },
    endpointRouting: { enabled: false, origin: "https://zcode.z.ai" },
    clientSigning: { enabled: false }, highspeed: { enabled: false, origin: "https://zcode.z.ai", models: [] },
    mcp: { enabled: true, webSearch: true, webReader: false, zread: false, gateway: mcpGateway },
    media: { enabled: false, upstreamOrigin: "https://zcode.chatglm.site" },
    async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },
    claim: { enabled: false, auto: true, origin: "https://zcode.z.ai", pollIntervalMs: 300000, cooldownMs: 600000, planId: "" },
    logging: { level: "info" },
    ...overrides,
  };
}

function fullCred(fields: Partial<Credential> = {}): Credential {
  return { apiKey: "sk-x.sec", provider: "zai", jwt: "jwt-1", ...fields };
}

/**
 * Minimal official-gateway stub: answers initialize (session id per route),
 * notifications, tools/list (one tool per plugin) and tools/call (echo).
 */
function officialGatewayStub(opts: { failInit?: Set<string> } = {}) {
  const calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ url, method: init?.method ?? "GET", body });
    const routeId = new URL(url).pathname.split("/").pop() ?? "";
    if (init?.method === "DELETE") return new Response(null, { status: 202 });
    const rpcMethod = body.method as string | undefined;
    const id = body.id;
    const json = (payload: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json", ...headers } });
    if (rpcMethod === "initialize") {
      if (opts.failInit?.has(routeId)) return new Response("forbidden", { status: 403 });
      return json({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "zcode-official-mcp", version: "1" } } }, { "mcp-session-id": `sess-${routeId}` });
    }
    if (rpcMethod === "notifications/initialized") return new Response(null, { status: 202 });
    if (rpcMethod === "tools/list") {
      return json({ jsonrpc: "2.0", id, result: { tools: [{ name: "quote", description: "d", inputSchema: { type: "object" } }] } });
    }
    if (rpcMethod === "tools/call") {
      const name = (body.params as { name?: string } | undefined)?.name ?? "?";
      return json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `called:${name}` }] } });
    }
    return json({ jsonrpc: "2.0", id, error: { code: -32601, message: "unknown" } });
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

function handler(config: ProxyConfig, auth: AuthManager, fetchImpl?: typeof fetch) {
  return createFetchHandler({ config, auth, ...(fetchImpl ? { fetchImpl } : {}) });
}

const rpc = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/mcp", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

beforeEach(() => {
  resetMcpAggregateCache();
});

describe("GET /mcp discovery", () => {
  it("lists the aggregate endpoint + catalogue as JSON by default", async () => {
    const auth = new AuthManager();
    auth.setOAuthCredential(fullCred());
    const resp = await handler(makeConfig(), auth, officialGatewayStub().fetch)(new Request("http://localhost/mcp"));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { endpoint: string; servers: unknown[]; authReady: boolean };
    expect(body.endpoint).toBe("/mcp");
    expect(body.servers.length).toBeGreaterThan(10);
    expect(body.authReady).toBe(true);
  });

  it("renders HTML for browsers", async () => {
    const auth = new AuthManager();
    auth.setOAuthCredential(fullCred());
    const resp = await handler(makeConfig(), auth, officialGatewayStub().fetch)(
      new Request("http://localhost/mcp", { headers: { accept: "text/html" } }),
    );
    expect(resp.headers.get("content-type")).toContain("text/html");
  });

  it("answers 405 to MCP clients asking for an SSE stream (no server push)", async () => {
    const auth = new AuthManager();
    auth.setOAuthCredential(fullCred());
    const resp = await handler(makeConfig(), auth, officialGatewayStub().fetch)(
      new Request("http://localhost/mcp", { headers: { accept: "text/event-stream" } }),
    );
    expect(resp.status).toBe(405);
    expect(resp.headers.get("allow")).toBe("POST, DELETE");
  });
});

describe("POST /mcp — JSON-RPC surface", () => {
  it("initialize: 200, aggregate serverInfo, protocol echo, no Mcp-Session-Id (stateless)", async () => {
    const auth = new AuthManager();
    auth.setOAuthCredential(fullCred());
    const resp = await handler(makeConfig(), auth, officialGatewayStub().fetch)(
      rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "c", version: "1" } } }),
    );
    expect(resp.status).toBe(200);
    expect(resp.headers.get("mcp-session-id")).toBeNull();
    const body = (await resp.json()) as { result: { protocolVersion: string; serverInfo: { name: string } } };
    expect(body.result.protocolVersion).toBe("2025-03-26");
    expect(body.result.serverInfo.name).toBe("zcode-proxy-mcp");
  });

  it("tools/list: namespaced merge across all plugins (upstream via shared fetchImpl)", async () => {
    const auth = new AuthManager();
    auth.setOAuthCredential(fullCred());
    const stub = officialGatewayStub();
    const resp = await handler(makeConfig(), auth, stub.fetch)(rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    const body = (await resp.json()) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.some((t) => t.name === "wind-stock__quote")).toBe(true);
    expect(body.result.tools.some((t) => t.name === "finance-search__quote")).toBe(true);
  });

  it("tools/call: dispatches with the original tool name", async () => {
    const auth = new AuthManager();
    auth.setOAuthCredential(fullCred());
    const stub = officialGatewayStub();
    const resp = await handler(makeConfig(), auth, stub.fetch)(
      rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "tianyancha__quote", arguments: { q: "x" } } }),
    );
    const body = (await resp.json()) as { result: { content: Array<{ text: string }> } };
    expect(body.result.content[0]!.text).toBe("called:quote");
    const call = stub.calls.filter((c) => c.body.method === "tools/call").at(-1)!;
    expect(call.url).toContain("/api/v1/mcp/server/finance_tianyancha");
    expect((call.body.params as { name: string }).name).toBe("quote");
  });

  it("notifications get 202 with no body", async () => {
    const auth = new AuthManager();
    auth.setOAuthCredential(fullCred());
    const resp = await handler(makeConfig(), auth, officialGatewayStub().fetch)(
      rpc({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    expect(resp.status).toBe(202);
    expect(await resp.text()).toBe("");
  });

  it("batches: replies collected for requests only", async () => {
    const auth = new AuthManager();
    auth.setOAuthCredential(fullCred());
    const resp = await handler(makeConfig(), auth, officialGatewayStub().fetch)(
      rpc([
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "ping" },
        "not-a-message",
      ]),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Array<{ id: number | null }>;
    // The invalid element earns an id:null error reply per JSON-RPC 2.0 §5.1.
    expect(body.map((r) => r.id)).toEqual([1, 2, null]);
  });

  it("invalid JSON → 400 -32700; empty batch → 400 -32600", async () => {
    const auth = new AuthManager();
    auth.setOAuthCredential(fullCred());
    const h = handler(makeConfig(), auth, officialGatewayStub().fetch);
    const bad = await h(rpc("{oops"));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: number } }).error.code).toBe(-32700);
    const empty = await h(rpc([]));
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: { code: number } }).error.code).toBe(-32600);
  });
});

describe("/mcp gates", () => {
  it("start-plan → 400 mcp_plan_unsupported", async () => {
    const auth = new AuthManager();
    auth.setOAuthCredential(fullCred());
    const resp = await handler(makeConfig({ plan: "start-plan" }), auth, officialGatewayStub().fetch)(rpc({ jsonrpc: "2.0", id: 1, method: "ping" }));
    expect(resp.status).toBe(400);
    expect(((await resp.json()) as { error: { type: string } }).error.type).toBe("mcp_plan_unsupported");
  });

  it("no credential → 400 mcp_credentials_unavailable", async () => {
    const resp = await handler(makeConfig(), new AuthManager(), officialGatewayStub().fetch)(rpc({ jsonrpc: "2.0", id: 1, method: "ping" }));
    expect(resp.status).toBe(400);
    expect(((await resp.json()) as { error: { type: string } }).error.type).toBe("mcp_credentials_unavailable");
  });

  it("proxyApiKey gate applies to /mcp like every other route", async () => {
    const auth = new AuthManager();
    auth.setOAuthCredential(fullCred());
    const h = handler(makeConfig({ auth: { proxyApiKey: "secret-1" } }), auth, officialGatewayStub().fetch);
    const denied = await h(new Request("http://localhost/mcp"));
    expect(denied.status).toBe(401);
    const allowed = await h(new Request("http://localhost/mcp", { headers: { authorization: "Bearer secret-1" } }));
    expect(allowed.status).toBe(200);
  });

  it("a re-login (credential change) rebuilds the aggregate automatically", async () => {
    const auth = new AuthManager();
    auth.setOAuthCredential(fullCred());
    const stub = officialGatewayStub();
    const h = handler(makeConfig(), auth, stub.fetch);
    await h(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    const initsFirst = stub.calls.filter((c) => c.body.method === "initialize").length;
    auth.setOAuthCredential(fullCred({ jwt: "jwt-2" }));
    await h(rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    const initsSecond = stub.calls.filter((c) => c.body.method === "initialize").length;
    expect(initsSecond).toBe(initsFirst * 2); // fresh sessions for the new credential
  });
});

describe("DELETE /mcp", () => {
  it("closes cached upstream sessions with 202", async () => {
    const auth = new AuthManager();
    auth.setOAuthCredential(fullCred());
    const stub = officialGatewayStub();
    const h = handler(makeConfig(), auth, stub.fetch);
    await h(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    const resp = await h(new Request("http://localhost/mcp", { method: "DELETE" }));
    expect(resp.status).toBe(202);
    expect(stub.calls.some((c) => c.method === "DELETE")).toBe(true);
  });
});
