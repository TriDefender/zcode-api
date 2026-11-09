import { describe, expect, it, afterEach } from "bun:test";
import {
  HighspeedManager,
  applyHighspeedCardHeaders,
  highspeedLlmUrl,
  isHighspeedCardRejection,
  rewriteBodyModel,
  type HighspeedAuth,
} from "./manager.js";
import type { UpstreamHeaderPair } from "../proxy/upstream.js";

const AUTH: HighspeedAuth = { jwt: "test-jwt", codingPlanAuth: "testkey.testsecret", family: "zai" };
const DRAW_URL = "https://zcode.z.ai/api/v1/highspeed/draw";
const SESSION_TASK = "11111111-2222-3333-4444-555555555555";

interface DrawCall { url: string; body: Record<string, unknown>; headers: Headers; }

function drawResponse(card: Record<string, unknown> | null, nextDrawAt?: number): Response {
  return new Response(JSON.stringify({ code: 0, msg: "success", data: { card, next_draw_at: nextDrawAt ?? 0 } }), { status: 200 });
}

function hitCard(now: number, model = "glm-5.3-highspeed"): Record<string, unknown> {
  return { card_id: "hsc_test_1", task_id: SESSION_TASK, provider: "builtin:zai-coding-plan", model, issued_at: now, expires_at: now + 300_000 };
}

/** Live managers registry — afterEach stops every heartbeat timer. */
const live: HighspeedManager[] = [];
afterEach(() => {
  for (const m of live.splice(0)) m.stop();
});

function makeManager(
  fetchImpl: typeof fetch,
  clock: { now: number },
  opts: { retryMs?: number; onEvent?: (message: string) => void } = {},
): HighspeedManager {
  const manager = new HighspeedManager({
    origin: "https://zcode.z.ai",
    models: ["glm-5.3", "glm-5.2", "glm-5.1"],
    fetchImpl,
    now: () => clock.now,
    retryMs: opts.retryMs ?? 2,
    onEvent: opts.onEvent,
  });
  live.push(manager);
  return manager;
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 5));
}

/** Poll until cond() holds or ~1s elapses (real-timer tests). */
async function until(cond: () => boolean): Promise<boolean> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return cond();
}

