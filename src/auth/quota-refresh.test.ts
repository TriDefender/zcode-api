import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { AccountPool, getAccountsStorePath } from "./account-pool.js";
import { QuotaRefreshScheduler, accountHasQuota } from "./quota-refresh.js";
import type { BalanceResponse } from "./billing.js";

const CRED = {
  apiKey: "k",
  provider: "zai" as const,
  jwt: "eyJhbG.header.payload",
  userId: "user-a",
};

describe("accountHasQuota", () => {
  it("returns true when any bucket has remaining tokens", () => {
    expect(
      accountHasQuota({
        ok: true,
        status: 200,
        balances: [{ remaining_units: 100, total_units: 1000 }],
      }),
    ).toBe(true);
  });

  it("returns false when all buckets empty", () => {
    expect(
      accountHasQuota({
        ok: true,
        status: 200,
        balances: [{ remaining_units: 0, total_units: 1000 }],
      }),
    ).toBe(false);
  });
});

describe("QuotaRefreshScheduler", () => {
  beforeEach(() => {
    const path = getAccountsStorePath();
    if (existsSync(path)) unlinkSync(path);
  });

  afterEach(() => {
    const path = getAccountsStorePath();
    if (existsSync(path)) unlinkSync(path);
  });

  it("reactivates exhausted account when billing shows quota", async () => {
    const pool = new AccountPool();
    const id = pool.addFromCredential(CRED);
    pool.markExhausted(id, "1005");
    expect(pool.activeCount()).toBe(0);

    const scheduler = new QuotaRefreshScheduler(pool, 60_000, async () => ({
      ok: true,
      status: 200,
      balances: [{ show_name: "GLM-5.2", remaining_units: 500_000, total_units: 3_000_000 }],
    }));

    const n = await scheduler.runOnce();
    expect(n).toBe(1);
    expect(pool.activeCount()).toBe(1);
    expect(pool.get(id)?.status).toBe("active");
    expect(pool.get(id)?.lastError).toBeNull();
  });

  it("leaves exhausted when billing still empty", async () => {
    const pool = new AccountPool();
    const id = pool.addFromCredential(CRED);
    pool.markExhausted(id, "1005");

    const scheduler = new QuotaRefreshScheduler(pool, 60_000, async () => ({
      ok: true,
      status: 200,
      balances: [{ remaining_units: 0, total_units: 3_000_000 }],
    }));

    expect(await scheduler.runOnce()).toBe(0);
    expect(pool.get(id)?.status).toBe("exhausted");
  });

  it("does not reactivate blocked accounts", async () => {
    const pool = new AccountPool();
    const id = pool.addFromCredential(CRED);
    pool.markBlocked(id, "3012");

    const scheduler = new QuotaRefreshScheduler(pool, 60_000, async () => ({
      ok: true,
      status: 200,
      balances: [{ remaining_units: 1_000_000 }],
    }));

    expect(await scheduler.runOnce()).toBe(0);
    expect(pool.get(id)?.status).toBe("blocked");
  });
});
