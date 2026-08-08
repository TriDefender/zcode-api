/**
 * Responses API → Chat Completions request translation.
 *
 * Mirrors the de-facto ecosystem approach verified against three independent
 * implementations (sub2api, cc-switch PR#3640, LiteLLM PR#29281) and adapted to
 * GLM as the upstream. Key rules:
 *
 *   - `instructions` becomes `messages[0]` (system).
 *   - `input[]` items become user/assistant/tool messages. Function-call /
 *     custom-tool-call / tool-search histories are rebuilt with the tool-reply
 *     invariant Chat Completions requires (assistant.tool_calls → tool reply,
 *     strictly paired, nothing in between).
 *   - `function` tools pass through to Chat `tools`.
 *   - `custom` tools (Codex's `exec` / `apply_patch`) downgrade to `function`
 *     with a `{input:string}` schema — this is the make-or-break for Codex.
 *   - `namespace` tools flatten to `{ns}__{name}` and are restored on the way
 *     back (see `chat-to-responses.ts`). Ambiguous collisions are rejected.
 *   - `tool_search` downgrades to a same-named `function` proxy with
 *     `execution:"client"` semantics (Codex routes by item type, not just name).
 *   - `web_search` / `web_search_preview` are stripped here; the Responses
 *     handler intercepts them via GLM MCP (see `proxy/responses-handler.ts`).
 *   - `file_search` / `code_interpreter` / `computer_use_preview` /
 *     `image_generation` / `mcp` (hosted) are stripped silently.
 *   - When all convertible tools are gone, `tool_choice` AND
 *     `parallel_tool_calls` are dropped (cc-switch PR#3640: leaving them with
 *     empty `tools[]` causes upstream 400/503 on strict backends).
 *
 * `previous_response_id` is NOT handled here — the Responses handler resolves
 * it via `ResponseStore` and prepends the stored history to `input[]` before
 * calling this translator. This module is pure and stateless.
 */
import type {
  OpenAIChatRequest,
  OpenAIMessage,
  OpenAIToolDefinition,
  OpenAIContentPart,
} from "./types.js";
import type {
  ResponsesRequest,
  ResponsesInputItem,
  ResponsesTool,
  ResponsesContentPart,
} from "./responses-types.js";
import { isHostedTool, isWebSearchTool } from "./responses-types.js";

/** Output of the translator: the Chat request + bookkeeping for the reverse path. */
export interface ResponsesToChatResult {
  chatRequest: OpenAIChatRequest;
  /** Tool names that were `type:"custom"` on the request — used to restore `custom_tool_call` items on the response. */
  customToolNames: Set<string>;
  /** Flattened namespace tool names → {namespace, name} — used to restore `namespace` on the response. */
  namespaceMap: Map<string, { namespace: string; name: string }>;
  /** True when the request declared a `web_search` hosted tool (handler intercepts it). */
  hasWebSearch: boolean;
  /** True when the request declared `type:"tool_search"` (response must emit `tool_search_call` items). */
  hasToolSearch: boolean;
  /** Names of tools the model may legally emit (after conversion). Used for response routing. */
  convertibleToolNames: Set<string>;
}

/** Sentinel schema for `custom` tools (free-text input — matches Codex's `exec`). */
const CUSTOM_TOOL_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { input: { type: "string" } },
  required: ["input"],
  additionalProperties: false,
};

/** Sentinel schema for the `tool_search` proxy function. */
const TOOL_SEARCH_PROXY_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { query: { type: "string" }, limit: { type: "number" } },
  additionalProperties: false,
};

/**
 * Translate a Responses request into a Chat Completions request.
 * Throws on unrecoverable ambiguity (e.g. namespace flatten collisions).
 */
