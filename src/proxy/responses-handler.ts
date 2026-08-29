/**
 * POST /v1/responses request handler.
 *
 * Pipeline:
 *   1. Parse body + credential.
 *   2. Resolve `previous_response_id` via `ResponseStore` (prepend stored history).
 *   3. Translate Responses → Chat Completions (`responsesToChatCompletions`):
 *        - function / custom / namespace / tool_search tools → Chat tools.
 *        - web_search / web_search_preview / file_search / code_interpreter /
 *          computer_use / image_generation / mcp → stripped silently.
 *   4. Apply the standard body transform (stream_options, user_id, start-plan system).
 *   5. POST to the GLM Chat Completions upstream (reuse `buildUpstreamRequest`).
 *   6. Translate the Chat response → Responses (`chatCompletionsToResponses`
 *      or `chatChunkToResponsesEvents` for streaming).
 *   7. Store the new response under its id (unless `store:false`).
 *
 * State management: in-memory only (process restart clears the store); see
 * `responses/store.ts`.
 */
import { transformRequestBody } from "./body-transformer.js";
import { getProvider } from "../provider/providers.js";
import type { ProxyConfig } from "../config/types.js";
import type { AuthManager } from "../auth/manager.js";
import { buildUpstreamRequest, buildUpstreamHeaderPairs } from "./upstream.js";
import { getDefaultEndpointRouting, type EndpointRoutingService } from "./endpoint-routing.js";
import { getDefaultClientSigning, sendWithClientSigning, type ClientSigningManager } from "./client-signing.js";
import { credentialString } from "../auth/types.js";
import { translateRequestOpenAIToAnthropic, translateResponseAnthropicToOpenAI } from "../translator/openai-to-anthropic.js";
import { anthropicSseToOpenaiSse } from "../translator/sse-translator.js";
import type { AnthropicMessagesRequest, AnthropicMessagesResponse } from "../translator/types.js";
import type { ProviderDef } from "../provider/types.js";
import {
  responsesToChatCompletions,
  ToolTranslationError,
} from "../translator/responses-to-chat.js";
import {
  chatCompletionsToResponses,
  chatChunkToResponsesEvents,
  finalizeResponsesStream,
  newResponsesStreamState,
  responsesEventToSse,
} from "../translator/chat-to-responses.js";
import {
  generateResponsesId,
  type ResponsesInputItem,
  type ResponsesRequest,
  type ResponsesResponse,
  type ResponsesStreamEvent,
  type ResponsesOutputItem,
} from "../translator/responses-types.js";
import { ResponseStore, type StoredResponse } from "../responses/store.js";
import { errorResponse, readBody, InflatedBodyTooLargeError } from "./handler.js";

export interface ResponsesHandlerOptions {
  config: ProxyConfig;
  auth: AuthManager;
  /** Response store; if absent, `previous_response_id` always 404s. */
  responseStore?: ResponseStore;
  /** DI seam for tests. */
  fetchImpl?: typeof fetch;
  /** Verbose per-request diagnostics. */
  debug?: boolean;
  /** Override the process-wide endpoint routing service (for testing). `null` disables. */
  endpointRouting?: EndpointRoutingService | null;
  /** Override the process-wide client signing manager (for testing). `null` disables. */
  clientSigning?: ClientSigningManager | null;
}

