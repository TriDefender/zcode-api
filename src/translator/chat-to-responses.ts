/**
 * Chat Completions → Responses API translation.
 *
 * Two entry points:
 *   - `chatCompletionsToResponses()` — batch response translation.
 *   - `chatCompletionsSseToResponsesStream()` — streaming SSE translation,
 *     producing the full Responses event lifecycle Codex requires:
 *       `response.created`
 *         → `response.output_item.added` (reasoning)
 *           → `reasoning_summary_part.added` / `delta` / `done` / `part.done` / `output_item.done`
 *         → `response.output_item.added` (message)
 *           → `content_part.added` / `output_text.delta` / `output_text.done` / `content_part.done` / `output_item.done`
 *         → per tool_call: `output_item.added` → `function_call_arguments.delta`* → `.done` + `output_item.done`
 *       → `response.completed`
 *
 * Reasoning/tool-call lifecycle completeness is non-negotiable: without
 * `function_call_arguments.done` + `output_item.done` Codex never finalises the
 * call and the session wedges (verified against sub2api's
 * `closeChatToolItems`).
 *
 * Namespace/custom/tool_search tool calls are restored to their Responses
 * item type using the bookkeeping from `responsesToChatCompletions()`.
 */
import type {
  OpenAIChatResponse,
  OpenAIChoice,
  OpenAIMessage,
  OpenAIUsage,
  OpenAIStreamChunk,
  OpenAIStreamChoice,
} from "./types.js";
import type {
  ResponsesResponse,
  ResponsesOutputItem,
  ResponsesContentPart,
  ResponsesStreamEvent,
  ResponsesUsage,
} from "./responses-types.js";
import { generateResponsesId, generateItemId, generateCallId } from "./responses-types.js";
import type { ResponsesToChatResult } from "./responses-to-chat.js";

// ─────────────────────────────────────────────
// Batch translation
// ─────────────────────────────────────────────

export interface ChatToResponsesOptions {
  /** Bookkeeping from the request translation (custom/namespace/tool_search maps). */
  meta?: Pick<ResponsesToChatResult, "customToolNames" | "namespaceMap" | "hasToolSearch">;
  /** Optional override id (otherwise generated). */
  responseId?: string;
  /** Optional `instructions` echoed onto the response (OpenAI does this). */
  instructions?: string;
  /** Optional `previous_response_id` echoed onto the response. */
  previousResponseId?: string;
}

/** Translate a non-streaming Chat Completions response into a Responses response. */
export function chatCompletionsToResponses(
  resp: OpenAIChatResponse,
  model: string,
  opts: ChatToResponsesOptions = {},
): ResponsesResponse {
  const id = opts.responseId ?? generateResponsesId();
  const choice = resp.choices?.[0];

  const output: ResponsesOutputItem[] = [];
  if (choice) {
    const items = chatChoiceToOutputItems(choice, opts.meta);
    output.push(...items);
  }
  if (output.length === 0) {
    output.push(emptyMessageOutput());
  }

  const status: ResponsesResponse["status"] = choice?.finish_reason === "length" ? "incomplete" : "completed";
  const incomplete = status === "incomplete"
    ? { reason: "max_output_tokens" }
    : undefined;

  return {
    id,
    object: "response",
    created_at: Date.now(),
    model: model || resp.model || "",
    status,
    output,
    ...(incomplete ? { incomplete_details: incomplete } : {}),
    ...(resp.usage ? { usage: chatUsageToResponsesUsage(resp.usage) } : {}),
    ...(opts.instructions ? { instructions: opts.instructions } : {}),
    ...(opts.previousResponseId ? { previous_response_id: opts.previousResponseId } : {}),
  };
}

