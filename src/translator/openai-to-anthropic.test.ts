/**
 * Tests for OpenAI ↔ Anthropic translators.
 * @see .omo/plans/zcode-proxy.md Task 11
 */
import { describe, it, expect } from "bun:test";
import {
  translateRequestOpenAIToAnthropic,
  translateResponseAnthropicToOpenAI,
} from "./openai-to-anthropic.js";
import {
  translateRequestAnthropicToOpenAI,
  translateResponseOpenAIToAnthropic,
} from "./anthropic-to-openai.js";
import type {
  OpenAIChatRequest,
  AnthropicMessagesResponse,
  AnthropicMessagesRequest,
  OpenAIChatResponse,
} from "./types.js";

describe("translateRequestOpenAIToAnthropic", () => {
  it("extracts system message to top-level system field", () => {
    const req: OpenAIChatRequest = {
      model: "glm-4.6",
      messages: [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "Hello" },
      ],
    };
    const result = translateRequestOpenAIToAnthropic(req);
    expect(result.system).toBe("You are helpful");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
  });

  it("joins multiple system messages", () => {
    const req: OpenAIChatRequest = {
      model: "glm-4.6",
      messages: [
        { role: "system", content: "Rule 1" },
        { role: "system", content: "Rule 2" },
        { role: "user", content: "Hi" },
      ],
    };
    const result = translateRequestOpenAIToAnthropic(req);
    expect(result.system).toBe("Rule 1\n\nRule 2");
  });

  it("sets max_tokens default when not provided", () => {
    const req: OpenAIChatRequest = {
      model: "glm-4.6",
      messages: [{ role: "user", content: "Hi" }],
    };
    const result = translateRequestOpenAIToAnthropic(req);
    expect(result.max_tokens).toBe(4096);
  });

  it("preserves max_tokens when provided", () => {
    const req: OpenAIChatRequest = {
      model: "glm-4.6",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 2048,
    };
    const result = translateRequestOpenAIToAnthropic(req);
    expect(result.max_tokens).toBe(2048);
  });

  it("translates stop to stop_sequences", () => {
    const req: OpenAIChatRequest = {
      model: "glm-4.6",
      messages: [{ role: "user", content: "Hi" }],
      stop: ["END", "STOP"],
    };
    const result = translateRequestOpenAIToAnthropic(req);
    expect(result.stop_sequences).toEqual(["END", "STOP"]);
  });

  it("translates tool definitions", () => {
    const req: OpenAIChatRequest = {
      model: "glm-4.6",
      messages: [{ role: "user", content: "Search for cats" }],
      tools: [{
        type: "function",
        function: {
          name: "search",
          description: "Search the web",
          parameters: { type: "object", properties: { query: { type: "string" } } },
        },
      }],
    };
    const result = translateRequestOpenAIToAnthropic(req);
    expect(result.tools).toHaveLength(1);
    expect(result.tools![0].name).toBe("search");
    expect(result.tools![0].description).toBe("Search the web");
    expect(result.tools![0].input_schema).toBeDefined();
  });

  it("translates tool_choice='auto' to Anthropic {type:'auto'}", () => {
    const req: OpenAIChatRequest = {
      model: "glm-4.6",
      messages: [{ role: "user", content: "Hi" }],
      tools: [{ type: "function", function: { name: "fn" } }],
      tool_choice: "auto",
    };
    const result = translateRequestOpenAIToAnthropic(req);
    expect(result.tool_choice).toEqual({ type: "auto" });
  });

  it("translates tool_choice='required' to Anthropic {type:'any'}", () => {
    const req: OpenAIChatRequest = {
      model: "glm-4.6",
      messages: [{ role: "user", content: "Hi" }],
      tools: [{ type: "function", function: { name: "fn" } }],
      tool_choice: "required",
    };
    const result = translateRequestOpenAIToAnthropic(req);
    expect(result.tool_choice).toEqual({ type: "any" });
  });

  it("translates tool_choice={type:'function',function:{name}} to Anthropic {type:'tool',name}", () => {
    const req: OpenAIChatRequest = {
      model: "glm-4.6",
      messages: [{ role: "user", content: "Hi" }],
      tools: [{ type: "function", function: { name: "specific_tool" } }],
      tool_choice: { type: "function", function: { name: "specific_tool" } },
    };
    const result = translateRequestOpenAIToAnthropic(req);
    expect(result.tool_choice).toEqual({ type: "tool", name: "specific_tool" });
  });

  it("omits tool_choice when not specified (Anthropic defaults to auto when tools present)", () => {
    const req: OpenAIChatRequest = {
      model: "glm-4.6",
      messages: [{ role: "user", content: "Hi" }],
      tools: [{ type: "function", function: { name: "fn" } }],
    };
    const result = translateRequestOpenAIToAnthropic(req);
    expect(result.tool_choice).toBeUndefined();
  });

  it("omits tool_choice for 'none' (Anthropic has no 'none' type — see next test for tools handling)", () => {
    const req: OpenAIChatRequest = {
      model: "glm-4.6",
      messages: [{ role: "user", content: "Hi" }],
      tools: [{ type: "function", function: { name: "fn" } }],
      tool_choice: "none",
    };
    const result = translateRequestOpenAIToAnthropic(req);
    expect(result.tool_choice).toBeUndefined();
  });

  it("tool_choice='none' strips the tools array so Anthropic does not auto-call tools", () => {
    const req: OpenAIChatRequest = {
      model: "glm-4.6",
      messages: [{ role: "user", content: "Hi" }],
      tools: [{ type: "function", function: { name: "fn" } }],
      tool_choice: "none",
    };
    const result = translateRequestOpenAIToAnthropic(req);
    expect(result.tool_choice).toBeUndefined();
    expect(result.tools).toBeUndefined();
  });

  it("translates assistant message with tool_calls into assistant content with tool_use blocks", () => {
    const req: OpenAIChatRequest = {
      model: "glm-4.6",
      messages: [
        { role: "user", content: "What's the weather?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_abc",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"SF"}' },
          }],
        },
      ],
    };
    const result = translateRequestOpenAIToAnthropic(req);
    const assistant = result.messages[1];
    expect(assistant.role).toBe("assistant");
    expect(Array.isArray(assistant.content)).toBe(true);
    const blocks = assistant.content as unknown[];
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as any).type).toBe("tool_use");
    expect((blocks[0] as any).id).toBe("call_abc");
    expect((blocks[0] as any).name).toBe("get_weather");
    expect((blocks[0] as any).input).toEqual({ city: "SF" });
  });

  it("preserves assistant text alongside tool_calls (text block first, then tool_use blocks)", () => {
    const req: OpenAIChatRequest = {
      model: "glm-4.6",
      messages: [
        { role: "user", content: "Hi" },
        {
          role: "assistant",
          content: "Let me check the weather.",
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"SF"}' },
          }],
        },
      ],
    };
    const result = translateRequestOpenAIToAnthropic(req);
    const blocks = result.messages[1].content as any[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: "text", text: "Let me check the weather." });
    expect(blocks[1].type).toBe("tool_use");
  });

  it("translates role:'tool' message into user message with tool_result block", () => {
    const req: OpenAIChatRequest = {
      model: "glm-4.6",
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_xyz",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"SF"}' },
          }],
        },
        { role: "tool", tool_call_id: "call_xyz", content: "62°F and sunny" },
      ],
    };
    const result = translateRequestOpenAIToAnthropic(req);
    const toolResultMsg = result.messages[2];
    expect(toolResultMsg.role).toBe("user");
    const blocks = toolResultMsg.content as any[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("tool_result");
    expect(blocks[0].tool_use_id).toBe("call_xyz");
    expect(blocks[0].content).toBe("62°F and sunny");
  });

  it("coalesces consecutive role:'tool' messages into a single user message with multiple tool_result blocks", () => {
    const req: OpenAIChatRequest = {
      model: "glm-4.6",
      messages: [
        { role: "user", content: "weather in SF and NYC" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_a", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } },
            { id: "call_b", type: "function", function: { name: "get_weather", arguments: '{"city":"NYC"}' } },
          ],
        },
        { role: "tool", tool_call_id: "call_a", content: "62°F" },
        { role: "tool", tool_call_id: "call_b", content: "58°F" },
      ],
    };
    const result = translateRequestOpenAIToAnthropic(req);
    expect(result.messages).toHaveLength(3);
    const coalesced = result.messages[2];
    expect(coalesced.role).toBe("user");
    const blocks = coalesced.content as any[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: "tool_result", tool_use_id: "call_a", content: "62°F" });
    expect(blocks[1]).toMatchObject({ type: "tool_result", tool_use_id: "call_b", content: "58°F" });
  });

  it("handles malformed tool_call arguments JSON by falling back to empty object input", () => {
    const req: OpenAIChatRequest = {
      model: "glm-4.6",
      messages: [
        { role: "user", content: "x" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_bad",
            type: "function",
            function: { name: "fn", arguments: "not-valid-json" },
          }],
        },
      ],
    };
    const result = translateRequestOpenAIToAnthropic(req);
    const block = (result.messages[1].content as any[])[0];
    expect(block.type).toBe("tool_use");
    expect(block.input).toEqual({});
  });

  it("preserves image parts in role:'tool' content (data: URL → Anthropic image block)", () => {
    const req: OpenAIChatRequest = {
      model: "glm-4.6",
      messages: [
        { role: "user", content: "x" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "fn", arguments: "{}" } }],
        },
        {
          role: "tool",
          tool_call_id: "c1",
          content: [
            { type: "text", text: "screenshot:" },
            { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
          ],
        },
      ],
    };
    const result = translateRequestOpenAIToAnthropic(req);
    const toolResultMsg = result.messages[2];
    expect(toolResultMsg.role).toBe("user");
    const blocks = toolResultMsg.content as any[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("tool_result");
    const inner = blocks[0].content;
    expect(Array.isArray(inner)).toBe(true);
    expect(inner).toHaveLength(2);
    expect(inner[0]).toEqual({ type: "text", text: "screenshot:" });
    expect(inner[1].type).toBe("image");
    expect(inner[1].source).toEqual({ type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" });
  });

  it("falls back to text block for non-data: image URLs in tool results (does not silently drop)", () => {
    const req: OpenAIChatRequest = {
      model: "glm-4.6",
      messages: [
        { role: "user", content: "x" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "fn", arguments: "{}" } }],
        },
        {
          role: "tool",
          tool_call_id: "c1",
          content: [
            { type: "text", text: "see:" },
            { type: "image_url", image_url: { url: "https://example.com/img.png" } },
          ],
        },
      ],
    };
    const result = translateRequestOpenAIToAnthropic(req);
    const inner = (result.messages[2].content as any[])[0].content;
    expect(Array.isArray(inner)).toBe(true);
    expect(inner).toHaveLength(2);
    expect(inner[0].type).toBe("text");
    expect(inner[1].type).toBe("text");
    expect(inner[1].text).toContain("https://example.com/img.png");
  });

  it("preserves message order and alternation: user → assistant → user (tool_result) → assistant", () => {
    const req: OpenAIChatRequest = {
      model: "glm-4.6",
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "w", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "c1", content: "62" },
        { role: "assistant", content: "The weather is 62°F" },
      ],
    };
    const result = translateRequestOpenAIToAnthropic(req);
    expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });
});

