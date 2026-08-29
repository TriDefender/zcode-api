/**
 * Tests for upstream request builder and proxy handler.
 * @see .omo/plans/zcode-proxy.md Task 6
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { gzipSync } from "node:zlib";
import { createServer } from "node:net";
import { buildUpstreamRequest, buildUpstreamHeaderPairs, buildUpstreamURL, buildAuthHeaders } from "./upstream.js";
import { sendOrderedUpstreamRequest } from "./ordered-transport.js";
import { buildZcodeTraceHeaders } from "./trace-headers.js";
import { proxyRequest, errorResponse, shouldUseOrderedTransport, stripAutoDecodedEncoding } from "./handler.js";
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

async function captureOrderedRequest(headers: Array<[string, string]>): Promise<{ raw: string; response: Response }> {
  let resolveRaw!: (raw: string) => void;
  const rawPromise = new Promise<string>((resolve) => { resolveRaw = resolve; });
  const server = createServer((socket) => {
    let raw = "";
    socket.on("data", (chunk) => {
      raw += chunk.toString("latin1");
      if (raw.includes("\r\n\r\n")) {
        resolveRaw(raw);
        socket.end("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\nok");
        server.close();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not expose a TCP port");

  const response = await sendOrderedUpstreamRequest({
    url: `http://127.0.0.1:${address.port}/v1/messages`,
    method: "POST",
    headers,
    body: "{}",
    decompress: false,
  });
  const raw = await rawPromise;
  return { raw, response };
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

  it("can still build direct Anthropic upstream URLs when explicitly requested", () => {
    expect(buildUpstreamURL("anthropic", ZAI_PROVIDER)).toBe(
      "https://api.z.ai/api/anthropic/v1/messages",
    );
    expect(buildUpstreamURL("anthropic", BIGMODEL_PROVIDER)).toBe(
      "https://open.bigmodel.cn/api/anthropic/v1/messages",
    );
  });
});

describe("buildZcodeTraceHeaders", () => {
  it("emits ZCode trace headers in source order and strips internal prefixes", () => {
    const h = buildZcodeTraceHeaders({
      requestId: "req_1",
      traceId: "trace_1",
      queryId: "query_turn_1",
      sessionId: "sess_thread_1",
    });

    expect(Object.keys(h)).toEqual(["x-request-id", "x-zcode-session-type", "x-zcode-trace-id", "x-query-id", "x-session-id"]);
    expect(h["x-request-id"]).toBe("req_1");
    expect(h["x-zcode-session-type"]).toBe("main");
    expect(h["x-zcode-trace-id"]).toBe("trace_1");
    expect(h["x-query-id"]).toBe("turn_1");
    expect(h["x-session-id"]).toBe("thread_1");
  });

  it("strips subagent session prefixes at emission time", () => {
    const h = buildZcodeTraceHeaders({
      requestId: "req_1",
      traceId: "trace_1",
      sessionId: "subagent_agent_worker_1",
    });

    expect(Object.keys(h)).toEqual(["x-request-id", "x-zcode-session-type", "x-zcode-trace-id", "x-session-id"]);
    expect(h["x-zcode-session-type"]).toBe("subagent");
    expect(h["x-session-id"]).toBe("worker_1");
  });

  it("omits query and session headers when no IDs exist", () => {
    const h = buildZcodeTraceHeaders({ requestId: "req_1", traceId: "trace_1" });

    expect(Object.keys(h)).toEqual(["x-request-id", "x-zcode-session-type", "x-zcode-trace-id"]);
    expect(h["x-zcode-session-type"]).toBe("main");
    expect(h["x-query-id"]).toBeUndefined();
    expect(h["x-session-id"]).toBeUndefined();
  });

  it("honors an explicit sessionType override", () => {
    const h = buildZcodeTraceHeaders({ requestId: "req_1", traceId: "trace_1", sessionType: "other" });
    expect(h["x-zcode-session-type"]).toBe("other");
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

  it("uses a stable x-session-id when an enforced client session is provided", () => {
    const session = { action: "enforce" as const, upstreamSessionId: "11111111-1111-4111-8111-111111111111" };
    const h1 = buildAuthHeaders("openai", ZAI_CRED, IDENTITY, "coding-plan", session);
    const h2 = buildAuthHeaders("openai", ZAI_CRED, IDENTITY, "coding-plan", session);

    expect(h1["x-session-id"]).toBe("11111111-1111-4111-8111-111111111111");
    expect(h2["x-session-id"]).toBe("11111111-1111-4111-8111-111111111111");
    expect(h1["x-request-id"]).not.toBe(h2["x-request-id"]);
    expect(h1["x-zcode-trace-id"]).not.toBe(h2["x-zcode-trace-id"]);
    expect(h1["x-query-id"]).toBeUndefined();
    expect(h2["x-query-id"]).toBeUndefined();
  });

  it("emits explicit enforced trace headers in ZCode/auth order", () => {
    const session = {
      source: "explicit" as const,
      action: "enforce" as const,
      requestId: "req_1",
      traceId: "trace_1",
      queryId: "query_turn_1",
      upstreamSessionId: "sess_thread_1",
    };
    const h = buildAuthHeaders("anthropic", ZAI_CRED, IDENTITY, "coding-plan", session);

    expect(Object.keys(h)).toEqual([
      "HTTP-Referer",
      "User-Agent",
      "X-ZCode-App-Version",
      "X-Title",
      "X-ZCode-Agent",
      "X-Platform",
      "X-Release-Channel",
      "X-Client-Language",
      "X-Client-Timezone",
      "X-Os-Category",
      "X-Os-Version",
      "x-request-id",
      "x-zcode-session-type",
      "x-zcode-trace-id",
      "x-query-id",
      "x-session-id",
      "x-api-key",
      "anthropic-version",
    ]);
    expect(h["x-request-id"]).toBe("req_1");
    expect(h["x-zcode-session-type"]).toBe("main");
    expect(h["x-zcode-trace-id"]).toBe("trace_1");
    expect(h["x-query-id"]).toBe("turn_1");
    expect(h["x-session-id"]).toBe("thread_1");
  });
  it("does not stabilize x-session-id for observe-only client sessions", () => {
    const session = { action: "observe" as const, upstreamSessionId: "11111111-1111-4111-8111-111111111111" };
    const h1 = buildAuthHeaders("openai", ZAI_CRED, IDENTITY, "coding-plan", session);
    const h2 = buildAuthHeaders("openai", ZAI_CRED, IDENTITY, "coding-plan", session);

    expect(h1["x-session-id"]).toBeTruthy();
    expect(h2["x-session-id"]).toBeTruthy();
    expect(h1["x-session-id"]).not.toBe(h2["x-session-id"]);
  });

  it("does not synthesize start-plan query/session headers when no trace context exists", () => {
    const h = buildAuthHeaders("anthropic", { ...ZAI_CRED, jwt: "jwt-token" }, IDENTITY, "start-plan");

    expect(h["x-request-id"]).toBeTruthy();
    expect(h["x-zcode-trace-id"]).toBeTruthy();
    expect(h["x-query-id"]).toBeUndefined();
    expect(h["x-session-id"]).toBeUndefined();
  });

  it("does not forward inferred start-plan session in observe mode", () => {
    const session = {
      source: "lineage" as const,
      action: "observe" as const,
      upstreamSessionId: "11111111-1111-4111-8111-111111111111",
    };
    const h = buildAuthHeaders("openai", { ...ZAI_CRED, jwt: "jwt-token" }, IDENTITY, "start-plan", session);

    expect(h["x-request-id"]).toBeTruthy();
    expect(h["x-zcode-trace-id"]).toBeTruthy();
    expect(h["x-session-id"]).toBeUndefined();
  });

  it("forwards inferred start-plan session in enforce mode", () => {
    const session = {
      source: "lineage" as const,
      action: "enforce" as const,
      upstreamSessionId: "11111111-1111-4111-8111-111111111111",
    };
    const h = buildAuthHeaders("openai", { ...ZAI_CRED, jwt: "jwt-token" }, IDENTITY, "start-plan", session);

    expect(h["x-session-id"]).toBe("11111111-1111-4111-8111-111111111111");
  });
});

describe("sendOrderedUpstreamRequest", () => {
  it("writes application headers in the supplied wire order", async () => {
    const headers: Array<[string, string]> = [
      ["content-type", "application/json"],
      ["accept-encoding", "gzip"],
      ["HTTP-Referer", "https://zcode.z.ai"],
      ["User-Agent", "ZCode/test-1.0.0"],
      ["X-ZCode-App-Version", "test-1.0.0"],
      ["X-Title", "Z Code@cli"],
      ["X-ZCode-Agent", "glm"],
      ["x-request-id", "req_1"],
      ["x-zcode-trace-id", "trace_1"],
      ["x-query-id", "turn_1"],
      ["x-session-id", "thread_1"],
      ["x-api-key", "testkey.testsecret"],
      ["anthropic-version", "2023-06-01"],
    ];

    const { raw, response } = await captureOrderedRequest(headers);
    const requestHeaders = raw.split("\r\n\r\n")[0].split("\r\n").slice(1);
    const appHeaders = requestHeaders.filter((line) => !/^(Host|Content-Length|Connection):/i.test(line));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(appHeaders).toEqual(headers.map(([k, v]) => `${k}: ${v}`));
  });

  it("rejects invalid header names and CRLF header values before writing", async () => {
    await expect(sendOrderedUpstreamRequest({
      url: "http://127.0.0.1:9/v1/messages",
      method: "POST",
      headers: [["x-request-id", "req_1\r\nx-extra: injected"]],
      body: "{}",
    })).rejects.toThrow(/Invalid upstream header value/);

    await expect(sendOrderedUpstreamRequest({
      url: "http://127.0.0.1:9/v1/messages",
      method: "POST",
      headers: [["bad header", "value"]],
      body: "{}",
    })).rejects.toThrow(/Invalid upstream header name/);
  });
});
describe("buildUpstreamHeaderPairs — accept-encoding forwarding", () => {
  it("forwards the client's accept-encoding when present (e.g. identity)", () => {
    const req = makeClientReq("{}", { "accept-encoding": "identity" });
    const pairs = buildUpstreamHeaderPairs(req, "openai", ZAI_CRED, IDENTITY);
    const ae = pairs.find(([k]) => k === "accept-encoding");
    expect(ae?.[1]).toBe("identity");
  });

  it("defaults to gzip when the client sent no accept-encoding", () => {
    const req = makeClientReq("{}");
    const pairs = buildUpstreamHeaderPairs(req, "openai", ZAI_CRED, IDENTITY);
    const ae = pairs.find(([k]) => k === "accept-encoding");
    expect(ae?.[1]).toBe("gzip");
  });

  it("forwards multi-value accept-encoding verbatim", () => {
    const req = makeClientReq("{}", { "accept-encoding": "gzip, deflate, br" });
    const pairs = buildUpstreamHeaderPairs(req, "openai", ZAI_CRED, IDENTITY);
    const ae = pairs.find(([k]) => k === "accept-encoding");
    expect(ae?.[1]).toBe("gzip, deflate, br");
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
    clientIdentity: { mode: "observe", ttlSeconds: 900, maxSessions: 1024 },
    responses: { enabled: true, storeMaxEntries: 1000, storeTtlMs: 86400000 },
  endpointRouting: { enabled: false, origin: "https://zcode.z.ai" },
  clientSigning: { enabled: false, origin: "https://zcode.z.ai" },
  mcp: { enabled: true, webSearch: true, webReader: false, zread: false },
  async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },
  claim: { enabled: false, auto: true, origin: "https://zcode.z.ai", pollIntervalMs: 300000, cooldownMs: 600000, planId: "" },
  logging: { level: "info" },
  };

  it("uses ordered transport for session-aware start-plan requests only outside injected fetch tests", () => {
    const startPlanConfig: ProxyConfig = { ...testConfig, plan: "start-plan" };

    expect(shouldUseOrderedTransport(startPlanConfig, {
      source: "lineage",
      action: "observe",
      confidence: 0.95,
      upstreamSessionId: "11111111-1111-4111-8111-111111111111",
    }, false)).toBe(false);
    expect(shouldUseOrderedTransport(startPlanConfig, {
      source: "lineage",
      action: "enforce",
      confidence: 0.95,
      upstreamSessionId: "11111111-1111-4111-8111-111111111111",
    }, false)).toBe(true);
    expect(shouldUseOrderedTransport(startPlanConfig, {
      source: "explicit",
      action: "observe",
      confidence: 1,
      upstreamSessionId: "sess_thread_1",
    }, false)).toBe(true);
    expect(shouldUseOrderedTransport(startPlanConfig, {
      source: "explicit",
      action: "observe",
      confidence: 1,
      upstreamSessionId: "sess_thread_1",
    }, true)).toBe(false);
  });

  it("forwards request to the Anthropic upstream with injected auth (native passthrough)", async () => {
    const fetchMock = mock(async (req: Request): Promise<Response> => {
      expect(req.url).toBe("https://api.z.ai/api/anthropic/v1/messages");
      expect(req.headers.get("x-api-key")).toBe("testkey.testsecret");
      expect(req.headers.get("anthropic-version")).toBe("2023-06-01");
      return new Response(JSON.stringify({
        id: "msg_fwd",
        type: "message",
        role: "assistant",
        model: "glm-4.6",
        content: [{ type: "text", text: "Hello" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      }), {
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

  it("passes the Anthropic SSE stream through natively for Anthropic clients", async () => {
    const sseBody = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"glm-4.6","content":[],"usage":{"input_tokens":10,"output_tokens":1}}}',
      '',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}',
      '',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
      '',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}',
      '',
      'event: message_stop\ndata: {"type":"message_stop"}',
      '',
    ].join("\n");

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
    expect(text).toContain('"text":"Hi"');
    expect(text).toContain("message_stop");
  });

  it("passes the Anthropic batch response through with raw-decompress transport", async () => {
    const fetchMock = mock(async (_req: Request, init?: RequestInit & { decompress?: boolean }): Promise<Response> => {
      expect(init?.decompress).toBe(false);
      return new Response(JSON.stringify({
        id: "msg_fwd2",
        type: "message",
        role: "assistant",
        model: "glm-4.6",
        content: [{ type: "text", text: "Hello" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    });

    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeClientReq('{"model":"glm-4.6","messages":[]}');

    const resp = await proxyRequest(clientReq, "anthropic", { config: testConfig, auth, fetchImpl: fetchMock as any });

    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("application/json");
    expect(resp.headers.get("content-encoding")).toBeNull();
    const body = await resp.json();
    expect(body.content[0].text).toBe("Hello");
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

  it("forwards upstream error status codes through verbatim for native Anthropic clients", async () => {
    const fetchMock = mock(async (): Promise<Response> => {
      return new Response('{"type":"error","error":{"type":"invalid_request_error","message":"bad model"}}', {
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

describe("proxyRequest — OpenAI translation mode (coding-plan → Anthropic upstream)", () => {
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
    clientIdentity: { mode: "observe", ttlSeconds: 900, maxSessions: 1024 },
    responses: { enabled: true, storeMaxEntries: 1000, storeTtlMs: 86400000 },
  endpointRouting: { enabled: false, origin: "https://zcode.z.ai" },
  clientSigning: { enabled: false, origin: "https://zcode.z.ai" },
  mcp: { enabled: true, webSearch: true, webReader: false, zread: false },
  async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },
  claim: { enabled: false, auto: true, origin: "https://zcode.z.ai", pollIntervalMs: 300000, cooldownMs: 600000, planId: "" },
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
    model: "glm-4.6",
    content: [{ type: "text", text: "Anthropic hello" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 3 },
  });

  it("routes OpenAI client request to the Anthropic upstream endpoint", async () => {
    const fetchMock = mock(async (req: Request): Promise<Response> => {
      expect(req.url).toBe("https://api.z.ai/api/anthropic/v1/messages");
      return new Response(ANTHROPIC_RESPONSE, { status: 200, headers: { "content-type": "application/json" } });
    });

    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[{"role":"user","content":"Hi"}]}');

    await proxyRequest(clientReq, "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses x-api-key + anthropic-version on the Anthropic upstream request", async () => {
    const fetchMock = mock(async (req: Request): Promise<Response> => {
      expect(req.headers.get("x-api-key")).toBe("testkey.testsecret");
      expect(req.headers.get("authorization")).toBeNull();
      expect(req.headers.get("anthropic-version")).toBe("2023-06-01");
      return new Response(ANTHROPIC_RESPONSE, { status: 200, headers: { "content-type": "application/json" } });
    });

    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[{"role":"user","content":"Hi"}]}');

    await proxyRequest(clientReq, "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
  });

  it("sends a translated Anthropic body upstream (no stream_options concept)", async () => {
    const fetchMock = mock(async (req: Request): Promise<Response> => {
      const body = await req.text();
      const parsed = JSON.parse(body);
      expect(parsed.model).toBe("glm-4.6");
      expect(parsed.messages[0].role).toBe("user");
      expect(parsed.messages[0].content[0].type).toBe("text");
      expect(parsed.messages[0].content[0].text).toBe("Hi");
      expect(parsed.stream_options).toBeUndefined();
      expect(parsed.system).toBeUndefined();
      return new Response(ANTHROPIC_RESPONSE, { status: 200, headers: { "content-type": "application/json" } });
    });

    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[{"role":"user","content":"Hi"}],"stream":true}');

    await proxyRequest(clientReq, "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
  });

  it("translates the Anthropic batch response back to OpenAI shape", async () => {
    const fetchMock = mock(async (): Promise<Response> => {
      return new Response(ANTHROPIC_RESPONSE, { status: 200, headers: { "content-type": "application/json" } });
    });

    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[{"role":"user","content":"Hi"}]}');

    const resp = await proxyRequest(clientReq, "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("application/json");
    const body = await resp.json();
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toBe("Anthropic hello");
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.usage.total_tokens).toBe(13);
  });

  it("does not synthesize gzip when the client does not accept it", async () => {
    const fetchMock = mock(async (): Promise<Response> => {
      return new Response(ANTHROPIC_RESPONSE, { status: 200, headers: { "content-type": "application/json" } });
    });

    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[]}');

    const resp = await proxyRequest(clientReq, "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
    expect(resp.headers.get("content-encoding")).toBeNull();
    const body = await resp.json();
    expect(body.object).toBe("chat.completion");
  });

  it("translates the Anthropic SSE stream to OpenAI chunks", async () => {
    const sseBody = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"glm-4.6","content":[],"usage":{"input_tokens":10,"output_tokens":1}}}',
      '',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
      '',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
      '',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}',
      '',
      'event: message_stop\ndata: {"type":"message_stop"}',
      '',
    ].join("\n");

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
  });

  it("forwards selected upstream headers in the translated batch response", async () => {
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

  it("gzips the translated body when the client advertises gzip", async () => {
    const fetchMock = mock(async (): Promise<Response> => {
      return new Response(ANTHROPIC_RESPONSE, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[]}', { "accept-encoding": "gzip" });

    const resp = await proxyRequest(clientReq, "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
    expect(resp.headers.get("content-encoding")).toBe("gzip");
  });

  it("does not propagate a stale upstream gzip label to the translated client response", async () => {
    // translate mode lets the runtime inflate; the mock simulates the
    // post-inflate state (decoded body, stale label) — the label must not
    // reach the OpenAI client
    const fetchMock = mock(async (): Promise<Response> => {
      return new Response(ANTHROPIC_RESPONSE, {
        status: 200,
        headers: { "content-type": "application/json", "content-encoding": "gzip" },
      });
    });

    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[]}');

    const resp = await proxyRequest(clientReq, "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
    expect(resp.headers.get("content-encoding")).toBeNull();
    const body = await resp.json();
    expect(body.object).toBe("chat.completion");
  });

  it("returns 400 for a malformed OpenAI body without calling upstream", async () => {
    const fetchMock = mock(async (): Promise<Response> => new Response("ok"));
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeOpenAIReq("not json");

    const resp = await proxyRequest(clientReq, "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
    expect(resp.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(0);
    const body = await resp.json();
    expect(body.error.type).toBe("translation_failed");
  });

  it("returns 502 when the upstream returns a non-JSON body", async () => {
    const fetchMock = mock(async (): Promise<Response> => {
      return new Response("not json", { status: 200, headers: { "content-type": "text/plain" } });
    });
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[]}');

    const resp = await proxyRequest(clientReq, "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
    expect(resp.status).toBe(502);
    const body = await resp.json();
    expect(body.error.type).toBe("translation_failed");
  });

  it("maps upstream non-2xx to 502 translation_failed for translated clients", async () => {
    const fetchMock = mock(async (): Promise<Response> => {
      return new Response('{"type":"error","error":{"type":"invalid_request_error","message":"bad request"}}', { status: 400, headers: { "content-type": "application/json" } });
    });
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[]}');

    const resp = await proxyRequest(clientReq, "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
    expect(resp.status).toBe(502);
    const body = await resp.json();
    expect(body.error.type).toBe("translation_failed");
  });
});

describe("client gzip handling", () => {
  const ANTHROPIC_RESPONSE = JSON.stringify({
    id: "msg_gz",
    type: "message",
    role: "assistant",
    model: "glm-4.6",
    content: [{ type: "text", text: "Anthropic hello" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 8, output_tokens: 5 },
  });

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
    clientIdentity: { mode: "observe", ttlSeconds: 900, maxSessions: 1024 },
    responses: { enabled: true, storeMaxEntries: 1000, storeTtlMs: 86400000 },
  endpointRouting: { enabled: false, origin: "https://zcode.z.ai" },
  clientSigning: { enabled: false, origin: "https://zcode.z.ai" },
    mcp: { enabled: true, webSearch: true, webReader: false, zread: false },
    async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },
  claim: { enabled: false, auto: true, origin: "https://zcode.z.ai", pollIntervalMs: 300000, cooldownMs: 600000, planId: "" },
    logging: { level: "info" },
  };

  const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });

  it("stripAutoDecodedEncoding drops gzip/br labels and stale content-length", () => {
    const upstream = new Response('{"ok":true}', {
      status: 200,
      headers: { "content-type": "application/json", "content-encoding": "gzip", "content-length": "49" },
    });
    const normalized = stripAutoDecodedEncoding(upstream);
    expect(normalized).not.toBe(upstream);
    expect(normalized.status).toBe(200);
    expect(normalized.headers.get("content-encoding")).toBeNull();
    expect(normalized.headers.get("content-length")).toBeNull();
    expect(normalized.headers.get("content-type")).toBe("application/json");
  });

  it("stripAutoDecodedEncoding handles br and comma-separated coding lists", () => {
    const br = new Response("x", { status: 200, headers: { "content-encoding": "br" } });
    expect(stripAutoDecodedEncoding(br).headers.get("content-encoding")).toBeNull();

    const multi = new Response("x", { status: 201, headers: { "content-encoding": "gzip, br" } });
    const normalized = stripAutoDecodedEncoding(multi);
    expect(normalized.headers.get("content-encoding")).toBeNull();
    expect(normalized.status).toBe(201);
  });

  it("stripAutoDecodedEncoding leaves unsupported or absent encodings untouched", () => {
    const zstd = new Response("x", { status: 200, headers: { "content-encoding": "zstd" } });
    expect(stripAutoDecodedEncoding(zstd)).toBe(zstd);

    const plain = new Response("x", { status: 200 });
    expect(stripAutoDecodedEncoding(plain)).toBe(plain);
  });

  it("inflates gzip request bodies before forwarding upstream", async () => {
    const payload = '{"model":"glm-4.6","messages":[{"role":"user","content":"Hi"}]}';
    const fetchMock = mock(async (req: Request): Promise<Response> => {
      const parsed = JSON.parse(await req.text());
      expect(parsed.model).toBe("glm-4.6");
      expect(parsed.messages[0].content[0].text).toBe("Hi");
      return new Response(ANTHROPIC_RESPONSE, { status: 200, headers: { "content-type": "application/json" } });
    });

    const clientReq = new Request("http://localhost:8080/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      body: gzipSync(new TextEncoder().encode(payload)),
    });

    const resp = await proxyRequest(clientReq, "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
    expect(resp.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = await resp.json();
    expect(body.object).toBe("chat.completion");
  });

  it("returns 400 for a corrupt gzip request body without calling upstream", async () => {
    const fetchMock = mock(async (): Promise<Response> => new Response("{}"));

    const clientReq = new Request("http://localhost:8080/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      body: new Uint8Array([1, 2, 3, 4]),
    });

    const resp = await proxyRequest(clientReq, "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
    expect(resp.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(0);
    const body = await resp.json();
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("gzip");
  });

  it("returns 413 when a gzip request body inflates past the ceiling", async () => {
    const fetchMock = mock(async (): Promise<Response> => new Response("{}"));

    // 65 MiB of zeros — tiny on the wire, 1 MiB past the 64 MiB inflated cap.
    const bomb = gzipSync(Buffer.alloc(65 * 1024 * 1024));
    const clientReq = new Request("http://localhost:8080/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      body: bomb,
    });

    const resp = await proxyRequest(clientReq, "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
    expect(resp.status).toBe(413);
    expect(fetchMock).toHaveBeenCalledTimes(0);
    const body = await resp.json();
    expect(body.error.type).toBe("request_too_large");
  });

  it("forwards plain (uncompressed) request bodies translated", async () => {
    const payload = '{"model":"glm-4.6","messages":[]}';
    const fetchMock = mock(async (req: Request): Promise<Response> => {
      const parsed = JSON.parse(await req.text());
      expect(parsed.model).toBe("glm-4.6");
      expect(parsed.messages).toEqual([]);
      return new Response(ANTHROPIC_RESPONSE, { status: 200, headers: { "content-type": "application/json" } });
    });

    const clientReq = new Request("http://localhost:8080/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });

    const resp = await proxyRequest(clientReq, "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
    expect(resp.status).toBe(200);
  });
});

describe("proxyRequest — Anthropic compatibility mode (coding-plan)", () => {
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
    clientIdentity: { mode: "observe", ttlSeconds: 900, maxSessions: 1024 },
    responses: { enabled: true, storeMaxEntries: 1000, storeTtlMs: 86400000 },
  endpointRouting: { enabled: false, origin: "https://zcode.z.ai" },
  clientSigning: { enabled: false, origin: "https://zcode.z.ai" },
  mcp: { enabled: true, webSearch: true, webReader: false, zread: false },
  async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },
  claim: { enabled: false, auto: true, origin: "https://zcode.z.ai", pollIntervalMs: 300000, cooldownMs: 600000, planId: "" },
  logging: { level: "info" },
  };

  it("Anthropic client request passes through to the native Anthropic upstream", async () => {
    const fetchMock = mock(async (req: Request, init?: RequestInit & { decompress?: boolean }): Promise<Response> => {
      expect(req.url).toBe("https://api.z.ai/api/anthropic/v1/messages");
      expect(req.headers.get("x-api-key")).toBe("testkey.testsecret");
      expect(req.headers.get("anthropic-version")).toBe("2023-06-01");
      expect(init?.decompress).toBe(false);
      const reqBody = JSON.parse(await req.text());
      expect(reqBody.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }]);
      return new Response(JSON.stringify({
        id: "msg_pt",
        type: "message",
        role: "assistant",
        model: "glm-4.6",
        content: [{ type: "text", text: "Hi" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeClientReq('{"model":"glm-4.6","messages":[{"role":"user","content":"hi"}]}');

    const resp = await proxyRequest(clientReq, "anthropic", { config: testConfig, auth, fetchImpl: fetchMock as any });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.type).toBe("message");
    expect(body.content[0]).toEqual({ type: "text", text: "Hi" });
  });

  it("start-plan OpenAI request translates to the live Anthropic gateway (Bearer JWT)", async () => {
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
        expect(req.headers.get("anthropic-version")).toBe("2023-06-01");
        const reqBody = JSON.parse(await req.text());
        expect(reqBody.system[0].text).toBe("You are ZCode, an interactive coding agent");
        expect(reqBody.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }]);
        expect(reqBody.max_tokens).toBe(4096);
        return new Response(JSON.stringify({
          id: "msg_sp",
          type: "message",
          role: "assistant",
          model: "glm-4.6",
          content: [{ type: "text", text: "start-plan reply" }],
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

  it("start-plan forwards explicit ZCode trace metadata to gateway attribution headers", async () => {
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
        expect(req.headers.get("x-request-id")).toBe("req_start_1");
        expect(req.headers.get("x-zcode-trace-id")).toBe("trace_start_1");
        expect(req.headers.get("x-query-id")).toBe("start_query_1");
        expect(req.headers.get("x-session-id")).toBe("start_session_1");
        return new Response(JSON.stringify({
          id: "msg_sp",
          type: "message",
          role: "assistant",
          model: "glm-4.6",
          content: [{ type: "text", text: "start-plan reply" }],
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
        body: JSON.stringify({
          model: "glm-4.6",
          metadata: {
            requestId: "req_start_1",
            traceId: "trace_start_1",
            queryId: "query_start_query_1",
            sessionId: "sess_start_session_1",
          },
          messages: [{ role: "user", content: "hi" }],
        }),
      });

      const resp = await proxyRequest(clientReq, "openai", { config: startPlanConfig, auth, fetchImpl: fetchMock as any });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(resp.status).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("start-plan enforce reuses inferred session through the unified resolver", async () => {
    const startPlanConfig: ProxyConfig = {
      ...testConfig,
      plan: "start-plan",
      clientIdentity: { mode: "enforce", ttlSeconds: 900, maxSessions: 1024 },
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
      const seenSessions: string[] = [];
      const fetchMock = mock(async (req: Request): Promise<Response> => {
        expect(req.url).toBe("https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages");
        seenSessions.push(req.headers.get("x-session-id") ?? "");
        return new Response(JSON.stringify({
          id: "msg_sp",
          type: "message",
          role: "assistant",
          model: "glm-4.6",
          content: [{ type: "text", text: "start-plan reply" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 3 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      });

      const auth = new AuthManager({ mode: "oauth", provider: "zai" });
      auth.setOAuthCredential({ apiKey: "dummy", provider: "zai", jwt: "jwt-mock" });
      const body = '{"model":"glm-4.6","messages":[{"role":"user","content":"hi"}]}';

      const first = await proxyRequest(new Request("http://localhost:8080/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }), "openai", { config: startPlanConfig, auth, fetchImpl: fetchMock as any });
      const second = await proxyRequest(new Request("http://localhost:8080/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }), "openai", { config: startPlanConfig, auth, fetchImpl: fetchMock as any });

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(seenSessions[0]).toBeTruthy();
      expect(seenSessions[1]).toBe(seenSessions[0]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("start-plan Anthropic request passes through to the live gateway with start-plan system blocks", async () => {
    const startPlanConfig: ProxyConfig = {
      ...testConfig,
      plan: "start-plan",
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async (req: RequestInfo | URL): Promise<Response> => {
      const url = typeof req === "string" ? req : req instanceof URL ? req.toString() : req.url;
      if (url.includes("/client/configs")) {
        return new Response(JSON.stringify({ data: { configs: { captcha: { enabled: false } } } }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected global fetch in test: ${url}`);
    }, { preconnect: originalFetch.preconnect });

    try {
      const fetchMock: typeof fetch = Object.assign(async (req: RequestInfo | URL): Promise<Response> => {
        if (!(req instanceof Request)) throw new Error("expected Request");
        expect(req.url).toBe("https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages");
        expect(req.headers.get("authorization")).toBe("Bearer jwt-mock");
        const reqBody = JSON.parse(await req.text());
        expect(reqBody.system[0].text).toBe("You are ZCode, an interactive coding agent");
        expect(reqBody.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }]);
        expect(reqBody.max_tokens).toBe(1024);
        return new Response(JSON.stringify({
          id: "msg_sp",
          type: "message",
          role: "assistant",
          model: "glm-4.6",
          content: [{ type: "text", text: "start-plan reply" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 3 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }, { preconnect: originalFetch.preconnect });

      const auth = new AuthManager({ mode: "oauth", provider: "zai" });
      auth.setOAuthCredential({ apiKey: "dummy", provider: "zai", jwt: "jwt-mock" });
      const clientReq = new Request("http://localhost:8080/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"model":"glm-4.6","max_tokens":1024,"messages":[{"role":"user","content":"hi"}]}',
      });

      const resp = await proxyRequest(clientReq, "anthropic", { config: startPlanConfig, auth, fetchImpl: fetchMock });
      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body.type).toBe("message");
      expect(body.content[0].text).toBe("start-plan reply");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not re-solve captcha for a start-plan 403 without captcha challenge header", async () => {
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
      const fetchMock = mock(async (): Promise<Response> => {
        return new Response(JSON.stringify({ error: { type: "forbidden", message: "not captcha" } }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
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
      // Upstream errors are wrapped: openai→anthropic translation mode reports
      // them as 502 translation_failed (same convention as coding-plan).
      expect(resp.status).toBe(502);
      const body = await resp.json();
      expect(body.error.type).toBe("translation_failed");
      expect(body.error.message).toContain("403");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("proxyRequest — tool-call roundtrip (OpenAI client → Anthropic upstream)", () => {
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
    clientIdentity: { mode: "observe", ttlSeconds: 900, maxSessions: 1024 },
    responses: { enabled: true, storeMaxEntries: 1000, storeTtlMs: 86400000 },
  endpointRouting: { enabled: false, origin: "https://zcode.z.ai" },
  clientSigning: { enabled: false, origin: "https://zcode.z.ai" },
  mcp: { enabled: true, webSearch: true, webReader: false, zread: false },
  async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },
  claim: { enabled: false, auto: true, origin: "https://zcode.z.ai", pollIntervalMs: 300000, cooldownMs: 600000, planId: "" },
  logging: { level: "info" },
  };

  function makeOpenAIReq(body: string): Request {
    return new Request("http://localhost:8080/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  }

  it("passes a full tool-call roundtrip through the Anthropic translation layer", async () => {
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
          model: "glm-4.6",
          content: [
            { type: "text", text: "Let me check." },
            { type: "tool_use", id: "call_xyz", name: "get_weather", input: { city: "SF" } },
          ],
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
        model: "glm-4.6",
        content: [{ type: "text", text: "It's 62°F in SF." }],
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
    expect(toolCall.id).toBe("call_xyz");
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
    expect(upstreamReq.messages[1].content.some((b: any) => b.type === "tool_use" && b.id === "call_xyz")).toBeTrue();
    const toolResultMsg = upstreamReq.messages[2];
    expect(toolResultMsg.role).toBe("user");
    expect(toolResultMsg.content.some((b: any) => b.type === "tool_result" && b.tool_use_id === "call_xyz" && b.content === "62°F and sunny")).toBeTrue();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("coalesces parallel OpenAI tool results into one user tool_result message upstream", async () => {
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
    const assistantMsg = upstreamReq.messages[1];
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.content.filter((b: any) => b.type === "tool_use").map((b: any) => b.id)).toEqual(["call_a", "call_b"]);
    const toolResultMsg = upstreamReq.messages[2];
    expect(toolResultMsg.role).toBe("user");
    expect(toolResultMsg.content.filter((b: any) => b.type === "tool_result").map((b: any) => b.tool_use_id)).toEqual(["call_a", "call_b"]);
  });
});

describe("proxyRequest — thinking endpoint matrix", () => {
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
    clientIdentity: { mode: "observe", ttlSeconds: 900, maxSessions: 1024 },
    responses: { enabled: true, storeMaxEntries: 1000, storeTtlMs: 86400000 },
  endpointRouting: { enabled: false, origin: "https://zcode.z.ai" },
  clientSigning: { enabled: false, origin: "https://zcode.z.ai" },
  mcp: { enabled: true, webSearch: true, webReader: false, zread: false },
  async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },
  claim: { enabled: false, auto: true, origin: "https://zcode.z.ai", pollIntervalMs: 300000, cooldownMs: 600000, planId: "" },
  logging: { level: "info" },
  };

  function makeOpenAIReq(stream: boolean): Request {
    return new Request("http://localhost:8080/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "glm-4.6",
        messages: [{ role: "user", content: "think then answer" }],
        stream,
      }),
    });
  }

  function makeAnthropicReq(stream: boolean): Request {
    return new Request("http://localhost:8080/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "glm-4.6",
        max_tokens: 1024,
        messages: [{ role: "user", content: "think then answer" }],
        stream,
      }),
    });
  }

  function codingPlanAuth(): AuthManager {
    return new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
  }

  function startPlanAuth(): AuthManager {
    const auth = new AuthManager({ mode: "oauth", provider: "zai" });
    auth.setOAuthCredential({ apiKey: "dummy", provider: "zai", jwt: "jwt-mock" });
    return auth;
  }

  async function withDisabledCaptcha<T>(run: () => Promise<T>): Promise<T> {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (req: Request | string): Promise<Response> => {
      const url = typeof req === "string" ? req : req.url;
      if (url.includes("/client/configs")) {
        return new Response(JSON.stringify({ data: { configs: { captcha: { enabled: false } } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected global fetch in test: ${url}`);
    }) as typeof fetch;
    try {
      return await run();
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  function anthropicThinkingResponse(): string {
    return JSON.stringify({
      id: "msg_thinking",
      type: "message",
      role: "assistant",
      content: [
        { type: "thinking", thinking: "First step. Second step.", signature: "sig_real" },
        { type: "text", text: "Final answer." },
      ],
      model: "glm-4.6",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 7 },
    });
  }


  function anthropicThinkingSse(): string {
    return [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_thinking","type":"message","role":"assistant","content":[],"model":"glm-4.6","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":0}}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"First step. "}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Second step."}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig_real"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Final answer."}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":1}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":7}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join("\n");
  }


  function openAIReasoningDeltas(sse: string): string[] {
    return sse
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)))
      .map((chunk) => chunk.choices?.[0]?.delta?.reasoning_content)
      .filter((text): text is string => typeof text === "string");
  }

  function anthropicEvents(sse: string): Array<{ event: string; data: any }> {
    return sse
      .split("\n\n")
      .map((block) => {
        const lines = block.trim().split("\n").filter(Boolean);
        const event = lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "";
        const dataLine = lines.find((line) => line.startsWith("data: "));
        if (!dataLine) return null;
        return { event, data: JSON.parse(dataLine.slice(6)) };
      })
      .filter((event): event is { event: string; data: any } => event !== null);
  }

  it("coding-plan Anthropic upstream non-streaming surfaces thinking as OpenAI reasoning_content", async () => {
    let upstreamUrl = "";
    const fetchMock = mock(async (req: Request): Promise<Response> => {
      upstreamUrl = req.url;
      return new Response(anthropicThinkingResponse(), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const resp = await proxyRequest(makeOpenAIReq(false), "openai", {
      config: testConfig,
      auth: codingPlanAuth(),
      fetchImpl: fetchMock as any,
    });

    expect(upstreamUrl).toBe("https://api.z.ai/api/anthropic/v1/messages");
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.choices[0].message.reasoning_content).toBe("First step. Second step.");
    expect(body.choices[0].message.content).toBe("Final answer.");
  });

  it("coding-plan Anthropic upstream streaming surfaces thinking as reasoning_content deltas", async () => {
    let upstreamUrl = "";
    const fetchMock = mock(async (req: Request): Promise<Response> => {
      upstreamUrl = req.url;
      return new Response(anthropicThinkingSse(), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const resp = await proxyRequest(makeOpenAIReq(true), "openai", {
      config: testConfig,
      auth: codingPlanAuth(),
      fetchImpl: fetchMock as any,
    });

    expect(upstreamUrl).toBe("https://api.z.ai/api/anthropic/v1/messages");
    expect(resp.status).toBe(200);
    const text = await resp.text();
    expect(openAIReasoningDeltas(text)).toEqual(["First step. ", "Second step."]);
    expect(text).toContain('"content":"Final answer."');
  });

  it("coding-plan Anthropic client non-streaming passes thinking blocks through natively", async () => {
    let upstreamUrl = "";
    const fetchMock = mock(async (req: Request): Promise<Response> => {
      upstreamUrl = req.url;
      return new Response(anthropicThinkingResponse(), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const resp = await proxyRequest(makeAnthropicReq(false), "anthropic", {
      config: testConfig,
      auth: codingPlanAuth(),
      fetchImpl: fetchMock as any,
    });

    expect(upstreamUrl).toBe("https://api.z.ai/api/anthropic/v1/messages");
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.content[0]).toEqual({ type: "thinking", thinking: "First step. Second step.", signature: "sig_real" });
    expect(body.content[1]).toEqual({ type: "text", text: "Final answer." });
  });

  it("coding-plan Anthropic client streaming passes thinking deltas through natively", async () => {
    let upstreamUrl = "";
    const fetchMock = mock(async (req: Request): Promise<Response> => {
      upstreamUrl = req.url;
      return new Response(anthropicThinkingSse(), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const resp = await proxyRequest(makeAnthropicReq(true), "anthropic", {
      config: testConfig,
      auth: codingPlanAuth(),
      fetchImpl: fetchMock as any,
    });

    expect(upstreamUrl).toBe("https://api.z.ai/api/anthropic/v1/messages");
    expect(resp.status).toBe(200);
    const text = await resp.text();
    expect(text).toContain('"type":"thinking_delta"');
    expect(text).toContain('"thinking":"First step. "');
    expect(text).toContain('"text":"Final answer."');
  });

  it("start-plan OpenAI endpoint non-streaming surfaces Anthropic upstream thinking as OpenAI reasoning_content", async () => {
    await withDisabledCaptcha(async () => {
      const fetchMock = mock(async (req: Request): Promise<Response> => {
        expect(req.url).toBe("https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages");
        return new Response(anthropicThinkingResponse(), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });

      const resp = await proxyRequest(makeOpenAIReq(false), "openai", {
        config: { ...testConfig, plan: "start-plan" },
        auth: startPlanAuth(),
        fetchImpl: fetchMock as any,
      });

      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body.choices[0].message.reasoning_content).toBe("First step. Second step.");
      expect(body.choices[0].message.content).toBe("Final answer.");
    });
  });

  it("start-plan OpenAI endpoint streaming surfaces Anthropic upstream thinking deltas as reasoning_content", async () => {
    await withDisabledCaptcha(async () => {
      const fetchMock = mock(async (req: Request): Promise<Response> => {
        expect(req.url).toBe("https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages");
        return new Response(anthropicThinkingSse(), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      });

      const resp = await proxyRequest(makeOpenAIReq(true), "openai", {
        config: { ...testConfig, plan: "start-plan" },
        auth: startPlanAuth(),
        fetchImpl: fetchMock as any,
      });

      expect(resp.status).toBe(200);
      expect(openAIReasoningDeltas(await resp.text())).toEqual(["First step. ", "Second step."]);
    });
  });

  it("start-plan Anthropic endpoint passes Anthropic upstream thinking through natively (non-streaming)", async () => {
    await withDisabledCaptcha(async () => {
      const fetchMock = mock(async (req: Request): Promise<Response> => {
        expect(req.url).toBe("https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages");
        return new Response(anthropicThinkingResponse(), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });

      const resp = await proxyRequest(makeAnthropicReq(false), "anthropic", {
        config: { ...testConfig, plan: "start-plan" },
        auth: startPlanAuth(),
        fetchImpl: fetchMock as any,
      });

      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body.content[0]).toEqual({ type: "thinking", thinking: "First step. Second step.", signature: "sig_real" });
      expect(body.content[1]).toEqual({ type: "text", text: "Final answer." });
    });
  });

  it("start-plan Anthropic endpoint passes Anthropic upstream thinking through natively (streaming)", async () => {
    await withDisabledCaptcha(async () => {
      const fetchMock = mock(async (req: Request): Promise<Response> => {
        expect(req.url).toBe("https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages");
        return new Response(anthropicThinkingSse(), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      });

      const resp = await proxyRequest(makeAnthropicReq(true), "anthropic", {
        config: { ...testConfig, plan: "start-plan" },
        auth: startPlanAuth(),
        fetchImpl: fetchMock as any,
      });

      expect(resp.status).toBe(200);
      const events = anthropicEvents(await resp.text());
      const thinkingStarts = events.filter((e) =>
        e.event === "content_block_start" && e.data.content_block?.type === "thinking"
      );
      const thinkingDeltas = events.filter((e) => e.data.delta?.type === "thinking_delta");

      expect(thinkingStarts).toHaveLength(1);
      expect(thinkingStarts[0].data).toEqual({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      });
      expect(thinkingDeltas.map((e) => e.data.index)).toEqual([0, 0]);
      expect(thinkingDeltas.map((e) => e.data.delta.thinking)).toEqual(["First step. ", "Second step."]);
    });
  });
});

describe("errorResponse", () => {
  it("builds JSON error with correct status", () => {
    const resp = errorResponse(401, "auth_error", "Invalid API key");
    expect(resp.status).toBe(401);
    expect(resp.headers.get("content-type")).toBe("application/json");
  });
});
