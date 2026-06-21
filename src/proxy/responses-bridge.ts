/**
 * Anthropic SSE → OpenAI Responses API SSE (Codex wire_api=responses).
 */
import { randomUUID } from "node:crypto";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function formatEvent(event: string, data: unknown): string {
  const payload =
    typeof data === "object" && data !== null && !Array.isArray(data)
      ? { type: event, ...(data as Record<string, unknown>) }
      : { type: event, data };
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function responsesLifecycleEvents(responseId: string, model: string): string {
  return (
    formatEvent("response.created", { response: { id: responseId, model } }) +
    formatEvent("response.in_progress", { response: { id: responseId } })
  );
}

export interface ResponsesSseOptions {
  /** Pre-assigned response id when lifecycle events were already sent. */
  responseId?: string;
  /** Skip response.created / response.in_progress (already sent to client). */
  skipLifecycle?: boolean;
}

function parseSseChunk(raw: string): Array<{ event: string; data: unknown }> {
  const results: Array<{ event: string; data: unknown }> = [];
  for (const block of raw.split("\n\n")) {
    const lines = block.trim().split("\n").filter(Boolean);
    if (lines.length === 0) continue;
    let eventType = "";
    let dataStr = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) eventType = line.slice(7).trim();
      else if (line.startsWith("data: ")) dataStr = line.slice(6);
    }
    if (!dataStr) continue;
    try {
      results.push({ event: eventType, data: JSON.parse(dataStr) });
    } catch {
      // skip malformed
    }
  }
  return results;
}

interface TextBlockState {
  outputIndex: number;
  contentIndex: number;
  itemId: string;
  textBuffer: string;
  itemAdded: boolean;
  partAdded: boolean;
  itemDone: boolean;
}

interface ToolBlockState {
  id: string;
  name: string;
  argBuffer: string;
  outputIndex: number;
  itemId: string;
  itemDone: boolean;
}

