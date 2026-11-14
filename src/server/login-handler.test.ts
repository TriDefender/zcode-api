/**
 * Tests for the /login selection-page backend (login-handler.ts):
 * transport-agnostic API handler + the TUI temporary loopback listener.
 * Upstream OAuth calls are mocked via `fetchImpl` injection into
 * `createPollLoginHost`; the listener smoke test uses a scripted host.
 *
 * @see _reverse/NOTEPAD.md "2026-11-14 增补"
 */
import { describe, it, expect, afterEach } from "bun:test";
import {
  createPollLoginHost,
  handleLoginApi,
  loginPageResponse,
  startLoginServer,
  type LoginFlowHost,
} from "./login-handler.js";

/** Wrap data in the zcode.z.ai `{code, data, msg}` envelope (same shape as oauth.test.ts). */
function envelopeResponse(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify({ code: 0, data, msg: "success" }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function initData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    flow_id: "flow_abc",
    poll_token: "server_poll_token",
    authorize_url: "https://zchat.z.ai/api/oauth/authorize?client_id=c&state=s",
    expires_at: Math.floor(Date.now() / 1000) + 600,
    poll_interval_sec: 2,
    ...overrides,
  };
}

/** Sequential scripted fetch: one handler per call, last one repeats. */
function scriptedFetch(handlers: Array<() => Response>): typeof fetch {
  let n = 0;
  return (async (): Promise<Response> => {
    const handler = handlers[Math.min(n, handlers.length - 1)];
    n += 1;
    return handler();
  }) as unknown as typeof fetch;
}

describe("loginPageResponse", () => {
  it("serves the selection page with the two login cards (bigmodel OAuth deprecated)", () => {
    const page = loginPageResponse();
    expect(page.status).toBe(200);
    expect(page.html).toContain('data-provider="zai"');
    expect(page.html).toContain('data-provider="zai_cn"');
    expect(page.html).not.toContain('data-provider="bigmodel"');
    expect(page.html).toContain("/login/start");
    expect(page.html).toContain("/login/status");
  });
});