/** Convert a single Chat choice into one or more Responses output items. */
function chatChoiceToOutputItems(
  choice: OpenAIChoice,
  meta: ChatToResponsesOptions["meta"],
): ResponsesOutputItem[] {
  const items: ResponsesOutputItem[] = [];
  const msg = choice.message;

  if (msg?.reasoning_content) {
    items.push({
      type: "reasoning",
      id: generateItemId(),
      summary: [{ type: "summary_text", text: msg.reasoning_content }],
      status: "completed",
    });
  }

  const text = extractAssistantText(msg);
  const toolCalls = msg?.tool_calls ?? [];
  const customNames = meta?.customToolNames ?? new Set<string>();
  const nsMap = meta?.namespaceMap ?? new Map<string, { namespace: string; name: string }>();
  const hasToolSearch = meta?.hasToolSearch === true;

  // Message item: emit when there's text, or when there are no tool calls
  // (Codex expects at least one output item; an empty message is the safe default).
  if (text.length > 0 || toolCalls.length === 0) {
    items.push({
      type: "message",
      id: generateItemId(),
      role: "assistant",
      content: [{ type: "output_text", text }],
      status: "completed",
    });
  }

  for (const tc of toolCalls) {
    const flatName = tc.function.name;
    const args = tc.function.arguments && tc.function.arguments.trim().length > 0
      ? tc.function.arguments
      : "{}";

    // Restore custom tools (input extracted from {input:"..."}).
    if (customNames.has(flatName)) {
      const inputStr = extractCustomToolInput(args);
      items.push({
        type: "custom_tool_call",
        id: generateItemId(),
        call_id: tc.id || generateCallId(),
        name: flatName,
        input: inputStr,
        status: "completed",
      });
      continue;
    }

    // Restore tool_search (must be `tool_search_call` with execution:"client").
    if (flatName === "tool_search" && hasToolSearch) {
      let argsObj: Record<string, unknown> = {};
      try { argsObj = JSON.parse(args); } catch { argsObj = {}; }
      items.push({
        type: "tool_search_call",
        id: generateItemId(),
        call_id: tc.id || generateCallId(),
        arguments: argsObj,
        execution: "client",
        status: "completed",
      });
      continue;
    }

    // Restore namespace tools (flatten name → {namespace, name}).
    const ns = nsMap.get(flatName);
    if (ns) {
      items.push({
        type: "function_call",
        id: generateItemId(),
        call_id: tc.id || generateCallId(),
        name: ns.name,
        namespace: ns.namespace,
        arguments: args,
        status: "completed",
      });
      continue;
    }

    // Plain function_call.
    items.push({
      type: "function_call",
      id: generateItemId(),
      call_id: tc.id || generateCallId(),
      name: flatName,
      arguments: args,
      status: "completed",
    });
  }

  return items;
}

function emptyMessageOutput(): ResponsesOutputItem {
  return {
    type: "message",
    id: generateItemId(),
    role: "assistant",
    content: [{ type: "output_text", text: "" }],
    status: "completed",
  };
}

function extractAssistantText(msg: OpenAIMessage | undefined): string {
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("\n");
  }
  return "";
}

/**
 * Extract the `input` string from a custom-tool-call's arguments.
 * The translator wrapped the input as `{input:"..."}` on the way out; on the
 * way back we try to parse it. If the model produced malformed JSON, fall back
 * to the raw argument text (sub2api rule).
 */
export function extractCustomToolInput(rawArgs: string): string {
  try {
    const obj = JSON.parse(rawArgs) as { input?: unknown };
    if (typeof obj.input === "string") return obj.input;
  } catch {
    // fallthrough — raw text (some models emit the bare string).
  }
  return rawArgs;
}

function chatUsageToResponsesUsage(u: OpenAIUsage): ResponsesUsage {
  return {
    input_tokens: u.prompt_tokens ?? 0,
    output_tokens: u.completion_tokens ?? 0,
    total_tokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
    ...(u.prompt_tokens_details?.cached_tokens ? { input_tokens_details: { cached_tokens: u.prompt_tokens_details.cached_tokens } } : {}),
    ...(u.output_tokens_details?.reasoning_tokens ? { output_tokens_details: { reasoning_tokens: u.output_tokens_details.reasoning_tokens } } : {}),
  };
}

