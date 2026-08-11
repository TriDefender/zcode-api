/**
 * HTTP client for ZCode's off-peak ticket-queue backend.
 *
 * Implements the 4 control-plane endpoints documented in `_reverse/NOTEPAD.md`:
 *   - `GET  /ticket/availability`        — probe queue availability
 *   - `POST /ticket`                     — take a number (queue entry)
 *   - `POST /ticket/status`              — batch poll ticket states
 *   - `POST /ticket/{id}/settle`         — close-out (success/abort/cancel)
 *
 * Each method has its own short timeout (default 15s) via `setTimeout + abort`.
 * 4xx on `settle` resolves as success (server already cleaned up — see `settleOne`
 * in the bundle). Other 4xx/5xx throw `OffPeakServerError`.
 *
 * @see _reverse/NOTEPAD.md "Off-Peak / Idle Plan" → "Endpoints" / "Headers"
 */
import type {
  AvailabilityResult,
  BatchStatusResult,
  OffPeakCredentials,
  TakeTicketResult,
  TicketState,
  TicketStatusResult,
} from "./types.js";
import { OffPeakServerError } from "./types.js";

export interface OffPeakClientOptions {
  origin: string;
  credentials: OffPeakCredentials;
  /** Per-call timeout in ms (default 15000). Applies to all 4 methods. */
  controlTimeoutMs?: number;
  /** DI seam for tests. Default `globalThis.fetch`. */
  fetchImpl?: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Settle-specific timeout override (default = controlTimeoutMs). Set lower for fire-and-forget abort paths. */
  settleTimeoutMs?: number;
}

const DEFAULT_CONTROL_TIMEOUT_MS = 15_000;

/** Maximum tickets per `/ticket/status` batch (server cap, mirrors bundle behavior). */
const MAX_BATCH_STATUS = 100;

export interface OffPeakClient {
  getAvailability(signal?: AbortSignal): Promise<AvailabilityResult>;
  takeTicket(taskId: string, signal?: AbortSignal): Promise<TakeTicketResult>;
  batchStatus(ticketIds: string[], signal?: AbortSignal): Promise<BatchStatusResult>;
  /** Settle a ticket. `settleAsSuccess` controls 4xx behavior: if true (default), 4xx resolves as success (server already cleaned up). */
  settle(ticketId: string, opts?: { settleAsSuccess?: boolean; signal?: AbortSignal }): Promise<void>;
}

