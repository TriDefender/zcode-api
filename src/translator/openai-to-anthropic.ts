/**
 * OpenAI → Anthropic request translator and Anthropic → OpenAI response translator.
 * @see .omo/plans/zcode-proxy.md Task 11
 */
import type {
  OpenAIChatRequest,
  OpenAIChatResponse,
  OpenAIMessage,
  OpenAIToolDefinition,
  AnthropicMessagesRequest,
  AnthropicMessagesResponse,
  AnthropicMessage,
  AnthropicContentBlock,
  AnthropicToolDefinition,
  AnthropicThinkingConfig,
} from "./types.js";
import { isReasoningModel, isThinkingRequired } from "../provider/models.js";

/** Default max_tokens if the OpenAI request doesn't specify one. */
const DEFAULT_MAX_TOKENS = 4096;

/** Translate an OpenAI chat request into an Anthropic messages request. */
export function translateRequestOpenAIToAnthropic(req: OpenAIChatRequest): AnthropicMessagesRequest {
  const systemMessages = req.messages.filter((m) => m.role === "system");
  const nonSystemMessages = req.messages.filter((m) => m.role !== "system");

  const system = systemMessages.length > 0
    ? systemMessages.map((m) => extractText(m)).join("\n\n")
    : undefined;

  const anthropicMessages = translateMessagesWithToolCoalescing(nonSystemMessages);

  const result: AnthropicMessagesRequest = {
    model: req.model,
    messages: anthropicMessages,
    max_tokens: req.max_tokens ?? DEFAULT_MAX_TOKENS,
  };

  if (system) result.system = system;
  if (req.temperature !== undefined) result.temperature = req.temperature;
  if (req.top_p !== undefined) result.top_p = req.top_p;
  if (req.stream !== undefined) result.stream = req.stream;
  if (req.stop) result.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];
  const thinking = translateThinking(req);
  if (thinking) result.thinking = thinking;
  if (req.tools?.length && req.tool_choice !== "none") {
    result.tools = req.tools.map(translateToolOpenAIToAnthropic);
  }
  if (req.tool_choice !== undefined && req.tool_choice !== "none") {
    const translated = translateToolChoice(req.tool_choice);
    if (translated) result.tool_choice = translated;
  }

  return result;
}

function translateThinking(req: OpenAIChatRequest): AnthropicThinkingConfig | undefined {
  const explicit = req.thinking;

  // GLM-5.3-Flash requires thinking; normalize attempts to disable or use an
  // unsupported adaptive mode to the provider's accepted enabled shape.
  if (isThinkingRequired(req.model)) {
    const budget = explicit && typeof explicit === "object"
      ? explicit.budget_tokens ?? explicit.budgetTokens
      : undefined;
    return {
      type: "enabled",
      ...(typeof budget === "number" && Number.isFinite(budget) && budget > 0
        ? { budget_tokens: Math.floor(budget) }
        : {}),
    };
  }

  if (explicit && typeof explicit === "object") {
    if (explicit.type === "disabled") return { type: "disabled" };
    if (explicit.type === "enabled" || explicit.type === "adaptive") {
      const budget = explicit.budget_tokens ?? explicit.budgetTokens;
      return {
        type: explicit.type,
        ...(typeof budget === "number" && Number.isFinite(budget) && budget > 0
          ? { budget_tokens: Math.floor(budget) }
          : {}),
        ...(explicit.type === "adaptive" && typeof explicit.display === "boolean"
          ? { display: explicit.display }
          : {}),
      };
    }
  }
  if (req.reasoning_effort === "none") return { type: "disabled" };
  if (isReasoningModel(req.model)) return { type: "enabled" };
  return undefined;
}

function translateToolChoice(
  choice: "none" | "auto" | "required" | { type: "function"; function: { name: string | undefined } },
): { type: "auto" | "any" | "tool"; name?: string } | undefined {
  if (choice === "auto") return { type: "auto" };
  if (choice === "required") return { type: "any" };
  if (typeof choice === "object" && choice.type === "function") {
    return { type: "tool", name: choice.function.name };
  }
  return undefined;
}

/**
 * Translate non-system OpenAI messages into Anthropic messages, coalescing
 * consecutive `role:"tool"` messages into a single Anthropic `user` message
 * with multiple `tool_result` blocks (Anthropic's expected shape for parallel
 * tool results).
 */
