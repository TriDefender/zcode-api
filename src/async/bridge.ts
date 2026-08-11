/**
 * Async bridge: core state machine turning sync client stream expectation
 * into off-peak async reality. See `.omo/plans/async-off-peak-bridge.md` §3.
 *
 * State machine:
 *   WAIT   (queued)            → poll every pollIntervalMs (signal-aware); emit keepalives
 *   READY  (ready/active)      → forward LLM call upstream with X-Off-Peak-Ticket-ID
 *   EXPIRED (ticket revoked)   → settleOnce(old); if attempt < maxRetries take new ticket → WAIT; else terminal error
 *   DONE   (stream completed)  → settleOnce(current); close stream
 *   ABORT  (client disconnect) → settleOnce(current); release resources
 *
 * Anti-patterns enforced (see plan §9):
 *   #1 — pure `: keepalive\n\n` comments during wait; no custom data events
 *   #2 — every takeTicket matched by exactly one settleOnce (idempotent)
 *   #3 — retry resends original prompt (no NOe placeholder)
 *   #5 — settle is fire-and-forget, never blocks stream closure
 *
 * Output: homogeneous byte stream (keepalives + upstream Anthropic bytes + terminal error events).
 */
import type { OffPeakClient } from "./client.js";
import type { OffPeakCredentials, TakeTicketResult, TicketState } from "./types.js";
import { isTicketExpired, isTicketReady } from "./types.js";
import { keepaliveFrame } from "./keepalive.js";
import { buildIdentityHeaders } from "../proxy/identity.js";
import type { ProxyIdentity } from "../config/types.js";

const EXPIRED_MARKER = "off-peak-ticket-expired";

export interface BridgeOptions {
  client: OffPeakClient;
  credentials: OffPeakCredentials;
  origin: string;
  identity: ProxyIdentity;
  llmRequestBody: string;
  initialTicket: TakeTicketResult;
  taskId: string;
  pollIntervalMs: number;
  keepAliveIntervalMs: number;
  maxRetries: number;
  /** Total wait cap across ALL retries (not per-ticket). 0 = unlimited. */
  maxWaitMs: number;
  clientSignal?: AbortSignal;
  fetchImpl?: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
  onTransition?: (info: BridgeTransition) => void;
}

export interface BridgeTransition {
  phase: "wait" | "ready" | "expired" | "done" | "abort" | "error";
  attempt: number;
  ticketId: string;
  state?: TicketState;
  message?: string;
}

export interface BridgeOutcome {
  attempts: number;
  finalTicketId: string;
  terminalPhase: BridgeTransition["phase"];
}

