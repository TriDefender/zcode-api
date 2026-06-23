/**
 * Tests for upstream request builder and proxy handler.
 * @see .omo/plans/zcode-proxy.md Task 6
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { buildUpstreamRequest, buildUpstreamURL, buildAuthHeaders } from "./upstream.js";
import { proxyRequest, errorResponse } from "./handler.js";
import { ZAI_PROVIDER, BIGMODEL_PROVIDER } from "../provider/providers.js";
import type { Credential } from "../auth/types.js";
import type { ProxyConfig, ProxyIdentity } from "../config/types.js";
import { AuthManager } from "../auth/manager.js";

const ZAI_CRED: Credential = { apiKey: "testkey", secret: "testsecret", provider: "zai" };
const BIGMODEL_CRED: Credential = { apiKey: "bmkey", provider: "bigmodel" };

const IDENTITY: ProxyIdentity = {
  appVersion: "test-1.0.0",
  sourceTitle: "cli",
  refererOrigin: "https://zcode.z.ai",
};

function makeClientReq(body: string, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:8080/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

describe("buildUpstreamURL", () => {
  it("builds Anthropic URL for Z.AI", () => {
    expect(buildUpstreamURL("anthropic", ZAI_PROVIDER)).toBe(
      "https://api.z.ai/api/anthropic/v1/messages",
    );
  });

  it("builds OpenAI URL for Z.AI", () => {
    expect(buildUpstreamURL("openai", ZAI_PROVIDER)).toBe(
      "https://api.z.ai/api/coding/paas/v4/chat/completions",
    );
  });

  it("builds Anthropic URL for Bigmodel", () => {
    expect(buildUpstreamURL("anthropic", BIGMODEL_PROVIDER)).toBe(
      "https://open.bigmodel.cn/api/anthropic/v1/messages",
    );
  });

  it("builds OpenAI URL for Bigmodel", () => {
    expect(buildUpstreamURL("openai", BIGMODEL_PROVIDER)).toBe(
      "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
    );
  });

  it("selects Anthropic upstream URL independent of client route (translation mode)", () => {
    expect(buildUpstreamURL("anthropic", ZAI_PROVIDER)).toBe(
      "https://api.z.ai/api/anthropic/v1/messages",
    );
    expect(buildUpstreamURL("anthropic", BIGMODEL_PROVIDER)).toBe(
      "https://open.bigmodel.cn/api/anthropic/v1/messages",
    );
  });
});

describe("buildAuthHeaders", () => {
  it("injects x-api-key + anthropic-version for Anthropic", () => {
    const h = buildAuthHeaders("anthropic", ZAI_CRED, IDENTITY);
    expect(h["x-api-key"]).toBe("testkey.testsecret");
    expect(h["anthropic-version"]).toBe("2023-06-01");
  });

  it("injects Authorization Bearer for OpenAI", () => {
    const h = buildAuthHeaders("openai", ZAI_CRED, IDENTITY);
    expect(h["authorization"]).toBe("Bearer testkey.testsecret");
  });

  it("uses apiKey only (no secret) for Bigmodel Anthropic", () => {
    const h = buildAuthHeaders("anthropic", BIGMODEL_CRED, IDENTITY);
    expect(h["x-api-key"]).toBe("bmkey");
    expect(h["anthropic-version"]).toBe("2023-06-01");
  });

  it("uses apiKey only for Bigmodel OpenAI", () => {
    const h = buildAuthHeaders("openai", BIGMODEL_CRED, IDENTITY);
    expect(h["authorization"]).toBe("Bearer bmkey");
  });

  it("injects ZCode identity headers (User-Agent + companions)", () => {
    const h = buildAuthHeaders("anthropic", ZAI_CRED, IDENTITY);
    expect(h["User-Agent"]).toBe("ZCode/test-1.0.0");
    expect(h["X-ZCode-App-Version"]).toBe("test-1.0.0");
    expect(h["X-Title"]).toBe("Z Code@cli");
    expect(h["X-ZCode-Agent"]).toBe("glm");
    expect(h["HTTP-Referer"]).toBe("https://zcode.z.ai");
  });

  it("generates unique x-session-id per call (no shared singleton)", () => {
    const h1 = buildAuthHeaders("openai", ZAI_CRED, IDENTITY);
    const h2 = buildAuthHeaders("openai", ZAI_CRED, IDENTITY);
    expect(h1["x-session-id"]).toBeTruthy();
    expect(h2["x-session-id"]).toBeTruthy();
    expect(h1["x-session-id"]).not.toBe(h2["x-session-id"]);
  });

  it("generates unique x-request-id and x-zcode-trace-id per call", () => {
    const h1 = buildAuthHeaders("openai", ZAI_CRED, IDENTITY);
    const h2 = buildAuthHeaders("openai", ZAI_CRED, IDENTITY);
    expect(h1["x-request-id"]).not.toBe(h2["x-request-id"]);
    expect(h1["x-zcode-trace-id"]).not.toBe(h2["x-zcode-trace-id"]);
    expect(h1["x-query-id"]).not.toBe(h2["x-query-id"]);
  });
});

describe("buildUpstreamRequest", () => {
  it("constructs full Anthropic request with correct URL + headers", async () => {
    const clientReq = makeClientReq('{"model":"glm-4.6","messages":[]}');
    const upstream = buildUpstreamRequest(clientReq, "anthropic", ZAI_PROVIDER, ZAI_CRED, '{"model":"glm-4.6","messages":[]}', IDENTITY);

    expect(upstream.url).toBe("https://api.z.ai/api/anthropic/v1/messages");
    expect(upstream.method).toBe("POST");
    expect(upstream.headers.get("x-api-key")).toBe("testkey.testsecret");
    expect(upstream.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(upstream.headers.get("content-type")).toBe("application/json");
    expect(upstream.headers.get("user-agent")).toBe("ZCode/test-1.0.0");

    const body = await upstream.text();
    expect(body).toBe('{"model":"glm-4.6","messages":[]}');
  });

  it("constructs full OpenAI request with correct URL + headers", async () => {
    const clientReq = makeClientReq('{"model":"glm-4.6","messages":[]}');
    const upstream = buildUpstreamRequest(clientReq, "openai", BIGMODEL_PROVIDER, BIGMODEL_CRED, '{"model":"glm-4.6","messages":[]}', IDENTITY);

    expect(upstream.url).toBe("https://open.bigmodel.cn/api/coding/paas/v4/chat/completions");
    expect(upstream.headers.get("authorization")).toBe("Bearer bmkey");
    expect(upstream.headers.get("content-type")).toBe("application/json");
  });

  it("preserves anthropic-beta header from client", () => {
    const clientReq = makeClientReq("{}", { "anthropic-beta": "prompt-caching-2024-07-31" });
    const upstream = buildUpstreamRequest(clientReq, "anthropic", ZAI_PROVIDER, ZAI_CRED, "{}", IDENTITY);
    expect(upstream.headers.get("anthropic-beta")).toBe("prompt-caching-2024-07-31");
  });

  it("strips client Authorization header (prevents credential leak)", () => {
    const clientReq = makeClientReq("{}", { authorization: "Bearer client-token" });
    const upstream = buildUpstreamRequest(clientReq, "anthropic", ZAI_PROVIDER, ZAI_CRED, "{}", IDENTITY);
    // Auth should be the injected credential, NOT the client's
    expect(upstream.headers.get("x-api-key")).toBe("testkey.testsecret");
    expect(upstream.headers.get("authorization")).toBeNull();
  });

  it("strips client x-api-key header", () => {
    const clientReq = makeClientReq("{}", { "x-api-key": "client-key" });
    const upstream = buildUpstreamRequest(clientReq, "openai", ZAI_PROVIDER, ZAI_CRED, "{}", IDENTITY);
    // For OpenAI format, auth goes in Authorization header; client's x-api-key should be stripped
    expect(upstream.headers.get("authorization")).toBe("Bearer testkey.testsecret");
    expect(upstream.headers.get("x-api-key")).toBeNull();
  });
});

describe("proxyRequest", () => {
  const testConfig: ProxyConfig = {
    server: { port: 8080, host: "0.0.0.0" },
    auth: { mode: "apikey", apiKey: "testkey.testsecret" },
    provider: "zai",
    plan: "coding-plan",
    providers: {
      zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
      bigmodel: { anthropicBase: "https://open.bigmodel.cn/api/anthropic", openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
    },
    defaultModel: "glm-4.6",
    models: ["glm-4.6"],
    identity: IDENTITY,
    logging: { level: "info" },
  };

  it("forwards request to upstream with injected auth", async () => {
    const fetchMock = mock(async (req: Request): Promise<Response> => {
      expect(req.url).toBe("https://api.z.ai/api/anthropic/v1/messages");
      expect(req.headers.get("x-api-key")).toBe("testkey.testsecret");
      expect(req.headers.get("anthropic-version")).toBe("2023-06-01");
      return new Response('{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"text","text":"Hello"}],"model":"glm-4.6","stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":5}}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeClientReq('{"model":"glm-4.6","messages":[{"role":"user","content":"Hi"}]}');

    const resp = await proxyRequest(clientReq, "anthropic", { config: testConfig, auth, fetchImpl: fetchMock as any });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.content[0].text).toBe("Hello");
  });

  it("streams response body through unchanged", async () => {
    const sseBody = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");

    const fetchMock = mock(async (): Promise<Response> => {
      return new Response(sseBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeClientReq('{"model":"glm-4.6","messages":[],"stream":true}');

    const resp = await proxyRequest(clientReq, "anthropic", { config: testConfig, auth, fetchImpl: fetchMock as any });

    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("text/event-stream");

    const text = await resp.text();
    expect(text).toContain("message_start");
    expect(text).toContain("text_delta");
    expect(text).toContain("message_stop");
  });

  it("forwards content-encoding from upstream response (decompress: false passthrough)", async () => {
    const fetchMock = mock(async (_req: Request, init?: RequestInit & { decompress?: boolean }): Promise<Response> => {
      expect(init?.decompress).toBe(false);
      return new Response('{"id":"msg_1","content":[{"text":"Hello"}]}', {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-encoding": "gzip",
        },
      });
    });

    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeClientReq('{"model":"glm-4.6","messages":[]}');

    const resp = await proxyRequest(clientReq, "anthropic", { config: testConfig, auth, fetchImpl: fetchMock as any });

    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("application/json");
    expect(resp.headers.get("content-encoding")).toBe("gzip");
  });

  it("returns 502 when upstream is unreachable", async () => {
    const fetchMock = mock(async (): Promise<Response> => {
      throw new Error("ECONNREFUSED");
    });

    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeClientReq('{"model":"glm-4.6","messages":[]}');

    const resp = await proxyRequest(clientReq, "anthropic", { config: testConfig, auth, fetchImpl: fetchMock as any });

    expect(resp.status).toBe(502);
    const body = await resp.json();
    expect(body.error.type).toBe("upstream_unreachable");
    expect(body.error.message).toContain("ECONNREFUSED");
  });

  it("returns 503 when credential unavailable", async () => {
    const fetchMock = mock(async (): Promise<Response> => new Response("ok"));

    const auth = new AuthManager({ mode: "oauth", provider: "zai" });
    const clientReq = makeClientReq('{"model":"glm-4.6","messages":[]}');

    const resp = await proxyRequest(clientReq, "anthropic", { config: testConfig, auth, fetchImpl: fetchMock as any });

    expect(resp.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    const body = await resp.json();
    expect(body.error.type).toBe("credential_unavailable");
  });

  it("forwards upstream error status codes", async () => {
    const fetchMock = mock(async (): Promise<Response> => {
      return new Response('{"error":{"type":"invalid_request_error","message":"bad model"}}', {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    });

    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeClientReq('{"model":"bad-model","messages":[]}');

    const resp = await proxyRequest(clientReq, "anthropic", { config: testConfig, auth, fetchImpl: fetchMock as any });

    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error.type).toBe("invalid_request_error");
  });
});

describe("proxyRequest — OpenAI translation mode (coding-plan)", () => {
  const testConfig: ProxyConfig = {
    server: { port: 8080, host: "0.0.0.0" },
    auth: { mode: "apikey", apiKey: "testkey.testsecret" },
    provider: "zai",
    plan: "coding-plan",
    providers: {
      zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
      bigmodel: { anthropicBase: "https://open.bigmodel.cn/api/anthropic", openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
    },
    defaultModel: "glm-4.6",
    models: ["glm-4.6"],
    identity: IDENTITY,
    logging: { level: "info" },
  };

  function makeOpenAIReq(body: string, headers: Record<string, string> = {}): Request {
    return new Request("http://localhost:8080/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
  }

  const ANTHROPIC_RESPONSE = JSON.stringify({
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "Translated hello" }],
    model: "glm-4.6",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 3 },
  });

  it("routes OpenAI request to Anthropic upstream endpoint", async () => {
    const fetchMock = mock(async (req: Request): Promise<Response> => {
      expect(req.url).toBe("https://api.z.ai/api/anthropic/v1/messages");
      return new Response(ANTHROPIC_RESPONSE, { status: 200, headers: { "content-type": "application/json" } });
    });

    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[{"role":"user","content":"Hi"}]}');

    await proxyRequest(clientReq, "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses x-api-key + anthropic-version on translated upstream request", async () => {
    const fetchMock = mock(async (req: Request): Promise<Response> => {
      expect(req.headers.get("x-api-key")).toBe("testkey.testsecret");
      expect(req.headers.get("anthropic-version")).toBe("2023-06-01");
      expect(req.headers.get("authorization")).toBeNull();
      return new Response(ANTHROPIC_RESPONSE, { status: 200, headers: { "content-type": "application/json" } });
    });

    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[{"role":"user","content":"Hi"}]}');

    await proxyRequest(clientReq, "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
  });

  it("sends translated Anthropic request body upstream (not OpenAI body)", async () => {
    const fetchMock = mock(async (req: Request): Promise<Response> => {
      const body = await req.text();
      const parsed = JSON.parse(body);
      expect(parsed.messages).toBeDefined();
      expect(parsed.max_tokens).toBe(4096);
      expect(parsed.messages[0].role).toBe("user");
      expect(Array.isArray(parsed.choices)).toBe(false);
      return new Response(ANTHROPIC_RESPONSE, { status: 200, headers: { "content-type": "application/json" } });
    });

    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[{"role":"user","content":"Hi"}]}');

    await proxyRequest(clientReq, "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
  });

  it("translates batch Anthropic response back to OpenAI format", async () => {
    const fetchMock = mock(async (): Promise<Response> => {
      return new Response(ANTHROPIC_RESPONSE, { status: 200, headers: { "content-type": "application/json" } });
    });

    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[{"role":"user","content":"Hi"}]}');

    const resp = await proxyRequest(clientReq, "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("application/json");
    expect(resp.headers.get("content-encoding")).toBeNull();
    const body = await resp.json();
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toBe("Translated hello");
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.usage.total_tokens).toBe(13);
  });

  it("returns gzip-encoded response when client sends accept-encoding: gzip", async () => {
    const fetchMock = mock(async (): Promise<Response> => {
      return new Response(ANTHROPIC_RESPONSE, { status: 200, headers: { "content-type": "application/json" } });
    });

    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[]}', { "accept-encoding": "gzip" });

    const resp = await proxyRequest(clientReq, "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
    expect(resp.headers.get("content-encoding")).toBe("gzip");
    const decompressed = Bun.gunzipSync(new Uint8Array(await resp.arrayBuffer()));
    const body = JSON.parse(new TextDecoder().decode(decompressed));
    expect(body.object).toBe("chat.completion");
  });

  it("translates SSE stream from Anthropic format to OpenAI format", async () => {
    const sseBody = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"glm-4.6","usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");

    const fetchMock = mock(async (): Promise<Response> => {
      return new Response(sseBody, { status: 200, headers: { "content-type": "text/event-stream" } });
    });

    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[],"stream":true}');

    const resp = await proxyRequest(clientReq, "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("text/event-stream");

    const text = await resp.text();
    expect(text).toContain("chat.completion.chunk");
    expect(text).toContain('"content":"Hello"');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toContain("data: [DONE]");
    expect(text).not.toContain("message_start");
    expect(text).not.toContain("text_delta");
    expect(text).toContain('"prompt_tokens":10');
    expect(text).toContain('"completion_tokens":5');
    expect(text).toContain('"total_tokens":15');
  });

  it("forwards x-request-id + anthropic ratelimit headers in translated batch response", async () => {
    const fetchMock = mock(async (): Promise<Response> => {
      return new Response(ANTHROPIC_RESPONSE, {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-request-id": "req_abc123",
          "anthropic-ratelimit-requests-remaining": "99",
          "anthropic-ratelimit-tokens-reset": "2025-01-01T00:00:00Z",
        },
      });
    });

    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[]}');

    const resp = await proxyRequest(clientReq, "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
    expect(resp.headers.get("x-request-id")).toBe("req_abc123");
    expect(resp.headers.get("anthropic-ratelimit-requests-remaining")).toBe("99");
    expect(resp.headers.get("anthropic-ratelimit-tokens-reset")).toBe("2025-01-01T00:00:00Z");
  });

  it("accepts gzip when client sends accept-encoding: gzip;q=0.5 (fractional q-value)", async () => {
    const fetchMock = mock(async (): Promise<Response> => {
      return new Response(ANTHROPIC_RESPONSE, { status: 200, headers: { "content-type": "application/json" } });
    });

    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[]}', { "accept-encoding": "gzip;q=0.5" });

    const resp = await proxyRequest(clientReq, "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
    expect(resp.headers.get("content-encoding")).toBe("gzip");
  });

  it("rejects gzip when client sends accept-encoding: gzip;q=0 (explicitly disabled)", async () => {
    const fetchMock = mock(async (): Promise<Response> => {
      return new Response(ANTHROPIC_RESPONSE, { status: 200, headers: { "content-type": "application/json" } });
    });

    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[]}', { "accept-encoding": "gzip;q=0" });

    const resp = await proxyRequest(clientReq, "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
    expect(resp.headers.get("content-encoding")).toBeNull();
  });

  it("returns 400 translation_failed when OpenAI request body is malformed JSON", async () => {
    const fetchMock = mock(async (): Promise<Response> => new Response("ok"));
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeOpenAIReq("not json");

    const resp = await proxyRequest(clientReq, "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
    expect(resp.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    const body = await resp.json();
    expect(body.error.type).toBe("translation_failed");
  });

  it("returns 502 translation_failed when upstream returns non-JSON in translation mode", async () => {
    const fetchMock = mock(async (): Promise<Response> => {
      return new Response("not json", { status: 200, headers: { "content-type": "application/json" } });
    });
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[]}');

    const resp = await proxyRequest(clientReq, "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
    expect(resp.status).toBe(502);
    const body = await resp.json();
    expect(body.error.type).toBe("translation_failed");
  });

  it("returns 502 translation_failed when upstream returns non-2xx in translation mode", async () => {
    const fetchMock = mock(async (): Promise<Response> => {
      return new Response('{"error":"bad request"}', { status: 400, headers: { "content-type": "application/json" } });
    });
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[]}');

    const resp = await proxyRequest(clientReq, "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
    expect(resp.status).toBe(502);
    const body = await resp.json();
    expect(body.error.type).toBe("translation_failed");
  });
});

describe("proxyRequest — regression: Anthropic passthrough unchanged", () => {
  const testConfig: ProxyConfig = {
    server: { port: 8080, host: "0.0.0.0" },
    auth: { mode: "apikey", apiKey: "testkey.testsecret" },
    provider: "zai",
    plan: "coding-plan",
    providers: {
      zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
      bigmodel: { anthropicBase: "https://open.bigmodel.cn/api/anthropic", openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
    },
    defaultModel: "glm-4.6",
    models: ["glm-4.6"],
    identity: IDENTITY,
    logging: { level: "info" },
  };

  it("Anthropic client request uses decompress:false passthrough", async () => {
    const fetchMock = mock(async (_req: Request, init?: RequestInit & { decompress?: boolean }): Promise<Response> => {
      expect(init?.decompress).toBe(false);
      return new Response('{"id":"msg_1","content":[{"type":"text","text":"Hi"}]}', {
        status: 200,
        headers: { "content-type": "application/json", "content-encoding": "gzip" },
      });
    });

    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeClientReq('{"model":"glm-4.6","messages":[]}');

    const resp = await proxyRequest(clientReq, "anthropic", { config: testConfig, auth, fetchImpl: fetchMock as any });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-encoding")).toBe("gzip");
  });

  it("start-plan OpenAI request translates through zcode.z.ai gateway", async () => {
    const startPlanConfig: ProxyConfig = {
      ...testConfig,
      plan: "start-plan",
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (req: Request | string): Promise<Response> => {
      const url = typeof req === "string" ? req : req.url;
      if (url.includes("/client/configs")) {
        return new Response(JSON.stringify({ data: { configs: { captcha: { enabled: false } } } }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected global fetch in test: ${url}`);
    }) as typeof fetch;

    try {
      const fetchMock = mock(async (req: Request): Promise<Response> => {
        expect(req.url).toBe("https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages");
        expect(req.headers.get("authorization")).toBe("Bearer jwt-mock");
        const reqBody = JSON.parse(await req.text());
        expect(reqBody.messages).toBeDefined();
        expect(reqBody.max_tokens).toBe(4096);
        return new Response(JSON.stringify({
          id: "msg_sp",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "start-plan reply" }],
          model: "glm-4.6",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 3 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      });

      const auth = new AuthManager({ mode: "oauth", provider: "zai" });
      auth.setOAuthCredential({ apiKey: "dummy", provider: "zai", jwt: "jwt-mock" });
      const clientReq = new Request("http://localhost:8080/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"model":"glm-4.6","messages":[{"role":"user","content":"hi"}]}',
      });

      const resp = await proxyRequest(clientReq, "openai", { config: startPlanConfig, auth, fetchImpl: fetchMock as any });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(resp.status).toBe(200);
      expect(resp.headers.get("content-type")).toBe("application/json");
      const body = await resp.json();
      expect(body.object).toBe("chat.completion");
      expect(body.choices[0].message.content).toBe("start-plan reply");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("proxyRequest — tool-call roundtrip (OpenAI client through Anthropic upstream)", () => {
  const testConfig: ProxyConfig = {
    server: { port: 8080, host: "0.0.0.0" },
    auth: { mode: "apikey", apiKey: "testkey.testsecret" },
    provider: "zai",
    plan: "coding-plan",
    providers: {
      zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
      bigmodel: { anthropicBase: "https://open.bigmodel.cn/api/anthropic", openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
    },
    defaultModel: "glm-4.6",
    models: ["glm-4.6"],
    identity: IDENTITY,
    logging: { level: "info" },
  };

  function makeOpenAIReq(body: string): Request {
    return new Request("http://localhost:8080/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  }

  it("translates a full OpenAI tool-call roundtrip to Anthropic tool_use + tool_result", async () => {
    let upstreamBody2: string | undefined;
    const fetchMock = mock(async (req: Request): Promise<Response> => {
      const bodyText = await req.text();
      const parsed = JSON.parse(bodyText) as { messages: Array<{ role: string; content: unknown }> };

      const hasToolResultInHistory = parsed.messages.some(
        (m) => Array.isArray(m.content) && m.content.some((b: any) => b?.type === "tool_result"),
      );

      if (!hasToolResultInHistory) {
        return new Response(JSON.stringify({
          id: "msg_tool_1",
          type: "message",
          role: "assistant",
          content: [
            { type: "text", text: "Let me check." },
            { type: "tool_use", id: "toolu_xyz", name: "get_weather", input: { city: "SF" } },
          ],
          model: "glm-4.6",
          stop_reason: "tool_use",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 8 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }

      upstreamBody2 = bodyText;
      return new Response(JSON.stringify({
        id: "msg_final",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "It's 62°F in SF." }],
        model: "glm-4.6",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 25, output_tokens: 6 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });

    const req1Body = JSON.stringify({
      model: "glm-4.6",
      messages: [{ role: "user", content: "What's the weather in SF?" }],
      tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } } } } }],
      tool_choice: "auto",
    });
    const resp1 = await proxyRequest(makeOpenAIReq(req1Body), "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
    expect(resp1.status).toBe(200);
    const resp1Body = await resp1.json();
    expect(resp1Body.choices[0].finish_reason).toBe("tool_calls");
    const toolCall = resp1Body.choices[0].message.tool_calls?.[0];
    expect(toolCall).toBeDefined();
    expect(toolCall.id).toBe("toolu_xyz");
    expect(toolCall.function.name).toBe("get_weather");
    expect(JSON.parse(toolCall.function.arguments)).toEqual({ city: "SF" });

    const req2Body = JSON.stringify({
      model: "glm-4.6",
      messages: [
        { role: "user", content: "What's the weather in SF?" },
        { role: "assistant", content: null, tool_calls: [toolCall] },
        { role: "tool", tool_call_id: toolCall.id, content: "62°F and sunny" },
      ],
      tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } } } } }],
    });
    const resp2 = await proxyRequest(makeOpenAIReq(req2Body), "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
    expect(resp2.status).toBe(200);
    const resp2Body = await resp2.json();
    expect(resp2Body.choices[0].message.content).toBe("It's 62°F in SF.");
    expect(resp2Body.choices[0].finish_reason).toBe("stop");

    expect(upstreamBody2).toBeDefined();
    const upstreamReq = JSON.parse(upstreamBody2!);
    expect(upstreamReq.messages).toHaveLength(3);
    expect(upstreamReq.messages[0].role).toBe("user");
    expect(upstreamReq.messages[1].role).toBe("assistant");
    const assistantBlocks = upstreamReq.messages[1].content;
    expect(Array.isArray(assistantBlocks)).toBe(true);
    const toolUseBlock = assistantBlocks.find((b: any) => b.type === "tool_use");
    expect(toolUseBlock).toMatchObject({ id: "toolu_xyz", name: "get_weather", input: { city: "SF" } });

    expect(upstreamReq.messages[2].role).toBe("user");
    const userBlocks = upstreamReq.messages[2].content;
    expect(Array.isArray(userBlocks)).toBe(true);
    const toolResultBlock = userBlocks.find((b: any) => b.type === "tool_result");
    expect(toolResultBlock).toMatchObject({ tool_use_id: "toolu_xyz", content: "62°F and sunny" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("coalesces parallel tool results into one Anthropic user message at the upstream", async () => {
    let upstreamBody: string | undefined;
    const fetchMock = mock(async (req: Request): Promise<Response> => {
      upstreamBody = await req.text();
      return new Response(JSON.stringify({
        id: "msg_done",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        model: "glm-4.6",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });

    const body = JSON.stringify({
      model: "glm-4.6",
      messages: [
        { role: "user", content: "weather in SF and NYC" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_a", type: "function", function: { name: "w", arguments: '{"city":"SF"}' } },
            { id: "call_b", type: "function", function: { name: "w", arguments: '{"city":"NYC"}' } },
          ],
        },
        { role: "tool", tool_call_id: "call_a", content: "62°F" },
        { role: "tool", tool_call_id: "call_b", content: "58°F" },
      ],
    });

    const resp = await proxyRequest(makeOpenAIReq(body), "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
    expect(resp.status).toBe(200);

    const upstreamReq = JSON.parse(upstreamBody!);
    expect(upstreamReq.messages).toHaveLength(3);
    expect(upstreamReq.messages[2].role).toBe("user");
    const blocks = upstreamReq.messages[2].content;
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: "tool_result", tool_use_id: "call_a", content: "62°F" });
    expect(blocks[1]).toMatchObject({ type: "tool_result", tool_use_id: "call_b", content: "58°F" });
  });
});

describe("errorResponse", () => {
  it("builds JSON error with correct status", () => {
    const resp = errorResponse(401, "auth_error", "Invalid API key");
    expect(resp.status).toBe(401);
    expect(resp.headers.get("content-type")).toBe("application/json");
  });
});