describe("HighspeedManager", () => {
  it("refreshes the idle window during held-card traffic before rejection", async () => {
    const clock = { now: 1_000_000 };
    let draws = 0;
    const manager = makeManager((async () => {
      draws++;
      return drawResponse({ ...hitCard(clock.now), expires_at: clock.now + 900_000 });
    }) as unknown as typeof fetch, clock);
    manager.onRequest("glm-5.2", SESSION_TASK, AUTH);
    expect(await until(() => manager.activeCard() !== null)).toBe(true);
    await settle();
    clock.now += 301_000;
    manager.onRequest("glm-5.2", SESSION_TASK, AUTH);
    expect(draws).toBe(1);
    manager.dropCard("upstream_rejected");
    expect(await until(() => draws === 2)).toBe(true);
  });
  it("draws on the first eligible request and holds the single card slot", async () => {
    const clock = { now: 1_000_000 };
    const calls: DrawCall[] = [];
    const manager = makeManager((async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown>, headers: new Headers(init?.headers) });
      return drawResponse(hitCard(clock.now));
    }) as unknown as typeof fetch, clock);

    manager.onRequest("glm-5.1", SESSION_TASK, AUTH);
    await settle();
    const card = manager.activeCard();
    expect(card?.cardId).toBe("hsc_test_1");
    expect(card?.model).toBe("glm-5.3-highspeed");

    // second eligible request while holding → no new draw
    manager.onRequest("glm-5.3", SESSION_TASK, AUTH);
    await settle();
    expect(calls.length).toBe(1);

    // draw request shape: auth trio + body fields (official contract)
    expect(calls[0]!.url).toBe(DRAW_URL);
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer test-jwt");
    expect(calls[0]!.headers.get("x-bigmodel-authorization")).toBe("Bearer testkey.testsecret");
    expect(calls[0]!.headers.get("bigmodel-target-type")).toBe("PERSONAL");
    expect(calls[0]!.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[0]!.body.task_id).toBe(SESSION_TASK);
    expect(calls[0]!.body.provider).toBe("builtin:zai-coding-plan");
    expect(calls[0]!.body.model).toBe("glm-5.1");
    // deviceMid omitted when not provided (makeManager passes none)
    expect(calls[0]!.headers.get("x-device-mid")).toBeNull();
  });

  it("sends X-Device-Mid on draws when provided (activity-gate 3001 fix, live 2026-10-12)", async () => {
    const clock = { now: 1_000_000 };
    const calls: DrawCall[] = [];
    const manager = new HighspeedManager({
      origin: "https://zcode.z.ai",
      models: ["glm-5.3"],
      deviceMid: "  e6e1ef31-b69a-496b-8428-ae909abc8904  ",
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown>, headers: new Headers(init?.headers) });
        return drawResponse(hitCard(clock.now));
      }) as unknown as typeof fetch,
      now: () => clock.now,
    });
    manager.onRequest("glm-5.3", SESSION_TASK, AUTH);
    await settle();
    expect(calls.length).toBe(1);
    expect(calls[0]!.headers.get("x-device-mid")).toBe("e6e1ef31-b69a-496b-8428-ae909abc8904");
  });

  it("draws synchronously on ignite: the first fetch starts before any await", () => {
    const clock = { now: 1_000_000 };
    let fetches = 0;
    const manager = makeManager((async () => {
      fetches++;
      return drawResponse(null);
    }) as unknown as typeof fetch, clock);

    manager.onRequest("glm-5.3", SESSION_TASK, AUTH);
    expect(fetches).toBe(1); // fired within onRequest, not on a timer
  });

  it("retries at the heartbeat cadence after a miss — server next_draw_at is ignored", async () => {
    const clock = { now: 1_000_000 };
    let fetches = 0;
    const manager = makeManager((async () => {
      fetches++;
      return drawResponse(null, clock.now + 120_000);
    }) as unknown as typeof fetch, clock);

    manager.onRequest("glm-5.3", SESSION_TASK, AUTH);
    expect(await until(() => fetches >= 3)).toBeTrue(); // ≥3 tries without new requests
  });

  it("stops the loop 5 minutes after the last eligible request (idle self-extinguish)", async () => {
    const clock = { now: 1_000_000 };
    let fetches = 0;
    const events: string[] = [];
    const manager = makeManager((async () => {
      fetches++;
      return drawResponse(null);
    }) as unknown as typeof fetch, clock, { onEvent: (m) => events.push(m) });

    manager.onRequest("glm-5.3", SESSION_TASK, AUTH);
    expect(await until(() => fetches >= 2)).toBeTrue();
    clock.now += 5 * 60_000 + 1; // idle window closed
    expect(await until(() => events.some((m) => m.includes("idle-stopped")))).toBeTrue();
    const fetchesAtStop = fetches;
    clock.now += 60_000;
    await settle();
    expect(fetches).toBe(fetchesAtStop); // loop is dead — no more draws
  });

  it("noteActivity (in-flight stream still producing) extends the idle window — no self-extinguish mid-stream", async () => {
    const clock = { now: 1_000_000 };
    let fetches = 0;
    const events: string[] = [];
    const manager = makeManager((async () => {
      fetches++;
      return drawResponse(null);
    }) as unknown as typeof fetch, clock, { onEvent: (m) => events.push(m) });

    manager.onRequest("glm-5.3", SESSION_TASK, AUTH);
    expect(await until(() => fetches >= 2)).toBeTrue();
    // 4 minutes into a long stream the SSE is still producing — that is
    // activity, not idle (§H): the stream-end touch re-arms the 5min window.
    clock.now += 4 * 60_000;
    manager.noteActivity();
    clock.now += 4 * 60_000 + 1; // 8min after the request, 4min+1ms after the touch
    await settle();
    expect(events.some((m) => m.includes("idle-stopped"))).toBeFalse(); // re-armed — loop alive
    expect(fetches).toBeGreaterThanOrEqual(2); // still drawing
    // Only a real gap past the TOUCHED window stops it.
    clock.now += 60_000 + 2; // >5min since the touch
    expect(await until(() => events.some((m) => m.includes("idle-stopped")))).toBeTrue();
    const fetchesAtStop = fetches;
    clock.now += 60_000;
    await settle();
    expect(fetches).toBe(fetchesAtStop); // loop dead — noteActivity never re-ignites
    manager.noteActivity(); // inert on a stopped loop: extends loopUntil but draws nothing
    clock.now += 60_000;
    await settle();
    expect(fetches).toBe(fetchesAtStop);
  });

  it("re-ignites after idle-stop when a new request arrives", async () => {
    const clock = { now: 1_000_000 };
    const manager = makeManager((async () => drawResponse(hitCard(clock.now))) as unknown as typeof fetch, clock);

    manager.onRequest("glm-5.3", SESSION_TASK, AUTH);
    await settle();
    expect(manager.activeCard()?.cardId).toBe("hsc_test_1");

    // card expires, loop had stopped; 10 idle minutes pass
    clock.now += 295_000;
    expect(manager.activeCard()).toBeNull();
    clock.now += 10 * 60_000;
    manager.onRequest("glm-5.3", SESSION_TASK, AUTH);
    await settle();
    expect(manager.activeCard()?.cardId).toBe("hsc_test_1"); // re-ignited and drew again
  });

  it("keeps redrawing after the card expires mid-idle-window", async () => {
    const clock = { now: 1_000_000 };
    let draws = 0;
    const manager = makeManager((async () => {
      draws++;
      return draws <= 4
        ? drawResponse(null)
        : drawResponse(hitCard(clock.now));
    }) as unknown as typeof fetch, clock);

    manager.onRequest("glm-5.3", SESSION_TASK, AUTH);
    expect(await until(() => manager.activeCard()?.cardId === "hsc_test_1")).toBeTrue(); // hit on the 5th draw
    const drawsAtFirstHit = draws;

    clock.now += 295_000; // 5s left — under the minimum-remaining guard
    expect(manager.activeCard()).toBeNull();
    manager.onRequest("glm-5.3", SESSION_TASK, AUTH); // re-ignite inside idle window (sub-min card must not block)
    expect(await until(() => draws > drawsAtFirstHit && manager.activeCard()?.cardId === "hsc_test_1")).toBeTrue();
    expect(draws).toBeGreaterThan(drawsAtFirstHit); // fresh draws actually fired past the first hit
  });

  it("blocks only the rejected model on draw 400 and keeps the account drawable (2026-10-14 flash finding)", async () => {
    const clock = { now: 1_000_000 };
    let calls = 0;
    const manager = makeManager((async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      const body = JSON.parse(String(init?.body)) as { model: string };
      return body.model === "glm-5.3-flash"
        ? new Response(JSON.stringify({ code: 3001, msg: "parameter error", logid: "x" }), { status: 400 })
        : drawResponse(hitCard(clock.now));
    }) as unknown as typeof fetch, clock);

    manager.onRequest("glm-5.3-flash", SESSION_TASK, AUTH);
    await settle();
    expect(calls).toBe(1); // one probe draw sufficed to learn the rejection

    manager.onRequest("glm-5.3-flash", SESSION_TASK, AUTH); // blocked — no refetch
    await settle();
    expect(calls).toBe(1);

    // the account itself is fine: another model draws and hits normally
    manager.onRequest("glm-5.3", SESSION_TASK, AUTH);
    expect(await until(() => manager.activeCard()?.cardId === "hsc_test_1")).toBeTrue();
    expect(calls).toBe(2);
  });

  it("never mounts a non-flash card on a flash request (tier guard)", async () => {
    const clock = { now: 1_000_000 };
    const manager = makeManager((async () => drawResponse(hitCard(clock.now, "glm-5.3"))) as unknown as typeof fetch, clock);

    manager.onRequest("glm-5.1", SESSION_TASK, AUTH);
    expect(await until(() => manager.activeCard()?.cardId === "hsc_test_1")).toBeTrue();

    // same tier (non-flash family) → mounts; flash → never (model-rewrite hazard)
    expect(manager.activeCardFor("glm-5.2")?.cardId).toBe("hsc_test_1");
    expect(manager.activeCardFor("glm-5.3-flash")).toBeNull();
    expect(manager.activeCardFor("glm-5.1")).not.toBeNull();
  });

  it("backs off 5s on HTTP 429, then resumes the heartbeat (2026-10-14 calibrated)", async () => {
    const clock = { now: 1_000_000 };
    let fetches = 0;
    const manager = makeManager((async () => {
      fetches++;
      return new Response("", { status: 429 });
    }) as unknown as typeof fetch, clock);

    manager.onRequest("glm-5.1", SESSION_TASK, AUTH);
    await settle();
    const atTwo = fetches;
    clock.now += 2_000; // inside the 5s backoff
    await settle();
    expect(fetches).toBe(atTwo); // no retries while backing off

    clock.now += 4_000; // past backoff
    expect(await until(() => fetches > atTwo)).toBeTrue();
  });

  it("negative-caches account unavailability (503 / biz 3404) for 10 minutes", async () => {
    const clock = { now: 1_000_000 };
    let fetches = 0;
    const manager = makeManager((async () => {
      fetches++;
      return new Response(JSON.stringify({ code: 3404, msg: "highspeed is temporarily unavailable" }), { status: 503 });
    }) as unknown as typeof fetch, clock);

    manager.onRequest("glm-5.2", SESSION_TASK, AUTH);
    await settle();
    const atTwo = fetches;
    // Stay inside the idle window across both clock jumps so the gate under
    // test is the negative cache, not the idle self-extinguish.
    clock.now += 120_000;
    manager.onRequest("glm-5.2", SESSION_TASK, AUTH);
    await settle();
    expect(fetches).toBe(atTwo); // still negative-cached

    clock.now += 8 * 60_000 + 1_000; // past 10min negative cache
    manager.onRequest("glm-5.2", SESSION_TASK, AUTH);
    expect(await until(() => fetches > atTwo)).toBeTrue();
  });

  it("draws with the latest request's model after a mid-loop model change", async () => {
    const clock = { now: 1_000_000 };
    const bodies: Record<string, unknown>[] = [];
    const manager = makeManager((async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return drawResponse(null);
    }) as unknown as typeof fetch, clock);

    manager.onRequest("glm-5.3", SESSION_TASK, AUTH);
    manager.onRequest("glm-5.2", SESSION_TASK, AUTH); // newer params win
    await until(() => bodies.length >= 3);
    expect(bodies.slice(1).every((b) => b.model === "glm-5.2")).toBeTrue();
    expect(bodies[0]!.model).toBe("glm-5.3");
  });

  it("deduplicates concurrent draws into a single fetch", async () => {
    const clock = { now: 1_000_000 };
    let fetches = 0;
    const manager = makeManager((async () => {
      fetches++;
      await new Promise((r) => setTimeout(r, 10));
      return drawResponse(hitCard(clock.now));
    }) as unknown as typeof fetch, clock);

    manager.onRequest("glm-5.3", SESSION_TASK, AUTH);
    manager.onRequest("glm-5.3", "another-task", AUTH);
    manager.onRequest("glm-5.3", "third-task", AUTH);
    await settle();
    await settle();
    expect(fetches).toBe(1);
  });

  it("drops the card on upstream rejection and redraws immediately", async () => {
    const clock = { now: 1_000_000 };
    let fetches = 0;
    const manager = makeManager((async () => {
      fetches++;
      return drawResponse(hitCard(clock.now));
    }) as unknown as typeof fetch, clock);

    manager.onRequest("glm-5.3", SESSION_TASK, AUTH);
    await settle();
    expect(manager.activeCard()).toBeDefined();

    manager.dropCard("upstream_rejected");
    await settle();
    expect(await until(() => manager.activeCard()?.cardId === "hsc_test_1")).toBeTrue();
    expect(fetches).toBeGreaterThanOrEqual(2);
  });

  it("redraws with the current account's auth after a cross-account card rejection", async () => {
    const clock = { now: 1_000_000 };
    const calls: DrawCall[] = [];
    const authA: HighspeedAuth = { jwt: "jwt-account-a", codingPlanAuth: "keyA.secret", family: "zai" };
    const authB: HighspeedAuth = { jwt: "jwt-account-b", codingPlanAuth: "keyB.secret", family: "bigmodel" };
    const manager = makeManager((async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown>, headers: new Headers(init?.headers) });
      return drawResponse(hitCard(clock.now));
    }) as unknown as typeof fetch, clock);

    // account A ignites the loop and holds the card
    manager.onRequest("glm-5.3", SESSION_TASK, authA);
    await settle();
    expect(manager.activeCard()?.cardId).toBe("hsc_test_1");

    // credential switch (proxy restart keeps the manager alive): B's requests
    // early-return while the card is held — `latest` must still move to B
    manager.onRequest("glm-5.3", SESSION_TASK, authB);
    await settle();
    expect(calls.length).toBe(1); // held card suppresses drawing

    // upstream rejects B's use of A's card → selectionFallback redraw
    manager.dropCard("upstream_rejected");
    expect(await until(() => calls.length >= 2)).toBeTrue();
    expect(calls[1]!.headers.get("authorization")).toBe("Bearer jwt-account-b");
    expect(calls[1]!.headers.get("x-bigmodel-authorization")).toBe("Bearer keyB.secret");
    expect(calls[1]!.body.provider).toBe("builtin:bigmodel-coding-plan");
  });

  it("skips drawing without a JWT and matches only configured model prefixes", () => {
    let fetches = 0;
    const manager = makeManager((async () => {
      fetches++;
      return drawResponse(null);
    }) as unknown as typeof fetch, { now: 1_000_000 });

    manager.onRequest("glm-5.3", SESSION_TASK, { ...AUTH, jwt: "  " });
    expect(fetches).toBe(0);

    expect(manager.isEligibleModel("glm-5.3")).toBeTrue();
    expect(manager.isEligibleModel("GLM-5.3-Flash")).toBeTrue();
    expect(manager.isEligibleModel("glm-4.6")).toBeFalse();
    expect(manager.isEligibleModel(undefined)).toBeFalse();
    manager.onRequest("glm-4.6", SESSION_TASK, AUTH);
    expect(fetches).toBe(0);
  });

  it("surfaces idle-stop exactly once via onEvent", async () => {
    const clock = { now: 1_000_000 };
    let fetches = 0;
    const events: string[] = [];
    const manager = makeManager((async () => {
      fetches++;
      return drawResponse(null);
    }) as unknown as typeof fetch, clock, { onEvent: (m) => events.push(m) });

    manager.onRequest("glm-5.3", SESSION_TASK, AUTH);
    await until(() => fetches >= 1);
    clock.now += 5 * 60_000 + 1;
    expect(await until(() => events.filter((m) => m.includes("idle-stopped")).length === 1)).toBeTrue();
    clock.now += 60_000;
    await settle();
    expect(events.filter((m) => m.includes("idle-stopped")).length).toBe(1); // no repeat
  });
});

