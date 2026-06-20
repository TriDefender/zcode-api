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

  it("builds start-plan URL on zcode.z.ai", () => {
    expect(buildUpstreamURL("anthropic", ZAI_PROVIDER, "start-plan")).toBe(
      "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages",
    );
  });

  it("builds OpenAI URL for Bigmodel", () => {
    expect(buildUpstreamURL("openai", BIGMODEL_PROVIDER)).toBe(
      "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
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

  it("uses Bearer JWT for start-plan (no x-api-key, no anthropic-version)", () => {
    const cred: Credential = { apiKey: "unused", provider: "zai", jwt: "eyJ.test.jwt" };
    const h = buildAuthHeaders("anthropic", cred, IDENTITY, "start-plan");
    expect(h.authorization).toBe("Bearer eyJ.test.jwt");
    expect(h["x-api-key"]).toBeUndefined();
    expect(h["anthropic-version"]).toBeUndefined();
  });

  it("throws when start-plan has no JWT", () => {
    const cred: Credential = { apiKey: "k", provider: "zai" };
    expect(() => buildAuthHeaders("anthropic", cred, IDENTITY, "start-plan")).toThrow(/JWT/);
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

describe("errorResponse", () => {
  it("builds JSON error with correct status", () => {
    const resp = errorResponse(401, "auth_error", "Invalid API key");
    expect(resp.status).toBe(401);
    expect(resp.headers.get("content-type")).toBe("application/json");
  });
});
