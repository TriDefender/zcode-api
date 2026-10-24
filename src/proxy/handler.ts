/**
 * Main proxy handler — routes requests, injects auth, forwards, and streams responses.
 *
 * **v2.6 upstream reality (post-PR #34)**: BOTH plan tiers post an
 * Anthropic-format upstream — coding-plan mirrors the real ZCode client
 * (api.z.ai/api/anthropic → ultra via endpoint routing); start-plan posts to
 * zcode.z.ai's Anthropic gateway with the plan JWT. Consequently:
 * - OpenAI clients are translated OpenAI→Anthropic on the way up and
 *   Anthropic→OpenAI on the way down ("translation" mode).
 * - Anthropic clients speak the upstream's native format — requests are
 *   forwarded with body transforms only ("passthrough" mode,
 *   `decompress: false`).
 *
 */
import type { Format } from "../translator/types.js";
import type { ProxyConfig } from "../config/types.js";
import type { AuthManager } from "../auth/manager.js";
import { getProvider } from "../provider/providers.js";
import { buildUpstreamHeaderPairs, buildUpstreamRequest, type UpstreamHeaderPair } from "./upstream.js";
import { getDefaultEndpointRouting, type EndpointRoutingService } from "./endpoint-routing.js";
import { getDefaultClientSigning, sendWithClientSigning, type ClientSigningManager } from "./client-signing.js";
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
import { credentialString } from "../auth/types.js";
import { sendOrderedUpstreamRequest, orderedAdvertisedCodings } from "./ordered-transport.js";
import { transformRequestBody } from "./body-transformer.js";
import { isCaptchaChallenged, retryOnCaptchaChallenge, resolveCaptchaAcquireBudgetMs, acquireCaptchaWithRetry, type CaptchaModuleLike } from "./captcha-retry.js";
import { type ClientSessionResult } from "./client-session.js";
import { resolveSessionContext } from "./session-context.js";
import { gzipSync } from "node:zlib";

// captcha.ts is loaded lazily inside the `startPlan` branch (only path that
// touches it). The solver itself (captcha-happy.ts) is dynamically imported
// by captcha-solver.ts, so non-start-plan processes never pay its startup
// cost. Desktop Bun keeps the same code path; the dynamic import resolves
// synchronously enough on Bun's warm cache.
type CaptchaModule = CaptchaModuleLike;
let captchaModule: CaptchaModule | null = null;
async function loadCaptcha(): Promise<CaptchaModule> {
  if (!captchaModule) captchaModule = await import("./captcha.js");
  return captchaModule;
}
import { translateRequestOpenAIToAnthropic, translateResponseAnthropicToOpenAI } from "../translator/openai-to-anthropic.js";
import { translateRequestAnthropicToOpenAI, translateResponseOpenAIToAnthropic } from "../translator/anthropic-to-openai.js";
import { anthropicSseToOpenaiSse, openaiSseToAnthropicSse } from "../translator/sse-translator.js";
import type { OpenAIChatRequest, OpenAIChatResponse, AnthropicMessagesRequest, AnthropicMessagesResponse } from "../translator/types.js";
import { dumpPhase, dumpHeaders, dumpBody, dumpEnabled } from "./dump.js";
import { StreamMetrics } from "./stream-metrics.js";
import { inflateWithCap } from "./inflate.js";
import { buildAnthropicMetadataUserId } from "./trace-headers.js";

