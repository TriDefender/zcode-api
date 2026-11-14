import { describe, it, expect } from "bun:test";
import { responsesToChatCompletions, ToolTranslationError } from "./responses-to-chat.js";
import type { ResponsesRequest } from "./responses-types.js";

function baseReq(overrides: Partial<ResponsesRequest> = {}): ResponsesRequest {
  return { model: "glm-5.2", input: [{ type: "message", role: "user", content: "hi" }], ...overrides };
}

describe("responsesToChatCompletions", () => {
  it("preserves easy input messages alongside explicit messages and skips unknown items", () => {
    const r = responsesToChatCompletions(baseReq({ input: [
      { role: "developer", content: "instruction" },
      { type: "message", role: "assistant", content: "previous answer" },
      { role: "user", content: [{ type: "input_text", text: "next question" }] },
      { type: "unknown", role: "user", content: "skip" },
    ] }));
    expect(r.chatRequest.messages).toEqual([
      { role: "system", content: "instruction" },
      { role: "assistant", content: "previous answer" },
      { role: "user", content: "next question" },
    ]);
  });

  it("translates instructions → system message", () => {
    const r = responsesToChatCompletions(baseReq({ instructions: "be brief" }));
    expect(r.chatRequest.messages[0]).toEqual({ role: "system", content: "be brief" });
  });

  it("translates bare-string input → single user message", () => {
    const r = responsesToChatCompletions(baseReq({ input: "hello world" }));
    expect(r.chatRequest.messages).toEqual([{ role: "user", content: "hello world" }]);
  });

  it("passes function tools through as Chat function tools", () => {
    const r = responsesToChatCompletions(baseReq({
      tools: [{ type: "function", name: "get_weather", parameters: { type: "object" } }],
    }));
    expect(r.chatRequest.tools).toEqual([
      { type: "function", function: { name: "get_weather", parameters: { type: "object" } } },
    ]);
  });

  it("downgrades custom tools to function with {input:string} schema", () => {
    const r = responsesToChatCompletions(baseReq({
      tools: [{ type: "custom", name: "exec", description: "run shell" }],
    }));
    expect(r.chatRequest.tools).toHaveLength(1);
    expect(r.chatRequest.tools![0].function.name).toBe("exec");
    expect(r.chatRequest.tools![0].function.parameters).toEqual({
      type: "object",
      properties: { input: { type: "string" } },
      required: ["input"],
      additionalProperties: false,
    });
    expect(r.customToolNames.has("exec")).toBe(true);
  });

  it("flattens namespace tools to {ns}__{name}", () => {
    const r = responsesToChatCompletions(baseReq({
      tools: [{
        type: "namespace",
        name: "gmail",
        tools: [{ type: "function", name: "send", parameters: { type: "object" } }],
      }],
    }));
    expect(r.chatRequest.tools![0].function.name).toBe("gmail__send");
    expect(r.namespaceMap.get("gmail__send")).toEqual({ namespace: "gmail", name: "send" });
  });

  it("rejects ambiguous namespace flatten collisions", () => {
    expect(() => responsesToChatCompletions(baseReq({
      tools: [
        { type: "function", name: "a__b" },
        { type: "namespace", name: "a", tools: [{ type: "function", name: "b" }] },
      ],
    }))).toThrow(ToolTranslationError);
  });

  it("downgrades tool_search to a same-named function proxy", () => {
    const r = responsesToChatCompletions(baseReq({
      tools: [{ type: "tool_search" }],
    }));
    expect(r.hasToolSearch).toBe(true);
    expect(r.chatRequest.tools![0].function.name).toBe("tool_search");
  });

  it("sets hasWebSearch=true and strips web_search from tools[]", () => {
    const r = responsesToChatCompletions(baseReq({
      tools: [
        { type: "web_search_preview" },
        { type: "function", name: "f", parameters: {} },
      ],
    }));
    expect(r.hasWebSearch).toBe(true);
    expect(r.chatRequest.tools).toHaveLength(1);
    expect(r.chatRequest.tools![0].function.name).toBe("f");
  });

  it("strips file_search/code_interpreter/computer_use_preview/image_generation/mcp silently", () => {
    const r = responsesToChatCompletions(baseReq({
      tools: [
        { type: "file_search", vector_store_ids: ["vs1"] },
        { type: "code_interpreter" },
        { type: "computer_use_preview" },
        { type: "image_generation" },
        { type: "mcp", server_url: "http://x" },
      ],
    }));
    expect(r.chatRequest.tools).toBeUndefined();
    expect(r.hasWebSearch).toBe(false);
  });

  it("drops tool_choice AND parallel_tool_calls when all tools stripped", () => {
    const r = responsesToChatCompletions(baseReq({
      tools: [{ type: "file_search", vector_store_ids: [] }],
      tool_choice: "auto",
      parallel_tool_calls: true,
    }));
    expect(r.chatRequest.tools).toBeUndefined();
    expect(r.chatRequest.tool_choice).toBeUndefined();
    expect(r.chatRequest.parallel_tool_calls).toBeUndefined();
  });

  it("drops tool_choice pointing to a stripped tool", () => {
    const r = responsesToChatCompletions(baseReq({
      tools: [
        { type: "web_search_preview" },
        { type: "function", name: "f", parameters: {} },
      ],
      tool_choice: { type: "web_search_preview" },
    }));
    expect(r.chatRequest.tool_choice).toBeUndefined();
  });

  it("passes tool_choice through when it points to a surviving function", () => {
    const r = responsesToChatCompletions(baseReq({
      tools: [{ type: "function", name: "f", parameters: {} }],
      tool_choice: { type: "function", name: "f" },
    }));
    expect(r.chatRequest.tool_choice).toEqual({ type: "function", function: { name: "f" } });
  });

  it("translates function_call + function_call_output into paired assistant tool_calls + tool reply", () => {
    const r = responsesToChatCompletions(baseReq({
      input: [
        { type: "message", role: "user", content: "what's the weather?" },
        { type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"city":"sf"}' },
        { type: "function_call_output", call_id: "call_1", output: "sunny" },
      ],
    }));
    const msgs = r.chatRequest.messages;
    // user, assistant(tool_calls), tool
    expect(msgs[0].role).toBe("user");
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].tool_calls).toEqual([
      { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"sf"}' } },
    ]);
    expect(msgs[2]).toEqual({ role: "tool", tool_call_id: "call_1", content: "sunny" });
  });

  it("maps function_call_output content-part arrays (input_image) onto Chat tool-message image parts", () => {
    // The Responses spec allows `output` to be a content-part array (OpenAI's
    // own docs show {type:"input_image", image_url} inside a tool result so
    // the model can look at a screenshot the tool returned) — stringly-typed
    // handling dropped the image.
    const dataUrl = "data:image/png;base64,aGVsbG8=";
    const r = responsesToChatCompletions(baseReq({
      input: [
        { type: "message", role: "user", content: "read the png" },
        { type: "function_call", call_id: "call_img", name: "read_file", arguments: '{"path":"a.png"}' },
        { type: "function_call_output", call_id: "call_img", output: [
          { type: "input_text", text: "Read image file: a.png" },
          { type: "input_image", image_url: dataUrl },
        ] },
      ],
    }));
    const toolMsg = r.chatRequest.messages[2];
    expect(toolMsg.role).toBe("tool");
    expect(toolMsg.content).toEqual([
      { type: "text", text: "Read image file: a.png" },
      { type: "image_url", image_url: { url: dataUrl } },
    ]);
  });

  it("stringifies structured (non-array, non-string) function_call_output output", () => {
    const r = responsesToChatCompletions(baseReq({
      input: [
        { type: "function_call", call_id: "c1", name: "get_data", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: { rows: 3, ok: true } },
      ],
    }));
    expect(r.chatRequest.messages[1]).toEqual({
      role: "tool",
      tool_call_id: "c1",
      content: '{"rows":3,"ok":true}',
    });
  });

  it("translates custom_tool_call + output with {input:...} argument shape", () => {
    const r = responsesToChatCompletions(baseReq({
      input: [
        { type: "message", role: "user", content: "run ls" },
        { type: "custom_tool_call", call_id: "call_1", name: "exec", input: "ls -la" },
        { type: "custom_tool_call_output", call_id: "call_1", output: "file1.txt" },
      ],
    }));
    const msgs = r.chatRequest.messages;
    expect(msgs[1].tool_calls![0].function.name).toBe("exec");
    // custom input wrapped as {input:"..."}
    expect(JSON.parse(msgs[1].tool_calls![0].function.arguments)).toEqual({ input: "ls -la" });
    expect(msgs[2]).toEqual({ role: "tool", tool_call_id: "call_1", content: "file1.txt" });
  });

  it("attaches reasoning to the next assistant tool_call message", () => {
    const r = responsesToChatCompletions(baseReq({
      input: [
        { type: "message", role: "user", content: "x" },
        { type: "reasoning", summary: [{ type: "summary_text", text: "thinking..." }] },
        { type: "function_call", call_id: "c1", name: "f", arguments: "{}" },
      ],
    }));
    // messages = [user(0), assistant(1)] — reasoning attaches to the assistant
    const assistant = r.chatRequest.messages[1];
    expect(assistant.role).toBe("assistant");
    expect(assistant.reasoning_content).toBe("thinking...");
  });

  it("forwards reasoning.effort to reasoning_effort on the chat request", () => {
    const r = responsesToChatCompletions(baseReq({ reasoning: { effort: "high" } }));
    expect(r.chatRequest.reasoning_effort).toBe("high");
  });
});

