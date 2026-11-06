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

type Seg = { t: string; c?: string };

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

/** One per-model balance window shown as a row in the Quota card. */
interface QuotaBalanceRow {
  showName: string;
  remainingUnits: number;
  totalUnits: number;
  expiresAt?: number;
  /** Upstream unit semantics; rendered unless it's the noise-default `"token"`. */
  unitType?: string;
}

/** One coding-plan usage window (monitor plane `limits[]` entry). */
interface QuotaCodingRow {
  /** Server-defined window type; `TIME_LIMIT`/`TOKENS_LIMIT` are the count/token windows. */
  type: string;
  remaining?: number;
  /**
   * Upstream usage percentage (0–100; live data 2026-09-30: 2/3/60). The one
   * self-consistent usage signal — `total`/`number` are junk (1/5 on live
   * rows), so the bar renders remaining share `1 − pct/100` from it.
   */
  percentage?: number;
  unit?: string;
  nextResetTime?: number;
}

/**
 * Quota card view-state; `null` hides the card entirely (logged out / never
 * fetched). `status: "error"` carries `error` (the fetch threw before any
 * snapshot existed); `errors` holds per-endpoint upstream failures that rode
 * along on an otherwise-OK snapshot. `coding` is the coding-plan monitor plane
 * (individual-subscription windows) — null when that endpoint failed.
 */
export interface QuotaState {
  status: "loading" | "ok" | "error";
  balances: QuotaBalanceRow[];
  coding: { level: string | null; rows: QuotaCodingRow[] } | null;
  errors: string[];
  error: string;
  /** Epoch ms of the last fetch attempt — rendered as the card pill clock. */
  fetchedAt: number;
}

export interface FrameState {
  version: string;
  configPath: string;
  provider: string;
  plan: string;
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
  quota: QuotaState | null;
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

// Solid filled buttons — GitHub dark-theme button palette via 24-bit
// truecolor SGR (Windows Terminal / mintty / modern Unix terminals render it
// natively; a legacy terminal falls back to its defaults with text intact).
//   green  #238636 success   red  #da3633 danger
//   blue   #1f6feb primary   gray #30363d secondary (text #c9d1d9)
const BTN_GREEN = "38;2;255;255;255;48;2;35;134;54";
const BTN_RED = "38;2;255;255;255;48;2;218;54;51";
const BTN_BLUE = "38;2;255;255;255;48;2;31;111;235";
const BTN_GRAY = "38;2;201;209;217;48;2;48;54;61";
const BTN_SELECTED = BTN_BLUE;

// GitHub dark-theme fg palette for the quota bars/values (same family as the
// button SGRs above; 24-bit truecolor, legacy terminals fall back to default fg):
//   success #3fb950 · warning #d29922 · danger #f85149 · muted track #6e7681
const BAR_GREEN = "38;2;63;185;80";
const BAR_AMBER = "38;2;210;153;34";
const BAR_RED = "38;2;248;81;73";
const BAR_TRACK = "38;2;110;118;129";
/** Black on bright yellow — login-hint attention chip, 16-color safe. */
const HINT_CHIP = "30;103";

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

/** `1,234,567` — full precision; quota units are the contract, not noise. */
function fmtUnits(n: number): string {
  return n.toLocaleString("en-US");
}

/** Compact `MM-DD` (or `YYYY-MM-DD` in another year); `""` when unparseable. */
function fmtExpiry(expiresAt: number): string {
  const ms = expiresAt > 1e12 ? expiresAt : expiresAt * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const mmdd = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return d.getFullYear() === new Date().getFullYear() ? mmdd : `${d.getFullYear()}-${mmdd}`;
}

function fmtClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

/** Epoch seconds/milliseconds both seen in the wild: >1e12 is milliseconds. */
function toEpochMs(v: number): number {
  return v > 1e12 ? v : v * 1000;
}

/** 1/8-cell partial blocks — the bar edge lands mid-cell for a smooth edge. */
const BAR_PARTIALS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
const BAR_W = 10;

/**
 * 括号进度条（htop/wget 同款终端原生样式）：`[████▋░░░░░]`。填充 = 阈值色，
 * 轨道与括号 = DIM 灰；末格用 1/8 分块字符（▏▎▍▌▋▊▉）做亚格平滑边缘。
 * frac 缺位时画空轨道（DIM）——占位但不上色。
 */
function quotaBar(frac: number | undefined, color: string): Seg[] {
  const cells = frac === undefined ? 0 : Math.max(0, Math.min(1, frac)) * BAR_W;
  const full = Math.floor(cells);
  const part = BAR_PARTIALS[Math.min(7, Math.floor((cells - full) * 8))];
  const fillLen = full + (part ? 1 : 0);
  return [
    { t: "[", c: BAR_TRACK },
    ...(full > 0 ? [{ t: "█".repeat(full), c: color }] : []),
    ...(part ? [{ t: part, c: color }] : []),
    ...(fillLen < BAR_W ? [{ t: "░".repeat(BAR_W - fillLen), c: BAR_TRACK }] : []),
    { t: "]", c: BAR_TRACK },
  ];
}

/** 名称列按显示宽度补空格 —— 两组行的条形起点对齐同一列。 */
function padName(t: string): string {
  const NAME_W = 13;
  const pad = NAME_W - displayWidth(t);
  return pad > 0 ? t + " ".repeat(pad) : t;
}

/** 剩余占比阈值色（GitHub dark 色系，与 Android 端同语义）：≤10% danger / ≤30% warning / 其余 success。 */
function fracColor(frac: number): string {
  return frac <= 0.1 ? BAR_RED : frac <= 0.3 ? BAR_AMBER : BAR_GREEN;
}

/** 重置倒计时：`4h 30m后重置` / `3d 06h后重置` / `12m后重置` / 已到点 `即将重置`。 */
function fmtResetCountdown(nextResetTime: number, nowMs: number): string {
  const diff = toEpochMs(nextResetTime) - nowMs;
  if (diff <= 0) return "即将重置";
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m}m后重置`;
  if (m < 1440) return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m后重置`;
  return `${Math.floor(m / 1440)}d ${String(Math.floor((m % 1440) / 60)).padStart(2, "0")}h后重置`;
}

