/**
 * Integration tests — end-to-end proxy tests with mock upstream.
 * @see .omo/plans/zcode-proxy.md Task 13
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { loadConfig } from "./config/loader.js";
import { AuthManager } from "./auth/manager.js";
import { startServer } from "./server/server.js";

let proxyServer: ReturnType<typeof Bun.serve>;
let mockUpstreamServer: ReturnType<typeof Bun.serve>;
let proxyPort: number;
let mockPort: number;
let capturedUpstreamBodies: string[] = [];

function findFreePort(): number {
  return 18000 + Math.floor(Math.random() * 1000);
}

beforeAll(() => {
  mockPort = findFreePort();
  proxyPort = findFreePort();

  mockUpstreamServer = Bun.serve({
    port: mockPort,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const rawBody = await req.text();
      let parsed: { stream?: boolean; model?: string } = {};
      try { parsed = JSON.parse(rawBody); } catch {}

      if (url.pathname.includes("/v1/messages")) {
        capturedUpstreamBodies.push(rawBody);
        let hasToolResult = false;
        let hasToolsDefined = false;
        try {
          const parsedAny = JSON.parse(rawBody) as {
            messages?: Array<{ content?: unknown }>;
            tools?: unknown[];
          };
          hasToolResult = (parsedAny.messages ?? []).some(
            (m) => Array.isArray(m.content) && m.content.some((b: any) => b?.type === "tool_result"),
          );
          hasToolsDefined = (parsedAny.tools?.length ?? 0) > 0;
        } catch {}

        if (hasToolResult) {
          return new Response(JSON.stringify({
            id: "msg_after_tool",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "Tool result acknowledged" }],
            model: "glm-4.6",
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 25, output_tokens: 4 },
          }), { status: 200, headers: { "content-type": "application/json" } });
        }

        if (hasToolsDefined && !parsed.stream) {
          return new Response(JSON.stringify({
            id: "msg_tool_call",
            type: "message",
            role: "assistant",
            content: [
              { type: "text", text: "Calling tool." },
              { type: "tool_use", id: "toolu_http_1", name: "get_weather", input: { city: "SF" } },
            ],
            model: "glm-4.6",
            stop_reason: "tool_use",
            stop_sequence: null,
            usage: { input_tokens: 15, output_tokens: 12 },
          }), { status: 200, headers: { "content-type": "application/json" } });
        }

        if (parsed.stream) {
          const sse = [
            'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_int","model":"glm-4.6"}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Integration stream"}}\n\n',
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ].join("");
          return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
        }
        return new Response(JSON.stringify({
          id: "msg_int_test",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Integration test response" }],
          model: "glm-4.6",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 8 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }

      if (url.pathname.includes("/chat/completions")) {
        return new Response(JSON.stringify({
          id: "chatcmpl-int-test",
          object: "chat.completion",
          created: Date.now(),
          model: "glm-4.6",
          choices: [{
            index: 0,
            message: { role: "assistant", content: "OpenAI integration response" },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }

      return new Response("not found", { status: 404 });
    },
  });

  const config = loadConfig("config.test.yaml");
  config.server.port = proxyPort;
  config.server.host = "127.0.0.1";
  config.auth.proxyApiKey = "integration-test-key";
  config.providers.zai.anthropicBase = `http://127.0.0.1:${mockPort}/anthropic`;
  config.providers.zai.openaiBase = `http://127.0.0.1:${mockPort}/coding`;
  config.auth.apiKey = "integrationTestKey.integrationTestSecret";

  const auth = new AuthManager({
    mode: "apikey",
    provider: "zai",
    apiKey: "integrationTestKey.integrationTestSecret",
  });

  proxyServer = startServer({ config, auth });
});

afterAll(() => {
  proxyServer?.stop(true);
  mockUpstreamServer?.stop(true);
});

function proxyUrl(path: string): string {
  return `http://127.0.0.1:${proxyPort}${path}`;
}
function authHeader(): Record<string, string> {
  return { "Authorization": "Bearer integration-test-key", "Content-Type": "application/json" };
}

describe("integration: OpenAI translation", () => {
  it("POST /v1/chat/completions returns 200 with translated response", async () => {
    const resp = await fetch(proxyUrl("/v1/chat/completions"), {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify({
        model: "glm-4.6",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toBe("Integration test response");
    expect(body.model).toBe("glm-4.6");
  });

  it("returns gzip-encoded body when client sends accept-encoding: gzip", async () => {
    const resp = await fetch(proxyUrl("/v1/chat/completions"), {
      method: "POST",
      headers: { ...authHeader(), "accept-encoding": "gzip" },
      body: JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "Hi" }] }),
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-encoding")).toBe("gzip");
    const body = await resp.json();
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toBe("Integration test response");
  });
});

describe("integration: OpenAI streaming translation", () => {
  it("translates Anthropic SSE to OpenAI SSE chunks", async () => {
    const resp = await fetch(proxyUrl("/v1/chat/completions"), {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify({
        model: "glm-4.6",
        messages: [{ role: "user", content: "Stream test" }],
        stream: true,
      }),
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("text/event-stream");
    const text = await resp.text();
    expect(text).toContain("chat.completion.chunk");
    expect(text).toContain("data: [DONE]");
  });
});

describe("integration: OpenAI tool-call roundtrip (HTTP layer)", () => {
  it("returns OpenAI tool_calls on turn 1, accepts tool_result on turn 2, upstream receives valid Anthropic shape", async () => {
    const tools = [{ type: "function", function: { name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } } } } }];

    const resp1 = await fetch(proxyUrl("/v1/chat/completions"), {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify({
        model: "glm-4.6",
        messages: [{ role: "user", content: "weather in SF?" }],
        tools,
        tool_choice: "auto",
      }),
    });
    expect(resp1.status).toBe(200);
    const body1 = await resp1.json();
    expect(body1.choices[0].finish_reason).toBe("tool_calls");
    const toolCall = body1.choices[0].message.tool_calls?.[0];
    expect(toolCall).toBeDefined();
    expect(toolCall.id).toBe("toolu_http_1");
    expect(toolCall.function.name).toBe("get_weather");
    expect(JSON.parse(toolCall.function.arguments)).toEqual({ city: "SF" });

    const resp2 = await fetch(proxyUrl("/v1/chat/completions"), {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify({
        model: "glm-4.6",
        messages: [
          { role: "user", content: "weather in SF?" },
          { role: "assistant", content: null, tool_calls: [toolCall] },
          { role: "tool", tool_call_id: toolCall.id, content: "62°F" },
        ],
        tools,
      }),
    });
    expect(resp2.status).toBe(200);
    const body2 = await resp2.json();
    expect(body2.choices[0].finish_reason).toBe("stop");
    expect(body2.choices[0].message.content).toBe("Tool result acknowledged");

    const toolResultBody = capturedUpstreamBodies
      .map((b) => JSON.parse(b))
      .filter((b) => (b.messages ?? []).some((m: any) => Array.isArray(m.content) && m.content.some((c: any) => c?.type === "tool_result")));
    expect(toolResultBody).toHaveLength(1);
    const upstreamReq = toolResultBody[0];
    expect(upstreamReq.messages).toHaveLength(3);
    expect(upstreamReq.messages[0].role).toBe("user");
    expect(upstreamReq.messages[1].role).toBe("assistant");
    const assistantBlocks = upstreamReq.messages[1].content;
    expect(Array.isArray(assistantBlocks)).toBe(true);
    const toolUseBlock = assistantBlocks.find((b: any) => b.type === "tool_use");
    expect(toolUseBlock).toMatchObject({ id: "toolu_http_1", name: "get_weather", input: { city: "SF" } });
    expect(upstreamReq.messages[2].role).toBe("user");
    const userBlocks = upstreamReq.messages[2].content;
    expect(Array.isArray(userBlocks)).toBe(true);
    const toolResultBlock = userBlocks.find((b: any) => b.type === "tool_result");
    expect(toolResultBlock).toMatchObject({ tool_use_id: "toolu_http_1", content: "62°F" });
    expect(upstreamReq.tools).toHaveLength(1);
    expect(upstreamReq.tools[0]).toMatchObject({ name: "get_weather" });
    expect(upstreamReq.tool_choice).toBeUndefined();
  });
});

describe("integration: Anthropic passthrough", () => {
  it("POST /v1/messages returns 200 with response", async () => {
    const resp = await fetch(proxyUrl("/v1/messages"), {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify({
        model: "glm-4.6",
        max_tokens: 100,
        messages: [{ role: "user", content: "Hello" }],
      }),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.content[0].text).toBe("Integration test response");
    expect(body.stop_reason).toBe("end_turn");
  });
});

describe("integration: Models endpoint", () => {
  it("GET /v1/models returns model list", async () => {
    const resp = await fetch(proxyUrl("/v1/models"), {
      headers: { Authorization: "Bearer integration-test-key" },
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.object).toBe("list");
    expect(body.data.length).toBeGreaterThan(0);
  });
});

describe("integration: Auth", () => {
  it("rejects request without proxy key", async () => {
    const resp = await fetch(proxyUrl("/v1/models"));
    expect(resp.status).toBe(401);
  });

  it("rejects request with wrong proxy key", async () => {
    const resp = await fetch(proxyUrl("/v1/models"), {
      headers: { Authorization: "Bearer wrong-key" },
    });
    expect(resp.status).toBe(401);
  });
});

describe("integration: Health", () => {
  it("GET /health returns ok", async () => {
    const resp = await fetch(proxyUrl("/health"), {
      headers: { Authorization: "Bearer integration-test-key" },
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.status).toBe("ok");
  });
});

describe("integration: Error handling", () => {
  it("unknown route returns 404", async () => {
    const resp = await fetch(proxyUrl("/unknown"), {
      headers: { Authorization: "Bearer integration-test-key" },
    });
    expect(resp.status).toBe(404);
  });

  it("CORS preflight returns 204", async () => {
    const resp = await fetch(proxyUrl("/v1/models"), { method: "OPTIONS" });
    expect(resp.status).toBe(204);
    expect(resp.headers.get("access-control-allow-origin")).toBe("*");
  });
});