// ─────────────────────────────────────────────
// Streaming translation
// ─────────────────────────────────────────────

/**
 * Stateful converter: feed it Chat SSE chunks, get Responses SSE events.
 * Lifecycle mirrors sub2api's `ChatCompletionsToResponsesStreamState`:
 *   - reasoning item opened lazily on first `reasoning_content` delta, closed
 *     before the message item or any tool call opens.
 *   - message item + `output_text` content part opened lazily on first content delta.
 *   - tool calls tracked by upstream index; each emits output_item.added →
 *     function_call_arguments.delta(s) → arguments.done + output_item.done.
 *   - On `finish_reason`, emit the terminal events for every open item, then
 *     `response.completed` carrying the full reconstructed `output[]`.
 */
export interface ResponsesStreamState {
  responseId: string;
  model: string;
  createdAt: number;
  sequenceNumber: number;
  createdSent: boolean;
  completedSent: boolean;

  // Output-index allocator (matches final `output[]` ordering).
  nextOutputIndex: number;

  // Reasoning item lifecycle.
  reasoningItemId: string | undefined;
  reasoningIndex: number;
  reasoningOpen: boolean;
  reasoningDone: boolean;
  reasoningText: string;

  // Message item + output_text content-part lifecycle.
  messageItemId: string | undefined;
  messageIndex: number;
  textPartOpen: boolean;
  text: string;

  // Tool-call lifecycle, keyed by the upstream tool_call index.
  toolCalls: Map<number, { id: string; name: string; args: string; itemId: string; outputIndex: number }>;

  finishReason: string | undefined;
  usage: ResponsesUsage | undefined;
  meta: ChatToResponsesOptions["meta"];
}

export function newResponsesStreamState(
  model: string,
  opts: {
    meta?: ChatToResponsesOptions["meta"];
    responseId?: string;
  } = {},
): ResponsesStreamState {
  return {
    responseId: opts.responseId ?? generateResponsesId(),
    model,
    createdAt: Date.now(),
    sequenceNumber: 0,
    createdSent: false,
    completedSent: false,
    nextOutputIndex: 0,
    reasoningItemId: undefined,
    reasoningIndex: -1,
    reasoningOpen: false,
    reasoningDone: false,
    reasoningText: "",
    messageItemId: undefined,
    messageIndex: -1,
    textPartOpen: false,
    text: "",
    toolCalls: new Map(),
    finishReason: undefined,
    usage: undefined,
    meta: opts.meta,
  };
}

/**
 * Convert one Chat SSE chunk into zero or more Responses SSE events.
 * Stateless aside from the `state` argument — caller drives the loop.
 */
export function chatChunkToResponsesEvents(
  chunk: OpenAIStreamChunk,
  state: ResponsesStreamState,
): ResponsesStreamEvent[] {
  const events: ResponsesStreamEvent[] = [];
  events.push(...ensureCreated(state));

  if (chunk.model && !state.model) state.model = chunk.model;
  if (chunk.usage) state.usage = chatUsageToResponsesUsage(chunk.usage);

  for (const choice of chunk.choices ?? []) {
    events.push(...handleChoice(choice, state));
  }

  return events;
}

