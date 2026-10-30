/**
 * HTTP client for ZCode's manual-claim billing endpoints (weekend plans).
 *
 * Mirrors the ZCode 3.12.3 desktop client's `getManualClaimPlanPreviews` /
 * `claimManualPlan` EXACTLY — the claim plane carries a minimal header set,
 * NOT the identity bundle:
 *
 *   - `GET  {origin}/api/v1/zcode-plan/billing/preview?app_version=&platform=`
 *     headers: `Authorization: Bearer {jwt}` only (omitted entirely when
 *     anonymous — no Content-Type, no Accept)
 *   - `POST {origin}/api/v1/zcode-plan/billing/claim`  body `{plan_id}`
 *     headers (bundle order): Authorization, Content-Type,
 *     [X-Aliyun-Captcha-Verify-Param, [X-Aliyun-Captcha-Verify-Region]]
 *     (omitted when the 3.16.3 configs.captcha gate is off),
 *     X-ZCode-App-Version, X-Platform
 *
 * NOTE: an earlier revision sent the full identity set with X-Device-Mid
 * (empirically accepted during the 0828 campaign). The 3.12.3 client sends
 * the minimal set above — we now mirror that verbatim.
 *
 * DEVIATION (2026-09-18, wk-0918 campaign): the gateway again rejects
 * preview with biz 3001 "parameter error" unless the request carries a
 * UUID-format `X-Device-Mid` (re-verified empirically: minimal headers +
 * X-Device-Mid → 200 with the wk-0918 plan; the same request minus that
 * header → 3001; adding captcha headers alone does not help). Same gateway
 * behavior as the 0828 campaign — the 3.12.3 bundle itself is minimal, so
 * this is a deliberate deviation from the verbatim mirror: when
 * `deviceMid` is provided both calls append `X-Device-Mid` (last position,
 * matching its slot in the endpoint-routing `TV` identity set).
 *
 * MARKETING ENUMERATION (2026-10-30, wk-1030 campaign): the weekend plan
 * was distributed via the marketing banner (`createMarketingTouchService`,
 * present since ≤3.16.3 in the host bundle) instead of the billing preview —
 * `GET {origin}/api/v1/marketing/touch?seq=N` with X-Device-Mid (required,
 * UUID-parsed) / X-Client-Language / X-ZCode-App-Version / [Authorization].
 * The banner button action `claim_zcode_plan` carries the plan_id (and the
 * banner background args carry the full `zcode_plan` object); the desktop
 * renderer then calls the SAME `claimManualPlan` billing endpoint with that
 * plan_id. `getMarketingPlans` mirrors the snapshot parse; `listPlans`
 * merges both faces (billing preview first, banner plans appended).
 *
 * @see _reverse/NOTEPAD.md "claim/billing 平面" + "3.17.1 增补"五轮
 */
import type { ClaimablePlan, ClaimOutcome, PlanEntitlement } from "./types.js";
import { classifyClaimCode } from "./types.js";