export function runAsyncBridge(opts: BridgeOptions): { stream: ReadableStream<Uint8Array>; outcome: Promise<BridgeOutcome> } {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const encoder = new TextEncoder();
  let outcomeResolve!: (o: BridgeOutcome) => void;
  const outcome = new Promise<BridgeOutcome>((r) => {
    outcomeResolve = r;
  });
  let outcomeResolved = false;
  function resolveOutcome(o: BridgeOutcome): void {
    if (outcomeResolved) return;
    outcomeResolved = true;
    outcomeResolve(o);
  }

  let aborted = false;
  const settledTickets = new Set<string>();
  function settleOnce(ticketId: string): void {
    if (settledTickets.has(ticketId)) return;
    settledTickets.add(ticketId);
    void opts.client.settle(ticketId).catch(() => {
      // best-effort; settle failure is non-fatal
    });
  }

  function log(info: BridgeTransition): void {
    try {
      opts.onTransition?.(info);
    } catch {
      // observability hook must never break the bridge
    }
  }

  function emitKeepalive(controller: ReadableStreamDefaultController<Uint8Array>): void {
    if (aborted) return;
    try {
      controller.enqueue(keepaliveFrame());
    } catch {
      // controller closed by consumer
    }
  }

  function emitTerminalError(controller: ReadableStreamDefaultController<Uint8Array>, message: string, type: string = "api_error"): void {
    if (aborted) return;
    const payload = JSON.stringify({ type: "error", error: { type, message } });
    try {
      controller.enqueue(encoder.encode(`event: error\ndata: ${payload}\n\n`));
    } catch {
      // already closed
    }
  }

  /**
   * Wait until ticket becomes ready/active OR expired/not_found OR abort OR total maxWaitMs exceeded.
   * `settled` and unknown states are treated as expired (server can't dispatch this ticket again).
   * Polls respect clientSignal for immediate cancellation.
   */
  async function waitForReady(ticketId: string, deadlineAt: number): Promise<{ state: TicketState }> {
    while (true) {
      if (aborted) return { state: "expired" as TicketState };
      const result = await opts.client.batchStatus([ticketId], opts.clientSignal);
      if (aborted) return { state: "expired" as TicketState };
      const ticket = result.tickets[0];
      if (!ticket) return { state: "not_found" as TicketState };
      if (isTicketReady(ticket.state)) return { state: ticket.state };
      // `settled`, `expired`, `not_found`, or any unknown state → unusable, treat as expired
      if (ticket.state !== "queued") return { state: "expired" as TicketState };

      const delay = result.nextPollAfterMs ?? opts.pollIntervalMs;
      if (opts.maxWaitMs > 0 && Date.now() + delay > deadlineAt) {
        return { state: "expired" as TicketState };
      }
      await sleep(delay, opts.clientSignal);
    }
  }

  async function forwardLLM(ticketId: string): Promise<{ response: Response; expiredInBody: boolean }> {
    const url = `${opts.origin.replace(/\/+$/, "")}/api/v1/off-peak/anthropic/v1/messages`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${opts.credentials.jwt}`,
      "x-coding-plan-api-key": opts.credentials.codingPlanApiKey,
      "x-off-peak-ticket-id": ticketId,
      ...buildIdentityHeaders(opts.identity),
    };
    if (opts.credentials.bigmodelOrganization) headers["bigmodel-organization"] = opts.credentials.bigmodelOrganization;
    if (opts.credentials.bigmodelProject) headers["bigmodel-project"] = opts.credentials.bigmodelProject;

    const resp = await fetchImpl(url, {
      method: "POST",
      headers,
      body: opts.llmRequestBody,
      signal: opts.clientSignal,
    });

    if (!resp.ok) {
      const bodyText = await resp.text().catch(() => "");
      if (bodyText.includes(EXPIRED_MARKER)) {
        return { response: new Response(bodyText, { status: resp.status, headers: resp.headers }), expiredInBody: true };
      }
      return { response: new Response(bodyText, { status: resp.status, headers: resp.headers }), expiredInBody: false };
    }
    return { response: resp, expiredInBody: false };
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // External signal → local aborted flag. Both paths (consumer cancel + signal abort) converge here.
      if (opts.clientSignal) {
        if (opts.clientSignal.aborted) aborted = true;
        else opts.clientSignal.addEventListener("abort", () => { aborted = true; }, { once: true });
      }

      // Keepalive runs ONLY during WAIT/retry phases; stopped before LLM streaming to
      // avoid inserting `: keepalive\n\n` inside a partial SSE frame split across chunks.
      let keepAliveTimer: ReturnType<typeof setInterval> | undefined;
      function startKeepalive(): void {
        if (keepAliveTimer) return;
        keepAliveTimer = setInterval(() => emitKeepalive(controller), opts.keepAliveIntervalMs);
      }
      function stopKeepalive(): void {
        if (keepAliveTimer) {
          clearInterval(keepAliveTimer);
          keepAliveTimer = undefined;
        }
      }

      // Total wait deadline across all retries (B11: was per-ticket, leaked to (maxRetries+1)*maxWaitMs).
      const requestStartedAt = Date.now();
      const deadlineAt = opts.maxWaitMs > 0 ? requestStartedAt + opts.maxWaitMs : Number.MAX_SAFE_INTEGER;

      let currentTicket = opts.initialTicket;
      let attempt = 0;

      try {
        while (true) {
          if (aborted) {
            log({ phase: "abort", attempt, ticketId: currentTicket.ticketId });
            settleOnce(currentTicket.ticketId);
            return;
          }

          // WAIT phase
          if (!isTicketReady(currentTicket.state)) {
            log({ phase: "wait", attempt, ticketId: currentTicket.ticketId, state: currentTicket.state });
            startKeepalive();
            const wait = await waitForReady(currentTicket.ticketId, deadlineAt);
            if (aborted) {
              stopKeepalive();
              log({ phase: "abort", attempt, ticketId: currentTicket.ticketId });
              settleOnce(currentTicket.ticketId);
              return;
            }
            if (isTicketExpired(wait.state)) {
              stopKeepalive();
              settleOnce(currentTicket.ticketId);
              // Check if this was a client-side maxWaitMs timeout (not server expiration).
              // Distinguish the error so users don't chase server-side ticket issues.
              if (opts.maxWaitMs > 0 && Date.now() >= deadlineAt) {
                emitTerminalError(controller, `async max wait timeout (${opts.maxWaitMs}ms exceeded)`, "timeout");
                resolveOutcome({ attempts: attempt + 1, finalTicketId: currentTicket.ticketId, terminalPhase: "error" });
                return;
              }
              log({ phase: "expired", attempt, ticketId: currentTicket.ticketId, state: wait.state, message: "expired in queue" });
              attempt++;
              if (attempt > opts.maxRetries) {
                emitTerminalError(controller, `async upstream exhausted retries (ticket expired in queue ${attempt}x)`, "api_error");
                resolveOutcome({ attempts: attempt, finalTicketId: currentTicket.ticketId, terminalPhase: "error" });
                return;
              }
              try {
                currentTicket = await opts.client.takeTicket(opts.taskId, opts.clientSignal);
              } catch (takeErr) {
                emitTerminalError(controller, `async retake failed: ${(takeErr as Error).message}`, "api_error");
                resolveOutcome({ attempts: attempt, finalTicketId: currentTicket.ticketId, terminalPhase: "error" });
                return;
              }
              continue;
            }
            stopKeepalive();
          }

          // READY phase — NO keepalive (would corrupt SSE frames split across chunks)
          log({ phase: "ready", attempt, ticketId: currentTicket.ticketId });
          let resp: Response;
          let expiredInBody: boolean;
          try {
            const forward = await forwardLLM(currentTicket.ticketId);
            resp = forward.response;
            expiredInBody = forward.expiredInBody;
          } catch (err) {
            if (aborted) {
              settleOnce(currentTicket.ticketId);
              return;
            }
            emitTerminalError(controller, `async upstream network error: ${(err as Error).message}`, "api_error");
            settleOnce(currentTicket.ticketId);
            resolveOutcome({ attempts: attempt + 1, finalTicketId: currentTicket.ticketId, terminalPhase: "error" });
            return;
          }

          if (!resp.ok || expiredInBody) {
            const bodyText = await resp.text().catch(() => "");
            if (expiredInBody || bodyText.includes(EXPIRED_MARKER)) {
              log({ phase: "expired", attempt, ticketId: currentTicket.ticketId, message: "expired during LLM (pre-stream)" });
              settleOnce(currentTicket.ticketId);
              attempt++;
              if (attempt > opts.maxRetries) {
                emitTerminalError(controller, `async upstream exhausted retries (ticket expired during LLM ${attempt}x)`, "api_error");
                resolveOutcome({ attempts: attempt, finalTicketId: currentTicket.ticketId, terminalPhase: "error" });
                return;
              }
              try {
                currentTicket = await opts.client.takeTicket(opts.taskId, opts.clientSignal);
              } catch (takeErr) {
                emitTerminalError(controller, `async retake failed: ${(takeErr as Error).message}`, "api_error");
                resolveOutcome({ attempts: attempt, finalTicketId: currentTicket.ticketId, terminalPhase: "error" });
                return;
              }
              continue;
            }
            // Non-expired upstream error → emit standard Anthropic error event.
            // Sanitized message: status only; body omitted to avoid leaking upstream internals.
            emitTerminalError(controller, `async upstream HTTP ${resp.status}`, "api_error");
            settleOnce(currentTicket.ticketId);
            resolveOutcome({ attempts: attempt + 1, finalTicketId: currentTicket.ticketId, terminalPhase: "error" });
            return;
          }

          // Stream upstream body with complete-frame buffering.
          //
          // DESIGN (fixes R3-2/R3-3/R4-1/R4-3 + bounds memory R4-5):
          //   - One TextDecoder for the whole streaming phase (handles partial
          //     multibyte UTF-8 correctly across chunk boundaries).
          //   - Accumulate decoded text until a complete SSE frame (`\n\n` boundary).
          //   - Scan the COMPLETE frame for the expired marker before forwarding.
          //     This catches markers split across any number of network chunks.
          //   - Forward via `encoder.encode(frame)` — re-encoding Unicode codepoints
          //     through UTF-16→UTF-8 is lossless for valid input, and avoids the
          //     raw-vs-decoded byte mismatch that previously dropped pre-commit
          //     chunks when the boundary spanned chunks.
          //   - Cap `pending` at MAX_PENDING_FRAME_BYTES to prevent a malicious
          //     upstream from exhausting memory by streaming without `\n\n`.
          //
          // State machine:
          //   Pre-commit (no frame forwarded yet): marker found → transparent retry.
          //   Post-commit (≥1 frame forwarded): marker found → terminal error
          //     (cannot retry — client already saw message_start; retrying would
          //     produce duplicate lifecycle events).
          let midStreamExpiredPreCommit = false;
          let midStreamExpiredPostCommit = false;
          let committed = false;
          if (resp.body) {
            const reader = resp.body.getReader();
            const streamDecoder = new TextDecoder();
            let pending = "";
            const MAX_PENDING_FRAME_BYTES = 1 * 1024 * 1024;
            try {
              while (true) {
                if (aborted) {
                  await reader.cancel().catch(() => {});
                  settleOnce(currentTicket.ticketId);
                  return;
                }
                const { done, value } = await reader.read();
                if (done) {
                  // SSE spec: discard pending data at EOF if it lacks a terminating
                  // blank line (incomplete event). Only flush if marker-free AND
                  // properly terminated.
                  if (pending.length > 0 && !aborted && !midStreamExpiredPreCommit && !midStreamExpiredPostCommit) {
                    if (pending.includes(EXPIRED_MARKER)) {
                      if (!committed) midStreamExpiredPreCommit = true;
                      else midStreamExpiredPostCommit = true;
                    } else if (pending.endsWith("\n\n")) {
                      // Properly terminated final frame — safe to forward.
                      try { controller.enqueue(encoder.encode(pending)); } catch {}
                    }
                    // else: unterminated event at EOF — discard per SSE spec.
                    pending = "";
                  }
                  break;
                }
                if (aborted) break;
                pending += streamDecoder.decode(value, { stream: true }).replace(/\r\n/g, "\n").replace(/\r/g, "\n");

                // Bounded buffer: if pending exceeds the cap without a frame boundary,
                // the upstream is malformed or malicious — terminate.
                if (pending.length > MAX_PENDING_FRAME_BYTES) {
                  await reader.cancel().catch(() => {});
                  emitTerminalError(controller, "async upstream SSE frame exceeded 1 MiB boundary", "api_error");
                  settleOnce(currentTicket.ticketId);
                  resolveOutcome({ attempts: attempt + 1, finalTicketId: currentTicket.ticketId, terminalPhase: "error" });
                  return;
                }

                // Process all complete frames in `pending`.
                let frameBoundaryFound = false;
                while (true) {
                  const idx = pending.indexOf("\n\n");
                  if (idx === -1) break;
                  const frame = pending.slice(0, idx + 2);
                  pending = pending.slice(idx + 2);

                  if (frame.includes(EXPIRED_MARKER)) {
                    if (!committed) {
                      midStreamExpiredPreCommit = true;
                    } else {
                      midStreamExpiredPostCommit = true;
                    }
                    await reader.cancel().catch(() => {});
                    frameBoundaryFound = true;
                    break;
                  }
                  try {
                    controller.enqueue(encoder.encode(frame));
                    committed = true;
                  } catch {
                    await reader.cancel().catch(() => {});
                    frameBoundaryFound = true;
                    break;
                  }
                }
                if (midStreamExpiredPreCommit || midStreamExpiredPostCommit || frameBoundaryFound) break;
              }
              // Flush decoder (no stream flag) to release internal partial-byte state.
              streamDecoder.decode();
            } finally {
              reader.releaseLock?.();
            }
          }

          if (midStreamExpiredPreCommit && !aborted) {
            log({ phase: "expired", attempt, ticketId: currentTicket.ticketId, message: "expired during LLM (mid-stream, pre-commit)" });
            settleOnce(currentTicket.ticketId);
            attempt++;
            if (attempt > opts.maxRetries) {
              emitTerminalError(controller, `async upstream exhausted retries (ticket expired mid-stream ${attempt}x)`, "api_error");
              resolveOutcome({ attempts: attempt, finalTicketId: currentTicket.ticketId, terminalPhase: "error" });
              return;
            }
            try {
              currentTicket = await opts.client.takeTicket(opts.taskId, opts.clientSignal);
            } catch (takeErr) {
              emitTerminalError(controller, `async retake failed: ${(takeErr as Error).message}`, "api_error");
              resolveOutcome({ attempts: attempt, finalTicketId: currentTicket.ticketId, terminalPhase: "error" });
              return;
            }
            continue;
          }

          if (midStreamExpiredPostCommit && !aborted) {
            // Cannot retry transparently — client already saw message_start.
            // Emit terminal error and close.
            log({ phase: "error", attempt, ticketId: currentTicket.ticketId, message: "expired mid-stream after commit; cannot retry" });
            settleOnce(currentTicket.ticketId);
            emitTerminalError(controller, "async upstream ticket expired mid-stream after output started", "api_error");
            resolveOutcome({ attempts: attempt + 1, finalTicketId: currentTicket.ticketId, terminalPhase: "error" });
            return;
          }

          if (aborted) {
            log({ phase: "abort", attempt, ticketId: currentTicket.ticketId });
            settleOnce(currentTicket.ticketId);
            resolveOutcome({ attempts: attempt + 1, finalTicketId: currentTicket.ticketId, terminalPhase: "abort" });
            return;
          }

          log({ phase: "done", attempt, ticketId: currentTicket.ticketId });
          settleOnce(currentTicket.ticketId);
          resolveOutcome({ attempts: attempt + 1, finalTicketId: currentTicket.ticketId, terminalPhase: "done" });
          return;
        }
      } catch (err) {
        if (!aborted) {
          emitTerminalError(controller, `async bridge internal error: ${(err as Error).message}`, "api_error");
        }
        settleOnce(currentTicket.ticketId);
        resolveOutcome({ attempts: attempt + 1, finalTicketId: currentTicket.ticketId, terminalPhase: "error" });
      } finally {
        stopKeepalive();
        try {
          controller.close();
        } catch {
          // already closed
        }
        // Abort paths return without calling resolveOutcome; resolve here as a fallback
        // so `await outcome` never hangs. Idempotent — explicit calls above take precedence.
        resolveOutcome({
          attempts: attempt + 1,
          finalTicketId: currentTicket.ticketId,
          terminalPhase: aborted ? "abort" : "error",
        });
      }
    },

    cancel() {
      aborted = true;
    },
  });

  return { stream, outcome };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
