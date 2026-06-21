/**
 * OpenAI Responses API → Anthropic messages (for Codex wire_api=responses).
 */
import type { AnthropicMessagesRequest, AnthropicMessage, AnthropicContentBlock } from "./types.js";

const DEFAULT_MAX_TOKENS = 8192;

const REASONING_EFFORT_BUDGET: Record<string, number> = {
  minimal: 512,
  low: 1024,
  medium: 8192,
  high: 16000,
  xhigh: 32000,
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!isRecord(part)) return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.output === "string") return part.output;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeContent(content: unknown): string | AnthropicContentBlock[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const blocks: AnthropicContentBlock[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    const type = part.type;
    if (type === "text" || type === "input_text" || type === "output_text") {
      blocks.push({ type: "text", text: str(part.text) ?? "" });
      continue;
    }
    if (type === "image_url" || type === "input_image") {
      const url =
        str(isRecord(part.image_url) ? part.image_url.url : undefined) ??
        str(part.url) ??
        str(part.image_url);
      if (url?.startsWith("data:")) {
        const m = url.match(/^data:([^;]+);base64,(.+)$/);
        if (m) {
          blocks.push({
            type: "image",
            source: { type: "base64", media_type: m[1]!, data: m[2]! },
          });
        }
      }
    }
  }
  return blocks.length > 0 ? blocks : "";
}

function inputItemToMessages(item: unknown): AnthropicMessage[] {
  if (typeof item === "string") {
    return [{ role: "user", content: item }];
  }
  if (!isRecord(item)) return [];

  if (item.type === "function_call") {
    const name = str(item.name);
    if (!name) return [];
    const callId = str(item.call_id) ?? str(item.id) ?? `call_${name}`;
    let input: Record<string, unknown> = {};
    try {
      const args = item.arguments;
      input = typeof args === "string" ? JSON.parse(args) : (args as Record<string, unknown>) ?? {};
    } catch {
      input = {};
    }
    return [{
      role: "assistant",
      content: [{ type: "tool_use", id: callId, name, input }],
    }];
  }

  if (item.type === "function_call_output") {
    const callId = str(item.call_id) ?? str(item.id) ?? "unknown";
    return [{
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: callId,
        content: contentToText(item.output ?? item.content),
      }],
    }];
  }

  const role = str(item.role);
  if (role === "assistant" || role === "user") {
    const msg: AnthropicMessage = {
      role,
      content: normalizeContent(item.content),
    };
    if (Array.isArray(item.tool_calls) && item.tool_calls.length > 0) {
      const blocks: AnthropicContentBlock[] = Array.isArray(msg.content)
        ? [...msg.content]
        : msg.content ? [{ type: "text", text: msg.content }] : [];
      for (const tc of item.tool_calls) {
        if (!isRecord(tc) || !isRecord(tc.function)) continue;
        const name = str(tc.function.name);
        if (!name) continue;
        const id = str(tc.id) ?? `call_${name}`;
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(str(tc.function.arguments) ?? "{}");
        } catch {
          input = {};
        }
        blocks.push({ type: "tool_use", id, name, input });
      }
      msg.content = blocks;
    }
    return [msg];
  }

  if (item.type === "message" && role) {
    return [{ role: role === "assistant" ? "assistant" : "user", content: normalizeContent(item.content) }];
  }

  if (item.type === "input_text" || item.type === "output_text") {
    return [{ role: "user", content: str(item.text) ?? "" }];
  }

  return [];
}

function normalizeInput(input: unknown): AnthropicMessage[] {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (Array.isArray(input)) return input.flatMap(inputItemToMessages);
  if (isRecord(input)) return inputItemToMessages(input);
  return [];
}

function normalizeTools(tools: unknown): AnthropicMessagesRequest["tools"] {
  if (!Array.isArray(tools)) return undefined;
  const out: NonNullable<AnthropicMessagesRequest["tools"]> = [];
  for (const tool of tools) {
    if (!isRecord(tool)) continue;
    if (tool.type === "function" && isRecord(tool.function)) {
      out.push({
        name: str(tool.function.name) ?? "tool",
        ...(str(tool.function.description) ? { description: tool.function.description } : {}),
        ...(isRecord(tool.function.parameters) ? { input_schema: tool.function.parameters } : {}),
      });
      continue;
    }
    if (tool.type === "function" || tool.type === "custom") {
      const name = str(tool.name);
      if (!name) continue;
      out.push({
        name,
        ...(str(tool.description) ? { description: tool.description } : {}),
        ...(isRecord(tool.parameters) ? { input_schema: tool.parameters } : {}),
        ...(isRecord(tool.input_schema) ? { input_schema: tool.input_schema } : {}),
      });
    }
  }
  return out.length > 0 ? out : undefined;
}

/** Translate a Responses API request body to Anthropic /v1/messages. */
export function translateResponsesToAnthropic(body: Record<string, unknown>): AnthropicMessagesRequest {
  const model = str(body.model) ?? "glm-5.2";
  const stream = body.stream !== false;

  const systemParts: string[] = [];
  const instructions = str(body.instructions);
  if (instructions) systemParts.push(instructions);

  const messages = normalizeInput(body.input);
  for (const msg of [...messages]) {
    // Pull system/developer out of input if present (re-parse from raw input)
    void msg;
  }
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!isRecord(item)) continue;
      const role = str(item.role);
      if (role === "system" || role === "developer") {
        const text = contentToText(item.content);
        if (text) systemParts.push(text);
      }
    }
  }

  const filtered = Array.isArray(body.input)
    ? normalizeInput(
        body.input.filter((item) => {
          if (!isRecord(item)) return true;
          const role = str(item.role);
          return role !== "system" && role !== "developer";
        }),
      )
    : messages;

  const maxTokens =
    typeof body.max_output_tokens === "number" ? body.max_output_tokens :
    typeof body.max_tokens === "number" ? body.max_tokens :
    DEFAULT_MAX_TOKENS;

  const result: AnthropicMessagesRequest = {
    model,
    messages: filtered.length > 0 ? filtered : [{ role: "user", content: "" }],
    max_tokens: maxTokens,
    stream,
  };

  if (systemParts.length > 0) result.system = systemParts.join("\n\n");
  if (typeof body.temperature === "number") result.temperature = body.temperature;
  if (typeof body.top_p === "number") result.top_p = body.top_p;

  const tools = normalizeTools(body.tools);
  if (tools) result.tools = tools;

  const reasoning = isRecord(body.reasoning) ? body.reasoning : null;
  const effort = reasoning && typeof reasoning.effort === "string" ? reasoning.effort : null;
  if (effort && effort !== "none") {
    const budget = REASONING_EFFORT_BUDGET[effort] ?? REASONING_EFFORT_BUDGET.medium!;
    (result as Record<string, unknown>).thinking = { type: "enabled", budget_tokens: budget };
  }

  return result;
}
