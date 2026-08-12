/**
 * Async route handlers — wrap the bridge with format-specific translation.
 *
 * Three handlers:
 *   - `handleAsyncMessages`  (Anthropic client, POST /async/v1/messages)         — passthrough
 *   - `handleAsyncChat`      (OpenAI client, POST /async/v1/chat/completions)    — request OAI→ANT, response ANT SSE→OAI SSE
 *   - `handleAsyncHealth`    (GET /async/v1/health)                              — probe queue availability
 *
 * Common pre-flight (B1 fix: validate BEFORE takeTicket so we never leak a ticket
 * on JSON parse / model-missing / translation failures):
 *   1. Verify credential has `jwt` (oauth-only — apikey mode lacks the JWT)
 *   2. Read + parse client body (skip for health)
 *   3. Validate required fields + build the Anthropic-format upstream body
 *   4. ONLY THEN takeTicket (any failure above returns 4xx WITHOUT a ticket)
 *
 * For non-stream (B5+B10): internally force `stream:true` upstream; return a
 * chunked `application/json` response that emits legal leading whitespace during
 * wait (defeats client TCP idle) and writes the final aggregated JSON at the end.
 *
 * @see .omo/plans/async-off-peak-bridge.md §3 for full design.
 */
import type { ProxyConfig } from "../config/types.js";
import type { AuthManager } from "../auth/manager.js";
import type { Credential } from "../auth/types.js";
import { credentialString } from "../auth/types.js";
import { errorResponse } from "../proxy/handler.js";
import { transformRequestBody } from "../proxy/body-transformer.js";
import { translateRequestOpenAIToAnthropic, translateResponseAnthropicToOpenAI } from "../translator/openai-to-anthropic.js";
import { anthropicSseToOpenaiSseWithKeepalive } from "./openai-stream-adapter.js";
import type { AnthropicMessagesRequest, OpenAIChatRequest, AnthropicMessagesResponse } from "../translator/types.js";
import { createOffPeakClient, type OffPeakClient } from "./client.js";
import type { OffPeakCredentials, TakeTicketResult } from "./types.js";
import { runAsyncBridge } from "./bridge.js";

/** Cap request body size to prevent memory exhaustion (B16). */
const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

/** Single space byte — used for non-stream chunked JSON whitespace keepalive. */
const SINGLE_SPACE = new Uint8Array([32]);

export interface AsyncHandlerOptions {
  config: ProxyConfig;
  auth: AuthManager;
  fetchImpl?: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
  debug?: boolean;
}

function buildCredentials(cred: Credential): OffPeakCredentials {
  return {
    jwt: cred.jwt ?? "",
    codingPlanApiKey: credentialString(cred),
  };
}

