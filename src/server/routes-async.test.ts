/**
 * Integration tests for `/async/*` routes — models the REAL off-peak protocol.
 *
 * The mock ticket/LLM server returns the canonical `{code:0, data:{...}}` envelope
 * on control-plane responses, returns batch JSON (not SSE) when the LLM request
 * has `stream:false`, and can simulate mid-stream ticket-expired inside an HTTP-200
 * SSE stream. This catches bugs that the v1 mocks (always-SSE, no-envelope) hid.
 */
import { describe, it, expect } from "bun:test";
import { createFetchHandler } from "./server.js";
import type { ProxyConfig } from "../config/types.js";
import { AuthManager } from "../auth/manager.js";
import type { Credential } from "../auth/types.js";

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
    clientIdentity: { mode: "observe", ttlSeconds: 900, maxSessions: 1024 },
    responses: { enabled: true, storeMaxEntries: 1000, storeTtlMs: 86400000 },
    mcp: { enabled: true, webSearch: true, webReader: false, zread: false },
    async: {
      enabled: true,
      origin: "https://zcode.z.ai",
      pollIntervalMs: 10,
      keepAliveIntervalMs: 5,
      maxWaitMs: 0,
      maxRetries: 3,
      settleTimeoutMs: 100,
      controlTimeoutMs: 1000,
      defaultModel: "",
    },
    logging: { level: "info" },
    ...overrides,
  };
}

function makeOauthAuth(jwt: string = "the-jwt"): AuthManager {
  const auth = new AuthManager({ mode: "oauth", provider: "zai" });
  const cred: Credential = { apiKey: "key-x.secret-y", provider: "zai", jwt };
  auth.setOAuthCredential(cred);
  return auth;
}

interface MockServerOpts {
  initialTicketState?: "queued" | "ready";
  queueProgression?: ("queued" | "ready" | "expired" | "not_found")[];
  /** First LLM call emits a 200 SSE whose FIRST event is `event:error` with the marker.
   *  Bridge detects pre-commit (no client-visible output yet) → transparent retry. */
  midStreamExpiredPreCommit?: boolean;
  /** First LLM call emits `message_start` (commits), THEN `event:error` with marker.
   *  Bridge detects post-commit → terminal error (no retry, no duplicate lifecycle). */
  midStreamExpiredPostCommit?: boolean;
  llmStatusOverride?: number;
  takeCount: { value: number };
  settleCount: { value: number };
}

function envelope(data: unknown, code: number = 0, msg: string = "ok"): unknown {
  return { code, msg, data };
}

