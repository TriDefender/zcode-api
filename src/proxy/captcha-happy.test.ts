import { describe, expect, test } from "bun:test";
import { installGuestConsoleShield } from "./captcha-happy.js";

describe("guest console shield", () => {
  test("swallows browser-style %c devtools lines on every method, passes real logs", () => {
    // Recorder goes FIRST so the shield wraps it (production order: the TUI's
    // console interception boots before the first captcha solve).
    const seen: string[] = [];
    const owner = console as unknown as Record<string, unknown>;
    const origLog = owner.log as (...a: unknown[]) => void;
    const record = (label: string) => (...a: unknown[]) => { seen.push(label + ": " + a.join(" ")); };
    owner.log = record("log");
    owner.group = record("group");
    owner.debug = record("debug");

    installGuestConsoleShield();

    // FeiLin SDK noise — the invisible devtools format, probed across methods.
    (console.log as (...a: unknown[]) => void)("%c%d", "font-size:0;color:transparent", "Error");
    (console.group as (...a: unknown[]) => void)("%c%d", "font-size:0;color:transparent", "Error");
    (console.debug as (...a: unknown[]) => void)("x", "font-size:0;color:transparent");
    // Real logs pass through.
    console.log("hello", 42);

    expect(seen).toEqual(["log: hello 42"]);
    owner.log = origLog;
  });
});
