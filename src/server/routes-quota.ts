/**
 * GET /quota — live free-quota snapshot from ZCode billing endpoints.
 *
 * Queries the same control plane the desktop client uses (`billing/balance` +
 * `billing/preview` on the configured claim origin) with the stored OAuth JWT
 * and the full desktop identity fingerprint. The billing gateway requires a
 * stable `X-Device-Mid`, so the config identity is forwarded unchanged.
 *
 * @see scripts in vibe-coding-labs/zcode-reverse-engineer (header shape) and
 *      zcode.z.ai desktop bundle `pio()` (identity header semantics).
 */
import { loadCredential } from "../auth/store.js";
import { buildIdentityHeaders } from "../proxy/identity.js";
import { inspectJwt } from "../auth/jwt-age.js";
import type { ProxyConfig } from "../config/types.js";
import { errorResponse } from "../proxy/handler.js";

export interface QuotaBalanceEntry {
  showName: string;
  remainingUnits: number;
  totalUnits: number;
  usedUnits: number;
  unitType?: string;
  expiresAt?: number;
}

export interface QuotaPlanEntry {
  planId: string;
  name: string;
  description?: string;
  entitlements: Array<{ showName: string; grantUnits: number; unitType: string; effectiveAt?: number }>;
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
  errors: string[];
}

/** Query one billing URL, tolerating per-endpoint failures. */
async function fetchBilling(
  origin: string,
  path: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<{ code?: number; msg?: string; data?: unknown } | null> {
  try {
    const resp = await fetchImpl(`${origin.replace(/\/+$/, "")}${path}`, { headers });
    const text = await resp.text();
    try {
      return JSON.parse(text) as { code?: number; msg?: string; data?: unknown };
    } catch {
      return { code: resp.status, msg: text.slice(0, 120) };
    }
  } catch (e) {
    return { code: -1, msg: String(e).slice(0, 120) };
  }
}

/** Build the billing snapshot. Exported for tests. */
export async function collectQuotaSnapshot(config: ProxyConfig, fetchImpl: typeof fetch = fetch): Promise<QuotaSnapshot> {
  const cred = await loadCredential();
  if (!cred?.jwt) {
    throw new Error("not logged in — no JWT credential (run: zcode-proxy auth login)");
  }
  const jwtInfo = inspectJwt(cred.jwt);
  const jwt = jwtInfo
    ? { ageHours: Number(jwtInfo.ageHours.toFixed(2)), issuedAt: jwtInfo.iat }
    : null;
  const identity = config.identity;
  const idHeaders = buildIdentityHeaders(identity);
  // The claim client drops X-ZCode-Agent for zcode.z.ai control-plane calls;
  // the billing gateway follows the same precedent.
  delete idHeaders["X-ZCode-Agent"];
  const headers: Record<string, string> = { ...idHeaders, authorization: `Bearer ${cred.jwt}`, Accept: "application/json" };
  const platform = `${identity.platform}-${identity.arch}`;
  const origin = config.claim.origin || "https://zcode.z.ai";
  const appVersion = identity.appVersion;

  const errors: string[] = [];
  const [balance, preview] = await Promise.all([
    fetchBilling(origin, `/api/v1/zcode-plan/billing/balance?app_version=${encodeURIComponent(appVersion)}&platform=${encodeURIComponent(platform)}`, headers, fetchImpl),
    fetchBilling(origin, `/api/v1/zcode-plan/billing/preview?app_version=${encodeURIComponent(appVersion)}&platform=${encodeURIComponent(platform)}`, headers, fetchImpl),
  ]);
  if (balance && balance.code !== 0) errors.push(`balance: ${balance.code} ${balance.msg ?? ""}`.trim());
  if (preview && preview.code !== 0) errors.push(`preview: ${preview.code} ${preview.msg ?? ""}`.trim());

  const balances: QuotaBalanceEntry[] = [];
  const balanceData = (balance?.data ?? {}) as { balances?: any[]; server_time?: number };
  for (const b of Array.isArray(balanceData.balances) ? balanceData.balances : []) {
    balances.push({
      showName: String(b.show_name ?? ""),
      remainingUnits: Number(b.remaining_units ?? 0),
      totalUnits: Number(b.total_units ?? 0),
      usedUnits: Number(b.used_units ?? 0),
      ...(b.unit_type ? { unitType: String(b.unit_type) } : {}),
      ...(Number.isFinite(b.expires_at) ? { expiresAt: b.expires_at as number } : {}),
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
        grantUnits: Number(e.grant_units ?? 0),
        unitType: String(e.unit_type ?? "token"),
        ...(Number.isFinite(e.effective_at) ? { effectiveAt: e.effective_at as number } : {}),
      })),
    });
  }

  return {
    provider: config.provider,
    serverTime: Number(balanceData.server_time ?? Math.floor(Date.now() / 1000)),
    jwt,
    balances,
    claimablePlans,
    errors,
  };
}

/** Handle GET /quota — JSON snapshot with the proxy error envelope on failure. */
export async function handleQuota(config: ProxyConfig, fetchImpl: typeof fetch = fetch): Promise<Response> {
  try {
    const snapshot = await collectQuotaSnapshot(config, fetchImpl);
    return new Response(JSON.stringify(snapshot, null, 1), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    return errorResponse(503, "quota_unavailable", `quota query failed: ${(e as Error).message}`);
  }
}
