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

  it("enables Anthropic thinking by default for GLM reasoning models", () => {
    const req: OpenAIChatRequest = {
      model: "glm-5.2",
      messages: [{ role: "user", content: "Hi" }],
    };

    const result = translateRequestOpenAIToAnthropic(req);

    expect(result.thinking).toEqual({ type: "enabled" });
  });

  it("does not enable Anthropic thinking by default for non-reasoning GLM models", () => {
    const req: OpenAIChatRequest = {
      model: "glm-4.5",
      messages: [{ role: "user", content: "Hi" }],
    };

    const result = translateRequestOpenAIToAnthropic(req);

    expect(result.thinking).toBeUndefined();
  });

  it("allows OpenAI clients to disable Anthropic thinking explicitly", () => {
    const req = {
      model: "glm-5.2",
      messages: [{ role: "user", content: "Hi" }],
      thinking: { type: "disabled" },
    } as OpenAIChatRequest;

    const result = translateRequestOpenAIToAnthropic(req);

    expect(result.thinking).toEqual({ type: "disabled" });
  });

  it("preserves explicit Anthropic thinking budget from OpenAI-compatible extra body", () => {
    const req = {
      model: "glm-5.2",
      messages: [{ role: "user", content: "Hi" }],
      thinking: { type: "enabled", budget_tokens: 1024 },
    } as OpenAIChatRequest;

    const result = translateRequestOpenAIToAnthropic(req);

    expect(result.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
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

  it("preserves thinking blocks as OpenAI reasoning_content", () => {
    const resp: AnthropicMessagesResponse = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [
        { type: "thinking", thinking: "I should answer directly." },
        { type: "text", text: "Hi" },
      ],
      model: "glm-4.6",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    };

    const result = translateResponseAnthropicToOpenAI(resp, "glm-4.6");

    expect(result.choices[0].message.reasoning_content).toBe("I should answer directly.");
    expect(result.choices[0].message.content).toBe("Hi");
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

  it("preserves request thinking control for OpenAI-compatible upstreams", () => {
    const req: AnthropicMessagesRequest = {
      model: "glm-5.2",
      messages: [{ role: "user", content: "Think" }],
      max_tokens: 100,
      thinking: { type: "enabled", budget_tokens: 2048 },
    };

    const result = translateRequestAnthropicToOpenAI(req);

    expect(result.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
  });

  it("preserves assistant thinking blocks as OpenAI reasoning_content", () => {
    const req: AnthropicMessagesRequest = {
      model: "glm-5.2",
      messages: [{
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I should reason first." },
          { type: "text", text: "Answer" },
        ],
      }],
      max_tokens: 100,
    };

    const result = translateRequestAnthropicToOpenAI(req);

    expect(result.messages[0]).toEqual({
      role: "assistant",
      content: "Answer",
      reasoning_content: "I should reason first.",
    });
  });

  it("preserves reasoning_content for a thinking-only assistant message (no text/tool_use)", () => {
    const req: AnthropicMessagesRequest = {
      model: "glm-5.2",
      messages: [{
        role: "assistant",
        content: [{ type: "thinking", thinking: "Just thinking, no answer yet." }],
      }],
      max_tokens: 100,
    };

    const result = translateRequestAnthropicToOpenAI(req);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toEqual({
      role: "assistant",
      content: null,
      reasoning_content: "Just thinking, no answer yet.",
    });
  });

  it("translates assistant tool_use blocks into OpenAI tool_calls", () => {
    const req: AnthropicMessagesRequest = {
      model: "glm-4.6",
      max_tokens: 100,
      messages: [
        { role: "user", content: "weather in SF?" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check." },
            { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "SF" } },
          ],
        },
      ],
    };

    const result = translateRequestAnthropicToOpenAI(req);
    const assistant = result.messages[1];
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toBe("Let me check.");
    expect(assistant.tool_calls).toEqual([{
      id: "toolu_1",
      type: "function",
      function: { name: "get_weather", arguments: '{"city":"SF"}' },
    }]);
  });

  it("translates user tool_result blocks into standalone role:'tool' messages", () => {
    const req: AnthropicMessagesRequest = {
      model: "glm-4.6",
      max_tokens: 100,
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "SF" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "62°F and sunny" }],
        },
      ],
    };

    const result = translateRequestAnthropicToOpenAI(req);
    expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    const toolMsg = result.messages[2];
    expect(toolMsg).toEqual({
      role: "tool",
      tool_call_id: "toolu_1",
      content: "62°F and sunny",
    });
  });

  it("coalesces parallel tool_result blocks into multiple role:'tool' messages", () => {
    const req: AnthropicMessagesRequest = {
      model: "glm-4.6",
      max_tokens: 100,
      messages: [
        { role: "user", content: "weather in SF and NYC" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_a", name: "get_weather", input: { city: "SF" } },
            { type: "tool_use", id: "toolu_b", name: "get_weather", input: { city: "NYC" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_a", content: "62°F" },
            { type: "tool_result", tool_use_id: "toolu_b", content: "58°F" },
          ],
        },
      ],
    };

    const result = translateRequestAnthropicToOpenAI(req);
    expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "tool"]);
    expect(result.messages[2]).toMatchObject({ role: "tool", tool_call_id: "toolu_a", content: "62°F" });
    expect(result.messages[3]).toMatchObject({ role: "tool", tool_call_id: "toolu_b", content: "58°F" });
  });

  it("translates tool_choice {type:'any'} to OpenAI 'required'", () => {
    const req: AnthropicMessagesRequest = {
      model: "glm-4.6",
      max_tokens: 100,
      messages: [{ role: "user", content: "Hi" }],
      tools: [{ name: "fn", input_schema: { type: "object" } }],
      tool_choice: { type: "any" },
    };

    const result = translateRequestAnthropicToOpenAI(req);

    expect(result.tool_choice).toBe("required");
  });

  it("translates tool_choice {type:'tool', name} to OpenAI function selector", () => {
    const req: AnthropicMessagesRequest = {
      model: "glm-4.6",
      max_tokens: 100,
      messages: [{ role: "user", content: "Hi" }],
      tools: [{ name: "specific_tool", input_schema: { type: "object" } }],
      tool_choice: { type: "tool", name: "specific_tool" },
    };

    const result = translateRequestAnthropicToOpenAI(req);

    expect(result.tool_choice).toEqual({ type: "function", function: { name: "specific_tool" } });
  });

  it("translates tool_choice {type:'auto'} to OpenAI 'auto'", () => {
    const req: AnthropicMessagesRequest = {
      model: "glm-4.6",
      max_tokens: 100,
      messages: [{ role: "user", content: "Hi" }],
      tools: [{ name: "fn", input_schema: { type: "object" } }],
      tool_choice: { type: "auto" },
    };

    const result = translateRequestAnthropicToOpenAI(req);

    expect(result.tool_choice).toBe("auto");
  });

  it("serializes non-text tool_result content (e.g. image) as JSON to avoid data loss", () => {
    const req: AnthropicMessagesRequest = {
      model: "glm-4.6",
      max_tokens: 100,
      messages: [
        { role: "user", content: "x" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "fn", input: {} }] },
        {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "t1",
            content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }],
          }],
        },
      ],
    };

    const result = translateRequestAnthropicToOpenAI(req);
    const toolMsg = result.messages[2];
    expect(toolMsg.role).toBe("tool");
    expect(typeof toolMsg.content).toBe("string");
    expect(toolMsg.content).toContain("image/png");
  });

  it("encodes tool_result.is_error=true as a [tool_error] prefix on the OpenAI tool message", () => {
    const req: AnthropicMessagesRequest = {
      model: "glm-4.6",
      max_tokens: 100,
      messages: [
        { role: "user", content: "x" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "fn", input: {} }] },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "command not found", is_error: true }],
        },
      ],
    };

    const result = translateRequestAnthropicToOpenAI(req);
    const toolMsg = result.messages[2];
    expect(toolMsg.role).toBe("tool");
    expect(toolMsg.content).toBe("[tool_error] command not found");
  });

  it("does not add [tool_error] prefix when is_error is absent or false", () => {
    const req: AnthropicMessagesRequest = {
      model: "glm-4.6",
      max_tokens: 100,
      messages: [
        { role: "user", content: "x" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "fn", input: {} }] },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "ok" },
            { type: "tool_result", tool_use_id: "t2", content: "still ok", is_error: false },
          ],
        },
      ],
    };

    const result = translateRequestAnthropicToOpenAI(req);
    expect(result.messages[2].content).toBe("ok");
    expect(result.messages[3].content).toBe("still ok");
  });

  it("preserves tool_choice {type:'tool'} without name by forwarding undefined (no synthetic empty name)", () => {
    // Client contract violation (Anthropic requires name for type:"tool"), but
    // the proxy must not mask it as an empty function name — forward as-is so
    // the upstream surfaces the original error.
    const req = {
      model: "glm-4.6",
      max_tokens: 100,
      messages: [{ role: "user", content: "Hi" }],
      tools: [{ name: "fn", input_schema: { type: "object" } }],
      tool_choice: { type: "tool" },
    } as unknown as AnthropicMessagesRequest;

    const result = translateRequestAnthropicToOpenAI(req);

    expect(result.tool_choice).toEqual({ type: "function", function: { name: undefined } });
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

  it("preserves OpenAI reasoning_content as an Anthropic thinking block", () => {
    const resp: OpenAIChatResponse = {
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1234567890,
      model: "glm-4.6",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          reasoning_content: "I should answer directly.",
          content: "Hi",
        },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };

    const result = translateResponseOpenAIToAnthropic(resp);

    expect(result.content[0]).toEqual({ type: "thinking", thinking: "I should answer directly." });
    expect(result.content[1]).toEqual({ type: "text", text: "Hi" });
  });

  it("maps usage tokens correctly", () => {
    const resp: OpenAIChatResponse = {
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1234567890,
      model: "glm-4.6",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "Hi" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    };
    const result = translateResponseOpenAIToAnthropic(resp);
    expect(result.usage.input_tokens).toBe(100);
    expect(result.usage.output_tokens).toBe(50);
  });

  it("subtracts cached tokens from input_tokens and reports cache buckets (prompt_tokens_details)", () => {
    const resp: OpenAIChatResponse = {
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1234567890,
      model: "glm-4.6",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "Hi" },
        finish_reason: "stop",
      }],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 10,
        total_tokens: 1010,
        prompt_tokens_details: { cached_tokens: 700 },
      },
    };
    const result = translateResponseOpenAIToAnthropic(resp);
    expect(result.usage.input_tokens).toBe(300); // 1000 - 700
    expect(result.usage.output_tokens).toBe(10);
    expect(result.usage.cache_read_input_tokens).toBe(700);
  });

  it("subtracts both cache_read and cache_creation from input_tokens", () => {
    const resp: OpenAIChatResponse = {
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1234567890,
      model: "glm-4.6",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "Hi" },
        finish_reason: "stop",
      }],
      usage: {
        prompt_tokens: 500,
        completion_tokens: 5,
        total_tokens: 505,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 100,
      },
    };
    const result = translateResponseOpenAIToAnthropic(resp);
    expect(result.usage.input_tokens).toBe(200); // 500 - 200 - 100
    expect(result.usage.cache_read_input_tokens).toBe(200);
    expect(result.usage.cache_creation_input_tokens).toBe(100);
  });
});
