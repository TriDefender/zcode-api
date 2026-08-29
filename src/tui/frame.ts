/**
 * Pure frame renderer for the TUI. Takes a complete view-model and returns
 * the full ANSI frame (one line per row, `\x1b[K`-terminated, `\x1b[J`-at-end)
 * that the terminal glue writes after a `\x1b[H` home. No I/O, no clock —
 * fully deterministic so tests can snapshot it.
 *
 * Layout mirrors the Android app: three stacked cards (Settings & Login /
 * Proxy Server / Logs) plus a toast line and a key-hint footer. The top two
 * cards are fixed-height; the log card absorbs the remaining terminal rows.
 */
import { displayWidth, truncateToWidth } from "./width.js";

export type Seg = { t: string; c?: string };

export interface FrameState {
  version: string;
  configPath: string;
  provider: string;
  plan: string;
  authMode: string;
  loggedIn: boolean;
  apiKeyPreview: string;
  loginInFlight: boolean;
  loginHint: string;
  serverStatus: "stopped" | "starting" | "running" | "error";
  serverUrl: string;
  serverError: string;
  modelCount: number;
  responsesEnabled: boolean;
  claimAuto: boolean;
  logTotal: number;
  logView: ReadonlyArray<{ level: string; text: string }>;
  logFollowing: boolean;
  logFromBottom: number;
  toast: { text: string; kind: "ok" | "err" | "info" } | null;
  width: number;
  height: number;
}

const DIM = "90";
const RED = "31";
const GREEN = "32";
const AMBER = "33";
const CYAN = "36";
const BOLD = "1";
const LABEL_W = 12; // fixed label column inside cards

function paint(code: string, t: string): string {
  return `\x1b[${code}m${t}\x1b[0m`;
}

function segWidth(segs: readonly Seg[]): number {
  let w = 0;
  for (const s of segs) w += displayWidth(s.t);
  return w;
}

function paintSegs(segs: readonly Seg[]): string {
  return segs.map((s) => (s.c ? paint(s.c, s.t) : s.t)).join("");
}

/** `╭─ title ────…──── pill ─╮` */
function renderTopBorder(w: number, left: Seg[], right: Seg[] = []): string {
  let l = left;
  let r = right;
  if (r.length === 0) {
    // ╭(1) ─(1) sp(1) left sp(1) fill ╮(1) = w
    if (5 + segWidth(l) > w - 1) l = [{ t: truncateToWidth(segPlain(l), Math.max(0, w - 7)) }];
    const fill = Math.max(1, w - 5 - segWidth(l));
    return paint(DIM, "╭─ ") + paintSegs(l) + paint(DIM, ` ${"─".repeat(fill)}╮`);
  }
  // ╭(1) ─(1) sp(1) left sp(1) fill sp(1) right sp(1) ─(1) ╮(1) = w
  const lw = segWidth(l);
  const rw = segWidth(r);
  let fill = w - 8 - lw - rw;
  if (fill < 1) {
    // Degenerate: shrink the right side, then the left.
    const budget = Math.max(0, w - 9 - lw);
    r = [{ t: truncateToWidth(segPlain(r), budget) }];
    fill = Math.max(1, w - 8 - lw - segWidth(r));
    if (fill < 1) {
      l = [{ t: truncateToWidth(segPlain(l), Math.max(0, w - 8 - segWidth(r))) }];
      fill = Math.max(1, w - 8 - segWidth(l) - segWidth(r));
    }
  }
  return (
    paint(DIM, "╭─ ") + paintSegs(l) + paint(DIM, ` ${"─".repeat(fill)} `) +
    paintSegs(r) + paint(DIM, " ─╮")
  );
}

function segPlain(segs: readonly Seg[]): string {
  return segs.map((s) => s.t).join("");
}

function renderBottomBorder(w: number): string {
  return paint(DIM, `╰${"─".repeat(Math.max(0, w - 2))}╯`);
}

/** `│ content …pad… │` — overflow is truncated on the segment that crosses the budget. */
function renderRow(w: number, segs: readonly Seg[]): string {
  const contentW = Math.max(0, w - 4);
  let total = 0;
  const out: string[] = [];
  for (const s of segs) {
    const sw = displayWidth(s.t);
    if (total + sw <= contentW) {
      out.push(s.c ? paint(s.c, s.t) : s.t);
      total += sw;
    } else {
      out.push(truncateToWidth(s.t, Math.max(0, contentW - total)));
      total = contentW;
      break;
    }
  }
  return `${paint(DIM, "│")} ${out.join("")}${" ".repeat(Math.max(0, contentW - total))} ${paint(DIM, "│")}`;
}

function labelRow(w: number, label: string, segs: readonly Seg[]): string {
  return renderRow(w, [{ t: " ".repeat(2) + label.padEnd(LABEL_W - 2), c: DIM }, ...segs]);
}

function blankLine(): string {
  return "\x1b[0m\x1b[K";
}

/** Radio-style option pair: selected highlighted, other dimmed. */
function optionSegs(
  current: string,
  other: string,
  disabled: boolean,
): Seg[] {
  if (disabled) {
    return [
      { t: `● ${current}   `, c: DIM },
      { t: `○ ${other}   `, c: DIM },
      { t: "(stop to switch)", c: AMBER },
    ];
  }
  return [
    { t: `● ${current}   `, c: "1;36" },
    { t: `○ ${other}`, c: DIM },
  ];
}

