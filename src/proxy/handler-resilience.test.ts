/**
 * Tests for the two resilience behaviors added after the PR #34 review:
 *
 * 1. In-body captcha challenge detection: a start-plan upstream response with
 *    HTTP 400 + {"code":3007,...} in the JSON body (no captcha header) must
 *    be treated as a captcha challenge and retried with a fresh token.
 * 2. Connect-retry freshness: after a connect-level failure, the retried
 *    dispatch must receive a FRESH Request (body not marked used). A mock
 *    fetch that throws-then-succeeds does NOT catch the bug (mocks don't
 *    enforce bodyUsed), so the mock asserts `req.bodyUsed === false` on
 *    every call per the review's test note.
 *
 * Both tests use the start-plan path with an injected captcha module via
 * `mock.module("./captcha.js")` (same technique as captcha-pool.test.ts).
 */
import { describe, it, expect, mock } from "bun:test";
import { proxyRequest } from "./handler.js";
import type { ProxyConfig, ProxyIdentity } from "../config/types.js";
import { AuthManager } from "../auth/manager.js";

const IDENTITY: ProxyIdentity = {
  appVersion: "test-1.0.0",
  sourceTitle: "cli",
  refererOrigin: "https://zcode.z.ai",
};

const TEST_CONFIG: ProxyConfig = {
  server: { port: 8080, host: "0.0.0.0" },
  auth: { mode: "apikey", apiKey: "testk...ret" },
  provider: "zai",
  plan: "start-plan",
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

const GATEWAY_URL = "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages";

const ANTHROPIC_OK = JSON.stringify({
  id: "msg_resilience",
  type: "message",
  role: "assistant",
  model: "glm-4.6",
  content: [{ type: "text", text: "resilience reply" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 5, output_tokens: 3 },
});

describe("proxyRequest — start-plan resilience (PR #34 review P1/P3)", () => {
  it("retries an in-body 3007 captcha challenge with a fresh token", async () => {
    // Mock the captcha module: config enabled, token take returns distinct
    // tokens per call so we can assert the retry used a FRESH token.
    let tokenSeq = 0;
    mock.module("./captcha.js", () => ({
      detectCaptchaChallenge: (resp: Response): string | null => {
        const v = resp.headers.get("x-aliyun-captcha-verify-param");
        return v && v.trim().length > 0 ? v.trim() : null;
      },
      getCaptchaToken: async (_appVersion: string) => {
        tokenSeq += 1;
        return { verifyParam: `tok-${tokenSeq}`, region: "sgp" };
      },
      RETRY_HEADERS: { PARAM: "x-aliyun-captcha-verify-param", REGION: "x-aliyun-captcha-verify-region" },
    }));

    // Upstream: first call = HTTP 400 with {"code":3007} in the body (no
    // captcha header), second call = success. The mock also records the
    // captcha header of each call so we can assert the retry used a FRESH
    // token (tok-2, not the consumed tok-1).
    const seenCaptchaHeaders: (string | null)[] = [];
    let calls = 0;
    const fetchMock = mock(async (req: Request): Promise<Response> => {
      if (req.url.includes("/client/configs")) {
        return new Response(JSON.stringify({ data: { configs: { captcha: { enabled: true } } } }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      calls += 1;
      seenCaptchaHeaders.push(req.headers.get("x-aliyun-captcha-verify-param"));
      if (calls === 1) {
        return new Response(JSON.stringify({ code: 3007, msg: "captcha verify failed" }), {
          status: 400, headers: { "content-type": "application/json" },
        });
      }
      return new Response(ANTHROPIC_OK, { status: 200, headers: { "content-type": "application/json" } });
    });

    const auth = new AuthManager({ mode: "oauth", provider: "zai" });
    auth.setOAuthCredential({ apiKey: "key-mock", provider: "zai", jwt: "jwt-mock" });
    const clientReq = new Request("http://localhost:8080/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"model":"glm-4.6","messages":[{"role":"user","content":"hi"}]}',
    });

    const resp = await proxyRequest(clientReq, "openai", { config: TEST_CONFIG, auth, fetchImpl: fetchMock as any });

    // The in-body 3007 challenge was detected and retried with a fresh token.
    expect(calls).toBe(2);
    expect(seenCaptchaHeaders[0]).toBe("tok-1");
    expect(seenCaptchaHeaders[1]).toBe("tok-2");
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.choices[0].message.content).toBe("resilience reply");
  });

  it("retries a connect failure with a FRESH Request (body not marked used)", async () => {
    // Upstream: first call = connect-level failure (the bug shape), second
    // call = success. The mock asserts req.bodyUsed === false on EVERY call
    // per the review's test note: mocks don't enforce bodyUsed the way real
    // fetch does, so the freshness assertion must be explicit.
    let calls = 0;
    const fetchMock = mock(async (req: Request): Promise<Response> => {
      calls += 1;
      // The freshness assertion: if the handler re-dispatched the SAME
      // Request object, this would be true on the second call.
      expect(req.bodyUsed).toBe(false);
      if (calls === 1) {
        throw new Error("Unable to connect. Is the computer able to access the url?");
      }
      return new Response(ANTHROPIC_OK, { status: 200, headers: { "content-type": "application/json" } });
    });

    const auth = new AuthManager({ mode: "oauth", provider: "zai" });
    auth.setOAuthCredential({ apiKey: "key-mock", provider: "zai", jwt: "jwt-mock" });
    const clientReq = new Request("http://localhost:8080/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"model":"glm-4.6","messages":[{"role":"user","content":"hi"}]}',
    });

    const resp = await proxyRequest(clientReq, "openai", { config: TEST_CONFIG, auth, fetchImpl: fetchMock as any });

    // The connect failure was retried with a FRESH Request (bodyUsed false
    // on the second call — the freshness assertion inside the mock passed).
    expect(calls).toBe(2);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.choices[0].message.content).toBe("resilience reply");
  });
});
