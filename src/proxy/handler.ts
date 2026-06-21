/**
 * Main proxy handler — routes requests, injects auth, forwards, and streams responses.
 * @see .omo/plans/zcode-proxy.md Task 6
 */
import type { Format } from "../translator/types.js";
import { randomUUID } from "node:crypto";
import type { ProxyConfig, ProxyIdentity } from "../config/types.js";
import type { AuthManager } from "../auth/manager.js";
import type { AccountPool } from "../auth/account-pool.js";
import type { ProviderDef } from "../provider/types.js";
import type { Credential } from "../auth/types.js";
import { getProvider } from "../provider/providers.js";
import { buildUpstreamRequest } from "./upstream.js";
import { transformRequestBody } from "./body-transformer.js";
import {
  detectCaptchaChallenge,
  getProactiveCaptchaHeaders,
  invalidateJsdomCaptcha,
  solveCaptcha,
  RETRY_HEADERS,
} from "./captcha.js";
import { normalizeStartPlanBody } from "./start-plan-body.js";
import { bridgeAnthropicResponse, bridgeOpenAIRequest } from "./format-bridge.js";
import { anthropicSseToResponsesSse, anthropicMessageToResponses, responsesLifecycleEvents } from "./responses-bridge.js";
import { anthropicSseToOpenaiSse } from "../translator/sse-translator.js";
import { classifyUpstreamFailure } from "./upstream-errors.js";
import type { RequestLogStore, RequestTokenUsage } from "../server/request-logs.js";
import { mergeTokenUsage, normalizeTokenUsage, usageFromResponseBody, usageFromSsePayload } from "../server/request-logs.js";

/** Options for the proxy handler. */
export interface ProxyHandlerOptions {
  config: ProxyConfig;
  auth: AuthManager;
  accountPool?: AccountPool;
  requestLogs?: RequestLogStore;
  /** Override the global fetch (for testing). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Translate Anthropic upstream responses to OpenAI Responses API (Codex). */
  responseBridge?: "responses";
}

