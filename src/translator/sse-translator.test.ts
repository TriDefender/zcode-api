/**
 * Tests for SSE event translator.
 * @see .omo/plans/zcode-proxy.md Task 12
 */
import { describe, it, expect } from "bun:test";
import { anthropicSseToOpenaiSse, openaiSseToAnthropicSse } from "./sse-translator.js";

function makeStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  return result;
}

interface ParsedChunk {
  choices: Array<{
    delta: {
      role?: string;
      content?: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: string | null;
  }>;
}

function parseChunks(output: string): ParsedChunk[] {
  return output
    .split('\n')
    .filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]')
    .map((l) => JSON.parse(l.slice(6)) as ParsedChunk);
}

function parseAnthropicEvents(output: string): Array<{ event: string; data: any }> {
  return output
    .split("\n\n")
    .map((block) => {
      const lines = block.trim().split("\n").filter(Boolean);
      const event = lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "";
      const dataLine = lines.find((line) => line.startsWith("data: "));
      if (!dataLine) return null;
      return { event, data: JSON.parse(dataLine.slice(6)) };
    })
    .filter((event): event is { event: string; data: any } => event !== null);
}

const ANTHROPIC_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_123","type":"message","role":"assistant","content":[],"model":"glm-4.6","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":0}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
].join('\n');

