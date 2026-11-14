import { describe, it, expect, afterEach } from "bun:test";
import { handleResponses } from "./responses-handler.js";
import { ResponseStore } from "../responses/store.js";
import type { ProxyConfig } from "../config/types.js";
import { AuthManager } from "../auth/manager.js";
import { HighspeedManager } from "../highspeed/manager.js";
import { ClientSigningManager } from "./client-signing.js";
import type * as CaptchaExports from "./captcha.js";

type CaptchaModule = typeof CaptchaExports;
const liveManagers: HighspeedManager[] = [];
afterEach(() => {
  for (const manager of liveManagers.splice(0)) manager.stop();
});

const CONFIG: ProxyConfig = {
  server: { port: 0, host: "127.0.0.1" },
  auth: {},
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
  clientSigning: { enabled: false }, highspeed: { enabled: false, origin: "https://zcode.z.ai", models: [] },
  mcp: { enabled: true, webSearch: true, webReader: false, zread: false, gateway: { enabled: true, upstreamOrigin: "https://zcode.chatglm.site" } },
  media: { enabled: false, upstreamOrigin: "https://zcode.chatglm.site" },
  async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },
  claim: { enabled: false, auto: true, origin: "https://zcode.z.ai", pollIntervalMs: 300000, cooldownMs: 600000, planId: "" },
  logging: { level: "info" },
};

const auth = { getCredential: async () => ({ apiKey: "testkey.testsecret", userId: "u1" }) } as unknown as import("../auth/manager.js").AuthManager;