/**
 * Forward a client request to the upstream provider with injected auth.
 *
 * Uses `decompress: false` on the upstream fetch so compressed response bodies
 * (gzip/deflate/br) pass through untouched — the raw bytes and Content-Encoding
 * header are forwarded as-is, letting the client handle decompression.
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
  const { config, auth, accountPool, requestLogs, responseBridge } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const started = Date.now();
  const reqId = nextReqId();

  const body = await readBody(clientReq);
  const meta = peekBody(body);

  const staticProvider = getProvider(config.provider);
  const provider = {
    ...staticProvider,
    anthropicBaseURL: config.providers[config.provider].anthropicBase,
    openaiBaseURL: config.providers[config.provider].openaiBase,
  };

  const usePool =
    config.plan === "start-plan" &&
    config.pool?.enabled !== false &&
    accountPool &&
    accountPool.activeCount() > 0;

  if (usePool && accountPool) {
    return proxyRequestWithPool({
      clientReq,
      format,
      config,
      provider,
      accountPool,
      fetchImpl,
      body,
      meta,
      reqId,
      started,
      requestLogs,
      responseBridge,
    });
  }

  let cred;
  try {
    cred = await auth.getCredential();
  } catch (err) {
    recordRequest(reqId, format, meta, 503, started, Date.now(), 0, 0, 0, { requestLogs });
    return errorResponse(503, "credential_unavailable", (err as Error).message);
  }

  return (await proxyRequestWithCredential({
    clientReq,
    format,
    config,
    provider,
    cred,
    fetchImpl,
    body,
    meta,
    reqId,
    started,
    requestLogs,
    responseBridge,
  })).response;
}

async function proxyRequestWithPool(opts: {
  clientReq: Request;
  format: Format;
  config: ProxyConfig;
  provider: ProviderDef;
  accountPool: AccountPool;
  fetchImpl: typeof fetch;
  body: string | undefined;
  meta: RequestMeta;
  reqId: string;
  started: number;
  requestLogs?: RequestLogStore;
  responseBridge?: "responses";
}): Promise<Response> {
  const maxAttempts = opts.config.pool?.maxAccountAttempts ?? 5;
  const excludeIds: string[] = [];

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const account = opts.accountPool.acquire(excludeIds);
    if (!account) break;

    console.log(`${opts.reqId} pool → ${account.userId ?? account.id.slice(0, 8)}`);

    const cred = opts.accountPool.toCredential(account);
    const logCtx = {
      requestLogs: opts.requestLogs,
      accountId: account.id,
      accountUserId: account.userId,
    };
    const result = await proxyRequestWithCredential({
      ...opts,
      cred,
      ...logCtx,
    });

    if (result.outcome === "success") {
      opts.accountPool.release(account.id);
      return result.response;
    }

    excludeIds.push(account.id);
    const msg = result.message ?? "upstream error";

    if (result.outcome === "quota") {
      opts.accountPool.markExhausted(account.id, msg);
      console.log(`${opts.reqId} account ${account.name} quota exhausted, trying next...`);
      continue;
    }
    if (result.outcome === "blocked") {
      opts.accountPool.markBlocked(account.id, msg);
      console.log(`${opts.reqId} account ${account.name} blocked (3012), trying next...`);
      continue;
    }
    if (result.outcome === "auth") {
      opts.accountPool.markAuthError(account.id, msg);
      console.log(`${opts.reqId} account ${account.name} JWT invalid, trying next...`);
      continue;
    }
    if (result.outcome === "captcha") {
      console.log(`${opts.reqId} captcha failed on ${account.name}, trying next account...`);
      continue;
    }

    return result.response;
  }

  recordRequest(opts.reqId, opts.format, opts.meta, 503, opts.started, Date.now(), 0, 0, 0, {
    requestLogs: opts.requestLogs,
  });
  return errorResponse(
    503,
    "no_available_account",
    `All ${excludeIds.length} pool account(s) failed or exhausted. Run: auth accounts`,
  );
}

type ProxyOutcome =
  | { outcome: "success"; response: Response }
  | { outcome: "quota" | "blocked" | "auth" | "captcha" | "error"; response: Response; message: string };

function responsesStreamHeaders(): Headers {
  const headers = new Headers();
  headers.set("content-type", "text/event-stream; charset=utf-8");
  headers.set("cache-control", "no-cache");
  headers.set("connection", "keep-alive");
  return headers;
}

function proxyResponsesEarlyStream(opts: {
  clientReq: Request;
  format: Format;
  config: ProxyConfig;
  provider: ProviderDef;
  cred: Credential;
  fetchImpl: typeof fetch;
  bridge: ReturnType<typeof bridgeOpenAIRequest>;
  upstreamBody: string | undefined;
  meta: RequestMeta;
  reqId: string;
  started: number;
  logCtx: RowLogCtx;
}): ProxyOutcome {
  const {
    clientReq, config, provider, cred, fetchImpl, bridge, upstreamBody,
    meta, reqId, started, logCtx, format,
  } = opts;
  const responseId = `resp_${randomUUID().slice(0, 12)}`;
  const encoder = new TextEncoder();
  const abort = new AbortController();
  let clientGone = false;

  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      clientGone = true;
      abort.abort();
    },
    async start(controller) {
      const safeEnqueue = (chunk: Uint8Array): boolean => {
        if (clientGone) return false;
        try {
          controller.enqueue(chunk);
          return true;
        } catch {
          clientGone = true;
          abort.abort();
          return false;
        }
      };

      safeEnqueue(encoder.encode(responsesLifecycleEvents(responseId, meta.model)));

      const keepalive = setInterval(() => {
        if (!safeEnqueue(encoder.encode(": keepalive\n\n"))) {
          clearInterval(keepalive);
        }
      }, 2000);

      const emitError = (message: string, type = "api_error") => {
        safeEnqueue(encoder.encode(
          `event: error\ndata: ${JSON.stringify({ type: "error", error: { type, message } })}\n\n`,
        ));
      };

      const safeClose = () => {
        clearInterval(keepalive);
        if (!clientGone) {
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      };

      try {
        let captchaHeaders: Record<string, string> = {};
        if (config.plan === "start-plan") {
          try {
            captchaHeaders = await getProactiveCaptchaHeaders(config.identity.appVersion);
            console.log(`${reqId} proactive captcha ready (${captchaHeaders[RETRY_HEADERS.PARAM]?.length ?? 0} chars)`);
          } catch (err) {
            recordRequest(reqId, format, meta, 503, started, Date.now(), 0, 0, 0, logCtx);
            emitError((err as Error).message, "captcha_solve_failed");
            safeClose();
            return;
          }
        }

        if (clientGone) return;

        let upstreamReq: Request;
        try {
          upstreamReq = buildUpstreamRequest(
            clientReq,
            bridge.upstreamFormat,
            provider,
            cred,
            upstreamBody,
            config.identity,
            config.plan,
            captchaHeaders,
          );
        } catch (err) {
          recordRequest(reqId, format, meta, 500, started, Date.now(), 0, 0, 0, logCtx);
          emitError((err as Error).message, "configuration_error");
          safeClose();
          return;
        }

        let upstreamResp: Response;
        try {
          upstreamResp = await fetchImpl(upstreamReq, { decompress: false, signal: abort.signal });
        } catch (err) {
          if (clientGone || abort.signal.aborted) return;
          recordRequest(reqId, format, meta, 502, started, Date.now(), 0, 0, 0, logCtx);
          emitError((err as Error).message, "upstream_unreachable");
          safeClose();
          return;
        }
        const headersAt = Date.now();

        if (config.plan === "start-plan") {
          const blocked = await readAccountBlock(upstreamResp);
          if (blocked) {
            try { upstreamResp.body?.cancel(); } catch {}
            emitError("Account blocked (3012)", "account_blocked");
            safeClose();
            return;
          }

          const retried = await retryStartPlanIfNeeded({
            fetchImpl,
            clientReq,
            upstreamFormat: bridge.upstreamFormat,
            provider,
            cred,
            upstreamBody,
            identity: config.identity,
            reqId,
            upstreamResp,
          });
          if (retried.error) {
            if (clientGone) return;
            const errText = await retried.error.clone().text().catch(() => "error");
            emitError(errText);
            safeClose();
            return;
          }
          upstreamResp = retried.response;
        }

        const failureKind = await classifyUpstreamFailure(upstreamResp, isCaptchaFailure);
        if (failureKind !== "ok") {
          if (clientGone) return;
          const errText = await upstreamResp.clone().text().catch(() => "upstream error");
          emitError(errText);
          safeClose();
          return;
        }

        if (!upstreamResp.body) {
          recordRequest(reqId, format, meta, upstreamResp.status, started, headersAt, 0, 0, 0, logCtx);
          safeClose();
          return;
        }

        const translated = anthropicSseToResponsesSse(upstreamResp.body, meta.model, {
          responseId,
          skipLifecycle: true,
        });
        const [clientBody, statsBody] = translated.tee();
        observeStream(reqId, format, meta, upstreamResp.status, started, statsBody, undefined, logCtx);
        const reader = clientBody.getReader();
        while (!clientGone) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || !safeEnqueue(value)) break;
        }
        try {
          await reader.cancel();
        } catch {}
      } catch (err) {
        if (!clientGone) emitError((err as Error).message);
      } finally {
        safeClose();
      }
    },
  });

  return {
    outcome: "success",
    response: new Response(stream, { status: 200, headers: responsesStreamHeaders() }),
  };
}

async function proxyRequestWithCredential(opts: {
  clientReq: Request;
  format: Format;
  config: ProxyConfig;
  provider: ProviderDef;
  cred: Credential;
  fetchImpl: typeof fetch;
  body: string | undefined;
  meta: RequestMeta;
  reqId: string;
  started: number;
  requestLogs?: RequestLogStore;
  accountId?: string;
  accountUserId?: string;
  responseBridge?: "responses";
}): Promise<ProxyOutcome> {
  const { config, cred, fetchImpl, clientReq, format, provider, body, meta, reqId, started, requestLogs, accountId, accountUserId, responseBridge } = opts;
  const logCtx = { requestLogs, accountId, accountUserId };

  let bridge;
  try {
    bridge = bridgeOpenAIRequest(body, format, config.plan);
  } catch {
    recordRequest(reqId, format, meta, 400, started, Date.now(), 0, 0, 0, logCtx);
    return {
      outcome: "error",
      response: errorResponse(400, "invalid_request_error", "Invalid JSON in OpenAI chat request body"),
      message: "invalid json",
    };
  }

  const transformedBody = transformRequestBody(bridge.body, {
    format: bridge.upstreamFormat,
    plan: config.plan,
    userId: cred.userId,
  });
  const upstreamBody =
    config.plan === "start-plan" ? normalizeStartPlanBody(transformedBody) : transformedBody;

  // Codex times out if no SSE bytes arrive during captcha/upstream TTFB — flush lifecycle first.
  if (responseBridge === "responses" && meta.stream !== false) {
    return proxyResponsesEarlyStream({
      clientReq,
      format,
      config,
      provider,
      cred,
      fetchImpl,
      bridge,
      upstreamBody,
      meta,
      reqId,
      started,
      logCtx,
    });
  }

  let captchaHeaders: Record<string, string> = {};
  if (config.plan === "start-plan") {
    try {
      captchaHeaders = await getProactiveCaptchaHeaders(config.identity.appVersion);
      console.log(`${reqId} proactive captcha ready (${captchaHeaders[RETRY_HEADERS.PARAM]?.length ?? 0} chars)`);
    } catch (err) {
      recordRequest(reqId, format, meta, 503, started, Date.now(), 0, 0, 0, logCtx);
      return {
        outcome: "error",
        response: errorResponse(503, "captcha_solve_failed", (err as Error).message),
        message: (err as Error).message,
      };
    }
  }

  let upstreamReq: Request;
  try {
    upstreamReq = buildUpstreamRequest(
      clientReq,
      bridge.upstreamFormat,
      provider,
      cred,
      upstreamBody,
      config.identity,
      config.plan,
      captchaHeaders,
    );
  } catch (err) {
    recordRequest(reqId, format, meta, 500, started, Date.now(), 0, 0, 0, logCtx);
    return {
      outcome: "error",
      response: errorResponse(500, "configuration_error", (err as Error).message),
      message: (err as Error).message,
    };
  }

  let upstreamResp: Response;
  try {
    upstreamResp = await fetchImpl(upstreamReq, { decompress: false });
  } catch (err) {
    recordRequest(reqId, format, meta, 502, started, Date.now(), 0, 0, 0, logCtx);
    return {
      outcome: "error",
      response: errorResponse(502, "upstream_unreachable", (err as Error).message),
      message: (err as Error).message,
    };
  }
  const headersAt = Date.now();

  if (config.plan === "start-plan") {
    const blocked = await readAccountBlock(upstreamResp);
    if (blocked) {
      try { upstreamResp.body?.cancel(); } catch {}
      return {
        outcome: "blocked",
        response: errorResponse(405, "account_blocked", "Account blocked (3012)"),
        message: "3012",
      };
    }

    const retried = await retryStartPlanIfNeeded({
      fetchImpl,
      clientReq,
      upstreamFormat: bridge.upstreamFormat,
      provider,
      cred,
      upstreamBody,
      identity: config.identity,
      reqId,
      upstreamResp,
    });
    if (retried.error) {
      const kind = await classifyUpstreamFailure(retried.error, isCaptchaFailure);
      return {
        outcome: kind === "ok" ? "error" : kind,
        response: retried.error,
        message: await retried.error.clone().text().catch(() => "error"),
      };
    }
    upstreamResp = retried.response;
  }

  const failureKind = await classifyUpstreamFailure(upstreamResp, isCaptchaFailure);
  if (failureKind !== "ok") {
    const errText = await upstreamResp.clone().text().catch(() => "");
    if (failureKind === "auth") {
      return { outcome: "auth", response: passthroughResponse(upstreamResp), message: errText };
    }
    if (failureKind === "quota") {
      return { outcome: "quota", response: passthroughResponse(upstreamResp), message: errText };
    }
    if (failureKind === "blocked") {
      return { outcome: "blocked", response: passthroughResponse(upstreamResp), message: errText };
    }
    if (failureKind === "captcha") {
      return { outcome: "captcha", response: passthroughResponse(upstreamResp), message: errText };
    }
    recordRequest(reqId, format, meta, upstreamResp.status, started, headersAt, 0, 0, 0, logCtx);
    return { outcome: "error", response: passthroughResponse(upstreamResp), message: errText };
  }

  const isSSE = upstreamResp.headers.get("content-type")?.includes("text/event-stream") ?? false;

  if (isSSE && upstreamResp.body) {
    if (responseBridge === "responses") {
      const translated = anthropicSseToResponsesSse(upstreamResp.body, meta.model);
      const [clientBody, statsBody] = translated.tee();
      observeStream(reqId, format, meta, upstreamResp.status, started, statsBody, undefined, logCtx);
      const headers = new Headers();
      headers.set("content-type", "text/event-stream; charset=utf-8");
      headers.set("cache-control", "no-cache");
      return {
        outcome: "success",
        response: new Response(clientBody, { status: upstreamResp.status, headers }),
      };
    }
    if (bridge.translateResponse) {
      const translated = anthropicSseToOpenaiSse(upstreamResp.body, meta.model);
      const [clientBody, statsBody] = translated.tee();
      observeStream(reqId, format, meta, upstreamResp.status, started, statsBody, undefined, logCtx);
      const headers = new Headers(upstreamResp.headers);
      headers.set("content-type", "text/event-stream; charset=utf-8");
      headers.delete("content-encoding");
      return {
        outcome: "success",
        response: new Response(clientBody, { status: upstreamResp.status, headers }),
      };
    }
    const [clientBody, statsBody] = upstreamResp.body.tee();
    observeStream(reqId, format, meta, upstreamResp.status, started, statsBody, upstreamResp.headers.get("content-encoding"), logCtx);
    return { outcome: "success", response: passthroughResponse(upstreamResp, clientBody) };
  }

  const text = await upstreamResp.text();
  let usage = normalizeTokenUsage(null);
  try {
    usage = normalizeTokenUsage(usageFromResponseBody(JSON.parse(text)));
  } catch {
    // non-JSON body
  }
  const endAt = Date.now();
  const totalMs = endAt - started;
  const avgTps = usage.outputTokens > 0 && totalMs > 0 ? usage.outputTokens / (totalMs / 1000) : 0;
  recordRequest(
    reqId,
    format,
    meta,
    upstreamResp.status,
    started,
    headersAt,
    usage.outputTokens,
    avgTps,
    endAt,
    logCtx,
    usage,
  );

  const rebuilt = new Response(text, { status: upstreamResp.status, headers: upstreamResp.headers });
  if (responseBridge === "responses") {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (parsed.type === "message") {
        return {
          outcome: "success",
          response: new Response(JSON.stringify(anthropicMessageToResponses(parsed, meta.model)), {
            status: upstreamResp.status,
            headers: { "content-type": "application/json" },
          }),
        };
      }
    } catch {
      // fall through
    }
    return { outcome: "success", response: rebuilt };
  }
  if (bridge.translateResponse) {
    return { outcome: "success", response: await bridgeAnthropicResponse(rebuilt, meta.model) };
  }
  return { outcome: "success", response: rebuilt };
}

async function retryStartPlanIfNeeded(opts: {
  fetchImpl: typeof fetch;
  clientReq: Request;
  upstreamFormat: Format;
  provider: ProviderDef;
  cred: Credential;
  upstreamBody: string | undefined;
  identity: ProxyIdentity;
  reqId: string;
  upstreamResp: Response;
}): Promise<{ response: Response; error?: Response }> {
  const needsRetry =
    detectCaptchaChallenge(opts.upstreamResp) !== null ||
    (await isCaptchaFailure(opts.upstreamResp));

  if (!needsRetry) {
    return { response: opts.upstreamResp };
  }

  try {
    opts.upstreamResp.body?.cancel();
  } catch {}

  console.log(`${opts.reqId} captcha rejected — re-solving traceless and retrying once...`);
  invalidateJsdomCaptcha();

  let captchaHeaders: Record<string, string>;
  try {
    captchaHeaders = await getProactiveCaptchaHeaders(opts.identity.appVersion);
  } catch (err) {
    return {
      response: opts.upstreamResp,
      error: errorResponse(503, "captcha_solve_failed", (err as Error).message),
    };
  }

  const challenge = detectCaptchaChallenge(opts.upstreamResp);
  if (challenge) {
    try {
      const { verifyParam, region } = await solveCaptcha(challenge, opts.identity.appVersion);
      captchaHeaders = {
        [RETRY_HEADERS.PARAM]: verifyParam,
        [RETRY_HEADERS.REGION]: region,
      };
    } catch (err) {
      return {
        response: opts.upstreamResp,
        error: errorResponse(503, "captcha_solve_failed", (err as Error).message),
      };
    }
  }

  const upstreamReq = buildUpstreamRequest(
    opts.clientReq,
    opts.upstreamFormat,
    opts.provider,
    opts.cred,
    opts.upstreamBody,
    opts.identity,
    "start-plan",
    captchaHeaders,
  );

  try {
    const upstreamResp = await opts.fetchImpl(upstreamReq, { decompress: false });
    if (await readAccountBlock(upstreamResp)) {
      try {
        upstreamResp.body?.cancel();
      } catch {}
      return {
        response: upstreamResp,
        error: errorResponse(405, "account_blocked", "Account blocked (3012). Use a fresh ZCode login."),
      };
    }
    if (detectCaptchaChallenge(upstreamResp) || (await isCaptchaFailure(upstreamResp))) {
      try {
        upstreamResp.body?.cancel();
      } catch {}
      return {
        response: upstreamResp,
        error: errorResponse(
          403,
          "captcha_verification_failed",
          "Captcha was solved but upstream still rejected the token",
        ),
      };
    }
    return { response: upstreamResp };
  } catch (err) {
    return {
      response: opts.upstreamResp,
      error: errorResponse(502, "upstream_unreachable", (err as Error).message),
    };
  }
}

/** 3012 = abuse block — never treat as captcha retry. */
async function readAccountBlock(resp: Response): Promise<boolean> {
  if (resp.status !== 405) return false;
  const text = await resp.clone().text().catch(() => "");
  return text.includes("3012");
}

