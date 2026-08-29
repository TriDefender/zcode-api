/**
 * Incremental VT/ANSI input parser for the TUI keyboard loop.
 *
 * stdin is read in raw mode as a UTF-8 string stream; `KeyParser.feed`
 * converts chunks into actions. A chunk can end in the middle of an escape
 * sequence (lone `\x1b` before more bytes arrive), so unconsumed input is
 * buffered until the sequence completes on a later chunk. Works identically
 * under Bun and Node — no readline keypress events involved.
 */

export type KeyAction =
  | { type: "char"; key: string }
  | { type: "up" }
  | { type: "down" }
  | { type: "pageup" }
  | { type: "pagedown" }
  | { type: "home" }
  | { type: "end" }
  | { type: "ctrl-c" }
  /** Recognized but without a binding (Enter, Tab, bare Esc, Alt+key, …). */
  | { type: "ignore" };

export class KeyParser {
  private pending = "";

  /** Consume a raw stdin chunk and return the actions it completes. */
  feed(chunk: string): KeyAction[] {
    const buf = this.pending + chunk;
    const actions: KeyAction[] = [];
    let i = 0;

    while (i < buf.length) {
      const ch = buf[i]!;

      if (ch === "\x1b") {
        if (i + 1 >= buf.length) break; // lone ESC at chunk end — wait for the rest
        if (buf[i + 1] === "[") {
          let j = i + 2;
          while (j < buf.length && !/[A-Za-z~]/.test(buf[j]!)) j++;
          if (j >= buf.length) break; // incomplete CSI — wait
          actions.push(csiAction(buf[j]!, buf.slice(i + 2, j)));
          i = j + 1;
          continue;
        }
        if (buf[i + 1] === "O") {
          if (i + 2 >= buf.length) break; // incomplete SS3 — wait
          actions.push(csiAction(buf[i + 2]!, ""));
          i += 3;
          continue;
        }
        // Alt+key or other two-byte sequence — no binding.
        actions.push({ type: "ignore" });
        i += 2;
        continue;
      }

      if (ch === "\x03") {
        actions.push({ type: "ctrl-c" });
        i++;
        continue;
      }

      if (ch < " " || ch === "\x7f") {
        // Remaining control bytes (Enter/Tab/backspace/…) carry no binding.
        actions.push({ type: "ignore" });
        i++;
        continue;
      }

      actions.push({ type: "char", key: ch });
      i++;
    }

    this.pending = buf.slice(i);
    return actions;
  }
}

function csiAction(final: string, params: string): KeyAction {
  switch (final) {
    case "A":
      return { type: "up" };
    case "B":
      return { type: "down" };
    case "H":
      return { type: "home" };
    case "F":
      return { type: "end" };
    case "~":
      if (params === "5" || params === "5;5") return { type: "pageup" };
      if (params === "6" || params === "6;5") return { type: "pagedown" };
      if (params === "1" || params === "7") return { type: "home" };
      if (params === "4" || params === "8") return { type: "end" };
      return { type: "ignore" };
    default:
      return { type: "ignore" };
  }
}
