/**
 * SSE event translator — converts streaming events between OpenAI and Anthropic formats.
 * @see .omo/plans/zcode-proxy.md Task 12
 * @see https://docs.anthropic.com/en/api/messages-streaming
 */
import type { AnthropicStreamEvent, OpenAIStreamChunk } from "./types.js";

/** Parse a raw SSE chunk string into event type + JSON data. */
interface ParsedSSE {
  event: string;
  data: unknown;
}

function parseSSEChunk(raw: string): ParsedSSE[] {
  const results: ParsedSSE[] = [];
  const blocks = raw.split("\n\n");

  for (const block of blocks) {
    const lines = block.trim().split("\n").filter(Boolean);
    if (lines.length === 0) continue;

    let eventType = "";
    let dataStr = "";

    for (const line of lines) {
      if (line.startsWith("event: ")) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        dataStr = line.slice(6);
      }
    }

    if (dataStr) {
      try {
        results.push({ event: eventType, data: JSON.parse(dataStr) });
      } catch {
        // Skip malformed JSON
      }
    }
  }

  return results;
}

interface TranslationState {
  messageId: string;
  model: string;
  roleSent: boolean;
  inputTokens: number;
  outputTokens: number;
  toolCallIndex: number;
  blockIndexToToolCallIndex: Map<number, number>;
  finishReasonSent: boolean;
}

function initState(model: string): TranslationState {
  return {
    messageId: "",
    model,
    roleSent: false,
    inputTokens: 0,
    outputTokens: 0,
    toolCallIndex: 0,
    blockIndexToToolCallIndex: new Map(),
    finishReasonSent: false,
  };
}

function makeChunk(
  state: TranslationState,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
): string {
  const chunk: OpenAIStreamChunk & { usage?: typeof usage } = {
    id: state.messageId || "chatcmpl-stream",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: state.model,
    choices: [{
      index: 0,
      delta: delta as any,
      finish_reason: finishReason as any,
    }],
  };
  if (usage) chunk.usage = usage;
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * Transform an Anthropic SSE stream into OpenAI SSE format.
 * Input: ReadableStream<Uint8Array> (Anthropic SSE bytes)
 * Output: ReadableStream<Uint8Array> (OpenAI SSE bytes)
 */
export function anthropicSseToOpenaiSse(
  upstream: ReadableStream<Uint8Array>,
  model: string = "glm-4.6",
): ReadableStream<Uint8Array> {
  const state = initState(model);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  return new ReadableStream({
    async start(controller) {
      const reader = upstream.getReader();
      let errored = false;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split("\n\n");
          buffer = blocks.pop() ?? "";

          for (const block of blocks) {
            const parsed = parseSSEChunk(block);
            for (const p of parsed) {
              const output = translateEvent(state, p);
              if (output) {
                controller.enqueue(encoder.encode(output));
              }
            }
          }
        }

        // Flush remaining buffer
        if (buffer.trim()) {
          const parsed = parseSSEChunk(buffer);
          for (const p of parsed) {
            const output = translateEvent(state, p);
            if (output) controller.enqueue(encoder.encode(output));
          }
        }

        // Emit [DONE]
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (err) {
        errored = true;
        // error()/close() 互斥:errored 流上再 close() 会抛 TypeError,进而触发 Bun 引擎空指针崩溃。
        try { controller.error(err); } catch {}
      } finally {
        if (!errored) {
          try { controller.close(); } catch {}
        }
        reader.releaseLock();
      }
    },
  });
}

function translateEvent(state: TranslationState, sse: ParsedSSE): string | null {
  const data = sse.data as AnthropicStreamEvent;

  switch (data.type) {
    case "message_start": {
      const msg = (data as any).message;
      state.messageId = msg?.id ?? "msg_stream";
      state.model = msg?.model ?? state.model;
      state.inputTokens = msg?.usage?.input_tokens ?? 0;
      if (!state.roleSent) {
        state.roleSent = true;
        return makeChunk(state, { role: "assistant" });
      }
      return null;
    }

    case "content_block_start": {
      if (data.type !== "content_block_start") return null;
      const block = data.content_block;
      const blockIdx = data.index;
      if (block.type === "tool_use") {
        const myIndex = state.toolCallIndex++;
        state.blockIndexToToolCallIndex.set(blockIdx, myIndex);
        return makeChunk(state, {
          tool_calls: [{
            index: myIndex,
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: "" },
          }],
        });
      }
      return null;
    }

    case "content_block_delta": {
      if (data.type !== "content_block_delta") return null;
      const delta = data.delta;
      const blockIdx = data.index;
      if (delta.type === "text_delta") {
        return makeChunk(state, { content: delta.text });
      }
      if (delta.type === "thinking_delta") {
        return makeChunk(state, { reasoning_content: delta.thinking });
      }
      if (delta.type === "signature_delta") {
        return null;
      }
      if (delta.type === "input_json_delta") {
        const myIndex = state.blockIndexToToolCallIndex.get(blockIdx);
        if (myIndex === undefined) return null;
        return makeChunk(state, {
          tool_calls: [{
            index: myIndex,
            function: { arguments: delta.partial_json ?? "" },
          }],
        });
      }
      return null;
    }

    case "message_delta": {
      const dataAny = data as any;
      const delta = dataAny.delta;
      if (dataAny?.usage?.output_tokens !== undefined) {
        state.outputTokens = dataAny.usage.output_tokens;
      }
      if (delta?.stop_reason) {
        const finishReason = mapStopReason(delta.stop_reason);
        state.finishReasonSent = true;
        return makeChunk(state, {}, finishReason, {
          prompt_tokens: state.inputTokens,
          completion_tokens: state.outputTokens,
          total_tokens: state.inputTokens + state.outputTokens,
        });
      }
      return null;
    }

    case "message_stop": {
      if (state.finishReasonSent) return null;
      return makeChunk(state, {}, "stop", {
        prompt_tokens: state.inputTokens,
        completion_tokens: state.outputTokens,
        total_tokens: state.inputTokens + state.outputTokens,
      });
    }

    case "ping":
    case "content_block_stop":
      return null;

    default:
      return null;
  }
}

