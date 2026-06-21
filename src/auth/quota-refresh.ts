/**
 * Periodically re-check billing for exhausted accounts and reactivate when quota returns.
 */
import type { AccountPool } from "./account-pool.js";
import { fetchBillingBalance, type BalanceResponse } from "./billing.js";

export type FetchBalanceFn = (jwt: string) => Promise<BalanceResponse>;

export function accountHasQuota(balance: BalanceResponse): boolean {
  if (!balance.ok || balance.balances.length === 0) return false;
  return balance.balances.some(
    (b) => (b.remaining_units ?? b.available_units ?? 0) > 0,
  );
}

export class QuotaRefreshScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private pool: AccountPool,
    private intervalMs: number,
    private fetchBalance: FetchBalanceFn = fetchBillingBalance,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Check exhausted accounts; return count reactivated. */
  async runOnce(): Promise<number> {
    let reactivated = 0;
    for (const account of this.pool.list()) {
      if (account.status !== "exhausted" || !account.enabled) continue;
      try {
        const balance = await this.fetchBalance(account.jwt);
        if (!accountHasQuota(balance)) continue;
        if (this.pool.markActive(account.id)) {
          reactivated += 1;
          const label = account.userId ?? account.id;
          const first = balance.balances.find((b) => (b.remaining_units ?? 0) > 0);
          console.log(
            `[pool] reactivated ${label}` +
              (first?.show_name ? ` (${first.show_name}: ${first.remaining_units} tokens)` : ""),
          );
        }
      } catch (err) {
        console.warn(`[pool] quota refresh failed for ${account.id}: ${(err as Error).message}`);
      }
    }
    return reactivated;
  }
}
