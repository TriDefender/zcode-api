/**
 * Main proxy handler — routes requests, injects auth, forwards, and streams responses.
 *
 * **Translation mode**:
 * - coding-plan and start-plan both use an OpenAI-compatible upstream.
 * - Anthropic clients are translated Anthropic → OpenAI upstream → Anthropic
 *   response. OpenAI clients are already in the upstream's native format and
 *   pass through.
 *
 * @see .omo/plans/zcode-proxy.md Task 6
 */
import type { Format } from "../translator/types.js";
import type { ProxyConfig } from "../config/types.js";
import type { AuthManager } from "../auth/manager.js";
import { getProvider } from "../provider/providers.js";
import { buildUpstreamHeaderPairs, buildUpstreamRequest, type UpstreamHeaderPair } from "./upstream.js";
import { getDefaultEndpointRouting, type EndpointRoutingService } from "./endpoint-routing.js";
import { getDefaultClientSigning, sendWithClientSigning, type ClientSigningManager } from "./client-signing.js";
import { credentialString } from "../auth/types.js";
import { sendOrderedUpstreamRequest } from "./ordered-transport.js";
import { transformRequestBody } from "./body-transformer.js";
import { type ClientSessionResult } from "./client-session.js";
import { resolveSessionContext } from "./session-context.js";
import { gzipSync } from "node:zlib";

