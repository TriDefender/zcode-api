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
import { buildUpstreamRequest, buildUpstreamHeaderPairs, type UpstreamHeaderPair } from "./upstream.js";
import { isCaptchaChallenged, retryOnCaptchaChallenge, resolveCaptchaAcquireBudgetMs, acquireCaptchaWithRetry, type CaptchaModuleLike } from "./captcha-retry.js";

// Lazy, runtime-gated module load (exception to the static-import rule, same
// as handler.ts): pulling captcha.ts eagerly drags in the happy-dom solver, so
// only start-plan — the one plan whose upstream is captcha-gated — pays for it.
type CaptchaModule = CaptchaModuleLike;
let captchaModule: CaptchaModule | null = null;
async function loadCaptcha(): Promise<CaptchaModule> {
  if (!captchaModule) captchaModule = await import("./captcha.js");
  return captchaModule;
}
import { getDefaultEndpointRouting, type EndpointRoutingService } from "./endpoint-routing.js";
import { getDefaultClientSigning, sendWithClientSigning, type ClientSigningManager } from "./client-signing.js";
import { resolveSessionContext } from "./session-context.js";
import {
  applyHighspeedCardHeaders,
  getDefaultHighspeedManager,
  highspeedAuthFrom,
  isHighspeedCardRejection,
  rewriteBodyModel,
  type HighspeedAuth,
  type HighspeedCard,
  type HighspeedManager,
} from "../highspeed/manager.js";
import { resolvedHighspeedLlmUrl } from "../highspeed/provider-config.js";
import { buildAnthropicMetadataUserId } from "./trace-headers.js";
import { credentialString } from "../auth/types.js";
import { translateRequestOpenAIToAnthropic, translateResponseAnthropicToOpenAI } from "../translator/openai-to-anthropic.js";
import { anthropicSseToOpenaiSse, AnthropicStreamError } from "../translator/sse-translator.js";
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
  failResponsesStream,
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
import {
  dispatchWithConnectRetry,
  errorResponse,
  isAnthropicMessagesResponse,
  nextReqId,
  observeStream,
  printRow,
  readBody,
  InflatedBodyTooLargeError,
  type RequestMeta,
} from "./handler.js";
import { dumpBody, dumpEnabled, dumpHeaders, dumpPhase } from "./dump.js";

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
  /** Override the process-wide highspeed card manager (for testing). `null` disables. */
  highspeed?: HighspeedManager | null;
  /** Override the lazily-imported captcha module (for testing). */
  captcha?: CaptchaModule;
}