function chatUpstream(body: string, status = 200): typeof fetch {
  // SSE bodies are labeled text/event-stream like the real wire — the handler
  // gates the streaming lane on that content-type (mirrors handler.ts)
  const contentType = body.startsWith("event:") || body.startsWith("data:") ? "text/event-stream" : "application/json";
  return (async (): Promise<Response> => new Response(body, { status, headers: { "content-type": contentType } })) as unknown as typeof fetch;
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
  it.each([null, [], 1, true])("rejects non-object JSON bodies: %j", async (body) => {
    const response = await handleResponses(makeReq(body), { config: CONFIG, auth });
    expect(response.status).toBe(400);
    expect((await response.json()).error.type).toBe("invalid_request");
  });
  it("sends easy input messages to the Anthropic upstream", async () => {
    let sent = "";
    const response = await handleResponses(makeReq({ model: "glm-5.2", input: [{ role: "user", content: "easy question" }] }), {
      config: CONFIG, auth, endpointRouting: null, clientSigning: null,
      fetchImpl: (async (request: Request) => {
        sent = await request.text();
        return new Response(anthropicMsg("answer"));
      }) as typeof fetch,
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(sent).messages[0].content).toContainEqual(expect.objectContaining({ type: "text", text: "easy question" }));
  });

  it.each([false, true])("surfaces Anthropic errors without completing or storing the response (partial=%s)", async (partial) => {
    const store = new ResponseStore({ maxEntries: 10, ttlMs: 60000 });
    const prefix = partial ? anthropicSse("partial").split("event: message_delta")[0] : "";
    const upstream = prefix + 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"upstream overloaded"}}\n\n';
    const response = await handleResponses(makeReq({ model: "glm-5.2", input: "hello", stream: true }), {
      config: CONFIG, auth, responseStore: store, endpointRouting: null, clientSigning: null,
      fetchImpl: chatUpstream(upstream),
    });
    const wire = await response.text();
    const events = wire.split("\n").filter(l => l.startsWith("data: ")).map(l => JSON.parse(l.slice(6)));
    const failed = events.find(e => e.type === "response.failed");
    expect(failed?.response.status).toBe("failed");
    expect(failed?.response.error).toEqual({ code: "overloaded_error", message: "upstream overloaded" });
    expect(events.some(e => e.type === "response.completed" || e.type === "response.output_item.done")).toBe(false);
    expect(store.get(failed.response.id)).toBeUndefined();
  });

  it.each([false, true])("replays namespaced tool calls with matching Anthropic tool definitions (stream=%s)", async (stream) => {
    const store = new ResponseStore({ maxEntries: 10, ttlMs: 60000 });
    const tools = [{ type: "namespace", name: "fs", tools: [{ type: "function", name: "read", parameters: { type: "object" } }] }];
    const toolEvents = [
      { type: "message_start", message: { id: "m1", model: "glm-5.2", usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_ns", name: "fs__read", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    const batch = { ...JSON.parse(anthropicMsg("")), content: [{ type: "tool_use", id: "call_ns", name: "fs__read", input: {} }], stop_reason: "tool_use" };
    const first = await handleResponses(makeReq({ model: "glm-5.2", input: "read file", tools, stream }), {
      config: CONFIG, auth, responseStore: store, endpointRouting: null, clientSigning: null,
      fetchImpl: chatUpstream(stream ? toolEvents.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("") : JSON.stringify(batch)),
    });
    const wire = await first.text();
    const result = stream ? wire.split("\n").filter(l => l.startsWith("data: ")).map(l => JSON.parse(l.slice(6))).find(e => e.type === "response.completed").response : JSON.parse(wire);
    expect(result.output[0]).toMatchObject({ name: "read", namespace: "fs" });
    for (const useStore of [false, true]) {
      let sent = "";
      const reply = { type: "function_call_output", call_id: "call_ns", output: "file content" };
      const next = await handleResponses(makeReq({ model: "glm-5.2", tools,
        ...(useStore ? { previous_response_id: result.id, input: [reply] } : { input: [...result.output, reply] }),
      }), { config: CONFIG, auth, responseStore: store, endpointRouting: null, clientSigning: null,
        fetchImpl: (async (request: Request) => { sent = await request.text(); return new Response(anthropicMsg("done")); }) as typeof fetch,
      });
      expect(next.status).toBe(200);
      const body = JSON.parse(sent);
      expect(body.tools[0].name).toBe("fs__read");
      const assistant = body.messages.find((m: { role: string }) => m.role === "assistant");
      expect(assistant.content[0]).toMatchObject({ type: "tool_use", id: "call_ns", name: "fs__read" });
    }
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

// /v1/responses used to skip captcha entirely (it passed `undefined` where
// handler.ts passes captcha headers), so every start-plan request came back as
// HTTP 400 {"code":3007,"msg":"captcha verify failed"} while the OpenAI and
// Anthropic routes worked.
describe("handleResponses captcha (start-plan)", () => {
  const START_PLAN: ProxyConfig = { ...CONFIG, plan: "start-plan", provider: "bigmodel" };
  const PARAM_HEADER = "x-aliyun-captcha-verify-param";
  const REGION_HEADER = "x-aliyun-captcha-verify-region";

  /** Fake captcha module: mints sequential tokens, records how many were asked for. */
  function fakeCaptcha(): { module: CaptchaModule; minted: () => number } {
    let n = 0;
    const module = {
      RETRY_HEADERS: { PARAM: PARAM_HEADER, REGION: REGION_HEADER },
      getCaptchaToken: async () => {
        n += 1;
        return { verifyParam: `token-${n}`, region: "cn" };
      },
      detectCaptchaChallenge: (resp: Response) => resp.headers.get(PARAM_HEADER),
    } as unknown as CaptchaModule;
    return { module, minted: () => n };
  }

  it("sends a captcha token upstream on start-plan", async () => {
    const seen: (string | null)[] = [];
    const fetchImpl = (async (request: Request): Promise<Response> => {
      seen.push(request.headers.get(PARAM_HEADER));
      return new Response(anthropicMsg("ok"), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const captcha = fakeCaptcha();
    const resp = await handleResponses(makeReq({ model: "glm-5.2", input: "hi" }), {
      config: START_PLAN, auth, fetchImpl, captcha: captcha.module,
    });
    expect(resp.status).toBe(200);
    expect(seen).toEqual(["token-1"]);
    expect(captcha.minted()).toBe(1);
  });

  it("retries once with a fresh token when upstream answers in-body 3007", async () => {
    const seen: (string | null)[] = [];
    const fetchImpl = (async (request: Request): Promise<Response> => {
      seen.push(request.headers.get(PARAM_HEADER));
      if (seen.length === 1) {
        return new Response(JSON.stringify({ code: 3007, msg: "captcha verify failed" }), {
          status: 400, headers: { "content-type": "application/json" },
        });
      }
      return new Response(anthropicMsg("recovered"), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const captcha = fakeCaptcha();
    const resp = await handleResponses(makeReq({ model: "glm-5.2", input: "hi" }), {
      config: START_PLAN, auth, fetchImpl, captcha: captcha.module,
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.output[0].content[0].text).toBe("recovered");
    // The challenged token is already spent, so the retry must carry a NEW one.
    expect(seen).toEqual(["token-1", "token-2"]);
  });

  it("retries when the challenge arrives as a response header", async () => {
    const seen: (string | null)[] = [];
    const fetchImpl = (async (request: Request): Promise<Response> => {
      seen.push(request.headers.get(PARAM_HEADER));
      if (seen.length === 1) {
        return new Response("denied", { status: 403, headers: { [PARAM_HEADER]: "challenge-abc" } });
      }
      return new Response(anthropicMsg("ok"), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const captcha = fakeCaptcha();
    const resp = await handleResponses(makeReq({ model: "glm-5.2", input: "hi" }), {
      config: START_PLAN, auth, fetchImpl, captcha: captcha.module,
    });
    expect(resp.status).toBe(200);
    expect(seen).toEqual(["token-1", "token-2"]);
  });

  it("gives up after one retry instead of looping", async () => {
    let calls = 0;
    const fetchImpl = (async (): Promise<Response> => {
      calls += 1;
      return new Response(JSON.stringify({ code: 3007, msg: "captcha verify failed" }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const captcha = fakeCaptcha();
    const resp = await handleResponses(makeReq({ model: "glm-5.2", input: "hi" }), {
      config: START_PLAN, auth, fetchImpl, captcha: captcha.module,
    });
    expect(calls).toBe(2);
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error.type).toBe("upstream_error");
    expect(body.error.message).toContain("3007");
  });

  it("does not touch captcha on coding-plan", async () => {
    const seen: (string | null)[] = [];
    const fetchImpl = (async (request: Request): Promise<Response> => {
      seen.push(request.headers.get(PARAM_HEADER));
      return new Response(anthropicMsg("ok"), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const captcha = fakeCaptcha();
    const resp = await handleResponses(makeReq({ model: "glm-5.2", input: "hi" }), {
      config: CONFIG, auth, fetchImpl, captcha: captcha.module,
    });
    expect(resp.status).toBe(200);
    expect(seen).toEqual([null]);
    expect(captcha.minted()).toBe(0);
  });

  it("injects the device/session metadata.user_id blob on BOTH plans (bundle E2e is plan-agnostic)", async () => {
    const START_PLAN: ProxyConfig = { ...CONFIG, plan: "start-plan", provider: "bigmodel" };
    let codingBody = "";
    let startBody = "";
    const codingFetch = (async (request: Request): Promise<Response> => {
      codingBody = await request.text();
      return new Response(anthropicMsg("ok"), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const startFetch = (async (request: Request): Promise<Response> => {
      startBody = await request.text();
      return new Response(anthropicMsg("ok"), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    // Inject a fake captcha module — without it the start-plan pre-mint path
    // lazy-imports the REAL solver and fires a network solve, timing out
    // single-file runs and leaking solver state into later tests.
    const startPlanCaptcha = fakeCaptcha();
    await handleResponses(makeReq({ model: "glm-5.2", input: "hi" }), { config: CONFIG, auth, fetchImpl: codingFetch });
    await handleResponses(makeReq({ model: "glm-5.2", input: "hi" }), { config: START_PLAN, auth, fetchImpl: startFetch, captcha: startPlanCaptcha.module });

    // The account uuid ("u1") is never transmitted — account_uuid is hardcoded
    // empty in the bundle (UIo); no session resolution on this path → "".
    expect(JSON.parse(JSON.parse(codingBody).metadata?.user_id)).toEqual({ account_uuid: "", session_id: "" });
    expect(JSON.parse(JSON.parse(startBody).metadata?.user_id)).toEqual({ account_uuid: "", session_id: "" });
  });
});

// CL-08: /v1/responses used to give up on the FIRST connect-level failure and
// mislabel captcha-retry dispatch failures as captcha_solver_failed.
describe("handleResponses resilience (CL-08)", () => {
  it("retries transient connect failures (3 attempts, fresh dispatch each)", async () => {
    let calls = 0;
    const fetchImpl = (async (): Promise<Response> => {
      calls += 1;
      if (calls < 3) throw new Error("Unable to connect");
      return new Response(anthropicMsg("after retry"), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const resp = await handleResponses(makeReq({ model: "glm-5.2", input: "hi" }), { config: CONFIG, auth, fetchImpl });
    expect(resp.status).toBe(200);
    expect(calls).toBe(3);
    const body = await resp.json();
    expect(body.output[0].content[0].text).toBe("after retry");
  });

  it("surfaces 502 upstream_unreachable after exhausting connect attempts", async () => {
    let calls = 0;
    const fetchImpl = (async (): Promise<Response> => {
      calls += 1;
      throw new Error("Unable to connect");
    }) as unknown as typeof fetch;

    const resp = await handleResponses(makeReq({ model: "glm-5.2", input: "hi" }), { config: CONFIG, auth, fetchImpl });
    expect(resp.status).toBe(502);
    expect(calls).toBe(3);
    const body = await resp.json();
    expect(body.error.type).toBe("upstream_unreachable");
  });

  it("does not retry once the client aborted", async () => {
    const controller = new AbortController();
    const req = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-5.2", input: "hi" }),
      signal: controller.signal,
    });
    let calls = 0;
    const fetchImpl = (async (): Promise<Response> => {
      calls += 1;
      controller.abort(); // abort while the first attempt is "in flight"
      throw new Error("Unable to connect");
    }) as unknown as typeof fetch;

    const resp = await handleResponses(req, { config: CONFIG, auth, fetchImpl });
    expect(resp.status).toBe(502);
    expect(calls).toBe(1);
  });

  it("captcha retry dispatch failure → 502 upstream_unreachable (not mislabeled 503)", async () => {
    const START_PLAN: ProxyConfig = { ...CONFIG, plan: "start-plan", provider: "bigmodel" };
    let calls = 0;
    const fetchImpl = (async (): Promise<Response> => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ code: 3007, msg: "captcha verify failed" }), {
          status: 400, headers: { "content-type": "application/json" },
        });
      }
      throw new Error("connection reset during retry");
    }) as unknown as typeof fetch;

    let n = 0;
    const captcha = {
      RETRY_HEADERS: { PARAM: "x-aliyun-captcha-verify-param", REGION: "x-aliyun-captcha-verify-region" },
      getCaptchaToken: async () => {
        n += 1;
        return { verifyParam: `token-${n}`, region: "cn" };
      },
      detectCaptchaChallenge: (resp: Response) => resp.headers.get("x-aliyun-captcha-verify-param"),
    } as unknown as CaptchaModule;

    const resp = await handleResponses(makeReq({ model: "glm-5.2", input: "hi" }), {
      config: START_PLAN, auth, fetchImpl, captcha,
    });
    expect(resp.status).toBe(502);
    const body = await resp.json();
    expect(body.error.type).toBe("upstream_unreachable");
  });

  it("captcha solver failure → 503 captcha_solver_failed (after bounded acquire retries)", async () => {
    const START_PLAN: ProxyConfig = { ...CONFIG, plan: "start-plan", provider: "bigmodel" };
    const fetchImpl = (async (): Promise<Response> =>
      new Response(JSON.stringify({ code: 3007, msg: "captcha verify failed" }), {
        status: 400, headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    // Strict acquisition retries within CAPTCHA_ACQUIRE_BUDGET_MS before
    // giving up (NOTEPAD "3.16.3 增补" §H) — shrink the budget for the test.
    const savedBudget = process.env.CAPTCHA_ACQUIRE_BUDGET_MS;
    process.env.CAPTCHA_ACQUIRE_BUDGET_MS = "10";
    let upstreamCalled = 0;
    const countingFetch = (async (req: Request): Promise<Response> => {
      upstreamCalled += 1;
      return fetchImpl(req);
    }) as unknown as typeof fetch;
    try {
      const captcha = {
        RETRY_HEADERS: { PARAM: "x-aliyun-captcha-verify-param", REGION: "x-aliyun-captcha-verify-region" },
        getCaptchaToken: async () => {
          throw new Error("solver exploded");
        },
        detectCaptchaChallenge: (resp: Response) => resp.headers.get("x-aliyun-captcha-verify-param"),
      } as unknown as CaptchaModule;

      const resp = await handleResponses(makeReq({ model: "glm-5.2", input: "hi" }), {
        config: START_PLAN, auth, fetchImpl: countingFetch, captcha,
      });
      expect(resp.status).toBe(503);
      const body = await resp.json();
      expect(body.error.type).toBe("captcha_solver_failed");
      // Strict mode: a captcha-less request is NEVER dispatched upstream.
      expect(upstreamCalled).toBe(0);
    } finally {
      if (savedBudget === undefined) delete process.env.CAPTCHA_ACQUIRE_BUDGET_MS;
      else process.env.CAPTCHA_ACQUIRE_BUDGET_MS = savedBudget;
    }
  });

  it("times out a stalled captcha acquisition and never dispatches a late token", async () => {
    const savedBudget = process.env.CAPTCHA_ACQUIRE_BUDGET_MS;
    process.env.CAPTCHA_ACQUIRE_BUDGET_MS = "25";
    const lateToken = { verifyParam: "late-token", region: "cn" };
    let finishAcquire!: (token: typeof lateToken) => void;
    const acquisition = new Promise<typeof lateToken>((resolve) => { finishAcquire = resolve; });
    let acquires = 0;
    let upstreamCalls = 0;
    let pendingResponse: Promise<Response> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const captcha = {
        RETRY_HEADERS: { PARAM: "x-aliyun-captcha-verify-param", REGION: "x-aliyun-captcha-verify-region" },
        getCaptchaToken: () => {
          acquires++;
          return acquisition;
        },
        detectCaptchaChallenge: () => null,
      } as unknown as CaptchaModule;
      pendingResponse = handleResponses(makeReq({ model: "glm-5.2", input: "hi" }), {
        config: { ...CONFIG, plan: "start-plan" }, auth, captcha,
        endpointRouting: null, clientSigning: null, highspeed: null,
        fetchImpl: (async () => {
          upstreamCalls++;
          return new Response(anthropicMsg("should not dispatch"));
        }) as unknown as typeof fetch,
      });
      const response = await Promise.race([
        pendingResponse,
        new Promise<never>((_resolve, reject) => {
          watchdog = setTimeout(() => reject(new Error("captcha acquisition exceeded its budget")), 1_000);
        }),
      ]);
      expect(response.status).toBe(503);
      expect((await response.json()).error.type).toBe("captcha_solver_failed");
      expect(acquires).toBe(1);
      expect(upstreamCalls).toBe(0);

      finishAcquire(lateToken);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(acquires).toBe(1);
      expect(upstreamCalls).toBe(0);
    } finally {
      finishAcquire(lateToken);
      await pendingResponse?.catch(() => {});
      if (watchdog !== undefined) clearTimeout(watchdog);
      if (savedBudget === undefined) delete process.env.CAPTCHA_ACQUIRE_BUDGET_MS;
      else process.env.CAPTCHA_ACQUIRE_BUDGET_MS = savedBudget;
    }
  });
});

// ── HighSpeed 加速卡接线（2026-10-14）+ session affinity 收口 ──

const ENFORCE_CONFIG: ProxyConfig = {
  ...CONFIG,
  clientIdentity: { mode: "enforce", ttlSeconds: 900, maxSessions: 1024 },
};

function oauthJwtAuth(): AuthManager {
  const auth = new AuthManager();
  auth.setOAuthCredential({ apiKey: "testkey", secret: "testsecret", provider: "zai", jwt: "test-zcode-jwt" });
  return auth;
}

/** Manager pre-loaded with an active card (draw mock always hits). */
async function cardHoldingManager(): Promise<HighspeedManager> {
  const now = Date.now();
  const manager = new HighspeedManager({
    origin: "https://zcode.z.ai",
    models: ["glm-5.3", "glm-5.2", "glm-5.1"],
    fetchImpl: (async () => new Response(JSON.stringify({
      code: 0, msg: "success",
      data: {
        card: { card_id: "hsc_resp_1", task_id: "t-1", provider: "builtin:zai-coding-plan", model: "glm-5.3-highspeed", issued_at: now, expires_at: now + 300_000 },
        next_draw_at: now + 120_000,
      },
    }), { status: 200 })) as unknown as typeof fetch,
  });
  liveManagers.push(manager);
  manager.onRequest("glm-5.2", "t-1", { jwt: "test-zcode-jwt", codingPlanAuth: "testkey.testsecret", family: "zai" });
  await new Promise((r) => setTimeout(r, 5));
  expect(manager.activeCard()?.cardId).toBe("hsc_resp_1");
  return manager;
}

describe("handleResponses highspeed wiring", () => {
  it("does not extend the old account's draw loop after switching to a credential without JWT", async () => {
    const clock = { now: 1_000_000 };
    let draws = 0;
    let finishIdleCheck!: (stopped: boolean) => void;
    const idleStopped = new Promise<boolean>((resolve) => { finishIdleCheck = resolve; });
    const manager = new HighspeedManager({
      origin: "https://zcode.z.ai",
      models: ["glm-5.2"],
      now: () => clock.now,
      retryMs: 2,
      onEvent: (message) => {
        if (message.includes("idle-stopped")) finishIdleCheck(true);
      },
      fetchImpl: (async () => {
        draws++;
        return new Response(JSON.stringify({ code: 0, data: { card: null } }));
      }) as unknown as typeof fetch,
    });
    liveManagers.push(manager);
    manager.onRequest("glm-5.2", "old-task", { jwt: "old-jwt", codingPlanAuth: "old-key", family: "zai" });
    expect(draws).toBe(1);

    // Match the panel's live credential reload after a coding-plan-only import.
    const switchedAuth = oauthJwtAuth();
    switchedAuth.setOAuthCredential({ apiKey: "imported-key", provider: "zai" });
    clock.now += 4 * 60_000;
    const response = await handleResponses(makeReq({ model: "glm-5.2", input: "hi" }), {
      config: CONFIG, auth: switchedAuth, highspeed: manager,
      endpointRouting: null, clientSigning: null,
      fetchImpl: chatUpstream(anthropicMsg("answer")),
    });
    expect(response.status).toBe(200);
    await response.text();

    const drawsBeforeIdle = draws;
    clock.now += 2 * 60_000; // Six minutes since the last JWT-backed request.
    const timeout = setTimeout(() => finishIdleCheck(false), 1_000);
    try {
      expect(await idleStopped).toBeTrue();
      expect(draws).toBe(drawsBeforeIdle);
    } finally {
      clearTimeout(timeout);
    }
  });

  it("restores the signing manager after a rejected unsigned card request", async () => {
    const manager = await cardHoldingManager();
    let signingCalls = 0;
    let requests = 0;
    const signer = new ClientSigningManager({ fetchImpl: (async () => {
      signingCalls++;
      return new Response("unavailable", { status: 503 });
    }) as unknown as typeof fetch });
    try {
      const response = await handleResponses(makeReq({ model: "glm-5.2", input: "hi" }), {
        config: CONFIG, auth: oauthJwtAuth(), endpointRouting: null, clientSigning: signer, highspeed: manager,
        fetchImpl: (async () => {
          requests++;
          if (requests === 1) {
            expect(signingCalls).toBe(0);
            return new Response("expired", { status: 401 });
          }
          expect(signingCalls).toBeGreaterThan(0);
          return new Response(anthropicMsg("recovered"));
        }) as unknown as typeof fetch,
      });
      expect(response.status).toBe(200);
      expect(requests).toBe(2);
    } finally { manager.stop(); }
  });
  it("mounts the card: model rewritten, rerouted to the highspeed endpoint, JWT auth set, card headers, never signed", async () => {
    const manager = await cardHoldingManager();
    const signingFetches: string[] = [];
    const calls: { url: string; headers: Headers; body: string }[] = [];
    const response = await handleResponses(makeReq({ model: "glm-5.2", input: "hello" }), {
      config: CONFIG, auth: oauthJwtAuth(), endpointRouting: null,
      clientSigning: new ClientSigningManager({
        fetchImpl: (async (input: RequestInfo | URL) => {
          signingFetches.push(String(input instanceof Request ? input.url : input));
          throw new Error(`unexpected signing fetch: ${String(input)}`);
        }) as unknown as typeof fetch,
      }),
      highspeed: manager,
      fetchImpl: (async (request: Request) => {
        calls.push({ url: request.url, headers: request.headers, body: await request.clone().text() });
        return new Response(anthropicMsg("answer"));
      }) as typeof fetch,
    });
    expect(response.status).toBe(200);
    expect(calls.length).toBe(1);
    expect(JSON.parse(calls[0]!.body).model).toBe("glm-5.3-highspeed");
    // URL rerouted to the dedicated highspeed inference endpoint (zcode-builtin
    // providerRules rev 31+; NOT the coding-plan provider URL)
    expect(calls[0]!.url).toBe("https://zcode.z.ai/api/v1/highspeed/anthropic/v1/messages");
    expect(calls[0]!.headers.get("x-api-key")).toBe("test-zcode-jwt");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer test-zcode-jwt");
    expect(calls[0]!.headers.get("x-bigmodel-authorization")).toBe("Bearer testkey.testsecret");
    expect(calls[0]!.headers.get("bigmodel-target-type")).toBe("PERSONAL");
    expect(calls[0]!.headers.get("x-highspeed-card-id")).toBe("hsc_resp_1");
    // official static rule: highspeed-mode requests are never signed
    expect(signingFetches.length).toBe(0);
    expect(calls[0]!.headers.get("x-client-sig")).toBeNull();
  });

  it("falls back to the session model and normal auth after a card rejection (401)", async () => {
    const manager = await cardHoldingManager();
    const calls: { url: string; headers: Headers; body: string }[] = [];
    const response = await handleResponses(makeReq({ model: "glm-5.2", input: "hello" }), {
      config: CONFIG, auth: oauthJwtAuth(), endpointRouting: null, clientSigning: null, highspeed: manager,
      fetchImpl: (async (request: Request) => {
        calls.push({ url: request.url, headers: request.headers, body: await request.clone().text() });
        return calls.length === 1
          ? new Response(JSON.stringify({ msg: "VERIFY_SIGNATURE_INVALID" }), { status: 401 })
          : new Response(anthropicMsg("answer"));
      }) as typeof fetch,
    });
    expect(response.status).toBe(200);
    expect(calls.length).toBe(2);
    // first: carded — dedicated highspeed endpoint
    expect(calls[0]!.headers.get("x-highspeed-card-id")).toBe("hsc_resp_1");
    expect(calls[0]!.url).toBe("https://zcode.z.ai/api/v1/highspeed/anthropic/v1/messages");
    expect(JSON.parse(calls[0]!.body).model).toBe("glm-5.3-highspeed");
    // fallback: original model, provider URL, normal coding-plan dual auth, no card header
    expect(calls[1]!.url).toBe("https://api.z.ai/api/anthropic/v1/messages");
    expect(calls[1]!.headers.get("x-highspeed-card-id")).toBeNull();
    expect(calls[1]!.headers.get("x-api-key")).toBe("testkey.testsecret");
    expect(calls[1]!.headers.get("authorization")).toBe("Bearer testkey.testsecret");
    expect(JSON.parse(calls[1]!.body).model).toBe("glm-5.2");
    // card dropped; the redraw hands back a fresh card (max-rate loop contract)
    await new Promise((r) => setTimeout(r, 5));
    expect(manager.activeCard()?.cardId).toBe("hsc_resp_1");
  });

  it("keeps card headers and the rerouted URL on connect-retry redispatches", async () => {
    const manager = await cardHoldingManager();
    const calls: { url: string; headers: Headers; body: string }[] = [];
    let attempts = 0;
    const response = await handleResponses(makeReq({ model: "glm-5.2", input: "hello" }), {
      config: CONFIG, auth: oauthJwtAuth(), endpointRouting: null, clientSigning: null, highspeed: manager,
      fetchImpl: (async (request: Request) => {
        attempts++;
        if (attempts === 1) throw new Error("Unable to connect");
        calls.push({ url: request.url, headers: request.headers, body: await request.clone().text() });
        return new Response(anthropicMsg("answer"));
      }) as typeof fetch,
    });
    expect(response.status).toBe(200);
    expect(attempts).toBe(2);
    expect(calls.length).toBe(1);
    // the retried dispatch must still carry the full carded set, card model
    // AND the rerouted highspeed URL (dispatch rebuilds from the closure
    // variable every attempt — mirrors handler.ts's rebuild test)
    expect(calls[0]!.headers.get("x-highspeed-card-id")).toBe("hsc_resp_1");
    expect(calls[0]!.headers.get("x-api-key")).toBe("test-zcode-jwt");
    expect(JSON.parse(calls[0]!.body).model).toBe("glm-5.3-highspeed");
    expect(calls[0]!.url).toBe("https://zcode.z.ai/api/v1/highspeed/anthropic/v1/messages");
  });

  it("leaves requests untouched when the model is not eligible", async () => {
    const manager = await cardHoldingManager();
    const calls: { url: string; headers: Headers; body: string }[] = [];
    const response = await handleResponses(makeReq({ model: "glm-4.6", input: "hello" }), {
      config: CONFIG, auth: oauthJwtAuth(), endpointRouting: null, clientSigning: null, highspeed: manager,
      fetchImpl: (async (request: Request) => {
        calls.push({ url: request.url, headers: request.headers, body: await request.clone().text() });
        return new Response(anthropicMsg("answer"));
      }) as typeof fetch,
    });
    expect(response.status).toBe(200);
    expect(calls.length).toBe(1);
    // uncarded traffic keeps the provider URL (no highspeed reroute)
    expect(calls[0]!.url).toBe("https://api.z.ai/api/anthropic/v1/messages");
    expect(calls[0]!.headers.get("x-highspeed-card-id")).toBeNull();
    expect(calls[0]!.headers.get("x-api-key")).toBe("testkey.testsecret");
    expect(JSON.parse(calls[0]!.body).model).toBe("glm-4.6");
  });
});

describe("handleResponses session affinity (2026-10-14 收口)", () => {
  it("preserves explicit trace context through captcha retry", async () => {
    const seen: Headers[] = [];
    const request = makeReq({ model: "glm-5.2", input: "hi" });
    request.headers.set("x-request-id", "request-retry");
    request.headers.set("x-zcode-trace-id", "trace-retry");
    const response = await handleResponses(request, {
      config: { ...ENFORCE_CONFIG, plan: "start-plan" }, auth,
      endpointRouting: null, clientSigning: null, highspeed: null,
      captcha: {
        RETRY_HEADERS: { PARAM: "x-aliyun-captcha-verify-param", REGION: "x-aliyun-captcha-verify-region" },
        getCaptchaToken: async () => ({ verifyParam: "test-token", region: "cn" }),
        detectCaptchaChallenge: () => null,
      } as unknown as CaptchaModule,
      fetchImpl: (async (req: Request) => {
        seen.push(req.headers);
        return seen.length === 1
          ? new Response(JSON.stringify({ code: 3007 }), { status: 400 })
          : new Response(anthropicMsg("recovered"));
      }) as typeof fetch,
    });
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(2);
    for (const headers of seen) {
      expect(headers.get("x-request-id")).toBe("request-retry");
      expect(headers.get("x-zcode-trace-id")).toBe("trace-retry");
    }
  });
  it("explicit x-session-id reaches trace headers and metadata.user_id (mirrors /v1/messages)", async () => {
    let sent: Request | undefined;
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": "sess_test123" },
      body: JSON.stringify({ model: "glm-5.2", input: "hello" }),
    }), {
      config: ENFORCE_CONFIG, auth, endpointRouting: null, clientSigning: null,
      fetchImpl: (async (request: Request) => {
        sent = request;
        return new Response(anthropicMsg("answer"));
      }) as typeof fetch,
    });
    expect(response.status).toBe(200);
    expect(sent).toBeDefined();
    expect(sent!.headers.get("x-session-id")).toBe("test123");
    const body = JSON.parse(await sent!.clone().text()) as { metadata?: { user_id?: string } };
    const userId = JSON.parse(body.metadata!.user_id!) as { device_id?: string; account_uuid: string; session_id: string };
    expect(userId.session_id).toBe("test123");
    expect(userId.account_uuid).toBe("");
  });
});

// 2026-11-09 实弹：highspeed 死卡以 HTTP 200 + {"code":1005} 信封回应；该形态
// 旧管线当成功处理——非流式在翻译层崩成 500（resp.content.filter）、流式产出空
// 流，且 /v1/responses 全端点不打请求表行，两起事故在日志面板均不可见。
describe("handleResponses observability + biz-envelope guards (2026-11-09)", () => {
  const envelope = JSON.stringify({ code: 1005, msg: "exceed quota limit", logid: "20261109" });

  it("turns a 200-wrapped biz envelope into an honest 502 (batch lane)", async () => {
    const response = await handleResponses(makeReq({ model: "glm-5.2", input: "hello" }), {
      config: CONFIG, auth, endpointRouting: null, clientSigning: null,
      fetchImpl: chatUpstream(envelope),
    });
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error.type).toBe("translation_failed");
    expect(body.error.message).toContain("exceed quota limit");
  });

  it("does the same for stream requests answered with JSON (no empty SSE garbage)", async () => {
    const response = await handleResponses(makeReq({ model: "glm-5.2", input: "hello", stream: true }), {
      config: CONFIG, auth, endpointRouting: null, clientSigning: null,
      fetchImpl: chatUpstream(envelope),
    });
    expect(response.status).toBe(502);
    expect((await response.json()).error.type).toBe("translation_failed");
  });

  it("logs request-table rows (RSP tag) for batch success and upstream error passthrough", async () => {
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
    try {
      const ok = await handleResponses(makeReq({ model: "glm-5.2", input: "hello" }), {
        config: CONFIG, auth, endpointRouting: null, clientSigning: null,
        fetchImpl: chatUpstream(anthropicMsg("hi back")),
      });
      expect(ok.status).toBe(200);
      const limited = await handleResponses(makeReq({ model: "glm-5.2", input: "hello" }), {
        config: CONFIG, auth, endpointRouting: null, clientSigning: null,
        fetchImpl: chatUpstream('{"error":{"type":"rate_limit_error"}}', 429),
      });
      expect(limited.status).toBe(429);
    } finally {
      console.log = origLog;
    }
    const rows = lines.filter((l) => l.includes("RSP"));
    expect(rows.some((l) => l.includes("|  200 |"))).toBeTrue();
    expect(rows.some((l) => l.includes("|  429 |"))).toBeTrue();
  });

  it("drops a quota-dead card answering 200+code:1005 and falls back to the session model", async () => {
    const manager = await cardHoldingManager();
    const calls: { url: string }[] = [];
    try {
      const response = await handleResponses(makeReq({ model: "glm-5.2", input: "hi" }), {
        config: CONFIG, auth: oauthJwtAuth(), endpointRouting: null, clientSigning: null, highspeed: manager,
        fetchImpl: (async (request: Request) => {
          calls.push({ url: request.url });
          return calls.length === 1
            ? new Response(envelope, { status: 200, headers: { "content-type": "application/json" } })
            : new Response(anthropicMsg("recovered"));
        }) as typeof fetch,
      });
      expect(response.status).toBe(200);
      expect(calls.length).toBe(2);
      // carded attempt reroutes to the dedicated highspeed endpoint; the
      // fallback returns to the provider URL with the session model
      expect(calls[0]!.url).toContain("/api/v1/highspeed/");
      expect(calls[1]!.url).toBe("https://api.z.ai/api/anthropic/v1/messages");
    } finally { manager.stop(); }
  });
});
