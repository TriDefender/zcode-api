import { describe, expect, test } from "bun:test";
import { KeyParser } from "./keys.js";

function types(parser: KeyParser, chunk: string): string[] {
  return parser.feed(chunk).map((a) => a.type);
}

describe("KeyParser", () => {
  test("plain characters map to char actions", () => {
    const p = new KeyParser();
    const actions = p.feed("qs");
    expect(actions).toEqual([
      { type: "char", key: "q" },
      { type: "char", key: "s" },
    ]);
  });

  test("ctrl-c is recognized", () => {
    const p = new KeyParser();
    expect(p.feed("\x03")).toEqual([{ type: "ctrl-c" }]);
  });

  test("arrow keys", () => {
    const p = new KeyParser();
    expect(types(p, "\x1b[A\x1b[B")).toEqual(["up", "down"]);
  });

  test("page and home/end keys", () => {
    const p = new KeyParser();
    expect(types(p, "\x1b[5~\x1b[6~\x1b[H\x1b[F")).toEqual(["pageup", "pagedown", "home", "end"]);
  });

  test("SS3 application-mode keys (ESC O A)", () => {
    const p = new KeyParser();
    expect(types(p, "\x1bOA\x1bOB")).toEqual(["up", "down"]);
  });

  test("enter, tab and backspace are ignored", () => {
    const p = new KeyParser();
    expect(types(p, "\r\n\t\x7f")).toEqual(["ignore", "ignore", "ignore", "ignore"]);
  });

  test("alt+key and bare ESC-prefixed sequences are ignored", () => {
    const p = new KeyParser();
    expect(types(p, "\x1bq")).toEqual(["ignore"]);
  });

  test("escape sequence split across chunks still completes", () => {
    const p = new KeyParser();
    expect(p.feed("\x1b")).toEqual([]); // buffered, nothing yet
    expect(p.feed("[B")).toEqual([{ type: "down" }]);
  });

  test("incomplete CSI with params waits for the final byte", () => {
    const p = new KeyParser();
    expect(p.feed("\x1b[5")).toEqual([]);
    expect(p.feed("~")).toEqual([{ type: "pageup" }]);
  });

  test("a completed sequence followed by chars in one chunk", () => {
    const p = new KeyParser();
    const actions = p.feed("\x1b[Aq\x1b[Bs");
    expect(actions.map((a) => a.type)).toEqual(["up", "char", "down", "char"]);
    expect(actions[1]).toEqual({ type: "char", key: "q" });
  });

  test("unknown CSI finals are ignored", () => {
    const p = new KeyParser();
    expect(types(p, "\x1b[Z\x1b[3~")).toEqual(["ignore", "ignore"]);
  });

  test("UTF-8 multibyte chars survive as single chars", () => {
    const p = new KeyParser();
    const actions = p.feed("日");
    expect(actions).toEqual([{ type: "char", key: "日" }]);
  });

  test("SGR mouse press maps to a 0-based click", () => {
    const p = new KeyParser();
    expect(p.feed("\x1b[<0;10;5M")).toEqual([{ type: "click", x: 9, y: 4 }]);
  });

  test("mouse release and drag are ignored", () => {
    const p = new KeyParser();
    expect(types(p, "\x1b[<0;10;5m\x1b[<32;10;5M")).toEqual(["ignore", "ignore"]);
  });

  test("wheel buttons map to scroll actions", () => {
    const p = new KeyParser();
    expect(types(p, "\x1b[<64;1;1M\x1b[<65;1;1M")).toEqual(["wheel-up", "wheel-down"]);
  });

  test("right/middle button presses are ignored", () => {
    const p = new KeyParser();
    expect(types(p, "\x1b[<1;3;3M\x1b[<2;3;3M")).toEqual(["ignore", "ignore"]);
  });

  test("mouse sequence split across chunks still completes", () => {
    const p = new KeyParser();
    expect(p.feed("\x1b[<0;")).toEqual([]);
    expect(p.feed("12;7M")).toEqual([{ type: "click", x: 11, y: 6 }]);
  });

  test("malformed mouse params are ignored", () => {
    const p = new KeyParser();
    expect(types(p, "\x1b[<;5M")).toEqual(["ignore"]);
  });

  test("pathological pending buffer is flushed so input recovers", () => {
    const p = new KeyParser();
    expect(p.feed("\x1b[" + ",".repeat(70))).toEqual([]); // no final byte — buffered
    expect(p.feed("x")).toEqual([{ type: "char", key: "x" }]); // >64-byte tail dropped, not wedged
  });
});