export function createOffPeakClient(opts: OffPeakClientOptions): OffPeakClient {
  const origin = opts.origin.replace(/\/+$/, "");
  const credentials = opts.credentials;
  const controlTimeoutMs = opts.controlTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;
  const settleTimeoutMs = opts.settleTimeoutMs ?? controlTimeoutMs;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  function buildHeaders(hasBody: boolean): Record<string, string> {
    const h: Record<string, string> = {
      authorization: `Bearer ${credentials.jwt}`,
      "x-coding-plan-api-key": credentials.codingPlanApiKey,
    };
    if (hasBody) h["content-type"] = "application/json";
    if (credentials.bigmodelOrganization) h["bigmodel-organization"] = credentials.bigmodelOrganization;
    if (credentials.bigmodelProject) h["bigmodel-project"] = credentials.bigmodelProject;
    return h;
  }

  async function request(
    method: string,
    path: string,
    body: unknown | undefined,
    timeoutMs: number,
    externalSignal: AbortSignal | undefined,
    isSettle: boolean,
    settleAsSuccess: boolean,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onExternalAbort = (): void => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }

    const url = `${origin}/api/v1/off-peak${path}`;
    const init: RequestInit = {
      method,
      headers: buildHeaders(body !== undefined),
      signal: controller.signal,
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    // Single outer try/finally covers BOTH fetch + body consumption.
    // Round 4 found that fetch rejection bypassed the body-phase cleanup,
    // leaving timer + listener leaked. Outer finally guarantees cleanup on every path.
    let resp: Response | undefined;
    let raw = "";
    try {
      try {
        resp = await fetchImpl(url, init);
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err);
        if (/abort/i.test(msg)) throw new OffPeakServerError(`off-peak request aborted: ${method} ${path}`, 0);
        throw new OffPeakServerError(`off-peak network error: ${method} ${path}: ${msg}`, 0);
      }
      raw = await resp.text();
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }

    if (!resp.ok) {
      // Settle-specific: 4xx means server already cleaned up (ticket expired/not_found) — treat as success.
      if (isSettle && settleAsSuccess && resp.status >= 400 && resp.status < 500) {
        return undefined;
      }
      let bizCode: string | undefined;
      let serverMsg = `HTTP ${resp.status}`;
      try {
        const parsed = JSON.parse(raw);
        bizCode = parsed?.code !== undefined ? String(parsed.code) : undefined;
        if (parsed?.msg) serverMsg = String(parsed.msg);
        else if (parsed?.message) serverMsg = String(parsed.message);
      } catch {
        if (raw.length > 0 && raw.length < 200) serverMsg = raw;
      }
      throw new OffPeakServerError(
        `off-peak ${method} ${path} failed: ${serverMsg}`,
        resp.status,
        bizCode,
      );
    }

    if (raw.length === 0) return undefined;
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      return undefined;
    }
    // Unwrap canonical envelope `{code:0, data:{...}}`. Non-zero `code` on HTTP 200
    // is a business-level error (mirrors `requestBizApi` in `auth/resolver.ts` and
    // the bundle's `n` helper: `y.code===0 ? y.data : y`).
    if (parsedJson && typeof parsedJson === "object") {
      const obj = parsedJson as { code?: unknown; data?: unknown; msg?: unknown; message?: unknown };
      if ("code" in obj || "data" in obj) {
        // NOTEPAD spec: canonical success is numeric `code === 0` ONLY (bundle's
        // `n` helper: `y.code===0 ? y.data : y`). Strict `===` rejects string "0",
        // numeric 200, undefined, etc. Responses without a numeric `code` field
        // but with `data` are NOT unwrapped (avoids masking biz errors).
        const code = obj.code;
        if (code !== 0) {
          if (code === undefined) {
            // Ambiguous envelope ({data:...} without code) — be conservative, don't unwrap.
            // Return parsedJson as-is so the caller sees the wrapper.
          } else {
            const msg = obj.msg ?? obj.message ?? `biz code ${String(code)}`;
            throw new OffPeakServerError(
              `off-peak ${method} ${path} biz error: ${msg}`,
              resp?.status ?? 0,
              String(code),
            );
          }
        } else if (obj.data !== undefined) {
          return obj.data;
        }
      }
    }
    return parsedJson;
  }

  return {
    async getAvailability(signal?: AbortSignal): Promise<AvailabilityResult> {
      const data = (await request("GET", "/ticket/availability", undefined, controlTimeoutMs, signal, false, false)) as
        | { can_take_number?: boolean; next_take_at?: number }
        | undefined;
      if (!data) throw new OffPeakServerError("off-peak availability empty response", 0);
      const canTakeNumber = data.can_take_number === true;
      if (!canTakeNumber && data.next_take_at === undefined) {
        throw new OffPeakServerError("off-peak availability missing next_take_at while unavailable", 0);
      }
      const result: AvailabilityResult = { canTakeNumber };
      if (data.next_take_at !== undefined) result.nextTakeAt = data.next_take_at;
      return result;
    },

    async takeTicket(taskId: string, signal?: AbortSignal): Promise<TakeTicketResult> {
      if (!taskId || typeof taskId !== "string") {
        throw new Error("takeTicket: taskId must be a non-empty string");
      }
      const data = (await request("POST", "/ticket", { task_id: taskId }, controlTimeoutMs, signal, false, false)) as
        | { ticket_id?: string; state?: string; position?: number; next_poll_after?: number }
        | undefined;
      if (!data || typeof data.ticket_id !== "string" || typeof data.state !== "string") {
        throw new OffPeakServerError("off-peak takeTicket malformed response", 0);
      }
      const state = data.state as TicketState;
      const result: TakeTicketResult = {
        ticketId: data.ticket_id,
        state,
        registeredAt: Date.now(),
      };
      if (data.position != null) result.position = data.position;
      if (data.next_poll_after !== undefined) result.nextPollAfterMs = data.next_poll_after * 1000;
      return result;
    },

    async batchStatus(ticketIds: string[], signal?: AbortSignal): Promise<BatchStatusResult> {
      if (ticketIds.length === 0) return { tickets: [] };
      const truncated = ticketIds.slice(0, MAX_BATCH_STATUS);
      const data = (await request(
        "POST",
        "/ticket/status",
        { ticket_ids: truncated },
        controlTimeoutMs,
        signal,
        false,
        false,
      )) as
        | { next_poll_after?: number; tickets?: Array<{ ticket_id?: string; state?: string; position?: number; active_deadline?: number }> }
        | undefined;
      if (!data || !Array.isArray(data.tickets)) {
        throw new OffPeakServerError("off-peak batchStatus malformed response", 0);
      }
      const result: BatchStatusResult = {
        tickets: data.tickets.map((t): TicketStatusResult => {
          if (typeof t.ticket_id !== "string" || typeof t.state !== "string") {
            throw new OffPeakServerError("off-peak batchStatus ticket entry malformed", 0);
          }
          const item: TicketStatusResult = {
            ticketId: t.ticket_id,
            state: t.state as TicketState,
          };
          if (t.position != null) item.position = t.position;
          if (t.active_deadline !== undefined) item.activeDeadline = t.active_deadline;
          return item;
        }),
      };
      if (data.next_poll_after !== undefined) result.nextPollAfterMs = data.next_poll_after * 1000;
      return result;
    },

    async settle(
      ticketId: string,
      opts: { settleAsSuccess?: boolean; signal?: AbortSignal } = {},
    ): Promise<void> {
      const settleAsSuccess = opts.settleAsSuccess !== false;
      await request(
        "POST",
        `/ticket/${encodeURIComponent(ticketId)}/settle`,
        undefined,
        settleTimeoutMs,
        opts.signal,
        true,
        settleAsSuccess,
      );
    },
  };
}