/** Options for the proxy handler. */
export interface ProxyHandlerOptions {
  config: ProxyConfig;
  auth: AuthManager;
  /** Override the global fetch (for testing). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * When true, emit additional per-request diagnostic lines: upstream URL,
   * redacted request headers, body preview, upstream response status and
   * selected response headers. Activated by `zcode-proxy serve debug`.
   */
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

/**
 * Forward a client request to the upstream provider with injected auth.
 *
 * Upstream fetch options differ by mode:
 * - **Passthrough** (OpenAI client): `{ decompress: false }` — compressed
 *   response bodies (gzip/deflate/br) pass through untouched; raw bytes and the
 *   Content-Encoding header are forwarded as-is, letting the client decompress.
 * - **Translation** (Anthropic client): no options — Bun decompresses so the proxy
 *   can read the body and translate OpenAI→Anthropic (then re-gzip if the client
 *   accepts).
 *
 * No upstream timeout is applied — matches ZCode desktop client behaviour
 * (the bundle has no automatic timer on LLM calls, only user-initiated abort).
 * Connection-level errors (ECONNREFUSED, DNS failure) still surface as 502.
 */
export async function proxyRequest(
  clientReq: Request,
  format: Format,
  opts: ProxyHandlerOptions,
): Promise<Response> {
  const { config, auth } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const hasCustomFetchImpl = opts.fetchImpl !== undefined;
  const debug = opts.debug === true;
  const started = Date.now();
  const reqId = nextReqId();

  let body: string | undefined;
  try {
    body = await readBody(clientReq);
  } catch (err) {
    if (err instanceof InflatedBodyTooLargeError) {
      return errorResponse(413, "request_too_large", err.message);
    }
    return errorResponse(400, "invalid_request_error", (err as Error).message);
  }

  const meta = peekBody(body);

  if (dumpEnabled()) {
    dumpPhase(reqId, "client_in", {
      method: clientReq.method,
      url: clientReq.url,
      headers: dumpHeaders(clientReq.headers),
      body: dumpBody(body),
    });
  }

  const staticProvider = getProvider(config.provider);
  const provider = {
    ...staticProvider,
    anthropicBaseURL: config.providers[config.provider].anthropicBase,
    openaiBaseURL: config.providers[config.provider].openaiBase,
  };

  let cred;
  try {
    cred = await auth.getCredential();
  } catch (err) {
    if (debug) debugError(reqId, "credential_unavailable", (err as Error).message);
    printRow(reqId, format, meta, 503, started, Date.now(), 0, 0, 0);
    return errorResponse(503, "credential_unavailable", (err as Error).message);
  }

  // v2.6: both plans use the Anthropic upstream. coding-plan mirrors the real
  // ZCode client (api.z.ai/api/anthropic → ultra via endpoint routing);
  // start-plan's old OpenAI gateway (/api/v1/zcode-plan/chat/completions) was
  // retired server-side (404 as of 2026-08-28) — the live desktop client now
  // posts Anthropic messages to /api/v1/zcode-plan/anthropic/v1/messages with
  // the start-plan JWT, so we do the same (no OpenAI translation either way).
  const startPlan = config.plan === "start-plan";
  const translateAnthropicToOpenAI = false;
  const translateOpenAIToAnthropic = format === "openai";
  const upstreamFormat: Format = "anthropic";

  let upstreamBody = body;
  if (translateOpenAIToAnthropic) {
    const translated = translateOpenAIBody(body);
    if (translated instanceof Response) return translated;
    upstreamBody = translated;
    if (debug) debugLine(reqId, `translated OpenAI→Anthropic (bytes=${upstreamBody?.length ?? 0})`);
  } else if (translateAnthropicToOpenAI) {
    const translated = translateAnthropicBody(body);
    if (translated instanceof Response) return translated;
    upstreamBody = translated;
    if (debug) debugLine(reqId, `translated Anthropic→OpenAI (bytes=${upstreamBody?.length ?? 0})`);
  }

  // Session affinity 在转换后的 anthropic 侧计算：上游请求恒为 Anthropic
  // 形状，OpenAI 客户端与 Anthropic 客户端的同一逻辑对话得到同构的
  // canonical 身份（hash 谱系/任务身份与上游会话对齐，而非客户端方言）。
  // （2026-10-24 网关规则再变，issue #71：不再因客户端 system 强制 subagent
  // 会话身份——custom 两块形态已全灭，客户端 system 走默认三块 + main。）
  let clientSession = resolveSessionContext({ clientReq, body: upstreamBody, traceBody: body, upstreamFormat, model: meta.model, config });
  if (debug && clientSession) {
    const shortSession = clientSession.sessionId ? clientSession.sessionId.slice(0, 10) : "-";
    debugLine(reqId, `clientIdentity source=${clientSession.source} action=${clientSession.action} confidence=${clientSession.confidence.toFixed(2)} session=${shortSession}`);
  }

  // Bundle `E2e` fires for EVERY anthropic-kind request (both plans) — the
  // injected user_id is the device/session blob, never the account uuid.
  const metadataUserId = buildAnthropicMetadataUserId(config.identity.deviceMid, clientSession?.sessionId);
  let transformedBody = transformRequestBody(upstreamBody, { format: upstreamFormat, metadataUserId, startPlan, provider: config.provider });
  if (debug && transformedBody !== upstreamBody) {
    debugLine(reqId, `body transformed (upstreamFormat=${upstreamFormat}, startPlan=${startPlan}, bytes=${transformedBody?.length ?? 0})`);
  }

  // ── HighSpeed 加速卡（3.15.1 镜像，默认开）──
  // coding-plan + 合格模型：懒触发抽卡（affinity task_id）；持卡窗口内改写
  // 模型为卡上模型并替换鉴权套装（buildHighspeedTurnExecution 同构）。挂卡
  // 请求不签名（官方静态规则：highspeed mode 永不签名）。
  const highspeedManager = opts.highspeed !== undefined ? opts.highspeed : getDefaultHighspeedManager(config);
  let highspeedCard: HighspeedCard | undefined;
  let highspeedAuth: HighspeedAuth | undefined = undefined;
  let highspeedOrigBody: string | undefined;
  let highspeedOrigPairs: UpstreamHeaderPair[] | undefined;
  if (highspeedManager && !startPlan && highspeedManager.isEligibleModel(meta.model) && transformedBody) {
    const auth = highspeedAuthFrom(cred);
    if (auth) {
      highspeedAuth = auth;
      highspeedManager.onRequest(meta.model, clientSession?.upstreamSessionId, auth);
      const card = highspeedManager.activeCardFor(meta.model);
      if (card) {
        highspeedOrigBody = transformedBody;
        transformedBody = rewriteBodyModel(transformedBody, card.model);
        highspeedCard = card;
        console.log(`${reqId} highspeed card applied (model=${card.model}, card ${card.cardId.slice(0, 12)}…, window ${Math.round((card.expiresAt - Date.now()) / 1000)}s)`);
      }
    }
  }

  let captchaHeaders: Record<string, string> | undefined;
  // 在飞即活动（NOTEPAD "3.16.3 增补" §H）：SSE 还在输出就不是空闲——流结束/请求
  // 完成时刷新 captcha 池与 highspeed 抽卡循环的空闲窗，长流式请求不得让池衰减、
  // 抽卡循环自熄（下一个 tool-loop turn 会落在被误判空闲抽干的池上）。captcha 侧
  // 用动态 import 维持懒加载纪律（coding-plan 永不加载 captcha 模块）；highspeed
  // 侧仅对合格请求记账（与 onRequest 同门）——不合格流量刷窗会让抽卡循环对永不
  // 挂卡的流量空转烧 draw 配额。
  // Only requests that actually entered onRequest may extend its auth's loop.
  const hsNoteEligible = highspeedAuth !== undefined;
  const noteInFlightEnded = (): void => {
    if (startPlan) void (opts.captcha ? Promise.resolve(opts.captcha) : loadCaptcha()).then((m) => m.noteDemand?.()).catch(() => {});
    if (hsNoteEligible) highspeedManager?.noteActivity();
  };
  if (startPlan) {
    // Captcha 头在 start-plane 是承重结构（2026-10-23 实弹，NOTEPAD "3.16.3 增补" §H）：
    // 裸发是真实客户端永不产生的形态，ESA 边缘对之间歇性回**空体 502**（无源站
    // request-id，下方 403 挑战重试不认识这种失败，不会兜底）。获取失败必须有界重试
    // （configs 镜像 1h 快照/无负缓存、池内已含 25s+10s 等待，预算覆盖典型故障窗口）后诚实 503，
    // 绝不 fail-open 裸发；getCaptchaToken 返回 null = 服务端明示禁用 → 无头即正确形态。
    try {
      captchaHeaders = await acquireCaptchaWithRetry(async () => {
        const captcha = opts.captcha ?? (await loadCaptcha());
        const token = await captcha.getCaptchaToken(config.identity.appVersion);
        return token ? { [captcha.RETRY_HEADERS.PARAM]: token.verifyParam, [captcha.RETRY_HEADERS.REGION]: token.region } : undefined;
      }, {
        budgetMs: resolveCaptchaAcquireBudgetMs(process.env.CAPTCHA_ACQUIRE_BUDGET_MS),
        signal: clientReq.signal,
        onRetry: debug ? (err) => debugError(reqId, "captcha_acquire_retry", `${err.message}; retrying`) : undefined,
      });
    } catch (err) {
      if (debug) debugError(reqId, "captcha_solver_failed", (err as Error).message);
      printRow(reqId, format, meta, 503, started, Date.now(), 0, 0, 0);
      return errorResponse(503, "captcha_solver_failed", `Captcha acquisition failed: ${(err as Error).message}. The start-plan edge rejects captcha-less requests — retry shortly.`);
    }
  }

  const useOrderedTransport = shouldUseOrderedTransport(clientSession, hasCustomFetchImpl);
  let upstreamHeaderPairs = buildUpstreamHeaderPairs(clientReq, upstreamFormat, cred, config.identity, config.plan, captchaHeaders, clientSession);
  if (highspeedCard && highspeedAuth) {
    highspeedOrigPairs = upstreamHeaderPairs;
    upstreamHeaderPairs = applyHighspeedCardHeaders(upstreamHeaderPairs, highspeedCard, highspeedAuth);
  }
  let upstreamReq = buildUpstreamRequest(clientReq, upstreamFormat, provider, cred, transformedBody, config.identity, config.plan, captchaHeaders, clientSession);
  if (highspeedCard && highspeedAuth) {
    // dispatch reuses the pre-built Request whenever the signer returns the
    // pairs unchanged (unsigned path) — rebuild it from the swapped pairs so
    // the card headers actually reach the wire (buildUpstreamRequest derives
    // its own header set internally).
    upstreamReq = new Request(upstreamReq.url, {
      method: upstreamReq.method,
      headers: Object.fromEntries(upstreamHeaderPairs),
      body: transformedBody ?? undefined,
    });
  }

  const routing = opts.endpointRouting !== undefined ? opts.endpointRouting : getDefaultEndpointRouting(config);
  let signer = opts.clientSigning !== undefined ? opts.clientSigning : getDefaultClientSigning(config);
  // 官方 3.15.1 静态规则：highspeed mode 的推理请求永不签名（`TUs` 返回 false）。
  if (highspeedCard) signer = null;
  const translateMode = translateOpenAIToAnthropic || translateAnthropicToOpenAI;
  // When the ordered transport must READ the upstream body (translate mode), it
  // has to inflate whatever coding the upstream picks — cap the advertised
  // accept-encoding (a passthrough of the inbound client's list, which browsers
  // set to `gzip, deflate, br, zstd`) to what the transport can decompress.
  // The ultra CDN serves SSE brotli-compressed when `br` is advertised, and a
  // coding the transport cannot inflate would starve the SSE translator
  // (observed 2026-09-18 as 0-byte streams → client timeouts). Pure-passthrough
  // requests keep the client's list verbatim — the client decodes those itself.
  if (useOrderedTransport && translateMode) {
    upstreamHeaderPairs = capOrderedAcceptEncoding(upstreamHeaderPairs);
  }
  const dispatch = async (req: Request, pairs: UpstreamHeaderPair[]): Promise<Response> => {
    let sendUrl = req.url;
    let routingHeaderPairs: UpstreamHeaderPair[] | undefined;
    if (routing) {
      const routed = await routing.resolve(req.url, credentialString(cred), cred.jwt);
      if (routed.routed) {
        sendUrl = routed.url;
        routingHeaderPairs = routed.headers ? (Object.entries(routed.headers) as UpstreamHeaderPair[]) : undefined;
        if (debug) debugLine(reqId, `endpoint routing: ${req.url} -> ${routed.url}`);
      }
    }
    // Signing decisions (exempt-path, handshake origin, bypass keying) run
    // against the PRE-routing provider URL — the client's signer wraps the
    // routing transport, so its checks see the original URL too.
    return sendWithClientSigning(signer, {
      url: req.url,
      headerPairs: pairs,
      credential: credentialString(cred),
      oauthAccessToken: cred.oauthAccessToken,
      provider: cred.provider,
      appVersion: config.identity.appVersion,
      debug: debug ? (message) => debugLine(reqId, message) : undefined,
      send: (finalPairs) => {
        // 3.16.2 X-ZCode-Authorization: the client appends it inside its
        // routing wrapper, which sits INSIDE the signing wrapper — so on the
        // wire it lands after the signature block, as the very last header.
        const outboundPairs = routingHeaderPairs ? [...finalPairs, ...routingHeaderPairs] : finalPairs;
        if (dumpEnabled()) {
          // The pre-built `upstream_out` line shows the pre-routing URL and
          // pre-signing header set; this line captures what actually went on
          // the wire (routed URL + signed pairs) — the two diverge silently
          // otherwise and misled a 2026-09-18 debugging session.
          dumpPhase(reqId, "wire_out", {
            url: sendUrl,
            signed: outboundPairs.some(([k]) => k.toLowerCase() === "x-client-sig"),
            headers: dumpHeaders(new Headers(Object.fromEntries(outboundPairs))),
          });
        }
        const sendReq = sendUrl === req.url && outboundPairs === pairs
          ? req
          : new Request(sendUrl, {
              method: req.method,
              headers: Object.fromEntries(outboundPairs),
              body: transformedBody ?? undefined,
            });
        return sendUpstreamRequest(sendReq, outboundPairs, transformedBody, translateMode, useOrderedTransport, fetchImpl, clientReq.signal, hasCustomFetchImpl);
      },
    });
  };

  if (debug) {
    debugLine(reqId, `→ POST ${upstreamReq.url}`);
    debugLine(reqId, `  ${formatHeaderPairs(upstreamReq.headers)}`);
    if (transformedBody) debugLine(reqId, `  body preview: ${previewBody(transformedBody)}`);
  }

  if (dumpEnabled()) {
    dumpPhase(reqId, "upstream_out", {
      method: upstreamReq.method,
      url: upstreamReq.url,
      headers: dumpHeaders(upstreamReq.headers),
      body: dumpBody(transformedBody),
      upstreamFormat,
      translateMode: translateOpenAIToAnthropic || translateAnthropicToOpenAI,
      useOrderedTransport,
      startPlan,
    });
  }

  let upstreamResp: Response;
  try {
    // Transient connect failures (DNS blip, TLS reset, Bun "Unable to
    // connect") happen a few times a day against the gateway. Retry the
    // CONNECT twice with a short backoff before surfacing a 502 — the
    // request never reached upstream, so resending is side-effect-free.
    // Guard rails: skip retry when the client already aborted or the ordered
    // transport flagged the failure postWrite; re-dispatch a FRESH Request
    // each attempt — a reused Request has its body stream marked used after
    // the first fetch (start-plan hits the plain pass-through path where
    // dispatch does NOT rebuild the Request).
    let dispatchAttempt = 0;
    upstreamResp = await dispatchWithConnectRetry(
      () => {
        dispatchAttempt += 1;
        const currentReq = dispatchAttempt === 1
          ? upstreamReq
          : highspeedCard
            // buildUpstreamRequest derives its own (uncarded) header set; a
            // carded rebuild must come from the swapped pairs — same reuse
            // hazard as the attempt-1 rebuild above
            ? new Request(upstreamReq.url, {
              method: upstreamReq.method,
              headers: Object.fromEntries(upstreamHeaderPairs),
              body: transformedBody ?? undefined,
            })
            : buildUpstreamRequest(clientReq, upstreamFormat, provider, cred, transformedBody, config.identity, config.plan, captchaHeaders, clientSession);
        return dispatch(currentReq, upstreamHeaderPairs);
      },
      {
        isAborted: () => clientReq.signal.aborted,
        onRetry: (attempt, err) => {
          if (debug) debugError(reqId, "upstream_connect_retry", `attempt ${attempt}/${MAX_CONNECT_ATTEMPTS - 1} failed (${err.message}), retrying in ${500 * attempt}ms`);
          console.log(`${reqId} upstream connect failed (${err.message}), retry ${attempt + 1}/${MAX_CONNECT_ATTEMPTS} in ${500 * attempt}ms`);
        },
      },
    );
  } catch (err) {
    if (debug) debugError(reqId, "upstream_unreachable", (err as Error).message);
    printRow(reqId, format, meta, 502, started, Date.now(), 0, 0, 0);
    return errorResponse(502, "upstream_unreachable", (err as Error).message);
  }
  const headersAt = Date.now();

  if (debug) {
    debugLine(reqId, `← ${upstreamResp.status} ${upstreamResp.statusText}`);
    debugLine(reqId, `  ${formatResponseHeaders(upstreamResp.headers)}`);
  }

  if (dumpEnabled()) {
    dumpPhase(reqId, "upstream_in", {
      status: upstreamResp.status,
      statusText: upstreamResp.statusText,
      headers: dumpHeaders(upstreamResp.headers),
      isSSE: upstreamResp.headers.get("content-type")?.includes("text/event-stream") ?? false,
      ttfbMs: headersAt - started,
    });
  }

  if (upstreamResp.status === 401 && startPlan) {
    if (debug) debugError(reqId, "start_plan_jwt_invalid", "JWT rejected upstream");
    printRow(reqId, format, meta, 401, started, headersAt, 0, 0, 0);
    return errorResponse(401, "start_plan_jwt_invalid", "Start-plan JWT was rejected. Re-run: zcode-proxy auth login");
  }

  // highspeed selectionFallback（官方语义）：挂卡请求收到 401 / biz 3402
  // （卡过期/拒绝）时弃卡，用原模型 + 常规 coding-plan 鉴权（恢复签名）重发一次。
  if (highspeedCard && highspeedManager && highspeedOrigBody !== undefined && highspeedOrigPairs !== undefined
    && (await isHighspeedCardRejection(upstreamResp))) {
    console.log(`${reqId} highspeed card rejected upstream — falling back to session model`);
    highspeedManager.dropCard("upstream_rejected");
    transformedBody = highspeedOrigBody;
    // restore + re-cap: highspeedOrigPairs was captured BEFORE the ordered-
    // transport accept-encoding cap, which only ran against the carded pairs
    // (same re-cap the captcha retry path performs after rebuilding pairs)
    upstreamHeaderPairs = useOrderedTransport && translateMode
      ? capOrderedAcceptEncoding(highspeedOrigPairs)
      : highspeedOrigPairs;
    signer = opts.clientSigning !== undefined ? opts.clientSigning : getDefaultClientSigning(config);
    const fallbackReq = buildUpstreamRequest(clientReq, upstreamFormat, provider, cred, transformedBody, config.identity, config.plan, captchaHeaders, clientSession);
    try {
      upstreamResp = await dispatch(fallbackReq, upstreamHeaderPairs);
    } catch (err) {
      if (debug) debugError(reqId, "upstream_unreachable", (err as Error).message);
      printRow(reqId, format, meta, 502, started, Date.now(), 0, 0, 0);
      return errorResponse(502, "upstream_unreachable", (err as Error).message);
    }
    if (debug) debugLine(reqId, `highspeed fallback dispatched (status=${upstreamResp.status})`);
  }

  // start-plan: on explicit captcha challenge, retry once with a fresh
  // pooled token (the challenged token was already consumed by this request;
  // getCaptchaToken takes the next pre-solved one). Detection covers the
  // response-header variant AND the in-body `{"code":3007}` variant (observed
  // 2026-08-29 as HTTP 400 JSON with no captcha header) via the shared
  // captcha-retry seam (used by /v1/responses too).
  const captcha = startPlan ? (opts.captcha ?? (await loadCaptcha())) : null;
  const captchaChallenge = captcha ? await isCaptchaChallenged(upstreamResp, captcha) : false;
  if (captchaChallenge && captcha) {
    console.log(`${reqId} captcha challenge, re-solving...`);
    const outcome = await retryOnCaptchaChallenge({
      captcha,
      appVersion: config.identity.appVersion,
      challengedResp: upstreamResp,
      debug: debug ? (message) => debugLine(reqId, message) : undefined,
      solveAndRetry: (retryHeaders) => {
        console.log(`${reqId} captcha re-solved (token ${retryHeaders[captcha.RETRY_HEADERS.PARAM].length} chars), retrying...`);
        upstreamHeaderPairs = buildUpstreamHeaderPairs(clientReq, upstreamFormat, cred, config.identity, config.plan, retryHeaders, clientSession);
        if (useOrderedTransport && translateMode) {
          upstreamHeaderPairs = capOrderedAcceptEncoding(upstreamHeaderPairs);
        }
        upstreamReq = buildUpstreamRequest(clientReq, upstreamFormat, provider, cred, transformedBody, config.identity, config.plan, retryHeaders, clientSession);
        return dispatch(upstreamReq, upstreamHeaderPairs).then((resp) => {
          if (debug) debugLine(reqId, `← retry ${resp.status} ${resp.statusText}`);
          return resp;
        });
      },
      mapError: (err, phase) => {
        if (phase === "solver") {
          if (debug) debugError(reqId, "captcha_solver_failed", err.message);
          printRow(reqId, format, meta, 503, started, Date.now(), 0, 0, 0);
          return errorResponse(503, "captcha_solver_failed", err.message);
        }
        if (debug) debugError(reqId, "upstream_unreachable", err.message);
        printRow(reqId, format, meta, 502, started, Date.now(), 0, 0, 0);
        return errorResponse(502, "upstream_unreachable", err.message);
      },
    });
    if (!outcome.ok) return outcome.resp;
    upstreamResp = outcome.resp;
  }

  const isSSE = upstreamResp.headers.get("content-type")?.includes("text/event-stream") ?? false;

  if (translateOpenAIToAnthropic) {
    if (!upstreamResp.ok) {
      return upstreamErrorPassthrough(reqId, format, meta, upstreamResp, started, headersAt);
    }
    if (isSSE && upstreamResp.body) {
      const translated = anthropicSseToOpenaiSse(upstreamResp.body, meta.model);
      const [clientBody, statsBody] = translated.tee();
      observeStream(reqId, format, meta, upstreamResp.status, started, statsBody, null, noteInFlightEnded);
      return translatedSseResponse(clientBody);
    }
    const batchResp = await translatedBatchResponse(clientReq, upstreamResp, meta.model, reqId, format, meta, started, headersAt);
    noteInFlightEnded();
    return batchResp;
  }

  if (translateAnthropicToOpenAI) {
    if (!upstreamResp.ok) {
      return upstreamErrorPassthrough(reqId, format, meta, upstreamResp, started, headersAt);
    }
    if (isSSE && upstreamResp.body) {
      const translated = openaiSseToAnthropicSse(upstreamResp.body, meta.model);
      const [clientBody, statsBody] = translated.tee();
      observeStream(reqId, format, meta, upstreamResp.status, started, statsBody, null, noteInFlightEnded);
      return translatedSseResponse(clientBody);
    }
    const batchResp = await translatedOpenAIToAnthropicBatchResponse(clientReq, upstreamResp, reqId, format, meta, started, headersAt);
    noteInFlightEnded();
    return batchResp;
  }

  if (isSSE && upstreamResp.body) {
    const [clientBody, statsBody] = upstreamResp.body.tee();
    observeStream(reqId, format, meta, upstreamResp.status, started, statsBody, upstreamResp.headers.get("content-encoding"), noteInFlightEnded);
    return passthroughResponse(upstreamResp, clientAcceptsGzip(clientReq), clientBody);
  }

  printRow(reqId, format, meta, upstreamResp.status, started, headersAt, 0, 0, 0);
  noteInFlightEnded();
  return passthroughResponse(upstreamResp, clientAcceptsGzip(clientReq));
}

export function shouldUseOrderedTransport(clientSession: ClientSessionResult | undefined, hasCustomFetchImpl: boolean): boolean {
  if (hasCustomFetchImpl) return false;
  return clientSession?.action === "enforce" || clientSession?.source === "explicit";
}

/**
 * Restrict an ordered-transport header-pair list's `accept-encoding` to codings
 * the transport can inflate itself (see ordered-transport.ts). Preserves the
 * client's token order, drops q-weights and unsupported tokens (including `*`),
 * and falls back to `identity` when nothing remains. Header order is untouched —
 * only the value at the existing position changes.
 */
export function capOrderedAcceptEncoding(
  pairs: UpstreamHeaderPair[],
  supported: readonly string[] = orderedAdvertisedCodings(),
): UpstreamHeaderPair[] {
  const idx = pairs.findIndex(([name]) => name.toLowerCase() === "accept-encoding");
  if (idx < 0) return pairs;
  const advertised = pairs[idx][1];
  const tokens = advertised
    .split(",")
    .map((token) => token.split(";")[0]!.trim().toLowerCase())
    .filter((token) => token.length > 0);
  const kept = tokens.filter((token) => token === "identity" || supported.includes(token));
  if (kept.length === tokens.length) return pairs;
  const next = kept.length > 0 ? kept.join(", ") : "identity";
  return pairs.map((pair, i) => (i === idx ? [pair[0], next] as UpstreamHeaderPair : pair));
}

/** Max attempts (initial + 2 retries) for transient CONNECT-level failures. */
const MAX_CONNECT_ATTEMPTS = 3;

/**
 * Connect-level retry ladder shared by the chat hot path and /v1/responses.
 * Transient connect failures (DNS blip, TLS reset, Bun "Unable to connect")
 * happen a few times a day against the gateway; the request never reached
 * upstream, so resending is side-effect-free.
 *
 * Contract (review P1/P2, PR #34/#35):
 *   - `attemptDispatch` must dispatch a FRESH request each call — a reused
 *     Request has its body stream marked used after the first fetch.
 *   - failures flagged `postWrite` (ordered transport already wrote the full
 *     request) are never retried — the upstream may have processed it.
 *   - no retry once the client aborted (`opts.isAborted`).
 */
export async function dispatchWithConnectRetry(
  attemptDispatch: () => Promise<Response>,
  opts: { isAborted?: () => boolean; onRetry?: (attempt: number, err: Error) => void } = {},
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    if (opts.isAborted?.()) throw new Error("client aborted before upstream connect");
    try {
      return await attemptDispatch();
    } catch (err) {
      if ((err as { postWrite?: boolean }).postWrite) throw err;
      if (attempt >= MAX_CONNECT_ATTEMPTS) throw err;
      const backoffMs = 500 * attempt;
      opts.onRetry?.(attempt, err as Error);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
}

/**
 * True on runtimes whose fetch ignores Bun's `decompress: false` extension and
 * transparently inflates compressed response bodies while KEEPING the
 * `content-encoding`/`content-length` headers (verified empirically against
 * Node 22/26 undici and Bun 1.3: gzip, deflate and br are all decoded, headers
 * unchanged). Bun honors `decompress: false` (raw bytes + truthful header), so
 * no normalization is needed there.
 */
const FETCH_AUTO_DECOMPRESSES = typeof Bun === "undefined";

/** Content codings a `FETCH_AUTO_DECOMPRESSES` runtime inflates transparently. */
const AUTO_DECODED_ENCODINGS = new Set(["gzip", "x-gzip", "deflate", "br"]);

/**
 * Strip `content-encoding`/`content-length` from a Response whose body the
 * runtime fetch has ALREADY inflated. Without this, passthrough on Node would
 * forward a decoded body still labeled `content-encoding: gzip` — clients that
 * advertise gzip then fail to decompress it, and the `passthroughResponse`
 * safety net would double-decompress an already-inflated stream for clients
 * that don't. No-op for encodings the runtime leaves untouched. Returns a new
 * Response because a fetch Response's headers can be immutable.
 */
export function stripAutoDecodedEncoding(resp: Response): Response {
  const encoding = resp.headers.get("content-encoding")?.toLowerCase().trim() ?? "";
  if (!encoding) return resp;
  const codings = encoding.split(",").map((c) => c.trim());
  if (!codings.every((c) => AUTO_DECODED_ENCODINGS.has(c))) return resp;
  const headers = new Headers(resp.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

async function sendUpstreamRequest(
  upstreamReq: Request,
  headerPairs: UpstreamHeaderPair[],
  body: string | undefined,
  translateMode: boolean,
  useOrderedTransport: boolean,
  fetchImpl: typeof fetch,
  abortSignal?: AbortSignal,
  hasCustomFetchImpl = false,
): Promise<Response> {
  if (useOrderedTransport) {
    return sendOrderedUpstreamRequest({
      url: upstreamReq.url,
      method: upstreamReq.method,
      headers: headerPairs,
      body,
      decompress: translateMode,
      signal: abortSignal,
    });
  }
  const fetchOpts: RequestInit & { decompress?: boolean } = translateMode ? {} : { decompress: false };
  if (abortSignal) fetchOpts.signal = abortSignal;
  const resp = await fetchImpl(upstreamReq, fetchOpts);
  // Passthrough on a runtime whose fetch auto-decompresses (Node/undici in the
  // Android bundle): the body arrives inflated while its headers still claim
  // compression. Drop the stale labels so the body/header pairing downstream
  // stays truthful. Skipped for injected fetch impls (tests) — their bodies are
  // genuinely compressed and their decompression semantics are their own.
  if (!translateMode && FETCH_AUTO_DECOMPRESSES && !hasCustomFetchImpl) {
    return stripAutoDecodedEncoding(resp);
  }
  return resp;
}

/**
 * Read the request body as a string, returning undefined for empty bodies.
 * Transparently inflates `content-encoding: gzip` request bodies (the OpenAI /
 * Anthropic upstreams accept gzipped request bodies; without this, clients
 * that send them got a misleading "body is not valid JSON" 400). Corrupt gzip
 * throws a descriptive Error; inflation past `MAX_INFLATED_BODY_BYTES` throws
 * `InflatedBodyTooLargeError` (streamed + aborted early, so a small wire
 * payload cannot expand into unbounded proxy memory).
 */
export async function readBody(req: Request): Promise<string | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength === 0) return undefined;
  const encoding = req.headers.get("content-encoding")?.toLowerCase().trim() ?? "";
  if (encoding === "gzip" || encoding === "x-gzip") {
    return new TextDecoder().decode(await inflateGzipBody(bytes));
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Decompressed-size ceiling for gzip request bodies. Generous by design:
 * plain bodies on `/v1/*` routes are intentionally uncapped (long-context LLM
 * requests reach several MB), so this only rejects pathological amplification.
 */
const MAX_INFLATED_BODY_BYTES = 64 * 1024 * 1024;

/** Thrown when a gzip request body expands past MAX_INFLATED_BODY_BYTES. */
export class InflatedBodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`gzip request body exceeds ${limit} bytes after decompression`);
    this.name = "InflatedBodyTooLargeError";
  }
}

async function inflateGzipBody(bytes: Uint8Array): Promise<Uint8Array> {
  const result = await inflateWithCap(bytes, MAX_INFLATED_BODY_BYTES);
  if (!result.ok) {
    if (result.reason === "too_large") throw new InflatedBodyTooLargeError(MAX_INFLATED_BODY_BYTES);
    throw new Error(`request body is marked content-encoding: gzip but failed to decompress: ${result.detail}`);
  }
  return result.bytes;
}

/**
 * Create a passthrough response that streams the upstream body to the client.
 * Preserves status and the allowlisted headers, and honors the client's
 * `Accept-Encoding` for gzip.
 *
 * The upstream request FORWARDS the client's `accept-encoding` (only
 * defaulting to "gzip" when the client sent none — see
 * `buildUpstreamHeaderPairs`), so the upstream compresses only when the
 * client can decode it. If THIS client did not advertise gzip but the body
 * arrived gzip-compressed anyway, we decompress before forwarding and drop
 * the now-mismatched `content-encoding`/`content-length` headers — otherwise
 * clients whose HTTP stack does not auto-decompress (e.g. some Tauri-based
 * clients) receive raw gzip bytes and fail to parse the JSON body with
 * "non-JSON body" errors despite a 200 status.
 */
function passthroughResponse(
  upstream: Response,
  clientAcceptsGzip: boolean,
  body?: ReadableStream<Uint8Array>,
): Response {
  const headers = new Headers();
  const forwardHeaders = [
    "content-type",
    "content-encoding",
    "cache-control",
    "x-request-id",
    "anthropic-ratelimit-requests-limit",
    "anthropic-ratelimit-requests-remaining",
    "anthropic-ratelimit-requests-reset",
    "anthropic-ratelimit-tokens-limit",
    "anthropic-ratelimit-tokens-remaining",
    "anthropic-ratelimit-tokens-reset",
  ];

  for (const h of forwardHeaders) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }

