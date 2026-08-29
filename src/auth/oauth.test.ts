/**
 * Tests for the OAuth login flows.
 *
 * Z.AI uses the server-mediated CLI login (init + poll at zcode.z.ai, 3.10
 * desktop parity — no local callback). Bigmodel keeps the classic auth-code
 * flow (localhost callback + token exchange). All upstream calls are mocked
 * via `fetchImpl` injection.
 *
 * @see _reverse/NOTEPAD.md "Method 1: OAuth Flow"
 */
import { describe, it, expect } from "bun:test";
import { ZaiOAuthClient, BigmodelOAuthClient } from "./oauth.js";

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
});

describe("BigmodelOAuthClient (auth-code flow)", () => {
  it("start() builds the bigmodel.cn authorize URL with appId/redirect/state", async () => {
    const client = new BigmodelOAuthClient();
    const started = await client.start();
    try {
      const url = new URL(started.authorizeUrl);
      expect(url.origin + url.pathname).toBe("https://bigmodel.cn/login");
      expect(url.searchParams.get("appId")).toBe("zcode");
      expect(url.searchParams.get("redirect")).toStartWith("http://127.0.0.1:");
      expect(url.searchParams.get("redirect")).toEndWith("/oauth/callback/bigmodel");
      expect(url.searchParams.get("state") ?? "").toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await client.close();
    }
  });

  it("exchangeCode unwraps the envelope and extracts bigmodel.access_token + jwt + userId", async () => {
    const mockFetch = (async (_input: RequestInfo | URL): Promise<Response> => {
      return envelopeResponse({
        token: "jwt_zcode",
        bigmodel: { access_token: "bm_access_123" },
        user: { user_id: "u1", name: "test" },
      });
    }) as typeof fetch;

    const client = new BigmodelOAuthClient(mockFetch);
    const result = await client.exchangeCode("code_xyz", "http://127.0.0.1:9/callback/bigmodel", "st");
    expect(result.accessToken).toBe("bm_access_123");
    expect(result.jwt).toBe("jwt_zcode");
    expect(result.userId).toBe("u1");
  });

  it("exchangeCode throws when data.bigmodel.access_token is missing", async () => {
    const mockFetch = (async (_input: RequestInfo | URL): Promise<Response> => {
      return envelopeResponse({ token: "jwt_only" });
    }) as typeof fetch;

    const client = new BigmodelOAuthClient(mockFetch);
    expect(client.exchangeCode("code", "redirect", "st")).rejects.toThrow(/data\.bigmodel\.access_token/);
  });

  it("exchangeCode throws on non-zero business code", async () => {
    const mockFetch = (async (_input: RequestInfo | URL): Promise<Response> => {
      return new Response(JSON.stringify({ code: 3004, msg: "invalid_code" }), { status: 200 });
    }) as typeof fetch;

    const client = new BigmodelOAuthClient(mockFetch);
    expect(client.exchangeCode("code", "redirect", "st")).rejects.toThrow(/invalid_code/);
  });

  it("authorize() runs the full flow: callback redirect + token exchange", async () => {
    // Mock fetch only answers the token-exchange POST.
    const exchangeFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toBe("https://zcode.z.ai/api/v1/oauth/token");
      return envelopeResponse({
        token: "jwt_full",
        bigmodel: { access_token: "resolved_token" },
        user: { user_id: "user_42" },
      });
    }) as typeof fetch;

    const client = new BigmodelOAuthClient(exchangeFetch);

    // Simulate the provider redirecting to the localhost callback by hitting
    // the authorize URL's `redirect` + `state` as soon as it is known.
    let capturedUrl = "";
    const result = await client.authorize((url) => {
      capturedUrl = url;
      const parsed = new URL(url);
      const redirectUri = parsed.searchParams.get("redirect") ?? "";
      const state = parsed.searchParams.get("state") ?? "";
      fetch(`${redirectUri}?authCode=code_from_provider&state=${state}`).catch(() => {});
    });

    expect(capturedUrl).toContain("bigmodel.cn/login");
    expect(result.accessToken).toBe("resolved_token");
    expect(result.provider).toBe("bigmodel");
    expect(result.userId).toBe("user_42");
    expect(result.jwt).toBe("jwt_full");
  });
});
