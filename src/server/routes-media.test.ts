/**
 * Media route tests — full fetch-handler dispatch: proxyApiKey gate, plan /
 * credential gates with the Ark error shape, task-id prefix routing, body
 * caps, 501 surfaces, and one happy path per face against a stubbed upstream.
 */
import { describe, it, expect } from "bun:test";
import { createFetchHandler } from "./server.js";
import type { ProxyConfig } from "../config/types.js";
import { AuthManager } from "../auth/manager.js";
import type { Credential } from "../auth/types.js";

function makeConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
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
    clientSigning: { enabled: false },
    highspeed: { enabled: false, origin: "https://zcode.z.ai", models: [] },
    mcp: { enabled: true, webSearch: true, webReader: false, zread: false, gateway: { enabled: true, upstreamOrigin: "https://zcode.test" } },
    media: { enabled: true, upstreamOrigin: "https://zcode.test" },
    async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },
    claim: { enabled: false, auto: true, origin: "https://zcode.z.ai", pollIntervalMs: 300000, cooldownMs: 600000, planId: "" },
    logging: { level: "info" },
    ...overrides,
  };
}

function authed(credFields: Partial<Credential> = {}): AuthManager {
  const auth = new AuthManager();
  auth.setOAuthCredential({ apiKey: "sk-x.sec", provider: "zai", jwt: "jwt-1", ...credFields });
  return auth;
}