export interface ClaimClientOptions {
  origin: string;
  /** OAuth JWT (`zcodejwttoken`); preview works without it, claim does not. */
  jwt?: string;
  appVersion: string;
  /** `${process.platform}-{arch}` in the real client (`u3()`). */
  platform: string;
  /**
   * Campaign-gated gateway requirement (0828 + 0918): UUID-format
   * `X-Device-Mid`. When omitted no device header is sent.
   */
  deviceMid?: string;
  /**
   * Marketing-face device id (`marketing/touch` uuid.parse's it — required
   * there even when the billing campaign gate is off). The caller supplies
   * a stable value (config `identity.deviceMid` or a derived fallback).
   */
  marketingDeviceMid?: string;
  /** Marketing-face locale header. Default `zh-CN` (client enum zh-CN|en-US). */
  language?: string;
  /** Per-call timeout in ms. Default `15000` (bundle `ss`). */
  timeoutMs?: number;
  /** DI seam for tests. Default `globalThis.fetch`. */
  fetchImpl?: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export interface ClaimClient {
  getPreviews(signal?: AbortSignal): Promise<ClaimablePlan[]>;
  /** Banner-distributed plans from `marketing/touch` (wk-1030 shape). */
  getMarketingPlans(signal?: AbortSignal): Promise<ClaimablePlan[]>;
  /** Preview + banner merged, deduped by planId (preview wins). */
  listPlans(signal?: AbortSignal): Promise<ClaimablePlan[]>;
  claim(planId: string, captcha?: { verifyParam: string; region?: string }, signal?: AbortSignal): Promise<ClaimOutcome>;
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
  const deviceMid = opts.deviceMid?.trim() || undefined;
  const marketingDeviceMid = opts.marketingDeviceMid?.trim() || undefined;
  const language = opts.language?.trim() || "zh-CN";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  // Marketing snapshot sequence — the client keeps a module-level counter
  // (`Xde++`); a per-client counter from 0 is equivalent per session.
  let marketingSeq = 0;

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

  /** Marketing snapshot delivery (wk-1030 shape, parsed defensively). */
  interface MarketingNode {
    action?: { type?: unknown; args?: { plan_id?: unknown } };
    buttons?: MarketingNode[];
  }
  interface MarketingDelivery {
    campaign_id?: unknown;
    banner?: MarketingNode & { background?: { args?: Record<string, unknown> } };
    popup?: MarketingNode & { background?: { args?: Record<string, unknown> } };
  }

  /** Collect `zcode_plan` RawPlan objects anywhere inside a delivery (depth-limited). */
  function collectZcodePlans(node: unknown, out: RawPlan[], depth = 0): void {
    if (depth > 4 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) collectZcodePlans(item, out, depth + 1);
      return;
    }
    const rec = node as Record<string, unknown>;
    const zp = rec.zcode_plan;
    if (zp && typeof zp === "object" && !Array.isArray(zp)) out.push(zp as RawPlan);
    for (const value of Object.values(rec)) collectZcodePlans(value, out, depth + 1);
  }

  /**
   * deliveries → claimable plans: button action `claim_zcode_plan` supplies
   * the plan_id (schema-conformant minimal args); the banner background args
   * carry the full `zcode_plan` object for enrichment when the ids match.
   */
  function parseMarketingDeliveries(deliveries: unknown[]): ClaimablePlan[] {
    const plans: ClaimablePlan[] = [];
    const seen = new Set<string>();
    for (const d of deliveries) {
      if (d === null || typeof d !== "object") continue;
      const delivery = d as MarketingDelivery;
      const campaignId = typeof delivery.campaign_id === "string" ? delivery.campaign_id : undefined;
      const richPlans: RawPlan[] = [];
      collectZcodePlans(delivery, richPlans);
      const richById = new Map(richPlans.map((p) => [p.plan_id?.trim() ?? "", p]));
      const buttonHosts = [delivery.banner, delivery.popup];
      for (const host of buttonHosts) {
        for (const button of host?.buttons ?? []) {
          if (button?.action?.type !== "claim_zcode_plan") continue;
          const planId = typeof button.action.args?.plan_id === "string" ? button.action.args.plan_id.trim() : "";
          if (!planId || seen.has(planId)) continue;
          const raw = richById.get(planId) ?? { plan_id: planId };
          const plan = parsePlan(raw);
          if (!plan) continue;
          seen.add(planId);
          plan.source = "banner";
          if (campaignId) plan.campaignId = campaignId;
          plans.push(plan);
        }
      }
    }
    return plans;
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
      // Bundle: `Authorization: Bearer` only when a JWT exists; anonymous
      // preview sends NO headers at all. X-Device-Mid is appended last when
      // provided (campaign gateway requirement — see file header).
      const headers: Record<string, string> = jwt ? { Authorization: `Bearer ${jwt}` } : {};
      if (deviceMid) headers["X-Device-Mid"] = deviceMid;
      const { status, json, text } = await request("GET", url, { headers, signal });
      // code 0 + NO data field (observed 2026-10-30, wk-1030): the billing
      // preview simply has no manual campaigns for this account — the
      // desktop client throws `manual_claim_preview_missing_data` here, but
      // its banner flow never calls preview. For enumeration we treat it as
      // an empty list so the marketing fallback can supply the plans.
      if (status >= 200 && status < 300 && json?.code === 0 && json?.data === undefined) {
        return [];
      }
      if (status < 200 || status >= 300 || (json?.code !== undefined && json.code !== 0) || json?.data === undefined) {
        const { code, message } = unwrapError(json, status, text);
        throw new ClaimPreviewError(`claim preview failed (${code}): ${message}`, status, code);
      }
      const data = json.data as { plans?: RawPlan[] };
      return ((data.plans ?? []) as RawPlan[]).flatMap((p) => {
        const plan = parsePlan(p);
        return plan ? [plan] : [];
      });
    },

