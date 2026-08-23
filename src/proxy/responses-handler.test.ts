import { describe, it, expect } from "bun:test";
import { handleResponses } from "./responses-handler.js";
import { ResponseStore } from "../responses/store.js";
import type { ProxyConfig } from "../config/types.js";

const CONFIG: ProxyConfig = {
  server: { port: 0, host: "127.0.0.1" },
  auth: { mode: "apikey", apiKey: "testkey.testsecret" },
  provider: "zai",
  plan: "coding-plan",
  providers: {
    zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
    bigmodel: { anthropicBase: "https://open.bigmodel.cn/api/anthropic", openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
  },
  defaultModel: "glm-5.2",
  models: ["glm-5.2"],
  identity: { appVersion: "test-1.0.0", sourceTitle: "cli", refererOrigin: "https://zcode.z.ai" },
  clientIdentity: { mode: "off", ttlSeconds: 900, maxSessions: 1024 },
  responses: { enabled: true, storeMaxEntries: 1000, storeTtlMs: 86400000 },
  endpointRouting: { enabled: false, origin: "https://zcode.z.ai" },
  clientSigning: { enabled: false, origin: "https://zcode.z.ai" },
  mcp: { enabled: true, webSearch: true, webReader: false, zread: false },
  async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },
  logging: { level: "info" },
};

const auth = { getCredential: async () => ({ apiKey: "testkey.testsecret", userId: "u1" }) } as unknown as import("../auth/manager.js").AuthManager;

function chatUpstream(body: string, status = 200): typeof fetch {
  return (async (): Promise<Response> => new Response(body, { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

function anthropicMsg(text: string, id = "msg_1"): string {
  return JSON.stringify({
    id,
    type: "message",
    role: "assistant",
    model: "glm-5.2",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 2 },
  });
}

function anthropicSse(text: string): string {
  return [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_s", type: "message", role: "assistant", model: "glm-5.2", content: [], usage: { input_tokens: 3, output_tokens: 0 } } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  ].join("");
}

function makeReq(body: unknown): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("handleResponses", () => {
  it("forwards Responses effort to the coding-plan Anthropic upstream", async () => {
    let upstreamBody: any;
    const fetchImpl = (async (request: Request): Promise<Response> => {
      upstreamBody = await request.json();
      return new Response(anthropicMsg("ok"), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const resp = await handleResponses(makeReq({
      model: "glm-5.3",
      input: "hello",
      reasoning: { effort: "xhigh" },
    }), { config: CONFIG, auth, fetchImpl });

    expect(resp.status).toBe(200);
    expect(upstreamBody.thinking).toEqual({ type: "enabled" });
    expect(upstreamBody.output_config).toEqual({ effort: "max" });
  });

  it("returns a ResponsesResponse with message output for a basic text request", async () => {
    const fetchImpl = chatUpstream(anthropicMsg("hi back"));
    const resp = await handleResponses(makeReq({ model: "glm-5.2", input: "hello" }), { config: CONFIG, auth, fetchImpl });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.object).toBe("response");
    expect(body.output[0].type).toBe("message");
    expect(body.output[0].content[0].text).toBe("hi back");
  });

  it("stores the response and resolves previous_response_id from the store", async () => {
    const store = new ResponseStore();
    const fetchImpl = chatUpstream(anthropicMsg("turn1"));
    const r1 = await handleResponses(makeReq({ model: "glm-5.2", input: "first turn" }), { config: CONFIG, auth, fetchImpl, responseStore: store });
    const body1 = await r1.json();
    expect(store.size()).toBe(1);

    // Second request references the first response's id.
    let secondUpstreamBody = "";
    const fetchImpl2 = (async (request: Request): Promise<Response> => {
      secondUpstreamBody = await request.text();
      return new Response(anthropicMsg("turn2", "msg_2"), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const r2 = await handleResponses(makeReq({ model: "glm-5.2", input: "second turn", previous_response_id: body1.id }), { config: CONFIG, auth, fetchImpl: fetchImpl2, responseStore: store });
    expect(r2.status).toBe(200);
    expect(secondUpstreamBody).toContain("first turn");
    expect(secondUpstreamBody).toContain("turn1");
    expect(secondUpstreamBody).toContain("second turn");
  });

  it("returns 404 when previous_response_id is not in the store", async () => {
    const store = new ResponseStore();
    const fetchImpl = chatUpstream(anthropicMsg("x"));
    const r = await handleResponses(makeReq({ model: "glm-5.2", input: "x", previous_response_id: "resp_missing" }), { config: CONFIG, auth, fetchImpl, responseStore: store });
    expect(r.status).toBe(404);
    const body = await r.json();
    expect(body.error.type).toBe("response_not_found");
  });

  it("does not store the response when store:false", async () => {
    const store = new ResponseStore();
    const fetchImpl = chatUpstream(anthropicMsg("x"));
    await handleResponses(makeReq({ model: "glm-5.2", input: "x", store: false }), { config: CONFIG, auth, fetchImpl, responseStore: store });
    expect(store.size()).toBe(0);
  });

  it("strips web_search_preview silently (model never sees it)", async () => {
    let upstreamCalls = 0;
    const fetchImpl = (async (): Promise<Response> => {
      upstreamCalls++;
      return new Response(anthropicMsg("no search needed"), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const r = await handleResponses(makeReq({ model: "glm-5.2", input: "search the web", tools: [{ type: "web_search_preview" }] }), { config: CONFIG, auth, fetchImpl });
    expect(r.status).toBe(200);
    expect(upstreamCalls).toBe(1);
    const body = await r.json();
    expect(body.output[0].type).toBe("message");
    const wsCall = body.output.find((o: { type: string }) => o.type === "web_search_call");
    expect(wsCall).toBeUndefined();
  });

  it("returns a text/event-stream response for stream:true", async () => {
    const fetchImpl = (async (): Promise<Response> => new Response(anthropicSse("hi"), { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
    const r = await handleResponses(makeReq({ model: "glm-5.2", input: "hi", stream: true }), { config: CONFIG, auth, fetchImpl });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/event-stream");
    const text = await r.text();
    expect(text).toContain("event: response.created");
    expect(text).toContain("event: response.completed");
    expect(text).toContain("response.output_text.delta");
  });

  it("stores a completed stream for previous_response_id continuation", async () => {
    const store = new ResponseStore();
    const streamFetch = (async (): Promise<Response> => new Response(anthropicSse("turn1"), { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
    const streamed = await handleResponses(makeReq({ model: "glm-5.2", input: "first turn", stream: true }), { config: CONFIG, auth, fetchImpl: streamFetch, responseStore: store });
    const streamText = await streamed.text();
    const responseId = streamText.match(/event: response\.completed\ndata: .*?"id":"([^"]+)"/)?.[1];
    expect(responseId).toBeDefined();

    let continuationUpstreamBody = "";
    const continuationFetch = (async (request: Request): Promise<Response> => {
      continuationUpstreamBody = await request.text();
      return new Response(anthropicMsg("turn2", "msg_c2"), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const continuation = await handleResponses(makeReq({ model: "glm-5.2", input: "second turn", previous_response_id: responseId }), { config: CONFIG, auth, fetchImpl: continuationFetch, responseStore: store });
    expect(continuation.status).toBe(200);
    expect(continuationUpstreamBody).toContain("first turn");
    expect(continuationUpstreamBody).toContain("turn1");
    expect(continuationUpstreamBody).toContain("second turn");
  });
});