function handleChoice(choice: OpenAIStreamChoice, state: ResponsesStreamState): ResponsesStreamEvent[] {
  const events: ResponsesStreamEvent[] = [];
  const delta = choice.delta ?? {};

  // ── reasoning ──
  if (delta.reasoning_content && delta.reasoning_content.length > 0) {
    events.push(...ensureReasoningItem(state));
    state.reasoningText += delta.reasoning_content;
    events.push(seq(state, {
      type: "response.reasoning_summary_text.delta",
      output_index: state.reasoningIndex,
      summary_index: 0,
      delta: delta.reasoning_content,
      item_id: state.reasoningItemId,
    }));
  }

  // ── content ──
  if (typeof delta.content === "string" && delta.content.length > 0) {
    events.push(...closeReasoningItem(state));
    events.push(...ensureMessageItem(state));
    events.push(...ensureTextPart(state));
    state.text += delta.content;
    events.push(seq(state, {
      type: "response.output_text.delta",
      output_index: state.messageIndex,
      content_index: 0,
      delta: delta.content,
      item_id: state.messageItemId,
    }));
  }

  // ── tool calls ──
  for (const tc of delta.tool_calls ?? []) {
    const idx = tc.index ?? 0;
    let entry = state.toolCalls.get(idx);
    if (!entry) {
      // First chunk for this tool call: close reasoning, open the item.
      events.push(...closeReasoningItem(state));
      const itemId = generateItemId();
      const outputIndex = allocIndex(state);
      const callId = tc.id || generateCallId();
      const name = tc.function?.name ?? "";
      entry = { id: callId, name, args: "", itemId, outputIndex };
      state.toolCalls.set(idx, entry);
      // GLM sometimes packs id+name+arguments into the first chunk; reset args
      // here so the append below doesn't double them (sub2api bug fix).
      const initialArgs = tc.function?.arguments ?? "";
      entry.args += initialArgs;
      events.push(seq(state, {
        type: "response.output_item.added",
        output_index: outputIndex,
        item: toolCallAddedItem(entry, state.meta),
      }));
      if (initialArgs.length > 0) {
        events.push(seq(state, toolArgsDeltaEvent(entry, initialArgs, state)));
      }
    } else {
      // Continuation chunk.
      if (tc.id) entry.id = tc.id;
      if (tc.function?.name) entry.name = tc.function.name;
      const argDelta = tc.function?.arguments ?? "";
      if (argDelta.length > 0) {
        entry.args += argDelta;
        events.push(seq(state, toolArgsDeltaEvent(entry, argDelta, state)));
      }
    }
  }

  if (choice.finish_reason) {
    state.finishReason = choice.finish_reason;
  }

  return events;
}

/** Build the `output_item.added` item shape for a tool call, restoring custom/tool_search/namespace types. */
function toolCallAddedItem(
  entry: { id: string; name: string; args: string; itemId: string },
  meta: ChatToResponsesOptions["meta"],
): ResponsesOutputItem {
  const customNames = meta?.customToolNames ?? new Set<string>();
  const nsMap = meta?.namespaceMap ?? new Map<string, { namespace: string; name: string }>();
  const hasToolSearch = meta?.hasToolSearch === true;

  if (customNames.has(entry.name)) {
    return {
      type: "custom_tool_call",
      id: entry.itemId,
      call_id: entry.id,
      name: entry.name,
      input: "", // final value emitted at output_item.done
      status: "in_progress",
    };
  }
  if (entry.name === "tool_search" && hasToolSearch) {
    return {
      type: "tool_search_call",
      id: entry.itemId,
      call_id: entry.id,
      execution: "client",
      status: "in_progress",
    };
  }
  const ns = nsMap.get(entry.name);
  if (ns) {
    return {
      type: "function_call",
      id: entry.itemId,
      call_id: entry.id,
      name: ns.name,
      namespace: ns.namespace,
      status: "in_progress",
    };
  }
  return {
    type: "function_call",
    id: entry.itemId,
    call_id: entry.id,
    name: entry.name,
    status: "in_progress",
  };
}

/** Choose the right "args delta" event for the tool type (function vs custom). */
function toolArgsDeltaEvent(
  entry: { id: string; name: string; args: string; itemId: string; outputIndex: number },
  delta: string,
  state: ResponsesStreamState,
): ResponsesStreamEvent {
  const customNames = state.meta?.customToolNames ?? new Set<string>();
  const isCustom = customNames.has(entry.name);
  const base = {
    output_index: entry.outputIndex,
    delta,
    item_id: entry.itemId,
    call_id: entry.id,
    name: entry.name,
  };
  return seq(state, isCustom
    ? { type: "response.custom_tool_call_input.delta", ...base }
    : { type: "response.function_call_arguments.delta", ...base });
}

