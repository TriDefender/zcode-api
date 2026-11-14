/**
 * Tests for the OAuth login flows.
 *
 * Both providers use the server-mediated CLI login (init + poll at
 * zcode.z.ai, 3.12.3 desktop parity — no local callback; the authorize URL
 * carries the `/app/oauth/login` interstitial param). The bigmodel OAuth
 * login is deprecated (superseded by zai_cn — the bigmodel FLAVOR survives
 * as a config/credential family). All upstream calls are mocked via
 * `fetchImpl` injection.
 *
 * @see _reverse/NOTEPAD.md "4. OAuth 流程"
 */
import { describe, it, expect } from "bun:test";
import { ZaiOAuthClient, ZaiCnOAuthClient, createPollLoginClient } from "./oauth.js";

/** Wrap data in the zcode.z.ai `{code, data, msg}` envelope as a JSON Response. */
function envelopeResponse(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify({ code: 0, data, msg: "success" }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Standard successful /oauth/cli/init payload (shape from the 3.10 bundle). */
function initData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    flow_id: "flow_abc",
    poll_token: "server_poll_token",
    authorize_url: "https://chat.z.ai/api/oauth/authorize?client_id=c&redirect_uri=https://zcode.z.ai/api/v1/oauth/cli/callback/zai&state=s",
    expires_at: Math.floor(Date.now() / 1000) + 600,
    poll_interval_sec: 2,
    ...overrides,
  };
}

/** Fetch mock that records every call and answers from a queue of handlers. */
type RecordedCall = { url: string; init: RequestInit };

function scriptedFetch(handlers: Array<(call: RecordedCall, n: number) => Response>) {
  const calls: RecordedCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call = { url: typeof input === "string" ? input : input.toString(), init: init ?? {} };
    const n = calls.length;
    calls.push(call);
    const handler = handlers[Math.min(n, handlers.length - 1)];
    return handler(call, n);
  }) as typeof fetch;
  return { impl, calls };
}