/** Transform Anthropic message SSE into Responses API SSE for Codex. */
export function anthropicSseToResponsesSse(
  upstream: ReadableStream<Uint8Array>,
  model: string,
  options: ResponsesSseOptions = {},
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const responseId = options.responseId ?? `resp_${randomUUID().slice(0, 12)}`;
  const skipLifecycle = options.skipLifecycle === true;
  let sentCreated = skipLifecycle;
  let sentInProgress = skipLifecycle;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let messageOutputIndex = 0;
  let nextOutputIndex = 0;
  let reasoningTokens = 0;
  const textBlocks = new Map<number, TextBlockState>();
  const toolBlocks = new Map<number, ToolBlockState>();

  const emit = (controller: ReadableStreamDefaultController<Uint8Array>, event: string, data: unknown) => {
    controller.enqueue(encoder.encode(formatEvent(event, data)));
  };

  const ensureLifecycle = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (!sentCreated) {
      emit(controller, "response.created", { response: { id: responseId, model } });
      sentCreated = true;
    }
    if (!sentInProgress) {
      emit(controller, "response.in_progress", { response: { id: responseId } });
      sentInProgress = true;
    }
  };

  const getTextBlock = (index: number): TextBlockState => {
    let block = textBlocks.get(index);
    if (!block) {
      if (textBlocks.size === 0) {
        messageOutputIndex = nextOutputIndex;
        nextOutputIndex += 1;
      }
      block = {
        outputIndex: messageOutputIndex,
        contentIndex: 0,
        itemId: `msg_${randomUUID().slice(0, 12)}`,
        textBuffer: "",
        itemAdded: false,
        partAdded: false,
        itemDone: false,
      };
      textBlocks.set(index, block);
    }
    return block;
  };

  const ensureTextItem = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    block: TextBlockState,
  ) => {
    if (!block.itemAdded) {
      emit(controller, "response.output_item.added", {
        output_index: block.outputIndex,
        item: {
          id: block.itemId,
          type: "message",
          role: "assistant",
          status: "in_progress",
          content: [],
        },
      });
      block.itemAdded = true;
    }
    if (!block.partAdded) {
      emit(controller, "response.content_part.added", {
        output_index: block.outputIndex,
        content_index: block.contentIndex,
        item_id: block.itemId,
        part: { type: "output_text", annotations: [], logprobs: [], text: "" },
      });
      block.partAdded = true;
    }
  };

  const finishToolBlock = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    tool: ToolBlockState,
  ) => {
    if (tool.itemDone) return;
    emit(controller, "response.function_call_arguments.done", {
      call_id: tool.id,
      name: tool.name,
      arguments: tool.argBuffer,
      output_index: tool.outputIndex,
    });
    emit(controller, "response.output_item.done", {
      output_index: tool.outputIndex,
      item: {
        type: "function_call",
        id: tool.itemId,
        call_id: tool.id,
        name: tool.name,
        arguments: tool.argBuffer,
      },
    });
    tool.itemDone = true;
  };

  const finishTextBlock = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    textBlock: TextBlockState,
  ) => {
    if (!textBlock.itemAdded || textBlock.itemDone) return;
    emit(controller, "response.output_item.done", {
      output_index: textBlock.outputIndex,
      item: {
        id: textBlock.itemId,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{
          type: "output_text",
          text: textBlock.textBuffer,
          annotations: [],
        }],
      },
    });
    textBlock.itemDone = true;
  };

  const buildResponseOutput = (): Record<string, unknown>[] => {
    const items: Array<{ outputIndex: number; item: Record<string, unknown> }> = [];
    for (const textBlock of textBlocks.values()) {
      if (!textBlock.itemAdded) continue;
      items.push({
        outputIndex: textBlock.outputIndex,
        item: {
          id: textBlock.itemId,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{
            type: "output_text",
            text: textBlock.textBuffer,
            annotations: [],
          }],
        },
      });
    }
    for (const tool of toolBlocks.values()) {
      items.push({
        outputIndex: tool.outputIndex,
        item: {
          type: "function_call",
          id: tool.itemId,
          call_id: tool.id,
          name: tool.name,
          arguments: tool.argBuffer,
        },
      });
    }
    return items
      .sort((a, b) => a.outputIndex - b.outputIndex)
      .map((entry) => entry.item);
  };

  return new ReadableStream({
    async start(controller) {
      const reader = upstream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let boundary = buffer.indexOf("\n\n");
          while (boundary !== -1) {
            const chunk = buffer.slice(0, boundary + 2);
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf("\n\n");

            for (const { event, data } of parseSseChunk(chunk)) {
              if (!isRecord(data)) continue;

              switch (event) {
                case "message_start": {
                  const msg = isRecord(data.message) ? data.message : null;
                  if (msg && typeof msg.id === "string") {
                    void msg.id;
                  }
                  const usage = msg && isRecord(msg.usage) ? msg.usage : null;
                  if (usage && typeof usage.input_tokens === "number") {
                    inputTokens = usage.input_tokens;
                  }
                  if (usage && typeof usage.cache_read_input_tokens === "number") {
                    cachedTokens = usage.cache_read_input_tokens;
                  }
                  ensureLifecycle(controller);
                  break;
                }
                case "content_block_start": {
                  const block = isRecord(data.content_block) ? data.content_block : null;
                  const index = typeof data.index === "number" ? data.index : 0;
                  ensureLifecycle(controller);

                  if (block?.type === "tool_use") {
                    const toolId = typeof block.id === "string" ? block.id : `call_${randomUUID().slice(0, 8)}`;
                    const toolName = typeof block.name === "string" ? block.name : "";
                    const outputIndex = nextOutputIndex;
                    const itemId = `item_${outputIndex}`;
                    nextOutputIndex += 1;
                    toolBlocks.set(index, {
                      id: toolId,
                      name: toolName,
                      argBuffer: "",
                      outputIndex,
                      itemId,
                      itemDone: false,
                    });
                    emit(controller, "response.output_item.added", {
                      output_index: outputIndex,
                      item: {
                        type: "function_call",
                        id: itemId,
                        call_id: toolId,
                        name: toolName,
                      },
                    });
                  } else if (block?.type === "text") {
                    ensureTextItem(controller, getTextBlock(index));
                  }
                  break;
                }
                case "content_block_delta": {
                  const delta = isRecord(data.delta) ? data.delta : null;
                  const index = typeof data.index === "number" ? data.index : 0;
                  if (!delta) break;
                  ensureLifecycle(controller);

                  if (delta.type === "text_delta" && typeof delta.text === "string") {
                    const textBlock = getTextBlock(index);
                    ensureTextItem(controller, textBlock);
                    textBlock.textBuffer += delta.text;
                    emit(controller, "response.output_text.delta", {
                      item_id: textBlock.itemId,
                      output_index: textBlock.outputIndex,
                      content_index: textBlock.contentIndex,
                      delta: delta.text,
                    });
                  } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
                    reasoningTokens += 1;
                    emit(controller, "response.reasoning_summary_text.delta", { delta: delta.thinking });
                  } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
                    const tool = toolBlocks.get(index);
                    if (tool) {
                      tool.argBuffer += delta.partial_json;
                      emit(controller, "response.function_call_arguments.delta", {
                        call_id: tool.id,
                        delta: delta.partial_json,
                        output_index: tool.outputIndex,
                      });
                    }
                  }
                  break;
                }
                case "content_block_stop": {
                  const index = typeof data.index === "number" ? data.index : -1;
                  const tool = toolBlocks.get(index);
                  if (tool) {
                    finishToolBlock(controller, tool);
                    break;
                  }

                  const textBlock = textBlocks.get(index);
                  if (textBlock && textBlock.partAdded) {
                    emit(controller, "response.output_text.done", {
                      item_id: textBlock.itemId,
                      output_index: textBlock.outputIndex,
                      content_index: textBlock.contentIndex,
                      text: textBlock.textBuffer,
                    });
                    emit(controller, "response.content_part.done", {
                      output_index: textBlock.outputIndex,
                      content_index: textBlock.contentIndex,
                      item_id: textBlock.itemId,
                      part: {
                        type: "output_text",
                        annotations: [],
                        logprobs: [],
                        text: textBlock.textBuffer,
                      },
                    });
                  }
                  break;
                }
                case "message_delta": {
                  const usage = isRecord(data.usage) ? data.usage : null;
                  if (usage && typeof usage.output_tokens === "number") {
                    outputTokens = usage.output_tokens;
                  }
                  if (usage && typeof usage.cache_read_input_tokens === "number") {
                    cachedTokens = Math.max(cachedTokens, usage.cache_read_input_tokens);
                  }
                  break;
                }
                case "message_stop": {
                  for (const tool of toolBlocks.values()) {
                    finishToolBlock(controller, tool);
                  }
                  for (const textBlock of textBlocks.values()) {
                    finishTextBlock(controller, textBlock);
                  }

                  const output = buildResponseOutput();
                  emit(controller, "response.completed", {
                    response: {
                      id: responseId,
                      model,
                      status: "completed",
                      output,
                      usage: {
                        input_tokens: inputTokens,
                        output_tokens: outputTokens,
                        total_tokens: inputTokens + outputTokens,
                        reasoning_tokens: reasoningTokens,
                        input_tokens_details: { cached_tokens: cachedTokens },
                        output_tokens_details: { reasoning_tokens: reasoningTokens },
                      },
                    },
                  });
                  break;
                }
                case "error": {
                  const err = isRecord(data.error) ? data.error : data;
                  emit(controller, "error", {
                    error: {
                      type: typeof err.type === "string" ? err.type : "api_error",
                      message: typeof err.message === "string" ? err.message : "Upstream error",
                    },
                  });
                  break;
                }
                default:
                  break;
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
        controller.close();
      }
    },
  });
}

