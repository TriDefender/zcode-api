import { describe, expect, test } from "bun:test";
import {
  installGlobalWindowAlias,
  makeDualConsole,
  makeDualTimers,
  removeGlobalWindowAlias,
} from "./captcha-happy.js";

describe("dual console (guest spam guard)", () => {
  test("drops every console method's call while the guest predicate holds", () => {
    const seen: string[] = [];
    const recorder: Record<string, unknown> = {};
    for (const m of ["log", "debug", "info", "dir", "table", "group", "warn", "error"]) {
      recorder[m] = (...a: unknown[]) => { seen.push(m + ": " + a.join(" ")); };
    }
    const orig = console as unknown as Record<string, unknown>;
    const saved = Object.fromEntries(
      Object.keys(recorder).map((k) => [k, orig[k]]),
    );
    Object.assign(orig, recorder);

    try {
      // Build the dual console against the recorder and route calls through
      // it with the guest predicate forced on — the FeiLin spam condition.
      const dual = makeDualConsole(() => true) as Record<string, (...a: unknown[]) => void>;
      dual.log!("%c%d", "font-size:0;color:transparent", "Error");
      dual.debug!("anything");
      dual.dir!({ an: "object" });
      dual.table!([1, 2]);
      expect(seen).toEqual([]);

      // Host condition — identical calls must forward untouched.
      const forward = makeDualConsole(() => false) as Record<string, (...a: unknown[]) => void>;
      forward.log!("hello", 42);
      forward.error!("[real] failure");
      expect(seen).toEqual(["log: hello 42", "error: [real] failure"]);
    } finally {
      Object.assign(orig, saved);
    }
  });
});

describe("dual timers (host unref contract vs guest window registry)", () => {
  type Fn = (...args: unknown[]) => unknown;

  function makeFixture() {
    const hostCalls: string[] = [];
    const winCalls: string[] = [];
    const hostTimer = { unref() {}, ref() {} };
    const host: Record<string, Fn> = {
      setTimeout: (...a: unknown[]) => { hostCalls.push("setTimeout:" + a[1]); return hostTimer; },
      setInterval: (...a: unknown[]) => { hostCalls.push("setInterval:" + a[1]); return hostTimer; },
      clearTimeout: (...a: unknown[]) => { hostCalls.push("clearTimeout"); },
      clearInterval: (...a: unknown[]) => { hostCalls.push("clearInterval"); },
    };
    const win: Record<string, unknown> = {
      setTimeout: (...a: unknown[]) => { winCalls.push("setTimeout:" + a[1]); return 0; },
      setInterval: (...a: unknown[]) => { winCalls.push("setInterval:" + a[1]); return 0; },
      clearTimeout: (...a: unknown[]) => { winCalls.push("clearTimeout"); },
      clearInterval: (...a: unknown[]) => { winCalls.push("clearInterval"); },
    };
    return { host, win, hostCalls, winCalls, hostTimer };
  }

  test("host-stack calls keep the host timer objects (the .unref() contract)", () => {
    const { host, win, hostCalls, winCalls, hostTimer } = makeFixture();
    const dual = makeDualTimers(win, host, () => false);
    const t = dual.setTimeout(() => {}, 500) as { unref(): void };
    expect(hostCalls).toEqual(["setTimeout:500"]);
    expect(winCalls).toEqual([]);
    expect(t).toBe(hostTimer);
    expect(typeof t.unref).toBe("function");
    dual.clearTimeout(t);
    expect(hostCalls).toEqual(["setTimeout:500", "clearTimeout"]);
  });

  test("guest-stack calls land on the window registry, reading it live", () => {
    const { host, win, hostCalls, winCalls } = makeFixture();
    const dual = makeDualTimers(win, host, () => true);
    expect(dual.setTimeout(() => {}, 16)).toBe(0);
    // Guest hooks of window.setTimeout apply to guest callers (pe-VM
    // scheduler behavior), including hooks installed AFTER the dual was
    // built — the window function is resolved per call.
    win.setTimeout = () => 42;
    expect(dual.setTimeout(() => {}, 1)).toBe(42);
    expect(hostCalls).toEqual([]);
    expect(winCalls).toEqual(["setTimeout:16"]);
  });

  test("the crash shape: a window timer without unref never reaches host callers", () => {
    const { host, win } = makeFixture();
    // Simulate the v4.5.2 field crash preconditions: the pe-VM hooks the
    // window's setTimeout into a wrapper that loses the handle, and Bun's
    // node:_http_server finishes a response and arms its keep-alive timer
    // through the aliased global setTimeout, then calls .unref() on the
    // result.
    win.setTimeout = (() => 0) as unknown;
    const dual = makeDualTimers(win, host, () => false);
    const timer = dual.setTimeout(() => {}, 5000) as { unref?: () => void };
    expect(typeof timer?.unref).toBe("function");
    expect(() => timer.unref!()).not.toThrow();
  });

  test("dispatchers look native to guest toString sweeps", () => {
    const { host, win } = makeFixture();
    const dual = makeDualTimers(win, host, () => false);
    expect(dual.setTimeout.name).toBe("setTimeout");
    expect(String(dual.setTimeout)).toBe("function setTimeout() { [native code] }");
    expect(String(dual.clearInterval)).toBe("function clearInterval() { [native code] }");
  });
});

