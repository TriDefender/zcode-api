/**
 * OpenAI-format route handlers: /v1/chat/completions + /v1/models.
 * @see .omo/plans/zcode-proxy.md Task 7
 */
import { proxyRequest, errorResponse, type ProxyHandlerOptions } from "../proxy/handler.js";
import { MODELS, getModel } from "../provider/models.js";
import type { OpenAIModelList } from "../translator/types.js";
import type { ModelDef } from "../provider/types.js";

const MODEL_CREATED_TIMESTAMP = 1_700_000_000;

const GLM52_REASONING_EFFORTS = [
  { reasoningEffort: "minimal", description: "Minimal reasoning" },
  { reasoningEffort: "low", description: "Fastest responses" },
  { reasoningEffort: "medium", description: "Balanced speed and quality" },
  { reasoningEffort: "high", description: "Deeper reasoning" },
  { reasoningEffort: "xhigh", description: "Maximum reasoning depth" },
];

/** Codex-compatible model metadata (GET /v1/models/:id/info). */
export interface CodexModelInfo {
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
  defaultReasoningEffort: string;
  inputModalities: string[];
  outputModalities: string[];
  supportsPersonality: boolean;
  upgrade: string | null;
  contextWindow?: number;
  maxContextWindow?: number;
  maxOutputTokens?: number;
}

function toCodexModelInfo(model: ModelDef, isDefault = false): CodexModelInfo {
  const reasoningEfforts =
    model.id === "glm-5.2" && model.reasoning
      ? GLM52_REASONING_EFFORTS
      : model.reasoning
        ? [
            { reasoningEffort: "low", description: "Fastest responses" },
            { reasoningEffort: "medium", description: "Balanced speed and quality" },
            { reasoningEffort: "high", description: "Deepest reasoning" },
          ]
        : [{ reasoningEffort: "low", description: "Fastest responses" }];

  return {
    id: model.id,
    displayName: model.name,
    description: `${model.name} via zcode-proxy`,
    isDefault,
    supportedReasoningEfforts: reasoningEfforts,
    defaultReasoningEffort: model.id === "glm-5.2" ? "medium" : model.reasoning ? "medium" : "low",
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportsPersonality: false,
    upgrade: null,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    maxContextWindow: model.contextWindow,
  };
}

/** Handle POST /v1/chat/completions — forward to upstream OpenAI endpoint. */
export async function handleChatCompletions(
  req: Request,
  opts: ProxyHandlerOptions,
): Promise<Response> {
  return proxyRequest(req, "openai", opts);
}

/** Handle GET /v1/models — return the model list in OpenAI format. */
export function handleListModels(): Response {
  const list: OpenAIModelList = {
    object: "list",
    data: MODELS.map((m) => ({
      id: m.id,
      object: "model" as const,
      created: MODEL_CREATED_TIMESTAMP,
      owned_by: "zcode-proxy",
    })),
  };
  return new Response(JSON.stringify(list), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Handle GET /v1/models/catalog — full Codex model catalog. */
export function handleListModelCatalog(): Response {
  const catalog = MODELS.map((m) => ({
    ...toCodexModelInfo(m, m.id === "glm-5.2"),
    outputModalities: ["text"],
    source: "static" as const,
  }));
  return new Response(JSON.stringify(catalog), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Handle GET /v1/models/:modelId — single model in OpenAI format. */
export function handleGetModel(modelId: string): Response {
  const model = getModel(modelId);
  if (!model) {
    return errorResponse(404, "model_not_found", `Model '${modelId}' not found`);
  }
  return new Response(JSON.stringify({
    id: model.id,
    object: "model",
    created: MODEL_CREATED_TIMESTAMP,
    owned_by: "zcode-proxy",
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Handle GET /v1/models/:modelId/info — extended metadata for Codex. */
export function handleGetModelInfo(modelId: string): Response {
  const model = getModel(modelId);
  if (!model) {
    return new Response(JSON.stringify({ error: `Model '${modelId}' not found` }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  const isDefault = model.id === "glm-5.2";
  return new Response(JSON.stringify(toCodexModelInfo(model, isDefault)), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