function generateTaskId(): string {
  return `proxy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function resolveModel(req: { model?: string }, config: ProxyConfig): string {
  const explicit = typeof req.model === "string" ? req.model.trim() : "";
  if (explicit) return explicit;
  if (config.async.defaultModel && config.async.defaultModel.trim()) return config.async.defaultModel.trim();
  return config.defaultModel;
}

async function readBody(req: Request): Promise<{ ok: true; body: string } | { ok: false; response: Response }> {
  // Reject oversized Content-Length up front; otherwise drain the stream incrementally
  // and abort as soon as we exceed the cap. This prevents an attacker from exhausting
  // memory by sending a huge chunked body with no Content-Length.
  const contentLength = req.headers.get("content-length");
  if (contentLength) {
    const cl = parseInt(contentLength, 10);
    if (Number.isFinite(cl) && cl > MAX_REQUEST_BODY_BYTES) {
      // Cancel the request body stream so the underlying socket releases; otherwise
      // the client can keep the connection alive despite the 413 response.
      req.body?.cancel().catch(() => {});
      return { ok: false, response: errorResponse(413, "request_too_large", `body exceeds ${MAX_REQUEST_BODY_BYTES} byte cap`) };
    }
  }
  if (!req.body) {
    return { ok: false, response: errorResponse(400, "invalid_request_error", "missing request body") };
  }
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        return { ok: false, response: errorResponse(413, "request_too_large", `body exceeds ${MAX_REQUEST_BODY_BYTES} byte cap`) };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, response: errorResponse(400, "invalid_request_error", "could not read request body") };
  } finally {
    reader.releaseLock?.();
  }
  const body = new TextDecoder().decode(Buffer.concat(chunks));
  if (!body || body.length === 0) {
    return { ok: false, response: errorResponse(400, "invalid_request_error", "empty request body") };
  }
  return { ok: true, body };
}

async function resolveCredential(opts: AsyncHandlerOptions): Promise<{ ok: true; cred: Credential; credentials: OffPeakCredentials } | { ok: false; response: Response }> {
  let cred: Credential;
  try {
    cred = await opts.auth.getCredential();
  } catch (err) {
    return { ok: false, response: errorResponse(401, "authentication_error", `credential resolution failed: ${(err as Error).message}`) };
  }
  if (!cred.jwt) {
    return {
      ok: false,
      response: errorResponse(
        400,
        "async_credentials_unavailable",
        "async endpoints require oauth mode (credential lacks JWT). Re-login via `auth login` or use sync /v1/* endpoints.",
      ),
    };
  }
  return { ok: true, cred, credentials: buildCredentials(cred) };
}

function buildClient(opts: AsyncHandlerOptions, credentials: OffPeakCredentials): OffPeakClient {
  return createOffPeakClient({
    origin: opts.config.async.origin,
    credentials,
    controlTimeoutMs: opts.config.async.controlTimeoutMs,
    settleTimeoutMs: opts.config.async.settleTimeoutMs,
    fetchImpl: opts.fetchImpl,
  });
}

async function takeTicketOr502(client: OffPeakClient, taskId: string, opts: AsyncHandlerOptions, signal: AbortSignal | undefined): Promise<{ ok: true; ticket: TakeTicketResult } | { ok: false; response: Response }> {
  try {
    const ticket = await client.takeTicket(taskId, signal);
    return { ok: true, ticket };
  } catch (err) {
    return { ok: false, response: errorResponse(502, "async_take_ticket_failed", `off-peak takeTicket failed: ${(err as Error).message}`) };
  }
}

function buildBridge(opts: AsyncHandlerOptions, client: OffPeakClient, credentials: OffPeakCredentials, llmRequestBody: string, initialTicket: TakeTicketResult, taskId: string, req: Request) {
  return runAsyncBridge({
    client,
    credentials,
    origin: opts.config.async.origin,
    identity: opts.config.identity,
    llmRequestBody,
    initialTicket,
    taskId,
    pollIntervalMs: opts.config.async.pollIntervalMs,
    keepAliveIntervalMs: opts.config.async.keepAliveIntervalMs,
    maxRetries: opts.config.async.maxRetries,
    maxWaitMs: opts.config.async.maxWaitMs,
    clientSignal: req.signal,
    fetchImpl: opts.fetchImpl,
    onTransition: opts.debug
      ? (info) => {
        console.log(`[async] task=${taskId} ticket=${info.ticketId} phase=${info.phase} attempt=${info.attempt}${info.state ? ` state=${info.state}` : ""}${info.message ? ` msg=${info.message}` : ""}`);
      }
      : undefined,
  });
}

function sseHeaders(): Record<string, string> {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  };
}

export async function handleAsyncMessages(req: Request, opts: AsyncHandlerOptions): Promise<Response> {
  // B1: validate everything before ticket acquisition
  const cred = await resolveCredential(opts);
  if (!cred.ok) return cred.response;

  const bodyResult = await readBody(req);
  if (!bodyResult.ok) return bodyResult.response;

  let parsedBody: Record<string, unknown>;
  try {
    const raw = JSON.parse(bodyResult.body);
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return errorResponse(400, "invalid_request_error", "request body must be a JSON object");
    }
    parsedBody = raw as Record<string, unknown>;
  } catch {
    return errorResponse(400, "invalid_request_error", "request body is not valid JSON");
  }
  if (!Array.isArray(parsedBody.messages) || parsedBody.messages.length === 0) {
    return errorResponse(400, "invalid_request_error", "missing or invalid `messages` field");
  }
  // Anthropic spec: omitted `stream` defaults to non-streaming (false).
  const clientWantsStream = parsedBody.stream === true;

  const modelStr = typeof parsedBody.model === "string" ? parsedBody.model : undefined;
  // Anthropic spec: omitted `stream` defaults to non-streaming (false).
  // Validated: parsedBody is a plain object with messages[]. Remaining fields
  // (max_tokens, tools, etc.) are forwarded as-is — upstream rejects invalid shapes.
  const upstreamBody = {
    ...parsedBody,
    model: resolveModel({ model: modelStr }, opts.config),
    stream: true,
  } as AnthropicMessagesRequest;
  const upstreamBodyText = transformRequestBody(JSON.stringify(upstreamBody), { format: "anthropic", userId: cred.cred.userId }) ?? JSON.stringify(upstreamBody);

  // Now we're safe to take a ticket
  const client = buildClient(opts, cred.credentials);
  const taskId = generateTaskId();
  const ticket = await takeTicketOr502(client, taskId, opts, req.signal);
  if (!ticket.ok) return ticket.response;

  const { stream, outcome } = buildBridge(opts, client, cred.credentials, upstreamBodyText, ticket.ticket, taskId, req);
  void outcome;

  if (clientWantsStream) {
    return new Response(stream, { status: 200, headers: sseHeaders() });
  }

  // Non-stream: chunked response with leading whitespace during wait + final JSON (B10)
  return new Response(nonStreamChunkedJson(stream), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache", "transfer-encoding": "chunked" },
  });
}

export async function handleAsyncChat(req: Request, opts: AsyncHandlerOptions): Promise<Response> {
  const cred = await resolveCredential(opts);
  if (!cred.ok) return cred.response;

  const bodyResult = await readBody(req);
  if (!bodyResult.ok) return bodyResult.response;

  let openaiReq: OpenAIChatRequest;
  try {
    openaiReq = JSON.parse(bodyResult.body) as OpenAIChatRequest;
  } catch {
    return errorResponse(400, "invalid_request_error", "request body is not valid JSON");
  }
  if (!Array.isArray(openaiReq.messages) || openaiReq.messages.length === 0) {
    return errorResponse(400, "invalid_request_error", "missing or invalid `messages` field");
  }
  openaiReq.model = resolveModel(openaiReq, opts.config);
  const clientWantsStream = openaiReq.stream === true;

  let anthropicReq: AnthropicMessagesRequest;
  try {
    anthropicReq = translateRequestOpenAIToAnthropic(openaiReq);
  } catch (err) {
    return errorResponse(400, "invalid_request_error", `OpenAI→Anthropic translation failed: ${(err as Error).message}`);
  }
  anthropicReq.stream = true;
  const upstreamBodyText = transformRequestBody(JSON.stringify(anthropicReq), { format: "anthropic", userId: cred.cred.userId }) ?? JSON.stringify(anthropicReq);

  const client = buildClient(opts, cred.credentials);
  const taskId = generateTaskId();
  const ticket = await takeTicketOr502(client, taskId, opts, req.signal);
  if (!ticket.ok) return ticket.response;

  const { stream: rawStream, outcome } = buildBridge(opts, client, cred.credentials, upstreamBodyText, ticket.ticket, taskId, req);
  void outcome;

  if (clientWantsStream) {
    // B4: custom translator that preserves `: keepalive` comments and converts Anthropic errors
    const openaiStream = anthropicSseToOpenaiSseWithKeepalive(rawStream, openaiReq.model);
    return new Response(openaiStream, { status: 200, headers: sseHeaders() });
  }

  return new Response(nonStreamChunkedJson(rawStream, { translate: "openai", model: openaiReq.model }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache", "transfer-encoding": "chunked" },
  });
}

export async function handleAsyncHealth(_req: Request, opts: AsyncHandlerOptions): Promise<Response> {
  const cred = await resolveCredential(opts);
  if (!cred.ok) return cred.response;
  const client = buildClient(opts, cred.credentials);
  try {
    const avail = await client.getAvailability();
    return new Response(JSON.stringify(avail), { status: 200, headers: { "content-type": "application/json" } });
  } catch (err) {
    return errorResponse(502, "async_health_failed", (err as Error).message);
  }
}

/**
 * Wrap the SSE byte stream as a non-stream JSON response. Emits leading whitespace
 * during ticket-queue wait (defeats client TCP idle), then a single JSON document.
 *
 * Two modes:
 *   - default: Anthropic batch JSON shape
 *   - {translate: "openai"}: OpenAI batch JSON shape (translated from Anthropic)
 */
function nonStreamChunkedJson(
  bridgeStream: ReadableStream<Uint8Array>,
  translateOpts?: { translate: "openai"; model: string },
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = bridgeStream.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          // One space byte per received chunk (not per char). Resets TCP idle timer
          // while keeping allocation count proportional to chunk count, not byte count.
          try {
            controller.enqueue(SINGLE_SPACE);
          } catch {
            return;
          }
          sseBuffer += decoder.decode(value, { stream: true });
        }
        sseBuffer += decoder.decode();
      } finally {
        reader.releaseLock?.();
      }

      // Reconstruct Anthropic batch JSON from accumulated SSE
      const anthropicMsg = reconstructAnthropicBatch(sseBuffer);
      if (!anthropicMsg) {
        const errPayload = { error: { type: "async_aggregation_failed", message: "could not reconstruct response from bridge stream" } };
        try {
          controller.enqueue(encoder.encode(JSON.stringify(errPayload)));
        } catch {
          // closed
        }
        controller.close();
        return;
      }

      const finalJson = translateOpts?.translate === "openai"
        ? JSON.stringify(translateResponseAnthropicToOpenAI(anthropicMsg, translateOpts.model))
        : JSON.stringify(anthropicMsg);
      try {
        controller.enqueue(encoder.encode(finalJson));
      } catch {
        // closed
      }
      controller.close();
    },
  });
}

/**
 * Reconstruct a synthetic `AnthropicMessagesResponse` from a stream of Anthropic SSE bytes.
 * Handles message_start, content_block_start/delta/stop, message_delta, message_stop.
 *
 * Fail-closed: returns null if `message_stop` not seen, or on `event: error`.
 * Preserves `signature_delta` for thinking blocks. No production `any`.
 */
function reconstructAnthropicBatch(sseText: string): AnthropicMessagesResponse | null {
  const blocks = sseText.split("\n\n");
  type ContentBlock =
    | { type: "text"; text: string }
    | { type: "thinking"; thinking: string; signature?: string }
    | { type: "tool_use"; id: string; name: string; input: unknown };
  let message: Partial<AnthropicMessagesResponse> | null = null;
  const content: ContentBlock[] = [];
  let currentBlock: ContentBlock | null = null;
  let currentToolJson = "";
  let sawMessageStop = false;
  let sawError = false;

  for (const block of blocks) {
    const lines = block.split("\n");
    let eventType: string | undefined;
    let data: string | undefined;
    for (const line of lines) {
      if (line.startsWith("event:")) eventType = line.slice(6).trim();
      else if (line.startsWith("data:")) data = line.slice(5).trim();
    }
    if (!data) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = (eventType ?? parsed.type) as string;
    switch (type) {
      case "message_start": {
        const msg = parsed.message as Partial<AnthropicMessagesResponse> | undefined;
        message = { ...(msg ?? {}) };
        break;
      }
      case "content_block_start": {
        const cb = parsed.content_block as Partial<ContentBlock> | undefined;
        if (!cb || !cb.type) break;
        if (cb.type === "text") currentBlock = { type: "text", text: "" };
        else if (cb.type === "thinking") currentBlock = { type: "thinking", thinking: "" };
        else if (cb.type === "tool_use" && typeof cb.id === "string" && typeof cb.name === "string") {
          currentBlock = { type: "tool_use", id: cb.id, name: cb.name, input: {} };
          currentToolJson = "";
        }
        break;
      }
      case "content_block_delta": {
        const delta = parsed.delta as Record<string, unknown> | undefined;
        if (!currentBlock || !delta) break;
        if (delta.type === "text_delta" && currentBlock.type === "text" && typeof delta.text === "string") {
          currentBlock.text += delta.text;
        } else if (delta.type === "thinking_delta" && currentBlock.type === "thinking" && typeof delta.thinking === "string") {
          currentBlock.thinking += delta.thinking;
        } else if (delta.type === "signature_delta" && currentBlock.type === "thinking" && typeof delta.signature === "string") {
          currentBlock.signature = (currentBlock.signature ?? "") + delta.signature;
        } else if (delta.type === "input_json_delta" && currentBlock.type === "tool_use" && typeof delta.partial_json === "string") {
          currentToolJson += delta.partial_json;
        }
        break;
      }
      case "content_block_stop": {
        if (currentBlock) {
          if (currentBlock.type === "tool_use") {
            try {
              currentBlock.input = JSON.parse(currentToolJson || "{}");
            } catch {
              currentBlock.input = {};
            }
            currentToolJson = "";
          }
          content.push(currentBlock);
          currentBlock = null;
        }
        break;
      }
      case "message_delta": {
        const delta = parsed.delta as Partial<AnthropicMessagesResponse> | undefined;
        const usage = parsed.usage as Record<string, number> | undefined;
        if (delta && message) Object.assign(message, delta);
        if (usage && message) message.usage = { ...(message.usage ?? { input_tokens: 0, output_tokens: 0 }), ...usage } as AnthropicMessagesResponse["usage"];
        break;
      }
      case "message_stop":
        sawMessageStop = true;
        break;
      case "error":
        sawError = true;
        break;
      default:
        // ignore ping / unknown
        break;
    }
  }

  if (sawError || !sawMessageStop || !message) return null;
  message.content = content as AnthropicMessagesResponse["content"];
  if (!message.stop_reason) message.stop_reason = "end_turn";
  if (!message.role) message.role = "assistant";
  if (!message.usage) message.usage = { input_tokens: 0, output_tokens: 0 };
  return message as AnthropicMessagesResponse;
}
