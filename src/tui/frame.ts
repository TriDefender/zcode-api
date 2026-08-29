/**
 * Pure frame renderer for the TUI. Takes a complete view-model and returns
 * the full ANSI frame plus the clickable hit regions — interactive rows are
 * rendered as bracketed buttons (`[ zai ]`, `[S] Start`) and every button
 * registers a row/column span the app hit-tests against mouse clicks (SGR
 * mouse tracking, opencode-style). No I/O, no clock — fully deterministic so
 * tests can snapshot both the text and the regions.
 *
 * Layout mirrors the Android app: three stacked cards (Settings & Login /
 * Proxy Server / Logs) plus a toast line and a key-hint footer (the hints
 * are themselves clickable). The top two cards are fixed-height; the log
 * card absorbs the remaining terminal rows.
 */
import { displayWidth, truncateToWidth } from "./width.js";

export type Seg = { t: string; c?: string };

/** What a mouse click on a button should do. `key` reuses the key bindings. */
export type ClickAction =
  | { kind: "key"; key: string }
  | { kind: "provider"; value: "zai" | "bigmodel" }
  | { kind: "plan"; value: "coding-plan" | "start-plan" }
  | { kind: "follow" };

/** 0-based terminal-cell span carrying an action. */
export interface ClickRegion {
  row: number;
  col: number;
  width: number;
  action: ClickAction;
}

export interface Frame {
  text: string;
  regions: ClickRegion[];
}

/** Hit-test: the action whose button contains (col,row), if any. */
export function findRegion(regions: readonly ClickRegion[], row: number, col: number): ClickAction | null {
  for (const r of regions) {
    if (r.row === row && col >= r.col && col < r.col + r.width) return r.action;
  }
  return null;
}

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

// Solid filled buttons (classic pressed-block look): background + fg codes.
// Green = start/confirm, red = destructive, blue = primary/selected, gray = secondary.
const BTN_GREEN = "1;30;42";
const BTN_RED = "1;97;41";
const BTN_BLUE = "1;97;44";
const BTN_GRAY = "97;100";
const BTN_SELECTED = BTN_BLUE;

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