function mapStopReason(stopReason: string): string {
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    default:
      return "stop";
  }
}

/**
 * Transform an OpenAI SSE stream into Anthropic SSE format.
 * Input: ReadableStream<Uint8Array> (OpenAI SSE bytes)
 * Output: ReadableStream<Uint8Array> (Anthropic SSE bytes)
 */
export function openaiSseToAnthropicSse(
  upstream: ReadableStream<Uint8Array>,
  model: string = "glm-4.6",
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  let messageStarted = false;
  let blockIndex = 0;
  let activeBlock: { type: "text" | "thinking"; index: number } | null = null;
  const messageId = `msg_${Date.now()}`;

  return new ReadableStream({
    async start(controller) {
      const reader = upstream.getReader();
      let errored = false;

      const enqueueAnthropicEvent = (eventType: string, data: unknown) => {
        controller.enqueue(encoder.encode(formatAnthropicSSE(eventType, data)));
      };

      const closeActiveBlock = () => {
        if (!activeBlock) return;
        enqueueAnthropicEvent("content_block_stop", {
          type: "content_block_stop",
          index: activeBlock.index,
        });
        activeBlock = null;
      };

      const ensureActiveBlock = (type: "text" | "thinking"): number => {
        if (activeBlock?.type === type) return activeBlock.index;
        closeActiveBlock();
        const index = blockIndex++;
        activeBlock = { type, index };
        enqueueAnthropicEvent("content_block_start", {
          type: "content_block_start",
          index,
          content_block: type === "text"
            ? { type: "text", text: "" }
            : { type: "thinking", thinking: "", signature: "" },
        });
        return index;
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const dataStr = line.slice(6).trim();

            if (dataStr === "[DONE]") {
              closeActiveBlock();
              enqueueAnthropicEvent("message_stop", { type: "message_stop" });
              continue;
            }

            try {
              const chunk = JSON.parse(dataStr) as OpenAIStreamChunk;
              const choice = chunk.choices?.[0];

              if (!messageStarted) {
                messageStarted = true;
                enqueueAnthropicEvent("message_start", {
                  type: "message_start",
                  message: {
                    id: messageId,
                    type: "message",
                    role: "assistant",
                    content: [],
                    model,
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: 0, output_tokens: 0 },
                  },
                });
              }

              if (choice?.delta?.content) {
                const index = ensureActiveBlock("text");
                enqueueAnthropicEvent("content_block_delta", {
                  type: "content_block_delta",
                  index,
                  delta: { type: "text_delta", text: choice.delta.content },
                });
              }

              if (choice?.delta?.reasoning_content) {
                const index = ensureActiveBlock("thinking");
                enqueueAnthropicEvent("content_block_delta", {
                  type: "content_block_delta",
                  index,
                  delta: { type: "thinking_delta", thinking: choice.delta.reasoning_content },
                });
              }

              if (choice?.finish_reason) {
                const stopReason = mapFinishReason(choice.finish_reason);
                closeActiveBlock();
                enqueueAnthropicEvent("message_delta", {
                  type: "message_delta",
                  delta: { stop_reason: stopReason },
                  usage: { output_tokens: 0 },
                });
              }
            } catch {
              // Skip malformed
            }
          }
        }

        closeActiveBlock();
      } catch (err) {
        errored = true;
        // error()/close() 互斥:errored 流上再 close() 会抛 TypeError,进而触发 Bun 引擎空指针崩溃。
        try { controller.error(err); } catch {}
      } finally {
        if (!errored) {
          try { controller.close(); } catch {}
        }
        reader.releaseLock();
      }
    },
  });
}

function formatAnthropicSSE(eventType: string, data: unknown): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

function mapFinishReason(finishReason: string): string {
  switch (finishReason) {
    case "stop": return "end_turn";
    case "length": return "max_tokens";
    case "tool_calls": return "tool_use";
    default: return "end_turn";
  }
}
