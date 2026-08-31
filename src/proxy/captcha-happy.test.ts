import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import net from "node:net";
import { GlobalWindow } from "happy-dom";
import {
  HOST_CRITICAL_GLOBALS,
  cancelGuestTimers,
  installGlobalWindowAlias,
  makeDualConsole,
  makeGuestTimers,
  removeGlobalWindowAlias,
} from "./captcha-happy.js";

// The window alias pass mutates the PROCESS-WIDE global object. A regression
// here crashed every proxy response under Bun:
//   TypeError: timer.unref is not a function
//     at onResponseFinishHandleSocket (node:_http_server)
// because globalThis.setTimeout had been repointed at happy-dom's window
// timers, which return a bare `{}` for a closed window and a handle with no
// `unref` for delay 0 — while Bun's node:http keep-alive path requires a real
// Node Timeout.
describe("host global integrity across the window alias", () => {
  const TIMER_GLOBALS = ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] as const;

  test("timer globals are never aliased onto the host", () => {
    for (const name of TIMER_GLOBALS) expect(HOST_CRITICAL_GLOBALS.has(name)).toBe(true);

    const hostTimers = TIMER_GLOBALS.map((n) => globalThis[n]);
    const w = new GlobalWindow({ url: "https://zcode.z.ai/" });
    installGlobalWindowAlias(globalThis, w);
    try {
      // Identity, not just callability: an aliased getter would return a
      // window-bound function instead of the host's own.
      TIMER_GLOBALS.forEach((n, i) => expect(globalThis[n]).toBe(hostTimers[i]));
      // The alias must still do its job for guest-visible DOM globals.
      expect(globalThis.document as unknown).toBe(w.document as unknown);
    } finally {
      removeGlobalWindowAlias(globalThis, w);
      w.happyDOM.close();
    }
    TIMER_GLOBALS.forEach((n, i) => expect(globalThis[n]).toBe(hostTimers[i]));
  });

  test("teardown restores shadowed host globals instead of deleting them", () => {
    const w = new GlobalWindow({ url: "https://zcode.z.ai/" });
    // `atob`/`navigator` exist on both the host and the window, so the alias
    // shadows them; the old teardown deleted them outright.
    const hostAtob = globalThis.atob;
    installGlobalWindowAlias(globalThis, w);
    expect(globalThis.atob).not.toBe(hostAtob);
    removeGlobalWindowAlias(globalThis, w);
    w.happyDOM.close();

    expect(globalThis.atob).toBe(hostAtob);
    expect(typeof globalThis.console.log).toBe("function");
    // Window-only aliases must be gone, not left dangling on the host.
    expect(globalThis.document).toBeUndefined();
  });

  test("nested solves keep the alias until the last window tears down", () => {
    const hostAtob = globalThis.atob;
    const a = new GlobalWindow({ url: "https://zcode.z.ai/" });
    const b = new GlobalWindow({ url: "https://zcode.z.ai/" });
    installGlobalWindowAlias(globalThis, a);
    installGlobalWindowAlias(globalThis, b);
    removeGlobalWindowAlias(globalThis, a);
    expect(globalThis.document as unknown).toBe(b.document as unknown);
    removeGlobalWindowAlias(globalThis, b);
    a.happyDOM.close();
    b.happyDOM.close();
    expect(globalThis.atob).toBe(hostAtob);
  });
});