/**
 * Emit terminal events for all open items, then `response.completed`.
 * Idempotent via `state.completedSent`.
 */
export function finalizeResponsesStream(state: ResponsesStreamState): ResponsesStreamEvent[] {
  if (state.completedSent) return [];
  const events: ResponsesStreamEvent[] = [];
  events.push(...ensureCreated(state));
  events.push(...closeReasoningItem(state));
  events.push(...synthesizeReasoningFallbackMessage(state));
  events.push(...closeMessageItem(state));
  events.push(...closeToolItems(state));

  const status: ResponsesResponse["status"] = state.finishReason === "length" ? "incomplete" : "completed";
  const incomplete = status === "incomplete" ? { reason: "max_output_tokens" } : undefined;

  state.completedSent = true;
  events.push(seq(state, {
    type: status === "incomplete" ? "response.incomplete" : "response.completed",
    response: {
      id: state.responseId,
      object: "response",
      created_at: state.createdAt,
      model: state.model,
      status,
      output: buildFinalOutput(state),
      ...(incomplete ? { incomplete_details: incomplete } : {}),
      ...(state.usage ? { usage: state.usage } : {}),
    },
  }));
  return events;
}

function ensureCreated(state: ResponsesStreamState): ResponsesStreamEvent[] {
  if (state.createdSent) return [];
  state.createdSent = true;
  return [seq(state, {
    type: "response.created",
    response: {
      id: state.responseId,
      object: "response",
      created_at: state.createdAt,
      model: state.model,
      status: "in_progress",
      output: [],
    },
  })];
}

function ensureReasoningItem(state: ResponsesStreamState): ResponsesStreamEvent[] {
  if (state.reasoningOpen || state.reasoningDone) return [];
  state.reasoningOpen = true;
  state.reasoningItemId = generateItemId();
  state.reasoningIndex = allocIndex(state);
  return [
    seq(state, {
      type: "response.output_item.added",
      output_index: state.reasoningIndex,
      item: { type: "reasoning", id: state.reasoningItemId, status: "in_progress" },
    }),
    seq(state, {
      type: "response.reasoning_summary_part.added",
      output_index: state.reasoningIndex,
      summary_index: 0,
      item_id: state.reasoningItemId,
      part: { type: "summary_text" },
    }),
  ];
}

function closeReasoningItem(state: ResponsesStreamState): ResponsesStreamEvent[] {
  if (!state.reasoningOpen) return [];
  state.reasoningOpen = false;
  state.reasoningDone = true;
  const text = state.reasoningText;
  return [
    seq(state, {
      type: "response.reasoning_summary_text.done",
      output_index: state.reasoningIndex,
      summary_index: 0,
      text,
      item_id: state.reasoningItemId,
    }),
    seq(state, {
      type: "response.reasoning_summary_part.done",
      output_index: state.reasoningIndex,
      summary_index: 0,
      item_id: state.reasoningItemId,
      part: { type: "summary_text", text },
    }),
    seq(state, {
      type: "response.output_item.done",
      output_index: state.reasoningIndex,
      item: {
        type: "reasoning",
        id: state.reasoningItemId,
        status: "completed",
        summary: [{ type: "summary_text", text }],
      },
    }),
  ];
}

/**
 * Some upstreams (DeepSeek-style) stream reasoning but no content and no tool
 * calls. Codex renders nothing in that case unless we synthesise a message
 * item from the reasoning text. Mirror sub2api's behaviour.
 */
function synthesizeReasoningFallbackMessage(state: ResponsesStreamState): ResponsesStreamEvent[] {
  if (state.messageItemId || state.text.length > 0 || state.reasoningText.length === 0 || state.toolCalls.size > 0) {
    return [];
  }
  const text = state.reasoningText;
  if (text.trim().length === 0) return [];
  const events: ResponsesStreamEvent[] = [];
  events.push(...ensureMessageItem(state));
  events.push(...ensureTextPart(state));
  state.text = text;
  events.push(seq(state, {
    type: "response.output_text.delta",
    output_index: state.messageIndex,
    content_index: 0,
    delta: text,
    item_id: state.messageItemId,
  }));
  return events;
}

