/**
 * Anthropic → OpenAI request translator and OpenAI → Anthropic response translator.
 * @see .omo/plans/zcode-proxy.md Task 11
 */
import type {
  OpenAIChatRequest,
  OpenAIChatResponse,
  OpenAIUsage,
  OpenAIMessage,
  OpenAIContentPart,
  OpenAIToolCall,
  AnthropicMessagesRequest,
  AnthropicMessagesResponse,
  AnthropicMessage,
  AnthropicContentBlock,
  AnthropicUsage,
} from "./types.js";

/** Translate an Anthropic messages request into an OpenAI chat request. */
export function translateRequestAnthropicToOpenAI(req: AnthropicMessagesRequest): OpenAIChatRequest {
  const messages: OpenAIMessage[] = [];

  if (req.system) {
    const systemText = typeof req.system === "string"
      ? req.system
      : req.system.map((s) => s.text).join("\n");
    messages.push({ role: "system", content: systemText });
  }

  for (const m of req.messages) {
    messages.push(...translateMessageAnthropicToOpenAI(m));
  }

  const result: OpenAIChatRequest = {
    model: req.model,
    messages,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.top_p !== undefined ? { top_p: req.top_p } : {}),
    ...(req.stream !== undefined ? { stream: req.stream } : {}),
    ...(req.max_tokens !== undefined ? { max_tokens: req.max_tokens } : {}),
  };

  if (req.stop_sequences?.length) {
    result.stop = req.stop_sequences.length === 1 ? req.stop_sequences[0] : req.stop_sequences;
  }

  if (req.thinking) {
    result.thinking = req.thinking;
  }

  if (req.tools?.length) {
    result.tools = req.tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        ...(t.input_schema ? { parameters: t.input_schema } : {}),
      },
    }));
  }

  if (req.tool_choice) {
    const translated = mapToolChoiceAnthropicToOpenAI(req.tool_choice);
    if (translated !== undefined) result.tool_choice = translated;
  }

  return result;
}

/**
 * Map an Anthropic `tool_choice` to the OpenAI Chat Completions form.
 *
 * Anthropic: `{type:"auto"|"any"|"tool", name?}` (a top-level string is also
 * accepted by the API). There is no `none` — suppressing tools is done by
 * omitting the `tools` array entirely.
 * OpenAI:    `"auto" | "required"` or `{type:"function", function:{name}}`.
 * Note: Anthropic `any` (force some tool) maps to OpenAI `required`.
 */
function mapToolChoiceAnthropicToOpenAI(
  choice: { type: "auto" | "any" | "tool"; name?: string },
): "auto" | "required" | { type: "function"; function: { name: string | undefined } } | undefined {
  switch (choice.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "tool":
      // Pass `name` through verbatim (possibly undefined). Anthropic mandates a
      // name for type:"tool", so a missing one is a client contract violation —
      // forwarding it lets the upstream reject with its native error rather than
      // masking the bug behind a synthetic empty function name.
      return { type: "function", function: { name: choice.name } };
    default:
      return undefined;
  }
}

/** Translate an OpenAI chat response into an Anthropic messages response. */
export function translateResponseOpenAIToAnthropic(
  resp: OpenAIChatResponse,
): AnthropicMessagesResponse {
  const choice = resp.choices?.[0];
  const content: AnthropicContentBlock[] = [];

  if (choice?.message?.reasoning_content) {
    content.push({ type: "thinking", thinking: choice.message.reasoning_content });
  }

  if (choice?.message?.content) {
    const textContent = typeof choice.message.content === "string"
      ? choice.message.content
      : Array.isArray(choice.message.content)
        ? choice.message.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("")
        : "";
    if (textContent) content.push({ type: "text", text: textContent });
  }

  if (choice?.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(tc.function.arguments);
      } catch {
        input = {};
      }
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input,
      });
    }
  }

  const stopReason = mapFinishReasonToStopReason(choice?.finish_reason);

  return {
    id: resp.id,
    type: "message",
    role: "assistant",
    content: content.length > 0 ? content : [{ type: "text", text: "" }],
    model: resp.model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: openaiUsageToAnthropic(resp.usage),
  };
}

/**
 * Translate a single Anthropic message into one or more OpenAI messages.
 *
 * A single Anthropic message can fan out to multiple OpenAI messages because
 * `tool_result` blocks must become standalone `role:"tool"` messages (OpenAI
 * has no inline equivalent). The carrier message (text/image/tool_use) is
 * emitted last, preserving the Anthropic role for text/assistant content.
 */
