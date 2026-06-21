/**
 * Staggered Z.AI billing cache for the dashboard — one account per tick to avoid rate limits.
 */
import type { AccountPool } from "./account-pool.js";
import { fetchBillingBalance, type BalanceBucket, type BalanceResponse } from "./billing.js";
import { accountHasQuota } from "./quota-refresh.js";

export interface QuotaCacheAccount {
  id: string;
  userId?: string;
  status: string;
  enabled: boolean;
  usageCount: number;
  lastUsedAt: number | null;
  ok: boolean;
  serverTime?: number;
  balances: Array<{
    show_name: string;
    total_units: number;
    used_units: number;
    remaining_units: number;
    period_end: number;
    period_start: number;
  }>;
  fetchedAt: number | null;
}

export interface QuotaCacheSnapshot {
  accounts: QuotaCacheAccount[];
  cache: {
    refreshing: boolean;
    cycleIntervalSec: number;
    fetchDelaySec: number;
    /** Epoch milliseconds when the next refresh cycle starts. */
    nextRefreshAt: number | null;
    lastCompletedAt: number | null;
  };
}

function mapBalances(balances: BalanceBucket[]) {
  return balances.map((b) => ({
    show_name: b.show_name,
    total_units: b.total_units,
    used_units: b.used_units,
    remaining_units: b.remaining_units,
    period_end: b.period_end,
    period_start: b.period_start,
  }));
}

function entryFromAccount(
  account: ReturnType<AccountPool["list"]>[number],
  balance: BalanceResponse | null,
): QuotaCacheAccount {
  return {
    id: account.id,
    userId: account.userId,
    status: account.status,
    enabled: account.enabled,
    usageCount: account.usageCount,
    lastUsedAt: account.lastUsedAt,
    ok: balance?.ok ?? false,
    serverTime: balance?.serverTime,
    balances: balance ? mapBalances(balance.balances) : [],
    fetchedAt: balance ? Date.now() : null,
  };
}

export class QuotaCache {
  private entries = new Map<string, QuotaCacheAccount>();
  private cycleTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshing = false;
  private nextRefreshAt: number | null = null;
  private lastCompletedAt: number | null = null;

  constructor(
    private pool: AccountPool,
    private cycleIntervalSec: number,
    private fetchDelaySec: number,
    private fetchBalance: (jwt: string) => Promise<BalanceResponse> = fetchBillingBalance,
  ) {}

  start(): void {
    if (this.cycleTimer) return;
    void this.scheduleNextCycle(0);
  }

  stop(): void {
    if (this.cycleTimer) {
      clearTimeout(this.cycleTimer);
      this.cycleTimer = null;
    }
  }

  getSnapshot(): QuotaCacheSnapshot {
    const accounts = this.pool.list().map((account) => {
      const cached = this.entries.get(account.id);
      if (cached) {
        return {
          ...cached,
          status: account.status,
          enabled: account.enabled,
          usageCount: account.usageCount,
          lastUsedAt: account.lastUsedAt,
          userId: account.userId ?? cached.userId,
        };
      }
      return entryFromAccount(account, null);
    });

    return {
      accounts,
      cache: {
        refreshing: this.refreshing,
        cycleIntervalSec: this.cycleIntervalSec,
        fetchDelaySec: this.fetchDelaySec,
        nextRefreshAt: this.nextRefreshAt,
        lastCompletedAt: this.lastCompletedAt,
      },
    };
  }

  private scheduleNextCycle(delayMs: number): void {
    if (this.cycleTimer) clearTimeout(this.cycleTimer);
    this.cycleTimer = setTimeout(() => void this.runCycle(), delayMs);
  }

  private async runCycle(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    this.nextRefreshAt = null;

    const accounts = this.pool.list();
    const delayMs = this.fetchDelaySec * 1000;

    try {
      for (let i = 0; i < accounts.length; i++) {
        const account = accounts[i]!;
        try {
          const balance = await this.fetchBalance(account.jwt);
          this.entries.set(account.id, entryFromAccount(account, balance));

          if (account.status === "exhausted" && account.enabled && accountHasQuota(balance)) {
            if (this.pool.markActive(account.id)) {
              const label = account.userId ?? account.id;
              const first = balance.balances.find((b) => (b.remaining_units ?? 0) > 0);
              console.log(
                `[pool] reactivated ${label}` +
                  (first?.show_name ? ` (${first.show_name}: ${first.remaining_units} tokens)` : ""),
              );
            }
          }
        } catch (err) {
          console.warn(`[quota-cache] billing failed for ${account.id}: ${(err as Error).message}`);
          this.entries.set(account.id, entryFromAccount(account, null));
        }

        if (i < accounts.length - 1 && delayMs > 0) {
          await sleep(delayMs);
        }
      }
      this.lastCompletedAt = Date.now();
    } finally {
      this.refreshing = false;
      this.nextRefreshAt = Date.now() + this.cycleIntervalSec * 1000;
      this.scheduleNextCycle(this.cycleIntervalSec * 1000);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
