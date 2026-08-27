/**
 * HTTP client for ZCode's manual-claim billing endpoints (weekend plans).
 *
 * Mirrors the ZCode 3.10 desktop client's `getManualClaimPlanPreviews` /
 * `claimManualPlan`:
 *   - `GET  {origin}/api/v1/zcode-plan/billing/preview?app_version=&platform=`
 *   - `POST {origin}/api/v1/zcode-plan/billing/claim`  body `{plan_id}`
 *
 * Claim headers: `Authorization: Bearer {jwt}` (OAuth), Aliyun captcha
 * verify param/region (same token source as the start-plan gateway),
 * `X-ZCode-App-Version` and `X-Platform` (part of server-side eligibility).
 *
 * @see _reverse/NOTEPAD.md "Manual Claim Plan" section.
 */
import type { ClaimablePlan, ClaimOutcome, PlanEntitlement } from "./types.js";
import { classifyClaimCode } from "./types.js";

export interface ClaimClientOptions {
  origin: string;
  /** OAuth JWT (`zcodejwttoken`); preview works without it, claim does not. */
  jwt?: string;
  appVersion: string;
  /** `${process.platform}-${process.arch}` in the real client. */
  platform: string;
  /** Per-call timeout in ms. Default `15000`. */
  timeoutMs?: number;
  /** DI seam for tests. Default `globalThis.fetch`. */
  fetchImpl?: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export interface ClaimClient {
  getPreviews(signal?: AbortSignal): Promise<ClaimablePlan[]>;
  claim(planId: string, captcha: { verifyParam: string; region?: string }, signal?: AbortSignal): Promise<ClaimOutcome>;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** Preview failure with the HTTP status preserved (404 = campaign not deployed yet). */
export class ClaimPreviewError extends Error {
  readonly status: number;
  readonly code: number | string;
  constructor(message: string, status: number, code: number | string) {
    super(message);
    this.name = "ClaimPreviewError";
    this.status = status;
    this.code = code;
  }
}

interface RawEntitlement {
  entitlement_id?: string;
  show_name?: string;
  meter?: string;
  unit_type?: string;
  capabilities?: string[];
  grant_units?: number;
  period?: string;
  priority?: number;
  effective_at?: number;
}

interface RawPlan {
  plan_id?: string;
  name?: string;
  description?: string;
  priority?: number;
  entitlements?: RawEntitlement[];
  starts_at?: number;
  ends_at?: number;
}

export function createClaimClient(opts: ClaimClientOptions): ClaimClient {
  const origin = opts.origin.replace(/\/+$/, "");
  const jwt = opts.jwt?.trim() || undefined;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  function parseEntitlement(c: RawEntitlement): PlanEntitlement | null {
    const entitlementId = c.entitlement_id?.trim() ?? "";
    if (!entitlementId) return null;
    const e: PlanEntitlement = {
      entitlementId,
      showName: c.show_name?.trim() ?? "",
      meter: c.meter?.trim() ?? "",
      unitType: c.unit_type?.trim() ?? "",
      capabilities: Array.isArray(c.capabilities) ? c.capabilities : [],
      grantUnits: Number.isFinite(c.grant_units) ? (c.grant_units as number) : 0,
      period: c.period?.trim() ?? "",
      priority: Number.isFinite(c.priority) ? (c.priority as number) : 0,
    };
    if (Number.isFinite(c.effective_at)) e.effectiveAt = c.effective_at as number;
    return e;
  }

  function parsePlan(p: RawPlan): ClaimablePlan | null {
    const planId = p.plan_id?.trim() ?? "";
    if (!planId) return null;
    const plan: ClaimablePlan = {
      planId,
      name: p.name?.trim() || planId,
      description: p.description?.trim() ?? "",
      priority: Number.isFinite(p.priority) ? (p.priority as number) : 0,
      entitlements: (p.entitlements ?? []).flatMap((c) => {
        const e = parseEntitlement(c);
        return e ? [e] : [];
      }),
    };
    if (Number.isFinite(p.starts_at)) plan.startsAt = p.starts_at as number;
    if (Number.isFinite(p.ends_at)) plan.endsAt = p.ends_at as number;
    return plan;
  }

  async function request(
    method: string,
    path: string,
    init: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal },
  ): Promise<{ status: number; json: Record<string, unknown> | undefined; text: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onExternalAbort = (): void => controller.abort();
    if (init.signal) {
      if (init.signal.aborted) controller.abort();
      else init.signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    let resp: Response;
    try {
      resp = await fetchImpl(`${origin}${path}`, {
        method,
        headers: init.headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });
      const text = await resp.text();
      let json: Record<string, unknown> | undefined;
      try {
        const parsed = JSON.parse(text) as unknown;
        if (parsed && typeof parsed === "object") json = parsed as Record<string, unknown>;
      } catch { /* non-JSON body surfaced via text */ }
      return { status: resp.status, json, text };
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  function unwrapError(json: Record<string, unknown> | undefined, status: number, text: string): { code: number | string; message: string } {
    const code = json?.code !== undefined ? (json.code as number | string) : status >= 400 ? status : -1;
    const rawMsg = json?.msg ?? json?.message;
    const message = typeof rawMsg === "string" && rawMsg.trim() ? rawMsg.trim() : text.length > 0 && text.length < 200 ? text : `HTTP ${status}`;
    return { code, message };
  }

  return {
    async getPreviews(signal?: AbortSignal): Promise<ClaimablePlan[]> {
      const url = `/api/v1/zcode-plan/billing/preview?app_version=${encodeURIComponent(opts.appVersion)}&platform=${encodeURIComponent(opts.platform)}`;
      const headers: Record<string, string> = {};
      if (jwt) headers.authorization = `Bearer ${jwt}`;
      const { status, json, text } = await request("GET", url, { headers, signal });
      if (status < 200 || status >= 300 || (json?.code !== undefined && json.code !== 0) || json?.data === undefined) {
        const { code, message } = unwrapError(json, status, text);
        throw new ClaimPreviewError(`claim preview failed (${code}): ${message}`, status, code);
      }
      const data = json.data as { plans?: RawPlan[] };
      return (data.plans ?? []).flatMap((p) => {
        const plan = parsePlan(p);
        return plan ? [plan] : [];
      });
    },

    async claim(planId: string, captcha: { verifyParam: string; region?: string }, signal?: AbortSignal): Promise<ClaimOutcome> {
      if (!jwt) return { ok: false, planId, failureKind: "login_required", code: 401, message: "manual_claim_login_required" };
      const headers: Record<string, string> = {
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
        "x-aliyun-captcha-verify-param": captcha.verifyParam,
        "x-zcode-app-version": opts.appVersion,
        "x-platform": opts.platform,
      };
      if (captcha.region) headers["x-aliyun-captcha-verify-region"] = captcha.region;
      const { status, json, text } = await request("POST", "/api/v1/zcode-plan/billing/claim", { body: { plan_id: planId }, headers, signal });

      const data = json?.data as { plan?: RawPlan } | undefined;
      const bizCode = json?.code !== undefined ? (json.code as number) : undefined;
      const plan = data?.plan;
      if (status >= 200 && status < 300 && bizCode === 0 && plan) {
        const out: ClaimOutcome = { ok: true, planId };
        if (Number.isFinite(plan.starts_at)) out.startsAt = plan.starts_at as number;
        if (Number.isFinite(plan.ends_at)) out.endsAt = plan.ends_at as number;
        return out;
      }
      const { code, message } = unwrapError(json, status, text);
      const failureEndsAt = Number.isFinite(plan?.ends_at) ? (plan?.ends_at as number) : undefined;
      const httpDerived = status >= 400 && bizCode === undefined;
      return {
        ok: false,
        planId,
        failureKind: httpDerived ? (status === 401 ? "login_required" : "http_error") : classifyClaimCode(code),
        code,
        message,
        ...(failureEndsAt !== undefined ? { failureEndsAt } : {}),
      };
    },
  };
}
