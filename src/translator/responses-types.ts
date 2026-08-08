/**
 * Type definitions for the OpenAI Responses API (`/v1/responses`).
 *
 * The Responses API is OpenAI's stateful successor to Chat Completions, used by
 * Codex CLI and the OpenAI Agents SDK. The proxy translates it bidirectionally
 * against the GLM Chat Completions upstream so non-OpenAI clients (Codex) can
 * drive GLM models directly.
 *
 * Reference: https://platform.openai.com/docs/api-reference/responses
 *
 * Scope (P1.0): request body, batch response, and streaming SSE events covering
 * text / reasoning / function_call / web_search_call outputs. The streaming
 * event set mirrors what Codex CLI consumes (verified against the Vercel AI SDK
 * Responses provider in `_reverse/zcode.cjs` L1814 and sub2api's bridge).
 */

// ─────────────────────────────────────────────
// Request
// ─────────────────────────────────────────────

/** Reasoning configuration on a Responses request. */
export interface ResponsesReasoning {
  effort?: "minimal" | "low" | "medium" | "high";
  summary?: "auto" | "concise" | "detailed" | "none";
}

/** A single text content part inside a Responses input/output message. */
export interface ResponsesContentPart {
  type: "input_text" | "output_text" | "text" | "input_image" | "image_url" | "summary_text";
  text?: string;
  image_url?: string | { url: string; detail?: string };
}

/** Tool definitions on a Responses request. */
export type ResponsesTool =
  | { type: "function"; name: string; description?: string; parameters?: Record<string, unknown>; strict?: boolean }
  | { type: "custom"; name: string; description?: string; format?: { type: "text" | "json" }; on_redirect?: string }
  | { type: "namespace"; name: string; description?: string; tools?: ResponsesTool[]; children?: ResponsesTool[] }
  | { type: "tool_search" }
  | { type: "web_search" | "web_search_preview"; search_context_size?: "low" | "medium" | "high"; user_location?: unknown }
  | { type: "file_search"; vector_store_ids?: string[] }
  | { type: "code_interpreter"; container?: unknown }
  | { type: "computer_use_preview"; display_height?: number; display_width?: number }
  | { type: "image_generation"; background?: string; input_fidelity?: string; size?: string }
  | { type: "mcp"; server_label?: string; server_url?: string; allowed_tools?: string[] }
  | { type: string; name?: string; description?: string; [k: string]: unknown };

/** Input items — Responses conversations are a flat list of typed items. */
export type ResponsesInputItem =
  | { type: "message"; role: "user" | "assistant" | "developer" | "system"; content: ResponsesContentPart[] | string; [k: string]: unknown }
  | { type: "reasoning"; id?: string; content?: ResponsesContentPart[]; summary?: ResponsesContentPart[]; encrypted_content?: string; [k: string]: unknown }
  | { type: "function_call"; call_id: string; name: string; arguments: string; id?: string; [k: string]: unknown }
  | { type: "function_call_output"; call_id: string; output: string; id?: string; [k: string]: unknown }
  | { type: "custom_tool_call"; call_id: string; name: string; input: string; id?: string; [k: string]: unknown }
  | { type: "custom_tool_call_output"; call_id: string; output: string; id?: string; [k: string]: unknown }
  | { type: "tool_search_call"; call_id?: string; arguments?: Record<string, unknown> | string; id?: string; [k: string]: unknown }
  | { type: "tool_search_output"; call_id?: string; output?: unknown; id?: string; [k: string]: unknown }
  | { type: "additional_tools"; role?: string; tools?: ResponsesTool[]; [k: string]: unknown }
  | { type: "web_search_call"; id?: string; status?: string; action?: unknown; [k: string]: unknown }
  | { type: "file_search_call" | "code_interpreter_call" | "computer_call" | "image_generation_call"; id?: string; status?: string; [k: string]: unknown }
  | { type: string; [k: string]: unknown };

/** POST /v1/responses request body. */
export interface ResponsesRequest {
  model: string;
  input: ResponsesInputItem[] | string;
  instructions?: string;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  tools?: ResponsesTool[];
  tool_choice?: "auto" | "none" | "required" | { type: string; name?: string; function?: { name?: string } } | Record<string, unknown>;
  parallel_tool_calls?: boolean;
  reasoning?: ResponsesReasoning;
  previous_response_id?: string;
  store?: boolean;
  metadata?: Record<string, unknown>;
  user?: string;
  service_tier?: string;
  prompt_cache_key?: string;
  include?: string[];
  [k: string]: unknown;
}

// ─────────────────────────────────────────────
// Batch response
// ─────────────────────────────────────────────

export interface ResponsesUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

export interface ResponsesIncompleteDetails {
  reason?: string;
}

