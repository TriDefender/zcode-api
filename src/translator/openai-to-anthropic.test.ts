/**
 * Tests for OpenAI ↔ Anthropic translators.
 */
import { describe, it, expect } from "bun:test";
import {
  translateRequestOpenAIToAnthropic,
  translateResponseAnthropicToOpenAI,
  anthropicUsageToOpenAI,
} from "./openai-to-anthropic.js";
import { responsesToChatCompletions } from "./responses-to-chat.js";
import {
  translateRequestAnthropicToOpenAI,
  translateResponseOpenAIToAnthropic,
  openaiUsageToAnthropic,
} from "./anthropic-to-openai.js";
import type {
  OpenAIChatRequest,
  OpenAIContentPart,
  AnthropicContentBlock,
  AnthropicMessagesResponse,
  AnthropicMessagesRequest,
  OpenAIChatResponse,
} from "./types.js";

describe("translateRequestOpenAIToAnthropic", () => {
  it("preserves developer instructions and prefers the current completion limit", () => {
    const result = translateRequestOpenAIToAnthropic({
      model: "glm-4.6", max_tokens: 20, max_completion_tokens: 100, thinking: { type: "disabled" },
      messages: [
        { role: "system", content: "base" },
        { role: "developer", content: [{ type: "text", text: "policy" }] },
        { role: "user", content: "hello" },
      ],
    });
    expect(result.system).toBe("base\n\npolicy");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.role).toBe("user");
    expect(result.max_tokens).toBe(100);
  });
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

  it("max_tokens defaults to the model's catalog maxOutputTokens (bundle Z = maxOutputTokens ?? modelDefault)", () => {
    const req: OpenAIChatRequest = {
      model: "glm-4.6",
      messages: [{ role: "user", content: "Hi" }],
    };
    const result = translateRequestOpenAIToAnthropic(req);
    expect(result.max_tokens).toBe(131_072);
  });

  it("adds the default thinking budget on top of the client's max_tokens (SDK additive rule)", () => {
    const req: OpenAIChatRequest = {
      model: "glm-4.6",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 2048,
    };
    const result = translateRequestOpenAIToAnthropic(req);
    // glm-4.6 is a reasoning model → default thinking budget 1024 → 2048+1024.
    expect(result.max_tokens).toBe(2048 + 1024);
    expect(result.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
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

  it("parallel_tool_calls:false synthesizes tool_choice {type:'auto',disable_parallel_tool_use:true} (issue #65)", () => {
    const req: OpenAIChatRequest = {
      model: "glm-4.6",
      messages: [{ role: "user", content: "Hi" }],
      tools: [{ type: "function", function: { name: "fn" } }],
      parallel_tool_calls: false,
    };
    const result = translateRequestOpenAIToAnthropic(req);
    expect(result.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
  });

  it("parallel_tool_calls:false merges into an explicit tool_choice", () => {
    const req: OpenAIChatRequest = {
      model: "glm-4.6",
      messages: [{ role: "user", content: "Hi" }],
      tools: [{ type: "function", function: { name: "fn" } }],
      tool_choice: "required",
      parallel_tool_calls: false,
    };
    const result = translateRequestOpenAIToAnthropic(req);
    expect(result.tool_choice).toEqual({ type: "any", disable_parallel_tool_use: true });
  });

  it("parallel_tool_calls:false is not emitted without tools (Anthropic rejects tool_choice with empty tools)", () => {
    const req: OpenAIChatRequest = {
      model: "glm-4.6",
      messages: [{ role: "user", content: "Hi" }],
      parallel_tool_calls: false,
    };
    const result = translateRequestOpenAIToAnthropic(req);
    expect(result.tool_choice).toBeUndefined();
  });

  it("parallel_tool_calls:true or omitted does not serialize disable_parallel_tool_use (upstream default)", () => {
    for (const parallel_tool_calls of [true, undefined]) {
      const req: OpenAIChatRequest = {
        model: "glm-4.6",
        messages: [{ role: "user", content: "Hi" }],
        tools: [{ type: "function", function: { name: "fn" } }],
        ...(parallel_tool_calls !== undefined ? { parallel_tool_calls } : {}),
      };
      const result = translateRequestOpenAIToAnthropic(req);
      expect(result.tool_choice).toBeUndefined();
    }
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

  it("end-to-end: Responses tool output with input_image reaches Anthropic as a tool_result image block", () => {
    // A client sending a read_file image result to /v1/responses goes through
    // the full chain Responses→Chat→Anthropic, and every hop must preserve
    // the image (previously dropped at the Responses→Chat hop).
    const dataUrl = "data:image/png;base64,aGVsbG8=";
    const responsesReq = {
      model: "glm-4.6",
      input: [
        { type: "message", role: "user", content: "look at the screenshot" },
        { type: "function_call", call_id: "call_img", name: "read_file", arguments: '{"path":"s.png"}' },
        { type: "function_call_output", call_id: "call_img", output: [
          { type: "input_text", text: "Read image file: s.png" },
          { type: "input_image", image_url: dataUrl },
        ] },
      ],
    } as Parameters<typeof responsesToChatCompletions>[0];
    const chatReq = responsesToChatCompletions(responsesReq).chatRequest;
    const anthropicReq = translateRequestOpenAIToAnthropic(chatReq);
    const toolResultMsg = anthropicReq.messages[2];
    expect(toolResultMsg.role).toBe("user");
    const blocks = toolResultMsg.content as any[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("tool_result");
    expect(blocks[0].tool_use_id).toBe("call_img");
    const inner = blocks[0].content as any[];
    expect(inner).toEqual([
      { type: "text", text: "Read image file: s.png" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
    ]);
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

  it("preserves non-data: image URLs in tool results as url-source image blocks", () => {
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
    expect(inner[0]).toEqual({ type: "text", text: "see:" });
    expect(inner[1]).toEqual({ type: "image", source: { type: "url", url: "https://example.com/img.png" } });
  });

  it("preserves image_url parts in regular user messages (data: URL → base64 image block)", () => {
    const req: OpenAIChatRequest = {
      model: "glm-4.6",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
        ],
      }],
    };
    const result = translateRequestOpenAIToAnthropic(req);
    const blocks = result.messages[0].content as AnthropicContentBlock[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: "text", text: "what is this?" });
    expect(blocks[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
    });
  });

  it("preserves http(s) image URLs in regular user messages as url-source image blocks", () => {
    const req: OpenAIChatRequest = {
      model: "glm-4.6",
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "https://example.com/cat.png", detail: "high" } },
        ],
      }],
    };
    const result = translateRequestOpenAIToAnthropic(req);
    const blocks = result.messages[0].content as AnthropicContentBlock[];
    expect(blocks).toEqual([{ type: "image", source: { type: "url", url: "https://example.com/cat.png" } }]);
  });

  it("degrades non-http non-base64 image URLs to a text block (no invalid url-source block)", () => {
    const req: OpenAIChatRequest = {
      model: "glm-4.6",
      messages: [{
        role: "user",
        content: [{ type: "image_url", image_url: { url: "ftp://example.com/img.png" } }],
      }],
    };
    const result = translateRequestOpenAIToAnthropic(req);
    const blocks = result.messages[0].content as AnthropicContentBlock[];
    expect(blocks).toEqual([{ type: "text", text: "ftp://example.com/img.png" }]);
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

  it("enables Anthropic thinking by default for GLM reasoning models (with the SDK's 1024 default budget)", () => {
    const req: OpenAIChatRequest = {
      model: "glm-5.2",
      messages: [{ role: "user", content: "Hi" }],
    };

    const result = translateRequestOpenAIToAnthropic(req);

    // Catalog "enabled" default always carries budgetTokens: 1024 on the wire.
    expect(result.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
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

  describe("GLM-5.3 reasoning-effort bug: reasoning_effort alone must produce output_config.effort AND a matching thinking.budget_tokens", () => {
    // Before the fix, `translateThinking()` only special-cased
    // `reasoning_effort:"none"`; every other value (e.g. "high") degraded to
    // `{type:"enabled"}` with no budget_tokens and no output_config. Captured
    // live upstream body: {"model":"glm-5.3","max_tokens":40000,"thinking":{"type":"enabled"}}
    // — which produced 1 character of thinking instead of ~244.

    it("glm-5.3: reasoning_effort:'high' sets BOTH output_config.effort and thinking.budget_tokens", () => {
      const req: OpenAIChatRequest = {
        model: "glm-5.3",
        messages: [{ role: "user", content: "Hi" }],
        reasoning_effort: "high",
        max_tokens: 40_000,
      };

      const result = translateRequestOpenAIToAnthropic(req);

      expect(result.output_config).toEqual({ effort: "high" });
      expect(result.thinking).toEqual({ type: "enabled", budget_tokens: 16_000 });
    });

    it("glm-5.3-flash: reasoning_effort:'high' also sets BOTH fields (previously got no thinking field at all)", () => {
      const req: OpenAIChatRequest = {
        model: "glm-5.3-flash",
        messages: [{ role: "user", content: "Hi" }],
        reasoning_effort: "high",
        max_tokens: 40_000,
      };

      const result = translateRequestOpenAIToAnthropic(req);

      expect(result.output_config).toEqual({ effort: "high" });
      expect(result.thinking).toEqual({ type: "enabled", budget_tokens: 16_000 });
    });

    it("glm-5.3: absent reasoning_effort defaults to 'max' (ZCode catalog defaultLevel), not near-zero", () => {
      const req: OpenAIChatRequest = {
        model: "glm-5.3",
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 40_000,
      };

      const result = translateRequestOpenAIToAnthropic(req);

      expect(result.output_config).toEqual({ effort: "max" });
      expect(result.thinking).toEqual({ type: "enabled", budget_tokens: 32_000 });
    });

    it("glm-5.3: reasoning_effort:'medium' rounds UP to 'high' effort/budget, not down to 'low'", () => {
      const req: OpenAIChatRequest = {
        model: "glm-5.3",
        messages: [{ role: "user", content: "Hi" }],
        reasoning_effort: "medium",
        max_tokens: 40_000,
      };

      const result = translateRequestOpenAIToAnthropic(req);

      expect(result.output_config).toEqual({ effort: "high" });
      expect(result.thinking).toEqual({ type: "enabled", budget_tokens: 16_000 });
    });

    it("glm-5.3: reasoning_effort:'none' routes through the effort channel as 'low' rather than {type:'disabled'} (disabling is a no-op upstream)", () => {
      const req: OpenAIChatRequest = {
        model: "glm-5.3",
        messages: [{ role: "user", content: "Hi" }],
        reasoning_effort: "none",
        max_tokens: 40_000,
      };

      const result = translateRequestOpenAIToAnthropic(req);

      expect(result.output_config).toEqual({ effort: "low" });
      expect(result.thinking).toEqual({ type: "enabled", budget_tokens: 8_000 });
    });

    it("glm-5.3: explicit thinking.budget_tokens is respected over the effort-level default budget, but output_config.effort is still attached", () => {
      const req = {
        model: "glm-5.3",
        messages: [{ role: "user", content: "Hi" }],
        reasoning_effort: "high",
        max_tokens: 40_000,
        thinking: { type: "enabled", budget_tokens: 5000 },
      } as OpenAIChatRequest;

      const result = translateRequestOpenAIToAnthropic(req);

      expect(result.output_config).toEqual({ effort: "high" });
      expect(result.thinking).toEqual({ type: "enabled", budget_tokens: 5000 });
    });

    // A JSON body may carry a fractional budget. Testing `> 0` before flooring
    // lets 0.5 through as a floored 0, which `fitGlm53Budget` passes straight
    // out again whenever max_tokens is not a finite number.
    it("glm-5.3: a sub-1 fractional explicit budget is ignored in favour of the effort default, never sent as 0", () => {
      const req = {
        model: "glm-5.3",
        messages: [{ role: "user", content: "Hi" }],
        reasoning_effort: "low",
        max_tokens: 40_000,
        thinking: { type: "enabled", budget_tokens: 0.5 },
      } as OpenAIChatRequest;

      const result = translateRequestOpenAIToAnthropic(req);

      expect(result.thinking).toEqual({ type: "enabled", budget_tokens: 8_000 });
    });

    it("glm-5.3: a fractional explicit budget above 1 is floored, not rounded", () => {
      const req = {
        model: "glm-5.3",
        messages: [{ role: "user", content: "Hi" }],
        reasoning_effort: "high",
        max_tokens: 40_000,
        thinking: { type: "enabled", budget_tokens: 5000.7 },
      } as OpenAIChatRequest;

      const result = translateRequestOpenAIToAnthropic(req);

      expect(result.thinking).toEqual({ type: "enabled", budget_tokens: 5000 });
    });

    it("glm-5.3: the thinking budget rides ON TOP of max_tokens (SDK additive rule), budget itself clamped only by the model ceiling", () => {
      const req: OpenAIChatRequest = {
        model: "glm-5.3",
        messages: [{ role: "user", content: "Hi" }],
        reasoning_effort: "max",
        max_tokens: 20_000,
      };

      const result = translateRequestOpenAIToAnthropic(req);

      // Bundle builder: max_tokens = Z + budget (then clamped to the model
      // max 128,000). 20_000 + 32_000 = 52_000 — the answer keeps its 20_000.
      expect(result.max_tokens).toBe(52_000);
      expect(result.thinking).toEqual({ type: "enabled", budget_tokens: 32_000 });
      expect(result.output_config).toEqual({ effort: "max" });
    });

    it("client omits max_tokens on glm-5.3: defaults to the model's catalog maxOutputTokens (128,000), not the generic 4096, so the max-effort thinking budget survives untouched", () => {
      const req: OpenAIChatRequest = {
        model: "glm-5.3",
        messages: [{ role: "user", content: "Hi" }],
        reasoning_effort: "max",
      };

      const result = translateRequestOpenAIToAnthropic(req);

      // Before this fix, the generic DEFAULT_MAX_TOKENS (4096) fallback meant
      // fitGlm53Budget(32_000, 4096) clamped the thinking budget down to
      // 4095 — nearly the entire response allowance, leaving ~1 token for
      // the answer. A model-aware default fixes that at the source.
      expect(result.max_tokens).toBe(128_000);
      expect(result.thinking).toEqual({ type: "enabled", budget_tokens: 32_000 });
      expect(result.output_config).toEqual({ effort: "max" });
    });

    // The effort channel is keyed off the model id, not off catalog membership,
    // so it keeps working for a family member the pinned catalog does not list
    // (glm-5.3-flash used to be one until master pinned it). Only the
    // max_tokens fallback consults the catalog, and it degrades to the generic
    // default rather than failing.
    it("an unlisted GLM-5.3-family id still gets the effort channel, with the generic max_tokens fallback", () => {
      const req: OpenAIChatRequest = {
        model: "glm-5.3-air",
        messages: [{ role: "user", content: "Hi" }],
        reasoning_effort: "max",
      };

      const result = translateRequestOpenAIToAnthropic(req);

      expect(result.output_config).toEqual({ effort: "max" });
      // No catalog entry → no model clamp and no max_tokens ceiling: the
      // generic 4096 fallback still gets the 32_000 budget added on top.
      expect(result.max_tokens).toBe(4096 + 32_000);
      expect(result.thinking).toEqual({ type: "enabled", budget_tokens: 32_000 });
    });

    it("glm-5.3-flash (pinned since master advertised it) gets the same model-aware default as glm-5.3", () => {
      const req: OpenAIChatRequest = {
        model: "glm-5.3-flash",
        messages: [{ role: "user", content: "Hi" }],
        reasoning_effort: "max",
      };

      const result = translateRequestOpenAIToAnthropic(req);

      expect(result.output_config).toEqual({ effort: "max" });
      expect(result.max_tokens).toBe(128_000);
      expect(result.thinking).toEqual({ type: "enabled", budget_tokens: 32_000 });
    });

    it("a GLM-5.3-family id absent from the catalog falls back to the generic 4096 default, not a crash", () => {
      const req: OpenAIChatRequest = {
        model: "glm-5.3-unlisted-variant",
        messages: [{ role: "user", content: "Hi" }],
        reasoning_effort: "low",
      };

      const result = translateRequestOpenAIToAnthropic(req);

      // Generic fallback + additive low-effort budget.
      expect(result.max_tokens).toBe(4096 + 8_000);
      expect(result.thinking).toEqual({ type: "enabled", budget_tokens: 8_000 });
    });

    it("non-GLM-5.3 catalog models also default to their catalog maxOutputTokens (glm-4.7: 131,072)", () => {
      const req: OpenAIChatRequest = {
        model: "glm-4.7",
        messages: [{ role: "user", content: "Hi" }],
      };

      const result = translateRequestOpenAIToAnthropic(req);

      // 131_072 base + 1024 default budget, clamped back to the 131_072 ceiling.
      expect(result.max_tokens).toBe(131_072);
    });

    it("glm-5.3: explicit thinking:{type:'disabled'} is forwarded as-is, not overridden to an effort level", () => {
      const req = {
        model: "glm-5.3",
        messages: [{ role: "user", content: "Hi" }],
        thinking: { type: "disabled" },
      } as OpenAIChatRequest;

      const result = translateRequestOpenAIToAnthropic(req);

      expect(result.thinking).toEqual({ type: "disabled" });
      expect(result.output_config).toBeUndefined();
    });

    it("glm-4.7 (non-GLM-5.3 reasoning model): no output_config, thinking on with the SDK default budget", () => {
      const req: OpenAIChatRequest = {
        model: "glm-4.7",
        messages: [{ role: "user", content: "Hi" }],
        reasoning_effort: "high",
      };

      const result = translateRequestOpenAIToAnthropic(req);

      expect(result.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
      expect(result.output_config).toBeUndefined();
    });
  });

  describe("applyAnthropicThinkingCompat (bundle builder compat rules)", () => {
    it("voids temperature/top_k/top_p when thinking is enabled", () => {
      const req: OpenAIChatRequest = {
        model: "glm-5.3",
        messages: [{ role: "user", content: "Hi" }],
        reasoning_effort: "high",
        temperature: 0.7,
        top_p: 0.9,
      };

      const result = translateRequestOpenAIToAnthropic(req);

      expect(result.temperature).toBeUndefined();
      expect(result.top_p).toBeUndefined();
      expect(result.top_k).toBeUndefined();
      expect(result.thinking).toEqual({ type: "enabled", budget_tokens: 16_000 });
    });

    it("voids top_p when temperature is set and thinking is NOT enabled (SDK topP-vs-temperature rule)", () => {
      const req: OpenAIChatRequest = {
        model: "glm-4.6v",
        messages: [{ role: "user", content: "Hi" }],
        temperature: 0.5,
        top_p: 0.9,
      };

      const result = translateRequestOpenAIToAnthropic(req);

      expect(result.temperature).toBe(0.5);
      expect(result.top_p).toBeUndefined();
    });

    it("keeps temperature and top_p independently when only one is set and thinking is off", () => {
      const tempOnly = translateRequestOpenAIToAnthropic({
        model: "glm-4.6v",
        messages: [{ role: "user", content: "Hi" }],
        temperature: 0.5,
      });
      expect(tempOnly.temperature).toBe(0.5);
      expect(tempOnly.top_p).toBeUndefined();

      const topPOnly = translateRequestOpenAIToAnthropic({
        model: "glm-4.6v",
        messages: [{ role: "user", content: "Hi" }],
        top_p: 0.9,
      });
      expect(topPOnly.temperature).toBeUndefined();
      expect(topPOnly.top_p).toBe(0.9);
    });

    it("adaptive thinking voids sampling params but adds no default budget (SDK: budget default only for 'enabled')", () => {
      const req = {
        model: "glm-5.2",
        messages: [{ role: "user", content: "Hi" }],
        thinking: { type: "adaptive" },
        temperature: 0.3,
      } as OpenAIChatRequest;

      const result = translateRequestOpenAIToAnthropic(req);

      expect(result.thinking).toEqual({ type: "adaptive" });
      expect(result.temperature).toBeUndefined();
      // adaptive carries no budget → max_tokens gains +0 (128_000 base).
      expect(result.max_tokens).toBe(128_000);
    });

    it("explicitly disabled thinking keeps temperature but still voids top_p (topP-vs-temperature rule is thinking-independent)", () => {
      const req = {
        model: "glm-5.2",
        messages: [{ role: "user", content: "Hi" }],
        thinking: { type: "disabled" },
        temperature: 0.7,
        top_p: 0.9,
      } as OpenAIChatRequest;

      const result = translateRequestOpenAIToAnthropic(req);

      expect(result.temperature).toBe(0.7);
      expect(result.top_p).toBeUndefined();
      expect(result.max_tokens).toBe(128_000);
    });

    it("max_tokens + budget is clamped to the model's catalog ceiling", () => {
      const req: OpenAIChatRequest = {
        model: "glm-5.3",
        messages: [{ role: "user", content: "Hi" }],
        reasoning_effort: "max",
        max_tokens: 120_000,
      };

      const result = translateRequestOpenAIToAnthropic(req);

      // 120_000 + 32_000 = 152_000 → clamped to the 128_000 ceiling.
      expect(result.max_tokens).toBe(128_000);
      expect(result.thinking).toEqual({ type: "enabled", budget_tokens: 32_000 });
    });
  });
});

describe("anthropicUsageToOpenAI", () => {
  it("folds cache reads into prompt_tokens and reports them as cached_tokens", () => {
    expect(anthropicUsageToOpenAI({
      input_tokens: 8,
      output_tokens: 3,
      cache_read_input_tokens: 1216,
      cache_creation_input_tokens: 0,
    })).toEqual({
      prompt_tokens: 1224,
      completion_tokens: 3,
      total_tokens: 1227,
      prompt_tokens_details: { cached_tokens: 1216 },
    });
  });

  it("counts both cache buckets but exposes only the read bucket", () => {
    const usage = anthropicUsageToOpenAI({
      input_tokens: 100,
      output_tokens: 5,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 30,
    });

    expect(usage).toEqual({
      prompt_tokens: 150,
      completion_tokens: 5,
      total_tokens: 155,
      prompt_tokens_details: { cached_tokens: 20 },
    });
    expect(usage).not.toHaveProperty("cache_read_input_tokens");
    expect(usage).not.toHaveProperty("cache_creation_input_tokens");
  });

  it("does not fabricate prompt_tokens_details when no cache bucket is reported", () => {
    expect(anthropicUsageToOpenAI({ input_tokens: 10, output_tokens: 2 })).toEqual({
      prompt_tokens: 10,
      completion_tokens: 2,
      total_tokens: 12,
    });
  });

  it("preserves an explicitly reported zero cache read", () => {
    expect(anthropicUsageToOpenAI({
      input_tokens: 10,
      output_tokens: 2,
      cache_read_input_tokens: 0,
    }).prompt_tokens_details).toEqual({ cached_tokens: 0 });
  });

  it("round-trips fresh input and cache reads through openaiUsageToAnthropic", () => {
    const anthropic = { input_tokens: 8, output_tokens: 3, cache_read_input_tokens: 1216 };
    expect(openaiUsageToAnthropic(anthropicUsageToOpenAI(anthropic))).toEqual(anthropic);
  });

  it("round-trips totals but not the cache-creation bucket, which OpenAI cannot express", () => {
    const anthropic = {
      input_tokens: 8,
      output_tokens: 3,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 20,
    };
    const back = openaiUsageToAnthropic(anthropicUsageToOpenAI(anthropic));

    expect(back.input_tokens + (back.cache_read_input_tokens ?? 0) + (back.cache_creation_input_tokens ?? 0))
      .toBe(128);
    expect(back.cache_creation_input_tokens).toBeUndefined();
    expect(back.input_tokens).toBe(28);
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

  it("reports cache-inclusive prompt_tokens for a cached response", () => {
    const resp: AnthropicMessagesResponse = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Hi" }],
      model: "glm-4.6",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 8,
        output_tokens: 3,
        cache_read_input_tokens: 1216,
        cache_creation_input_tokens: 0,
      },
    };

    expect(translateResponseAnthropicToOpenAI(resp, "glm-4.6").usage).toEqual({
      prompt_tokens: 1224,
      completion_tokens: 3,
      total_tokens: 1227,
      prompt_tokens_details: { cached_tokens: 1216 },
    });
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

  it("preserves base64 image blocks as image_url data: URLs", () => {
    const req: AnthropicMessagesRequest = {
      model: "glm-4.6",
      max_tokens: 100,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
        ],
      }],
    };
    const result = translateRequestAnthropicToOpenAI(req);
    const content = result.messages[0].content as OpenAIContentPart[];
    expect(content).toEqual([
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
    ]);
  });

  it("preserves url-source image blocks as image_url http URLs", () => {
    const req: AnthropicMessagesRequest = {
      model: "glm-4.6",
      max_tokens: 100,
      messages: [{
        role: "user",
        content: [{ type: "image", source: { type: "url", url: "https://example.com/img.png" } }],
      }],
    };
    const result = translateRequestAnthropicToOpenAI(req);
    const content = result.messages[0].content as OpenAIContentPart[];
    expect(content).toEqual([{ type: "image_url", image_url: { url: "https://example.com/img.png" } }]);
  });

  it("round-trips images through both translators without loss", () => {
    const original: OpenAIChatRequest = {
      model: "glm-4.6",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "see" },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } },
          { type: "image_url", image_url: { url: "https://example.com/a.png" } },
        ],
      }],
    };
    const anthropic = translateRequestOpenAIToAnthropic(original);
    const back = translateRequestAnthropicToOpenAI(anthropic);
    expect(back.messages[0].content).toEqual(original.messages[0].content);
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

// ─────────────────────────────────────────────
// video_url / file part mapping (ZCode-plan gateway accepts base64 video and
// PDF document blocks — live-verified 2026-10-03 against glm-5.3-flash)
// ─────────────────────────────────────────────

describe("translateRequestOpenAIToAnthropic: video_url / file parts", () => {
  it("maps video_url data URL → video block with base64 source", () => {
    const req: OpenAIChatRequest = {
      model: "glm-4.6v",
      messages: [{
        role: "user",
        content: [
          { type: "video_url", video_url: { url: "data:video/mp4;base64,AAAAKGZ0eXBtcDQy" } },
          { type: "text", text: "describe this" },
        ],
      }],
    };
    const result = translateRequestOpenAIToAnthropic(req);
    const blocks = result.messages[0].content as any[];
    expect(blocks[0]).toEqual({
      type: "video",
      source: { type: "base64", media_type: "video/mp4", data: "AAAAKGZ0eXBtcDQy" },
    });
  });

  it("maps video_url http(s) URL → video block with url source", () => {
    const req: OpenAIChatRequest = {
      model: "glm-4.6v",
      messages: [{
        role: "user",
        content: [{ type: "video_url", video_url: { url: "https://example.com/clip.mp4" } }],
      }],
    };
    const result = translateRequestOpenAIToAnthropic(req);
    const blocks = result.messages[0].content as any[];
    expect(blocks[0]).toEqual({
      type: "video",
      source: { type: "url", url: "https://example.com/clip.mp4" },
    });
  });

  it("degrades an exotic-scheme video_url to a text block carrying the URL", () => {
    const req: OpenAIChatRequest = {
      model: "glm-4.6v",
      messages: [{
        role: "user",
        content: [{ type: "video_url", video_url: { url: "ftp://example.com/clip.mp4" } }],
      }],
    };
    const result = translateRequestOpenAIToAnthropic(req);
    const blocks = result.messages[0].content as any[];
    expect(blocks[0]).toEqual({ type: "text", text: "ftp://example.com/clip.mp4" });
  });

  it("maps file file_data PDF data URL → document block with base64 source and title", () => {
    const req: OpenAIChatRequest = {
      model: "glm-4.6",
      messages: [{
        role: "user",
        content: [
          { type: "file", file: { filename: "report.pdf", file_data: "data:application/pdf;base64,JVBERi0xLjQK" } },
          { type: "text", text: "summarize" },
        ],
      }],
    };
    const result = translateRequestOpenAIToAnthropic(req);
    const blocks = result.messages[0].content as any[];
    expect(blocks[0]).toEqual({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: "JVBERi0xLjQK" },
      title: "report.pdf",
    });
  });

  it("maps file file_data http(s) URL → document block with url source", () => {
    const req: OpenAIChatRequest = {
      model: "glm-4.6",
      messages: [{
        role: "user",
        content: [{ type: "file", file: { filename: "doc.pdf", file_data: "https://example.com/doc.pdf" } }],
      }],
    };
    const result = translateRequestOpenAIToAnthropic(req);
    const blocks = result.messages[0].content as any[];
    expect(blocks[0]).toEqual({
      type: "document",
      source: { type: "url", url: "https://example.com/doc.pdf" },
      title: "doc.pdf",
    });
  });

  it("degrades a file_id-only file part to a text block carrying the filename", () => {
    const req: OpenAIChatRequest = {
      model: "glm-4.6",
      messages: [{
        role: "user",
        content: [{ type: "file", file: { filename: "upload.pdf" } }],
      }],
    };
    const result = translateRequestOpenAIToAnthropic(req);
    const blocks = result.messages[0].content as any[];
    expect(blocks[0]).toEqual({ type: "text", text: "upload.pdf" });
  });

  it("maps video_url/file parts inside tool_result content", () => {
    const req: OpenAIChatRequest = {
      model: "glm-4.6v",
      messages: [
        { role: "user", content: "record" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "read_video", arguments: "{}" } }],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: [
            { type: "text", text: "clip:" },
            { type: "video_url", video_url: { url: "data:video/webm;base64,AAAA" } },
            { type: "file", file: { filename: "log.pdf", file_data: "data:application/pdf;base64,JVBERi0=" } },
          ],
        },
      ],
    };
    const result = translateRequestOpenAIToAnthropic(req);
    const toolResultMsg = result.messages[2];
    expect(toolResultMsg.role).toBe("user");
    const inner = (toolResultMsg.content as any[])[0].content;
    expect(Array.isArray(inner)).toBe(true);
    expect(inner[0]).toEqual({ type: "text", text: "clip:" });
    expect(inner[1]).toEqual({
      type: "video",
      source: { type: "base64", media_type: "video/webm", data: "AAAA" },
    });
    expect(inner[2]).toEqual({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" },
      title: "log.pdf",
    });
  });
});