describe("highspeed helpers", () => {
  it("rewriteBodyModel swaps the model field and tolerates non-JSON", () => {
    expect(rewriteBodyModel('{"model":"glm-5.1","messages":[]}', "glm-5.3-highspeed"))
      .toBe('{"model":"glm-5.3-highspeed","messages":[]}');
    expect(rewriteBodyModel("not json", "glm-5.3-highspeed")).toBe("not json");
    expect(rewriteBodyModel('{"messages":[]}', "x")).toBe('{"messages":[]}');
  });

  it("highspeedLlmUrl pins the dedicated inference endpoint (zcode-builtin providerRules rev 31+)", () => {
    expect(highspeedLlmUrl("https://zcode.z.ai")).toBe("https://zcode.z.ai/api/v1/highspeed/anthropic/v1/messages");
    expect(highspeedLlmUrl("https://zcode.z.ai/")).toBe("https://zcode.z.ai/api/v1/highspeed/anthropic/v1/messages");
  });

  it("manager.llmUrl derives from the draw-plane origin", () => {
    const manager = new HighspeedManager({
      origin: "https://hs.example.test",
      models: ["glm-5.3"],
      fetchImpl: (async () => new Response("{}")) as unknown as typeof fetch,
    });
    live.push(manager);
    expect(manager.llmUrl).toBe("https://hs.example.test/api/v1/highspeed/anthropic/v1/messages");
  });

  it("applyHighspeedCardHeaders swaps the coding-plan dual auth and appends the card set", () => {
    const pairs: UpstreamHeaderPair[] = [
      ["content-type", "application/json"],
      ["x-api-key", "testkey.testsecret"],
      ["authorization", "Bearer testkey.testsecret"],
    ];
    const out = applyHighspeedCardHeaders(pairs, {
      cardId: "hsc_1", taskId: "t", model: "glm-5.3-highspeed", issuedAt: 0, expiresAt: 1,
    }, AUTH);
    expect(out.find(([k]) => k.toLowerCase() === "x-api-key")?.[1]).toBe("test-jwt");
    expect(out.find(([k]) => k.toLowerCase() === "authorization")?.[1]).toBe("Bearer test-jwt");
    expect(out.find(([k]) => k === "X-Bigmodel-Authorization")?.[1]).toBe("Bearer testkey.testsecret");
    expect(out.find(([k]) => k === "Bigmodel-Target-Type")?.[1]).toBe("PERSONAL");
    expect(out.find(([k]) => k === "X-Highspeed-Card-ID")?.[1]).toBe("hsc_1");
    expect(out.length).toBe(pairs.length + 3);
  });

  it("isHighspeedCardRejection matches 401 and biz-3402 envelopes only", async () => {
    expect(await isHighspeedCardRejection(new Response("nope", { status: 401 }))).toBeTrue();
    expect(await isHighspeedCardRejection(new Response(JSON.stringify({ code: 3402, msg: "highspeed_card_expired" }), { status: 400 }))).toBeTrue();
    expect(await isHighspeedCardRejection(new Response(JSON.stringify({ code: 3007 }), { status: 400 }))).toBeFalse();
    expect(await isHighspeedCardRejection(new Response("data: hi\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }))).toBeFalse();
    expect(await isHighspeedCardRejection(new Response("plain", { status: 400 }))).toBeFalse();
  });
});