const json = (payload: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json", ...headers } });

/** Upstream stub that answers ToolHub invokes and video_edit tools/call by URL. */
function mediaUpstreamStub(handlers: {
  toolhub?: (url: string, body: Record<string, unknown>) => Response;
  videoEdit?: (body: Record<string, unknown>) => Response;
}) {
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    // multipart uploads (FormData) and non-JSON bodies parse to {} — URL-based
    // dispatch below is what matters.
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({ url, body, headers });
    if (url.includes("/api/v1/mcp/server/video_edit")) {
      const resp = handlers.videoEdit?.(body) ?? json({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "stub missing videoEdit handler" } });
      return resp;
    }
    return handlers.toolhub?.(url, body) ?? json({ code: 1, msg: "stub missing toolhub handler" });
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

function handler(config: ProxyConfig, auth: AuthManager, fetchImpl?: typeof fetch) {
  return createFetchHandler({ config, auth, ...(fetchImpl ? { fetchImpl } : {}) });
}

describe("media routes — gating", () => {
  it("requires the proxy API key when configured (shared gate)", async () => {
    const config = makeConfig({ auth: { proxyApiKey: "sk-proxy" } });
    const resp = await handler(config, authed())(new Request("http://localhost/api/v3/images/generations", { method: "POST", body: "{}" }));
    expect(resp.status).toBe(401);
  });

  it("400s for start-plan with an Ark-shaped plan_unsupported error", async () => {
    const config = makeConfig({ plan: "start-plan" });
    const resp = await handler(config, authed())(new Request("http://localhost/api/v3/images/generations", { method: "POST", body: JSON.stringify({ prompt: "x" }) }));
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("plan_unsupported");
    expect(body.error.message).toContain("coding-plan");
    expect("type" in body.error).toBe(false);
  });

  it("400s credentials_unavailable when the credential lacks a JWT", async () => {
    const auth = authed({ jwt: undefined });
    const resp = await handler(makeConfig(), auth)(new Request("http://localhost/api/v3/tts/create", { method: "POST", body: JSON.stringify({ text_prompt: "hi" }) }));
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe("credentials_unavailable");
  });

  it("404s every media face when media.enabled=false", async () => {
    const config = makeConfig({ media: { enabled: false, upstreamOrigin: "https://zcode.test" } });
    for (const [path, method] of [
      ["/api/v3/images/generations", "POST"],
      ["/api/v3/contents/generations/tasks", "POST"],
      ["/api/v3/contents/generations/tasks/t1", "GET"],
      ["/api/v3/auc/bigmodel/recognize/flash", "POST"],
      ["/api/v3/tts/create", "POST"],
    ] as const) {
      const resp = await handler(config, authed())(new Request(`http://localhost${path}`, { method, body: method === "POST" ? "{}" : undefined }));
      expect(resp.status).toBe(404);
    }
  });
});

describe("media routes — unsupported surfaces", () => {
  it("501s the async ASR pair with the sync alternative spelled out", async () => {
    const h = handler(makeConfig(), authed());
    for (const path of ["/api/v3/auc/bigmodel/submit", "/api/v3/auc/bigmodel/query"]) {
      const resp = await h(new Request(`http://localhost${path}`, { method: "POST", body: "{}" }));
      expect(resp.status).toBe(501);
      const body = (await resp.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("not_supported");
      expect(body.error.message).toContain("recognize/flash");
    }
  });

  it("501s video task DELETE for coding-plan, but start-plan hits the plan gate first (400)", async () => {
    const h = handler(makeConfig(), authed());
    const resp = await h(new Request("http://localhost/api/v3/contents/generations/tasks/t1", { method: "DELETE" }));
    expect(resp.status).toBe(501);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_supported");

    const startPlan = handler(makeConfig({ plan: "start-plan" }), authed());
    const gated = await startPlan(new Request("http://localhost/api/v3/contents/generations/tasks/t1", { method: "DELETE" }));
    expect(gated.status).toBe(400);
    const gatedBody = (await gated.json()) as { error: { code: string } };
    expect(gatedBody.error.code).toBe("plan_unsupported");
  });
});

describe("media routes — task-id routing", () => {
  it("rejects malformed task ids before any upstream call", async () => {
    const stub = mediaUpstreamStub({});
    const resp = await handler(makeConfig(), authed(), stub.fetch)(
      new Request("http://localhost/api/v3/contents/generations/tasks/bad%2Fid%2F..", { method: "GET" }),
    );
    expect(resp.status).toBe(400);
    expect(stub.calls.length).toBe(0);
  });

  it("answers 400 (not a router 500) for malformed percent-sequences in the task id", async () => {
    const stub = mediaUpstreamStub({});
    // decodeURIComponent throws URIError on these; the router must fall back to
    // the raw segment so the character-class guard rejects them as 400.
    for (const suffix of ["%80", "%", "%C3"]) {
      const resp = await handler(makeConfig(), authed(), stub.fetch)(
        new Request(`http://localhost/api/v3/contents/generations/tasks/${suffix}`, { method: "GET" }),
      );
      expect(resp.status).toBe(400);
      const body = (await resp.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("invalid_parameter");
    }
    expect(stub.calls.length).toBe(0);
  });

  it("routes GET tasks/{id} to the ToolHub query and maps the snapshot", async () => {
    const stub = mediaUpstreamStub({
      toolhub: () => json({ code: 0, data: { status: "succeeded", output: { video_url: "https://v.test/a.mp4" } } }),
    });
    const resp = await handler(makeConfig(), authed(), stub.fetch)(new Request("http://localhost/api/v3/contents/generations/tasks/task-9", { method: "GET" }));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { id: string; status: string; content: { video_url: string } };
    expect(body).toEqual({ id: "task-9", status: "succeeded", content: { video_url: "https://v.test/a.mp4" } });
    expect(stub.calls[0].url).toBe("https://zcode.test/api/v1/toolhub/tool/video_generate/tasks/query");
    const bodyOut = stub.calls[0].body as { task_id: string };
    expect(bodyOut.task_id).toBe("task-9");
  });
});

describe("media routes — happy paths", () => {
  it("POST /api/v3/images/generations → ToolHub invoke → Ark response", async () => {
    const stub = mediaUpstreamStub({
      toolhub: (url, body) => {
        expect(url).toBe("https://zcode.test/api/v1/toolhub/tool/image_generate/invoke");
        expect((body as { query: string }).query).toBe("a cat");
        expect((stub.calls[0].headers["idempotency-key"] ?? "")).toMatch(/[0-9a-f-]{36}/);
        return json({ code: 0, data: { state: "SUCCEEDED", output: { image_url: "https://img.test/x.png" }, invocation_id: "inv-1" } });
      },
    });
    const resp = await handler(makeConfig(), authed(), stub.fetch)(
      new Request("http://localhost/api/v3/images/generations", { method: "POST", body: JSON.stringify({ model: "doubao-seedream-4-0-250828", prompt: "a cat" }) }),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { model: string; created: number; data: Array<{ url: string }>; usage: { generated_images: number } };
    expect(body.model).toBe("doubao-seedream-4-0-250828");
    expect(body.created).toBeGreaterThan(0);
    expect(body.data).toEqual([{ url: "https://img.test/x.png" }]);
    expect(body.usage).toEqual({ generated_images: 1 });
  });

  it("POST /api/v3/auc/bigmodel/recognize/flash → video_edit → X-Api-Status-Code + ms utterances", async () => {
    const stub = mediaUpstreamStub({
      videoEdit: (body) => {
        // 8 required fields, zero-values included.
        expect(Object.keys((body.params as { arguments: Record<string, unknown> }).arguments).length).toBe(8);
        const sseBody = `data: ${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { structuredContent: { transcript: { text: "你好", audio_duration_seconds: 1.2, segments: [{ speaker: "1", text: "你好", start: 0.1, end: 1.2, words: [] }] } } },
        })}\n\n`;
        return new Response(sseBody, { status: 200, headers: { "content-type": "text/event-stream", "x-request-id": "req-77" } });
      },
    });
    const resp = await handler(makeConfig(), authed(), stub.fetch)(
      new Request("http://localhost/api/v3/auc/bigmodel/recognize/flash", {
        method: "POST",
        headers: { "x-api-request-id": "caller-req-1", "x-api-resource-id": "volc.bigasr.auc", "x-api-key": "ignored" },
        body: JSON.stringify({ user: { uid: "u" }, audio: { data: "QUJD", format: "mp3", language: "zh-CN" }, request: { model_name: "bigmodel" } }),
      }),
    );
    expect(resp.status).toBe(200);
    expect(resp.headers.get("x-api-status-code")).toBe("20000000");
    expect(resp.headers.get("x-api-request-id")).toBe("caller-req-1");
    const body = (await resp.json()) as { result: { text: string; utterances: Array<{ text: string; start_time: number; end_time: number; additions?: { speaker: string } }> }; audio_info?: { duration: number } };
    expect(body.result.text).toBe("你好");
    expect(body.result.utterances[0]).toMatchObject({ text: "你好", start_time: 100, end_time: 1200, additions: { speaker: "1" } });
    expect(body.audio_info).toEqual({ duration: 1200 });
    // identity headers reached the speech gateway (not the caller's x-api-key)
    expect(stub.calls[0].headers["authorization"]).toBe("Bearer jwt-1");
    expect(stub.calls[0].headers["x-bigmodel-authorization"]).toBe("Bearer sk-x.sec");
  });

  it("silent audio answers X-Api-Status-Code 20000003 with an empty body", async () => {
    const stub = mediaUpstreamStub({
      videoEdit: () => {
        const sseBody = `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent: { silent_audio: true } } })}\n\n`;
        return new Response(sseBody, { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    });
    const resp = await handler(makeConfig(), authed(), stub.fetch)(
      new Request("http://localhost/api/v3/auc/bigmodel/recognize/flash", { method: "POST", body: JSON.stringify({ audio: { data: "QUJD", format: "wav" } }) }),
    );
    expect(resp.status).toBe(200);
    expect(resp.headers.get("x-api-status-code")).toBe("20000003");
    expect(await resp.json()).toEqual({});
  });

  it("POST /api/v3/tts/create → video_edit speech_synthesize → {code:0,data}", async () => {
    const stub = mediaUpstreamStub({
      videoEdit: (body) => {
        const args = (body.params as { arguments: Record<string, unknown> }).arguments;
        expect(Object.keys(args).length).toBe(11);
        expect(args.voice).toBe("zh_female_1");
        // 客户端带来的非空 model 必须在反代侧改写成 ""——video_edit 只吃空 model
        // （实弹 2026-11-14：任何非空 model → internal_error）。
        expect(args.model).toBe("");
        return json({ jsonrpc: "2.0", id: 1, result: { structuredContent: { audio_base64: "AAA=", duration: 1.5 } } });
      },
    });
    const resp = await handler(makeConfig(), authed(), stub.fetch)(
      new Request("http://localhost/api/v3/tts/create", {
        method: "POST",
        body: JSON.stringify({ model: "seed-tts-2", text_prompt: "你好", audio_config: { format: "mp3" }, references: [{ speaker: "zh_female_1" }] }),
      }),
    );
    expect(resp.status).toBe(200);
    expect(resp.headers.get("x-api-request-id")).toMatch(/[0-9a-f-]{36}/);
    const body = (await resp.json()) as { code: number; data: string; duration: number };
    expect(body).toEqual({ code: 0, data: "AAA=", duration: 1.5 });
  });

  it("TTS: omitted model flows upstream as empty string (kit mirror); >1 voice references answer 400 locally", async () => {
    const stub = mediaUpstreamStub({
      videoEdit: (body) => {
        const args = (body.params as { arguments: Record<string, unknown> }).arguments;
        expect(args.model).toBe("");
        return json({ jsonrpc: "2.0", id: 1, result: { structuredContent: { audio_base64: "AAA=" } } });
      },
    });
    const h = handler(makeConfig(), authed(), stub.fetch);
    const noModel = await h(new Request("http://localhost/api/v3/tts/create", { method: "POST", body: JSON.stringify({ text_prompt: "hi" }) }));
    expect(noModel.status).toBe(200);
    const twoRefs = await h(new Request("http://localhost/api/v3/tts/create", {
      method: "POST",
      body: JSON.stringify({ model: "m", text_prompt: "hi", references: [{ speaker: "a" }, { speaker: "b" }] }),
    }));
    expect(twoRefs.status).toBe(400);
    expect(((await twoRefs.json()) as { error: { message: string } }).error.message).toContain("one voice reference");
  });

  it("POST /api/v3/contents/generations/tasks → invoke → {id, model, status:queued}", async () => {
    const stub = mediaUpstreamStub({
      toolhub: () => json({ code: 0, data: { state: "SUCCEEDED", output: { task_id: "task-3" } } }),
    });
    const resp = await handler(makeConfig(), authed(), stub.fetch)(
      new Request("http://localhost/api/v3/contents/generations/tasks", {
        method: "POST",
        body: JSON.stringify({ model: "doubao-seedance-2-5-260628", content: [{ type: "text", text: "drone" }] }),
      }),
    );
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ id: "task-3", model: "doubao-seedance-2-5-260628", status: "queued" });
    // Adaptive default ratio mirrors the Ark default (ToolHub's own default is 16:9).
    const body = stub.calls[0].body as { ratio?: string };
    expect(body.ratio).toBe("adaptive");
  });
});

describe("media routes — body caps and upstream error surfacing", () => {
  it("413s an images body over the 14 MiB cap (generic message, not the ASR chunking hint)", async () => {
    const stub = mediaUpstreamStub({});
    const resp = await handler(makeConfig(), authed(), stub.fetch)(
      new Request("http://localhost/api/v3/images/generations", {
        method: "POST",
        headers: { "content-length": String(20 * 1024 * 1024) },
        body: "{}",
      }),
    );
    expect(resp.status).toBe(413);
    const body = (await resp.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("request_too_large");
    // The message names the CAP (14 MiB), not the declared size.
    expect(body.error.message).toContain("14680064");
    expect(body.error.message).not.toContain("45 MiB");
    expect(stub.calls.length).toBe(0);
  });

  it("accepts a request body sized like a spec-legal 10 MiB base64 reference (≈13.3 MiB)", async () => {
    // 10 MiB image → ≈13.3 MiB base64 + envelope must NOT trip the 14 MiB cap,
    // and the strict base64 check must pass — the flow reaches upload+invoke.
    const stub = mediaUpstreamStub({
      toolhub: (url) =>
        url.includes("/api/v1/toolhub/files")
          ? json({ code: 0, data: { url: "https://files.test/ref.png" } })
          : json({ code: 0, data: { state: "SUCCEEDED", output: { image_url: "https://img.test/x.png" } } }),
    });
    // Encodes exactly 10,485,759 bytes (≤ 10 MiB) in 13,981,012 base64 chars (a multiple of 4).
    const encoded = "A".repeat(13_981_012);
    const resp = await handler(makeConfig(), authed(), stub.fetch)(
      new Request("http://localhost/api/v3/images/generations", {
        method: "POST",
        body: JSON.stringify({ prompt: "x", image: `data:image/png;base64,${encoded}` }),
      }),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { data: Array<{ url: string }> };
    expect(body.data[0]).toEqual({ url: "https://img.test/x.png" });
  });

  it("413s an ASR body over 45 MiB with the chunking hint", async () => {
    const stub = mediaUpstreamStub({});
    const resp = await handler(makeConfig(), authed(), stub.fetch)(
      new Request("http://localhost/api/v3/auc/bigmodel/recognize/flash", {
        method: "POST",
        headers: { "content-length": String(50 * 1024 * 1024) },
        body: "{}",
      }),
    );
    expect(resp.status).toBe(413);
    const body = (await resp.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("request_too_large");
    expect(body.error.message).toContain("45 MiB");
    expect(body.error.message).toContain("chunk");
    expect(stub.calls.length).toBe(0);
  });

  it("video create on HTTP 429 exhausts the same-key ladder → 429 rate_limit_exceeded (definitive rejection)", async () => {
    const stub = mediaUpstreamStub({ toolhub: () => new Response("slow down", { status: 429 }) });
    // mediaRetryDelayMs: the video-submit retry ladder sleeps between attempts
    // (production 5s) — inject ~1ms so the ladder completes inside the test.
    const fetchHandler = createFetchHandler({ config: makeConfig(), auth: authed(), fetchImpl: stub.fetch, mediaRetryDelayMs: 1 });
    const resp = await fetchHandler(
      new Request("http://localhost/api/v3/contents/generations/tasks", { method: "POST", body: JSON.stringify({ content: [{ type: "text", text: "x" }] }) }),
    );
    expect(resp.status).toBe(429);
    const body = (await resp.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("rate_limit_exceeded");
    expect(body.error.message).toContain("no task was created");
    expect(body.error.message).not.toContain("charged");
    expect(stub.calls.length).toBe(4);
    expect(new Set(stub.calls.map((c) => c.headers["idempotency-key"])).size).toBe(1);
  });

  it("video create: an unconfirmed transient followed by 429s keeps the double-billing 502", async () => {
    let n = 0;
    const stub = mediaUpstreamStub({
      toolhub: () => {
        n += 1;
        if (n === 1) {
          // A timeout is result-unconfirmed: the submit may have landed, so a
          // later 429 does NOT clear the double-billing uncertainty.
          const err = new Error("deadline");
          err.name = "TimeoutError";
          throw err;
        }
        return new Response("slow down", { status: 429 });
      },
    });
    const fetchHandler = createFetchHandler({ config: makeConfig(), auth: authed(), fetchImpl: stub.fetch, mediaRetryDelayMs: 1 });
    const resp = await fetchHandler(
      new Request("http://localhost/api/v3/contents/generations/tasks", { method: "POST", body: JSON.stringify({ content: [{ type: "text", text: "x" }] }) }),
    );
    expect(resp.status).toBe(502);
    const body = (await resp.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("upstream_error");
    expect(body.error.message).toContain("may already have been created");
  });

  it("maps a speech-gateway 429 to 429 rate_limit_exceeded", async () => {
    const stub = mediaUpstreamStub({ videoEdit: () => new Response("slow down", { status: 429 }) });
    const resp = await handler(makeConfig(), authed(), stub.fetch)(
      new Request("http://localhost/api/v3/tts/create", { method: "POST", body: JSON.stringify({ model: "seed-tts-2", text_prompt: "hi" }) }),
    );
    expect(resp.status).toBe(429);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe("rate_limit_exceeded");
    expect(stub.calls.length).toBe(1);
  });

  it("maps ToolHub terminal codes to Ark kinds (3706 → upstream_permission_denied)", async () => {
    const stub = mediaUpstreamStub({
      toolhub: () => json({ code: 3706, msg: "phone binding required" }),
    });
    const resp = await handler(makeConfig(), authed(), stub.fetch)(
      new Request("http://localhost/api/v3/images/generations", { method: "POST", body: JSON.stringify({ prompt: "x" }) }),
    );
    expect(resp.status).toBe(502);
    const body = (await resp.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("upstream_permission_denied");
    expect(body.error.message).toContain("3706");
  });

  it("invalid JSON bodies answer 400 invalid_parameter (Ark shape)", async () => {
    const resp = await handler(makeConfig(), authed())(
      new Request("http://localhost/api/v3/images/generations", { method: "POST", body: "not-json" }),
    );
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_parameter");
  });
});
