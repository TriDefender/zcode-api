/**
 * Type definitions for OpenAI and Anthropic API formats.
 * @see .omo/plans/zcode-proxy.md Task 5
 * @see https://platform.openai.com/docs/api-reference/chat
 * @see https://docs.anthropic.com/en/api/messages
 */

// ─────────────────────────────────────────────
// Shared types
// ─────────────────────────────────────────────

/** API format identifier. */
export type Format = "openai" | "anthropic";

// ─────────────────────────────────────────────
// OpenAI types
// ─────────────────────────────────────────────

/** OpenAI message role. */
type OpenAIRole = "system" | "user" | "assistant" | "tool";

/** OpenAI message in a chat completion request. */
export interface OpenAIMessage {
  role: OpenAIRole;
  content: string | null | OpenAIContentPart[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
  /** Reasoning / chain-of-thought content (GLM, DeepSeek-R1, o1-style models). */
  reasoning_content?: string;
}

/** Multi-modal content part (OpenAI format). */
export interface OpenAIContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string; detail?: string };
}

/** Tool call in an assistant message. */
export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** Tool call delta in a streaming chunk (carries `index` to align parallel calls). */
export interface OpenAIStreamToolCall {
  index: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

/**
 * OpenAI usage block. `prompt_tokens` is *inclusive* of cache hits on most
 * compatible upstreams, so the Anthropic `input_tokens` (exclusive of cache)
 * is derived by subtracting the cache buckets — see `openaiUsageToAnthropic`.
 */
export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** Standard OpenAI cache breakdown. */
  prompt_tokens_details?: { cached_tokens?: number };
  /** Anthropic-style direct cache fields (some compatible upstreams emit these). */
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  /** Standard OpenAI reasoning-token breakdown (mirrors `prompt_tokens_details`). */
  output_tokens_details?: { reasoning_tokens?: number; audio_tokens?: number };
}

/** Tool definition in OpenAI format. */
export interface OpenAIToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/** POST /v1/chat/completions request body. */
export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  top_p?: number;
  n?: number;
  stream?: boolean;
  stop?: string | string[];
  max_tokens?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  logit_bias?: Record<string, number>;
  user?: string;
  tools?: OpenAIToolDefinition[];
  tool_choice?: "none" | "auto" | "required" | { type: "function"; function: { name: string | undefined } };
  parallel_tool_calls?: boolean;
  response_format?: { type: "text" | "json_object" };
  seed?: number;
  reasoning_effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  thinking?: AnthropicThinkingConfig & { budgetTokens?: number };
}

/** Non-streaming response. */
export interface OpenAIChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: OpenAIChoice[];
  usage?: OpenAIUsage;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
}

/** Single choice in a non-streaming chat completion response. */
export interface OpenAIChoice {
  index?: number;
  message: OpenAIMessage;
  finish_reason?: "stop" | "length" | "tool_calls" | "content_filter" | null;
}

/** Streaming chunk (SSE `data:` payload). */
export interface OpenAIStreamChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: OpenAIStreamChoice[];
  /** Present on the final chunk when `stream_options.include_usage` is set. */
  usage?: OpenAIUsage;
}

/** Choice in a streaming chunk. */
export interface OpenAIStreamChoice {
  index: number;
  delta: {
    role?: "assistant";
    content?: string;
    reasoning_content?: string;
    tool_calls?: OpenAIStreamToolCall[];
  };
  finish_reason?: "stop" | "length" | "tool_calls" | "content_filter" | null;
}

/** /v1/models list entry. */
interface OpenAIModel {
  id: string;
  object: "model";
  created?: number;
  owned_by: string;
}

/** /v1/models list response. */
export interface OpenAIModelList {
  object: "list";
  data: OpenAIModel[];
}

// ─────────────────────────────────────────────
// Anthropic types
// ─────────────────────────────────────────────

/** Anthropic content block types. */
export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string | AnthropicContentBlock[]; is_error?: boolean }
  | { type: "thinking"; thinking: string; signature?: string };

/** Anthropic message in a request. */
export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

/** POST /v1/messages request body. */
export interface AnthropicMessagesRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: "text"; text: string }>;
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stream?: boolean;
  stop_sequences?: string[];
  metadata?: { user_id?: string };
  tools?: AnthropicToolDefinition[];
  tool_choice?: { type: "auto" | "any" | "tool"; name?: string };
  thinking?: AnthropicThinkingConfig;
}

/** Anthropic thinking/reasoning control. */
export interface AnthropicThinkingConfig {
  type: "enabled" | "disabled" | "adaptive";
  budget_tokens?: number;
  display?: boolean;
}

/** Tool definition in Anthropic format. */
export interface AnthropicToolDefinition {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

/** Non-streaming response. */
export interface AnthropicMessagesResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

/** Anthropic usage block (cache buckets are optional — only present when non-zero). */
export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

// ─────────────────────────────────────────────
// Anthropic SSE event types
// @see https://docs.anthropic.com/en/api/messages-streaming
// ─────────────────────────────────────────────

export type AnthropicStreamEvent =
  | { type: "message_start"; message: AnthropicMessagesResponse }
  | { type: "content_block_start"; index: number; content_block: AnthropicContentBlock }
  | {
      type: "content_block_delta";
      index: number;
      delta:
        | { type: "text_delta"; text: string }
        | { type: "input_json_delta"; partial_json: string }
        | { type: "thinking_delta"; thinking: string }
        | { type: "signature_delta"; signature: string }
        | { type: "stop_reason"; stop_reason: string };
    }
  | { type: "content_block_stop"; index: number }
  | {
      type: "message_delta";
      delta: { stop_reason: string; stop_sequence?: string | null };
      usage?: { output_tokens: number };
    }
  | { type: "message_stop" }
  | { type: "ping" };