// captcha.ts is loaded lazily inside the `startPlan` branch (only path that
// touches it). The solver itself (captcha-happy.ts) is dynamically imported
// by captcha-solver.ts, so non-start-plan processes never pay its startup
// cost. Desktop Bun keeps the same code path; the dynamic import resolves
// synchronously enough on Bun's warm cache.
type CaptchaModule = typeof import("./captcha.js");
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
  const clientSession = resolveSessionContext({ clientReq, body, upstreamFormat, model: meta.model, config });
  if (debug && clientSession) {
    const shortSession = clientSession.sessionId ? clientSession.sessionId.slice(0, 10) : "-";
    debugLine(reqId, `clientIdentity source=${clientSession.source} action=${clientSession.action} confidence=${clientSession.confidence.toFixed(2)} session=${shortSession}`);
  }

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

  const transformedBody = transformRequestBody(upstreamBody, { format: upstreamFormat, userId: startPlan ? undefined : cred.userId, startPlan });
  if (debug && transformedBody !== upstreamBody) {
    debugLine(reqId, `body transformed (upstreamFormat=${upstreamFormat}, startPlan=${startPlan}, bytes=${transformedBody?.length ?? 0})`);
  }

  let captchaHeaders: Record<string, string> | undefined;
  if (startPlan) {
    try {
      const captcha = await loadCaptcha();
      const token = await captcha.getCaptchaToken(config.identity.appVersion);
      captchaHeaders = { [captcha.RETRY_HEADERS.PARAM]: token.verifyParam, [captcha.RETRY_HEADERS.REGION]: token.region };
    } catch {
      // Will solve on 403 fallback below
    }
  }

  const useOrderedTransport = shouldUseOrderedTransport(config, clientSession, hasCustomFetchImpl);
  let upstreamHeaderPairs = buildUpstreamHeaderPairs(clientReq, upstreamFormat, cred, config.identity, config.plan, captchaHeaders, clientSession);
  let upstreamReq = buildUpstreamRequest(clientReq, upstreamFormat, provider, cred, transformedBody, config.identity, config.plan, captchaHeaders, clientSession);

  const routing = opts.endpointRouting !== undefined ? opts.endpointRouting : getDefaultEndpointRouting(config);
  const signer = opts.clientSigning !== undefined ? opts.clientSigning : getDefaultClientSigning(config);
  const translateMode = translateOpenAIToAnthropic || translateAnthropicToOpenAI;
  const dispatch = async (req: Request, pairs: UpstreamHeaderPair[]): Promise<Response> => {
    let sendUrl = req.url;
    if (routing) {
      const routed = await routing.resolve(req.url, credentialString(cred));
      if (routed.routed) {
        sendUrl = routed.url;
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
      appVersion: config.identity.appVersion,
      debug: debug ? (message) => debugLine(reqId, message) : undefined,
      send: (finalPairs) => {
        const sendReq = sendUrl === req.url && finalPairs === pairs
          ? req
          : new Request(sendUrl, {
              method: req.method,
              headers: Object.fromEntries(finalPairs),
              body: transformedBody ?? undefined,
            });
        return sendUpstreamRequest(sendReq, finalPairs, transformedBody, translateMode, useOrderedTransport, fetchImpl, clientReq.signal, hasCustomFetchImpl);
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
    // Guard rails (review P1/P2 + nits): skip retry when the client already
    // aborted, and re-dispatch a FRESH Request each attempt — a reused
    // Request has its body stream marked used after the first fetch, so
    // attempt 2+ would throw "Request body already used" before any I/O
    // (start-plan hits the plain pass-through path where dispatch does NOT
    // rebuild the Request).
    const maxConnectAttempts = 3;
    for (let attempt = 1; ; attempt++) {
      if (clientReq.signal.aborted) throw new Error("client aborted before upstream connect");
      try {
        upstreamResp = await dispatch(upstreamReq, upstreamHeaderPairs);
        break;
      } catch (err) {
        if (attempt >= maxConnectAttempts) throw err;
        const backoffMs = 500 * attempt;
        if (debug) debugError(reqId, "upstream_connect_retry", `attempt ${attempt}/${maxConnectAttempts - 1} failed (${(err as Error).message}), retrying in ${backoffMs}ms`);
        console.log(`${reqId} upstream connect failed (${(err as Error).message}), retry ${attempt + 1}/${maxConnectAttempts} in ${backoffMs}ms`);
        await new Promise((r) => setTimeout(r, backoffMs));
        // Rebuild the Request so the body stream is fresh for the next
        // dispatch (mirrors the captcha retry, which already constructs a
        // new Request per attempt).
        upstreamReq = buildUpstreamRequest(clientReq, upstreamFormat, provider, cred, transformedBody, config.identity, config.plan, captchaHeaders, clientSession);
      }
    }
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

  // start-plan: on explicit captcha challenge, retry once with a fresh
  // pooled token (the challenged token was already consumed by this request;
  // getCaptchaToken takes the next pre-solved one). `&& captcha` looks
  // redundant but is required for TS null-narrowing.
  const captcha = startPlan ? await loadCaptcha() : null;
  let captchaChallenge = captcha ? captcha.detectCaptchaChallenge(upstreamResp) : null;
  // In-body challenge variant (observed 2026-08-29): the gateway sometimes
  // returns the challenge as HTTP 400 with {"code":3007,...} in the JSON body
  // instead of the captcha response header, so detectCaptchaChallenge never
  // fires and the client just gets a raw 502. Peek a clone of the body (error
  // responses are small; the original body stays untouched for the retry or
  // the error path) and treat it as a challenge too.
  if (!captchaChallenge && captcha && !upstreamResp.ok) {
    const ctype = upstreamResp.headers.get("content-type") ?? "";
    if (!ctype.includes("text/event-stream")) {
      try {
        const peek = await upstreamResp.clone().text();
        if (peek.includes('"code":3007') || peek.includes('"code": 3007')) {
          captchaChallenge = "in-body-3007";
        }
      } catch {}
    }
  }
  if (captchaChallenge && captcha) {
    if (debug) debugLine(reqId, "captcha challenge — re-solving and retrying once");
    try { upstreamResp.body?.cancel(); } catch {}
    console.log(`${reqId} captcha challenge, re-solving...`);
    try {
      const fresh = await captcha.getCaptchaToken(config.identity.appVersion);
      console.log(`${reqId} captcha re-solved (token ${fresh.verifyParam.length} chars), retrying...`);
      const retryHeaders = {
        [captcha.RETRY_HEADERS.PARAM]: fresh.verifyParam,
        [captcha.RETRY_HEADERS.REGION]: fresh.region,
      };
      upstreamHeaderPairs = buildUpstreamHeaderPairs(clientReq, upstreamFormat, cred, config.identity, config.plan, retryHeaders, clientSession);
      upstreamReq = buildUpstreamRequest(clientReq, upstreamFormat, provider, cred, transformedBody, config.identity, config.plan, retryHeaders, clientSession);
      upstreamResp = await dispatch(upstreamReq, upstreamHeaderPairs).catch((err: Error) => {
        if (debug) debugError(reqId, "upstream_unreachable", err.message);
        printRow(reqId, format, meta, 502, started, Date.now(), 0, 0, 0);
        return errorResponse(502, "upstream_unreachable", err.message);
      });
      if (debug) debugLine(reqId, `← retry ${upstreamResp.status} ${upstreamResp.statusText}`);
    } catch (err) {
      if (debug) debugError(reqId, "captcha_solver_failed", (err as Error).message);
      printRow(reqId, format, meta, 503, started, Date.now(), 0, 0, 0);
      return errorResponse(503, "captcha_solver_failed", (err as Error).message);
    }
  }

  const isSSE = upstreamResp.headers.get("content-type")?.includes("text/event-stream") ?? false;

  if (translateOpenAIToAnthropic) {
    if (!upstreamResp.ok) {
      const errBody = await upstreamResp.text().catch(() => "");
      printRow(reqId, format, meta, 502, started, headersAt, 0, 0, 0);
      return errorResponse(502, "translation_failed", `upstream returned ${upstreamResp.status}: ${errBody.slice(0, 200)}`);
    }
    if (isSSE && upstreamResp.body) {
      const translated = anthropicSseToOpenaiSse(upstreamResp.body, meta.model);
      const [clientBody, statsBody] = translated.tee();
      observeStream(reqId, format, meta, upstreamResp.status, started, statsBody, null);
      return translatedSseResponse(clientBody);
    }
    return await translatedBatchResponse(clientReq, upstreamResp, meta.model, reqId, format, meta, started, headersAt);
  }

  if (translateAnthropicToOpenAI) {
    if (!upstreamResp.ok) {
      const errBody = await upstreamResp.text().catch(() => "");
      printRow(reqId, format, meta, 502, started, headersAt, 0, 0, 0);
      return errorResponse(502, "translation_failed", `upstream returned ${upstreamResp.status}: ${errBody.slice(0, 200)}`);
    }
    if (isSSE && upstreamResp.body) {
      const translated = openaiSseToAnthropicSse(upstreamResp.body, meta.model);
      const [clientBody, statsBody] = translated.tee();
      observeStream(reqId, format, meta, upstreamResp.status, started, statsBody, null);
      return translatedSseResponse(clientBody);
    }
    return await translatedOpenAIToAnthropicBatchResponse(clientReq, upstreamResp, reqId, format, meta, started, headersAt);
  }

  if (isSSE && upstreamResp.body) {
    const [clientBody, statsBody] = upstreamResp.body.tee();
    observeStream(reqId, format, meta, upstreamResp.status, started, statsBody, upstreamResp.headers.get("content-encoding"));
    return passthroughResponse(upstreamResp, clientAcceptsGzip(clientReq), clientBody);
  }

  printRow(reqId, format, meta, upstreamResp.status, started, headersAt, 0, 0, 0);
  return passthroughResponse(upstreamResp, clientAcceptsGzip(clientReq));
}

export function shouldUseOrderedTransport(config: ProxyConfig, clientSession: ClientSessionResult | undefined, hasCustomFetchImpl: boolean): boolean {
  if (hasCustomFetchImpl) return false;
  return clientSession?.action === "enforce" || clientSession?.source === "explicit";
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
  const gunzip = new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const reader = source.pipeThrough(gunzip).getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_INFLATED_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new InflatedBodyTooLargeError(MAX_INFLATED_BODY_BYTES);
      }
      parts.push(value);
    }
  } catch (err) {
    if (err instanceof InflatedBodyTooLargeError) throw err;
    throw new Error(`request body is marked content-encoding: gzip but failed to decompress: ${(err as Error).message}`);
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(parts);
}

/**
 * Create a passthrough response that streams the upstream body to the client.
 * Preserves status and the allowlisted headers, and honors the client's
 * `Accept-Encoding` for gzip.
 *
 * The upstream request always advertises `accept-encoding: gzip` (see
 * `buildUpstreamHeaderPairs`), so the upstream typically returns a gzip body.
 * If THIS client did not advertise gzip, we decompress before forwarding and
 * drop the now-mismatched `content-encoding`/`content-length` headers —
 * otherwise clients whose HTTP stack does not auto-decompress (e.g. some
 * Tauri-based clients) receive raw gzip bytes and fail to parse the JSON
 * body with "non-JSON body" errors despite a 200 status.
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
): void {
  const compressed = contentEncoding !== null;
  const dumpOn = dumpEnabled();
  let tokens = 0;
  let sseBuffer = "";
  let firstChunkAt = 0;
  let totalBytes = 0;
  let firstBytesSample = "";

  function parseSse(text: string): void {
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
      try {
        const j = JSON.parse(line.slice(5).trim());
        if (j.usage?.completion_tokens) { tokens = j.usage.completion_tokens; continue; }
        if (j.usage?.output_tokens) { tokens = j.usage.output_tokens; continue; }
        // OpenAI content delta: choices[0].delta.content
        const oai = j.choices?.[0]?.delta?.content;
        if (typeof oai === "string" && oai.length > 0) { tokens++; continue; }
        // Anthropic content delta: type=content_block_delta, delta.type=text_delta
        if (j.type === "content_block_delta" && j.delta?.type === "text_delta") {
          const t = j.delta?.text;
          if (typeof t === "string" && t.length > 0) tokens++;
        }
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
        if (firstChunkAt === 0) firstChunkAt = Date.now();
        if (dumpOn && value) {
          totalBytes += value.byteLength;
          if (firstBytesSample.length < 4096) {
            firstBytesSample += decoder.decode(value.slice(0, 4096 - firstBytesSample.length), { stream: true });
          }
        }
        if (!compressed) {
          sseBuffer += decoder.decode(value, { stream: true });
          const idx = sseBuffer.lastIndexOf("\n");
          if (idx >= 0) {
            parseSse(sseBuffer.slice(0, idx));
            sseBuffer = sseBuffer.slice(idx + 1);
          }
        }
      }
      if (!compressed && sseBuffer) parseSse(sseBuffer);
    } catch {}
    const endAt = Date.now();
    const ttfbMs = (firstChunkAt > 0 ? firstChunkAt : endAt) - requestSentAt;
    const totalMs = endAt - requestSentAt;
    const avgTps = tokens > 0 && totalMs > 0 ? tokens / (totalMs / 1000) : 0;
    printRow(reqId, format, meta, status, requestSentAt, requestSentAt + ttfbMs, tokens, avgTps, endAt);
    if (dumpOn) {
      dumpPhase(reqId, "upstream_stream_summary", {
        status,
        contentEncoding,
        compressed,
        totalBytes,
        tokensObserved: tokens,
        ttfbMs,
        totalMs,
        firstBytesSample: firstBytesSample.length > 0 ? firstBytesSample.slice(0, 4096) : "(empty stream)",
      });
    }
  })().catch(() => {});
}