/** Narrow captcha detection — avoid masking unrelated 403s (PR review #3). */
async function isCaptchaFailure(resp: Response): Promise<boolean> {
  if (detectCaptchaChallenge(resp)) return true;
  const text = await resp.clone().text().catch(() => "");
  const low = text.toLowerCase();
  if (low.includes("3012")) return false;
  return low.includes("3007") || (low.includes("captcha") && resp.status === 403);
}

/** Read the request body as a string, returning undefined for empty bodies. */
async function readBody(req: Request): Promise<string | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const text = await req.text();
  if (text.length === 0) return undefined;
  return text;
}

/**
 * Create a passthrough response that streams the upstream body to the client.
 * Preserves status, headers, and body stream.
 */
function passthroughResponse(upstream: Response, body?: ReadableStream<Uint8Array>): Response {
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

  return new Response(body ?? upstream.body, {
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

function nextReqId(): string {
  return `#${String(++reqCounter).padStart(3, "0")}`;
}

function printHeader(): void {
  if (headerPrinted) return;
  headerPrinted = true;
  console.log(
    "| #    | Time       | Fmt | Model       | Mode   | Stat |    TTFB |    In |   Out | Cache |  tok/s |   Total |",
  );
  console.log(
    "|------|------------|-----|-------------|--------|------|---------|-------|-------|-------|--------|---------|",
  );
}

interface RowLogCtx {
  requestLogs?: RequestLogStore;
  accountId?: string;
  accountUserId?: string;
}

function recordRequest(
  reqId: string,
  format: Format,
  meta: RequestMeta,
  status: number,
  started: number,
  headersAt: number,
  tokens: number,
  avgTps: number,
  streamEndAt: number,
  ctx: RowLogCtx = {},
  tokenUsage?: Partial<RequestTokenUsage>,
): void {
  const usage = mergeTokenUsage(
    {
      inputTokens: 0,
      outputTokens: tokens,
      cachedTokens: 0,
      reasoningTokens: 0,
    },
    tokenUsage,
  );
  if (usage.outputTokens === 0 && tokens > 0) {
    usage.outputTokens = tokens;
  }
  printRow(reqId, format, meta, status, started, headersAt, usage, avgTps, streamEndAt);
  ctx.requestLogs?.append({
    id: reqId,
    format,
    model: meta.model,
    stream: meta.stream,
    status,
    ttfbMs: Math.max(0, headersAt - started),
    tokens: usage.outputTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedTokens: usage.cachedTokens,
    reasoningTokens: usage.reasoningTokens,
    tokPerSec: avgTps,
    totalMs: streamEndAt > started ? streamEndAt - started : Math.max(0, headersAt - started),
    accountId: ctx.accountId,
    accountUserId: ctx.accountUserId,
  });
}

function printRow(
  reqId: string,
  format: Format,
  meta: RequestMeta,
  status: number,
  started: number,
  headersAt: number,
  usage: RequestTokenUsage,
  avgTps: number,
  streamEndAt: number,
): void {
  printHeader();
  const ts = new Date(started).toISOString().slice(11, 19);
  const tag = format === "anthropic" ? "ANT" : "OAI";
  const mode = meta.stream ? "stream" : "batch";
  const ttfb = `${headersAt - started}ms`;
  const total = streamEndAt > started ? `${streamEndAt - started}ms` : "-";
  const outTok = usage.outputTokens > 0 ? String(usage.outputTokens) : "-";
  const inTok = usage.inputTokens > 0 ? String(usage.inputTokens) : "-";
  const cacheTok = usage.cachedTokens > 0 ? String(usage.cachedTokens) : "-";
  const tps = avgTps > 0 ? avgTps.toFixed(1) : "-";
  console.log(
    `| ${reqId.padEnd(4)} | ${ts.padEnd(10)} | ${tag} | ${meta.model.padEnd(11)} | ${mode.padEnd(6)} | ${String(status).padStart(4)} | ${ttfb.padStart(7)} | ${inTok.padStart(5)} | ${outTok.padStart(5)} | ${cacheTok.padStart(5)} | ${tps.padStart(6)} | ${total.padStart(7)} |`,
  );
}

function observeStream(
  reqId: string,
  format: Format,
  meta: RequestMeta,
  status: number,
  requestSentAt: number,
  body: ReadableStream<Uint8Array>,
  contentEncoding: string | null,
  ctx: RowLogCtx = {},
): void {
  const compressed = contentEncoding !== null;
  let usage: RequestTokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
  };
  let outputChunks = 0;
  let sseBuffer = "";
  let firstChunkAt = 0;

  function parseSse(text: string): void {
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
      try {
        const j = JSON.parse(line.slice(5).trim());
        usage = mergeTokenUsage(usage, usageFromSsePayload(j));
        if (j.usage?.completion_tokens) { outputChunks = j.usage.completion_tokens; continue; }
        if (j.usage?.output_tokens) { outputChunks = j.usage.output_tokens; continue; }
        const oai = j.choices?.[0]?.delta?.content;
        if (typeof oai === "string" && oai.length > 0) { outputChunks++; continue; }
        if (j.type === "content_block_delta" && j.delta?.type === "text_delta") {
          const t = j.delta?.text;
          if (typeof t === "string" && t.length > 0) outputChunks++;
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
    if (usage.outputTokens === 0 && outputChunks > 0) {
      usage.outputTokens = outputChunks;
    }
    const avgTps = usage.outputTokens > 0 && totalMs > 0 ? usage.outputTokens / (totalMs / 1000) : 0;
    recordRequest(
      reqId,
      format,
      meta,
      status,
      requestSentAt,
      requestSentAt + ttfbMs,
      usage.outputTokens,
      avgTps,
      endAt,
      ctx,
      usage,
    );
  })().catch(() => {});
}
