/**
 * GET /quota — live quota snapshot from both upstream quota planes.
 *
 * Two planes, mirroring the official desktop panel's split (`getSnapshotForRequest`):
 *  - credits plane: `zcode-plan/billing/balance` + `billing/preview` on the
 *    configured claim origin with the stored OAuth plan JWT and the desktop
 *    identity fingerprint (start-plan/trial credit buckets);
 *  - coding plane: `GET {coding origin}/api/monitor/usage/quota/limit` with the
 *    stored coding-plan API key in `authorization` (bundle `wK`/`Z_`+`md`) —
 *    the windowed usage limits of individual coding plans (`data.limits[]`,
 *    TOKENS_LIMIT = prompt windows; TIME_LIMIT = tool-call window).
 *
 * The billing gateway requires a stable `X-Device-Mid`, so the config identity
 * is forwarded unchanged.
 *
 * @see _reverse/NOTEPAD.md "coding-plan 用量平面" (chain extracted from
 *      zcode.z.ai desktop bundle `getSnapshotForQuery`/`BigModelUsageQuotaProvider`)
 */
import os from "node:os";
import { loadCredential } from "../auth/store.js";
import { buildIdentityHeaders, normalizePrintableHeaderValue } from "../proxy/identity.js";
import { inspectJwt } from "../auth/jwt-age.js";
import { credentialString, type Credential } from "../auth/types.js";
import type { ProxyConfig } from "../config/types.js";
import { errorResponse } from "../proxy/handler.js";

interface QuotaBalanceEntry {
  showName: string;
  remainingUnits: number;
  totalUnits: number;
  usedUnits: number;
  unitType?: string;
  expiresAt?: number;
}

interface QuotaPlanEntry {
  planId: string;
  name: string;
  description?: string;
  entitlements: Array<{ showName: string; grantUnits: number; unitType: string; effectiveAt?: number }>;
}

/**
 * One usage window from the coding-plan monitor plane (`limits[]` entry).
 * `type` values are server-defined. Live (2026-10-12, max tier): the 5h/weekly
 * prompt windows are `TOKENS_LIMIT`; `TIME_LIMIT` is the MCP tool-call window
 * (remaining counts tool calls, percentage = used share — the official panel's
 * "工具调用" card), not a prompt window.
 */
interface QuotaCodingLimit {
  type: string;
  unit?: string;
  /** Upstream `number` — window total (undefined = unlimited/unreported). */
  total?: number;
  /** Upstream `usage`. */
  used?: number;
  remaining?: number;
  percentage?: number;
  /** Epoch seconds or milliseconds, as upstream sends it (both seen in the wild). */
  nextResetTime?: number;
}

interface QuotaCodingPlan {
  /** Plan tier string from upstream (e.g. `"max"`); null when unreported. */
  level: string | null;
  limits: QuotaCodingLimit[];
}

export interface QuotaSnapshot {
  provider: string;
  serverTime: number;
  /**
   * Stored start-plan JWT age (informational). The token has no `exp` and is
   * not rejected by age — an 8-day-old JWT still serves billing/balance. Only
   * a real 401/3012 from the billing gateway indicates re-login is needed,
   * which surfaces in `errors`.
   */
  jwt: { ageHours: number; issuedAt: number } | null;
  balances: QuotaBalanceEntry[];
  claimablePlans: QuotaPlanEntry[];
  /**
   * Coding-plan monitor plane snapshot; null when the endpoint failed or was
   * unreachable — the official panel tolerates the same way (quota: null).
   */
  codingPlan: QuotaCodingPlan | null;
  errors: string[];
}

