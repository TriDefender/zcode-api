/**
 * Tests for the /mcp routes: listing, proxyApiKey gating, plan gating,
 * credential matrix, and relay forwarding through the full fetch-handler dispatch.
 */
import { describe, it, expect } from "bun:test";
import { createFetchHandler } from "./server.js";
import type { ProxyConfig, McpGatewayConfig } from "../config/types.js";
import { AuthManager } from "../auth/manager.js";
import type { Credential } from "../auth/types.js";

function makeConfig(overrides: Partial<ProxyConfig> = {}, mcpGateway: McpGatewayConfig = { enabled: true, upstreamOrigin: "https://zcode.z.ai" }): ProxyConfig {
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
    clientSigning: { enabled: false, origin: "https://zcode.z.ai" },
    mcp: { enabled: true, webSearch: true, webReader: false, zread: false, gateway: mcpGateway },
    async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },
    claim: { enabled: false, auto: true, origin: "https://zcode.z.ai", pollIntervalMs: 300000, cooldownMs: 600000, planId: "" },
    logging: { level: "info" },
    ...overrides,
  };
}

function fullCred(fields: Partial<Credential> = {}): Credential {
  return { apiKey: "sk-x.sec", provider: "zai", jwt: "jwt-1", ...fields };
}

/** Capturing upstream stub shared by relay tests. */
function upstreamCapture(resp?: Response): { fetch: typeof fetch; seen: () => { url: string; init: RequestInit } } {
  let captured: { url: string; init: RequestInit } | null = null;
  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    captured = { url: String(input), init: init ?? {} };
    return resp ?? new Response('{"jsonrpc":"2.0","id":1,"result":{}}', {
      status: 200,
      headers: { "content-type": "application/json", "mcp-session-id": "sess-9" },
    });
  }) as typeof fetch;
  return { fetch: impl, seen: () => captured! };
}

describe("GET /mcp listing", () => {
  it("lists catalogue servers with route metadata (JSON default)", async () => {
    const auth = new AuthManager();
    auth.setOAuthCredential(fullCred());
    const handler = createFetchHandler({ config: makeConfig(), auth, fetchImpl: upstreamCapture().fetch });

    const resp = await handler(new Request("http://localhost/mcp", { method: "GET" }));
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("application/json");
    const body = await resp.json();
    expect(body.object).toBe("list");
    expect(body.authReady).toBe(true);
    expect(body.authMode).toBe("coding-plan");
    const tianyancha = body.servers.find((s: { key: string }) => s.key === "tianyancha");
    expect(tianyancha).toBeDefined();
    expect(tianyancha.path).toBe("/mcp/tianyancha");
    expect(tianyancha.routeId).toBe("finance_tianyancha");
    expect(tianyancha.requiresPaidPlan).toBe(true);
    expect(tianyancha.methods).toEqual(["POST", "GET", "DELETE"]);
  });

  it("renders an HTML table for browsers (Accept: text/html)", async () => {
    const auth = new AuthManager();
    auth.setOAuthCredential(fullCred());
    const handler = createFetchHandler({ config: makeConfig(), auth, fetchImpl: upstreamCapture().fetch });

    const resp = await handler(new Request("http://localhost/mcp", { method: "GET", headers: { accept: "text/html,application/xhtml+xml" } }));
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("text/html");
    const html = await resp.text();
    expect(html).toContain("tianyancha");
    expect(html).toContain("finance_tianyancha");
  });

  it("annotates authError=plan_unsupported on start-plan", async () => {
    const auth = new AuthManager();
    auth.setOAuthCredential(fullCred());
    const handler = createFetchHandler({ config: makeConfig({ plan: "start-plan" }), auth, fetchImpl: upstreamCapture().fetch });

    const resp = await handler(new Request("http://localhost/mcp", { method: "GET" }));
    const body = await resp.json();
    expect(body.authReady).toBe(false);
    expect(body.authError).toBe("plan_unsupported");
  });

  it("annotates authError=missing_jwt when the stored credential lacks a JWT", async () => {
    const auth = new AuthManager();
    auth.setOAuthCredential(fullCred({ jwt: undefined }));
    const handler = createFetchHandler({ config: makeConfig(), auth, fetchImpl: upstreamCapture().fetch });

    const resp = await handler(new Request("http://localhost/mcp", { method: "GET" }));
    const body = await resp.json();
    expect(body.authReady).toBe(false);
    expect(body.authError).toBe("missing_jwt");
  });
});