describe("handleLoginApi", () => {
  it("POST /login/start rejects a malformed body and an unknown provider", async () => {
    const host = createPollLoginHost({ onTokens: async () => {} });
    try {
      const badJson = await handleLoginApi("POST", "/login/start", async () => "not-json{", host);
      expect(badJson.status).toBe(400);
      expect(badJson.json).toEqual({ ok: false, error: "invalid_json" });

      for (const provider of ["nope", "", "zai_cn_x", "bigmodel", null, undefined, 42]) {
        const r = await handleLoginApi(
          "POST",
          "/login/start",
          async () => JSON.stringify({ provider }),
          host,
        );
        expect(r.status).toBe(400);
        expect(r.json).toEqual({ ok: false, error: "invalid_provider" });
      }
    } finally {
      await host.close();
    }
  });

  it("unknown paths 404 in-band", async () => {
    const host = createPollLoginHost({ onTokens: async () => {} });
    try {
      const r = await handleLoginApi("GET", "/login/other", async () => "", host);
      expect(r.status).toBe(404);
      expect(r.json).toEqual({ ok: false, error: "not_found" });
    } finally {
      await host.close();
    }
  });

  it("drives idle → authorizing → ready across start/status with the terminal phase first", async () => {
    const onTokensProviders: string[] = [];
    const doneResults: Array<{ provider: string; error: string | null }> = [];
    const host = createPollLoginHost({
      onTokens: async (provider) => {
        onTokensProviders.push(provider);
      },
      onDone: (provider, error) => {
        doneResults.push({ provider, error });
      },
      fetchImpl: scriptedFetch([
        () => envelopeResponse(initData()),
        () => envelopeResponse({ status: "pending" }),
      () =>
        envelopeResponse({
          status: "ready",
          token: "jwt_final",
          user: { user_id: "u1" },
          // Family-folded bucket (live-verified 2026-11-14: no data.zai_cn on the wire).
          zai: { access_token: "at_cn" },
        }),
      ]),
      sleep: async () => {},
    });
    try {
      const initial = await handleLoginApi("GET", "/login/status", async () => "", host);
      expect(initial.json).toEqual({ ok: true, phase: "idle" });

      const start = await handleLoginApi(
        "POST",
        "/login/start",
        async () => JSON.stringify({ provider: "zai_cn" }),
        host,
      );
      expect(start.json.ok).toBe(true);
      // The flow's applyInterstitial appends the /app/oauth/login param — the
      // surfaced URL starts with the server-issued authorize_url.
      expect((start.json as { authorizeUrl: string }).authorizeUrl).toStartWith(String(initData().authorize_url));

      const authorizing = await handleLoginApi("GET", "/login/status", async () => "", host);
      expect(authorizing.json).toEqual({ ok: true, phase: "authorizing", provider: "zai_cn" });

      // The background completion resolves on the microtask queue; yield.
      await new Promise((resolve) => setTimeout(resolve, 0));

      const ready = await handleLoginApi("GET", "/login/status", async () => "", host);
      expect(ready.json).toEqual({ ok: true, phase: "ready", provider: "zai_cn" });
      expect(onTokensProviders).toEqual(["zai_cn"]);
      // onDone fires with null error AFTER the terminal status is set.
      expect(doneResults).toEqual([{ provider: "zai_cn", error: null }]);
    } finally {
      await host.close();
    }
  });

  it("a resolver failure surfaces as phase failed with the error message", async () => {
    const host = createPollLoginHost({
      onTokens: async () => {
        throw new Error("z/login failed: 502");
      },
      fetchImpl: scriptedFetch([
        () => envelopeResponse(initData()),
        () =>
          envelopeResponse({
            status: "ready",
            token: "jwt",
            user: { user_id: "u" },
            zai: { access_token: "at" },
          }),
      ]),
      sleep: async () => {},
    });
    try {
      await handleLoginApi("POST", "/login/start", async () => JSON.stringify({ provider: "zai" }), host);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const failed = await handleLoginApi("GET", "/login/status", async () => "", host);
      expect(failed.json).toEqual({ ok: true, phase: "failed", provider: "zai", error: "z/login failed: 502" });
    } finally {
      await host.close();
    }
  });

  it("a second start while authorizing fails in-band without disturbing the flow", async () => {
    // Deadline ~1s out: the flow stays authorizing well past the assertions
    // below, then the complete() loop self-terminates. The injected sleep must
    // be a REAL timer — a resolved-promise sleep in the poll loop starves the
    // macrotask queue (infinite microtask chain) and hangs the test.
    const host = createPollLoginHost({
      onTokens: async () => {},
      fetchImpl: scriptedFetch([
        () => envelopeResponse(initData({ expires_at: Math.floor(Date.now() / 1000) + 1 })),
        () => envelopeResponse({ status: "pending" }),
      ]),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    try {
      const first = await handleLoginApi("POST", "/login/start", async () => JSON.stringify({ provider: "zai" }), host);
      expect(first.json.ok).toBe(true);
      expect((first.json as { authorizeUrl: string }).authorizeUrl).toStartWith(String(initData().authorize_url));

      const second = await handleLoginApi("POST", "/login/start", async () => JSON.stringify({ provider: "zai_cn" }), host);
      expect(second.status).toBe(200);
      expect(second.json).toEqual({ ok: false, error: "login_already_in_progress" });

      const status = await handleLoginApi("GET", "/login/status", async () => "", host);
      expect((status.json as { phase: string }).phase).toBe("authorizing");
      expect((status.json as { provider?: string }).provider).toBe("zai");
    } finally {
      await host.close();
    }
  });
});

describe("startLoginServer (TUI temporary loopback listener)", () => {
  const handles: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    while (handles.length > 0) {
      await handles.pop()?.close();
    }
  });

  it("serves the page, routes the flow API, and 404s unknown paths", async () => {
    const host: LoginFlowHost = {
      start: async (provider) => ({ authorizeUrl: `https://example.com/authorize?provider=${provider}` }),
      status: async () => ({ phase: "authorizing", provider: "zai_cn" }),
    };
    const server = await startLoginServer(host);
    handles.push(server);
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/login`);

    const page = await fetch(server.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('data-provider="zai_cn"');

    // `/` redirects to the same page content (plain GET / serves the HTML too).
    const root = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(root.status).toBe(200);
    expect(await root.text()).toContain("ZCode Proxy");

    const start = await fetch(`http://127.0.0.1:${server.port}/login/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "zai_cn" }),
    });
    expect(start.status).toBe(200);
    expect(await start.json()).toEqual({ ok: true, authorizeUrl: "https://example.com/authorize?provider=zai_cn" });

    const status = await fetch(`http://127.0.0.1:${server.port}/login/status`);
    expect(await status.json()).toEqual({ ok: true, phase: "authorizing", provider: "zai_cn" });

    const missing = await fetch(`http://127.0.0.1:${server.port}/login/other`);
    expect(missing.status).toBe(404);
  });

  it("close() releases the port", async () => {
    const host: LoginFlowHost = {
      start: async () => ({ authorizeUrl: "https://example.com/x" }),
      status: async () => ({ phase: "idle" }),
    };
    const server = await startLoginServer(host);
    await server.close();
    let refused = false;
    try {
      await fetch(server.url);
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  });
});