/** Query one billing/monitor URL, tolerating per-endpoint failures. */
async function fetchBilling(
  origin: string,
  path: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<{ code?: number; msg?: string; data?: unknown; success?: unknown } | null> {
  try {
    const resp = await fetchImpl(`${origin.replace(/\/+$/, "")}${path}`, { headers });
    const text = await resp.text();
    try {
      return JSON.parse(text) as { code?: number; msg?: string; data?: unknown; success?: unknown };
    } catch {
      return { code: resp.status, msg: text.slice(0, 120) };
    }
  } catch (e) {
    return { code: -1, msg: String(e).slice(0, 120) };
  }
}

/** Mirror of the bundle's `$_` (isSuccessfulBigModelEnvelope): `success !== false` and code absent/0/200. */
function isSuccessfulEnvelope(e: { code?: number; success?: unknown }): boolean {
  return e.success !== false && (e.code === undefined || e.code === 0 || e.code === 200);
}

/** Coding origin per stored credential's provider — `https://api.z.ai` / `https://open.bigmodel.cn`. */
function codingOrigin(config: ProxyConfig, provider: Credential["provider"]): string | null {
  // zai_cn folds into the BIGMODEL family (desktop
  // `resolveStartPlanFamilyFromOAuthProvider`: zai_cn → "bigmodel") — the
  // config providers map has no zai_cn key.
  const family = provider === "zai_cn" ? "bigmodel" : provider;
  try {
    return new URL(config.providers[family].openaiBase).origin;
  } catch {
    return null;
  }
}

/** Normalize one upstream limit entry; rows without any usable number are display noise and dropped. */
function parseCodingLimit(e: any): QuotaCodingLimit | null {
  if (typeof e?.type !== "string" || e.type.trim() === "") return null;
  const total = toFiniteNumber(e.number);
  const used = toFiniteNumber(e.usage);
  const remaining = toFiniteNumber(e.remaining);
  if (total === undefined && used === undefined && remaining === undefined) return null;
  const pct = toFiniteNumber(e.percentage);
  const reset = toFiniteNumber(e.next_reset_time ?? e.nextResetTime);
  const unit = typeof e.unit === "string" && e.unit.trim() !== "" ? e.unit : undefined;
  return {
    type: e.type.trim(),
    ...(unit ? { unit } : {}),
    ...(total !== undefined ? { total } : {}),
    ...(used !== undefined ? { used } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
    ...(pct !== undefined ? { percentage: pct } : {}),
    ...(reset !== undefined ? { nextResetTime: reset } : {}),
  };
}

/** Coerce an upstream value to a finite number, or undefined (never NaN — JSON.stringify would emit null). */
function toFiniteNumber(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** Build the quota snapshot. Exported for tests. `loadCredentialImpl` is injectable for tests. */
export async function collectQuotaSnapshot(
  config: ProxyConfig,
  fetchImpl: typeof fetch = fetch,
  loadCredentialImpl: typeof loadCredential = loadCredential,
): Promise<QuotaSnapshot> {
  const cred = await loadCredentialImpl();
  if (!cred) {
    throw new Error("not logged in (run: zcode-proxy auth login)");
  }
  const jwtInfo = cred.jwt ? inspectJwt(cred.jwt) : null;
  const jwt = jwtInfo
    ? { ageHours: Number(jwtInfo.ageHours.toFixed(2)), issuedAt: jwtInfo.iat }
    : null;
  const identity = config.identity;
  const idHeaders = buildIdentityHeaders(identity);
  // The claim client drops X-ZCode-Agent for zcode.z.ai control-plane calls;
  // the billing gateway follows the same precedent.
  delete idHeaders["X-ZCode-Agent"];
  const headers: Record<string, string> = { ...idHeaders, authorization: `Bearer ${cred.jwt}`, Accept: "application/json" };
  // Billing fingerprint is reconstructed from the observed claim-client format
  // (`${platform}-${arch}`). Reuses identity.ts's env-override normalization
  // (same ZCODE_IDENTITY_PLATFORM/ARCH overrides the proxy headers use —
  // Android seeds linux-x64 via index.ts); empty or non-printable overrides
  // fall back to the real values — an empty override must not yield
  // `-x64`/`linux-`.
  // NOTE: ProxyIdentity has no platform/arch fields — do not read them off `identity`.
  const platform = `${normalizePrintableHeaderValue(process.env.ZCODE_IDENTITY_PLATFORM) ?? process.platform}-${normalizePrintableHeaderValue(process.env.ZCODE_IDENTITY_ARCH) ?? os.arch()}`;
  const origin = config.claim.origin || "https://zcode.z.ai";
  const appVersion = identity.appVersion;

  const errors: string[] = [];
  // Credits plane needs the plan JWT; a coding-plan account without one still
  // gets its monitor-plane limits below instead of a dead snapshot.
  let balance: Awaited<ReturnType<typeof fetchBilling>> = null;
  let preview: Awaited<ReturnType<typeof fetchBilling>> = null;
  if (cred.jwt) {
    [balance, preview] = await Promise.all([
      fetchBilling(origin, `/api/v1/zcode-plan/billing/balance?app_version=${encodeURIComponent(appVersion)}&platform=${encodeURIComponent(platform)}`, headers, fetchImpl),
      fetchBilling(origin, `/api/v1/zcode-plan/billing/preview?app_version=${encodeURIComponent(appVersion)}&platform=${encodeURIComponent(platform)}`, headers, fetchImpl),
    ]);
    if (balance && !isSuccessfulEnvelope(balance)) errors.push(`balance: ${balance.code} ${balance.msg ?? ""}`.trim());
    if (preview && !isSuccessfulEnvelope(preview)) errors.push(`preview: ${preview.code} ${preview.msg ?? ""}`.trim());
  } else {
    errors.push("balance: no plan JWT — credits plane unavailable (re-login to capture it)");
  }

  // Coding plane: same contract the official usage panel uses for individual
  // coding plans (`authorization` = the raw API key, personal scope — no team
  // headers, no `?type=2`). Failures degrade to null like the official
  // `fetchQuota().catch(() => null)`, never killing the credits data.
  let codingPlan: QuotaCodingPlan | null = null;
  const cOrigin = codingOrigin(config, cred.provider);
  if (cOrigin) {
    const cEnvelope = await fetchBilling(cOrigin, "/api/monitor/usage/quota/limit", {
      authorization: credentialString(cred),
      accept: "application/json",
    }, fetchImpl);
    if (cEnvelope && isSuccessfulEnvelope(cEnvelope)) {
      const d = (cEnvelope.data ?? {}) as { level?: unknown; limits?: unknown };
      codingPlan = {
        level: typeof d.level === "string" && d.level.trim() !== "" ? d.level.trim() : null,
        limits: (Array.isArray(d.limits) ? d.limits : []).map(parseCodingLimit).filter((l): l is QuotaCodingLimit => l !== null),
      };
    } else {
      errors.push(`coding: ${cEnvelope ? `${cEnvelope.code} ${cEnvelope.msg ?? ""}`.trim() : "request failed"}`);
    }
  }

  const balances: QuotaBalanceEntry[] = [];
  const balanceData = (balance?.data ?? {}) as { balances?: any[]; server_time?: number };
  for (const b of Array.isArray(balanceData.balances) ? balanceData.balances : []) {
    // unitType/expiresAt camelCase aliases observed live alongside snake_case;
    // accept both so neither casing drops the field.
    const expiresAt = toFiniteNumber(b.expires_at ?? b.expiresAt);
    const unitType = b.unit_type ?? b.unitType;
    balances.push({
      showName: String(b.show_name ?? ""),
      remainingUnits: toFiniteNumber(b.remaining_units ?? b.remainingUnits) ?? 0,
      totalUnits: toFiniteNumber(b.total_units ?? b.totalUnits) ?? 0,
      usedUnits: toFiniteNumber(b.used_units ?? b.usedUnits) ?? 0,
      ...(unitType ? { unitType: String(unitType) } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    });
  }

  const claimablePlans: QuotaPlanEntry[] = [];
  const previewData = (preview?.data ?? {}) as { plans?: any[] };
  for (const p of Array.isArray(previewData.plans) ? previewData.plans : []) {
    claimablePlans.push({
      planId: String(p.plan_id ?? ""),
      name: String(p.name ?? p.plan_id ?? ""),
      ...(p.description ? { description: String(p.description) } : {}),
      entitlements: (Array.isArray(p.entitlements) ? p.entitlements : []).map((e: any) => ({
        showName: String(e.show_name ?? ""),
        grantUnits: toFiniteNumber(e.grant_units ?? e.grantUnits) ?? 0,
        unitType: String(e.unit_type ?? e.unitType ?? "token"),
        ...(toFiniteNumber(e.effective_at ?? e.effectiveAt) !== undefined
          ? { effectiveAt: toFiniteNumber(e.effective_at ?? e.effectiveAt) as number }
          : {}),
      })),
    });
  }

  return {
    provider: config.provider,
    serverTime: toFiniteNumber(balanceData.server_time) ?? Math.floor(Date.now() / 1000),
    jwt,
    balances,
    claimablePlans,
    codingPlan,
    errors,
  };
}

/** Handle GET /quota — JSON snapshot with the proxy error envelope on failure. `loadCredentialImpl` is injectable for tests. */
export async function handleQuota(
  config: ProxyConfig,
  fetchImpl: typeof fetch = fetch,
  loadCredentialImpl: typeof loadCredential = loadCredential,
): Promise<Response> {
  try {
    const snapshot = await collectQuotaSnapshot(config, fetchImpl, loadCredentialImpl);
    return new Response(JSON.stringify(snapshot, null, 1), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    return errorResponse(503, "quota_unavailable", `quota query failed: ${(e as Error).message}`);
  }
}