    async getMarketingPlans(signal?: AbortSignal): Promise<ClaimablePlan[]> {
      if (!marketingDeviceMid) return [];
      const headers: Record<string, string> = {
        "X-Device-Mid": marketingDeviceMid,
        "X-Client-Language": language,
        "X-ZCode-App-Version": opts.appVersion,
      };
      if (jwt) headers["Authorization"] = `Bearer ${jwt}`;
      const path = `/api/v1/marketing/touch?seq=${marketingSeq++}`;
      const { status, json, text } = await request("GET", path, { headers, signal });
      if (status < 200 || status >= 300 || (json?.code !== undefined && json.code !== 0)) {
        // Marketing failures never block enumeration — log-free empty result
        // (the billing face stays authoritative when both are alive).
        void text;
        return [];
      }
      const deliveries = (json?.data as { deliveries?: unknown[] } | undefined)?.deliveries ?? [];
      return parseMarketingDeliveries(deliveries);
    },

    async listPlans(signal?: AbortSignal): Promise<ClaimablePlan[]> {
      const [preview, banner] = await Promise.all([
        this.getPreviews(signal).catch((err: unknown) => {
          // 404 = campaign endpoint not deployed (pre-launch state) — keep
          // polling semantics to the caller by surfacing an EMPTY list here
          // only for that case; real errors propagate.
          if (err instanceof ClaimPreviewError && err.status === 404) return [];
          throw err;
        }),
        this.getMarketingPlans(signal),
      ]);
      const seen = new Set(preview.map((p) => p.planId));
      const merged = [...preview];
      for (const p of banner) {
        if (seen.has(p.planId)) continue;
        seen.add(p.planId);
        merged.push(p);
      }
      return merged;
    },

    async claim(planId: string, captcha?: { verifyParam: string; region?: string }, signal?: AbortSignal): Promise<ClaimOutcome> {
      if (!jwt) return { ok: false, planId, failureKind: "login_required", code: 401, message: "manual_claim_login_required" };
      // Bundle `claimManualPlan` header order: Authorization, Content-Type,
      // [captcha param, [captcha region]] (omitted entirely when the 3.16.3
      // configs.captcha gate is off — captcha arg undefined),
      // X-ZCode-App-Version, X-Platform, [X-Device-Mid] (campaign-gated
      // deviation, same as preview).
      const headers: Record<string, string> = {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      };
      if (captcha) {
        headers["X-Aliyun-Captcha-Verify-Param"] = captcha.verifyParam;
        if (captcha.region) headers["X-Aliyun-Captcha-Verify-Region"] = captcha.region;
      }
      headers["X-ZCode-App-Version"] = opts.appVersion;
      headers["X-Platform"] = opts.platform;
      if (deviceMid) headers["X-Device-Mid"] = deviceMid;
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