function translateMessagesWithToolCoalescing(messages: OpenAIMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (m.role === "tool" && m.tool_call_id) {
      const results: AnthropicContentBlock[] = [];
      while (i < messages.length) {
        const tool = messages[i];
        const toolCallId = tool.tool_call_id;
        if (tool.role !== "tool" || !toolCallId) break;
        results.push({
          type: "tool_result",
          tool_use_id: toolCallId,
          content: toolResultContent(tool),
        });
        i++;
      }
      out.push({ role: "user", content: results });
      continue;
    }
    out.push(translateMessageOpenAIToAnthropic(m));
    i++;
  }
  return out;
}

function translateMessageOpenAIToAnthropic(msg: OpenAIMessage): AnthropicMessage {
  if (msg.role === "assistant" && msg.tool_calls?.length) {
    const blocks: AnthropicContentBlock[] = [];
    const text = extractText(msg);
    if (text.length > 0) blocks.push({ type: "text", text });
    for (const tc of msg.tool_calls) {
      blocks.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: parseToolArguments(tc.function.arguments),
      });
    }
    return { role: "assistant", content: blocks };
  }
  return {
    role: msg.role === "assistant" ? "assistant" : "user",
    content: translateContentOpenAIToAnthropic(msg),
  };
}

function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function toolResultContent(msg: OpenAIMessage): string | AnthropicContentBlock[] {
  if (typeof msg.content === "string") return msg.content;
  if (!Array.isArray(msg.content)) return "";
  if (msg.content.every((c) => c.type === "text")) {
    const joined = msg.content.map((c) => c.text ?? "").join("");
    return joined;
  }
  return msg.content.map(translateOpenAIContentPart);
}

function parseDataUrl(url: string): { mediaType: string; data: string } | undefined {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
  if (!m) return undefined;
  return { mediaType: m[1], data: m[2] };
}

/** Translate an Anthropic messages response into an OpenAI chat completion response. */
export function translateResponseAnthropicToOpenAI(
  resp: AnthropicMessagesResponse,
  model: string,
): OpenAIChatResponse {
  const textBlocks = resp.content.filter((b) => b.type === "text");
  const toolUseBlocks = resp.content.filter((b) => b.type === "tool_use");
  const thinkingBlocks = resp.content.filter((b) => b.type === "thinking");

  const content = textBlocks.map((b) => (b as any).text).join("") || null;
  const reasoningContent = thinkingBlocks.map((b) => (b as any).thinking ?? "").join("") || undefined;
  const toolCalls = toolUseBlocks.length > 0
    ? toolUseBlocks.map((b, i) => ({
        id: (b as any).id,
        type: "function" as const,
        function: {
          name: (b as any).name,
          arguments: JSON.stringify((b as any).input ?? {}),
        },
      }))
    : undefined;

  const finishReason = mapStopReasonToFinishReason(resp.stop_reason);

  return {
    id: resp.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content,
        ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: finishReason,
    }],
    usage: {
      prompt_tokens: resp.usage?.input_tokens ?? 0,
      completion_tokens: resp.usage?.output_tokens ?? 0,
      total_tokens: (resp.usage?.input_tokens ?? 0) + (resp.usage?.output_tokens ?? 0),
    },
  };
}

function extractText(msg: OpenAIMessage): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
  }
  return "";
}

function translateContentOpenAIToAnthropic(msg: OpenAIMessage): string | AnthropicContentBlock[] {
  if (typeof msg.content === "string") return msg.content;
  if (msg.content === null) return "";
  if (Array.isArray(msg.content)) return msg.content.map(translateOpenAIContentPart);
  return "";
}

/** Convert an OpenAI content part without silently dropping image input. */
function translateOpenAIContentPart(part: { type: "text" | "image_url"; text?: string; image_url?: { url: string; detail?: string } }): AnthropicContentBlock {
  if (part.type === "text") return { type: "text", text: part.text ?? "" };
  const url = part.image_url?.url ?? "";
  const parsed = parseDataUrl(url);
  if (parsed) {
    return {
      type: "image",
      source: { type: "base64", media_type: parsed.mediaType, data: parsed.data },
    };
  }
  if (/^https?:\/\//i.test(url)) {
    return { type: "image", source: { type: "url", url } };
  }
  // Preserve malformed/unsupported image references as text rather than
  // turning them into an empty content block.
  return { type: "text", text: url };
}

function translateToolOpenAIToAnthropic(tool: OpenAIToolDefinition): AnthropicToolDefinition {
  return {
    name: tool.function.name,
    ...(tool.function.description ? { description: tool.function.description } : {}),
    ...(tool.function.parameters ? { input_schema: tool.function.parameters } : {}),
  };
}

function mapStopReasonToFinishReason(
  stopReason: string | null | undefined,
): "stop" | "length" | "tool_calls" | "content_filter" | null {
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    default:
      return null;
  }
}