/** Handle POST /v1/responses. */
export async function handleResponses(
  clientReq: Request,
  opts: ResponsesHandlerOptions,
): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const debug = opts.debug === true;
  const start = Date.now();
  const reqId = nextReqId();

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
  if (dumpEnabled()) {
    dumpPhase(reqId, "client_in", {
      method: clientReq.method,
      url: clientReq.url,
      headers: dumpHeaders(clientReq.headers),
      body: dumpBody(rawBody),
    });
  }
  let req: ResponsesRequest;
  try {
    req = JSON.parse(rawBody) as ResponsesRequest;
  } catch (err) {
    return errorResponse(400, "invalid_request", `request body is not valid JSON: ${(err as Error).message}`);
  }
  if (!req || typeof req !== "object" || Array.isArray(req)) {
    return errorResponse(400, "invalid_request", "request body must be an object");
  }
  if (typeof req.input !== "string" && !Array.isArray(req.input)) {
    return errorResponse(400, "invalid_request", "`input` must be a string or an array");
  }
  if (typeof req.model !== "string" || req.model.length === 0) {
    return errorResponse(400, "invalid_request", "`model` is required");
  }

  const stream = req.stream === true;
  const meta: RequestMeta = { model: req.model, stream };

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
    printRow(reqId, "openai", meta, 503, start, Date.now(), 0, 0, 0, "RSP");
    return errorResponse(503, "credential_unavailable", (err as Error).message);
  }
  const providerDef = resolveProviderDef(opts.config);

  // ── 5. body transform (start-plan system / anthropic cache_control + user_id) ──
  // Both plans post Anthropic upstream (mirrors handler.ts): the start-plan
  // OpenAI gateway was retired server-side (404 as of 2026-08-28), so the
  // Responses → Chat → Anthropic translator chain runs unconditionally.
  const startPlan = opts.config.plan === "start-plan";
  const upstreamFormat: "openai" | "anthropic" = "anthropic";
  let anthropicReq: AnthropicMessagesRequest;
  try {
    anthropicReq = translateRequestOpenAIToAnthropic(chatRequest);
  } catch (err) {
    return errorResponse(400, "translation_failed", `Chat→Anthropic translation failed: ${(err as Error).message}`);
  }
  const anthropicBody = JSON.stringify(anthropicReq);
  // Session affinity 收口（2026-10-14，与 handler.ts 同构）：在转换后的
  // anthropic 侧计算，同一逻辑对话与 /v1/messages 得到同构的会话身份——
  // trace 头、metadata.user_id 与 highspeed task_id 共用该结果。
  const clientSession = resolveSessionContext({ clientReq, body: anthropicBody, traceBody: rawBody, upstreamFormat: "anthropic", model: req.model, config: opts.config });
  // userId mirrors handler.ts for BOTH plans: the bundle's `E2e` is
  // provider-kind gated only (never plan-gated), so start-plan carries the
  // same device/session blob as coding-plan.
  const metadataUserId = buildAnthropicMetadataUserId(opts.config.identity.deviceMid, clientSession?.sessionId);
  let transformedBody = transformRequestBody(anthropicBody, {
    format: "anthropic",
    metadataUserId,
    startPlan,
    provider: opts.config.provider,
  }) ?? anthropicBody;

  // ── HighSpeed 加速卡（2026-10-14 接线，与 handler.ts 同构）──
  // coding-plan + 合格模型：抽卡触发（task_id=upstreamSessionId，会话模型如
  // glm-5.3）；抽中挂卡后改写模型为卡上模型、换装 JWT 鉴权套装并 reroute 到
  // highspeed 专属推理端点（`HighspeedManager.llmUrl`（`highspeedLlmUrl()`），
  // 2026-11-09 补齐）；挂卡请求永不签名（官方静态规则）。
  const highspeedManager = opts.highspeed !== undefined ? opts.highspeed : getDefaultHighspeedManager(opts.config);
  let highspeedCard: HighspeedCard | undefined;
  let highspeedAuth: HighspeedAuth | undefined;
  let highspeedOrigBody: string | undefined;
  let highspeedOrigPairs: UpstreamHeaderPair[] | undefined;
  let highspeedUpstreamUrl: string | undefined;
  if (highspeedManager && !startPlan && highspeedManager.isEligibleModel(req.model) && transformedBody) {
    const hsAuth = highspeedAuthFrom(cred);
    if (hsAuth) {
      highspeedAuth = hsAuth;
      highspeedManager.onRequest(req.model, clientSession?.upstreamSessionId, hsAuth);
      const card = highspeedManager.activeCardFor(req.model);
      if (card) {
        highspeedOrigBody = transformedBody;
        transformedBody = rewriteBodyModel(transformedBody, card.model);
        highspeedCard = card;
        // remote provider-config snapshot overrides the pinned default (CDN
        // hot-update chain, provider-config.ts); sync read, fail-open default
        highspeedUpstreamUrl = resolvedHighspeedLlmUrl(hsAuth.family) ?? highspeedManager.llmUrl;
      }
    }
  }

  // ── 6. POST upstream ──
  // start-plan gates every upstream call behind an Aliyun captcha token. The
  // Anthropic/OpenAI routes mint one in handler.ts; /v1/responses did not, so
  // start-plan users got {"code":3007,"msg":"captcha verify failed"} surfaced
  // as HTTP 400 upstream_error on every request.
  let captchaHeaders: Record<string, string> | undefined;
  if (startPlan) {
    // 与 handler.ts 同款严格获取（NOTEPAD "3.16.3 增补" §H）：裸发 captcha-less 会被
    // start-plane 边缘空体 502 间歇拦截；null=服务端明示禁用（无头即正确形态），
    // throw=有界重试（CAPTCHA_ACQUIRE_BUDGET_MS，默认 45s）后诚实 503。
    try {
      captchaHeaders = await acquireCaptchaWithRetry(async () => {
        const captcha = opts.captcha ?? (await loadCaptcha());
        const token = await captcha.getCaptchaToken(opts.config.identity.appVersion);
        return token ? { [captcha.RETRY_HEADERS.PARAM]: token.verifyParam, [captcha.RETRY_HEADERS.REGION]: token.region } : undefined;
      }, {
        budgetMs: resolveCaptchaAcquireBudgetMs(process.env.CAPTCHA_ACQUIRE_BUDGET_MS),
        signal: clientReq.signal,
      });
    } catch (err) {
      if (debug) console.log(`[responses] ERROR captcha_solver_failed: ${(err as Error).message}`);
      printRow(reqId, "openai", meta, 503, start, Date.now(), 0, 0, 0, "RSP");
      return errorResponse(503, "captcha_solver_failed", `Captcha acquisition failed: ${(err as Error).message}. The start-plan edge rejects captcha-less requests — retry shortly.`);
    }
  }
  // 在飞即活动（同 handler.ts，NOTEPAD "3.16.3 增补" §H）：流结束/请求完成刷新
  // captcha 池与 highspeed 抽卡循环的空闲窗——SSE 输出中不算空闲。highspeed 侧
  // 仅对合格请求记账（与上面 onRequest 同门），防止不合格流量空转抽卡循环。
  // Only requests that actually entered onRequest may extend its auth's loop.
  const hsNoteEligible = highspeedAuth !== undefined;
  const noteInFlightEnded = (): void => {
    if (startPlan) void (opts.captcha ? Promise.resolve(opts.captcha) : loadCaptcha()).then((m) => m.noteDemand?.()).catch(() => {});
    if (hsNoteEligible) highspeedManager?.noteActivity();
  };

  const upstreamHeaders = buildUpstreamHeaderPairs(clientReq, upstreamFormat, cred, opts.config.identity, opts.config.plan, captchaHeaders, clientSession);
  let wireHeaders = upstreamHeaders;
  if (highspeedCard && highspeedAuth) {
    highspeedOrigPairs = upstreamHeaders;
    wireHeaders = applyHighspeedCardHeaders(upstreamHeaders, highspeedCard, highspeedAuth);
  }
  const upstreamReq = buildUpstreamRequest(clientReq, upstreamFormat, providerDef, cred, transformedBody, opts.config.identity, opts.config.plan, captchaHeaders, clientSession);
  // Carded requests reroute to the dedicated highspeed inference endpoint
  // (manager.llmUrl; mirrors handler.ts — the official `account:*-highspeed-card`
  // providers pin {origin}/api/v1/highspeed/anthropic, and routing has no
  // from→to entry for it → passes through unchanged). The 401/3402 fallback
  // below restores the provider URL.
  let upstreamUrl = highspeedUpstreamUrl ?? upstreamReq.url;
  if (debug) console.log(`[responses] → POST ${upstreamUrl}`);
  if (dumpEnabled()) {
    dumpPhase(reqId, "upstream_out", {
      method: "POST",
      url: upstreamUrl,
      headers: dumpHeaders(new Headers(Object.fromEntries(wireHeaders))),
      body: dumpBody(transformedBody),
      upstreamFormat,
      translateMode: true,
      startPlan,
    });
  }

  const routing = opts.endpointRouting !== undefined ? opts.endpointRouting : getDefaultEndpointRouting(opts.config);
  // 官方 3.15.1 静态规则：highspeed mode 的推理请求永不签名（`TUs` 返回 false）。
  let signer = highspeedCard ? null : (opts.clientSigning !== undefined ? opts.clientSigning : getDefaultClientSigning(opts.config));
  const dispatch = async (pairs: UpstreamHeaderPair[]): Promise<Response> => {
    const routed = routing ? await routing.resolve(upstreamUrl, credentialString(cred), cred.jwt) : null;
    const sendUrl = routed?.routed ? routed.url : upstreamUrl;
    const routingHeaderPairs = routed?.headers
      ? (Object.entries(routed.headers) as UpstreamHeaderPair[])
      : undefined;
    if (debug && routed?.routed) console.log(`[responses] endpoint routing: ${upstreamUrl} -> ${sendUrl}`);
    // signing decisions run against the PRE-routing provider URL (mirrors the
    // client, whose signer wraps the routing transport)
    return sendWithClientSigning(signer, {
      url: upstreamUrl,
      headerPairs: pairs,
      credential: credentialString(cred),
      oauthAccessToken: cred.oauthAccessToken,
      provider: cred.provider,
      appVersion: opts.config.identity.appVersion,
      debug: debug ? (message) => console.log(`[responses] ${message}`) : undefined,
      send: (finalPairs) => {
        // 3.16.2 X-ZCode-Authorization rides after the signature block (the
        // client's routing wrapper sits inside its signing wrapper) — last on
        // the wire, same as handler.ts.
        const outboundPairs = routingHeaderPairs ? [...finalPairs, ...routingHeaderPairs] : finalPairs;
        if (dumpEnabled()) {
          // what actually went on the wire: routed URL + signed pairs (mirrors
          // handler.ts — the pre-routing/pre-signing view is `upstream_out`)
          dumpPhase(reqId, "wire_out", {
            url: sendUrl,
            signed: outboundPairs.some(([k]) => k.toLowerCase() === "x-client-sig"),
            headers: dumpHeaders(new Headers(Object.fromEntries(outboundPairs))),
          });
        }
        const req = new Request(sendUrl, {
          method: "POST",
          headers: Object.fromEntries(outboundPairs),
          body: transformedBody ?? undefined,
        });
        return fetchImpl(req, { method: "POST", headers: Object.fromEntries(outboundPairs), body: transformedBody ?? undefined, signal: clientReq.signal });
      },
    });
  };

  let upstreamResp: Response;
  try {
    // Connect-retry ladder mirrors the chat hot path (handler.ts): 3 attempts,
    // fresh Request per dispatch (built inside `dispatch`), 500ms×attempt
    // backoff, no retry once the client aborted.
    upstreamResp = await dispatchWithConnectRetry(() => dispatch(wireHeaders), {
      isAborted: () => clientReq.signal.aborted,
    });
  } catch (err) {
    printRow(reqId, "openai", meta, 502, start, Date.now(), 0, 0, 0, "RSP");
    return errorResponse(502, "upstream_unreachable", (err as Error).message);
  }
  const headersAt = Date.now();
  if (debug) console.log(`[responses] ← ${upstreamResp.status} ${upstreamResp.statusText}`);
  if (dumpEnabled()) {
    dumpPhase(reqId, "upstream_in", {
      status: upstreamResp.status,
      statusText: upstreamResp.statusText,
      headers: dumpHeaders(upstreamResp.headers),
      isSSE: upstreamResp.headers.get("content-type")?.includes("text/event-stream") ?? false,
      ttfbMs: headersAt - start,
    });
  }

  // highspeed selectionFallback（官方语义，与 handler.ts 同构）：挂卡请求收到
  // 401 / biz 3402 → 弃卡 + 原模型 + 常规双头鉴权（恢复签名）重发一次。
  if (highspeedCard && highspeedAuth && highspeedOrigBody !== undefined && highspeedOrigPairs !== undefined
    && await isHighspeedCardRejection(upstreamResp)) {
    console.log("[responses] highspeed card rejected upstream — falling back to session model");
    highspeedManager?.dropCard("upstream_rejected");
    transformedBody = highspeedOrigBody;
    upstreamUrl = upstreamReq.url;
    signer = opts.clientSigning !== undefined ? opts.clientSigning : getDefaultClientSigning(opts.config);
    const retryPairs = highspeedOrigPairs;
    try {
      upstreamResp = await dispatchWithConnectRetry(() => dispatch(retryPairs), {
        isAborted: () => clientReq.signal.aborted,
      });
    } catch (err) {
      printRow(reqId, "openai", meta, 502, start, Date.now(), 0, 0, 0, "RSP");
      return errorResponse(502, "upstream_unreachable", (err as Error).message);
    }
  }

  // Captcha challenge retry (mirrors handler.ts via the shared captcha-retry
  // seam): the gateway signals it either through the captcha response header
  // or as HTTP 400 with {"code":3007} in the body. The challenged token is
  // already spent, so retry once with a fresh pooled one.
  if (startPlan && !upstreamResp.ok) {
    const captcha = opts.captcha ?? (await loadCaptcha());
    if (await isCaptchaChallenged(upstreamResp, captcha)) {
      if (debug) console.log("[responses] captcha challenge — re-solving and retrying once");
      const outcome = await retryOnCaptchaChallenge({
        captcha,
        appVersion: opts.config.identity.appVersion,
        challengedResp: upstreamResp,
        debug: debug ? (message) => console.log(`[responses] ${message}`) : undefined,
        solveAndRetry: (retryHeaders) => dispatch(
          buildUpstreamHeaderPairs(clientReq, upstreamFormat, cred, opts.config.identity, opts.config.plan, retryHeaders, clientSession),
        ),
        mapError: (err, phase) => {
          if (phase === "solver") {
            printRow(reqId, "openai", meta, 503, start, Date.now(), 0, 0, 0, "RSP");
            return errorResponse(503, "captcha_solver_failed", err.message);
          }
          printRow(reqId, "openai", meta, 502, start, Date.now(), 0, 0, 0, "RSP");
          return errorResponse(502, "upstream_unreachable", err.message);
        },
      });
      if (!outcome.ok) return outcome.resp;
      upstreamResp = outcome.resp;
    }
  }

  if (!upstreamResp.ok) {
    const errText = await upstreamResp.text().catch(() => "");
    printRow(reqId, "openai", meta, upstreamResp.status, start, headersAt, 0, 0, 0, "RSP");
    return errorResponse(upstreamResp.status, "upstream_error", errText.slice(0, 500) || `upstream returned ${upstreamResp.status}`);
  }

  // Effective streaming = the client asked for a stream AND the upstream
  // actually answered with SSE. A JSON answer to a stream request (HTTP 200
  // wrapped around a business envelope — start-plan quota `code:1005`, a
  // quota-dead highspeed card, …) takes the batch lane, where the
  // `isAnthropicMessagesResponse` guard turns it into an honest 502 instead of
  // feeding JSON to the SSE translator (2026-11-09 实弹: the envelope crashed
  // `resp.content.filter` in the batch lane and produced empty streams in the
  // SSE lane — both invisible in the log pane, NOTEPAD "3.16.3 增补" §C).
  const isSSE = upstreamResp.headers.get("content-type")?.includes("text/event-stream") ?? false;
  const streamOut = stream && isSSE;

  if (upstreamFormat === "anthropic") {
    // normalize the Anthropic upstream response into the OpenAI Chat shape the
    // downstream Responses translators already consume (SSE + batch)
    if (streamOut) {
      if (!upstreamResp.body) {
        return errorResponse(502, "translation_failed", "upstream returned no body for stream");
      }
      const translated = anthropicSseToOpenaiSse(upstreamResp.body, req.model);
      // tee: one branch feeds the client translator, one feeds the shared
      // request-table row (tokens/tok/s at stream end) — same observe pattern
      // as handler.ts. The in-flight note stays with `onStreamEnd` below.
      const [clientBody, statsBody] = translated.tee();
      observeStream(reqId, "openai", meta, upstreamResp.status, start, statsBody, null, undefined, "RSP");
      upstreamResp = new Response(clientBody, {
        status: upstreamResp.status,
        headers: { "content-type": "text/event-stream" },
      });
    } else {
      const rawAnthropic = await upstreamResp.text();
      let parsedAnthropic: AnthropicMessagesResponse;
      try {
        parsedAnthropic = JSON.parse(rawAnthropic) as AnthropicMessagesResponse;
      } catch (err) {
        printRow(reqId, "openai", meta, 502, start, headersAt, 0, 0, 0, "RSP");
        return errorResponse(502, "translation_failed", `upstream returned non-JSON body: ${(err as Error).message}`);
      }
      if (!isAnthropicMessagesResponse(parsedAnthropic)) {
        printRow(reqId, "openai", meta, 502, start, headersAt, 0, 0, 0, "RSP");
        return errorResponse(502, "translation_failed", `upstream returned invalid Anthropic message: ${rawAnthropic.slice(0, 200)}`);
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
  const translatorMeta = { customToolNames, namespaceMap, hasToolSearch };

  if (streamOut) {
    return streamResponse(upstreamResp, { responseId, model: req.model, meta: translatorMeta, request: req, input, options: opts, onStreamEnd: noteInFlightEnded });
  }

  const rawChatResp = await upstreamResp.text();
  let chatRespJson;
  try {
    chatRespJson = JSON.parse(rawChatResp);
  } catch (err) {
    printRow(reqId, "openai", meta, 502, start, headersAt, 0, 0, 0, "RSP");
    return errorResponse(502, "translation_failed", `upstream returned non-JSON body: ${(err as Error).message}`);
  }
  const responsesResp = chatCompletionsToResponses(chatRespJson, req.model, {
    responseId,
    meta: translatorMeta,
    ...(typeof req.instructions === "string" ? { instructions: req.instructions } : {}),
    ...(prevId ? { previousResponseId: prevId } : {}),
  });

  // ── 9. store the response (unless `store:false`) ──
  if (req.store !== false && opts.responseStore) {
    const stored = buildStoredResponse(responsesResp, input, req.instructions);
    opts.responseStore.set(stored);
  }

  if (debug) console.log(`[responses] ← ${responsesResp.status} (${Date.now() - start}ms)`);

  printRow(reqId, "openai", meta, 200, start, headersAt, chatRespJson?.usage?.completion_tokens ?? 0, 0, 0, "RSP");
  noteInFlightEnded();
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
  /** Fired once when the client stream completes, errors, or is cancelled. */
  onStreamEnd?: () => void;
}

function streamResponse(upstreamResp: Response, context: StreamResponseContext): Response {
  if (!upstreamResp.body) {
    return errorResponse(502, "translation_failed", "upstream returned no body for stream");
  }
  const state = newResponsesStreamState(context.model, { meta: context.meta, responseId: context.responseId });
  let onStreamEnded = false;
  const fireStreamEnd = (): void => {
    if (onStreamEnded) return;
    onStreamEnded = true;
    try { context.onStreamEnd?.(); } catch {}
  };

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
              // Release the upstream reader too — without the cancel the
              // upstream connection lingers until GC. Fire-and-forget so a
              // slow cancel never delays the client-visible error. The
              // errored-flag + early-return semantics (anti-pattern #24) are
              // unchanged: no further reads, no finalize, no close().
              reader.cancel().catch(() => {});
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
        try {
          for (const evt of failResponsesStream(state, {
            code: err instanceof AnthropicStreamError ? err.code : "upstream_error",
            message: err instanceof Error ? err.message : String(err),
          })) send(evt);
          controller.close();
        } catch { try { controller.error(err); } catch {} }
      } finally {
        fireStreamEnd();
      }
    },
    cancel(reason) {
      context.options.debug === true && console.log(`[responses] stream cancelled: ${String(reason)}`);
      fireStreamEnd();
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