describe("ZaiOAuthClient (server-mediated cli login)", () => {
  it("start() POSTs /oauth/cli/init with a 32-byte Bearer and returns the server authorize URL", async () => {
    const { impl, calls } = scriptedFetch([
      () => envelopeResponse(initData()),
    ]);
    const client = new ZaiOAuthClient(impl, async () => {});

    const started = await client.start();
    try {
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("https://zcode.z.ai/api/v1/oauth/cli/init");
      expect(calls[0].init.method).toBe("POST");
      expect(JSON.parse(String(calls[0].init.body))).toEqual({ provider: "zai" });
      const bearer = String((calls[0].init.headers as Record<string, string>).authorization);
      expect(bearer).toMatch(/^Bearer [0-9a-f]{64}$/);

      expect(started.authorizeUrl).toContain("chat.z.ai/api/oauth/authorize");
      expect(started.callbackUrl).toBe("");
      expect(started.state).toBe("flow_abc");
    } finally {
      await client.close();
    }
  });

  it("start() rejects with the server msg on a business error", async () => {
    const { impl } = scriptedFetch([
      () => new Response(JSON.stringify({ code: 3001, msg: "too_many_flows" }), { status: 200 }),
    ]);
    const client = new ZaiOAuthClient(impl, async () => {});
    expect(client.start()).rejects.toThrow(/3001|too_many_flows/s);
  });

  it("start() rejects on an HTTP error with a non-JSON body", async () => {
    const { impl } = scriptedFetch([
      () => new Response("server error", { status: 500 }),
    ]);
    const client = new ZaiOAuthClient(impl, async () => {});
    expect(client.start()).rejects.toThrow(/init.*500/s);
  });

  it("start() rejects when the init data is missing required fields", async () => {
    const { impl } = scriptedFetch([
      () => envelopeResponse({ flow_id: "only_flow_id" }),
    ]);
    const client = new ZaiOAuthClient(impl, async () => {});
    expect(client.start()).rejects.toThrow(/invalid response data/);
  });

  it("authorize() polls until ready and maps zai.access_token + jwt + user_id", async () => {
    const { impl, calls } = scriptedFetch([
      () => envelopeResponse(initData()),
      () => envelopeResponse({ status: "pending" }),
      () =>
        envelopeResponse({
          status: "ready",
          token: "jwt_final",
          user: { user_id: "user_9", name: "u" },
          zai: { access_token: "zai_at" },
        }),
    ]);
    const client = new ZaiOAuthClient(impl, async () => {});

    let surfacedUrl = "";
    const result = await client.authorize((url) => {
      surfacedUrl = url;
    });

    expect(surfacedUrl).toContain("chat.z.ai/api/oauth/authorize");
    expect(result.provider).toBe("zai");
    expect(result.accessToken).toBe("zai_at");
    expect(result.jwt).toBe("jwt_final");
    expect(result.userId).toBe("user_9");

    // init + 2 polls; every poll carries the client Bearer and the flow_id path.
    expect(calls.length).toBe(3);
    const poll = calls[1];
    expect(poll.url).toBe("https://zcode.z.ai/api/v1/oauth/cli/poll/flow_abc");
    expect(poll.init.method).toBe("GET");
  });

  it("poll status 'failed' rejects with Authorization failed", async () => {
    const { impl } = scriptedFetch([
      () => envelopeResponse(initData()),
      () => envelopeResponse({ status: "failed" }),
    ]);
    const client = new ZaiOAuthClient(impl, async () => {});
    const started = await client.start();
    expect(client.complete(started)).rejects.toThrow(/Authorization failed/);
  });

  it("complete() times out once expires_at has passed", async () => {
    const { impl, calls } = scriptedFetch([
      () => envelopeResponse(initData({ expires_at: Math.floor(Date.now() / 1000) - 10 })),
    ]);
    const client = new ZaiOAuthClient(impl, async () => {});
    const started = await client.start();
    expect(client.complete(started, 300_000)).rejects.toThrow(/timed out/);
    // Never polled: the deadline was already past.
    expect(calls).toHaveLength(1);
  });

  it("ready response without zai.access_token rejects", async () => {
    const { impl } = scriptedFetch([
      () => envelopeResponse(initData()),
      () => envelopeResponse({ status: "ready", token: "jwt_only", user: { user_id: "u" } }),
    ]);
    const client = new ZaiOAuthClient(impl, async () => {});
    const started = await client.start();
    expect(client.complete(started)).rejects.toThrow(/data\.zai\.access_token/);
  });

  it("start() overrides redirect_uri with the /app/oauth/login interstitial (3.12.3 `Ed`)", async () => {
    const { impl } = scriptedFetch([
      () => envelopeResponse(initData()),
    ]);
    const client = new ZaiOAuthClient(impl, async () => {});
    const started = await client.start();
    try {
      const url = new URL(started.authorizeUrl);
      const interstitial = url.searchParams.get("redirect_uri") ?? "";
      expect(interstitial).toStartWith("https://zcode.z.ai/app/oauth/login?");
      const inner = new URL(interstitial);
      expect(inner.searchParams.get("redirect")).toBe("zcode://oauth/callback");
      expect(inner.searchParams.get("app_version")).toBe("3.18.2");
    } finally {
      await client.close();
    }
  });

  it("poll retries on 5xx / network errors / malformed 200s, then succeeds (3.12.3 semantics)", async () => {
    const handlers: Array<(call: RecordedCall, n: number) => Response> = [
      () => envelopeResponse(initData({ poll_interval_sec: 1 })),
      () => new Response("bad gateway", { status: 502 }),
      () => {
        throw new Error("network down");
      },
      () => new Response("not json", { status: 200 }),
      () =>
        envelopeResponse({
          status: "ready",
          token: "jwt_final",
          user: { user_id: "user_9" },
          zai: { access_token: "zai_at" },
        }),
    ];
    const { impl, calls } = scriptedFetch(handlers);
    const client = new ZaiOAuthClient(impl, async () => {});
    const result = await client.authorize();
    expect(result.accessToken).toBe("zai_at");
    expect(calls.length).toBe(5);
  });

  it("poll treats 4xx (except 408/429) as fatal", async () => {
    const { impl, calls } = scriptedFetch([
      () => envelopeResponse(initData()),
      () => new Response(JSON.stringify({ code: 0 }), { status: 404 }),
    ]);
    const client = new ZaiOAuthClient(impl, async () => {});
    const started = await client.start();
    await expect(client.complete(started)).rejects.toThrow(/status=404/);
    expect(calls.length).toBe(2);
  });

  it("poll retries on 429 and 408", async () => {
    const { impl, calls } = scriptedFetch([
      () => envelopeResponse(initData({ poll_interval_sec: 1 })),
      () => new Response("rate", { status: 429 }),
      () => new Response("timeout", { status: 408 }),
      () => envelopeResponse({ status: "ready", token: "j", user: { user_id: "u" }, zai: { access_token: "at" } }),
    ]);
    const client = new ZaiOAuthClient(impl, async () => {});
    const result = await client.authorize();
    expect(result.accessToken).toBe("at");
    expect(calls.length).toBe(4);
  });

  it("poll treats envelope code != 0 as fatal", async () => {
    const { impl } = scriptedFetch([
      () => envelopeResponse(initData()),
      () => new Response(JSON.stringify({ code: 3002, msg: "flow_gone" }), { status: 200 }),
    ]);
    const client = new ZaiOAuthClient(impl, async () => {});
    const started = await client.start();
    await expect(client.complete(started)).rejects.toThrow(/code=3002/);
  });
});

