/**
 * Integration wiring tests: highspeed card application inside `proxyRequest`
 * (injected manager), covering model rewrite + auth swap + unsigned dispatch,
 * and the selectionFallback redispatch after a card rejection.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { proxyRequest } from "./handler.js";
import type { ProxyConfig, ProxyIdentity } from "../config/types.js";
import { AuthManager } from "../auth/manager.js";
import { HighspeedManager } from "../highspeed/manager.js";
import {
  __resetHighspeedProviderConfigForTests,
  __setProviderConfigFetchForTests,
  warmHighspeedProviderConfig,
} from "../highspeed/provider-config.js";
import { ClientSigningManager } from "./client-signing.js";

const IDENTITY: ProxyIdentity = {
  appVersion: "3.15.1",
  sourceTitle: "cli",
  refererOrigin: "https://zcode.z.ai",
};

const TEST_CONFIG: ProxyConfig = {
  server: { port: 8080, host: "0.0.0.0" },
  auth: {},
  provider: "zai",
  plan: "coding-plan",
  providers: {
    zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
    bigmodel: { anthropicBase: "https://open.bigmodel.cn/api/anthropic", openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
  },
  defaultModel: "glm-4.6",
  models: ["glm-4.6"],
  identity: IDENTITY,
  clientIdentity: { mode: "off", ttlSeconds: 900, maxSessions: 1024 },
  responses: { enabled: true, storeMaxEntries: 1000, storeTtlMs: 86400000 },
  endpointRouting: { enabled: false, origin: "https://zcode.z.ai" },
  clientSigning: { enabled: false },
  highspeed: { enabled: false, origin: "https://zcode.z.ai", models: [] },
  mcp: { enabled: true, webSearch: true, webReader: false, zread: false, gateway: { enabled: true, upstreamOrigin: "https://zcode.chatglm.site" } },
  async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },
  claim: { enabled: false, auto: true, origin: "https://zcode.z.ai", pollIntervalMs: 300000, cooldownMs: 600000, planId: "" },
  logging: { level: "info" },
};

const CRED = "testkey.testsecret";
const JWT = "test-zcode-jwt";
const liveManagers: HighspeedManager[] = [];
afterEach(() => {
  for (const manager of liveManagers.splice(0)) manager.stop();
});

function oauthAuth(key = CRED): AuthManager {
  const [apiKey, secret] = key.split(".");
  const auth = new AuthManager();
  auth.setOAuthCredential({ apiKey, secret, provider: "zai", jwt: JWT });
  return auth;
}

function anthropicClientReq(): Request {
  return new Request("http://localhost:8080/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "glm-5.1", max_tokens: 32, messages: [{ role: "user", content: "hi" }] }),
  });
}

function anthropicOk(): Response {
  return new Response(
    JSON.stringify({
      id: "msg_wire", type: "message", role: "assistant", model: "glm-5.3-highspeed",
      content: [{ type: "text", text: "Hi" }], stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Manager pre-loaded with an active card (draw already settled). */
async function cardHoldingManager(): Promise<HighspeedManager> {
  const now = Date.now();
  const manager = new HighspeedManager({
    origin: "https://zcode.z.ai",
    models: ["glm-5.3", "glm-5.2", "glm-5.1"],
    fetchImpl: (async () => new Response(JSON.stringify({
      code: 0, msg: "success",
      data: {
        card: { card_id: "hsc_wiring_1", task_id: "t-1", provider: "builtin:zai-coding-plan", model: "glm-5.3-highspeed", issued_at: now, expires_at: now + 300_000 },
        next_draw_at: now + 120_000,
      },
    }), { status: 200 })) as unknown as typeof fetch,
  });
  liveManagers.push(manager);
  manager.onRequest("glm-5.1", "t-1", { jwt: JWT, codingPlanAuth: CRED, family: "zai" });
  await new Promise((r) => setTimeout(r, 5));
  expect(manager.activeCard()?.cardId).toBe("hsc_wiring_1");
  return manager;
}

