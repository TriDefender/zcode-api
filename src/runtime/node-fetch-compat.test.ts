import { describe, it, expect } from "bun:test";
import { ensureNodeFetchNoTimeouts } from "./node-fetch-compat.js";

describe("ensureNodeFetchNoTimeouts", () => {
  it("is a safe no-op under Bun (never imports undici)", async () => {
    await expect(ensureNodeFetchNoTimeouts()).resolves.toBeUndefined();
    // idempotent — second call must not throw either
    await expect(ensureNodeFetchNoTimeouts()).resolves.toBeUndefined();
  });
});
