/**
 * Start Plan billing helpers — quota buckets must exist before /v1/messages works.
 */
const BILLING_BASE = "https://zcode.z.ai/api/v1/zcode-plan/billing";

export interface BalanceBucket {
  entitlement_id?: string;
  show_name?: string;
  remaining_units?: number;
  available_units?: number;
}

export interface BalanceResponse {
  ok: boolean;
  status: number;
  balances: BalanceBucket[];
  raw?: string;
}

function authHeaders(jwt: string): Record<string, string> {
  return {
    authorization: `Bearer ${jwt}`,
    accept: "application/json",
    "User-Agent": "ZCode/3.1.2",
    "X-ZCode-App-Version": "3.1.2",
  };
}

export async function fetchBillingBalance(jwt: string): Promise<BalanceResponse> {
  const resp = await fetch(`${BILLING_BASE}/balance`, { headers: authHeaders(jwt) });
  const text = await resp.text();
  try {
    const json = JSON.parse(text) as { data?: { balances?: BalanceBucket[] } };
    const balances = json?.data?.balances ?? [];
    return { ok: resp.ok, status: resp.status, balances, raw: text };
  } catch {
    return { ok: resp.ok, status: resp.status, balances: [], raw: text };
  }
}

/** billing/current often appears before balance buckets are allocated for new accounts. */
export async function fetchBillingCurrent(jwt: string): Promise<{ ok: boolean; status: number }> {
  const resp = await fetch(`${BILLING_BASE}/current?app_version=3.1.2`, {
    headers: authHeaders(jwt),
  });
  return { ok: resp.ok, status: resp.status };
}

export async function waitForQuotaBuckets(
  jwt: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<BalanceResponse> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const intervalMs = opts.intervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;

  let last: BalanceResponse = { ok: false, status: 0, balances: [] };

  while (Date.now() < deadline) {
    await fetchBillingCurrent(jwt);
    last = await fetchBillingBalance(jwt);
    if (last.balances.length > 0) return last;
    await sleep(intervalMs);
  }

  return last;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
