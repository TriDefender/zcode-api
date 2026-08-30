import { describe, expect, test } from "bun:test";
import { makeDualConsole } from "./captcha-happy.js";

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