describe("alias lifecycle (install/remove descriptor contract)", () => {
  const TIMER_PROPS = ["setTimeout", "setInterval", "clearTimeout", "clearInterval"];

  function makeSandbox() {
    // Sentinel the pristine host fns return — the dual's host lane must
    // surface it untouched even when the window's timers are hostile.
    const pristine = { marker: "pristine-host-timer" };
    const g: Record<string, unknown> = {};
    for (const p of TIMER_PROPS) {
      g[p] = () => pristine;
    }
    // Window stub whose timers are hooked/lossy (pe-VM scheduler shape).
    const w: Record<string, unknown> = {
      setTimeout: () => 0,
      setInterval: () => 0,
      clearTimeout: () => {},
      clearInterval: () => {},
    };
    return { g, w, pristine };
  }

  test("host lane serves the PRISTINE timers, not the generic-alias getters (capture-order regression)", () => {
    const { g, w, pristine } = makeSandbox();
    installGlobalWindowAlias(g, w);
    // A host-stack call (this test's stack has no guest CDN frames) through
    // the aliased global must return the pristine fn's return value. Under
    // the capture-order bug the host lane fell back to g[prop], which the
    // generic props loop had already turned into a window-forwarding
    // accessor — this would read 0 from the hooked window stub instead.
    const hostLane = g.setTimeout as (...a: unknown[]) => unknown;
    expect(hostLane(() => {}, 1)).toBe(pristine);
    removeGlobalWindowAlias(g, w);
  });

  test("remove restores the pre-install descriptors byte-identically", () => {
    const { g, w } = makeSandbox();
    const before = Object.fromEntries(
      TIMER_PROPS.map((p) => [p, Object.getOwnPropertyDescriptor(g, p)]),
    );
    installGlobalWindowAlias(g, w);
    expect(Object.getOwnPropertyDescriptor(g, "setTimeout")?.get).toBeDefined();
    removeGlobalWindowAlias(g, w);
    for (const p of TIMER_PROPS) {
      expect(Object.getOwnPropertyDescriptor(g, p)).toEqual(before[p]);
      expect(g[p]).toBe(before[p]!.value);
    }
  });

  test("concurrent installs restore exactly once, on the last remove", () => {
    const { g } = makeSandbox();
    const w1: Record<string, unknown> = { setTimeout: () => 1, setInterval: () => 1, clearTimeout: () => {}, clearInterval: () => {} };
    const w2: Record<string, unknown> = { setTimeout: () => 2, setInterval: () => 2, clearTimeout: () => {}, clearInterval: () => {} };
    const orig = g.setTimeout;
    installGlobalWindowAlias(g, w1);
    installGlobalWindowAlias(g, w2);
    removeGlobalWindowAlias(g, w1); // refcount 2→1: no restore yet
    expect(typeof Object.getOwnPropertyDescriptor(g, "setTimeout")?.get).toBe("function");
    expect(g.setTimeout).not.toBe(orig);
    removeGlobalWindowAlias(g, w2); // refcount 1→0: restore
    expect(g.setTimeout).toBe(orig);
  });
});
