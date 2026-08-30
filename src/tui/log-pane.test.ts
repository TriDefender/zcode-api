import { describe, expect, test } from "bun:test";
import { LogPane } from "./log-pane.js";

describe("LogPane", () => {
  test("push appends and tracks count", () => {
    const pane = new LogPane();
    pane.push("one");
    pane.push("two");
    expect(pane.count).toBe(2);
    expect(pane.view(10).lines.map((l) => l.text)).toEqual(["one", "two"]);
  });

  test("strips ANSI codes", () => {
    const pane = new LogPane();
    pane.push("\x1b[31merror\x1b[0m part");
    expect(pane.view(10).lines[0]!.text).toBe("error part");
  });

  test("splits embedded newlines into rows", () => {
    const pane = new LogPane();
    pane.push("a\nb\nc");
    expect(pane.count).toBe(3);
    expect(pane.view(10).lines.map((l) => l.text)).toEqual(["a", "b", "c"]);
  });

  test("trailing newline does not create an empty row", () => {
    const pane = new LogPane();
    pane.push("a\n");
    expect(pane.count).toBe(1);
  });

  test("evicts oldest beyond capacity", () => {
    const pane = new LogPane(5);
    for (let i = 0; i < 8; i++) pane.push(`line-${i}`);
    expect(pane.count).toBe(5);
    expect(pane.view(10).lines.map((l) => l.text)).toEqual([
      "line-3", "line-4", "line-5", "line-6", "line-7",
    ]);
  });

  test("follows the tail by default", () => {
    const pane = new LogPane();
    for (let i = 0; i < 20; i++) pane.push(`l${i}`);
    expect(pane.following).toBe(true);
    expect(pane.view(5).lines.map((l) => l.text)).toEqual(["l15", "l16", "l17", "l18", "l19"]);
    expect(pane.view(5).fromBottom).toBe(0);
  });

  test("scrollUp freezes the viewport, scrollDown to 0 resumes following", () => {
    const pane = new LogPane();
    for (let i = 0; i < 20; i++) pane.push(`l${i}`);
    pane.scrollUp(3);
    expect(pane.following).toBe(false);
    expect(pane.view(5).lines.map((l) => l.text)).toEqual(["l12", "l13", "l14", "l15", "l16"]);
    expect(pane.view(5).fromBottom).toBe(3);
    pane.scrollDown(2);
    expect(pane.view(5).fromBottom).toBe(1);
    pane.scrollDown(10);
    expect(pane.following).toBe(true);
    expect(pane.view(5).lines.at(-1)!.text).toBe("l19");
  });

  test("scrollUp is clamped to the buffer length", () => {
    const pane = new LogPane();
    for (let i = 0; i < 10; i++) pane.push(`l${i}`);
    pane.scrollUp(1000);
    expect(pane.view(3).lines.map((l) => l.text)).toEqual(["l0", "l1", "l2"]);
    expect(pane.view(3).fromBottom).toBe(7);
  });

  test("clear empties and resumes following", () => {
    const pane = new LogPane();
    for (let i = 0; i < 10; i++) pane.push(`l${i}`);
    pane.scrollUp(5);
    pane.clear();
    expect(pane.count).toBe(0);
    expect(pane.following).toBe(true);
    expect(pane.view(5).lines).toEqual([]);
  });

  test("keeps levels and monotonic sequence", () => {
    const pane = new LogPane();
    pane.push("info line", "info");
    pane.push("warn line", "warn");
    pane.push("error line", "error");
    const view = pane.view(10).lines;
    expect(view.map((l) => l.level)).toEqual(["info", "warn", "error"]);
    expect(view[0]!.seq < view[1]!.seq && view[1]!.seq < view[2]!.seq).toBe(true);
  });

  test("viewport height is clamped to at least 1", () => {
    const pane = new LogPane();
    pane.push("a");
    pane.push("b");
    expect(pane.view(0).lines).toHaveLength(1);
  });
});