function ensureMessageItem(state: ResponsesStreamState): ResponsesStreamEvent[] {
  if (state.messageItemId) return [];
  state.messageItemId = generateItemId();
  state.messageIndex = allocIndex(state);
  return [seq(state, {
    type: "response.output_item.added",
    output_index: state.messageIndex,
    item: {
      type: "message",
      id: state.messageItemId,
      role: "assistant",
      status: "in_progress",
      content: [{ type: "output_text" }],
    },
  })];
}

function ensureTextPart(state: ResponsesStreamState): ResponsesStreamEvent[] {
  if (state.textPartOpen) return [];
  state.textPartOpen = true;
  return [seq(state, {
    type: "response.content_part.added",
    output_index: state.messageIndex,
    content_index: 0,
    item_id: state.messageItemId,
    part: { type: "output_text", text: "" },
  })];
}

function closeMessageItem(state: ResponsesStreamState): ResponsesStreamEvent[] {
  if (!state.messageItemId) return [];
  const events: ResponsesStreamEvent[] = [];
  if (state.textPartOpen) {
    events.push(seq(state, {
      type: "response.output_text.done",
      output_index: state.messageIndex,
      content_index: 0,
      text: state.text,
      item_id: state.messageItemId,
    }));
    events.push(seq(state, {
      type: "response.content_part.done",
      output_index: state.messageIndex,
      content_index: 0,
      item_id: state.messageItemId,
      part: { type: "output_text", text: state.text },
    }));
  }
  events.push(seq(state, {
    type: "response.output_item.done",
    output_index: state.messageIndex,
    item: {
      type: "message",
      id: state.messageItemId,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: state.text }],
    },
  }));
  return events;
}

function closeToolItems(state: ResponsesStreamState): ResponsesStreamEvent[] {
  const events: ResponsesStreamEvent[] = [];
  // Emit in index order (some upstreams deliver out-of-order).
  const sortedKeys = [...state.toolCalls.keys()].sort((a, b) => a - b);
  for (const idx of sortedKeys) {
    const entry = state.toolCalls.get(idx)!;
    const customNames = state.meta?.customToolNames ?? new Set<string>();
    const nsMap = state.meta?.namespaceMap ?? new Map<string, { namespace: string; name: string }>();
    const hasToolSearch = state.meta?.hasToolSearch === true;
    const isCustom = customNames.has(entry.name);
    const isToolSearch = entry.name === "tool_search" && hasToolSearch;
    const ns = nsMap.get(entry.name);
    const finalArgs = entry.args.trim().length === 0 ? "{}" : entry.args;

    // args.done event (function vs custom differ in event name + payload key).
    if (isCustom) {
      const inputStr = extractCustomToolInput(finalArgs);
      events.push(seq(state, {
        type: "response.custom_tool_call_input.done",
        output_index: entry.outputIndex,
        input: inputStr,
        item_id: entry.itemId,
        call_id: entry.id,
        name: entry.name,
      }));
      events.push(seq(state, {
        type: "response.output_item.done",
        output_index: entry.outputIndex,
        item: {
          type: "custom_tool_call",
          id: entry.itemId,
          call_id: entry.id,
          name: entry.name,
          input: inputStr,
          status: "completed",
        },
      }));
    } else if (isToolSearch) {
      let argsObj: Record<string, unknown> = {};
      try { argsObj = JSON.parse(finalArgs); } catch { argsObj = {}; }
      events.push(seq(state, {
        type: "response.function_call_arguments.done",
        output_index: entry.outputIndex,
        arguments: finalArgs,
        item_id: entry.itemId,
        call_id: entry.id,
        name: entry.name,
      }));
      events.push(seq(state, {
        type: "response.output_item.done",
        output_index: entry.outputIndex,
        item: {
          type: "tool_search_call",
          id: entry.itemId,
          call_id: entry.id,
          arguments: argsObj,
          execution: "client",
          status: "completed",
        },
      }));
    } else {
      events.push(seq(state, {
        type: "response.function_call_arguments.done",
        output_index: entry.outputIndex,
        arguments: finalArgs,
        item_id: entry.itemId,
        call_id: entry.id,
        name: entry.name,
      }));
      events.push(seq(state, {
        type: "response.output_item.done",
        output_index: entry.outputIndex,
        item: ns
          ? {
            type: "function_call",
            id: entry.itemId,
            call_id: entry.id,
            name: ns.name,
            namespace: ns.namespace,
            arguments: finalArgs,
            status: "completed",
          }
          : {
            type: "function_call",
            id: entry.itemId,
            call_id: entry.id,
            name: entry.name,
            arguments: finalArgs,
            status: "completed",
          },
      }));
    }
  }
  return events;
}