  const upstreamEncoding = headers.get("content-encoding")?.toLowerCase() ?? "";
  const source = body ?? upstream.body;
  if (upstreamEncoding.includes("gzip") && !clientAcceptsGzip && source) {
    const gunzip = new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
    const decompressed = source.pipeThrough(gunzip);
    headers.delete("content-encoding");
    headers.delete("content-length");
    return new Response(decompressed, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  }

  return new Response(source, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

/** Build a JSON error response. */
export function errorResponse(status: number, type: string, message: string): Response {
  const body = JSON.stringify({
    error: { type, message },
  });
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Translate an OpenAI request body string to Anthropic JSON. Returns error Response on failure. */
function translateOpenAIBody(body: string | undefined): Response | string | undefined {
  if (body === undefined || body.length === 0) {
    return errorResponse(400, "translation_failed", "OpenAI request body is empty; cannot translate.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    return errorResponse(400, "translation_failed", `OpenAI request body is not valid JSON: ${(err as Error).message}`);
  }
  try {
    const translated = translateRequestOpenAIToAnthropic(parsed as OpenAIChatRequest);
    return JSON.stringify(translated);
  } catch (err) {
    return errorResponse(400, "translation_failed", `OpenAI→Anthropic translation failed: ${(err as Error).message}`);
  }
}

/** True when the client request explicitly accepts gzip (and has not disabled it via q=0). */
function clientAcceptsGzip(req: Request): boolean {
  const ae = req.headers.get("accept-encoding");
  if (!ae) return false;
  return /\bgzip\b(?!\s*;\s*q=0(?:\.0+)?\s*(?:,|$))/i.test(ae);
}

/** Build a translated batch (non-streaming) OpenAI response. Gzip if client accepts. */
async function translatedBatchResponse(
  clientReq: Request,
  upstream: Response,
  model: string,
  reqId: string,
  format: Format,
  meta: RequestMeta,
  started: number,
  headersAt: number,
): Promise<Response> {
  const raw = await upstream.text();
  let parsedAnthropic: AnthropicMessagesResponse;
  try {
    parsedAnthropic = JSON.parse(raw) as AnthropicMessagesResponse;
  } catch (err) {
    printRow(reqId, format, meta, 502, started, headersAt, 0, 0, 0);
    return errorResponse(502, "translation_failed", `upstream returned non-JSON body: ${(err as Error).message}`);
  }
  if (!isAnthropicMessagesResponse(parsedAnthropic)) {
    printRow(reqId, format, meta, 502, started, headersAt, 0, 0, 0);
    return errorResponse(502, "translation_failed", `upstream returned invalid Anthropic message: ${raw.slice(0, 200)}`);
  }
  const openaiResp = translateResponseAnthropicToOpenAI(parsedAnthropic, model);
  const json = JSON.stringify(openaiResp);
  const payload = new TextEncoder().encode(json);

  const respHeaders = new Headers();
  respHeaders.set("content-type", "application/json");
  for (const h of forwardedUpstreamHeaders()) {
    const v = upstream.headers.get(h);
    if (v) respHeaders.set(h, v);
  }

  if (clientAcceptsGzip(clientReq)) {
    respHeaders.set("content-encoding", "gzip");
    printRow(reqId, format, meta, upstream.status, started, headersAt, openaiResp.usage?.completion_tokens ?? 0, 0, 0);
    return new Response(gzipSync(payload), {
      status: upstream.status,
      headers: respHeaders,
    });
  }
  printRow(reqId, format, meta, upstream.status, started, headersAt, openaiResp.usage?.completion_tokens ?? 0, 0, 0);
  return new Response(payload, {
    status: upstream.status,
    headers: respHeaders,
  });
}

async function translatedOpenAIToAnthropicBatchResponse(
  clientReq: Request,
  upstream: Response,
  reqId: string,
  format: Format,
  meta: RequestMeta,
  started: number,
  headersAt: number,
): Promise<Response> {
  const raw = await upstream.text();
  let parsedOpenAI: OpenAIChatResponse;
  try {
    parsedOpenAI = JSON.parse(raw) as OpenAIChatResponse;
  } catch (err) {
    printRow(reqId, format, meta, 502, started, headersAt, 0, 0, 0);
    return errorResponse(502, "translation_failed", `upstream returned non-JSON body: ${(err as Error).message}`);
  }
  const anthropicResp = translateResponseOpenAIToAnthropic(parsedOpenAI);
  const json = JSON.stringify(anthropicResp);
  const payload = new TextEncoder().encode(json);

  const respHeaders = new Headers();
  respHeaders.set("content-type", "application/json");
  for (const h of forwardedUpstreamHeaders()) {
    const v = upstream.headers.get(h);
    if (v) respHeaders.set(h, v);
  }

  if (clientAcceptsGzip(clientReq)) {
    respHeaders.set("content-encoding", "gzip");
    printRow(reqId, format, meta, upstream.status, started, headersAt, anthropicResp.usage.output_tokens, 0, 0);
    return new Response(gzipSync(payload), {
      status: upstream.status,
      headers: respHeaders,
    });
  }
  printRow(reqId, format, meta, upstream.status, started, headersAt, anthropicResp.usage.output_tokens, 0, 0);
  return new Response(payload, {
    status: upstream.status,
    headers: respHeaders,
  });
}

function translateAnthropicBody(body: string | undefined): Response | string | undefined {
  if (body === undefined || body.length === 0) {
    return errorResponse(400, "translation_failed", "Anthropic request body is empty; cannot translate.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    return errorResponse(400, "translation_failed", `Anthropic request body is not valid JSON: ${(err as Error).message}`);
  }
  try {
    const translated = translateRequestAnthropicToOpenAI(parsed as AnthropicMessagesRequest);
    return JSON.stringify(translated);
  } catch (err) {
    return errorResponse(400, "translation_failed", `Anthropic→OpenAI translation failed: ${(err as Error).message}`);
  }
}

function isAnthropicMessagesResponse(value: unknown): value is AnthropicMessagesResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<AnthropicMessagesResponse>;
  return candidate.type === "message" && candidate.role === "assistant" && Array.isArray(candidate.content);
}

function forwardedUpstreamHeaders(): string[] {
  return [
    "x-request-id",
    "anthropic-ratelimit-requests-limit",
    "anthropic-ratelimit-requests-remaining",
    "anthropic-ratelimit-requests-reset",
    "anthropic-ratelimit-tokens-limit",
    "anthropic-ratelimit-tokens-remaining",
    "anthropic-ratelimit-tokens-reset",
  ];
}

function translatedSseResponse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  });
}

interface RequestMeta {
  model: string;
  stream: boolean;
}

function peekBody(body: string | undefined): RequestMeta {
  if (!body) return { model: "-", stream: false };
  try {
    const p = JSON.parse(body) as Record<string, unknown>;
    return {
      model: typeof p.model === "string" ? p.model : "-",
      stream: p.stream === true,
    };
  } catch {
    return { model: "-", stream: false };
  }
}

let reqCounter = 0;
let headerPrinted = false;

/** Format a unix-ms timestamp as local HH:MM:SS in the host's timezone (not UTC). */
function localTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function nextReqId(): string {
  return `#${String(++reqCounter).padStart(3, "0")}`;
}

/**
 * Translate-mode upstream failures pass the REAL status + body through
 * (issue #71): wrapping them as 502 made clients retry 405/429 as if they
 * were transient gateway faults. The upstream body (Anthropic error JSON)
 * is forwarded verbatim with its content-type.
 */
async function upstreamErrorPassthrough(
  reqId: string,
  format: Format,
  meta: RequestMeta,
  upstreamResp: Response,
  started: number,
  headersAt: number,
): Promise<Response> {
  const errBody = await upstreamResp.text().catch(() => "");
  printRow(reqId, format, meta, upstreamResp.status, started, headersAt, 0, 0, 0);
  return new Response(errBody, {
    status: upstreamResp.status,
    headers: { "content-type": upstreamResp.headers.get("content-type") ?? "application/json" },
  });
}

const DEBUG_BODY_PREVIEW = 200;
const SENSITIVE_HEADERS = new Set(["authorization", "x-api-key", "cookie", "set-cookie", "proxy-authorization"]);

function debugLine(reqId: string, msg: string): void {
  console.log(`${reqId} debug: ${msg}`);
}

function debugError(reqId: string, kind: string, msg: string): void {
  console.log(`${reqId} debug: ERROR ${kind}: ${msg}`);
}

function redactHeaderVal(key: string, val: string): string {
  const k = key.toLowerCase();
  if (!SENSITIVE_HEADERS.has(k)) return val;
  if (k === "authorization") {
    const sp = val.indexOf(" ");
    return sp > 0 ? `${val.slice(0, sp)} <redacted>` : "<redacted>";
  }
  if (val.length <= 10) return "<redacted>";
  return `${val.slice(0, 6)}...${val.slice(-4)}`;
}

function formatHeaderPairs(headers: Headers): string {
  const pairs: string[] = [];
  for (const [k, v] of headers.entries()) {
    pairs.push(`${k}=${redactHeaderVal(k, v)}`);
  }
  return pairs.join(" ");
}

function formatResponseHeaders(headers: Headers): string {
  const interesting = [
    "content-type",
    "content-encoding",
    "content-length",
    "x-request-id",
    "anthropic-ratelimit-requests-remaining",
    "anthropic-ratelimit-tokens-remaining",
  ];
  const pairs: string[] = [];
  for (const h of interesting) {
    const v = headers.get(h);
    if (v) pairs.push(`${h}=${v}`);
  }
  return pairs.length > 0 ? pairs.join(" ") : "(no notable headers)";
}

function previewBody(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length <= DEBUG_BODY_PREVIEW) return flat;
  return `${flat.slice(0, DEBUG_BODY_PREVIEW)}…(${flat.length} bytes total)`;
}

const COMPACT_LOG = process.env.ZCODE_LOG_FORMAT === "compact";

function printHeader(): void {
  if (headerPrinted) return;
  headerPrinted = true;
  if (COMPACT_LOG) return;
  console.log(
    "| #    | Time       | Fmt | Model       | Mode   | Stat |    TTFB |   Tok |  tok/s |   Total |",
  );
  console.log(
    "|------|------------|-----|-------------|--------|------|---------|-------|--------|---------|",
  );
}

function printRow(
  reqId: string,
  format: Format,
  meta: RequestMeta,
  status: number,
  started: number,
  headersAt: number,
  tokens: number,
  avgTps: number,
  streamEndAt: number,
): void {
  printHeader();
  const tag = format === "anthropic" ? "ANT" : "OAI";
  const mode = meta.stream ? "stream" : "batch";

  if (COMPACT_LOG) {
    const ttfbMs = headersAt - started;
    const totalMs = streamEndAt > started ? streamEndAt - started : ttfbMs;
    const ttfbStr = fmtMs(ttfbMs);
    const tokStr = tokens > 0 ? `${tokens}tok` : "";
    const tpsStr = avgTps > 0 ? `${avgTps.toFixed(0)}t/s` : "";
    const parts = [reqId, tag, meta.model, String(status), mode];
    if (meta.stream && streamEndAt > started) {
      parts.push(`${ttfbStr}→${fmtMs(totalMs)}`);
    } else {
      parts.push(ttfbStr);
    }
    if (tokStr) parts.push(tokStr);
    if (tpsStr) parts.push(tpsStr);
    console.log(parts.join(" "));
    return;
  }

  const ts = localTime(started);
  const ttfb = `${headersAt - started}ms`;
  const total = streamEndAt > started ? `${streamEndAt - started}ms` : "-";
  const tok = tokens > 0 ? String(tokens) : "-";
  const tps = avgTps > 0 ? avgTps.toFixed(1) : "-";
  console.log(
    `| ${reqId.padEnd(4)} | ${ts.padEnd(10)} | ${tag} | ${meta.model.padEnd(11)} | ${mode.padEnd(6)} | ${String(status).padStart(4)} | ${ttfb.padStart(7)} | ${tok.padStart(5)} | ${tps.padStart(6)} | ${total.padStart(7)} |`,
  );
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
}

function observeStream(
  reqId: string,
  format: Format,
  meta: RequestMeta,
  status: number,
  requestSentAt: number,
  body: ReadableStream<Uint8Array>,
  contentEncoding: string | null,
  onEnd?: () => void,
): void {
  const compressed = contentEncoding !== null;
  const dumpOn = dumpEnabled();
  const sampleDecoder = new TextDecoder();
  const metrics = new StreamMetrics();
  let sseBuffer = "";
  let firstChunkAt = 0;
  let lastChunkAt = 0;
  let totalBytes = 0;
  let firstBytesSample = "";

  function parseSse(text: string, receivedAt: number): void {
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
      try {
        const j = JSON.parse(line.slice(5).trim());
        metrics.observe(j, receivedAt);
      } catch {}
    }
  }

