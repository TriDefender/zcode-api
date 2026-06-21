/**
 * Tests for server routing and proxy API key auth.
 * @see .omo/plans/zcode-proxy.md Task 7
 */
import { describe, it, expect } from "bun:test";
import { createFetchHandler } from "./server.js";
import { handleListModels } from "./routes-openai.js";
import { handleMessages } from "./routes-anthropic.js";
import type { ProxyConfig } from "../config/types.js";
import { AuthManager } from "../auth/manager.js";

function makeConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    server: { port: 0, host: "127.0.0.1" },
    auth: { mode: "apikey", apiKey: "testkey.testsecret", ...overrides.auth },
    provider: "zai",
    plan: "coding-plan",
    providers: {
      zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
      bigmodel: { anthropicBase: "https://open.bigmodel.cn/api/anthropic", openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
    },
    defaultModel: "glm-4.6",
    models: ["glm-4.6"],
    identity: { appVersion: "test-1.0.0", sourceTitle: "cli", refererOrigin: "https://zcode.z.ai" },
    pool: { enabled: false, maxAccountAttempts: 5 },
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
  it("GET /v1/models returns model list", async () => {
    const config = makeConfig({ auth: { mode: "apikey", apiKey: "test" } });
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" });
    const handler = createFetchHandler({ config, auth, fetchImpl: mockUpstream() });

    const resp = await handler(new Request("http://localhost/v1/models", { method: "GET" }));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.object).toBe("list");
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0].object).toBe("model");
  });

  it("POST /v1/chat/completions forwards to upstream", async () => {
    const config = makeConfig();
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
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

  it("POST /v1/messages forwards to Anthropic upstream", async () => {
    const config = makeConfig();
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
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

  it("GET /health returns ok status", async () => {
    const config = makeConfig();
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" });
    const handler = createFetchHandler({ config, auth });

    const resp = await handler(new Request("http://localhost/health"));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.status).toBe("ok");
  });

  it("GET /app returns dashboard HTML", async () => {
    const config = makeConfig();
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" });
    const handler = createFetchHandler({ config, auth });

    const resp = await handler(new Request("http://localhost/app"));
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("text/html");
    const html = await resp.text();
    expect(html).toContain("ZCode Proxy");
  });

  it("unknown route returns 404", async () => {
    const config = makeConfig();
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" });
    const handler = createFetchHandler({ config, auth });

    const resp = await handler(new Request("http://localhost/unknown", { method: "GET" }));
    expect(resp.status).toBe(404);
  });
});

describe("proxy API key auth", () => {
  it("rejects request without proxy API key when configured", async () => {
    const config = makeConfig({ auth: { mode: "apikey", apiKey: "test", proxyApiKey: "proxy-secret" } });
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" });
    const handler = createFetchHandler({ config, auth, fetchImpl: mockUpstream() });

    const resp = await handler(new Request("http://localhost/v1/models"));
    expect(resp.status).toBe(401);
  });

  it("accepts request with correct Bearer proxy key", async () => {
    const config = makeConfig({ auth: { mode: "apikey", apiKey: "test", proxyApiKey: "proxy-secret" } });
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" });
    const handler = createFetchHandler({ config, auth, fetchImpl: mockUpstream() });

    const resp = await handler(
      new Request("http://localhost/v1/models", {
        headers: { authorization: "Bearer proxy-secret" },
      }),
    );
    expect(resp.status).toBe(200);
  });

  it("accepts request with correct x-api-key proxy key", async () => {
    const config = makeConfig({ auth: { mode: "apikey", apiKey: "test", proxyApiKey: "proxy-secret" } });
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" });
    const handler = createFetchHandler({ config, auth, fetchImpl: mockUpstream() });

    const resp = await handler(
      new Request("http://localhost/v1/models", {
        headers: { "x-api-key": "proxy-secret" },
      }),
    );
    expect(resp.status).toBe(200);
  });

  it("rejects request with wrong proxy key", async () => {
    const config = makeConfig({ auth: { mode: "apikey", apiKey: "test", proxyApiKey: "proxy-secret" } });
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" });
    const handler = createFetchHandler({ config, auth, fetchImpl: mockUpstream() });

    const resp = await handler(
      new Request("http://localhost/v1/models", {
        headers: { authorization: "Bearer wrong-key" },
      }),
    );
    expect(resp.status).toBe(401);
  });

  it("does not require proxy key when proxyApiKey is unset", async () => {
    const config = makeConfig({ auth: { mode: "apikey", apiKey: "test" } });
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" });
    const handler = createFetchHandler({ config, auth, fetchImpl: mockUpstream() });

    const resp = await handler(new Request("http://localhost/v1/models"));
    expect(resp.status).toBe(200);
  });
});

describe("CORS", () => {
  it("OPTIONS returns 204 with CORS headers", async () => {
    const config = makeConfig();
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" });
    const handler = createFetchHandler({ config, auth });

    const resp = await handler(new Request("http://localhost/v1/models", { method: "OPTIONS" }));
    expect(resp.status).toBe(204);
    expect(resp.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("route handler exports", () => {
  it("handleListModels returns model list", () => {
    const resp = handleListModels();
    expect(resp.status).toBe(200);
  });

  it("handleMessages is a function", () => {
    expect(typeof handleMessages).toBe("function");
  });
});

describe("responses and model metadata routes", () => {
  it("GET /v1/models/glm-5.2 returns model", async () => {
    const config = makeConfig({ auth: { mode: "apikey", apiKey: "test" } });
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" });
    const handler = createFetchHandler({ config, auth, fetchImpl: mockUpstream() });

    const resp = await handler(new Request("http://localhost/v1/models/glm-5.2"));
    expect(resp.status).toBe(200);
    const body = await resp.json() as { id: string };
    expect(body.id).toBe("glm-5.2");
  });

  it("GET /v1/models/glm-5.2/info returns Codex metadata", async () => {
    const config = makeConfig({ auth: { mode: "apikey", apiKey: "test" } });
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" });
    const handler = createFetchHandler({ config, auth, fetchImpl: mockUpstream() });

    const resp = await handler(new Request("http://localhost/v1/models/glm-5.2/info"));
    expect(resp.status).toBe(200);
    const body = await resp.json() as { id: string; supportedReasoningEfforts: unknown[] };
    expect(body.id).toBe("glm-5.2");
    expect(body.supportedReasoningEfforts.length).toBe(5);
  });

  it("POST /responses is routed (not 404)", async () => {
    const config = makeConfig({
      auth: { mode: "apikey", apiKey: "test" },
      plan: "start-plan",
      pool: { enabled: false, maxAccountAttempts: 5 },
    });
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" });
    const handler = createFetchHandler({
      config,
      auth,
      fetchImpl: async (req: Request) => {
        if (req.url.includes("/v1/messages")) {
          const sse = [
            "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"m1\",\"usage\":{\"input_tokens\":1}}}\n\n",
            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hi\"}}\n\n",
            "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
          ].join("");
          return new Response(sse, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response("{}", { status: 404 });
      },
    });

    const resp = await handler(new Request("http://localhost/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-5.2", input: "hello" }),
    }));
    expect(resp.status).not.toBe(404);
  });
});