describe("guest timers", () => {
  test("hand out real Node handles, including delay 0 and closed windows", () => {
    const w = new GlobalWindow({ url: "https://zcode.z.ai/" });
    const timers = makeGuestTimers(w);
    // delay 0 is the case happy-dom answers with a handle lacking `unref`.
    for (const delay of [0, 50]) {
      const handle = timers.setTimeout(() => {}, delay);
      expect(typeof handle.unref).toBe("function");
      expect(typeof handle.refresh).toBe("function");
      timers.clearTimeout(handle);
    }
    w.happyDOM.close();
    // happy-dom returns `{}` once closed; ours must stay a usable handle.
    const afterClose = timers.setTimeout(() => {}, 10);
    expect(typeof afterClose.unref).toBe("function");
    cancelGuestTimers(w);
  });

  // The Aliyun/FeiLin risk engine sweeps platform APIs with
  // Function.prototype.toString and flags visible JS source. Plain closures
  // leaked their body here and upstream answered every request with
  // {"code":3007,"msg":"captcha verify failed"} — the solve itself succeeded
  // locally, so only a fingerprint assertion catches this.
  test("are indistinguishable from native timers", () => {
    const w = new GlobalWindow({ url: "https://zcode.z.ai/" });
    const timers = makeGuestTimers(w);
    for (const name of ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] as const) {
      const shim = timers[name];
      expect(shim.toString()).toBe(`function ${name}() { [native code] }`);
      expect(shim.name).toBe(name);
      expect(shim.length).toBe(globalThis[name].length);
    }
    cancelGuestTimers(w);
    w.happyDOM.close();
  });

  test("keep one identity per window", () => {
    // `setTimeout === window.setTimeout` holds in a real browser, so every
    // call site must receive the same function objects.
    const w = new GlobalWindow({ url: "https://zcode.z.ai/" });
    expect(makeGuestTimers(w).setTimeout).toBe(makeGuestTimers(w).setTimeout);
    cancelGuestTimers(w);
    w.happyDOM.close();
  });

  test("installed on the window with happy-dom's own descriptor shape", () => {
    // Enumerability/writability are themselves fingerprint signals: a timer
    // that suddenly became enumerable (or an accessor) is a tell. Compare a
    // pristine window against the same defineProperty applyPolyfills uses.
    const pristine = new GlobalWindow({ url: "https://zcode.z.ai/" });
    const expected = Object.getOwnPropertyDescriptor(pristine, "setTimeout");
    pristine.happyDOM.close();

    const w = new GlobalWindow({ url: "https://zcode.z.ai/" });
    const timers = makeGuestTimers(w);
    Object.defineProperty(w, "setTimeout", {
      value: timers.setTimeout,
      configurable: true,
      writable: true,
    });
    const actual = Object.getOwnPropertyDescriptor(w, "setTimeout");
    expect(actual?.enumerable).toBe(expected?.enumerable);
    expect(actual?.writable).toBe(expected?.writable);
    expect(actual?.configurable).toBe(expected?.configurable);
    expect(actual?.get).toBeUndefined();
    expect(Object.keys(w).includes("setTimeout")).toBe(false);
    cancelGuestTimers(w);
    w.happyDOM.close();
  });

  test("are reaped when the window is destroyed", () => {
    const w = new GlobalWindow({ url: "https://zcode.z.ai/" });
    const timers = makeGuestTimers(w);
    const pending = [timers.setTimeout(() => {}, 5_000), timers.setInterval(() => {}, 5_000)];
    for (const handle of pending) expect((handle as { _destroyed: boolean })._destroyed).toBe(false);

    w.happyDOM.close();
    cancelGuestTimers(w);
    // Assert the handles themselves are cleared rather than waiting to observe
    // a callback that must never run.
    for (const handle of pending) expect((handle as { _destroyed: boolean })._destroyed).toBe(true);
  });

  test("host timers scheduled during a solve survive window teardown", () => {
    const w = new GlobalWindow({ url: "https://zcode.z.ai/" });
    installGlobalWindowAlias(globalThis, w);
    // Under the old aliasing these landed in the window's asyncTaskManager and
    // were silently cancelled by close() — killing pool refill and keepalive.
    const hostTimer = setTimeout(() => {}, 5_000);
    const hostInterval = setInterval(() => {}, 5_000);
    removeGlobalWindowAlias(globalThis, w);
    w.happyDOM.close();

    expect((hostTimer as unknown as { _destroyed: boolean })._destroyed).toBe(false);
    expect((hostInterval as unknown as { _destroyed: boolean })._destroyed).toBe(false);
    clearTimeout(hostTimer);
    clearInterval(hostInterval);
  });
});

describe("node:http keep-alive under the alias (original crash)", () => {
  test("responses finish while a destroyed window's alias is still installed", async () => {
    const server = createServer((_req, res) => { res.writeHead(200); res.end("ok"); });
    server.keepAliveTimeout = 120_000;
    const listening = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", () => listening.resolve());
    await listening.promise;
    const { port } = server.address() as { port: number };

    const crashes: Error[] = [];
    const onCrash = (err: Error): void => { crashes.push(err); };
    process.on("uncaughtException", onCrash);

    // Two concurrent solves. The alias getters bind whichever window was
    // installed LAST, so destroying `b` while `a` keeps the ref-count above
    // zero is what leaves the host globals pointing at a CLOSED window — the
    // exact state in which `timer.unref()` threw on response finish.
    const a = new GlobalWindow({ url: "https://zcode.z.ai/" });
    const b = new GlobalWindow({ url: "https://zcode.z.ai/" });
    installGlobalWindowAlias(globalThis, a);
    installGlobalWindowAlias(globalThis, b);
    b.happyDOM.close();
    removeGlobalWindowAlias(globalThis, b);

    // The crash fired on RESPONSE FINISH, so the response must be read over a
    // real socket; `keep-alive` is what makes Bun re-arm the socket timeout.
    const request = (): Promise<string> => {
      const { promise, resolve, reject } = Promise.withResolvers<string>();
      const sock = net.connect(port, "127.0.0.1", () => {
        sock.write("GET /x HTTP/1.1\r\nHost: l\r\nConnection: keep-alive\r\n\r\n");
      });
      sock.once("data", (d) => { sock.destroy(); resolve(d.toString()); });
      sock.once("error", reject);
      return promise;
    };

    try {
      expect(await request()).toContain("200 OK");
      // Full teardown, then serve again: the old `delete` left globalThis
      // without setTimeout at all → "ReferenceError: setTimeout is not defined".
      a.happyDOM.close();
      removeGlobalWindowAlias(globalThis, a);
      expect(typeof globalThis.setTimeout).toBe("function");
      expect(await request()).toContain("200 OK");
      expect(crashes).toEqual([]);
    } finally {
      process.off("uncaughtException", onCrash);
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    }
  });
});

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