  (async () => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        lastChunkAt = performance.now();
        if (firstChunkAt === 0) firstChunkAt = Date.now();
        if (dumpOn && value) {
          totalBytes += value.byteLength;
          if (firstBytesSample.length < 4096) {
            firstBytesSample += sampleDecoder.decode(value.slice(0, 4096 - firstBytesSample.length), { stream: true });
          }
        }
        if (!compressed) {
          sseBuffer += decoder.decode(value, { stream: true });
          const idx = sseBuffer.lastIndexOf("\n");
          if (idx >= 0) {
            parseSse(sseBuffer.slice(0, idx), lastChunkAt);
            sseBuffer = sseBuffer.slice(idx + 1);
          }
        }
      }
      if (!compressed && sseBuffer) parseSse(sseBuffer, lastChunkAt);
    } catch {}
    const endAt = Date.now();
    // Stream finished (or failed): the request is no longer in flight. Fired
    // exactly once from this reader loop — the single point that observes
    // SSE completion for every streaming response path.
    try { onEnd?.(); } catch {}
    const ttfbMs = (firstChunkAt > 0 ? firstChunkAt : endAt) - requestSentAt;
    const totalMs = endAt - requestSentAt;
    const tokens = metrics.tokens;
    const avgTps = metrics.tokensPerSecond;
    printRow(reqId, format, meta, status, requestSentAt, requestSentAt + ttfbMs, tokens, avgTps, endAt);
    if (dumpOn) {
      dumpPhase(reqId, "upstream_stream_summary", {
        status,
        contentEncoding,
        compressed,
        totalBytes,
        tokensObserved: tokens,
        generationMs: metrics.generationMs,
        tokensPerSecond: avgTps,
        ttfbMs,
        totalMs,
        firstBytesSample: firstBytesSample.length > 0 ? firstBytesSample.slice(0, 4096) : "(empty stream)",
      });
    }
  })().catch(() => {});
}
