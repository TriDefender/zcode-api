/**
 * Handler-level integration tests for the media fallback: prevention (strip
 * before the first attempt on text-only models) and reactive retry (strip
 * after the upstream rejects an image block). Mirrors the cc-switch forwarder
 * wiring in `src-tauri/src/proxy/forwarder.rs`.
 */
import { describe, it, expect, mock } from "bun:test";
import { proxyRequest } from "./handler.js";
import { AuthManager } from "../auth/manager.js";
import type { ProxyConfig, ProxyIdentity } from "../config/types.js";

const IDENTITY: ProxyIdentity = {
  appVersion: "test-1.0.0",
  sourceTitle: "cli",
  refererOrigin: "https://zcode.z.ai",
};

const testConfig: ProxyConfig = {
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

function makeAnthropicReq(body: string): Request {
  return new Request("http://localhost:8080/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

function makeOpenAIReq(body: string): Request {
  return new Request("http://localhost:8080/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

const OPENAI_OK = JSON.stringify({
  id: "chatcmpl_1",
  object: "chat.completion",
  created: 1,
  model: "glm-4.6",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
});

const ERROR_1210 = JSON.stringify({
  error: { code: "1210", message: "messages.content.type 参数非法，取值范围 ['text']" },
});

const ANTHROPIC_IMAGE_BODY = {
  model: "glm-4.6",
  max_tokens: 1024,
  messages: [{
    role: "user",
    content: [
      { type: "text", text: "describe this" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
    ],
  }],
};

function auth(): AuthManager {
  return new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
}

function hasMarker(content: unknown): boolean {
  return Array.isArray(content) && content.some(
    (b) => b && typeof b === "object" && (b as any).type === "text" && (b as any).text === "[Unsupported Image]",
  );
}

function hasImageUrl(content: unknown): boolean {
  return Array.isArray(content) && content.some(
    (b) => b && typeof b === "object" && (b as any).type === "image_url",
  );
}

describe("media fallback — prevention", () => {
  it("strips the image before the first attempt for a text-only model (anthropic client)", async () => {
    let captured: any;
    const fetchMock = mock(async (req: Request): Promise<Response> => {
      captured = JSON.parse(await req.text());
      return new Response(OPENAI_OK, { status: 200, headers: { "content-type": "application/json" } });
    });

    const resp = await proxyRequest(makeAnthropicReq(JSON.stringify(ANTHROPIC_IMAGE_BODY)), "anthropic", {
      config: testConfig, auth: auth(), fetchImpl: fetchMock as any,
    });

    expect(resp.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const content = captured.messages[0].content;
    expect(hasImageUrl(content)).toBe(false);
    expect(hasMarker(content)).toBe(true);
  });

  it("keeps the image for a vision model (no preventive strip)", async () => {
    let captured: any;
    const fetchMock = mock(async (req: Request): Promise<Response> => {
      captured = JSON.parse(await req.text());
      return new Response(OPENAI_OK, { status: 200, headers: { "content-type": "application/json" } });
    });

    await proxyRequest(makeAnthropicReq(JSON.stringify({ ...ANTHROPIC_IMAGE_BODY, model: "glm-4.6v" })), "anthropic", {
      config: testConfig, auth: auth(), fetchImpl: fetchMock as any,
    });

    expect(hasImageUrl(captured.messages[0].content)).toBe(true);
  });

  it("strips image_url for OpenAI passthrough clients on text-only models", async () => {
    let captured: any;
    const fetchMock = mock(async (req: Request): Promise<Response> => {
      captured = JSON.parse(await req.text());
      return new Response(OPENAI_OK, { status: 200, headers: { "content-type": "application/json" } });
    });

    const resp = await proxyRequest(makeOpenAIReq(JSON.stringify({
      model: "glm-4.6",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
        ],
      }],
    })), "openai", { config: testConfig, auth: auth(), fetchImpl: fetchMock as any });

    expect(resp.status).toBe(200);
    const content = captured.messages[0].content;
    expect(hasImageUrl(content)).toBe(false);
    expect(hasMarker(content)).toBe(true);
  });
});

describe("media fallback — reactive retry", () => {
  it("retries once after a Z.AI 1210 rejection, stripping the image on the retry", async () => {
    const captured: any[] = [];
    const fetchMock = mock(async (req: Request): Promise<Response> => {
      captured.push(JSON.parse(await req.text()));
      if (captured.length === 1) {
        return new Response(ERROR_1210, { status: 400, headers: { "content-type": "application/json" } });
      }
      return new Response(OPENAI_OK, { status: 200, headers: { "content-type": "application/json" } });
    });

    // vision model → prevention skips, so the first attempt carries image_url and is rejected
    const resp = await proxyRequest(
      makeAnthropicReq(JSON.stringify({ ...ANTHROPIC_IMAGE_BODY, model: "glm-4.6v" })),
      "anthropic",
      { config: testConfig, auth: auth(), fetchImpl: fetchMock as any },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(resp.status).toBe(200);
    expect(hasImageUrl(captured[0].messages[0].content)).toBe(true);
    expect(hasImageUrl(captured[1].messages[0].content)).toBe(false);
    expect(hasMarker(captured[1].messages[0].content)).toBe(true);
  });

  it("does not retry a non-media 400 error", async () => {
    const fetchMock = mock(async (): Promise<Response> => {
      return new Response(JSON.stringify({ error: { message: "Invalid API key" } }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    });

    const resp = await proxyRequest(
      makeAnthropicReq(JSON.stringify({ ...ANTHROPIC_IMAGE_BODY, model: "glm-4.6v" })),
      "anthropic",
      { config: testConfig, auth: auth(), fetchImpl: fetchMock as any },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resp.status).toBe(502);
    const body = await resp.json();
    expect(body.error.type).toBe("translation_failed");
  });

  it("returns 502 when the retry also fails", async () => {
    const fetchMock = mock(async (): Promise<Response> => {
      return new Response(ERROR_1210, { status: 400, headers: { "content-type": "application/json" } });
    });

    const resp = await proxyRequest(
      makeAnthropicReq(JSON.stringify({ ...ANTHROPIC_IMAGE_BODY, model: "glm-4.6v" })),
      "anthropic",
      { config: testConfig, auth: auth(), fetchImpl: fetchMock as any },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(resp.status).toBe(502);
  });
});
