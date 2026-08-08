import { describe, it, expect } from "bun:test";
import { ResponseStore } from "./store.js";
import type { StoredResponse } from "./store.js";

function entry(id: string): StoredResponse {
  return {
    id,
    model: "glm-5.2",
    status: "completed",
    input: [],
    output: [],
    createdAt: 0,
    lastAccessedAt: 0,
  };
}

describe("ResponseStore", () => {
  it("round-trips set → get", () => {
    const s = new ResponseStore();
    s.set(entry("resp_1"));
    expect(s.get("resp_1")?.id).toBe("resp_1");
    expect(s.get("missing")).toBeUndefined();
  });

  it("evicts oldest on LRU overflow", () => {
    const s = new ResponseStore({ maxEntries: 2 });
    s.set(entry("a"));
    s.set(entry("b"));
    s.set(entry("c"));
    expect(s.get("a")).toBeUndefined();
    expect(s.get("b")?.id).toBe("b");
    expect(s.get("c")?.id).toBe("c");
  });

  it("refreshes LRU position on get", () => {
    const s = new ResponseStore({ maxEntries: 2 });
    s.set(entry("a"));
    s.set(entry("b"));
    s.get("a");
    s.set(entry("c"));
    expect(s.get("a")?.id).toBe("a");
    expect(s.get("b")).toBeUndefined();
  });

  it("expires entries past TTL", () => {
    const s = new ResponseStore({ ttlMs: 50 });
    s.set(entry("a"));
    expect(s.get("a")?.id).toBe("a");
    // Wait past TTL
    const start = Date.now();
    while (Date.now() - start < 60) {
      // busy-wait 60ms
    }
    expect(s.get("a")).toBeUndefined();
  });

  it("supports delete and clear", () => {
    const s = new ResponseStore();
    s.set(entry("a"));
    s.set(entry("b"));
    expect(s.delete("a")).toBe(true);
    expect(s.get("a")).toBeUndefined();
    expect(s.size()).toBe(1);
    s.clear();
    expect(s.size()).toBe(0);
  });
});