/** Reconstruct the final `output[]` array for `response.completed`. Order: reasoning → message → tool_calls. */
function buildFinalOutput(state: ResponsesStreamState): ResponsesOutputItem[] {
  const out: ResponsesOutputItem[] = [];
  if (state.reasoningDone && state.reasoningText.length > 0) {
    out.push({
      type: "reasoning",
      id: state.reasoningItemId!,
      summary: [{ type: "summary_text", text: state.reasoningText }],
      status: "completed",
    });
  }
  if (state.messageItemId || state.toolCalls.size === 0) {
    out.push({
      type: "message",
      id: state.messageItemId ?? generateItemId(),
      role: "assistant",
      content: [{ type: "output_text", text: state.text }],
      status: "completed",
    });
  }
  const sortedKeys = [...state.toolCalls.keys()].sort((a, b) => a - b);
  for (const idx of sortedKeys) {
    const entry = state.toolCalls.get(idx)!;
    const customNames = state.meta?.customToolNames ?? new Set<string>();
    const nsMap = state.meta?.namespaceMap ?? new Map<string, { namespace: string; name: string }>();
    const hasToolSearch = state.meta?.hasToolSearch === true;
    const isCustom = customNames.has(entry.name);
    const isToolSearch = entry.name === "tool_search" && hasToolSearch;
    const ns = nsMap.get(entry.name);
    const finalArgs = entry.args.trim().length === 0 ? "{}" : entry.args;

    if (isCustom) {
      out.push({
        type: "custom_tool_call",
        id: entry.itemId,
        call_id: entry.id,
        name: entry.name,
        input: extractCustomToolInput(finalArgs),
        status: "completed",
      });
    } else if (isToolSearch) {
      let argsObj: Record<string, unknown> = {};
      try { argsObj = JSON.parse(finalArgs); } catch { argsObj = {}; }
      out.push({
        type: "tool_search_call",
        id: entry.itemId,
        call_id: entry.id,
        arguments: argsObj,
        execution: "client",
        status: "completed",
      });
    } else if (ns) {
      out.push({
        type: "function_call",
        id: entry.itemId,
        call_id: entry.id,
        name: ns.name,
        namespace: ns.namespace,
        arguments: finalArgs,
        status: "completed",
      });
    } else {
      out.push({
        type: "function_call",
        id: entry.itemId,
        call_id: entry.id,
        name: entry.name,
        arguments: finalArgs,
        status: "completed",
      });
    }
  }
  return out;
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function allocIndex(state: ResponsesStreamState): number {
  return state.nextOutputIndex++;
}

/** Attach the next `sequence_number` and freeze the event `type`/payload. */
function seq(state: ResponsesStreamState, evt: Omit<ResponsesStreamEvent, "sequence_number">): ResponsesStreamEvent {
  const n = state.sequenceNumber++;
  return { ...(evt as ResponsesStreamEvent), sequence_number: n };
}

/** Format a Responses SSE event as an SSE wire line. */
export function responsesEventToSse(evt: ResponsesStreamEvent): string {
  return `event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`;
}
