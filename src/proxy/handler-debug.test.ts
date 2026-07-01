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
  clientIdentity: { mode: "observe", ttlSeconds: 900, maxSessions: 1024 },
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

function openaiOk(): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl_debug",
      object: "chat.completion",
      model: "glm-4.6",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hi" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
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
        fetchImpl: mockFetch(async () => openaiOk()),
      });
      expect(resp.status).toBe(200);
    });

    const debugLines = lines.filter((l) => l.includes(" debug: "));
    expect(debugLines.length).toBeGreaterThan(0);
    expect(debugLines.some((l) => l.includes("translated Anthropic→OpenAI"))).toBe(true);
    expect(debugLines.some((l) => l.includes("→ POST https://api.z.ai/api/coding/paas/v4/chat/completions"))).toBe(true);
    expect(debugLines.some((l) => l.includes("← 200"))).toBe(true);
  });

  it("redacts sensitive request headers (authorization) in debug output", async () => {
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeClientReq('{"model":"glm-4.6","messages":[]}');

    const lines = await captureConsoleLog(async () => {
      await proxyRequest(clientReq, "anthropic", {
        config: TEST_CONFIG,
        auth,
        debug: true,
        fetchImpl: mockFetch(async () => openaiOk()),
      });
    });

    const headerLine = lines.find((l) => l.includes("debug:") && l.includes("authorization="));
    expect(headerLine).toBeDefined();
    expect(headerLine!).toContain("authorization=Bearer <redacted>");
    expect(headerLine!).not.toContain("testkey.testsecret");
  });

  it("does not emit debug lines when debug is omitted (default off)", async () => {
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeClientReq('{"model":"glm-4.6","messages":[]}');

    const lines = await captureConsoleLog(async () => {
      await proxyRequest(clientReq, "anthropic", {
        config: TEST_CONFIG,
        auth,
        fetchImpl: mockFetch(async () => openaiOk()),
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

  it("does not emit translation note when client format is OpenAI", async () => {
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
        fetchImpl: mockFetch(async () => openaiOk()),
      });
    });

    expect(lines.some((l) => l.includes("debug: translated OpenAI→Anthropic"))).toBe(false);
    expect(lines.some((l) => l.includes("debug: translated Anthropic→OpenAI"))).toBe(false);
    expect(lines.some((l) => l.includes("→ POST https://api.z.ai/api/coding/paas/v4/chat/completions"))).toBe(true);
  });

  it("emits observe-only client identity inference without stabilizing x-session-id", async () => {
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const body = '{"model":"glm-4.6","messages":[{"role":"user","content":"Hi"}]}';
    const seenSessions: string[] = [];

    const lines = await captureConsoleLog(async () => {
      for (let i = 0; i < 2; i++) {
        const resp = await proxyRequest(makeClientReq(body), "anthropic", {
          config: TEST_CONFIG,
          auth,
          debug: true,
          fetchImpl: mockFetch(async (req) => {
            seenSessions.push(req.headers.get("x-session-id") ?? "");
            return openaiOk();
          }),
        });
        expect(resp.status).toBe(200);
      }
    });

    expect(lines.some((l) => l.includes("clientIdentity source=lineage action=observe"))).toBe(true);
    expect(seenSessions[0]).toBeTruthy();
    expect(seenSessions[1]).toBeTruthy();
    expect(seenSessions[0]).not.toBe(seenSessions[1]);
  });

  it("stabilizes x-session-id in enforce mode for the same inferred session", async () => {
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const body = '{"model":"glm-4.6","messages":[{"role":"user","content":"Hi"}]}';
    const seenSessions: string[] = [];
    const config: ProxyConfig = { ...TEST_CONFIG, clientIdentity: { mode: "enforce", ttlSeconds: 900, maxSessions: 1024 } };

    for (let i = 0; i < 2; i++) {
      const resp = await proxyRequest(makeClientReq(body), "anthropic", {
        config,
        auth,
        fetchImpl: mockFetch(async (req) => {
          seenSessions.push(req.headers.get("x-session-id") ?? "");
          return openaiOk();
        }),
      });
      expect(resp.status).toBe(200);
    }

    expect(seenSessions[0]).toBeTruthy();
    expect(seenSessions[1]).toBe(seenSessions[0]);
  });

  it("emits client identity debug line even when no session can be inferred", async () => {
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const lines = await captureConsoleLog(async () => {
      await proxyRequest(makeClientReq('{"model":"glm-4.6","messages":[]}'), "anthropic", {
        config: TEST_CONFIG,
        auth,
        debug: true,
        fetchImpl: mockFetch(async () => openaiOk()),
      });
    });

    expect(lines.some((l) => l.includes("clientIdentity source=none action=observe confidence=0.00 session=-"))).toBe(true);
  });
});
