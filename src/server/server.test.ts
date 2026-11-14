/**
 * Tests for server routing and proxy API key auth.
 */
import { describe, it, expect } from "bun:test";
import { createFetchHandler } from "./server.js";
import { handleListModels } from "./routes-openai.js";
import type { ProxyConfig } from "../config/types.js";
import type { LoginFlowHost } from "./login-handler.js";
import { AuthManager } from "../auth/manager.js";

/** AuthManager with a preset oauth credential (replaces the removed apikey mode). */
function oauthAuth(key = "testkey.testsecret"): AuthManager {
  const [apiKey, secret] = key.split(".");
  const auth = new AuthManager();
  auth.setOAuthCredential(secret ? { apiKey, secret, provider: "zai" } : { apiKey, provider: "zai" });
  return auth;
}

function makeConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    server: { port: 0, host: "127.0.0.1" },
    auth: { ...overrides.auth },
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
    mcp: { enabled: true, webSearch: true, webReader: false, zread: false, gateway: { enabled: true, upstreamOrigin: "https://zcode.chatglm.site" } },
    media: { enabled: false, upstreamOrigin: "https://zcode.chatglm.site" },
  async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },
  claim: { enabled: false, auto: true, origin: "https://zcode.z.ai", pollIntervalMs: 300000, cooldownMs: 600000, planId: "" },
    logging: { level: "info" },
    ...overrides,
  };
}

function mockUpstream(): typeof fetch {
  return (async (req: Request): Promise<Response> => {
    const url = req.url;
    if (url.includes("/v1/models") || req.method === "GET") {
      return new Response('{"object":"list","data":[]}', { status: 200, headers: { "content-type": "application/json" } });
    }
    const body = await req.text();
    const parsed = JSON.parse(body);
    if (url.includes("/anthropic/") || url.includes("/v1/messages")) {
      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Hello from upstream" }],
          model: parsed.model ?? "glm-4.6",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: Date.now(),
        model: parsed.model ?? "glm-4.6",
        choices: [{ index: 0, message: { role: "assistant", content: "Hello from upstream" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

describe("server routing", () => {
  it("POST /v1/chat/completions forwards to upstream", async () => {
    const config = makeConfig();
    const auth = oauthAuth();
    const handler = createFetchHandler({ config, auth, fetchImpl: mockUpstream() });

    const resp = await handler(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "Hi" }] }),
      }),
    );
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.choices[0].message.content).toBe("Hello from upstream");
  });

  it("POST /v1/messages returns Anthropic-compatible response", async () => {
    const config = makeConfig();
    const auth = oauthAuth();
    const handler = createFetchHandler({ config, auth, fetchImpl: mockUpstream() });

    const resp = await handler(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-4.6", max_tokens: 100, messages: [{ role: "user", content: "Hi" }] }),
      }),
    );
    expect(resp.status).toBe(200);
  });

  it("does not expose POST /v1/responses when Responses API is disabled", async () => {
    const config = makeConfig({ responses: { enabled: false, storeMaxEntries: 1000, storeTtlMs: 86400000 } });
    const auth = oauthAuth();
    let upstreamCalls = 0;
    const fetchImpl = Object.assign(async (_request: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      upstreamCalls++;
      return new Response("unexpected", { status: 500 });
    }, { preconnect: fetch.preconnect });
    const handler = createFetchHandler({ config, auth, fetchImpl });

    const resp = await handler(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6", input: "Hi" }),
    }));
    expect(resp.status).toBe(404);
    expect(upstreamCalls).toBe(0);
  });

  it("returns async_plan_unsupported on /async/* when plan is start-plan", async () => {
    const config = makeConfig({
      plan: "start-plan",
      async: { enabled: true, origin: "https://zcode.z.ai", pollIntervalMs: 10, keepAliveIntervalMs: 5, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 100, controlTimeoutMs: 1000, defaultModel: "" },
    });
    const auth = oauthAuth();
    const handler = createFetchHandler({ config, auth, fetchImpl: mockUpstream() });

    const resp = await handler(new Request("http://localhost/async/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "Hi" }] }),
    }));
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error.type).toBe("async_plan_unsupported");
  });

  it("GET /health returns ok status", async () => {
    const config = makeConfig();
    const auth = oauthAuth("test");
    const handler = createFetchHandler({ config, auth });

    const resp = await handler(new Request("http://localhost/health"));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.status).toBe("ok");
  });
});

