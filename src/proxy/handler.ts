/**
 * Main proxy handler — routes requests, injects auth, forwards, and streams responses.
 * @see .omo/plans/zcode-proxy.md Task 6
 */
import type { Format } from "../translator/types.js";
import type { ProxyConfig } from "../config/types.js";
import type { AuthManager } from "../auth/manager.js";
import type { ProviderDef } from "../provider/types.js";
import type { Credential } from "../auth/types.js";
import type { ProxyIdentity } from "../config/types.js";
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

/** Options for the proxy handler. */
export interface ProxyHandlerOptions {
  config: ProxyConfig;
  auth: AuthManager;
  /** Override the global fetch (for testing). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
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
  const { config, auth } = opts;
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

  let cred;
  try {
    cred = await auth.getCredential();
  } catch (err) {
    printRow(reqId, format, meta, 503, started, Date.now(), 0, 0, 0);
    return errorResponse(503, "credential_unavailable", (err as Error).message);
  }

  // start-plan only exposes the Anthropic endpoint (OpenAI path returns 404).
  // Reject OpenAI-format requests early with a clear message.
  if (config.plan === "start-plan" && format === "openai") {
    printRow(reqId, format, meta, 400, started, Date.now(), 0, 0, 0);
    return errorResponse(400, "unsupported_format", "start-plan only supports the Anthropic API format. Use POST /v1/messages instead of /v1/chat/completions.");
  }

  const transformedBody = transformRequestBody(body, {
    format,
    plan: config.plan,
    userId: cred.userId,
  });

  let captchaHeaders: Record<string, string> = {};
  if (config.plan === "start-plan") {
    try {
      captchaHeaders = await getProactiveCaptchaHeaders();
      console.log(`${reqId} proactive captcha ready (${captchaHeaders[RETRY_HEADERS.PARAM]?.length ?? 0} chars)`);
    } catch (err) {
      printRow(reqId, format, meta, 503, started, Date.now(), 0, 0, 0);
      return errorResponse(503, "captcha_solve_failed", (err as Error).message);
    }
  }

  let upstreamReq = buildUpstreamRequest(
    clientReq,
    format,
    provider,
    cred,
    transformedBody,
    config.identity,
    config.plan,
    captchaHeaders,
  );

  let upstreamResp: Response;
  try {
    upstreamResp = await fetchImpl(upstreamReq, { decompress: false });
  } catch (err) {
    printRow(reqId, format, meta, 502, started, Date.now(), 0, 0, 0);
    return errorResponse(502, "upstream_unreachable", (err as Error).message);
  }
  const headersAt = Date.now();

  if (upstreamResp.status === 401 && config.plan === "start-plan") {
    printRow(reqId, format, meta, 401, started, headersAt, 0, 0, 0);
    return errorResponse(401, "start_plan_jwt_invalid", "Start-plan JWT was rejected. Re-run: zcode-proxy auth login");
  }

  if (config.plan === "start-plan") {
    const retried = await retryStartPlanIfNeeded({
      fetchImpl,
      clientReq,
      format,
      provider,
      cred,
      transformedBody,
      identity: config.identity,
      reqId,
      upstreamResp,
    });
    if (retried.error) {
      printRow(reqId, format, meta, retried.error.status, started, Date.now(), 0, 0, 0);
      return retried.error;
    }
    upstreamResp = retried.response;
  }

  const isSSE = upstreamResp.headers.get("content-type")?.includes("text/event-stream") ?? false;

  if (isSSE && upstreamResp.body) {
    const [clientBody, statsBody] = upstreamResp.body.tee();
    observeStream(reqId, format, meta, upstreamResp.status, started, statsBody, upstreamResp.headers.get("content-encoding"));
    return passthroughResponse(upstreamResp, clientBody);
  }

  printRow(reqId, format, meta, upstreamResp.status, started, headersAt, 0, 0, 0);
  return passthroughResponse(upstreamResp);
}

async function retryStartPlanIfNeeded(opts: {
  fetchImpl: typeof fetch;
  clientReq: Request;
  format: Format;
  provider: ProviderDef;
  cred: Credential;
  transformedBody: string | undefined;
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
    captchaHeaders = await getProactiveCaptchaHeaders();
  } catch (err) {
    return {
      response: opts.upstreamResp,
      error: errorResponse(503, "captcha_solve_failed", (err as Error).message),
    };
  }

  const challenge = detectCaptchaChallenge(opts.upstreamResp);
  if (challenge) {
    const { verifyParam, region } = await solveCaptcha(challenge);
    captchaHeaders = {
      [RETRY_HEADERS.PARAM]: verifyParam,
      [RETRY_HEADERS.REGION]: region,
    };
  }

  const upstreamReq = buildUpstreamRequest(
    opts.clientReq,
    opts.format,
    opts.provider,
    opts.cred,
    opts.transformedBody,
    opts.identity,
    "start-plan",
    captchaHeaders,
  );

  try {
    const upstreamResp = await opts.fetchImpl(upstreamReq, { decompress: false });
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

async function isCaptchaFailure(resp: Response): Promise<boolean> {
  if (resp.status === 403 || resp.status === 405) return true;
  const text = await resp.clone().text().catch(() => "");
  const low = text.toLowerCase();
  return low.includes("captcha") || low.includes("3007") || low.includes("3012");
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
  const ts = new Date(started).toISOString().slice(11, 19);
  const tag = format === "anthropic" ? "ANT" : "OAI";
  const mode = meta.stream ? "stream" : "batch";
  const ttfb = `${headersAt - started}ms`;
  const total = streamEndAt > started ? `${streamEndAt - started}ms` : "-";
  const tok = tokens > 0 ? String(tokens) : "-";
  const tps = avgTps > 0 ? avgTps.toFixed(1) : "-";
  console.log(
    `| ${reqId.padEnd(4)} | ${ts.padEnd(10)} | ${tag} | ${meta.model.padEnd(11)} | ${mode.padEnd(6)} | ${String(status).padStart(4)} | ${ttfb.padStart(7)} | ${tok.padStart(5)} | ${tps.padStart(6)} | ${total.padStart(7)} |`,
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
): void {
  const compressed = contentEncoding !== null;
  let tokens = 0;
  let sseBuffer = "";
  let firstChunkAt = 0;

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
  })().catch(() => {});
}
