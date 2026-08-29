/**
 * OpenAI → Anthropic request translator and Anthropic → OpenAI response translator.
 * @see .omo/plans/zcode-proxy.md Task 11
 */
import type {
  OpenAIChatRequest,
  OpenAIChatResponse,
  OpenAIUsage,
  OpenAIMessage,
  OpenAIToolDefinition,
  AnthropicMessagesRequest,
  AnthropicMessagesResponse,
  AnthropicMessage,
  AnthropicContentBlock,
  AnthropicToolDefinition,
  AnthropicThinkingConfig,
  AnthropicUsage,
  AnthropicOutputConfig,
} from "./types.js";
import { MODELS } from "../provider/models.js";
import {
  isGlm53Model,
  normalizeGlm53Effort,
  buildGlm53Reasoning,
  fitGlm53Budget,
} from "../provider/reasoning.js";

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
    max_tokens: req.max_tokens ?? resolveDefaultMaxTokens(req.model),
  };

  if (system) result.system = system;
  if (req.temperature !== undefined) result.temperature = req.temperature;
  if (req.top_p !== undefined) result.top_p = req.top_p;
  if (req.stream !== undefined) result.stream = req.stream;
  if (req.stop) result.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];
  if (isGlm53Model(req.model)) {
    const { thinking, output_config } = translateGlm53Reasoning(req, result.max_tokens);
    result.thinking = thinking;
    if (output_config) result.output_config = output_config;
  } else {
    const thinking = translateThinking(req);
    if (thinking) result.thinking = thinking;
  }
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

function isReasoningModel(model: string): boolean {
  return MODELS.some((m) => m.id === model && m.reasoning === true);
}

/**
 * Resolve the max_tokens fallback when the OpenAI client omits it.
 *
 * The generic `DEFAULT_MAX_TOKENS` (4096) is too small to coexist with the
 * GLM-5.3 effort-based thinking budgets `translateGlm53Reasoning` attaches
 * below (up to 32,000) — `fitGlm53Budget` would clamp nearly the entire
 * allowance into thinking, leaving almost nothing for the answer. ZCode's own
 * clamp is written against the *model's* maxOutputTokens ceiling (128,000 for
 * glm-5.3), not a generic request-level fallback, so for this family look up
 * that ceiling in the catalog instead. Falls back to the generic default if
 * the model id isn't in the catalog. Every other model's default is
 * untouched — this is deliberately scoped to GLM-5.3 only.
 */
function resolveDefaultMaxTokens(model: string): number {
  if (!isGlm53Model(model)) return DEFAULT_MAX_TOKENS;
  const catalogEntry = MODELS.find((m) => m.id === model);
  return catalogEntry?.maxOutputTokens ?? DEFAULT_MAX_TOKENS;
}

/**
 * Build the `thinking` + `output_config` pair for a GLM-5.3 family request.
 *
 * `output_config.effort` is the only channel the Anthropic upstream honors
 * for this family — bare `reasoning_effort` is silently ignored — so every
 * GLM-5.3 request gets an explicit effort level, defaulting to ZCode's
 * catalog default (`max`) rather than falling through to a near-zero
 * upstream default. `reasoning_effort:"none"` maps to `"low"` here (via
 * `normalizeGlm53Effort`) instead of `{type:"disabled"}`: disabling does not
 * actually work for plain glm-5.3 (54 chars of thinking still came back in
 * live testing), so routing it through the effort channel is the closer
 * approximation across the whole family.
 *
 * An explicit `req.thinking:{type:"disabled"}` is still forwarded as-is
 * (rather than overridden to an effort level) since it does work for
 * glm-5.3-flash, and is the closest available signal for plain glm-5.3.
 * An explicit `req.thinking` budget is respected over the effort-level
 * default budget, but `output_config.effort` is still attached — without it
 * the upstream runs at its own near-zero default regardless of budget.
 */