function friendlyWindowType(type: string): string {
  if (type === "TOKENS_LIMIT") return "Token";
  if (type === "TIME_LIMIT") return "周期";
  return type;
}

/**
 * 窗口语义名：type + horizon 判别，永不按重置升序位次贴标签。位次方案已被
 * 实弹证伪（2026-10-12，max 档，对拍官方面板"剩余额度"卡）：三窗口按重置
 * 升序是 5h TOKENS_LIMIT / MCP 工具调用 TIME_LIMIT / 每周 TOKENS_LIMIT ——
 * 位次标签把工具调用行贴成"每周"、每周行贴成"月度"，整体错位一格。
 * MCP 工具调用窗口（TIME_LIMIT）由调用方先行剔除，不进本函数；已知边缘：
 * 每周窗口生命末期（最后 ≤6h）会被贴成"5 小时"，跨过重置即自愈 —— 比位次
 * 方案整体平移好。逾期（horizon < 0，时钟偏斜/服务端滚动滞后；实弹 2026-11-05
 * 截图：重置边界上的 5h 行被旧降级贴成"周期"）同样归入 5h 档 —— 5h 窗口滚动
 * 频率是每周窗口的 28 倍，逾期行几乎必是 5h 窗口。无重置时间/超长 horizon 时
 * 诚实降级为类型名/周期，不硬贴语义。
 */
function codingWindowLabel(type: string, nextResetTime: number | undefined, nowMs: number): string {
  const horizon = nextResetTime !== undefined ? toEpochMs(nextResetTime) - nowMs : undefined;
  if (horizon === undefined) return friendlyWindowType(type);
  if (horizon <= 6 * 3600e3) return "5 小时";
  if (horizon <= 8 * 86400e3) return "每周";
  if (horizon <= 45 * 86400e3) return "月度";
  return "周期";
}

