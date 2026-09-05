/**
 * OpenAI-format route handlers: /v1/chat/completions + /v1/models.
 * @see .omo/plans/zcode-proxy.md Task 7
 */
import { proxyRequest, type ProxyHandlerOptions } from "../proxy/handler.js";
import { MODELS } from "../provider/models.js";
import type { OpenAIModelList } from "../translator/types.js";

/** Handle POST /v1/chat/completions — forward OpenAI-compatible chat requests upstream. */
export async function handleChatCompletions(
  req: Request,
  opts: ProxyHandlerOptions,
): Promise<Response> {
  return proxyRequest(req, "openai", opts);
}

/** Handle GET /v1/models — return the model list in OpenAI format. */
export function handleListModels(req: Request): Response {
  // CLIProxyAPI-style rich catalog: DSH's better-basicfun synchronizer probes
  // with ?client_version=pi and parses a top-level `models[]` array with
  // slug/context_window/max_tokens/supported_reasoning_levels fields. A plain
  // OpenAI request keeps the original `data[]` shape.
  const clientVersion = new URL(req.url).searchParams.get("client_version");
  if (clientVersion === "pi") {
    const body = {
      object: "list",
      models: MODELS.map((m) => ({
        slug: m.id,
        display_name: m.name,
        description: m.name,
        context_window: m.contextWindow,
        max_context_window: m.contextWindow,
        ...(m.maxOutputTokens === undefined ? {} : { max_tokens: m.maxOutputTokens }),
        input_modalities: m.id.includes("v") ? ["text", "image"] : ["text"],
        supported_reasoning_levels: m.reasoning
          ? [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }]
          : [],
        visibility: "list",
      })),
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  const list: OpenAIModelList = {
    object: "list",
    data: MODELS.map((m) => ({
      id: m.id,
      object: "model" as const,
      owned_by: "zcode-proxy",
    })),
  };
  return new Response(JSON.stringify(list), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
