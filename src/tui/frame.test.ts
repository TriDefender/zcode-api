import { describe, expect, test } from "bun:test";
import { buildFrame, findRegion, type FrameState } from "./frame.js";
import { displayWidth, stripAnsi } from "./width.js";

function baseState(overrides: Partial<FrameState> = {}): FrameState {
  return {
    version: "2.6.0",
    configPath: "config.yaml",
    provider: "zai",
    plan: "coding-plan",
    loggedIn: false,
    apiKeyPreview: "",
    loginInFlight: false,
    loginHint: "",
    serverStatus: "stopped",
    serverUrl: "",
    serverError: "",
    modelCount: 6,
    responsesEnabled: true,
    claimAuto: false,
    quota: null,
    logTotal: 0,
    logView: [],
    logFollowing: true,
    logFromBottom: 0,
    toast: null,
    width: 80,
    height: 30,
    ...overrides,
  };
}

function plainLines(state: FrameState): string[] {
  return buildFrame(state).text.split("\n").map((l) => stripAnsi(l.replace(/\x1b\[K$/, "")));
}

describe("buildFrame", () => {
  test("renders the three card titles, mirroring the Android layout", () => {
    const lines = plainLines(baseState());
    const text = lines.join("\n");
    expect(text).toContain("Settings & Login");
    expect(text).toContain("Proxy Server");
    expect(text).toContain("Logs");
  });

  test("shows provider/plan button state and auth status", () => {
    const text = plainLines(baseState({ loggedIn: true, apiKeyPreview: "ab12cd34…" })).join("\n");
    expect(text).toContain(" zai ");
    expect(text).toContain(" bigmodel ");
    expect(text).toContain(" coding-plan ");
    expect(text).toContain(" start-plan ");
    expect(text).toContain("logged in · ab12cd34…");
    expect(text).toContain(" Logged In ");
    expect(text).toContain(" Logout ");
  });

  test("shows a running server with its URL", () => {
    const text = plainLines(
      baseState({ serverStatus: "running", serverUrl: "http://127.0.0.1:8080" }),
    ).join("\n");
    expect(text).toContain("● running");
    expect(text).toContain("http://127.0.0.1:8080");
  });

  test("shows the error row when startup failed", () => {
    const text = plainLines(
      baseState({ serverStatus: "error", serverError: "EADDRINUSE: port busy" }),
    ).join("\n");
    expect(text).toContain("✗ failed");
    expect(text).toContain("EADDRINUSE: port busy");
  });

  test("renders log lines newest-last and marks the count", () => {
    const text = plainLines(
      baseState({
        logTotal: 3,
        logView: [
          { level: "info", text: "one" },
          { level: "error", text: "boom" },
          { level: "info", text: "two" },
        ],
      }),
    ).join("\n");
    expect(text).toContain("(3)");
    expect(text.indexOf("one")).toBeLessThan(text.indexOf("boom"));
    expect(text.indexOf("boom")).toBeLessThan(text.indexOf("two"));
  });

  test("shows an empty-log placeholder", () => {
    const text = plainLines(baseState()).join("\n");
    expect(text).toContain("(no logs yet");
  });

  test("scrollback state shows a more-below indicator instead of following", () => {
    const text = plainLines(baseState({ logFollowing: false, logFromBottom: 42 })).join("\n");
    expect(text).toContain("▼ 42 more");
    expect(text).not.toContain("following");
  });

  test("toast line appears above the footer", () => {
    const lines = plainLines(baseState({ toast: { text: "proxy started", kind: "ok" } }));
    const footerIdx = lines.findIndex((l) => l.includes("[s] start/stop"));
    const toastIdx = lines.findIndex((l) => l.includes("proxy started"));
    expect(toastIdx).toBeGreaterThan(0);
    expect(toastIdx).toBe(footerIdx - 1);
  });

  test("login-in-flight adds a hint row and pill", () => {
    const text = plainLines(
      baseState({ loginInFlight: true, loginHint: "waiting for browser authorization…" }),
    ).join("\n");
    expect(text).toContain("waiting for browser authorization…");
    expect(text).toContain("● logging in…");
  });

  test("provider switch is locked while the proxy runs", () => {
    const text = plainLines(baseState({ serverStatus: "running" })).join("\n");
    expect(text).toContain("(stop to switch)");
  });

  test("server Start/Stop are clickable in either state (filled buttons row)", () => {
    for (const serverStatus of ["stopped", "running"] as const) {
      const f = buildFrame(baseState({ serverStatus, loggedIn: true, apiKeyPreview: "ab…" }));
      const lines = f.text.split("\n").map((l) => stripAnsi(l.replace(/\x1b\[K$/, "")));
      const serverRow = lines.findIndex((l) => l.includes(" Stop ") && !l.includes("[s]"));
      expect(serverRow).toBeGreaterThan(0);
      const onRow = f.regions.filter((r) => r.row === serverRow);
      expect(onRow.some((r) => r.action.kind === "key" && r.action.key === "s")).toBe(true);
      const text = lines.join("\n");
      expect(text).toContain(" Start ");
      expect(text).toContain(" Stop ");
    }
  });

  test("registers click regions for provider/plan/login/server/footer buttons", () => {
    const { regions } = buildFrame(baseState());
    const actions = regions.map((r) => r.action);
    expect(actions).toContainEqual({ kind: "provider", value: "zai" });
    expect(actions).toContainEqual({ kind: "provider", value: "bigmodel" });
    expect(actions).toContainEqual({ kind: "plan", value: "coding-plan" });
    expect(actions).toContainEqual({ kind: "plan", value: "start-plan" });
    expect(actions).toContainEqual({ kind: "key", key: "l" });
    expect(actions).toContainEqual({ kind: "key", key: "s" });
    expect(actions).toContainEqual({ kind: "key", key: "q" });
  });

  test("findRegion hit-tests provider buttons on their row", () => {
    const { text, regions } = buildFrame(baseState());
    const lines = text.split("\n").map((l) => stripAnsi(l.replace(/\x1b\[K$/, "")));
    const providerRow = lines.findIndex((l) => l.includes(" zai "));
    expect(providerRow).toBeGreaterThan(0);
    const colOfZai = lines[providerRow]!.indexOf(" zai ");
    const colOfBigmodel = lines[providerRow]!.indexOf(" bigmodel ");
    expect(findRegion(regions, providerRow, colOfZai + 2)).toEqual({ kind: "provider", value: "zai" });
    expect(findRegion(regions, providerRow, colOfBigmodel + 2)).toEqual({ kind: "provider", value: "bigmodel" });
    expect(findRegion(regions, providerRow, colOfBigmodel - 1)).toBeNull();
  });

  test("provider/plan buttons are locked (no regions) while the proxy runs", () => {
    const { regions } = buildFrame(baseState({ serverStatus: "running" }));
    const providerRegions = regions.filter((r) => r.action.kind === "provider");
    expect(providerRegions).toEqual([]);
  });

  test("logout is only clickable when logged in (card button, not footer)", () => {
    const cardLogoutRegions = (f: { text: string; regions: ReturnType<typeof buildFrame>["regions"] }) => {
      const lines = f.text.split("\n").map((l) => stripAnsi(l.replace(/\x1b\[K$/, "")));
      const row = lines.findIndex((l) => l.includes(" Logout "));
      return f.regions.filter((r) => r.row === row && r.action.kind === "key" && r.action.key === "o");
    };
    expect(cardLogoutRegions(buildFrame(baseState({ loggedIn: false })))).toEqual([]);
    expect(cardLogoutRegions(buildFrame(baseState({ loggedIn: true, apiKeyPreview: "ab12…" })))).toHaveLength(1);
  });

  test("the log title bar is a follow button while scrolled", () => {
    const following = buildFrame(baseState({ logFollowing: true }));
    expect(following.regions.some((r) => r.action.kind === "follow")).toBe(false);
    const scrolled = buildFrame(baseState({ logFollowing: false, logFromBottom: 9 }));
    const follow = scrolled.regions.find((r) => r.action.kind === "follow");
    expect(follow).toBeDefined();
    expect(follow!.row).toBeGreaterThan(0);
  });

  test("buttons keep their slots when the selection changes (no jumping)", () => {
    // zai is always the first slot, bigmodel the second — regardless of which
    // is selected (the user's mouse must not hit a different button twice).
    for (const provider of ["zai", "bigmodel"] as const) {
      const { text, regions } = buildFrame(baseState({ provider }));
      const lines = text.split("\n").map((l) => stripAnsi(l.replace(/\x1b\[K$/, "")));
      const row = lines.findIndex((l) => l.includes(" zai "));
      expect(lines[row]!.indexOf(" zai ")).toBeLessThan(lines[row]!.indexOf(" bigmodel "));
      const bigmodelCol = lines[row]!.indexOf(" bigmodel ");
      expect(findRegion(regions, row, bigmodelCol + 2)).toEqual({ kind: "provider", value: "bigmodel" });
      expect(findRegion(regions, row, lines[row]!.indexOf(" zai ") + 2)).toEqual({ kind: "provider", value: "zai" });
    }
    for (const plan of ["coding-plan", "start-plan"] as const) {
      const { text } = buildFrame(baseState({ plan }));
      const lines = text.split("\n").map((l) => stripAnsi(l.replace(/\x1b\[K$/, "")));
      const row = lines.findIndex((l) => l.includes(" coding-plan "));
      expect(lines[row]!.indexOf(" coding-plan ")).toBeLessThan(lines[row]!.indexOf(" start-plan "));
    }
  });

  test("no line exceeds the terminal width (CJK logs included)", () => {
    const state = baseState({
      logTotal: 2,
      logView: [
        { level: "info", text: "#001 上游连接失败 upstream connect failed after many retries with backoff" },
        { level: "error", text: "🚀 emoji + 日本語テキスト mixing widths for truncation testing 1234567890" },
      ],
    });
    for (const raw of buildFrame(state).text.split("\n")) {
      expect(displayWidth(raw)).toBeLessThanOrEqual(state.width);
    }
  });

  test("box borders span the full width", () => {
    const lines = plainLines(baseState());
    const borders = lines.filter((l) => l.startsWith("╭"));
    expect(borders.length).toBe(3);
    for (const b of borders) expect(displayWidth(b)).toBe(80);
    for (const b of lines.filter((l) => l.startsWith("╰"))) {
      expect(displayWidth(b)).toBe(80);
    }
  });

  test("fills the terminal height: cards + logs + footer", () => {
    const state = baseState({
      logTotal: 50,
      logView: Array.from({ length: 50 }, (_, i) => ({ level: "info", text: `log ${i}` })),
    });
    const lines = plainLines(state);
    // every rendered row (before \x1b[J) accounts for one terminal row
    expect(lines.length).toBe(30);
  });

  test("too-small terminals get a compact message instead of boxes", () => {
    const frame = buildFrame(baseState({ width: 30, height: 10 })).text;
    expect(frame).toContain("terminal too small");
    expect(frame).not.toContain("╭");
  });

  test("quota card hidden when quota is null (logged out)", () => {
    const text = plainLines(baseState({ quota: null })).join("\n");
    expect(text).not.toContain("Quota");
  });

  test("quota card shows per-model remaining/total with expiry", () => {
    const text = plainLines(baseState({
      quota: {
        status: "ok",
        balances: [
          { showName: "GLM-5.3", remainingUnits: 2000000, totalUnits: 3000000, expiresAt: 1767225600 },
          { showName: "GLM Coding", remainingUnits: 5, totalUnits: 100 },
        ],
        coding: null,
        errors: [],
        error: "",
        fetchedAt: new Date("2026-09-29T12:00:00").getTime(),
      },
    })).join("\n");
    expect(text).toContain("Quota");
    expect(text).toContain("GLM-5.3");
    expect(text).toContain("2,000,000 / 3,000,000");
    expect(text).toContain("GLM Coding");
    expect(text).toContain("5 / 100");
    expect(text).toContain("12:00:00");
    expect(text).toContain(" Refresh ");
  });

  test("quota card renders coding-plan windows after credit buckets", () => {
    const twoHoursOut = Date.now() + 2 * 3600e3; // ≤6h → "5 小时" label
    const text = plainLines(baseState({
      quota: {
        status: "ok",
        balances: [{ showName: "GLM-5.3", remainingUnits: 2000000, totalUnits: 3000000 }],
        coding: {
          level: "max",
          rows: [
            // MCP tool-call window — dropped, never rendered as LLM usage.
            { type: "TIME_LIMIT", remaining: 3836, nextResetTime: Date.now() + 3 * 86400e3 },
            { type: "TOKENS_LIMIT", remaining: 36, unit: "prompt", nextResetTime: twoHoursOut },
            { type: "WEEK_LIMIT", remaining: 500 },
          ],
        },
        errors: [],
        error: "",
        fetchedAt: Date.now(),
      },
    })).join("\n");
    expect(text).toContain("Balances");
    expect(text).toContain("Coding");
    expect(text).not.toContain("TIME_LIMIT");
    expect(text).not.toContain("3,836");
    // Window names are horizon-based — known-shape rows never show raw types.
    expect(text).toContain("5 小时");
    // Mirror of the official panel: remaining alone — upstream `number` is not
    // a comparable total (live TIME_LIMIT row: remaining=3836, number=1).
    expect(text).toContain("剩 36 prompt");
    expect(text).toContain("后重置");
    expect(text).toContain("· max");
    // No reset time → no semantic label either: honest fallback to the raw type.
    expect(text).toContain("WEEK_LIMIT");
    expect(text).toContain("500");
  });

  test("coding rows carry their own group label and render standalone", () => {
    const quota = {
      status: "ok" as const,
      balances: [],
      coding: { level: null, rows: [{ type: "TOKENS_LIMIT", remaining: 9, nextResetTime: Date.now() + 3600e3 }] },
      errors: [],
      error: "",
      fetchedAt: Date.now(),
    };
    const text = plainLines(baseState({ quota })).join("\n");
    expect(text).toContain("Coding");
    expect(text).not.toContain("Balances");
    const codingLine = plainLines(baseState({ quota })).find((l) => l.includes("5 小时")) ?? "";
    expect(codingLine).toContain("剩 9 次");
    expect(codingLine).not.toContain("/");
    expect(text).toContain("后重置");
  });

  test("MCP tool-call window (TIME_LIMIT) is dropped, not mislabeled as an LLM window", () => {
    const text = plainLines(baseState({
      quota: {
        status: "ok",
        balances: [],
        coding: {
          level: null,
          rows: [{ type: "TIME_LIMIT", remaining: 3836, percentage: 4, nextResetTime: Date.now() + 3600e3 }],
        },
        errors: [],
        error: "",
        fetchedAt: Date.now(),
      },
    })).join("\n");
    expect(text).toContain("(no quota entries reported by upstream)");
    expect(text).not.toContain("3,836");
    expect(text).not.toContain("每周");
  });

  test("coding windows get semantic labels, bars and countdowns (live 2026-10-12 shape)", () => {
    const now = Date.now();
    // Exact live /quota shape (2026-10-12, max tier), upstream order. The
    // official panel labels these: 5 小时 剩99% · 工具调用 96% · 每周 剩41%.
    const rows = [
      { type: "TOKENS_LIMIT", percentage: 1, nextResetTime: now + 4.9 * 3600e3 },
      { type: "TIME_LIMIT", remaining: 3836, percentage: 4, nextResetTime: now + 3 * 86400e3 + 3600e3 },
      { type: "TOKENS_LIMIT", percentage: 59, nextResetTime: now + 4 * 86400e3 + 23 * 3600e3 },
    ];
    const quota = { status: "ok" as const, balances: [], coding: { level: "max", rows }, errors: [], error: "", fetchedAt: now };
    const text = plainLines(baseState({ quota })).join("\n");
    // Horizon labels: 4.9h → 5 小时, 4d23h → 每周. The MCP row is dropped, so
    // the old positional scheme's "月度" and "剩 3,836 次" never appear.
    expect(text).toContain("5 小时");
    expect(text).toContain("每周");
    expect(text).not.toContain("月度");
    expect(text).not.toContain("TIME_LIMIT");
    expect(text).not.toContain("TOKENS_LIMIT");
    expect(text).not.toContain("3,836");
    expect(text).toContain("剩 99%"); // 1 − 1%
    expect(text).toContain("剩 41%"); // 1 − 59%
    const weeklyLine = plainLines(baseState({ quota })).find((l) => l.includes("每周")) ?? "";
    expect(weeklyLine).toContain("["); // bracketed progress bar renders
    expect(weeklyLine).toContain("█");
    expect(weeklyLine).toContain("41%");
    // 所有条形起点对齐同一列 —— 名称列按显示宽度补空格（"5 小时"6 格 vs "每周"4 格）
    const barCols = plainLines(baseState({ quota }))
      .filter((l) => l.includes("[") && (l.includes("█") || l.includes("░")))
      .map((l) => l.indexOf("["));
    expect(barCols.length).toBe(2);
    expect(new Set(barCols).size).toBe(1);
  });

  test("overdue window (clock skew / roll lag) still reads as the 5h window, not 周期", () => {
    const now = Date.now();
    // Live 2026-11-05 screenshot: a reset-boundary row (nextResetTime just past,
    // countdown "即将重置") was degraded to the generic "周期" label. The overdue
    // row is the 5h window whenever a live weekly row sits below it (28× roll
    // frequency), so negative horizon falls into the ≤6h band.
    const quota = {
      status: "ok" as const,
      balances: [],
      coding: {
        level: "max",
        rows: [
          { type: "TOKENS_LIMIT", percentage: 70, nextResetTime: now - 2 * 60e3 },
          { type: "TOKENS_LIMIT", percentage: 41, nextResetTime: now + 2 * 86400e3 + 10 * 3600e3 },
        ],
      },
      errors: [],
      error: "",
      fetchedAt: now,
    };
    const text = plainLines(baseState({ quota })).join("\n");
    expect(text).toContain("5 小时");
    expect(text).toContain("即将重置");
    expect(text).toContain("每周");
    expect(text).not.toContain("周期");
  });

  test("non-token unit types are surfaced, token stays invisible", () => {
    const balanceLine = (unitType?: string): string =>
      plainLines(baseState({
        quota: {
          status: "ok",
          balances: [{ showName: "GLM-5.3", remainingUnits: 1, totalUnits: 2, ...(unitType ? { unitType } : {}) }],
          coding: null,
          errors: [],
          error: "",
          fetchedAt: Date.now(),
        },
      })).find((l) => l.includes("GLM-5.3")) ?? "";
    expect(balanceLine("prompt")).toContain("· prompt");
    expect(balanceLine("token")).not.toContain("token");
    expect(balanceLine(undefined)).not.toContain("·");
  });

  test("quota card caps balance rows to keep the Logs card room", () => {
    const balances = Array.from({ length: 8 }, (_, i) => ({
      showName: `Model ${i}`,
      remainingUnits: i,
      totalUnits: 100,
    }));
    const text = plainLines(baseState({
      quota: { status: "ok", balances, coding: null, errors: [], error: "", fetchedAt: Date.now() },
    })).join("\n");
    expect(text).toContain("Model 3");
    expect(text).not.toContain("Model 4");
  });

  test("row cap spans both planes (balances first, coding after, overflow counted together)", () => {
    const balances = Array.from({ length: 3 }, (_, i) => ({ showName: `Model ${i}`, remainingUnits: i, totalUnits: 100 }));
    const codingRows = Array.from({ length: 3 }, (_, i) => ({ type: `LIMIT_${i}`, remaining: i }));
    const text = plainLines(baseState({
      quota: { status: "ok", balances, coding: { level: null, rows: codingRows }, errors: [], error: "", fetchedAt: Date.now() },
    })).join("\n");
    expect(text).toContain("Model 2");
    expect(text).toContain("LIMIT_0");
    expect(text).not.toContain("LIMIT_1");
    expect(text).toContain("+2 more");
  });

  test("quota card shows error state and upstream warnings", () => {
    const text = plainLines(baseState({
      quota: {
        status: "error",
        balances: [],
        coding: null,
        errors: [],
        error: "not logged in (run: zcode-proxy auth login)",
        fetchedAt: Date.now(),
      },
    })).join("\n");
    expect(text).toContain("unavailable");
    expect(text).toContain("not logged in");
    const warned = plainLines(baseState({
      quota: { status: "ok", balances: [], coding: null, errors: ["balance: 3012 risk"], error: "", fetchedAt: Date.now() },
    })).join("\n");
    expect(warned).toContain("⚠");
    expect(warned).toContain("3012");
  });

  test("both planes empty → explicit no-entries row (not the old balance-only copy)", () => {
    const text = plainLines(baseState({
      quota: { status: "ok", balances: [], coding: { level: null, rows: [] }, errors: [], error: "", fetchedAt: Date.now() },
    })).join("\n");
    expect(text).toContain("no quota entries reported by upstream");
  });

  test("quota Refresh button is clickable and footer advertises [r]", () => {
    const f = buildFrame(baseState({
      quota: { status: "ok", balances: [], coding: null, errors: [], error: "", fetchedAt: Date.now() },
    }));
    const actions = f.regions.map((r) => r.action);
    expect(actions).toContainEqual({ kind: "key", key: "r" });
    // The footer drops its tail on 80 columns (like [p]/[t]/[c]); [r] shows
    // only on wider terminals.
    const wide = buildFrame(baseState({
      width: 140,
      quota: { status: "ok", balances: [], coding: null, errors: [], error: "", fetchedAt: Date.now() },
    }));
    const lines = wide.text.split("\n").map((l) => stripAnsi(l.replace(/\x1b\[K$/, "")));
    expect(lines.join("\n")).toContain("[r] quota refresh");
  });

  test("quota card hides on short terminals so the Logs card keeps room", () => {
    const quota = { status: "ok" as const, balances: [{ showName: "GLM-5.3", remainingUnits: 1, totalUnits: 2 }], coding: null, errors: [], error: "", fetchedAt: Date.now() };
    const text = plainLines(baseState({ height: 21, quota })).join("\n");
    expect(text).not.toContain("Quota");
    const textTall = plainLines(baseState({ height: 22, quota })).join("\n");
    expect(textTall).toContain("Quota");
  });

  test("quota card never pushes the frame past the terminal height", () => {
    for (const height of [22, 24, 30, 40]) {
      const state = baseState({
        height,
        logTotal: 50,
        logView: Array.from({ length: 50 }, (_, i) => ({ level: "info", text: `log ${i}` })),
        quota: {
          status: "ok",
          balances: Array.from({ length: 6 }, (_, i) => ({ showName: `Model ${i}`, remainingUnits: i, totalUnits: 100 })),
          coding: { level: null, rows: Array.from({ length: 6 }, (_, i) => ({ type: `LIMIT_${i}`, remaining: i })) },
          errors: [],
          error: "",
          fetchedAt: Date.now(),
        },
      });
      expect(plainLines(state).length).toBe(height);
    }
  });

  test("no line exceeds the terminal width with a long quota showName", () => {
    const state = baseState({
      quota: {
        status: "ok",
        balances: [{ showName: "超长模型名称测试超长模型名称测试超长模型名称", remainingUnits: 1234567890, totalUnits: 9876543210, expiresAt: 1735689600 }],
        coding: { level: "an-unreasonably-long-tier-name-from-upstream", rows: [{ type: "超长窗口类型名称测试超长窗口类型名称测试", remaining: 1234567, nextResetTime: 1735689600 }] },
        errors: [],
        error: "",
        fetchedAt: Date.now(),
      },
    });
    for (const raw of buildFrame(state).text.split("\n")) {
      expect(displayWidth(raw)).toBeLessThanOrEqual(state.width);
    }
  });
});