describe("proxy API key auth", () => {
  it("accepts request with correct Bearer proxy key", async () => {
    const config = makeConfig({ auth: { proxyApiKey: "proxy-secret" } });
    const auth = oauthAuth("test");
    const handler = createFetchHandler({ config, auth, fetchImpl: mockUpstream() });

    const resp = await handler(
      new Request("http://localhost/v1/models", {
        headers: { authorization: "Bearer proxy-secret" },
      }),
    );
    expect(resp.status).toBe(200);
  });

  it("accepts request with correct x-api-key proxy key", async () => {
    const config = makeConfig({ auth: { proxyApiKey: "proxy-secret" } });
    const auth = oauthAuth("test");
    const handler = createFetchHandler({ config, auth, fetchImpl: mockUpstream() });

    const resp = await handler(
      new Request("http://localhost/v1/models", {
        headers: { "x-api-key": "proxy-secret" },
      }),
    );
    expect(resp.status).toBe(200);
  });

  it("does not require proxy key when proxyApiKey is unset", async () => {
    const config = makeConfig({ auth: {} });
    const auth = oauthAuth("test");
    const handler = createFetchHandler({ config, auth, fetchImpl: mockUpstream() });

    const resp = await handler(new Request("http://localhost/v1/models"));
    expect(resp.status).toBe(200);
  });
});

