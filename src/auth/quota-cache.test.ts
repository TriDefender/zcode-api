import { describe, it, expect, mock } from "bun:test";
import { AccountPool } from "./account-pool.js";
import { QuotaCache } from "./quota-cache.js";

describe("QuotaCache", () => {
  it("returns cached snapshot without live billing calls", async () => {
    const pool = new AccountPool();
    pool.addFromCredential({
      apiKey: "start-plan",
      provider: "zai",
      jwt: "jwt-a",
      userId: "user-a",
    });

    const fetchBalance = mock(async () => ({
      ok: true,
      serverTime: 1000,
      balances: [{ show_name: "GLM", total_units: 100, used_units: 0, remaining_units: 100, period_end: 2000, period_start: 0 }],
    }));

    const cache = new QuotaCache(pool, 300, 0, fetchBalance);
    await (cache as unknown as { runCycle(): Promise<void> }).runCycle();

    const snap = cache.getSnapshot();
    expect(snap.accounts).toHaveLength(1);
    expect(snap.accounts[0]?.balances).toHaveLength(1);
    expect(snap.cache.cycleIntervalSec).toBe(300);
    expect(fetchBalance).toHaveBeenCalledTimes(1);
  });
});