export function responsesToChatCompletions(req: ResponsesRequest): ResponsesToChatResult {
  const messages: OpenAIMessage[] = [];

  // ── instructions → system message ──
  if (typeof req.instructions === "string" && req.instructions.trim().length > 0) {
    messages.push({ role: "system", content: req.instructions });
  }

  // ── input[] → messages ──
  const inputItems = normaliseInput(req.input);
  const built = buildMessagesFromItems(inputItems);
  messages.push(...built);

  // ── tools + bookkeeping ──
  const customToolNames = new Set<string>();
  const namespaceMap = new Map<string, { namespace: string; name: string }>();
  const convertibleToolNames = new Set<string>();
  let hasWebSearch = false;
  let hasToolSearch = false;

  const tools: OpenAIToolDefinition[] = [];
  if (Array.isArray(req.tools)) {
    for (const tool of req.tools) {
      collectTools(tool, "", tools, customToolNames, namespaceMap, convertibleToolNames, ref => {
        if (ref === "web_search") hasWebSearch = true;
        if (ref === "tool_search") hasToolSearch = true;
      });
    }
  }

  // ── assemble chat request ──
  const chatRequest: OpenAIChatRequest = {
    model: req.model,
    messages,
    ...(req.max_output_tokens !== undefined ? { max_tokens: req.max_output_tokens } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.top_p !== undefined ? { top_p: req.top_p } : {}),
    ...(req.stream !== undefined ? { stream: req.stream } : {}),
    ...(req.user !== undefined ? { user: req.user } : {}),
  };
  if (tools.length > 0) chatRequest.tools = tools;

  // ── tool_choice + parallel_tool_calls (cc-switch PR#3640 cleanup) ──
  if (tools.length > 0 && req.tool_choice !== undefined) {
    const mapped = mapToolChoice(req.tool_choice, convertibleToolNames, hasToolSearch);
    if (mapped !== undefined) chatRequest.tool_choice = mapped;
  }
  if (tools.length > 0 && req.parallel_tool_calls !== undefined) {
    chatRequest.parallel_tool_calls = req.parallel_tool_calls;
  }

  // ── reasoning.effort → reasoning_effort ──
  if (req.reasoning?.effort) {
    chatRequest.reasoning_effort = req.reasoning.effort;
  }

  return {
    chatRequest,
    customToolNames,
    namespaceMap,
    hasWebSearch,
    hasToolSearch,
    convertibleToolNames,
  };
}

// ─────────────────────────────────────────────
// Input → messages
// ─────────────────────────────────────────────

/** Coerce `input` (string or array) into a flat array of items. */
function normaliseInput(input: ResponsesRequest["input"]): ResponsesInputItem[] {
  if (typeof input === "string") {
    return [{ type: "message", role: "user", content: input }];
  }
  if (!Array.isArray(input)) return [];
  return input.filter((x): x is ResponsesInputItem => x !== null && typeof x === "object");
}

/**
 * Walk input items and build Chat messages. Preserves the tool-call invariant
 * Chat Completions requires: an assistant `tool_calls` message must be followed
 * immediately by one `tool` message per call_id, in order, nothing between.
 *
 * Strategy mirrors sub2api's `buildChatMessagesFromItems` + `normalizeChatMessages`
 * (combined here in a single pass for simplicity):
 *   - `reasoning` text attaches to the next assistant tool-call message.
 *   - parallel `function_call` items coalesce into one assistant message.
 *   - unknown item types with no Chat equivalent are skipped (web_search_call,
 *     file_search_call, etc.) — they have no Chat representation.
 */