function makeMockFetch(opts: MockServerOpts): typeof fetch {
  const state = { ticketCounter: 0, pollCounter: 0, llmCounter: 0 };

  return (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = typeof url === "string" ? url : url.toString();
    const method = init?.method ?? "GET";

    if (u.endsWith("/api/v1/off-peak/ticket/availability") && method === "GET") {
      return json(envelope({ can_take_number: true }));
    }

    if (u.endsWith("/api/v1/off-peak/ticket") && method === "POST") {
      state.ticketCounter++;
      opts.takeCount.value++;
      return json(envelope({
        ticket_id: `t-${state.ticketCounter}`,
        state: opts.initialTicketState ?? "ready",
        ...(opts.initialTicketState === "queued" ? { position: 1, next_poll_after: 0.01 } : {}),
      }));
    }

    if (u.endsWith("/api/v1/off-peak/ticket/status") && method === "POST") {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const tid = body.ticket_ids?.[0] ?? "t-1";
      const stateStr = opts.queueProgression?.[state.pollCounter] ?? "ready";
      state.pollCounter++;
      return json(envelope({
        next_poll_after: 0.01,
        tickets: [{ ticket_id: tid, state: stateStr }],
      }));
    }

    if (u.includes("/api/v1/off-peak/ticket/") && u.endsWith("/settle") && method === "POST") {
      opts.settleCount.value++;
      return new Response(null, { status: 200 });
    }

    if (u.endsWith("/api/v1/off-peak/anthropic/v1/messages") && method === "POST") {
      state.llmCounter++;
      const reqBody = JSON.parse((init?.body as string) ?? "{}");

      if (opts.llmStatusOverride && opts.llmStatusOverride !== 200) {
        return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "forced upstream error" } }), {
          status: opts.llmStatusOverride,
          headers: { "content-type": "application/json" },
        });
      }

      if (opts.midStreamExpiredPreCommit && state.llmCounter === 1) {
        // FIRST event is the error (no message_start emitted to client).
        // Bridge scans the pre-commit buffer, sees the marker before any boundary
        // is committed → transparent retry.
        const chunks = [
          `event: error\ndata: {"type":"error","error":{"type":"api_error","message":"off-peak-ticket-expired: deadline reached"}}\n\n`,
        ];
        return sseResponse(chunks);
      }

      if (opts.midStreamExpiredPostCommit && state.llmCounter === 1) {
        // First chunk: normal message_start (commits to client).
        // Second chunk: error containing the marker → post-commit, must NOT retry.
        const chunks = [
          `event: message_start\ndata: {"type":"message_start","message":{"id":"msg-x"}}\n\n`,
          `event: error\ndata: {"type":"error","error":{"type":"api_error","message":"off-peak-ticket-expired: deadline reached"}}\n\n`,
        ];
        return sseResponse(chunks);
      }

      if (reqBody.stream === false || reqBody.stream === undefined) {
        throw new Error(`UNEXPECTED stream:false upstream request — handler must force stream:true internally. body.stream=${reqBody.stream}`);
      }

      const chunks = [
        `event: message_start\ndata: {"type":"message_start","message":{"id":"msg-1","role":"assistant","model":"glm-4.6","usage":{"input_tokens":5,"output_tokens":0}}}\n\n`,
        `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
        `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello from off-peak"}}\n\n`,
        `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`,
        `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\n`,
        `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
      ];
      return sseResponse(chunks);
    }

    return new Response("not mocked: " + u, { status: 599 });
  }) as typeof fetch;
}

function json(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function drain(resp: Response, maxMs: number = 2000): Promise<string> {
  if (!resp.body) return "";
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const readP = reader.read();
    const timeoutP = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 500));
    const r = await Promise.race([readP, timeoutP]);
    if (r === "timeout") {
      if (chunks.length > 0) break;
      continue;
    }
    if (r.done) break;
    chunks.push(r.value);
  }
  reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks));
}

describe("/async/* routing", () => {
  it("returns 404 when async.enabled=false", async () => {
    const config = makeConfig({ async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 10, keepAliveIntervalMs: 5, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 100, controlTimeoutMs: 1000, defaultModel: "" } });
    const auth = makeOauthAuth();
    const handler = createFetchHandler({ config, auth, fetchImpl: makeMockFetch({ takeCount: { value: 0 }, settleCount: { value: 0 } }) });
    const resp = await handler(new Request("http://localhost/async/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "hi" }], max_tokens: 100 }),
    }));
    expect(resp.status).toBe(404);
  });

  it("returns 400 async_credentials_unavailable when credential lacks jwt (apikey mode)", async () => {
    const config = makeConfig();
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "key.secret" });
    const counters = { takeCount: { value: 0 }, settleCount: { value: 0 } };
    const handler = createFetchHandler({ config, auth, fetchImpl: makeMockFetch(counters) });
    const resp = await handler(new Request("http://localhost/async/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "hi" }], max_tokens: 100 }),
    }));
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error.type).toBe("async_credentials_unavailable");
    expect(counters.takeCount.value).toBe(0);
  });

  it("B1: malformed JSON returns 400 WITHOUT taking a ticket", async () => {
    const config = makeConfig();
    const auth = makeOauthAuth();
    const counters = { takeCount: { value: 0 }, settleCount: { value: 0 } };
    const handler = createFetchHandler({ config, auth, fetchImpl: makeMockFetch(counters) });
    const resp = await handler(new Request("http://localhost/async/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ malformed json",
    }));
    expect(resp.status).toBe(400);
    expect(counters.takeCount.value).toBe(0);
    expect(counters.settleCount.value).toBe(0);
  });

  it("B1: missing messages field returns 400 WITHOUT taking a ticket", async () => {
    const config = makeConfig();
    const auth = makeOauthAuth();
    const counters = { takeCount: { value: 0 }, settleCount: { value: 0 } };
    const handler = createFetchHandler({ config, auth, fetchImpl: makeMockFetch(counters) });
    const resp = await handler(new Request("http://localhost/async/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6" }),
    }));
    expect(resp.status).toBe(400);
    expect(counters.takeCount.value).toBe(0);
  });
});

describe("/async/v1/messages (Anthropic)", () => {
  it("happy path streaming: 200 + text/event-stream with Anthropic bytes", async () => {
    const config = makeConfig();
    const auth = makeOauthAuth();
    const counters = { takeCount: { value: 0 }, settleCount: { value: 0 } };
    const handler = createFetchHandler({ config, auth, fetchImpl: makeMockFetch(counters) });

    const resp = await handler(new Request("http://localhost/async/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "hi" }], max_tokens: 100, stream: true }),
    }));

    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type") ?? "").toContain("text/event-stream");
    const text = await drain(resp);
    expect(text).toContain("message_start");
    expect(text).toContain("Hello from off-peak");
    expect(text).toContain("message_stop");
    expect(counters.takeCount.value).toBe(1);
    expect(counters.settleCount.value).toBe(1);
  });

  it("B3 pre-commit: marker arrives BEFORE first boundary → transparent retry, no leaked marker", async () => {
    const config = makeConfig();
    const auth = makeOauthAuth();
    const counters = { takeCount: { value: 0 }, settleCount: { value: 0 } };
    const fetchImpl = makeMockFetch({ ...counters, midStreamExpiredPreCommit: true });
    const handler = createFetchHandler({ config, auth, fetchImpl });

    const resp = await handler(new Request("http://localhost/async/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "hi" }], max_tokens: 100, stream: true }),
    }));

    const text = await drain(resp);
    expect(text).toContain("Hello from off-peak");
    expect(text).not.toContain("off-peak-ticket-expired");
    expect(counters.takeCount.value).toBe(2);
    expect(counters.settleCount.value).toBe(2);
  });

  it("B3 post-commit: marker arrives AFTER first chunk committed → terminal error, NO retry, NO duplicate message_start", async () => {
    const config = makeConfig();
    const auth = makeOauthAuth();
    const counters = { takeCount: { value: 0 }, settleCount: { value: 0 } };
    const fetchImpl = makeMockFetch({ ...counters, midStreamExpiredPostCommit: true });
    const handler = createFetchHandler({ config, auth, fetchImpl });

    const resp = await handler(new Request("http://localhost/async/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "hi" }], max_tokens: 100, stream: true }),
    }));

    const text = await drain(resp);
    // Pre-commit succeeded → first message_start reached client.
    // Post-commit error → terminal error event emitted, no retry.
    expect(text).toContain("message_start");
    expect(text).toContain("event: error");
    expect(text).toContain("expired mid-stream after output started");
    expect(text).not.toContain("off-peak-ticket-expired");
    // NO retry happened — only the initial ticket was taken
    expect(counters.takeCount.value).toBe(1);
    expect(counters.settleCount.value).toBe(1);
  });

  it("B9: non-expired upstream 500 → standard Anthropic event:error (no raw body leak)", async () => {
    const config = makeConfig();
    const auth = makeOauthAuth();
    const counters = { takeCount: { value: 0 }, settleCount: { value: 0 } };
    const fetchImpl = makeMockFetch({ ...counters, llmStatusOverride: 500 });
    const handler = createFetchHandler({ config, auth, fetchImpl });

    const resp = await handler(new Request("http://localhost/async/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "hi" }], max_tokens: 100, stream: true }),
    }));

    const text = await drain(resp);
    expect(text).toContain("event: error");
    expect(text).toContain('"type":"error"');
    expect(text).toContain("HTTP 500");
    expect(counters.settleCount.value).toBe(1);
  });

  it("non-stream: returns aggregated Anthropic JSON", async () => {
    const config = makeConfig();
    const auth = makeOauthAuth();
    const counters = { takeCount: { value: 0 }, settleCount: { value: 0 } };
    const handler = createFetchHandler({ config, auth, fetchImpl: makeMockFetch(counters) });

    const resp = await handler(new Request("http://localhost/async/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "hi" }], max_tokens: 100, stream: false }),
    }));

    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type") ?? "").toContain("application/json");
    const body = await resp.json();
    expect(body.role).toBe("assistant");
    expect(Array.isArray(body.content)).toBe(true);
    expect(body.content[0].text).toBe("Hello from off-peak");
    expect(body.stop_reason).toBe("end_turn");
    expect(counters.settleCount.value).toBe(1);
  });
});

describe("/async/v1/chat/completions (OpenAI)", () => {
  it("B4: happy path stream — keepalives preserved + OpenAI chunks emitted", async () => {
    const config = makeConfig({ async: { enabled: true, origin: "https://zcode.z.ai", pollIntervalMs: 30, keepAliveIntervalMs: 5, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 100, controlTimeoutMs: 1000, defaultModel: "" } });
    const auth = makeOauthAuth();
    const counters = { takeCount: { value: 0 }, settleCount: { value: 0 } };
    // Two queued polls then ready — gives keepalive time to fire during wait
    const fetchImpl = makeMockFetch({ ...counters, initialTicketState: "queued", queueProgression: ["queued", "queued", "ready"] });
    const handler = createFetchHandler({ config, auth, fetchImpl });

    const resp = await handler(new Request("http://localhost/async/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "hi" }], stream: true }),
    }));

    expect(resp.status).toBe(200);
    const text = await drain(resp);
    expect(text).toContain("choices");
    expect(text).toContain("Hello from off-peak");
    expect(text).toContain("[DONE]");
    expect(text).toContain(": keepalive\n\n");
    expect(counters.settleCount.value).toBe(1);
  });

  it("B4: bridge error event translates to OpenAI data:{error}", async () => {
    const config = makeConfig();
    const auth = makeOauthAuth();
    const counters = { takeCount: { value: 0 }, settleCount: { value: 0 } };
    const fetchImpl = makeMockFetch({ ...counters, llmStatusOverride: 500 });
    const handler = createFetchHandler({ config, auth, fetchImpl });

    const resp = await handler(new Request("http://localhost/async/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "hi" }], stream: true }),
    }));

    const text = await drain(resp);
    expect(text).toContain('"error"');
    expect(text).toContain("HTTP 500");
    expect(text).toContain("[DONE]");
  });

  it("non-stream: returns aggregated OpenAI JSON", async () => {
    const config = makeConfig();
    const auth = makeOauthAuth();
    const counters = { takeCount: { value: 0 }, settleCount: { value: 0 } };
    const handler = createFetchHandler({ config, auth, fetchImpl: makeMockFetch(counters) });

    const resp = await handler(new Request("http://localhost/async/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "hi" }] }),
    }));

    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.object).toBe("chat.completion");
    expect(body.choices?.[0]?.message?.content).toBe("Hello from off-peak");
    expect(counters.settleCount.value).toBe(1);
  });
});

describe("/async/v1/health", () => {
  it("returns availability (envelope unwrapped)", async () => {
    const config = makeConfig();
    const auth = makeOauthAuth();
    const counters = { takeCount: { value: 0 }, settleCount: { value: 0 } };
    const handler = createFetchHandler({ config, auth, fetchImpl: makeMockFetch(counters) });

    const resp = await handler(new Request("http://localhost/async/v1/health", { method: "GET" }));

    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.canTakeNumber).toBe(true);
  });

  it("returns 400 when credential lacks jwt", async () => {
    const config = makeConfig();
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "key.secret" });
    const counters = { takeCount: { value: 0 }, settleCount: { value: 0 } };
    const handler = createFetchHandler({ config, auth, fetchImpl: makeMockFetch(counters) });

    const resp = await handler(new Request("http://localhost/async/v1/health", { method: "GET" }));
    expect(resp.status).toBe(400);
  });
});
