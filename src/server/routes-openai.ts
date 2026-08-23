/**
 * OpenAI-format route handlers: /v1/chat/completions + /v1/models.
 * @see .omo/plans/zcode-proxy.md Task 7
 */
import { proxyRequest, type ProxyHandlerOptions } from "../proxy/handler.js";
import type { ModelDef } from "../provider/types.js";
import { catalogContextWindow, reasoningModel } from "../translator/reasoning-effort.js";
import type { ProxyConfig } from "../config/types.js";
import type { OpenAIModelList } from "../translator/types.js";

/** Handle POST /v1/chat/completions — forward OpenAI-compatible chat requests upstream. */
export async function handleChatCompletions(
  req: Request,
  opts: ProxyHandlerOptions,
): Promise<Response> {
  return proxyRequest(req, "openai", opts);
}

/** Handle GET /v1/models with protocol-specific capability discovery. */
export function handleListModels(req: Request, config: ProxyConfig): Response {
  const models = config.models
    .map((id) => ({ id, definition: reasoningModel(id) }))
    .filter((model): model is { id: string; definition: ModelDef } => model.definition !== undefined);
  const url = new URL(req.url);

  if (url.searchParams.has("client_version")) {
    return jsonResponse({ models: models.map(({ id, definition }) => codexModel(id, definition)) });
  }
  if (req.headers.has("anthropic-version")) {
    return anthropicModelsResponse(url, models);
  }

  const list: OpenAIModelList = {
    object: "list",
    data: config.models.map((id) => ({ id, object: "model" as const, owned_by: "zcode-proxy" })),
  };
  return jsonResponse(list);
}

function codexModel(id: string, model: ModelDef): Record<string, unknown> {
  const efforts = model.reasoningEfforts?.filter((effort) => effort !== "none") ?? [];
  return {
    slug: id,
    display_name: model.name,
    description: model.name,
    default_reasoning_level: model.defaultReasoningEffort ?? "max",
    supported_reasoning_levels: efforts.map((effort) => ({ effort, description: `${effort} reasoning` })),
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: 0,
    base_instructions: "",
    supports_reasoning_summaries: model.reasoning === true,
    default_reasoning_summary: "none",
    support_verbosity: false,
    apply_patch_tool_type: "freeform",
    truncation_policy: { mode: "bytes", limit: 10_000 },
    context_window: catalogContextWindow(id, model),
    max_context_window: catalogContextWindow(id, model),
    effective_context_window_percent: 95,
    supports_parallel_tool_calls: true,
    experimental_supported_tools: [],
    input_modalities: model.inputModalities ?? ["text"],
  };
}

function anthropicModel(id: string, model: ModelDef): Record<string, unknown> {
  const acceptedEfforts = new Set(Object.keys(model.reasoningEffortMap ?? {}));
  const supported = (effort: "low" | "medium" | "high" | "max") => ({
    supported: acceptedEfforts.has(effort),
  });
  return {
    id,
    type: "model",
    display_name: model.name,
    created_at: "1970-01-01T00:00:00Z",
    max_input_tokens: catalogContextWindow(id, model),
    max_tokens: model.maxOutputTokens ?? catalogContextWindow(id, model),
    capabilities: {
      batch: { supported: false },
      citations: { supported: false },
      code_execution: { supported: false },
      context_management: {
        supported: false,
        clear_thinking_20251015: { supported: false },
        clear_tool_uses_20250919: { supported: false },
        compact_20260112: { supported: false },
      },
      effort: {
        supported: acceptedEfforts.size > 0,
        low: supported("low"),
        medium: supported("medium"),
        high: supported("high"),
        max: supported("max"),
      },
      image_input: { supported: model.inputModalities?.includes("image") === true },
      pdf_input: { supported: false },
      structured_outputs: { supported: false },
      thinking: {
        supported: model.reasoning === true,
        types: {
          enabled: { supported: model.reasoning === true },
          adaptive: { supported: false },
        },
      },
    },
  };
}

function anthropicModelsResponse(
  url: URL,
  models: Array<{ id: string; definition: ModelDef }>,
): Response {
  const limitValue = url.searchParams.get("limit");
  const limit = limitValue === null ? 20 : Number(limitValue);
  const after = url.searchParams.get("after_id");
  const before = url.searchParams.get("before_id");
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000 || (after && before)) {
    return jsonError(400, "invalid pagination parameters");
  }

  let start = 0;
  let end = models.length;
  if (after) {
    const index = models.findIndex((model) => model.id === after);
    if (index < 0) return jsonError(400, `unknown after_id: ${after}`);
    start = index + 1;
  }
  if (before) {
    const index = models.findIndex((model) => model.id === before);
    if (index < 0) return jsonError(400, `unknown before_id: ${before}`);
    end = index;
  }

  const remaining = models.slice(start, end);
  const page = before ? remaining.slice(-limit) : remaining.slice(0, limit);
  const data = page.map(({ id, definition }) => anthropicModel(id, definition));
  return jsonResponse({
    data,
    first_id: page[0]?.id ?? null,
    last_id: page.at(-1)?.id ?? null,
    has_more: remaining.length > page.length,
  });
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