function buildMessagesFromItems(items: ResponsesInputItem[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  let pendingReasoning = "";

  for (const item of items) {
    const type = (item as { type?: string }).type ?? "";

    switch (type) {
      case "message": {
        const role = (item as { role?: string }).role;
        const chatRole = role === "assistant" ? "assistant"
          : role === "developer" || role === "system" ? "system"
          : "user";
        const content = contentPartsToChat((item as { content?: ResponsesContentPart[] | string }).content, chatRole);
        out.push({ role: chatRole, content });
        if (chatRole !== "assistant") pendingReasoning = "";
        continue;
      }
      case "reasoning": {
        const text = extractReasoningText(item);
        if (text) pendingReasoning = text;
        continue;
      }
      case "function_call": {
        const fc = item as { call_id: string; name: string; arguments?: string };
        const args = (fc.arguments ?? "").trim().length === 0 ? "{}" : fc.arguments!;
        const toolCall = {
          id: fc.call_id,
          type: "function" as const,
          function: { name: fc.name, arguments: args },
        };
        mergeToolCallIntoAssistant(out, toolCall, pendingReasoning);
        pendingReasoning = "";
        continue;
      }
      case "custom_tool_call": {
        // Custom tool calls arrive as {call_id, name, input}; rewrite to a
        // function_call-shaped assistant message so the upstream sees the same
        // tool-call invariant. Input is wrapped in {input: "..."}.
        const ct = item as { call_id: string; name: string; input?: string };
        const argObj = JSON.stringify({ input: ct.input ?? "" });
        const toolCall = {
          id: ct.call_id,
          type: "function" as const,
          function: { name: ct.name, arguments: argObj },
        };
        mergeToolCallIntoAssistant(out, toolCall, pendingReasoning);
        pendingReasoning = "";
        continue;
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        const fco = item as { call_id: string; output?: string };
        out.push({
          role: "tool",
          tool_call_id: fco.call_id,
          content: fco.output ?? "",
        });
        pendingReasoning = "";
        continue;
      }
      case "tool_search_call": {
        const tsc = item as { call_id?: string; arguments?: Record<string, unknown> | string };
        const argStr = typeof tsc.arguments === "string" ? tsc.arguments : JSON.stringify(tsc.arguments ?? {});
        const toolCall = {
          id: tsc.call_id ?? "",
          type: "function" as const,
          function: { name: "tool_search", arguments: argStr },
        };
        mergeToolCallIntoAssistant(out, toolCall, pendingReasoning);
        pendingReasoning = "";
        continue;
      }
      case "tool_search_output": {
        const tso = item as { call_id?: string; output?: unknown };
        out.push({
          role: "tool",
          tool_call_id: tso.call_id ?? "",
          content: typeof tso.output === "string" ? tso.output : JSON.stringify(tso.output ?? {}),
        });
        pendingReasoning = "";
        continue;
      }
      case "additional_tools":
        // Already absorbed into `tools[]` by the tools-walker; not a message.
        continue;
      default:
        // Unknown / hosted-only items (web_search_call, file_search_call, …)
        // have no Chat representation — skip them rather than emit a spurious
        // message between an assistant tool_calls and its reply.
        if (type !== "") pendingReasoning = "";
        continue;
    }
  }

  return out;
}

/**
 * Push (or merge into the previous assistant) an assistant tool-call message.
 * Parallel tool calls arrive as consecutive items and must share one assistant
 * message so the Chat schema accepts the following tool replies.
 */
function mergeToolCallIntoAssistant(
  out: OpenAIMessage[],
  toolCall: { id: string; type: "function"; function: { name: string; arguments: string } },
  reasoning: string,
): void {
  const last = out[out.length - 1];
  if (last && last.role === "assistant" && Array.isArray(last.tool_calls)) {
    last.tool_calls.push(toolCall);
    if (!last.reasoning_content && reasoning) last.reasoning_content = reasoning;
  } else {
    out.push({
      role: "assistant",
      content: null,
      tool_calls: [toolCall],
      ...(reasoning ? { reasoning_content: reasoning } : {}),
    });
  }
}

/** Extract reasoning text from a `reasoning` item (summary[] or content[]). */
function extractReasoningText(item: ResponsesInputItem): string {
  const r = item as { summary?: ResponsesContentPart[]; content?: ResponsesContentPart[] };
  const parts = Array.isArray(r.summary) && r.summary.length > 0 ? r.summary : r.content;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .filter((t) => t.length > 0)
    .join("\n");
}

/** Convert Responses content parts to a Chat `content` value (string or parts[]). */
function contentPartsToChat(
  content: ResponsesContentPart[] | string | undefined,
  role: string,
): string | OpenAIContentPart[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const textParts: string[] = [];
  const chatParts: OpenAIContentPart[] = [];
  let hasImage = false;
  for (const part of content) {
    if ((part.type === "input_text" || part.type === "output_text" || part.type === "text") && typeof part.text === "string") {
      if (part.text.length === 0) continue;
      textParts.push(part.text);
      chatParts.push({ type: "text", text: part.text });
    } else if (part.type === "input_image" || part.type === "image_url") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      if (!url) continue;
      hasImage = true;
      chatParts.push({ type: "image_url", image_url: { url } });
    }
  }
  // No image → collapse to plain string (cleaner for the upstream).
  if (!hasImage) return textParts.join("\n");
  // Non-user roles can't carry image_url in many upstreams — degrade to text.
  if (role !== "user") return textParts.join("\n");
  return chatParts;
}

// ─────────────────────────────────────────────
// Tools collection
// ─────────────────────────────────────────────

type RefSignal = (ref: "web_search" | "tool_search") => void;

/**
 * Walk a tool (possibly a namespace tree) and collect Chat-function tools.
 * Rejects on ambiguous namespace flatten collisions (sub2api rule).
 */
