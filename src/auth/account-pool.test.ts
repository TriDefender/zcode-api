import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { AccountPool, getAccountsStorePath } from "./account-pool.js";
import type { Credential } from "./types.js";

const CRED: Credential = {
  apiKey: "k",
  provider: "zai",
  jwt: "eyJhbG.header.payload",
  userId: "user-a",
};

describe("AccountPool", () => {
  beforeEach(() => {
    const path = getAccountsStorePath();
    if (existsSync(path)) unlinkSync(path);
  });

  afterEach(() => {
    const path = getAccountsStorePath();
    if (existsSync(path)) unlinkSync(path);
  });

  it("adds and round-robins accounts", () => {
    const pool = new AccountPool();
    const id1 = pool.addFromCredential(CRED);
    const id2 = pool.addFromCredential(
      { ...CRED, jwt: "eyJ.other.jwt", userId: "user-b" },
    );

    expect(pool.activeCount()).toBe(2);
    const first = pool.acquire();
    const second = pool.acquire([first!.id]);
    expect(first?.id).toBe(id1);
    expect(second?.id).toBe(id2);
  });

  it("dedupes same jwt on re-add", () => {
    const pool = new AccountPool();
    const id1 = pool.addFromCredential(CRED);
    const id2 = pool.addFromCredential(CRED);
    expect(id1).toBe(id2);
    expect(pool.size()).toBe(1);
  });

  it("skips exhausted accounts", () => {
    const pool = new AccountPool();
    const id = pool.addFromCredential(CRED);
    pool.markExhausted(id, "1005");
    expect(pool.acquire()).toBeNull();
  });
});