function translateMessageAnthropicToOpenAI(m: AnthropicMessage): OpenAIMessage[] {
  if (typeof m.content === "string") {
    return [{ role: m.role, content: m.content }];
  }

  const result: OpenAIMessage[] = [];
  const contentParts: OpenAIContentPart[] = [];
  const toolCalls: OpenAIToolCall[] = [];
  const reasoningParts: string[] = [];

  for (const block of m.content) {
    switch (block.type) {
      case "text": {
        contentParts.push({ type: "text", text: block.text });
        break;
      }
      case "image": {
        if (block.source.type === "base64") {
          contentParts.push({
            type: "image_url",
            image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
          });
        }
        break;
      }
      case "tool_use": {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        });
        break;
      }
      case "tool_result": {
        result.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: toolResultContentToOpenAI(block.content, block.is_error === true),
        });
        break;
      }
      case "thinking": {
        if (block.thinking.length > 0) reasoningParts.push(block.thinking);
        break;
      }
      default:
        break;
    }
  }

  // Emit the carrier message when there is text/image content, tool calls, or
  // assistant reasoning — otherwise a thinking-only assistant turn would lose
  // its reasoning_content (and the next user turn would be misaligned).
  const hasReasoning = m.role === "assistant" && reasoningParts.length > 0;
  if (contentParts.length > 0 || toolCalls.length > 0 || hasReasoning) {
    const content: string | null | OpenAIContentPart[] = contentParts.length === 0
      ? null
      : contentParts.length === 1 && contentParts[0].type === "text"
        ? contentParts[0].text ?? ""
        : contentParts;
    result.push({
      role: m.role,
      content,
      ...(hasReasoning ? { reasoning_content: reasoningParts.join("\n") } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
  }

  // Guarantee at least one message so the turn isn't silently dropped.
  if (result.length === 0) {
    result.push({ role: m.role, content: null });
  }

  return result;
}

/**
 * Flatten an Anthropic tool_result `content` field into an OpenAI tool-message
 * `content` string. Text blocks are joined; non-text blocks are JSON-serialized
 * to avoid data loss (OpenAI tool messages are stringly-typed).
 *
 * OpenAI has no native "this tool call failed" flag, so a truthy `isError`
 * (Anthropic's `tool_result.is_error`) is encoded as a leading `[tool_error]`
 * marker so the downstream model can still tell a failed execution from a
 * successful one.
 */
function toolResultContentToOpenAI(
  content: string | AnthropicContentBlock[] | undefined,
  isError: boolean,
): string {
  const body = flattenToolResultContent(content);
  return isError && body.length > 0 ? `[tool_error] ${body}` : body;
}

function flattenToolResultContent(content: string | AnthropicContentBlock[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts = content
    .filter((b) => b.type === "text")
    .map((b) => b.text);
  if (texts.length > 0) return texts.join("");
  return JSON.stringify(content);
}

function mapFinishReasonToStopReason(
  finishReason: string | null | undefined,
): "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null {
  switch (finishReason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "content_filter":
      return "end_turn";
    default:
      return null;
  }
}

/**
 * Convert an OpenAI usage block into Anthropic usage semantics.
 *
 * OpenAI `prompt_tokens` is *inclusive* of cache hits, while Anthropic
 * `input_tokens` is the fresh (uncached) input. The three buckets are mutually
 * exclusive and sum to `prompt_tokens`: `input + cache_read + cache_creation`.
 * Cache values are accepted from either the standard `prompt_tokens_details`
 * breakdown or Anthropic-style direct fields (some compatible upstreams emit
 * those). Missing buckets default to 0, so a vanilla OpenAI usage with no cache
 * fields passes through unchanged.
 */
export function openaiUsageToAnthropic(usage: OpenAIUsage | undefined): AnthropicUsage {
  const promptTokens = usage?.prompt_tokens ?? 0;
  const cacheRead = usage?.cache_read_input_tokens
    ?? usage?.prompt_tokens_details?.cached_tokens
    ?? 0;
  const cacheCreation = usage?.cache_creation_input_tokens ?? 0;
  const inputTokens = Math.max(0, promptTokens - cacheRead - cacheCreation);
  const result: AnthropicUsage = {
    input_tokens: inputTokens,
    output_tokens: usage?.completion_tokens ?? 0,
  };
  if (cacheRead > 0) result.cache_read_input_tokens = cacheRead;
  if (cacheCreation > 0) result.cache_creation_input_tokens = cacheCreation;
  return result;
}