describe("translateResponseAnthropicToOpenAI", () => {
  it("extracts text content from response", () => {
    const resp: AnthropicMessagesResponse = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Hello world" }],
      model: "glm-4.6",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const result = translateResponseAnthropicToOpenAI(resp, "glm-4.6");
    expect(result.choices[0].message.content).toBe("Hello world");
    expect(result.choices[0].finish_reason).toBe("stop");
  });

  it("maps stop_reason to finish_reason", () => {
    const resp: AnthropicMessagesResponse = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "..." }],
      model: "glm-4.6",
      stop_reason: "max_tokens",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const result = translateResponseAnthropicToOpenAI(resp, "glm-4.6");
    expect(result.choices[0].finish_reason).toBe("length");
  });

  it("translates tool_use blocks to tool_calls", () => {
    const resp: AnthropicMessagesResponse = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [
        { type: "text", text: "Let me search" },
        { type: "tool_use", id: "tu_1", name: "search", input: { query: "cats" } },
      ],
      model: "glm-4.6",
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 20 },
    };
    const result = translateResponseAnthropicToOpenAI(resp, "glm-4.6");
    expect(result.choices[0].message.tool_calls).toHaveLength(1);
    expect(result.choices[0].message.tool_calls![0].function.name).toBe("search");
    expect(result.choices[0].finish_reason).toBe("tool_calls");
  });

  it("maps usage tokens correctly", () => {
    const resp: AnthropicMessagesResponse = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Hi" }],
      model: "glm-4.6",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 50 },
    };
    const result = translateResponseAnthropicToOpenAI(resp, "glm-4.6");
    expect(result.usage!.prompt_tokens).toBe(100);
    expect(result.usage!.completion_tokens).toBe(50);
    expect(result.usage!.total_tokens).toBe(150);
  });
});