function translateGlm53Reasoning(
  req: OpenAIChatRequest,
  maxTokens: number,
): { thinking: AnthropicThinkingConfig; output_config?: AnthropicOutputConfig } {
  const explicit = req.thinking;
  if (explicit && typeof explicit === "object" && explicit.type === "disabled") {
    return { thinking: { type: "disabled" } };
  }

  const effort = normalizeGlm53Effort(req.reasoning_effort);
  const base = buildGlm53Reasoning(effort);

  let budget: number = base.thinking.budget_tokens;
  if (explicit && typeof explicit === "object" && (explicit.type === "enabled" || explicit.type === "adaptive")) {
    const explicitBudget = explicit.budget_tokens ?? explicit.budgetTokens;
    if (typeof explicitBudget === "number" && Number.isFinite(explicitBudget)) {
      // Floor before the positivity test, not after: JSON permits a fractional
      // budget, and a value like 0.5 passes `> 0` yet floors to 0 — which then
      // survives `fitGlm53Budget` untouched whenever `max_tokens` is not a
      // finite number, handing the upstream `budget_tokens: 0`.
      const floored = Math.floor(explicitBudget);
      if (floored > 0) budget = floored;
    }
  }

  const fitted = fitGlm53Budget(budget, maxTokens);
  return {
    thinking: fitted !== undefined ? { type: "enabled", budget_tokens: fitted } : { type: "enabled" },
    output_config: base.output_config,
  };
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
  return msg.content.map((c) => {
    if (c.type === "text") return { type: "text" as const, text: c.text ?? "" };
    if (c.type === "image_url" && c.image_url?.url) {
      return imageUrlToAnthropicBlock(c.image_url.url);
    }
    return { type: "text" as const, text: "" };
  });
}

function parseDataUrl(url: string): { mediaType: string; data: string } | undefined {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
  if (!m) return undefined;
  return { mediaType: m[1], data: m[2] };
}

/**
 * Map an OpenAI `image_url` string to an Anthropic image block.
 *
 * `data:` base64 URLs become inline base64 sources; http(s) URLs become
 * url-source image blocks — the same two shapes the ZCode client emits
 * (`image-data` → base64 source, `image-url` → url source). Anything else
 * (non-base64 data URLs, exotic schemes) degrades to a text block carrying
 * the URL verbatim rather than emitting a block the upstream would reject.
 * OpenAI's `detail` hint has no Anthropic equivalent and is dropped.
 */
function imageUrlToAnthropicBlock(url: string): AnthropicContentBlock {
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
  return { type: "text", text: url };
}

/**
 * Convert an Anthropic usage block into OpenAI's cache-inclusive usage
 * semantics — the counterpart of `openaiUsageToAnthropic`.
 *
 * Anthropic reports the fresh (uncached) input in `input_tokens` and keeps the
 * three buckets mutually exclusive; OpenAI's `prompt_tokens` is *inclusive* of
 * cache hits. So prompt = input + cache_read + cache_creation, with the cache
 * read additionally surfaced through the standard `prompt_tokens_details`.
 * The Anthropic-style cache fields are deliberately not mirrored onto the
 * OpenAI usage object — strict-schema clients reject unknown members.
 *
 * Totals round-trip exactly; buckets do not. OpenAI has no cache-creation
 * member, so a converted-and-converted-back usage reclassifies those tokens as
 * fresh input. `prompt_tokens` and `total_tokens` stay correct either way.
 */
export function anthropicUsageToOpenAI(usage: AnthropicUsage | undefined): OpenAIUsage {
  const inputTokens = usage?.input_tokens ?? 0;
  const outputTokens = usage?.output_tokens ?? 0;
  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  const cacheCreation = usage?.cache_creation_input_tokens ?? 0;
  const promptTokens = inputTokens + cacheRead + cacheCreation;

  return {
    prompt_tokens: promptTokens,
    completion_tokens: outputTokens,
    total_tokens: promptTokens + outputTokens,
    // Presence-preserving: an upstream explicitly reporting 0 cache reads stays
    // distinguishable from one reporting no cache breakdown at all.
    ...(usage?.cache_read_input_tokens != null
      ? { prompt_tokens_details: { cached_tokens: cacheRead } }
      : {}),
  };
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
    usage: anthropicUsageToOpenAI(resp.usage),
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
  if (Array.isArray(msg.content)) {
    return msg.content.map((c) => {
      if (c.type === "text") return { type: "text" as const, text: c.text ?? "" };
      if (c.type === "image_url" && c.image_url?.url) {
        return imageUrlToAnthropicBlock(c.image_url.url);
      }
      return { type: "text" as const, text: "" };
    });
  }
  return "";
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
