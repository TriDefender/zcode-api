/**
 * Integration wiring tests: endpoint routing rewrite + client signing applied
 * inside `proxyRequest` (via the injected DI overrides), with the fetch mock
 * capturing the final upstream URL and headers.
 */
import { describe, it, expect } from "bun:test";
import { hkdfSync } from "node:crypto";
import { proxyRequest } from "./handler.js";
import type { ProxyConfig, ProxyIdentity } from "../config/types.js";
import { AuthManager } from "../auth/manager.js";
import { EndpointRoutingService } from "./endpoint-routing.js";
import { ClientSigningManager } from "./client-signing.js";

const IDENTITY: ProxyIdentity = {
  appVersion: "3.8.1",
  sourceTitle: "cli",
  refererOrigin: "https://zcode.z.ai",
};

const TEST_CONFIG: ProxyConfig = {
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
  clientIdentity: { mode: "off", ttlSeconds: 900, maxSessions: 1024 },
  responses: { enabled: true, storeMaxEntries: 1000, storeTtlMs: 86400000 },
  endpointRouting: { enabled: false, origin: "https://zcode.z.ai" },
  clientSigning: { enabled: false, origin: "https://zcode.z.ai" },
  mcp: { enabled: true, webSearch: true, webReader: false, zread: false },
  async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },
  claim: { enabled: false, auto: true, origin: "https://zcode.z.ai", pollIntervalMs: 300000, cooldownMs: 600000, planId: "" },
  logging: { level: "info" },
};

const CRED = "testkey.testsecret";
const LLM_URL = "https://api.z.ai/api/anthropic/v1/messages";
const ULTRA_URL = "https://zcode.z.ai/api/v1/ultra-zai/anthropic/v1/messages";

function anthropicClientReq(extraHeaders?: Record<string, string>): Request {
  return new Request("http://localhost:8080/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify({ model: "glm-4.6", max_tokens: 32, messages: [{ role: "user", content: "hi" }] }),
  });
}

function anthropicOk(): Response {
  return new Response(
    JSON.stringify({
      id: "msg_wire",
      type: "message",
      role: "assistant",
      model: "glm-4.6",
      content: [{ type: "text", text: "Hi" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function routingMock(): EndpointRoutingService {
  return new EndpointRoutingService({
    identity: IDENTITY,
    fetchImpl: (async () => new Response(JSON.stringify({
      code: 0,
      data: { proxyEndpoint: { mapping: [{ from: LLM_URL, to: ULTRA_URL }] } },
    }), { status: 200 })) as unknown as typeof fetch,
  });
}

async function buildSigningManagerFixture(): Promise<{ manager: ClientSigningManager; publicKeyRaw: Uint8Array<ArrayBuffer> }> {
  const keyPair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
  const publicKeyRaw = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));

  // plaintext is base64(pkcs8 DER) — see client-signing.test.ts for the bundle reference
  let pkcs8Binary = "";
  for (const b of pkcs8) pkcs8Binary += String.fromCharCode(b);
  const plainBytes = new TextEncoder().encode(btoa(pkcs8Binary));

  const aesBits = Buffer.from(hkdfSync("sha256", Buffer.from("testsecret"), Buffer.from("WD_CLIENT_SIGN_KDF_SALT"), Buffer.from("ed25519_priv"), 32));
  const aesKey = await crypto.subtle.importKey("raw", new Uint8Array(aesBits), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode("testkey"), tagLength: 128 },
    aesKey,
    plainBytes,
  ));
  const combined = new Uint8Array(iv.length + encrypted.length);
  combined.set(iv);
  combined.set(encrypted, iv.length);
  let cipherBinary = "";
  for (const b of combined) cipherBinary += String.fromCharCode(b);

  const manager = new ClientSigningManager({
    identity: IDENTITY,
    fetchImpl: (async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/api/v1/agent/configs")) {
        return new Response(JSON.stringify({ code: 0, data: { codingPlanSignature: { enable: true } } }), { status: 200 });
      }
      if (url.endsWith("/api/paas/c1f3a7e2/v2/client")) {
        return new Response(JSON.stringify({ code: 200, data: { privateCipher: btoa(cipherBinary) } }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch,
  });
  return { manager, publicKeyRaw };
}

describe("proxyRequest endpoint-routing + client-signing wiring", () => {
  it("sends the rewritten URL and signing headers to the upstream fetch", async () => {
    const { manager, publicKeyRaw } = await buildSigningManagerFixture();
    let capturedUrl = "";
    let capturedHeaders: Headers | undefined;

    const resp = await proxyRequest(anthropicClientReq(), "anthropic", {
      config: TEST_CONFIG,
      auth: new AuthManager({ mode: "apikey", provider: "zai", apiKey: CRED }),
      fetchImpl: Object.assign(async (input: RequestInfo | URL) => {
        capturedUrl = String(input instanceof Request ? input.url : input);
        capturedHeaders = input instanceof Request ? input.headers : new Headers();
        return anthropicOk();
      }, { preconnect: () => {} }) as typeof fetch,
      endpointRouting: routingMock(),
      clientSigning: manager,
    });

    expect(resp.status).toBe(200);
    expect(capturedUrl).toBe(ULTRA_URL);
    expect(capturedHeaders!.get("x-client-sig")).toBeDefined();
    expect(capturedHeaders!.get("x-app-id")).toBe("zcode");
    expect(capturedHeaders!.get("x-client-version")).toBe("3.8.1");
    expect(capturedHeaders!.get("x-client-pow")).toMatch(/^[0-9a-f]{32}$/);

    // signature verifies with the handshake public key over the exact signed message
    const verifyKey = await crypto.subtle.importKey("raw", publicKeyRaw, "Ed25519", false, ["verify"]);
    const message = `testkey\n${capturedHeaders!.get("x-client-ts")}\n3.8.1\n${capturedHeaders!.get("x-session-id")}\n${capturedHeaders!.get("x-client-nonce")}`;
    const sigBytes = Uint8Array.from(atob(capturedHeaders!.get("x-client-sig")!), (ch) => ch.charCodeAt(0));
    expect(await crypto.subtle.verify("Ed25519", verifyKey, sigBytes, new TextEncoder().encode(message))).toBeTrue();
  });

  it("keeps the original URL and unsigned headers when both features are disabled via null overrides", async () => {
    let capturedUrl = "";
    let capturedHeaders: Headers | undefined;
    const resp = await proxyRequest(anthropicClientReq({
      "X-Client-Sig": "spoofed",
      "X-Client-Pow": "spoofed",
      "X-App-Id": "spoofed",
    }), "anthropic", {
      config: TEST_CONFIG,
      auth: new AuthManager({ mode: "apikey", provider: "zai", apiKey: CRED }),
      fetchImpl: Object.assign(async (input: RequestInfo | URL) => {
        capturedUrl = String(input instanceof Request ? input.url : input);
        capturedHeaders = input instanceof Request ? input.headers : new Headers();
        return anthropicOk();
      }, { preconnect: () => {} }) as typeof fetch,
      endpointRouting: null,
      clientSigning: null,
    });
    expect(resp.status).toBe(200);
    expect(capturedUrl).toBe(LLM_URL);
    expect(capturedHeaders!.get("x-client-sig")).toBeNull();
    expect(capturedHeaders!.get("x-client-pow")).toBeNull();
    expect(capturedHeaders!.get("x-app-id")).toBeNull();
  });
});