/** Signer whose fetch records every call — proves carded requests never even attempt a handshake. */
function recordingSigner(calls: string[]): ClientSigningManager {
  return new ClientSigningManager({
    fetchImpl: (async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      throw new Error(`unexpected signing fetch: ${url}`);
    }) as unknown as typeof fetch,
  });
}

describe("proxyRequest highspeed wiring", () => {
  it("does not extend the old account's draw loop after switching to a credential without JWT", async () => {
    const clock = { now: 1_000_000 };
    let draws = 0;
    let finishIdleCheck!: (stopped: boolean) => void;
    const idleStopped = new Promise<boolean>((resolve) => { finishIdleCheck = resolve; });
    const manager = new HighspeedManager({
      origin: "https://zcode.z.ai",
      models: ["glm-5.1"],
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
    manager.onRequest("glm-5.1", "old-task", { jwt: JWT, codingPlanAuth: CRED, family: "zai" });
    expect(draws).toBe(1);

    // The serve panel can reload a coding-plan-only --import credential while
    // the process-wide manager still holds the previous account's draw params.
    const switchedAuth = oauthAuth();
    switchedAuth.setOAuthCredential({ apiKey: "imported-key", provider: "zai" });
    clock.now += 4 * 60_000;
    const response = await proxyRequest(anthropicClientReq(), "anthropic", {
      config: TEST_CONFIG, auth: switchedAuth, highspeed: manager,
      endpointRouting: null, clientSigning: null,
      fetchImpl: (async () => anthropicOk()) as unknown as typeof fetch,
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

  it("rewrites the model, reroutes to the highspeed endpoint, swaps auth to the JWT set, adds the card header, and skips signing", async () => {
    const manager = await cardHoldingManager();
    const upstreamCalls: { url: string; headers: Headers; body: string }[] = [];
    const signingFetches: string[] = [];

    const resp = await proxyRequest(anthropicClientReq(), "anthropic", {
      config: TEST_CONFIG,
      auth: oauthAuth(),
      fetchImpl: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(String(input), init);
        upstreamCalls.push({ url: req.url, headers: req.headers, body: await req.clone().text() });
        return anthropicOk();
      }, { preconnect: () => {} }) as unknown as typeof fetch,
      endpointRouting: null,
      clientSigning: recordingSigner(signingFetches),
      highspeed: manager,
    });

    expect(resp.status).toBe(200);
    expect(upstreamCalls.length).toBe(1);
    const call = upstreamCalls[0]!;
    // model rewritten to the card model
    expect(JSON.parse(call.body).model).toBe("glm-5.3-highspeed");
    // URL rerouted to the dedicated highspeed inference endpoint (NOT the
    // coding-plan provider URL — zcode-builtin providerRules rev 31+)
    expect(call.url).toBe("https://zcode.z.ai/api/v1/highspeed/anthropic/v1/messages");
    // coding-plan dual auth replaced by the JWT set + card headers
    expect(call.headers.get("x-api-key")).toBe(JWT);
    expect(call.headers.get("authorization")).toBe(`Bearer ${JWT}`);
    expect(call.headers.get("x-bigmodel-authorization")).toBe(`Bearer ${CRED}`);
    expect(call.headers.get("bigmodel-target-type")).toBe("PERSONAL");
    expect(call.headers.get("x-highspeed-card-id")).toBe("hsc_wiring_1");
    // official static rule: highspeed-mode requests are never signed — the
    // signer was never even consulted (no handshake fetch attempted)
    expect(signingFetches.length).toBe(0);
    expect(call.headers.get("x-client-sig")).toBeNull();
  });

  it("mounts on the CDN-resolved base when the remote provider-config snapshot overrides it", async () => {
    // Seed the module-level snapshot via the test fetch seam (client/configs →
    // CDN two-stage, never the network); try/finally resets it — bun runs
    // test files in one process, a leaked snapshot would reroute other files'
    // carded assertions.
    __setProviderConfigFetchForTests((async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      return url.includes("/api/v1/client/configs")
        ? jsonResponse({ data: { configs: { builtin_provider_config_json: "https://cdn.example.test/builtin.json" } } })
        : jsonResponse({ config: { providerConfigRules: { providerRules: [
          { providerId: "account:zai-highspeed-card", config: { api: { baseUrl: "https://moved.example.test/hs/anthropic" } } },
        ] } } });
    }) as unknown as typeof fetch);
    try {
      await warmHighspeedProviderConfig({ origin: "https://zcode.z.ai", appVersion: IDENTITY.appVersion });
      const manager = await cardHoldingManager();
      const upstreamCalls: { url: string }[] = [];
      const resp = await proxyRequest(anthropicClientReq(), "anthropic", {
        config: TEST_CONFIG,
        auth: oauthAuth(),
        fetchImpl: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
          const req = input instanceof Request ? input : new Request(String(input), init);
          upstreamCalls.push({ url: req.url });
          return anthropicOk();
        }, { preconnect: () => {} }) as unknown as typeof fetch,
        endpointRouting: null,
        clientSigning: null,
        highspeed: manager,
      });
      expect(resp.status).toBe(200);
      // remote snapshot wins over the pinned default for the zai family
      expect(upstreamCalls[0]!.url).toBe("https://moved.example.test/hs/anthropic/v1/messages");
    } finally {
      __resetHighspeedProviderConfigForTests();
      __setProviderConfigFetchForTests(null);
    }
  });

  it("falls back to the original model and normal auth after a card rejection (401)", async () => {
    const manager = await cardHoldingManager();
    const upstreamCalls: { url: string; headers: Headers; body: string }[] = [];

    const resp = await proxyRequest(anthropicClientReq(), "anthropic", {
      config: TEST_CONFIG,
      auth: oauthAuth(),
      fetchImpl: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(String(input), init);
        upstreamCalls.push({ url: req.url, headers: req.headers, body: await req.clone().text() });
        return upstreamCalls.length === 1
          ? new Response(JSON.stringify({ msg: "VERIFY_SIGNATURE_INVALID" }), { status: 401 })
          : anthropicOk();
      }, { preconnect: () => {} }) as unknown as typeof fetch,
      endpointRouting: null,
      clientSigning: null,
      highspeed: manager,
    });

    expect(resp.status).toBe(200);
    expect(upstreamCalls.length).toBe(2);
    // first: carded — dedicated highspeed endpoint
    expect(upstreamCalls[0]!.headers.get("x-highspeed-card-id")).toBe("hsc_wiring_1");
    expect(upstreamCalls[0]!.url).toBe("https://zcode.z.ai/api/v1/highspeed/anthropic/v1/messages");
    expect(JSON.parse(upstreamCalls[0]!.body).model).toBe("glm-5.3-highspeed");
    // fallback: original model, provider URL, normal coding-plan dual auth, no card header
    expect(upstreamCalls[1]!.url).toBe("https://api.z.ai/api/anthropic/v1/messages");
    expect(upstreamCalls[1]!.headers.get("x-highspeed-card-id")).toBeNull();
    expect(upstreamCalls[1]!.headers.get("x-api-key")).toBe(CRED);
    expect(upstreamCalls[1]!.headers.get("authorization")).toBe(`Bearer ${CRED}`);
    expect(JSON.parse(upstreamCalls[1]!.body).model).toBe("glm-5.1");
    // card dropped; the active session re-ignites the loop and the always-hit
    // draw mock hands back a fresh card (2026-10-12 max-rate loop contract)
    await new Promise((r) => setTimeout(r, 5));
    expect(manager.activeCard()?.cardId).toBe("hsc_wiring_1");
  });

  it("keeps card headers on connect-retry rebuilds (attempt ≥ 2 rebuilds from the swapped pairs)", async () => {
    const manager = await cardHoldingManager();
    const upstreamCalls: { url: string; headers: Headers; body: string }[] = [];
    let attempts = 0;

    const resp = await proxyRequest(anthropicClientReq(), "anthropic", {
      config: TEST_CONFIG,
      auth: oauthAuth(),
      fetchImpl: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        attempts++;
        if (attempts === 1) throw new Error("Unable to connect");
        const req = input instanceof Request ? input : new Request(String(input), init);
        upstreamCalls.push({ url: req.url, headers: req.headers, body: await req.clone().text() });
        return anthropicOk();
      }, { preconnect: () => {} }) as unknown as typeof fetch,
      endpointRouting: null,
      clientSigning: null,
      highspeed: manager,
    });

    expect(resp.status).toBe(200);
    expect(attempts).toBe(2);
    expect(upstreamCalls.length).toBe(1);
    // the retried request must still carry the full carded auth set + card model
    expect(upstreamCalls[0]!.headers.get("x-highspeed-card-id")).toBe("hsc_wiring_1");
    expect(upstreamCalls[0]!.headers.get("x-api-key")).toBe(JWT);
    expect(upstreamCalls[0]!.headers.get("x-bigmodel-authorization")).toBe(`Bearer ${CRED}`);
    expect(JSON.parse(upstreamCalls[0]!.body).model).toBe("glm-5.3-highspeed");
    // …and stay on the rerouted highspeed URL (upstreamReq.url is reused as-is)
    expect(upstreamCalls[0]!.url).toBe("https://zcode.z.ai/api/v1/highspeed/anthropic/v1/messages");
  });

  it("leaves requests untouched when the model is not eligible", async () => {
    const base = await cardHoldingManager();
    let noteActivityCalls = 0;
    // Object.create wrapper (NOT Object.assign): mutating base in place would
    // rebind base.noteActivity to the spy itself → infinite recursion.
    const manager = Object.create(base) as HighspeedManager;
    manager.noteActivity = () => {
      noteActivityCalls += 1;
      base.noteActivity();
    };
    const upstreamCalls: { url: string; headers: Headers; body: string }[] = [];

    const resp = await proxyRequest(new Request("http://localhost:8080/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6", max_tokens: 32, messages: [{ role: "user", content: "hi" }] }),
    }), "anthropic", {
      config: TEST_CONFIG,
      auth: oauthAuth(),
      fetchImpl: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(String(input), init);
        upstreamCalls.push({ url: req.url, headers: req.headers, body: await req.clone().text() });
        return anthropicOk();
      }, { preconnect: () => {} }) as unknown as typeof fetch,
      endpointRouting: null,
      clientSigning: null,
      highspeed: manager,
    });

    expect(resp.status).toBe(200);
    expect(upstreamCalls.length).toBe(1);
    // uncarded traffic keeps the provider URL (no highspeed reroute)
    expect(upstreamCalls[0]!.url).toBe("https://api.z.ai/api/anthropic/v1/messages");
    expect(upstreamCalls[0]!.headers.get("x-highspeed-card-id")).toBeNull();
    expect(upstreamCalls[0]!.headers.get("x-api-key")).toBe(CRED);
    expect(JSON.parse(upstreamCalls[0]!.body).model).toBe("glm-4.6");
    // §H eligibility gate: in-flight activity must not re-arm the draw loop
    // for traffic that can never mount a card (idle-window invariant).
    expect(noteActivityCalls).toBe(0);
    base.stop();
  });

  it("notifies in-flight activity for an eligible model after the response completes", async () => {
    const base = await cardHoldingManager();
    let noteActivityCalls = 0;
    const manager = Object.create(base) as HighspeedManager;
    manager.noteActivity = () => {
      noteActivityCalls += 1;
      base.noteActivity();
    };

    const resp = await proxyRequest(anthropicClientReq(), "anthropic", {
      config: TEST_CONFIG,
      auth: oauthAuth(),
      fetchImpl: Object.assign(async () => anthropicOk(), { preconnect: () => {} }) as unknown as typeof fetch,
      endpointRouting: null,
      clientSigning: null,
      highspeed: manager,
    });

    expect(resp.status).toBe(200);
    expect(noteActivityCalls).toBe(1);
    base.stop();
  });
});