describe("translateRequestAnthropicToOpenAI", () => {
  it("converts system string to system message", () => {
    const req: AnthropicMessagesRequest = {
      model: "glm-4.6",
      messages: [{ role: "user", content: "Hi" }],
      system: "Be helpful",
      max_tokens: 1000,
    };
    const result = translateRequestAnthropicToOpenAI(req);
    expect(result.messages[0].role).toBe("system");
    expect(result.messages[0].content).toBe("Be helpful");
    expect(result.max_tokens).toBe(1000);
  });

  it("converts stop_sequences to stop", () => {
    const req: AnthropicMessagesRequest = {
      model: "glm-4.6",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 100,
      stop_sequences: ["END"],
    };
    const result = translateRequestAnthropicToOpenAI(req);
    expect(result.stop).toBe("END");
  });

  it("translates tools", () => {
    const req: AnthropicMessagesRequest = {
      model: "glm-4.6",
      messages: [{ role: "user", content: "Search" }],
      max_tokens: 100,
      tools: [{ name: "search", description: "Search web", input_schema: { type: "object" } }],
    };
    const result = translateRequestAnthropicToOpenAI(req);
    expect(result.tools).toHaveLength(1);
    expect(result.tools![0].function.name).toBe("search");
  });
});

describe("translateResponseOpenAIToAnthropic", () => {
  it("converts text response", () => {
    const resp: OpenAIChatResponse = {
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1234567890,
      model: "glm-4.6",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "Hello" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    const result = translateResponseOpenAIToAnthropic(resp);
    expect(result.content[0]).toEqual({ type: "text", text: "Hello" });
    expect(result.stop_reason).toBe("end_turn");
    expect(result.usage.input_tokens).toBe(10);
    expect(result.usage.output_tokens).toBe(5);
  });

  it("maps finish_reason to stop_reason", () => {
    const resp: OpenAIChatResponse = {
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1234567890,
      model: "glm-4.6",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "..." },
        finish_reason: "length",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    const result = translateResponseOpenAIToAnthropic(resp);
    expect(result.stop_reason).toBe("max_tokens");
  });
});