/** Handle POST /v1/responses. */
export async function handleResponses(
  clientReq: Request,
  opts: ResponsesHandlerOptions,
): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const debug = opts.debug === true;
  const start = Date.now();

  // ── 1. parse body ──
  let rawBody: string;
  try {
    rawBody = (await readBody(clientReq)) ?? "";
  } catch (err) {
    if (err instanceof InflatedBodyTooLargeError) {
      return errorResponse(413, "request_too_large", err.message);
    }
    return errorResponse(400, "invalid_request", `could not read request body: ${(err as Error).message}`);
  }
  let req: ResponsesRequest;
  try {
    req = JSON.parse(rawBody) as ResponsesRequest;
  } catch (err) {
    return errorResponse(400, "invalid_request", `request body is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof req.input !== "string" && !Array.isArray(req.input)) {
    return errorResponse(400, "invalid_request", "`input` must be a string or an array");
  }
  if (typeof req.model !== "string" || req.model.length === 0) {
    return errorResponse(400, "invalid_request", "`model` is required");
  }

  const stream = req.stream === true;

  // ── 2. resolve previous_response_id ──
  let historyItems: ResponsesInputItem[] = [];
  let prevId: string | undefined;
  if (typeof req.previous_response_id === "string" && req.previous_response_id.length > 0) {
    if (!opts.responseStore) {
      return errorResponse(404, "response_store_disabled", "`previous_response_id` was supplied but the response store is not configured");
    }
    const prev = opts.responseStore.get(req.previous_response_id);
    if (!prev) {
      return errorResponse(404, "response_not_found", `previous_response_id ${req.previous_response_id} not found (response store is in-memory; entries are lost on restart and after the TTL)`);
    }
    prevId = req.previous_response_id;
    historyItems = [...prev.input, ...outputItemsAsInputItems(prev.output)];
  }

  // ── 3. translate Responses → Chat Completions ──
  const input: ResponsesInputItem[] = typeof req.input === "string"
    ? [...historyItems, { type: "message", role: "user", content: req.input }]
    : [...historyItems, ...req.input];
  const reqWithHistory: ResponsesRequest = {
    ...req,
    input,
  };
  let translated;
  try {
    translated = responsesToChatCompletions(reqWithHistory);
  } catch (err) {
    if (err instanceof ToolTranslationError) {
      return errorResponse(400, "tool_translation_error", err.message);
    }
    throw err;
  }
  const { chatRequest, customToolNames, namespaceMap, hasToolSearch } = translated;

  // ── 4. credential + provider ──
  let cred;
  try {
    cred = await opts.auth.getCredential();
  } catch (err) {
    return errorResponse(503, "credential_unavailable", (err as Error).message);
  }
  const providerDef = resolveProviderDef(opts.config);

  // ── 5. body transform (start-plan system / anthropic cache_control + user_id) ──
  // Both plans post Anthropic upstream (mirrors handler.ts): the start-plan
  // OpenAI gateway was retired server-side (404 as of 2026-08-28), so the
  // Responses → Chat → Anthropic translator chain runs unconditionally.
  const startPlan = opts.config.plan === "start-plan";
  const upstreamFormat: "openai" | "anthropic" = "anthropic";
  let upstreamRequestBody: string;
  {
    let anthropicReq: AnthropicMessagesRequest;
    try {
      anthropicReq = translateRequestOpenAIToAnthropic(chatRequest);
    } catch (err) {
      return errorResponse(400, "translation_failed", `Chat→Anthropic translation failed: ${(err as Error).message}`);
    }
    upstreamRequestBody = transformRequestBody(JSON.stringify(anthropicReq), {
      format: "anthropic",
      userId: cred.userId,
      startPlan,
    }) ?? JSON.stringify(anthropicReq);
  }
  const transformedBody = upstreamRequestBody;

  // ── 6. POST upstream ──
  const upstreamHeaders = buildUpstreamHeaderPairs(clientReq, upstreamFormat, cred, opts.config.identity, opts.config.plan, undefined, undefined);
  const upstreamReq = buildUpstreamRequest(clientReq, upstreamFormat, providerDef, cred, transformedBody, opts.config.identity, opts.config.plan, undefined, undefined);
  if (debug) console.log(`[responses] → POST ${upstreamReq.url}`);

  let upstreamResp: Response;
  try {
    const routing = opts.endpointRouting !== undefined ? opts.endpointRouting : getDefaultEndpointRouting(opts.config);
    const routed = routing ? await routing.resolve(upstreamReq.url, credentialString(cred)) : null;
    const sendUrl = routed?.routed ? routed.url : upstreamReq.url;
    if (debug && routed?.routed) console.log(`[responses] endpoint routing: ${upstreamReq.url} -> ${sendUrl}`);
    const signer = opts.clientSigning !== undefined ? opts.clientSigning : getDefaultClientSigning(opts.config);
    // signing decisions run against the PRE-routing provider URL (mirrors the
    // client, whose signer wraps the routing transport)
    upstreamResp = await sendWithClientSigning(signer, {
      url: upstreamReq.url,
      headerPairs: upstreamHeaders,
      credential: credentialString(cred),
      appVersion: opts.config.identity.appVersion,
      debug: debug ? (message) => console.log(`[responses] ${message}`) : undefined,
      send: (finalPairs) => {
        const req = new Request(sendUrl, {
          method: "POST",
          headers: Object.fromEntries(finalPairs),
          body: transformedBody ?? undefined,
        });
        return fetchImpl(req, { method: "POST", headers: Object.fromEntries(finalPairs), body: transformedBody ?? undefined, signal: clientReq.signal });
      },
    });
  } catch (err) {
    return errorResponse(502, "upstream_unreachable", (err as Error).message);
  }

  if (!upstreamResp.ok) {
    const errText = await upstreamResp.text().catch(() => "");
    return errorResponse(upstreamResp.status, "upstream_error", errText.slice(0, 500) || `upstream returned ${upstreamResp.status}`);
  }

  if (upstreamFormat === "anthropic") {
    // normalize the Anthropic upstream response into the OpenAI Chat shape the
    // downstream Responses translators already consume (SSE + batch)
    if (stream) {
      if (!upstreamResp.body) {
        return errorResponse(502, "translation_failed", "upstream returned no body for stream");
      }
      upstreamResp = new Response(anthropicSseToOpenaiSse(upstreamResp.body, req.model), {
        status: upstreamResp.status,
        headers: { "content-type": "text/event-stream" },
      });
    } else {
      const rawAnthropic = await upstreamResp.text();
      let parsedAnthropic: AnthropicMessagesResponse;
      try {
        parsedAnthropic = JSON.parse(rawAnthropic) as AnthropicMessagesResponse;
      } catch (err) {
        return errorResponse(502, "translation_failed", `upstream returned non-JSON body: ${(err as Error).message}`);
      }
      const openaiResp = translateResponseAnthropicToOpenAI(parsedAnthropic, req.model);
      upstreamResp = new Response(JSON.stringify(openaiResp), {
        status: upstreamResp.status,
        headers: { "content-type": "application/json" },
      });
    }
  }

  // ── 8. translate Chat → Responses ──
  const responseId = generateResponsesId();
  const meta = { customToolNames, namespaceMap, hasToolSearch };

  if (stream) {
    return streamResponse(upstreamResp, { responseId, model: req.model, meta, request: req, input, options: opts });
  }

  const rawChatResp = await upstreamResp.text();
  let chatRespJson;
  try {
    chatRespJson = JSON.parse(rawChatResp);
  } catch (err) {
    return errorResponse(502, "translation_failed", `upstream returned non-JSON body: ${(err as Error).message}`);
  }
  const responsesResp = chatCompletionsToResponses(chatRespJson, req.model, {
    responseId,
    meta,
    ...(typeof req.instructions === "string" ? { instructions: req.instructions } : {}),
    ...(prevId ? { previousResponseId: prevId } : {}),
  });

  // ── 9. store the response (unless `store:false`) ──
  if (req.store !== false && opts.responseStore) {
    const stored = buildStoredResponse(responsesResp, input, req.instructions);
    opts.responseStore.set(stored);
  }

  if (debug) console.log(`[responses] ← ${responsesResp.status} (${Date.now() - start}ms)`);

  return new Response(JSON.stringify(responsesResp), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// ─────────────────────────────────────────────
// Streaming response
// ─────────────────────────────────────────────

interface StreamResponseContext {
  responseId: string;
  model: string;
  meta: { customToolNames: Set<string>; namespaceMap: Map<string, { namespace: string; name: string }>; hasToolSearch: boolean };
  request: ResponsesRequest;
  input: ResponsesInputItem[];
  options: ResponsesHandlerOptions;
}

function streamResponse(upstreamResp: Response, context: StreamResponseContext): Response {
  if (!upstreamResp.body) {
    return errorResponse(502, "translation_failed", "upstream returned no body for stream");
  }
  const state = newResponsesStreamState(context.model, { meta: context.meta, responseId: context.responseId });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (evt: ResponsesStreamEvent) => controller.enqueue(encoder.encode(responsesEventToSse(evt)));
      try {
        const reader = upstreamResp.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let errored = false;
        for (;;) {
          if (errored) break;
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // SSE chunks are separated by `\n\n`; process complete frames.
          let nl: number;
          while ((nl = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 2);
            const dataLine = extractSseData(frame);
            if (!dataLine || dataLine === "[DONE]") continue;
            try {
              const chunk = JSON.parse(dataLine);
              for (const evt of chatChunkToResponsesEvents(chunk, state)) send(evt);
            } catch (err) {
              errored = true;
              controller.error(err);
              return;
            }
          }
        }
        const finalEvents = finalizeResponsesStream(state);
        for (const evt of finalEvents) send(evt);
        const finalEvent = finalEvents.find((evt) => evt.type === "response.completed" || evt.type === "response.incomplete");
        if (finalEvent && context.request.store !== false && context.options.responseStore) {
          context.options.responseStore.set(buildStoredResponse(finalEvent.response, context.input, context.request.instructions));
        }
        try { controller.close(); } catch {}
      } catch (err) {
        try { controller.error(err); } catch {}
      }
    },
    cancel(reason) {
      context.options.debug === true && console.log(`[responses] stream cancelled: ${String(reason)}`);
      try { upstreamResp.body?.cancel(); } catch {}
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

function extractSseData(frame: string): string | null {
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("data:")) return line.slice(5).replace(/^\s/, "");
  }
  return null;
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function resolveProviderDef(config: ProxyConfig): ProviderDef & { openaiBaseURL: string; anthropicBaseURL: string } {
  const base = getProvider(config.provider);
  const endpoints = config.providers[config.provider];
  return {
    ...base,
    anthropicBaseURL: endpoints.anthropicBase,
    openaiBaseURL: endpoints.openaiBase,
  };
}

/**
 * Cast stored output items back into input items so the next turn's history is
 * a flat list the translator can walk. Responses output and input item shapes
 * overlap enough that a structural cast is sound (the fields we read — `type`,
 * `call_id`, `name`, `arguments`, `content`, `role` — are shared).
 */
function outputItemsAsInputItems(outputs: ResponsesOutputItem[]): ResponsesInputItem[] {
  return outputs as unknown as ResponsesInputItem[];
}

function buildStoredResponse(
  resp: ResponsesResponse,
  input: ResponsesInputItem[],
  instructions: string | undefined,
): StoredResponse {
  return {
    id: resp.id,
    model: resp.model,
    status: (resp.status === "completed" || resp.status === "incomplete" || resp.status === "failed" ? resp.status : "completed"),
    input,
    output: resp.output,
    usage: resp.usage,
    instructions,
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
  };
}
