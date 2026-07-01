/**
 * Anthropic → OpenAI request translator and OpenAI → Anthropic response translator.
 * @see .omo/plans/zcode-proxy.md Task 11
 */
import type {
  OpenAIChatRequest,
  OpenAIChatResponse,
  OpenAIMessage,
  AnthropicMessagesRequest,
  AnthropicMessagesResponse,
  AnthropicMessage,
  AnthropicContentBlock,
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
    messages.push(translateMessageAnthropicToOpenAI(m));
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

  return result;
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
    content.push({ type: "text", text: choice.message.content });
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
    usage: {
      input_tokens: resp.usage?.prompt_tokens ?? 0,
      output_tokens: resp.usage?.completion_tokens ?? 0,
    },
  };
}

function translateMessageAnthropicToOpenAI(m: AnthropicMessage): OpenAIMessage {
  if (typeof m.content === "string") {
    return { role: m.role, content: m.content };
  }

  const textParts = m.content
    .filter((b) => b.type === "text")
    .map((b) => (b as any).text)
    .join("");
  const thinkingParts = m.content
    .filter((b) => b.type === "thinking")
    .map((b) => (b as any).thinking ?? "")
    .join("");

  return {
    role: m.role,
    content: textParts || null,
    ...(m.role === "assistant" && thinkingParts ? { reasoning_content: thinkingParts } : {}),
  };
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