describe("/mcp proxyApiKey gating (LLM-route semantics)", () => {
  const auth = new AuthManager();
  auth.setOAuthCredential(fullCred());

  it("rejects /mcp and /mcp/{server} without the key when one is configured", async () => {
    const handler = createFetchHandler({ config: makeConfig({ auth: { proxyApiKey: "secret-1" } }), auth, fetchImpl: upstreamCapture().fetch });
    const listing = await handler(new Request("http://localhost/mcp"));
    const relay = await handler(new Request("http://localhost/mcp/tianyancha", { method: "POST", body: "{}" }));
    expect(listing.status).toBe(401);
    expect(relay.status).toBe(401);
  });

  it("accepts both routes with the correct key (authorization or x-api-key)", async () => {
    const handler = createFetchHandler({ config: makeConfig({ auth: { proxyApiKey: "secret-1" } }), auth, fetchImpl: upstreamCapture().fetch });
    const listing = await handler(new Request("http://localhost/mcp", { headers: { authorization: "Bearer secret-1" } }));
    const relay = await handler(new Request("http://localhost/mcp/tianyancha", { method: "POST", headers: { "x-api-key": "secret-1" }, body: "{}" }));
    expect(listing.status).toBe(200);
    expect(relay.status).toBe(200);
  });
});

describe("/mcp/{server} relay", () => {
  it("POST forwards to the official gateway with injected credentials", async () => {
    const auth = new AuthManager();
    auth.setOAuthCredential(fullCred());
    const upstream = upstreamCapture();
    const handler = createFetchHandler({ config: makeConfig(), auth, fetchImpl: upstream.fetch });

    const resp = await handler(new Request("http://localhost/mcp/tianyancha", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer client-key" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    }));

    expect(resp.status).toBe(200);
    expect(resp.headers.get("mcp-session-id")).toBe("sess-9");
    const { url, init } = upstream.seen();
    expect(url).toBe("https://zcode.z.ai/api/v1/mcp/server/finance_tianyancha");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer jwt-1");
    expect(headers["X-Bigmodel-Authorization"]).toBe("Bearer sk-x.sec");
    expect(headers["Bigmodel-Target-Type"]).toBe("PERSONAL");
  });

  it("respects a configured upstreamOrigin override", async () => {
    const auth = new AuthManager();
    auth.setOAuthCredential(fullCred());
    const upstream = upstreamCapture();
    const handler = createFetchHandler({
      config: makeConfig({}, { enabled: true, upstreamOrigin: "http://127.0.0.1:9999" }),
      auth,
      fetchImpl: upstream.fetch,
    });
    const resp = await handler(new Request("http://localhost/mcp/wind-stock", { method: "POST", body: "{}" }));
    expect(resp.status).toBe(200);
    expect(upstream.seen().url).toBe("http://127.0.0.1:9999/api/v1/mcp/server/finance_wind_stock");
  });

  it("unknown server → 404 mcp_server_not_found", async () => {
    const auth = new AuthManager();
    auth.setOAuthCredential(fullCred());
    const handler = createFetchHandler({ config: makeConfig(), auth, fetchImpl: upstreamCapture().fetch });
    const resp = await handler(new Request("http://localhost/mcp/nope", { method: "POST", body: "{}" }));
    expect(resp.status).toBe(404);
    const body = await resp.json();
    expect(body.error.type).toBe("mcp_server_not_found");
    expect(body.error.message).toContain("GET /mcp");
  });

  it("malformed percent-escape in the server key → 404, not 500", async () => {
    const auth = new AuthManager();
    auth.setOAuthCredential(fullCred());
    const handler = createFetchHandler({ config: makeConfig(), auth, fetchImpl: upstreamCapture().fetch });
    const resp = await handler(new Request("http://localhost/mcp/%zz", { method: "POST", body: "{}" }));
    expect(resp.status).toBe(404);
    const body = await resp.json();
    expect(body.error.type).toBe("mcp_server_not_found");
  });

  it("start-plan → 400 mcp_plan_unsupported (explicit, mirrors async routes)", async () => {
    const auth = new AuthManager();
    auth.setOAuthCredential(fullCred());
    const handler = createFetchHandler({ config: makeConfig({ plan: "start-plan" }), auth, fetchImpl: upstreamCapture().fetch });
    const resp = await handler(new Request("http://localhost/mcp/tianyancha", { method: "POST", body: "{}" }));
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error.type).toBe("mcp_plan_unsupported");
    expect(body.error.message).toContain("coding-plan");
  });

  it("not logged in → 400 mcp_credentials_unavailable", async () => {
    const handler = createFetchHandler({ config: makeConfig(), auth: new AuthManager(), fetchImpl: upstreamCapture().fetch });
    const resp = await handler(new Request("http://localhost/mcp/tianyancha", { method: "POST", body: "{}" }));
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error.type).toBe("mcp_credentials_unavailable");
    expect(body.error.message).toContain("auth login");
  });

  it("gateway disabled → routes disappear (404)", async () => {
    const auth = new AuthManager();
    auth.setOAuthCredential(fullCred());
    const handler = createFetchHandler({
      config: makeConfig({}, { enabled: false, upstreamOrigin: "https://zcode.z.ai" }),
      auth,
      fetchImpl: upstreamCapture().fetch,
    });
    const listing = await handler(new Request("http://localhost/mcp"));
    const relay = await handler(new Request("http://localhost/mcp/tianyancha", { method: "POST", body: "{}" }));
    expect(listing.status).toBe(404);
    expect(relay.status).toBe(404);
  });
});