// ─────────────────────────────────────────────
// input_video / input_file parts (media through the Responses endpoint)
// ─────────────────────────────────────────────

describe("responsesToChatCompletions: media parts", () => {
  it("maps input_video part → chat video_url part (keeps parts array form)", () => {
    const r = responsesToChatCompletions(baseReq({ input: [{
      type: "message",
      role: "user",
      content: [
        { type: "input_video", video_url: "data:video/mp4;base64,AAAAKGZ0eXBtcDQy" } as any,
        { type: "input_text", text: "describe this" },
      ],
    }] }));
    expect(r.chatRequest.messages[0]).toEqual({
      role: "user",
      content: [
        { type: "video_url", video_url: { url: "data:video/mp4;base64,AAAAKGZ0eXBtcDQy" } },
        { type: "text", text: "describe this" },
      ],
    });
  });

  it("maps input_file part with file_data → chat file part", () => {
    const r = responsesToChatCompletions(baseReq({ input: [{
      type: "message",
      role: "user",
      content: [
        { type: "input_file", filename: "report.pdf", file_data: "data:application/pdf;base64,JVBERi0xLjQK" } as any,
        { type: "input_text", text: "summarize" },
      ],
    }] }));
    expect(r.chatRequest.messages[0]).toEqual({
      role: "user",
      content: [
        { type: "file", file: { filename: "report.pdf", file_data: "data:application/pdf;base64,JVBERi0xLjQK" } },
        { type: "text", text: "summarize" },
      ],
    });
  });

  it("skips a file_id-only input_file (hosted, no payload) and collapses to text", () => {
    const r = responsesToChatCompletions(baseReq({ input: [{
      type: "message",
      role: "user",
      content: [
        { type: "input_file", file_id: "file_123" } as any,
        { type: "input_text", text: "hello" },
      ],
    }] }));
    expect(r.chatRequest.messages[0]).toEqual({ role: "user", content: "hello" });
  });

  it("degrades media parts in non-user roles to text (existing image rule)", () => {
    const r = responsesToChatCompletions(baseReq({ input: [
      { type: "message", role: "assistant", content: [
        { type: "input_video", video_url: "data:video/mp4;base64,AAAA" } as any,
        { type: "input_text", text: "looked at this" },
      ] },
    ] }));
    expect(r.chatRequest.messages[0]).toEqual({ role: "assistant", content: "looked at this" });
  });

  it("accepts a bare data field as the input_video URL carrier", () => {
    const r = responsesToChatCompletions(baseReq({ input: [{
      type: "message",
      role: "user",
      content: [
        { type: "input_video", data: "data:video/mp4;base64,AAAAKGZ0eXBtcDQy" } as any,
        { type: "input_text", text: "describe" },
      ],
    }] }));
    expect((r.chatRequest.messages[0].content as any[])[0]).toEqual({
      type: "video_url",
      video_url: { url: "data:video/mp4;base64,AAAAKGZ0eXBtcDQy" },
    });
  });
});
