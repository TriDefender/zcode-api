/**
 * getCaptchaToken acquisition semantics (NOTEPAD "3.16.3 增补" §H 九轮):
 * pool-first degradation through configs-fetch outages (banked tokens are
 * never stranded by a flaky configs endpoint), fresh authoritative disable
 * beats the pool, and a strict throw only when no config history exists.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

const solveMock = mock(async () => "t".repeat(64));

mock.module("./captcha-solver.js", () => ({
  runCaptchaSolve: solveMock,
  shutdownCaptchaSolver: () => {},
  setCaptchaSolverConcurrency: () => {},
  captchaSolverConcurrency: () => 2,
  CAPTCHA_NODE_DIR: "/tmp",
}));

const captcha = await import("./captcha.js");

const ENABLED_BODY = JSON.stringify({
  data: { configs: { captcha: { enabled: true, prefix: "no8xfe", sceneId: "11xygtvd", region: "sgp" } } },
});
const DISABLED_BODY = JSON.stringify({
  data: { configs: { captcha: { enabled: false, prefix: "no8xfe", sceneId: "11xygtvd", region: "sgp" } } },
});
const jsonResp = (body: string) =>
  new Response(body, { status: 200, headers: { "content-type": "application/json" } });

describe("getCaptchaToken — pool-first degradation (§H 九轮)", () => {
  beforeEach(() => {
    solveMock.mockClear();
    captcha.__resetCaptchaConfigCacheForTests();
  });
  afterEach(() => {
    captcha.__setConfigsFetchForTests(null);
    try { captcha.shutdownCaptcha(); } catch {}
  });

  it("serves tokens through a configs-fetch outage instead of stranding the pool", async () => {
    // Live regression (2026-10-23 #002): configs endpoint flaked for ~45s and
    // 16 acquisition retries burned the whole budget while the pool had stock.
    let outage = false;
    captcha.__setConfigsFetchForTests((async () => {
      if (outage) throw new Error("network blip");
      return jsonResp(ENABLED_BODY);
    }) as unknown as typeof fetch);

    const first = await captcha.getCaptchaToken("test-1.0.0");
    expect(first?.region).toBe("sgp");
    expect(first?.verifyParam.length).toBeGreaterThan(0);

    // The 1h config snapshot expires mid-outage — the refresh now fails.
    outage = true;
    captcha.__resetCaptchaConfigCacheForTests(true); // keep lastGood
    const second = await captcha.getCaptchaToken("test-1.0.0");
    expect(second).not.toBeNull(); // pool-first: banked token still served
    expect(second?.region).toBe("sgp"); // region from the last-good config
  });

  it("an active block missing region fails open (3.18.0 `qV` mirror — solver init rides server fields)", async () => {
    // 3.18.0 renderer qV: !region||!prefix||!sceneId → no captcha (NOTEPAD
    // 「3.18.0 增补」§C 复核修正). A partial block must not mint.
    captcha.__setConfigsFetchForTests((async () =>
      jsonResp(JSON.stringify({
        data: { configs: { captcha: { enabled: true, prefix: "no8xfe", sceneId: "11xygtvd" } } },
      }))
    ) as unknown as typeof fetch);
    expect(await captcha.getCaptchaToken("test-1.0.0")).toBeNull();

    // Empty string counts as missing too.
    captcha.__resetCaptchaConfigCacheForTests();
    captcha.__setConfigsFetchForTests((async () =>
      jsonResp(JSON.stringify({
        data: { configs: { captcha: { enabled: true, prefix: "no8xfe", sceneId: "11xygtvd", region: "" } } },
      }))
    ) as unknown as typeof fetch);
    expect(await captcha.getCaptchaToken("test-1.0.0")).toBeNull();
    expect(solveMock).not.toHaveBeenCalled();
  });

  it("an authoritative disable beats banked tokens and survives the next refresh outage", async () => {
    let disabled = false;
    let outage = false;
    captcha.__setConfigsFetchForTests(
      (async () => {
        if (outage) throw new Error("network blip");
        return jsonResp(disabled ? DISABLED_BODY : ENABLED_BODY);
      }) as unknown as typeof fetch,
    );

    expect(await captcha.getCaptchaToken("test-1.0.0")).not.toBeNull();
    disabled = true;
    captcha.__resetCaptchaConfigCacheForTests(true); // see the fresh config now
    expect(await captcha.getCaptchaToken("test-1.0.0")).toBeNull(); // no headers is the correct shape
    outage = true;
    captcha.__resetCaptchaConfigCacheForTests(true);
    expect(await captcha.getCaptchaToken("test-1.0.0")).toBeNull(); // never resurrect the old enabled config
  });

  it("no config history + outage → strict throw (never dispatch captcha-less)", async () => {
    captcha.__setConfigsFetchForTests(
      (async () => {
        throw new Error("network blip");
      }) as unknown as typeof fetch,
    );
    await expect(captcha.getCaptchaToken("test-1.0.0")).rejects.toThrow("Captcha config unavailable");
  });
});

describe("fetchCaptchaConfig cadence — real-client mirror (§H 十轮)", () => {
  beforeEach(() => {
    solveMock.mockClear();
    captcha.__resetCaptchaConfigCacheForTests();
  });
  afterEach(() => {
    captcha.__setConfigsFetchForTests(null);
    try { captcha.shutdownCaptcha(); } catch {}
  });

  it("1h snapshot: repeated acquisitions share ONE configs fetch", async () => {
    let fetches = 0;
    captcha.__setConfigsFetchForTests((async () => {
      fetches++;
      return jsonResp(ENABLED_BODY);
    }) as unknown as typeof fetch);

    await captcha.getCaptchaToken("test-1.0.0");
    await captcha.getCaptchaToken("test-1.0.0");
    await captcha.getCaptchaToken("test-1.0.0");
    expect(fetches).toBe(1); // snapshot served from cache (mirror RRe=1h)
  });

  it("NO negative cache: a failed refresh retries the fetch on the very next call", async () => {
    let fail = true;
    let fetches = 0;
    captcha.__setConfigsFetchForTests((async () => {
      fetches++;
      if (fail) throw new Error("network blip");
      return jsonResp(ENABLED_BODY);
    }) as unknown as typeof fetch);

    // Old behavior neg-cached the failure for 15s; the mirror (host
    // getClientConfigs) leaves no failure marker — the next call refetches.
    await expect(captcha.getCaptchaToken("test-1.0.0")).rejects.toThrow("Captcha config unavailable");
    expect(fetches).toBe(1);
    fail = false;
    const token = await captcha.getCaptchaToken("test-1.0.0");
    expect(token).not.toBeNull();
    expect(fetches).toBe(2);
  });

  it("HTTP errors cancel their bodies and never poison the 1h snapshot", async () => {
    for (const status of [429, 503]) {
      captcha.__resetCaptchaConfigCacheForTests();
      let fetches = 0;
      let cancelled = false;
      captcha.__setConfigsFetchForTests((async () => {
        fetches++;
        if (fetches > 1) return jsonResp(DISABLED_BODY);
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ code: status, message: "temporary failure" })));
          },
          cancel() { cancelled = true; },
        }), { status, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch);

      await expect(captcha.getCaptchaToken("test-1.0.0")).rejects.toThrow("Captcha config unavailable");
      expect(cancelled).toBe(true);
      expect(await captcha.getCaptchaToken("test-1.0.0")).toBeNull();
      expect(fetches).toBe(2);
    }
  });

  it("a stalled JSON body times out, cancels its reader, and releases shared acquisitions", async () => {
    const savedTimeout = process.env.CAPTCHA_CONFIG_TIMEOUT_MS;
    process.env.CAPTCHA_CONFIG_TIMEOUT_MS = "20";
    let fetches = 0;
    let cancelled = false;
    let fetchSignal: AbortSignal | null | undefined;
    let stalledBody: ReadableStream<Uint8Array> | undefined;
    try {
      captcha.__setConfigsFetchForTests((async (_url: RequestInfo | URL, init?: RequestInit) => {
        fetches++;
        if (fetches > 1) return jsonResp(DISABLED_BODY);
        fetchSignal = init?.signal;
        stalledBody = new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(new TextEncoder().encode('{"data":')); },
          cancel() { cancelled = true; },
        });
        return new Response(stalledBody, { headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch);

      const results = await Promise.allSettled([
        captcha.getCaptchaToken("test-1.0.0"),
        captcha.getCaptchaToken("test-1.0.0"),
      ]);
      expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
      expect(fetches).toBe(1);
      expect(fetchSignal?.aborted).toBe(true);
      expect(cancelled).toBe(true);
      expect(stalledBody?.locked).toBe(false);
      expect(await captcha.getCaptchaToken("test-1.0.0")).toBeNull();
      expect(fetches).toBe(2);
    } finally {
      if (savedTimeout === undefined) delete process.env.CAPTCHA_CONFIG_TIMEOUT_MS;
      else process.env.CAPTCHA_CONFIG_TIMEOUT_MS = savedTimeout;
    }
  });

  it("in-flight dedup: concurrent acquisitions share one configs fetch", async () => {
    let fetches = 0;
    captcha.__setConfigsFetchForTests((async () => {
      fetches++;
      await new Promise((r) => setTimeout(r, 40));
      return jsonResp(ENABLED_BODY);
    }) as unknown as typeof fetch);

    const [a, b] = await Promise.all([
      captcha.getCaptchaToken("test-1.0.0"),
      captcha.getCaptchaToken("test-1.0.0"),
    ]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(fetches).toBe(1); // mirror clientConfigRequest dedup
  });
});