/** Convert a non-streaming Anthropic message to Responses API JSON. */
export function anthropicMessageToResponses(
  resp: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  const id = typeof resp.id === "string" ? resp.id : `resp_${randomUUID().slice(0, 12)}`;
  const content = Array.isArray(resp.content) ? resp.content : [];
  const output: Record<string, unknown>[] = [];
  let outputIndex = 0;

  const textParts = content
    .filter((b) => isRecord(b) && b.type === "text")
    .map((b) => (isRecord(b) ? String(b.text ?? "") : ""))
    .join("");
  if (textParts) {
    output.push({
      type: "message",
      id: `msg_${id}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: textParts, annotations: [] }],
    });
    outputIndex += 1;
  }

  for (const block of content) {
    if (!isRecord(block) || block.type !== "tool_use") continue;
    const name = typeof block.name === "string" ? block.name : "tool";
    const callId = typeof block.id === "string" ? block.id : `call_${name}`;
    const args = block.input != null ? JSON.stringify(block.input) : "{}";
    output.push({
      type: "function_call",
      id: `item_${outputIndex}`,
      call_id: callId,
      name,
      arguments: args,
    });
    outputIndex += 1;
  }

  if (output.length === 0) {
    output.push({
      type: "message",
      id: `msg_${id}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "", annotations: [] }],
    });
  }

  const usage = isRecord(resp.usage) ? resp.usage : {};
  return {
    id,
    object: "response",
    model,
    status: "completed",
    output,
    usage: {
      input_tokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
      output_tokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
      total_tokens:
        (typeof usage.input_tokens === "number" ? usage.input_tokens : 0) +
        (typeof usage.output_tokens === "number" ? usage.output_tokens : 0),
    },
  };
}
