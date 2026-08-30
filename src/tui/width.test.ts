import { describe, expect, test } from "bun:test";
import { displayWidth, padEndWidth, stripAnsi, truncateToWidth } from "./width.js";

describe("stripAnsi", () => {
  test("removes SGR sequences", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
    expect(stripAnsi("\x1b[1;36mbold cyan\x1b[0m ok")).toBe("bold cyan ok");
  });

  test("removes cursor movement and other CSI", () => {
    expect(stripAnsi("\x1b[H\x1b[2J\x1b[Khello")).toBe("hello");
    expect(stripAnsi("a\x1b[?1049hb")).toBe("ab");
  });

  test("leaves plain text untouched", () => {
    expect(stripAnsi("plain text 123")).toBe("plain text 123");
  });
});

describe("displayWidth", () => {
  test("ASCII counts one cell per char", () => {
    expect(displayWidth("hello world")).toBe(11);
    expect(displayWidth("")).toBe(0);
  });

  test("ANSI escapes count as zero", () => {
    expect(displayWidth("\x1b[31mab\x1b[0m")).toBe(2);
  });

  test("CJK counts two cells", () => {
    expect(displayWidth("日志")).toBe(4);
    expect(displayWidth("a日b志")).toBe(6);
  });

  test("fullwidth forms count two cells", () => {
    expect(displayWidth("ＡＢ")).toBe(4);
  });

  test("emoji count two cells", () => {
    expect(displayWidth("🚀x")).toBe(3);
  });

  test("combining marks count zero", () => {
    expect(displayWidth("e\u0301x")).toBe(2);
  });
});

describe("truncateToWidth", () => {
  test("returns short strings unchanged", () => {
    expect(truncateToWidth("abc", 10)).toBe("abc");
    expect(truncateToWidth("abc", 3)).toBe("abc");
  });

  test("truncates ASCII with ellipsis", () => {
    const out = truncateToWidth("abcdefghijkl", 8);
    expect(displayWidth(out)).toBe(8);
    expect(out.endsWith("…")).toBe(true);
    expect(out.startsWith("abcdefg")).toBe(true);
  });

  test("never cuts a wide char in half", () => {
    const out = truncateToWidth("日志日志日志", 7);
    expect(displayWidth(out)).toBe(7);
    expect(out).toBe("日志日…");
  });

  test("handles ANSI-laden input by stripping first", () => {
    const out = truncateToWidth("\x1b[31merror message that is quite long\x1b[0m", 10);
    expect(displayWidth(out)).toBe(10);
    expect(out).not.toContain("\x1b");
  });

  test("max 0 yields empty string", () => {
    expect(truncateToWidth("abc", 0)).toBe("");
  });

  test("wide ellipsis still fits", () => {
    const out = truncateToWidth("日志志", 3);
    expect(displayWidth(out)).toBeLessThanOrEqual(3);
  });
});

describe("padEndWidth", () => {
  test("pads ASCII to exact width", () => {
    expect(displayWidth(padEndWidth("ab", 5))).toBe(5);
    expect(padEndWidth("ab", 5)).toBe("ab   ");
  });

  test("pads CJK correctly", () => {
    expect(displayWidth(padEndWidth("日志", 6))).toBe(6);
  });

  test("does not shrink overlong input", () => {
    expect(padEndWidth("abcdef", 3)).toBe("abcdef");
  });
});