describe("CORS", () => {
  it("OPTIONS with proxyApiKey set returns 204 with CORS headers", async () => {
    const config = makeConfig({ auth: { proxyApiKey: "secret" } });
    const auth = oauthAuth("test");
    const handler = createFetchHandler({ config, auth });

    const resp = await handler(new Request("http://localhost/v1/models", { method: "OPTIONS" }));
    expect(resp.status).toBe(204);
    expect(resp.headers.get("access-control-allow-origin")).toBe("*");
    expect(resp.headers.get("access-control-allow-methods")).toContain("DELETE");
  });

  it("keyless deployment emits no CORS headers (blocks cross-origin browsers)", async () => {
    const config = makeConfig({ auth: {} });
    const auth = oauthAuth("test");
    const handler = createFetchHandler({ config, auth });

    const preflight = await handler(new Request("http://localhost/v1/models", { method: "OPTIONS" }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();

    const resp = await handler(new Request("http://localhost/v1/models", { method: "GET" }));
    expect(resp.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("web UI", () => {
  it("GET /webui serves HTML without the proxy API key", async () => {
    // proxyApiKey is configured, yet /webui must load freely — it sits before
    // the auth gate by design so the page can present the key input.
    const config = makeConfig({ auth: { proxyApiKey: "proxy-secret" } });
    const auth = oauthAuth("test");
    const handler = createFetchHandler({ config, auth, fetchImpl: mockUpstream() });

    const resp = await handler(new Request("http://localhost/webui", { method: "GET" }));
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("text/html");
    const body = await resp.text();
    expect(body).toContain("<!doctype html>");
  });

  it("non-GET /webui is not served as the SPA", async () => {
    const config = makeConfig({ auth: { proxyApiKey: "proxy-secret" } });
    const auth = oauthAuth("test");
    const handler = createFetchHandler({ config, auth, fetchImpl: mockUpstream() });

    const resp = await handler(new Request("http://localhost/webui", { method: "POST" }));
    // POST falls through to the auth gate (proxyApiKey set, no creds) -> 401.
    expect(resp.status).toBe(401);
  });
});

describe("login page routes", () => {
  /** Scripted LoginFlowHost — the OAuth flow itself is covered in login-handler.test.ts. */
  function fakeLoginHost(): LoginFlowHost {
    return {
      start: async (provider) => ({ authorizeUrl: `https://example.com/authorize?provider=${provider}` }),
      status: async () => ({ phase: "idle" }),
    };
  }

  it("without loginHost the /login routes stay unregistered (TUI hosts its own listener)", async () => {
    const config = makeConfig();
    const auth = oauthAuth("test");
    const handler = createFetchHandler({ config, auth, fetchImpl: mockUpstream() });

    const resp = await handler(new Request("http://localhost/login", { method: "GET" }));
    expect(resp.status).toBe(404);
  });

  it("GET /login serves the selection page tokenless; flow endpoints sit behind the proxyApiKey gate", async () => {
    const config = makeConfig({ auth: { proxyApiKey: "proxy-secret" } });
    const auth = oauthAuth("test");
    const handler = createFetchHandler({ config, auth, fetchImpl: mockUpstream(), loginHost: fakeLoginHost() });

    // Static page: tokenless, like /webui (the page itself is inert).
    const page = await handler(new Request("http://localhost/login", { method: "GET" }));
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain('data-provider="zai_cn"');

    // Flow endpoints: a completed login overwrites the stored credential, so
    // starting one MUST carry the key (401 without it).
    const unauthorized = await handler(
      new Request("http://localhost/login/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "zai_cn" }),
      }),
    );
    expect(unauthorized.status).toBe(401);

    const authorized = await handler(
      new Request("http://localhost/login/start", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer proxy-secret" },
        body: JSON.stringify({ provider: "zai_cn" }),
      }),
    );
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toEqual({
      ok: true,
      authorizeUrl: "https://example.com/authorize?provider=zai_cn",
    });

    // Body cap: /login/start only ever carries `{provider}` — a large body is
    // rejected 413 before the handler sees it (TUI listener has the same cap).
    const oversized = await handler(
      new Request("http://localhost/login/start", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer proxy-secret",
          "content-length": String(9000),
        },
        body: "x".repeat(9000),
      }),
    );
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ ok: false, error: "body_too_large" });

    const status = await handler(
      new Request("http://localhost/login/status", {
        method: "GET",
        headers: { authorization: "Bearer proxy-secret" },
      }),
    );
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ ok: true, phase: "idle" });
  });

  it("without a proxyApiKey the flow endpoints are open (loopback default deployment)", async () => {
    const config = makeConfig();
    const auth = oauthAuth("test");
    const handler = createFetchHandler({ config, auth, fetchImpl: mockUpstream(), loginHost: fakeLoginHost() });

    const resp = await handler(
      new Request("http://localhost/login/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "zai" }),
      }),
    );
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true, authorizeUrl: "https://example.com/authorize?provider=zai" });
  });
});

describe("route handler exports", () => {
  it("handleListModels rich catalog on client_version=pi", async () => {
    const resp = handleListModels(new Request("http://localhost/v1/models?client_version=pi"));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      models: Array<{
        slug: string;
        context_window: number;
        max_tokens?: number;
        input_modalities: string[];
        supported_reasoning_levels: Array<{ effort: string }>;
        visibility: string;
      }>;
      data?: unknown;
    };
    // Rich shape: top-level models[], no data[].
    expect(Array.isArray(body.models)).toBe(true);
    expect(body.data).toBeUndefined();
    // Only the advertised pair is listed (full pinned catalog stays internal
    // for the translator; other model ids still forward).
    expect(body.models.map((m) => m.slug)).toEqual(["glm-5.3", "glm-5.3-flash"]);
    const flash = body.models.find((m) => m.slug === "glm-5.3-flash");
    expect(flash).toBeDefined();
    expect(flash!.context_window).toBe(1_000_000);
    expect(flash!.max_tokens).toBe(128_000);
    expect(flash!.visibility).toBe("list");
    expect(flash!.input_modalities).toEqual(["text", "image"]);
    expect(body.models.find((m) => m.slug === "glm-5.3")!.input_modalities).toEqual(["text"]);
    // Reasoning model advertises the Codex-style effort levels the DSH
    // better-basicfun bridge maps onto its selector levels.
    const efforts = flash!.supported_reasoning_levels.map((l) => l.effort);
    expect(efforts).toEqual(["low", "medium", "high", "xhigh"]);
  });
});
