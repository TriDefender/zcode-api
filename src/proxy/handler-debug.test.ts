/**
 * Tests for the `debug` flag on `ProxyHandlerOptions`. Verifies that when
 * `debug: true` the handler emits per-request diagnostic lines, and that
 * the flag defaults to off (no extra output).
 */
import { describe, it, expect } from "bun:test";
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
  logging: { level: "info" },
};

function makeClientReq(body: string): Request {
  return new Request("http://localhost:8080/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

function mockFetch(impl: (req: Request) => Promise<Response>): typeof fetch {
  return Object.assign(impl, { preconnect: () => {} }) as typeof fetch;
}

async function captureConsoleLog(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines;
}

function anthropicOk(): Response {
  return new Response(
    JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Hi" }],
      model: "glm-4.6",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("proxyRequest debug mode", () => {
  it("emits debug lines when debug=true (upstream URL, headers, response status)", async () => {
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeClientReq('{"model":"glm-4.6","messages":[{"role":"user","content":"Hi"}]}');

    const lines = await captureConsoleLog(async () => {
      const resp = await proxyRequest(clientReq, "anthropic", {
        config: TEST_CONFIG,
        auth,
        debug: true,
        fetchImpl: mockFetch(async () => anthropicOk()),
      });
      expect(resp.status).toBe(200);
    });

    const debugLines = lines.filter((l) => l.includes(" debug: "));
    expect(debugLines.length).toBeGreaterThan(0);
    expect(debugLines.some((l) => l.includes("→ POST https://api.z.ai/api/anthropic/v1/messages"))).toBe(true);
    expect(debugLines.some((l) => l.includes("← 200"))).toBe(true);
  });

  it("redacts sensitive request headers (x-api-key) in debug output", async () => {
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeClientReq('{"model":"glm-4.6","messages":[]}');

    const lines = await captureConsoleLog(async () => {
      await proxyRequest(clientReq, "anthropic", {
        config: TEST_CONFIG,
        auth,
        debug: true,
        fetchImpl: mockFetch(async () => anthropicOk()),
      });
    });

    const headerLine = lines.find((l) => l.includes("debug:") && l.includes("x-api-key="));
    expect(headerLine).toBeDefined();
    expect(headerLine!).toContain("x-api-key=testke...cret");
    expect(headerLine!).not.toContain("testkey.testsecret");
  });

  it("does not emit debug lines when debug is omitted (default off)", async () => {
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeClientReq('{"model":"glm-4.6","messages":[]}');

    const lines = await captureConsoleLog(async () => {
      await proxyRequest(clientReq, "anthropic", {
        config: TEST_CONFIG,
        auth,
        fetchImpl: mockFetch(async () => anthropicOk()),
      });
    });

    const debugLines = lines.filter((l) => l.includes(" debug: "));
    expect(debugLines.length).toBe(0);
  });

  it("emits ERROR debug line on upstream failure", async () => {
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeClientReq('{"model":"glm-4.6","messages":[]}');

    const lines = await captureConsoleLog(async () => {
      const resp = await proxyRequest(clientReq, "anthropic", {
        config: TEST_CONFIG,
        auth,
        debug: true,
        fetchImpl: mockFetch(async () => { throw new Error("ECONNREFUSED"); }),
      });
      expect(resp.status).toBe(502);
    });

    expect(lines.some((l) => l.includes("debug: ERROR upstream_unreachable: ECONNREFUSED"))).toBe(true);
  });

  it("emits translation note when client format is OpenAI", async () => {
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = new Request("http://localhost:8080/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "glm-4.6",
        messages: [{ role: "user", content: "Hi" }],
      }),
    });

    const lines = await captureConsoleLog(async () => {
      await proxyRequest(clientReq, "openai", {
        config: TEST_CONFIG,
        auth,
        debug: true,
        fetchImpl: mockFetch(async () => anthropicOk()),
      });
    });

    expect(lines.some((l) => l.includes("debug: translated OpenAI→Anthropic"))).toBe(true);
  });
});