function logLineCode(level: string): string | undefined {
  if (level === "error") return RED;
  if (level === "warn") return AMBER;
  return undefined;
}

export function buildFrame(s: FrameState): string {
  const w = s.width;
  const h = s.height;

  if (w < 40 || h < 14) {
    // Untruncated on purpose: shrinking the diagnostic would defeat it.
    return (
      "zcode-proxy: terminal too small for the TUI.\x1b[0m\x1b[K\n" +
      `   need >= 40x14, got ${w}x${h}\x1b[0m\x1b[K` +
      "\x1b[0m\x1b[J"
    );
  }

  const pill: Seg[] = s.loginInFlight
    ? [{ t: "● logging in…", c: AMBER }]
    : s.loggedIn
      ? [{ t: "● ready", c: GREEN }]
      : [{ t: "● logged out", c: AMBER }];

  const busy = s.serverStatus === "running" || s.serverStatus === "starting";

  // --- Settings & Login card ---------------------------------------------
  const authSegs: Seg[] = s.authMode === "oauth"
    ? s.loggedIn
      ? [{ t: "● ", c: GREEN }, { t: `logged in · ${s.apiKeyPreview}` }]
      : [{ t: "○ not logged in", c: AMBER }]
    : [{ t: "apikey mode (config.yaml)", c: DIM }];

  const topRows: string[] = [
    labelRow(w, "Provider", optionSegs(s.provider, s.provider === "zai" ? "bigmodel" : "zai", busy)),
    labelRow(w, "Plan", optionSegs(s.plan, s.plan === "coding-plan" ? "start-plan" : "coding-plan", busy)),
    labelRow(w, "Auth", authSegs),
  ];
  if (s.loginInFlight && s.loginHint) {
    topRows.push(labelRow(w, "Login", [{ t: `» ${s.loginHint}`, c: AMBER }]));
  }
  const topCard: string[] = [
    renderTopBorder(w, [{ t: "Settings & Login", c: BOLD }], pill),
    ...topRows,
    renderBottomBorder(w),
  ];

  // --- Proxy Server card --------------------------------------------------
  const statusSegs: Seg[] =
    s.serverStatus === "running"
      ? [{ t: "● running", c: GREEN }, { t: "  " + s.serverUrl, c: CYAN }]
      : s.serverStatus === "starting"
        ? [{ t: "● starting…", c: AMBER }]
        : s.serverStatus === "error"
          ? [{ t: "✗ failed", c: RED }]
          : [{ t: "○ stopped", c: DIM }];
  const configText = [
    `${s.provider} · ${s.plan} · ${s.modelCount} models`,
    s.responsesEnabled ? "/v1/responses" : "",
    s.claimAuto ? "claim:auto" : "",
    `v${s.version}`,
  ].filter(Boolean).join(" · ");

  const proxyCard: string[] = [
    renderTopBorder(w, [{ t: "Proxy Server", c: BOLD }]),
    labelRow(w, "Status", statusSegs),
    labelRow(w, "Config", [{ t: configText, c: DIM }]),
  ];
  if (s.serverStatus === "error" && s.serverError) {
    proxyCard.push(labelRow(w, "Error", [{ t: s.serverError, c: RED }]));
  }
  proxyCard.push(renderBottomBorder(w));

  // --- Logs card (absorbs remaining height) -------------------------------
  const logRight: Seg[] = s.logFollowing
    ? [{ t: "following", c: GREEN }]
    : [{ t: `▼ ${s.logFromBottom} more · g follow`, c: AMBER }];
  const fixed =
    topCard.length + 1 /* blank */ + proxyCard.length + 1 /* blank */ +
    2 /* log card borders */ + 1 /* footer */ + (s.toast ? 1 : 0);
  const logRows = Math.max(1, h - fixed);
  const logCard: string[] = [
    renderTopBorder(w, [{ t: "Logs", c: BOLD }, { t: ` (${s.logTotal})`, c: DIM }], logRight),
  ];
  if (s.logView.length === 0) {
    logCard.push(renderRow(w, [{ t: "(no logs yet — start the server and send requests)", c: DIM }]));
  } else {
    for (const line of s.logView.slice(-logRows)) {
      logCard.push(renderRow(w, [{ t: truncateToWidth(line.text, w - 6), c: logLineCode(line.level) }]));
    }
  }
  logCard.push(renderBottomBorder(w));

  // --- Toast + footer ------------------------------------------------------
  const lines: string[] = [];
  lines.push(...topCard, blankLine(), ...proxyCard, blankLine(), ...logCard);
  if (s.toast) {
    const color = s.toast.kind === "ok" ? GREEN : s.toast.kind === "err" ? RED : CYAN;
    lines.push(" " + paint(color, truncateToWidth(`▸ ${s.toast.text}`, w - 2)) + "\x1b[0m\x1b[K");
  }
  const footer = [
    "s start/stop", "l login", "o logout", "p provider", "t plan",
    "↑↓/pgup/pgdn scroll", "g follow", "c clear", "q quit",
  ].join(" · ");
  lines.push(" " + paint(DIM, truncateToWidth(footer, w - 2)) + "\x1b[0m\x1b[K");

  return lines.join("\n") + "\x1b[0m\x1b[J";
}
