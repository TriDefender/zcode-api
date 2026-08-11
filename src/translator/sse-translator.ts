/**
 * SSE event translator — converts streaming events between OpenAI and Anthropic formats.
 * @see .omo/plans/zcode-proxy.md Task 12
 * @see https://docs.anthropic.com/en/api/messages-streaming
 */
import type { AnthropicStreamEvent, OpenAIStreamChunk, OpenAIStreamToolCall, OpenAIUsage } from "./types.js";
import { openaiUsageToAnthropic } from "./anthropic-to-openai.js";

/** Parse a raw SSE chunk string into event type + JSON data. */
export interface ParsedSSE {
  event: string;
  data: unknown;
}

export function parseSSEChunk(raw: string): ParsedSSE[] {
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

export interface TranslationState {
  messageId: string;
  model: string;
  roleSent: boolean;
  inputTokens: number;
  outputTokens: number;
  toolCallIndex: number;
  blockIndexToToolCallIndex: Map<number, number>;
  finishReasonSent: boolean;
}

export function initState(model: string): TranslationState {
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

export function translateEvent(state: TranslationState, sse: ParsedSSE): string | null {
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
  /** OpenAI tool_call index → Anthropic block state. */
  const toolBlocks = new Map<number, { index: number; id: string; name: string; started: boolean; pendingArgs: string }>();
  /** Anthropic block indices of started tool_use blocks, in open order. */
  const openToolBlockIndices: number[] = [];
  let outputTokens = 0;
  /** Latest upstream usage — OpenAI only emits it in the final chunk, so we
   *  accumulate and emit it once, deferred to end-of-stream. */
  let latestUsage: OpenAIUsage | undefined;
  /** Stop reason captured from the finish_reason chunk; held until we can pair
   *  it with the complete usage before emitting message_delta. */
  let pendingStopReason: string | null = null;
  let contentClosed = false;
  let messageDeltaSent = false;
  let messageStopped = false;
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

      const closeToolBlocks = () => {
        for (const idx of openToolBlockIndices) {
          enqueueAnthropicEvent("content_block_stop", {
            type: "content_block_stop",
            index: idx,
          });
        }
        openToolBlockIndices.length = 0;
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

      /**
       * Route OpenAI streaming tool_call deltas into Anthropic tool_use blocks.
       * OpenAI identifies each parallel call by `index`; we lazily allocate an
       * Anthropic block per index, emit `content_block_start` once id+name
       * arrive, then stream `input_json_delta` for each arguments fragment.
       * Arguments that arrive before id/name (non-standard ordering from some
       * compatible upstreams) are buffered into `pendingArgs` and flushed on
       * start, so the tool input is never silently truncated.
       */
      const handleToolCalls = (toolCalls: OpenAIStreamToolCall[]) => {
        // Tool calls never share a block with text/thinking — close any open prose block first.
        closeActiveBlock();
        for (const tc of toolCalls) {
          const idx = tc.index ?? 0;
          let state = toolBlocks.get(idx);
          if (!state) {
            state = { index: blockIndex++, id: "", name: "", started: false, pendingArgs: "" };
            toolBlocks.set(idx, state);
          }
          if (tc.id) state.id = tc.id;
          if (tc.function?.name) state.name = tc.function.name;

          if (!state.started && state.id && state.name) {
            state.started = true;
            enqueueAnthropicEvent("content_block_start", {
              type: "content_block_start",
              index: state.index,
              content_block: { type: "tool_use", id: state.id, name: state.name, input: {} },
            });
            openToolBlockIndices.push(state.index);
            if (state.pendingArgs.length > 0) {
              enqueueAnthropicEvent("content_block_delta", {
                type: "content_block_delta",
                index: state.index,
                delta: { type: "input_json_delta", partial_json: state.pendingArgs },
              });
              state.pendingArgs = "";
            }
          }

          const argsDelta = tc.function?.arguments;
          if (argsDelta) {
            if (state.started) {
              enqueueAnthropicEvent("content_block_delta", {
                type: "content_block_delta",
                index: state.index,
                delta: { type: "input_json_delta", partial_json: argsDelta },
              });
            } else {
              // id/name not yet seen — buffer until the block can open.
              state.pendingArgs += argsDelta;
            }
          }
        }
      };

      /**
       * Force-open any tool blocks that accumulated arguments (or a partial
       * id/name) but never crossed the id+name threshold before the stream
       * ended. Uses fallback id/name so the data is surfaced rather than
       * silently dropped. Mirrors cc-switch's "late tool starts" flush.
       */
      const startPendingToolBlocks = () => {
        const lateStarts: Array<{ index: number; id: string; name: string; args: string }> = [];
        for (const [openaiIdx, state] of toolBlocks) {
          if (state.started) continue;
          if (!state.pendingArgs && !state.id && !state.name) continue;
          state.started = true;
          lateStarts.push({
            index: state.index,
            id: state.id || `tool_call_${openaiIdx}`,
            name: state.name || "unknown_tool",
            args: state.pendingArgs,
          });
          state.pendingArgs = "";
          openToolBlockIndices.push(state.index);
        }
        lateStarts.sort((a, b) => a.index - b.index);
        for (const ls of lateStarts) {
          enqueueAnthropicEvent("content_block_start", {
            type: "content_block_start",
            index: ls.index,
            content_block: { type: "tool_use", id: ls.id, name: ls.name, input: {} },
          });
          if (ls.args.length > 0) {
            enqueueAnthropicEvent("content_block_delta", {
              type: "content_block_delta",
              index: ls.index,
              delta: { type: "input_json_delta", partial_json: ls.args },
            });
          }
        }
      };

      /**
       * Close every open content block (text/thinking/tool_use). Idempotent via
       * the `contentClosed` flag so it is safe to call at both finish_reason
       * and end-of-stream. Split from `finalizeStream` so the finish_reason
       * chunk can close blocks *without* emitting message_delta — the usage
       * chunk arrives afterwards and must be folded in first.
       */
      const closeContent = () => {
        if (contentClosed) return;
        contentClosed = true;
        closeActiveBlock();
        startPendingToolBlocks();
        closeToolBlocks();
      };

      /**
       * Emit the terminal message_delta + message_stop. The message_delta
       * carries the full Anthropic usage (input + output + cache) derived from
       * the latest upstream usage snapshot. This is what lets Anthropic clients
       * see a non-zero input_tokens despite OpenAI only reporting usage in the
       * stream's final chunk — the delta is deferred until that chunk lands.
       */
      const finalizeStream = () => {
        closeContent();
        if (!messageDeltaSent) {
          messageDeltaSent = true;
          const usage = openaiUsageToAnthropic(latestUsage);
          if (!latestUsage) usage.output_tokens = outputTokens;
          enqueueAnthropicEvent("message_delta", {
            type: "message_delta",
            delta: {
              stop_reason: pendingStopReason ?? "end_turn",
              stop_sequence: null,
            },
            usage,
          });
        }
        if (!messageStopped) {
          messageStopped = true;
          enqueueAnthropicEvent("message_stop", { type: "message_stop" });
        }
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
              finalizeStream();
              continue;
            }

            try {
              const chunk = JSON.parse(dataStr) as OpenAIStreamChunk;
              const choice = chunk.choices?.[0];

              // Accumulate usage from every chunk that carries one. OpenAI's
              // include_usage stream emits it only on the final (often
              // choices-less) chunk, but compatible upstreams may spread it
              // across chunks — keep the freshest snapshot.
              if (chunk.usage) {
                latestUsage = chunk.usage;
                outputTokens = chunk.usage.completion_tokens ?? outputTokens;
              }

              if (!messageStarted) {
                messageStarted = true;
                // message_start must lead the stream, but the upstream usage
                // has not arrived yet at this point, so input_tokens starts at
                // 0 here and is delivered for real via the deferred
                // message_delta once usage lands. (Anthropic's own streaming
                // also reports input_tokens up-front; we cannot, given the
                // upstream timing.)
                const startUsage = openaiUsageToAnthropic(chunk.usage);
                enqueueAnthropicEvent("message_start", {
                  type: "message_start",
                  message: {
                    id: chunk.id ?? messageId,
                    type: "message",
                    role: "assistant",
                    content: [],
                    model: chunk.model || model,
                    stop_reason: null,
                    stop_sequence: null,
                    usage: startUsage,
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

              if (choice?.delta?.tool_calls?.length) {
                handleToolCalls(choice.delta.tool_calls);
              }

              if (choice?.finish_reason) {
                // Close blocks now, but hold message_delta until the stream
                // actually ends so the usage chunk (which follows finish_reason
                // in include_usage streams) is folded into the final usage.
                pendingStopReason = mapFinishReason(choice.finish_reason);
                closeContent();
              }
            } catch {
              // Skip malformed
            }
          }
        }

        // Stream ended — emit the deferred message_delta (with full usage) and
        // message_stop. Covers both explicit [DONE] already handled above and
        // streams that terminate without one.
        finalizeStream();
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