describe("ZaiCnOAuthClient (3.18.2 desktop \"Z.ai (CN)\" flavor — NOTEPAD「2026-11-14 增补」)", () => {
  it("start() POSTs provider zai_cn and the init issues the zchat.z.ai authorize host", async () => {
    const { impl, calls } = scriptedFetch([
      () =>
        envelopeResponse(
          initData({
            authorize_url:
              "https://zchat.z.ai/api/oauth/authorize?client_id=c&redirect_uri=https://zcode.z.ai/api/v1/oauth/cli/callback/zai_cn&state=s",
          }),
        ),
    ]);
    const client = new ZaiCnOAuthClient(impl, async () => {});

    const started = await client.start();
    try {
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("https://zcode.z.ai/api/v1/oauth/cli/init");
      expect(JSON.parse(String(calls[0].init.body))).toEqual({ provider: "zai_cn" });
      // The authorize_url is whatever the server issued — the client never
      // hardcodes the zchat host (same server-driven discipline as zai).
      expect(started.authorizeUrl).toContain("zchat.z.ai/api/oauth/authorize");
      expect(started.state).toBe("flow_abc");
    } finally {
      await client.close();
    }
  });

  it("start() keeps the zai-family `redirect_uri` interstitial and adds provider=zai_cn ON the interstitial", async () => {
    const { impl } = scriptedFetch([
      () =>
        envelopeResponse(
          initData({
            authorize_url: "https://zchat.z.ai/api/oauth/authorize?client_id=c&state=s",
          }),
        ),
    ]);
    const client = new ZaiCnOAuthClient(impl, async () => {});
    const started = await client.start();
    try {
      const url = new URL(started.authorizeUrl);
      // Param NAME stays redirect_uri (zai family), unlike bigmodel's `redirect`.
      const interstitial = url.searchParams.get("redirect_uri") ?? "";
      expect(interstitial).toStartWith("https://zcode.z.ai/app/oauth/login?");
      const inner = new URL(interstitial);
      expect(inner.searchParams.get("redirect")).toBe("zcode://oauth/callback");
      expect(inner.searchParams.get("app_version")).toBe("3.18.2");
      // 3.18.2 host `t===Qr` branch: the interstitial itself carries the flavor.
      expect(inner.searchParams.get("provider")).toBe("zai_cn");
    } finally {
      await client.close();
    }
  });

  it("authorize() polls until ready and reads the FAMILY-FOLDED data.zai bucket + linked bigmodel credential", async () => {
    const { impl, calls } = scriptedFetch([
      () =>
        envelopeResponse(
          initData({
            authorize_url: "https://zchat.z.ai/api/oauth/authorize?client_id=c&state=s",
          }),
        ),
      () => envelopeResponse({ status: "pending" }),
      () =>
        envelopeResponse({
          status: "ready",
          token: "jwt_final",
          user: { user_id: "user_cn" },
          // Live-verified 2026-11-14: the ready payload carries NO data.zai_cn
          // key — the host poll normalizer reads data.zai for the whole zai family.
          zai: { access_token: "zai_cn_at" },
          // The linked BigModel credential rides the same payload
          // (host `x = _c(provider) ? Rw(l.bigmodel) : void 0`).
          bigmodel: { customer_id: "bm_customer_1", access_token: "linked_bm_at" },
        }),
    ]);
    const client = new ZaiCnOAuthClient(impl, async () => {});

    const result = await client.authorize();

    expect(result.provider).toBe("zai_cn");
    expect(result.accessToken).toBe("zai_cn_at");
    expect(result.jwt).toBe("jwt_final");
    expect(result.userId).toBe("user_cn");
    // The bigmodel-family downstream resolves through THIS token, not the zai-side one.
    expect(result.linkedBigModel).toEqual({ customerId: "bm_customer_1", accessToken: "linked_bm_at" });
    expect(calls.length).toBe(3);
    expect(calls[1].url).toBe("https://zcode.z.ai/api/v1/oauth/cli/poll/flow_abc");
  });

  it("a malformed data.bigmodel on a zai-family ready payload rejects (host Rw semantics)", async () => {
    const { impl } = scriptedFetch([
      () => envelopeResponse(initData()),
      () =>
        envelopeResponse({
          status: "ready",
          token: "j",
          user: { user_id: "u" },
          zai: { access_token: "at" },
          bigmodel: { access_token: "only_token_no_customer_id" },
        }),
    ]);
    const client = new ZaiCnOAuthClient(impl, async () => {});
    expect(client.authorize()).rejects.toThrow(/BigModel linked response invalid/);
  });

  it("ready response missing data.zai.access_token rejects naming the folded key + actual payload keys", async () => {
    const { impl } = scriptedFetch([
      () =>
        envelopeResponse(
          initData({ authorize_url: "https://zchat.z.ai/api/oauth/authorize?client_id=c&state=s" }),
        ),
      () =>
        envelopeResponse({ status: "ready", token: "jwt_only", user: { user_id: "u" }, stray: 1 }),
    ]);
    const client = new ZaiCnOAuthClient(impl, async () => {});
    const started = await client.start();
    expect(client.complete(started)).rejects.toThrow(
      /missing data\.zai\.access_token .*payload keys: status, token, user, stray/s,
    );
  });

  it("createPollLoginClient() covers every login flavor", async () => {
    const { impl } = scriptedFetch([() => envelopeResponse(initData())]);
    const zai = createPollLoginClient("zai", impl);
    const zaiCn = createPollLoginClient("zai_cn", impl);
    expect(zai).toBeInstanceOf(ZaiOAuthClient);
    expect(zaiCn).toBeInstanceOf(ZaiCnOAuthClient);
    await Promise.all([zai, zaiCn].map((c) => c.close()));
  });
});