/** At most this many per-model balance rows — the card must stay bounded so the Logs card keeps room on short terminals. */
const MAX_QUOTA_ROWS = 4;

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

  const authSegs: Seg[] = s.loggedIn
    ? [{ t: "● ", c: GREEN }, { t: `logged in · ${s.apiKeyPreview}` }]
    : [{ t: "○ not logged in", c: AMBER }];
  emit((composeRow(w, lines.length, "Auth", authSegs.map((g) => ({ t: g.t, c: g.c })))).line);

  const loginRow = composeRow(w, lines.length, "", s.loginInFlight
    ? [{ t: " Logging in… ", c: DIM }]
    : s.loggedIn
      ? [
          { t: " Logged In ", c: DIM },
          { t: "  " },
          // Logout is stop-first while the proxy is running — the server keeps
          // serving with its in-memory credential until restarted.
          busy
            ? { t: " Logout ", c: DIM }
            : { t: " Logout ", c: BTN_GRAY, action: { kind: "key", key: "o" } },
        ]
      : [
          { t: " OAuth Login ", c: BTN_GREEN, action: { kind: "key", key: "l" } },
          { t: "  " },
          { t: " Logout ", c: DIM },
        ]);
  emit(loginRow.line);
  regions.push(...loginRow.regions);

  if (s.loginInFlight && s.loginHint) {
    // High-contrast attention chip (black on bright yellow): the headless
    // paste fallback hint must not be missed — plain amber text reads as
    // ordinary on many terminal palettes.
    emit((composeRow(w, lines.length, "Login", [{ t: ` ▸ ${s.loginHint} `, c: HINT_CHIP }])).line);
  }

  emit(renderBottomBorder(w));
  emit("");

  // --- Quota card (auto-hidden when logged out / terminal too short) --------
  // Height budget: everything above + the Logs card's borders/one row + the
  // footer needs 21 rows, and each balance row costs one more — so on a 24-row
  // terminal the card shows at most 3 models instead of pushing the footer off
  // the screen.
  const quotaRows = s.quota ? Math.min(MAX_QUOTA_ROWS, h - 21) : 0;
  if (s.quota && quotaRows >= 1) {
    const pill: Seg[] =
      s.quota.status === "loading"
        ? [{ t: "refreshing…", c: AMBER }]
        : s.quota.status === "error"
          ? [{ t: "unavailable", c: RED }]
          : [{ t: fmtClock(s.quota.fetchedAt), c: DIM }];
    emit(renderTopBorder(w, [{ t: "Quota", c: BOLD }], pill));

    if (s.quota.status === "loading") {
      emit((composeRow(w, lines.length, "Balances", [{ t: "refreshing…", c: DIM }])).line);
    } else if (s.quota.status === "error") {
      emit((composeRow(w, lines.length, "Balances", [{ t: truncateToWidth(s.quota.error, w - 22), c: RED }])).line);
    } else {
      // Both planes render as one table: credits buckets ("Balances") then
      // coding-plan windows ("Coding"), each group's first row carries the
      // label. Rows share the value grammar: name · bar · remaining · reset.
      // Live data (2026-09-30, max tier): upstream `total`/`number` are junk
      // (1/5 on real rows) while `percentage` is self-consistent — the bar is
      // the remaining share derived from it, never an X/Y fabrication.
      // `TIME_LIMIT` rows are the MCP tool-call window (live 2026-10-12:
      // remaining=3836 / percentage=4 = the official panel's "工具调用" card) —
      // MCP 余量与 LLM 用量无关，不进 Coding 行。
      const coding = s.quota.coding?.rows ?? [];
      type QuotaTableRow = { label: string; segs: Seg[] };
      const unitNote = (u: string | undefined): Seg[] =>
        !u || u === "token" ? [] : [{ t: `  · ${u}`, c: DIM }];
      const nowMs = Date.now();
      const remainingFrac = (pct: number | undefined): number | undefined =>
        pct !== undefined && pct >= 0 && pct <= 100 ? 1 - pct / 100 : undefined;
      const sortedCoding = [...coding]
        .filter((c) => c.type !== "TIME_LIMIT")
        .sort(
          (a, b) => (a.nextResetTime ?? Number.POSITIVE_INFINITY) - (b.nextResetTime ?? Number.POSITIVE_INFINITY),
        );
      const rows: QuotaTableRow[] = [
        ...s.quota.balances.map((b, i): QuotaTableRow => {
          const exp = b.expiresAt ? fmtExpiry(b.expiresAt) : "";
          const frac = b.totalUnits > 0 ? b.remainingUnits / b.totalUnits : undefined;
          return {
            label: i === 0 ? "Balances" : "",
            segs: [
              { t: padName(truncateToWidth(b.showName || "(unnamed)", 13)), c: CYAN },
              { t: "  " },
              ...quotaBar(frac, frac !== undefined ? fracColor(frac) : BAR_GREEN),
              { t: "  " },
              {
                t: `${fmtUnits(b.remainingUnits)} / ${fmtUnits(b.totalUnits)}`,
                c: frac !== undefined ? fracColor(frac) : BAR_GREEN,
              },
              ...(exp ? [{ t: `  · exp ${exp}`, c: DIM }] : []),
              ...unitNote(b.unitType),
            ],
          };
        }),
        ...sortedCoding.map((c, i): QuotaTableRow => {
          const frac = remainingFrac(c.percentage);
          const barColor = frac !== undefined ? fracColor(frac) : BAR_GREEN;
          const value =
            c.remaining !== undefined
              ? `剩 ${fmtUnits(c.remaining)}${c.unit ? ` ${c.unit}` : " 次"}`
              : frac !== undefined
                ? `剩 ${Math.round(frac * 100)}%`
                : "—";
          const reset = c.nextResetTime !== undefined ? fmtResetCountdown(c.nextResetTime, nowMs) : "";
          return {
            label: i === 0 ? "Coding" : "",
            segs: [
              { t: padName(truncateToWidth(codingWindowLabel(c.type, c.nextResetTime, nowMs), 13)), c: CYAN },
              { t: "  " },
              ...quotaBar(frac, barColor),
              { t: "  " },
              { t: value, c: barColor },
              ...(reset ? [{ t: `  · ${reset}`, c: DIM }] : []),
              ...(i === 0 && s.quota?.coding?.level ? [{ t: `  · ${s.quota.coding.level}`, c: DIM }] : []),
            ],
          };
        }),
      ];
      if (rows.length === 0) {
        emit((composeRow(w, lines.length, "Balances", [{ t: "(no quota entries reported by upstream)", c: DIM }])).line);
      }
      for (const r of rows.slice(0, quotaRows)) {
        const row = composeRow(w, lines.length, r.label, r.segs);
        emit(row.line);
        regions.push(...row.regions);
      }
    }

    // Hidden-row count tracks what this card actually renders: TIME_LIMIT
    // (MCP tool-call) rows are filtered out above and must not count here.
    const totalRows =
      s.quota.balances.length +
      (s.quota.coding?.rows.filter((c) => c.type !== "TIME_LIMIT").length ?? 0);
    const hiddenModels = Math.max(0, totalRows - quotaRows);
    const refreshRow = composeRow(w, lines.length, "", [
      { t: " Refresh ", c: BTN_GRAY, action: { kind: "key", key: "r" } },
      ...(hiddenModels > 0 ? [{ t: `  +${hiddenModels} more (zcode-proxy quota)` as string, c: DIM }] : []),
      ...(s.quota.errors.length > 0
        ? [{ t: `  ⚠ ${truncateToWidth(s.quota.errors[0] ?? "", Math.max(0, w - 30))}` as string, c: AMBER }]
        : []),
    ]);
    emit(refreshRow.line);
    regions.push(...refreshRow.regions);
    emit(renderBottomBorder(w));
    emit("");
  }

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
    ["p", "provider"], ["t", "plan"], ["r", "quota refresh"], ["u", "update"], ["c", "clear"],
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
