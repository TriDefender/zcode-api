import { describe, expect, test } from "bun:test";
import { describeGuestError, isGuestOriginError } from "./guest-error.js";

/** The exact stack from the field crash report (v4.5.5, TUI mode). */
function fieldCrash(): Error {
  const err = new ReferenceError("moveBy is not defined");
  err.stack =
    "ReferenceError: moveBy is not defined\n" +
    "    at tE (https://g.alicdn.com/captcha-frontend/FeiLin/1.5.1/" +
    "feilin008.489f1fe42772a97d510f162902b33c35c004ce7746ca3f4696c42f8d1f677670.js:1:169658)";
  return err;
}

function withStack(message: string, stack: string): Error {
  const err = new Error(message);
  err.stack = stack;
  return err;
}

describe("guest-origin classification", () => {
  test("the captcha SDK crash that killed the TUI is attributed to the guest", () => {
    expect(isGuestOriginError(fieldCrash())).toBe(true);
  });

  test("host faults stay fatal", () => {
    // The v4.5.2 crash shape: a Bun-internal timer stripped of `.unref()`.
    // It is a real proxy defect and must never be swallowed as guest noise.
    const unref = withStack(
      "setTimeout(() => {}, 0).unref is not a function",
      "TypeError: …unref is not a function\n    at node:_http_server:512:9",
    );
    expect(isGuestOriginError(unref)).toBe(false);
    expect(
      isGuestOriginError(withStack("boom", "Error: boom\n    at buildFrame (/app/src/tui/frame.ts:88:3)")),
    ).toBe(false);
  });

  test("an unattributable error is treated as a host fault", () => {
    // No evidence must never mean "assume guest": that would silently mask
    // genuine crashes behind a log line.
    expect(isGuestOriginError(new Error("no stack recorded"))).toBe(false);
    expect(isGuestOriginError({ message: "not even an Error" })).toBe(false);
    expect(isGuestOriginError(undefined)).toBe(false);
  });

  test("lookalike hosts are not guest evidence", () => {
    expect(
      isGuestOriginError(withStack("x", "at f (https://evil-alicdn.com.attacker.net/x.js:1:1)")),
    ).toBe(false);
    expect(
      isGuestOriginError(withStack("x", "at f (https://cdn.example.com/p?ref=alicdn.com)")),
    ).toBe(false);
  });

  test("every host serving the SDK counts, including subdomains and cause chains", () => {
    expect(isGuestOriginError(withStack("x", "at https://o.alicdn.com/captcha-frontend/a.js:1:1"))).toBe(true);
    expect(isGuestOriginError(withStack("x", "at https://captcha.ap-southeast-1.aliyuncs.com/x.js:1:1"))).toBe(true);
    const wrapped = withStack("wrapper", "Error: wrapper\n    at host (/app/x.ts:1:1)");
    (wrapped as { cause?: unknown }).cause = fieldCrash();
    expect(isGuestOriginError(wrapped)).toBe(true);
  });

  test("a self-referential cause chain terminates", () => {
    const a = withStack("a", "at /app/a.ts:1:1");
    const b = withStack("b", "at /app/b.ts:1:1");
    (a as { cause?: unknown }).cause = b;
    (b as { cause?: unknown }).cause = a;
    expect(isGuestOriginError(a)).toBe(false);
  });

  test("the log line names the error and the bundle, without the content hash", () => {
    const line = describeGuestError(fieldCrash());
    expect(line).toContain("ReferenceError: moveBy is not defined");
    expect(line).toContain("feilin008");
    expect(line).not.toContain("https://");
  });
});