function collectTools(
  tool: ResponsesTool,
  namespacePrefix: string,
  out: OpenAIToolDefinition[],
  customToolNames: Set<string>,
  namespaceMap: Map<string, { namespace: string; name: string }>,
  convertibleToolNames: Set<string>,
  signal: RefSignal,
): void {
  const type = (tool as { type?: string }).type ?? "";

  if (type === "function") {
    const name = (tool as { name: string }).name;
    const flatName = namespacePrefix ? `${namespacePrefix}__${name}` : name;
    if (convertibleToolNames.has(flatName)) {
      throw new ToolTranslationError(`duplicate tool name after flattening: "${flatName}"`);
    }
    const t = tool as { description?: string; parameters?: Record<string, unknown> };
    out.push({
      type: "function",
      function: {
        name: flatName,
        ...(t.description ? { description: t.description } : {}),
        ...(t.parameters ? { parameters: t.parameters } : {}),
      },
    });
    convertibleToolNames.add(flatName);
    if (namespacePrefix) namespaceMap.set(flatName, { namespace: namespacePrefix, name });
    return;
  }

  if (type === "custom") {
    const name = (tool as { name: string }).name;
    const flatName = namespacePrefix ? `${namespacePrefix}__${name}` : name;
    if (convertibleToolNames.has(flatName)) {
      throw new ToolTranslationError(`duplicate tool name after flattening: "${flatName}"`);
    }
    const t = tool as { description?: string };
    out.push({
      type: "function",
      function: {
        name: flatName,
        ...(t.description ? { description: t.description } : {}),
        parameters: CUSTOM_TOOL_SCHEMA,
      },
    });
    convertibleToolNames.add(flatName);
    customToolNames.add(flatName);
    if (namespacePrefix) namespaceMap.set(flatName, { namespace: namespacePrefix, name });
    return;
  }

  if (type === "namespace") {
    const ns = (tool as { name: string }).name;
    const children = (tool as { tools?: ResponsesTool[]; children?: ResponsesTool[] }).tools
      ?? (tool as { children?: ResponsesTool[] }).children
      ?? [];
    const childPrefix = namespacePrefix ? `${namespacePrefix}__${ns}` : ns;
    for (const child of children) {
      collectTools(child, childPrefix, out, customToolNames, namespaceMap, convertibleToolNames, signal);
    }
    return;
  }

  if (type === "tool_search") {
    signal("tool_search");
    if (convertibleToolNames.has("tool_search")) return; // de-dup identical declarations
    out.push({
      type: "function",
      function: {
        name: "tool_search",
        description: "Search the available tool registry.",
        parameters: TOOL_SEARCH_PROXY_SCHEMA,
      },
    });
    convertibleToolNames.add("tool_search");
    return;
  }

  if (isWebSearchTool(tool)) {
    // Stripped here; handler intercepts via GLM MCP.
    signal("web_search");
    return;
  }

  if (isHostedTool(tool)) {
    // file_search, code_interpreter, computer_use_preview, image_generation, mcp — strip silently.
    return;
  }

  // Unknown tool type — pass through as a function if it carries a name+parameters, else drop.
  const maybeName = (tool as { name?: string }).name;
  const maybeParams = (tool as { parameters?: Record<string, unknown> }).parameters;
  if (typeof maybeName === "string" && maybeParams && typeof maybeParams === "object") {
    const flatName = namespacePrefix ? `${namespacePrefix}__${maybeName}` : maybeName;
    if (!convertibleToolNames.has(flatName)) {
      out.push({ type: "function", function: { name: flatName, parameters: maybeParams } });
      convertibleToolNames.add(flatName);
    }
  }
}

/**
 * Map a Responses `tool_choice` to a Chat `tool_choice`.
 * Returns `undefined` when the choice points to a stripped/non-convertible tool
 * (cc-switch rule: dropping tools must also drop their forced choice or the
 * upstream 400s on "tool_choice references unknown tool").
 */
function mapToolChoice(
  raw: ResponsesRequest["tool_choice"],
  convertible: Set<string>,
  hasToolSearch: boolean,
): OpenAIChatRequest["tool_choice"] {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") {
    // "auto" | "none" | "required" pass through verbatim.
    return raw as "auto" | "none" | "required";
  }
  if (typeof raw !== "object") return undefined;
  const obj = raw as { type?: string; name?: string; function?: { name?: string } };
  const type = obj.type ?? "";

  // String-typed choices like {type:"web_search"} must drop entirely (the tool was stripped).
  if (type === "web_search" || type === "web_search_preview") return undefined;
  if (type === "file_search" || type === "code_interpreter" || type === "computer_use_preview" || type === "image_generation" || type === "mcp") {
    return undefined;
  }

  if (type === "tool_search") {
    // Forced tool_search maps to a forced function choice on the proxy.
    return hasToolSearch ? { type: "function", function: { name: "tool_search" } } : undefined;
  }

  if (type === "custom" || type === "function") {
    const name = obj.name ?? obj.function?.name;
    if (typeof name !== "string" || name.length === 0) return undefined;
    // Drop if the named tool didn't survive conversion.
    if (!convertible.has(name)) return undefined;
    return { type: "function", function: { name } };
  }

  return undefined;
}

/** Thrown when a Responses request cannot be safely translated. */
export class ToolTranslationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolTranslationError";
  }
}
