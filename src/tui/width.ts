/**
 * Display-width helpers for TUI rendering.
 *
 * Terminal cells are monospace but East-Asian characters, fullwidth forms and
 * most emoji occupy 2 cells while combining marks occupy 0 — naive `.length`
 * math misaligns box borders the moment a log line contains CJK text (and
 * proxy errors regularly do, since upstream bodies are passed through).
 * `displayWidth` implements the common subset of wcwidth; width errors on
 * exotic content are cosmetic only (a mis-truncated log line), never fatal.
 */

/** CSI sequences, OSC sequences, and remaining two-byte ESC sequences. */
const ANSI_RE = /\x1b(?:\[[0-9;?<=>! ]*[A-Za-z~@`\\]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_=>])/g;

/** Ranges whose code points occupy two terminal cells. */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4c6], [0xa960, 0xa97c], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe52], [0xfe54, 0xfe66],
  [0xfe68, 0xfe6b], [0xff01, 0xff60], [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f900, 0x1f9ff],
  [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];

/** Ranges whose code points occupy zero cells (combining marks, ZW*, variation selectors). */
const ZERO_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f], [0x200b, 0x200f], [0x20d0, 0x20ff], [0xfe00, 0xfe0f],
];

function inRanges(cp: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = ranges[mid]!;
    if (cp < a) hi = mid - 1;
    else if (cp > b) lo = mid + 1;
    else return true;
  }
  return false;
}

function codePointWidth(cp: number): number {
  if (cp === 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (inRanges(cp, ZERO_RANGES)) return 0;
  if (inRanges(cp, WIDE_RANGES)) return 2;
  return 1;
}

/** Remove ANSI escape sequences so the result can be measured / compared. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/** Display width in terminal cells (ANSI escape sequences count as 0). */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) {
    w += codePointWidth(ch.codePointAt(0)!);
  }
  return w;
}

/**
 * Truncate to `max` display cells, appending `…` when anything was cut.
 * ANSI sequences are stripped first — callers that want color re-wrap the
 * result themselves.
 */
export function truncateToWidth(s: string, max: number, ellipsis = "…"): string {
  if (max <= 0) return "";
  const plain = stripAnsi(s);
  if (displayWidth(plain) <= max) return plain;
  const ellWidth = displayWidth(ellipsis);
  let w = 0;
  let out = "";
  for (const ch of plain) {
    const cw = codePointWidth(ch.codePointAt(0)!);
    if (w + cw > max - ellWidth) break;
    out += ch;
    w += cw;
  }
  return out + ellipsis;
}

/** Pad with spaces (display-width aware) so the string occupies exactly `width` cells. */
export function padEndWidth(s: string, width: number): string {
  const pad = width - displayWidth(s);
  return pad > 0 ? s + " ".repeat(pad) : s;
}