describe("anthropicSseToOpenaiSse", () => {
  it("translates message_start to first chunk with role", async () => {
    const input = makeStream(ANTHROPIC_SSE);
    const output = await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));
    expect(output).toContain('"role":"assistant"');
  });

  it("translates text_delta to delta.content", async () => {
    const input = makeStream(ANTHROPIC_SSE);
    const output = await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));
    expect(output).toContain('"content":"Hello"');
    expect(output).toContain('"content":" world"');
  });

  it("translates thinking_delta to delta.reasoning_content", async () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_1","model":"glm-4.6"}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"I should answer directly."}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig_ignored"}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');

    const output = await collectStream(anthropicSseToOpenaiSse(makeStream(sse), "glm-4.6"));
    const chunks = parseChunks(output);
    const reasoning = chunks
      .map((c) => c.choices[0]?.delta.reasoning_content)
      .filter((text): text is string => typeof text === "string");

    expect(reasoning).toEqual(["I should answer directly."]);
    expect(output).not.toContain("sig_ignored");
  });

  it("translates multiple thinking_delta events into stable reasoning_content deltas", async () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_1","model":"glm-4.6"}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"First step. "}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Second step."}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig_ignored"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');

    const output = await collectStream(anthropicSseToOpenaiSse(makeStream(sse), "glm-4.6"));
    const chunks = parseChunks(output);
    const reasoning = chunks
      .map((c) => c.choices[0]?.delta.reasoning_content)
      .filter((text): text is string => typeof text === "string");

    expect(reasoning).toEqual(["First step. ", "Second step."]);
    expect(output).not.toContain("sig_ignored");
  });

  it("translates message_delta stop_reason to finish_reason", async () => {
    const input = makeStream(ANTHROPIC_SSE);
    const output = await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));
    expect(output).toContain('"finish_reason":"stop"');
  });

  it("emits [DONE] at the end", async () => {
    const input = makeStream(ANTHROPIC_SSE);
    const output = await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));
    expect(output).toContain("data: [DONE]");
  });

  it("emits usage on final chunk from input_tokens + output_tokens", async () => {
    const input = makeStream(ANTHROPIC_SSE);
    const output = await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));
    expect(output).toContain('"usage"');
    expect(output).toContain('"prompt_tokens":10');
    expect(output).toContain('"completion_tokens":5');
    expect(output).toContain('"total_tokens":15');
  });

  it("handles max_tokens stop reason", async () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_1","model":"glm-4.6"}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');
    const input = makeStream(sse);
    const output = await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));
    expect(output).toContain('"finish_reason":"length"');
  });

  it("emits OpenAI tool_calls delta with id+name+empty arguments on tool_use content_block_start", async () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_1","model":"glm-4.6"}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_abc","name":"get_weather","input":{}}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');
    const input = makeStream(sse);
    const output = await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));
    const chunks = parseChunks(output);
    const toolCallChunks = chunks.filter((c) => c.choices?.[0]?.delta?.tool_calls);
    expect(toolCallChunks).toHaveLength(1);
    const tc = toolCallChunks[0].choices[0].delta.tool_calls![0];
    expect(tc).toEqual({
      index: 0,
      id: "toolu_abc",
      type: "function",
      function: { name: "get_weather", arguments: "" },
    });
    const finishReasons = chunks
      .flatMap((c) => c.choices ?? [])
      .map((ch) => ch.finish_reason)
      .filter((fr): fr is string => fr !== null && fr !== undefined);
    expect(finishReasons).toEqual(["tool_calls"]);
  });

  it("streams input_json_delta as OpenAI tool_calls.function.arguments deltas", async () => {
    const deltaLine = (partial: string) =>
      `data: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: partial },
      })}`;
    const sse = [
      'event: message_start',
      `data: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", model: "glm-4.6" } })}`,
      '',
      'event: content_block_start',
      `data: ${JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} },
      })}`,
      '',
      'event: content_block_delta',
      deltaLine('{"city":'),
      '',
      'event: content_block_delta',
      deltaLine('"SF"}'),
      '',
      'event: content_block_stop',
      `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
      '',
      'event: message_delta',
      `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" } })}`,
      '',
      'event: message_stop',
      `data: ${JSON.stringify({ type: "message_stop" })}`,
      '',
    ].join('\n');
    const input = makeStream(sse);
    const output = await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));
    const chunks = output
      .split('\n')
      .filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]')
      .map((l) => JSON.parse(l.slice(6)) as { choices: Array<{ delta: { tool_calls?: Array<{ index: number; function?: { arguments?: string } }> } }> });
    const argChunks = chunks
      .flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? []);
    expect(argChunks.length).toBe(3);
    expect(argChunks[0]).toMatchObject({ index: 0, id: "toolu_1" });
    expect(argChunks[0].function?.arguments).toBe("");
    expect(argChunks[1].function?.arguments).toBe('{"city":');
    expect(argChunks[2].function?.arguments).toBe('"SF"}');
    const assembled = (argChunks.map((c) => c.function?.arguments ?? "").join(""));
    expect(JSON.parse(assembled)).toEqual({ city: "SF" });
  });

  it("uses separate incrementing OpenAI tool_calls index for multiple parallel tool_use blocks", async () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_1","model":"glm-4.6"}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_a","name":"w","input":{}}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_b","name":"w","input":{}}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');
    const input = makeStream(sse);
    const output = await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));
    const chunks = parseChunks(output);
    const toolCallChunks = chunks.filter((c) => c.choices?.[0]?.delta?.tool_calls);
    expect(toolCallChunks).toHaveLength(2);
    expect(toolCallChunks[0].choices[0].delta.tool_calls![0]).toEqual({
      index: 0,
      id: "toolu_a",
      type: "function",
      function: { name: "w", arguments: "" },
    });
    expect(toolCallChunks[1].choices[0].delta.tool_calls![0]).toEqual({
      index: 1,
      id: "toolu_b",
      type: "function",
      function: { name: "w", arguments: "" },
    });
  });

  it("does not emit tool_calls for text-only streams (regression)", async () => {
    const input = makeStream(ANTHROPIC_SSE);
    const output = await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));
    expect(output).not.toContain('"tool_calls"');
  });

  it("emits exactly one non-null finish_reason per stream (no duplicate from message_stop)", async () => {
    const sse = [
      'event: message_start',
      `data: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", model: "glm-4.6" } })}`,
      '',
      'event: content_block_start',
      `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "w", input: {} } })}`,
      '',
      'event: message_delta',
      `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" } })}`,
      '',
      'event: message_stop',
      `data: ${JSON.stringify({ type: "message_stop" })}`,
      '',
    ].join('\n');
    const input = makeStream(sse);
    const output = await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));
    const chunks = output
      .split('\n')
      .filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]')
      .map((l) => JSON.parse(l.slice(6)) as { choices: Array<{ finish_reason: string | null }> });
    const finishReasons = chunks
      .flatMap((c) => c.choices ?? [])
      .map((ch) => ch.finish_reason)
      .filter((fr): fr is string => fr !== null && fr !== undefined);
    expect(finishReasons).toHaveLength(1);
    expect(finishReasons[0]).toBe("tool_calls");
  });

  it("still emits finish_reason='stop' via message_stop when message_delta lacks stop_reason", async () => {
    const sse = [
      'event: message_start',
      `data: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", model: "glm-4.6" } })}`,
      '',
      'event: content_block_delta',
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } })}`,
      '',
      'event: message_stop',
      `data: ${JSON.stringify({ type: "message_stop" })}`,
      '',
    ].join('\n');
    const input = makeStream(sse);
    const output = await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));
    const chunks = output
      .split('\n')
      .filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]')
      .map((l) => JSON.parse(l.slice(6)) as { choices: Array<{ finish_reason: string | null }> });
    const finishReasons = chunks
      .flatMap((c) => c.choices ?? [])
      .map((ch) => ch.finish_reason)
      .filter((fr): fr is string => fr !== null && fr !== undefined);
    expect(finishReasons).toHaveLength(1);
    expect(finishReasons[0]).toBe("stop");
  });
});

describe("openaiSseToAnthropicSse", () => {
  it("emits message_start on first chunk", async () => {
    const sse = [
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":123,"model":"glm-4.6","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
      '',
    ].join('\n');
    const input = makeStream(sse);
    const output = await collectStream(openaiSseToAnthropicSse(input, "glm-4.6"));
    expect(output).toContain("message_start");
    expect(output).toContain('"role":"assistant"');
  });

  it("translates delta.content to text_delta", async () => {
    const sse = [
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"glm-4.6","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const input = makeStream(sse);
    const output = await collectStream(openaiSseToAnthropicSse(input, "glm-4.6"));
    expect(output).toContain("text_delta");
    expect(output).toContain('"text":"Hi"');
  });

  it("translates delta.reasoning_content to thinking_delta", async () => {
    const sse = [
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"glm-4.6","choices":[{"index":0,"delta":{"reasoning_content":"I should answer directly."},"finish_reason":null}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');

    const output = await collectStream(openaiSseToAnthropicSse(makeStream(sse), "glm-4.6"));

    expect(output).toContain("thinking_delta");
    expect(output).toContain('"thinking":"I should answer directly."');
  });

  it("keeps consecutive reasoning_content deltas in one official Anthropic thinking block", async () => {
    const sse = [
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"glm-4.6","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
      '',
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"glm-4.6","choices":[{"index":0,"delta":{"reasoning_content":"First step. "},"finish_reason":null}]}',
      '',
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"glm-4.6","choices":[{"index":0,"delta":{"reasoning_content":"Second step."},"finish_reason":null}]}',
      '',
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"glm-4.6","choices":[{"index":0,"delta":{"content":"Final."},"finish_reason":null}]}',
      '',
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"glm-4.6","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');

    const output = await collectStream(openaiSseToAnthropicSse(makeStream(sse), "glm-4.6"));
    const events = parseAnthropicEvents(output);
    const thinkingStarts = events.filter((e) =>
      e.event === "content_block_start" && e.data.content_block?.type === "thinking"
    );
    const thinkingDeltas = events.filter((e) => e.data.delta?.type === "thinking_delta");
    const thinkingStops = events.filter((e) =>
      e.event === "content_block_stop" && e.data.index === thinkingStarts[0]?.data.index
    );
    const textStarts = events.filter((e) =>
      e.event === "content_block_start" && e.data.content_block?.type === "text"
    );

    expect(thinkingStarts).toHaveLength(1);
    expect(thinkingStarts[0].data).toEqual({
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "" },
    });
    expect(thinkingDeltas.map((e) => e.data.index)).toEqual([0, 0]);
    expect(thinkingDeltas.map((e) => e.data.delta.thinking)).toEqual(["First step. ", "Second step."]);
    expect(thinkingStops).toHaveLength(1);
    expect(textStarts[0].data.index).toBe(1);
  });

  it("emits message_stop on [DONE]", async () => {
    const sse = [
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"glm-4.6","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const input = makeStream(sse);
    const output = await collectStream(openaiSseToAnthropicSse(input, "glm-4.6"));
    expect(output).toContain("message_stop");
  });
});