/** An output item in a completed Responses payload. */
export type ResponsesOutputItem =
  | { type: "message"; id?: string; role: "assistant"; content: ResponsesContentPart[]; status?: string; [k: string]: unknown }
  | { type: "reasoning"; id?: string; summary?: ResponsesContentPart[]; content?: ResponsesContentPart[]; status?: string; [k: string]: unknown }
  | { type: "function_call"; id?: string; call_id: string; name: string; arguments: string; status?: string; namespace?: string; [k: string]: unknown }
  | { type: "custom_tool_call"; id?: string; call_id: string; name: string; input: string; status?: string; [k: string]: unknown }
  | { type: "tool_search_call"; id?: string; call_id?: string; arguments?: Record<string, unknown> | string; execution?: "client" | "server"; status?: string; [k: string]: unknown }
  | { type: "web_search_call"; id?: string; call_id?: string; status?: string; action?: unknown; [k: string]: unknown }
  | { type: string; id?: string; status?: string; [k: string]: unknown };

export interface ResponsesResponse {
  id: string;
  object: "response";
  created_at?: number;
  model: string;
  status: "completed" | "incomplete" | "failed" | "in_progress" | "cancelled";
  output: ResponsesOutputItem[];
  usage?: ResponsesUsage;
  incomplete_details?: ResponsesIncompleteDetails;
  instructions?: string;
  previous_response_id?: string;
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

// ─────────────────────────────────────────────
// Streaming SSE events
// ─────────────────────────────────────────────

/** Discriminated union of all Responses SSE event shapes the proxy emits. */
export type ResponsesStreamEvent =
  | { type: "response.created"; response: ResponsesResponse; sequence_number?: number; [k: string]: unknown }
  | { type: "response.in_progress"; response: ResponsesResponse; sequence_number?: number; [k: string]: unknown }
  | { type: "response.output_item.added"; output_index: number; item: ResponsesOutputItem; sequence_number?: number; [k: string]: unknown }
  | { type: "response.output_item.done"; output_index: number; item: ResponsesOutputItem; sequence_number?: number; [k: string]: unknown }
  | { type: "response.content_part.added"; output_index: number; content_index: number; item_id?: string; part: ResponsesContentPart; sequence_number?: number; [k: string]: unknown }
  | { type: "response.content_part.done"; output_index: number; content_index: number; item_id?: string; part: ResponsesContentPart; sequence_number?: number; [k: string]: unknown }
  | { type: "response.output_text.delta"; output_index: number; content_index: number; delta: string; item_id?: string; sequence_number?: number; [k: string]: unknown }
  | { type: "response.output_text.done"; output_index: number; content_index: number; text: string; item_id?: string; sequence_number?: number; [k: string]: unknown }
  | { type: "response.reasoning_summary_part.added"; output_index: number; summary_index: number; item_id?: string; part: ResponsesContentPart; sequence_number?: number; [k: string]: unknown }
  | { type: "response.reasoning_summary_text.delta"; output_index: number; summary_index: number; delta: string; item_id?: string; sequence_number?: number; [k: string]: unknown }
  | { type: "response.reasoning_summary_text.done"; output_index: number; summary_index: number; text: string; item_id?: string; sequence_number?: number; [k: string]: unknown }
  | { type: "response.reasoning_summary_part.done"; output_index: number; summary_index: number; item_id?: string; part: ResponsesContentPart; sequence_number?: number; [k: string]: unknown }
  | { type: "response.function_call_arguments.delta"; output_index: number; delta: string; item_id?: string; call_id?: string; name?: string; sequence_number?: number; [k: string]: unknown }
  | { type: "response.function_call_arguments.done"; output_index: number; arguments: string; item_id?: string; call_id?: string; name?: string; sequence_number?: number; [k: string]: unknown }
  | { type: "response.custom_tool_call_input.delta"; output_index: number; delta: string; item_id?: string; call_id?: string; name?: string; sequence_number?: number; [k: string]: unknown }
  | { type: "response.custom_tool_call_input.done"; output_index: number; input: string; item_id?: string; call_id?: string; name?: string; sequence_number?: number; [k: string]: unknown }
  | { type: "response.completed"; response: ResponsesResponse; sequence_number?: number; [k: string]: unknown }
  | { type: "response.incomplete"; response: ResponsesResponse; sequence_number?: number; [k: string]: unknown }
  | { type: "response.failed"; response: ResponsesResponse; sequence_number?: number; error?: unknown; [k: string]: unknown }
  | { type: "error"; code?: string; message?: string; sequence_number?: number; [k: string]: unknown };

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/** Generate a Responses-style id: `resp_<22 url-safe chars>`. */
export function generateResponsesId(prefix = "resp_"): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}${hex}`;
}

/** Generate a per-output-item id: `item_<22 hex>`. Used by the response translator. */
export function generateItemId(): string {
  return generateResponsesId("item_");
}

/** Generate a call_id: `call_<22 hex>`. Used for tool calls. */
export function generateCallId(): string {
  return generateResponsesId("call_");
}

/** Type guard: a Responses tool is "hosted" (runs on the server side) — we strip these. */
export function isHostedTool(t: ResponsesTool): boolean {
  return t.type === "file_search"
    || t.type === "code_interpreter"
    || t.type === "computer_use_preview"
    || t.type === "image_generation"
    || t.type === "mcp";
}

/** Type guard: a web-search hosted tool — we route this to GLM MCP (intercepted). */
export function isWebSearchTool(t: ResponsesTool): boolean {
  return t.type === "web_search" || t.type === "web_search_preview";
}