function segPlain(segs: readonly Seg[]): string {
  return segs.map((s) => s.t).join("");
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

function renderBottomBorder(w: number): string {
  return paint(DIM, `╰${"─".repeat(Math.max(0, w - 2))}╯`);
}

interface Part {
  t: string;
  c?: string;
  action?: ClickAction;
}

/**
 * `│   Label  [button] [button] … │` for an interactive row: parts are laid
 * out left-to-right after the (optional) label column; parts carrying an
 * action register a click region spanning exactly their cells. Overflow is
 * dropped on the part that crosses the budget (and its region never added).
 * With `chrome: false` the card borders/padding are omitted (footer row).
 */
function composeRow(
  w: number,
  row: number,
  label: string | null,
  parts: readonly Part[],
  opts: { chrome?: boolean } = {},
): { line: string; regions: ClickRegion[] } {
  const chrome = opts.chrome !== false;
  const contentW = Math.max(0, w - (chrome ? 4 : 2));
  const prefixPlain = label !== null ? " ".repeat(2) + label.padEnd(LABEL_W - 2) : " ".repeat(2);
  const prefixW = displayWidth(prefixPlain);
  const prefixPainted = label !== null ? paint(DIM, prefixPlain) : prefixPlain;

  const regions: ClickRegion[] = [];
  const painted: string[] = [];
  let col = prefixW;
  for (const p of parts) {
    const pw = displayWidth(p.t);
    if (col + pw > contentW) break;
    // With chrome the content starts after `│ ` (2 cells); without it the
    // prefix itself starts at column 0.
    if (p.action) regions.push({ row, col: (chrome ? 2 : 0) + col, width: pw, action: p.action });
    painted.push(p.c ? paint(p.c, p.t) : p.t);
    col += pw;
  }
  if (!chrome) {
    return { line: prefixPainted + painted.join(""), regions };
  }
  const pad = " ".repeat(Math.max(0, contentW - col));
  return {
    line: `${paint(DIM, "│")} ${prefixPainted}${painted.join("")}${pad} ${paint(DIM, "│")}`,
    regions,
  };
}

/** Radio-style option buttons rendered in FIXED slot order — selection only
 * changes colors, never positions, so clicking the same spot twice always
 * hits the same button. */
function optionParts(
  slots: readonly [string, string],
  selected: string,
  makeAction: (v: string) => ClickAction,
  disabled: boolean,
): Part[] {
  const parts: Part[] = [];
  slots.forEach((v, i) => {
    if (i > 0) parts.push({ t: "  " });
    parts.push({
      t: ` ${v} `,
      c: disabled ? DIM : v === selected ? BTN_SELECTED : BTN_GRAY,
      action: disabled ? undefined : makeAction(v),
    });
  });
  if (disabled) parts.push({ t: "  " }, { t: "(stop to switch)", c: AMBER });
  return parts;
}

function logLineCode(level: string): string | undefined {
  if (level === "error") return RED;
  if (level === "warn") return AMBER;
  return undefined;
}

export function buildFrame(s: FrameState): Frame {
  const w = s.width;
  const h = s.height;
  const regions: ClickRegion[] = [];
  const lines: string[] = [];
  const emit = (line: string): number => {
    lines.push(line + "\x1b[0m\x1b[K");
    return lines.length - 1;
  };

  if (w < 40 || h < 14) {
    // Untruncated on purpose: shrinking the diagnostic would defeat it.
    emit("zcode-proxy: terminal too small for the TUI.");
    emit(`   need >= 40x14, got ${w}x${h}`);
    return { text: lines.join("\n") + "\x1b[0m\x1b[J", regions };
  }

  const pill: Seg[] = s.loginInFlight
    ? [{ t: "● logging in…", c: AMBER }]
    : s.loggedIn
      ? [{ t: "● ready", c: GREEN }]
      : [{ t: "● logged out", c: AMBER }];

  const busy = s.serverStatus === "running" || s.serverStatus === "starting";

  // --- Settings & Login card ---------------------------------------------
  emit(renderTopBorder(w, [{ t: "Settings & Login", c: BOLD }], pill));

  const providerRow = composeRow(
    w, lines.length, "Provider",
    optionParts(
      ["zai", "bigmodel"],
      s.provider,
      (v) => ({ kind: "provider", value: v as "zai" | "bigmodel" }),
      busy,
    ),
  );
  emit(providerRow.line);
  regions.push(...providerRow.regions);

  const planRow = composeRow(
    w, lines.length, "Plan",
    optionParts(
      ["coding-plan", "start-plan"],
      s.plan,
      (v) => ({ kind: "plan", value: v as "coding-plan" | "start-plan" }),
      busy,
    ),
  );
  emit(planRow.line);
  regions.push(...planRow.regions);

  const authSegs: Seg[] = s.authMode === "oauth"
    ? s.loggedIn
      ? [{ t: "● ", c: GREEN }, { t: `logged in · ${s.apiKeyPreview}` }]
      : [{ t: "○ not logged in", c: AMBER }]
    : [{ t: "apikey mode (config.yaml)", c: DIM }];
  emit((composeRow(w, lines.length, "Auth", authSegs.map((g) => ({ t: g.t, c: g.c })))).line);

  const loginRow = composeRow(w, lines.length, "", s.loginInFlight
    ? [{ t: " Logging in… ", c: DIM }]
    : s.loggedIn
      ? [
          { t: " Logged In ", c: DIM },
          { t: "  " },
          { t: " Logout ", c: BTN_GRAY, action: { kind: "key", key: "o" } },
        ]
      : [
          { t: " OAuth Login ", c: BTN_GREEN, action: { kind: "key", key: "l" } },
          { t: "  " },
          { t: " Logout ", c: DIM },
        ]);
  emit(loginRow.line);
  regions.push(...loginRow.regions);

  if (s.loginInFlight && s.loginHint) {
    emit((composeRow(w, lines.length, "Login", [{ t: `» ${s.loginHint}`, c: AMBER }])).line);
  }

  emit(renderBottomBorder(w));
  emit("");

  // --- Proxy Server card --------------------------------------------------
  emit(renderTopBorder(w, [{ t: "Proxy Server", c: BOLD }]));

  const statusSegs: Seg[] =
    s.serverStatus === "running"
      ? [{ t: "● running", c: GREEN }, { t: "  " + s.serverUrl, c: CYAN }]
      : s.serverStatus === "starting"
        ? [{ t: "● starting…", c: AMBER }]
        : s.serverStatus === "error"
          ? [{ t: "✗ failed", c: RED }]
          : [{ t: "○ stopped", c: DIM }];
  emit((composeRow(w, lines.length, "Status", statusSegs.map((g) => ({ t: g.t, c: g.c })))).line);

  const configText = [
    `${s.provider} · ${s.plan} · ${s.modelCount} models`,
    s.responsesEnabled ? "/v1/responses" : "",
    s.claimAuto ? "claim:auto" : "",
    `v${s.version}`,
  ].filter(Boolean).join(" · ");
  emit((composeRow(w, lines.length, "Config", [{ t: configText, c: DIM }])).line);

  const startEnabled = s.serverStatus === "stopped" || s.serverStatus === "error";
  const stopEnabled = s.serverStatus === "running";
  const serverButtonsRow = composeRow(w, lines.length, "", [
    { t: " Start ", c: startEnabled ? BTN_GREEN : DIM, action: startEnabled ? { kind: "key", key: "s" } : undefined },
    { t: "    " },
    { t: " Stop ", c: stopEnabled ? BTN_RED : DIM, action: stopEnabled ? { kind: "key", key: "s" } : undefined },
  ]);
  emit(serverButtonsRow.line);
  regions.push(...serverButtonsRow.regions);

  if (s.serverStatus === "error" && s.serverError) {
    emit((composeRow(w, lines.length, "Error", [{ t: s.serverError, c: RED }])).line);
  }
  emit(renderBottomBorder(w));
  emit("");

  // --- Logs card (absorbs remaining height) -------------------------------
  const logRight: Seg[] = s.logFollowing
    ? [{ t: "following", c: GREEN }]
    : [{ t: `▼ ${s.logFromBottom} more · g follow`, c: AMBER }];
  const fixed =
    lines.length + 2 /* log card borders */ + 1 /* footer */ + (s.toast ? 1 : 0);
  const logRows = Math.max(1, h - fixed);
  const logBorderRow = emit(renderTopBorder(w, [{ t: "Logs", c: BOLD }, { t: ` (${s.logTotal})`, c: DIM }], logRight));
  if (!s.logFollowing) {
    // Clicking the log title bar jumps back to the tail, like the g key.
    regions.push({ row: logBorderRow, col: 0, width: w, action: { kind: "follow" } });
  }
  if (s.logView.length === 0) {
    emit((composeRow(w, lines.length, null, [{ t: "(no logs yet — start the server and send requests)", c: DIM }])).line);
  } else {
    for (const line of s.logView.slice(-logRows)) {
      emit((composeRow(w, lines.length, null, [{ t: truncateToWidth(line.text, w - 6), c: logLineCode(line.level) }])).line);
    }
  }
  emit(renderBottomBorder(w));

  // --- Toast + footer ------------------------------------------------------
  if (s.toast) {
    const color = s.toast.kind === "ok" ? GREEN : s.toast.kind === "err" ? RED : CYAN;
    emit(" " + paint(color, truncateToWidth(`▸ ${s.toast.text}`, w - 2)));
  }
  const footerRow = lines.length;
  const footerParts: Part[] = [];
  // Priority order — the footer composes greedily and drops its tail on
  // narrow terminals, so the primary actions must come first.
  const footerItems: Array<[string, string]> = [
    ["s", "start/stop"], ["l", "login"], ["o", "logout"], ["g", "follow"], ["q", "quit"],
    ["p", "provider"], ["t", "plan"], ["c", "clear"],
  ];
  footerParts.push({ t: "↑↓ scroll", c: DIM });
  for (const [key, label] of footerItems) {
    footerParts.push({ t: " · ", c: DIM });
    footerParts.push({ t: `[${key}] ${label}`, c: DIM, action: { kind: "key", key } });
  }
  // The footer lives outside the card borders — no chrome, plain indent.
  const footer = composeRow(w, footerRow, null, footerParts, { chrome: false });
  emit(footer.line);
  regions.push(...footer.regions);

  return { text: lines.join("\n") + "\x1b[0m\x1b[J", regions };
}
