/**
 * PC terminal UI (zcode-proxy's default mode) — an in-process control panel
 * mirroring the Android app's three-card layout: Settings & Login / Proxy
 * Server / Logs.
 *
 * The TUI owns the terminal (alternate screen + raw mode) and, like the
 * Android entry, intercepts console.log/warn/error into a ring buffer so the
 * per-request log rows land in the Logs card. Zero new dependencies: the
 * renderer, input parser and width math are hand-rolled ANSI/VT (Bun- and
 * Node-compatible, bundles into both release artifacts).
 *
 * index.ts dispatches here via dynamic import (this module imports helpers
 * back from index.js), mirroring the claimCommand pattern.
 */
import { loadConfig } from "../config/loader.js";
import { updateConfigYaml, ensureConfigFile } from "../config/edit.js";
import { AuthManager } from "../auth/manager.js";
import { startServer, type ProxyServer } from "../server/server.js";
import { buildServerOptions } from "../server/server-options.js";
import { loadCredential, saveCredential, clearCredential } from "../auth/store.js";
import { type OAuthFlowTokens } from "../auth/oauth.js";
import { createPollLoginHost, startLoginServer, type LoginServerHandle } from "../server/login-handler.js";
import { KeyResolver } from "../auth/resolver.js";
import { openBrowser } from "../runtime/open-browser.js";
import { isGuestOriginError, describeGuestError } from "../runtime/guest-error.js";
import { ensureDeviceMidInConfig, VERSION, type ServeArgs } from "../index.js";
import { collectQuotaSnapshot, type QuotaSnapshot } from "../server/routes-quota.js";
import { appendFileSync } from "node:fs";
import type { ProxyConfig } from "../config/types.js";
import type { ConfigProviderId, ProviderId } from "../provider/types.js";
import { credentialFamily } from "../provider/providers.js";
import { LogPane, type LogLevel } from "./log-pane.js";
import { checkForUpdate, createUpdateCheckQueue } from "../update/check.js";
import { KeyParser, type KeyAction } from "./keys.js";
import { buildFrame, findRegion, type ClickAction, type ClickRegion, type Frame, type QuotaState } from "./frame.js";

type PlanTier = "coding-plan" | "start-plan";
type ServerStatus = "stopped" | "starting" | "running" | "error";

const RENDER_MS = 33;
const PAGE_LINES = 10;
const TOAST_MS = 2600;

export async function runTui(args: ServeArgs): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    process.stderr.write(
      "zcode-proxy: TUI mode needs an interactive terminal (TTY). " +
        "For headless/CLI use run: zcode-proxy --cli serve\n",
    );
    process.exit(1);
  }

  const path = args.configPath ?? process.env.ZCODE_PROXY_CONFIG ?? "config.yaml";
  let config: ProxyConfig;
  try {
    if (ensureConfigFile(path)) {
      ensureDeviceMidInConfig(path);
      process.stderr.write(`Created ${path} from bundled template.\n`);
    }
    config = loadConfig(path);
  } catch (err) {
    process.stderr.write(`zcode-proxy: config error: ${(err as Error).message}\n`);
    process.exit(1);
  }

  const auth = new AuthManager();
  const pane = new LogPane(2000);
  const serverRef: { current: ProxyServer | null } = { current: null };

  const state = {
    // Config-surface provider (zai|bigmodel) — the login-page flow picks the
    // login flavor independently; `p` keeps cycling the config surface only.
    provider: config.provider,
    plan: config.plan as PlanTier,
    loggedIn: false,
    apiKeyPreview: "",
    serverStatus: "stopped" as ServerStatus,
    serverUrl: "",
    serverError: "",
    loginInFlight: false,
    loginHint: "",
    quota: null as QuotaState | null,
    toast: null as { text: string; kind: "ok" | "err" | "info" } | null,
  };

  // --- terminal setup ------------------------------------------------------
  const stdout = process.stdout;
  const stdin = process.stdin;
  // Captured before any interception: the TUI's own frame/setup writes and
  // the post-cleanup error path must always reach the real terminal, even
  // after process.stdout/stderr.write are rerouted into the log pane below.
  const realStdoutWrite = stdout.write.bind(stdout) as (...a: unknown[]) => boolean;
  const realStderrWrite = process.stderr.write.bind(process.stderr) as (...a: unknown[]) => boolean;
  // Raw-mode availability check BEFORE any terminal state is touched: the
  // failure message must reach the real terminal, not the (not yet visible)
  // log pane, and nothing needs restoring if we never entered the alt screen.
  if (typeof (stdin as { setRawMode?: (m: boolean) => void }).setRawMode !== "function") {
    realStderrWrite("zcode-proxy: tui requires a terminal with raw-mode input.\n");
    process.exit(1);
  }
  // Alt screen + hide cursor + SGR mouse tracking (buttons clickable, wheel scrolls).
  const enterAltScreen = (): void => {
    realStdoutWrite("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[2J");
  };
  enterAltScreen();

  const restore = (): void => {
    try { realStdoutWrite("\x1b[0m\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l"); } catch { /* terminal gone */ }
  };

  // --- console interception → log pane (Android-entry pattern) ------------
  // ALL console methods are intercepted, not just log/warn/error: guest
  // scripts (the captcha SDK) probe the full console surface, and anything
  // left unpatched would bypass the pane and write raw into the alt-screen
  // frame. Originals are kept for the pre-TUI error path and restore.
  const origConsole: Record<string, (...a: unknown[]) => void> = {};
  const origError = console.error;
  const logFile = process.env.ZCODE_TUI_LOGFILE;
  const emit = (text: string, level: "info" | "warn" | "error"): void => {
    pane.push(text, level);
    if (logFile) {
      try { appendFileSync(logFile, text + "\n", "utf-8"); } catch { /* best-effort tee */ }
    }
    scheduleRender();
  };
  const consoleOwner = console as unknown as Record<string, unknown>;
  for (const key of Object.keys(console)) {
    const fn = consoleOwner[key];
    if (typeof fn !== "function") continue;
    origConsole[key] = fn as (...a: unknown[]) => void;
    consoleOwner[key] = (...a: unknown[]) => {
      const level = key === "error" ? "error" : key === "warn" ? "warn" : "info";
      const prefix = key === "error" ? "[error] " : key === "warn" ? "[warn] " : "";
      emit(prefix + a.map(String).join(" "), level);
    };
  }
  const restoreConsole = (): void => {
    for (const [key, fn] of Object.entries(origConsole)) consoleOwner[key] = fn;
  };
  const restoreStdio = (): void => {
    process.stdout.write = realStdoutWrite as typeof process.stdout.write;
    process.stderr.write = realStderrWrite as typeof process.stderr.write;
  };

  // Reroute raw process.stdout/stderr writers into the log pane. The codebase
  // has ~30 direct `process.stderr.write` call sites (captcha diagnostics,
  // runtime notices) that bypass the console interception above — on the alt
  // screen their text + newlines land mid-frame, garbling the rendered UI and
  // the click regions with it. The TUI's own writes go through the captured
  // originals, never through these overrides.
  const routeToPane =
    (level: LogLevel) =>
    (chunk: unknown, encOrCb?: unknown, maybeCb?: unknown): boolean => {
      const text =
        typeof chunk === "string"
          ? chunk
          : Buffer.isBuffer(chunk)
            ? chunk.toString("utf8")
            : chunk instanceof Uint8Array
              ? new TextDecoder().decode(chunk)
              : String(chunk);
      try { emit(text, level); } catch { /* pane failure must not break the writer */ }
      const cb = typeof encOrCb === "function" ? encOrCb : typeof maybeCb === "function" ? maybeCb : undefined;
      if (cb) (cb as () => void)();
      return true;
    };
  process.stdout.write = routeToPane("info") as typeof process.stdout.write;
  process.stderr.write = routeToPane("warn") as typeof process.stderr.write;

  // --- rendering -----------------------------------------------------------
  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  let lastRenderAt = 0;
  let activeRegions: ClickRegion[] = [];
  function renderNow(): void {
    if (renderTimer) clearTimeout(renderTimer); // watchdog may fire mid-cycle
    renderTimer = null;
    lastRenderAt = Date.now();
    let frame: Frame;
    try {
      const width = stdout.columns || 80;
      const height = stdout.rows || 24;
      const view = pane.view(Math.max(4, height - 14));
      frame = buildFrame({
        version: VERSION,
        configPath: path,
        provider: state.provider,
        plan: state.plan,
        loggedIn: state.loggedIn,
        apiKeyPreview: state.apiKeyPreview,
        loginInFlight: state.loginInFlight,
        loginHint: state.loginHint,
        serverStatus: state.serverStatus,
        serverUrl: state.serverUrl,
        serverError: state.serverError,
        modelCount: config.models.length,
        responsesEnabled: config.responses.enabled,
        claimAuto: config.claim.enabled && config.claim.auto,
        quota: state.quota,
        logTotal: view.total,
        logView: view.lines,
        logFollowing: pane.following,
        logFromBottom: view.fromBottom,
        toast: state.toast,
        width,
        height,
      });
    } catch (err) {
      // A broken frame must never escape: through the uncaughtException
      // handler it would tear down the whole TUI. Record it WITHOUT
      // rescheduling (pane.push, not emit) — emit's scheduleRender would turn
      // a deterministic buildFrame failure into a ~30 Hz render-error loop.
      // The watchdog retries at its own 2-4s cadence instead.
      try { pane.push(`frame render failed: ${(err as Error).message}`, "error"); } catch { /* ignore */ }
      return;
    }
    activeRegions = frame.regions;
    try { realStdoutWrite("\x1b[H" + frame.text); } catch { /* terminal gone */ }
  }
  function scheduleRender(): void {
    if (renderTimer) return;
    renderTimer = setTimeout(renderNow, RENDER_MS);
    if (typeof renderTimer.unref === "function") renderTimer.unref();
  }
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  function setToast(text: string, kind: "ok" | "err" | "info"): void {
    state.toast = { text, kind };
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      state.toast = null;
      toastTimer = null;
      scheduleRender();
    }, TOAST_MS);
    if (typeof toastTimer.unref === "function") toastTimer.unref();
    scheduleRender();
  }

  // --- update notice (issue #60) -------------------------------------------
  // Same check the Android app runs at startup: silent on every failure, and
  // the result lands in the Logs card (the panel surfaces it through the log
  // tee for free). `u` re-runs it manually — an explicit request overrides
  // ZCODE_UPDATE_CHECK=off and the muted-tag list, and always answers visibly.
  // The queue keeps a press made while the startup check is still in flight
  // instead of dropping it: that check's result may be up-to-date, skipped or
  // unavailable, none of which is an answer to an explicit request.
  const runUpdateCheck = createUpdateCheckQueue(async (manual) => {
    const result = await checkForUpdate(VERSION, { force: manual });
    if (result.kind === "update") {
      emit(`update: ${result.notice.text}`, "info");
      if (manual) setToast(`update available: ${result.notice.latest}`, "info");
      return;
    }
    if (!manual) return;
    if (result.kind === "up-to-date") setToast(`already on the latest version (v${VERSION})`, "ok");
    else if (result.kind === "skipped") setToast(`v${VERSION} is muted via ZCODE_UPDATE_SKIP`, "info");
    else setToast("update check unavailable (offline, or GitHub blocked)", "err");
  });

  // --- auth ----------------------------------------------------------------
  async function refreshAuth(): Promise<void> {
    const cred = await loadCredential().catch(() => null);
    state.loggedIn = cred != null;
    state.apiKeyPreview = cred ? `${cred.apiKey.slice(0, 8)}…` : "";
    // Logout hides the quota card (the billing calls need the JWT).
    if (!state.loggedIn) state.quota = null;
    else if (!state.quota) void refreshQuota();
    scheduleRender();
  }

  // --- quota (billing balance windows; manual refresh only — the billing
  // gateway rate-limits frequent queries, so no polling timer) ---------------
  let quotaFetchInFlight = false;
  async function refreshQuota(): Promise<void> {
    if (quotaFetchInFlight) return;
    quotaFetchInFlight = true;
    const firstFetch = state.quota == null;
    state.quota = { status: "loading", balances: [], coding: null, errors: [], error: "", fetchedAt: Date.now() };
    scheduleRender();
    try {
      const snap: QuotaSnapshot = await collectQuotaSnapshot(config);
      state.quota = {
        status: "ok",
        balances: snap.balances.map((b) => ({
          showName: b.showName,
          remainingUnits: b.remainingUnits,
          totalUnits: b.totalUnits,
          ...(b.expiresAt !== undefined ? { expiresAt: b.expiresAt } : {}),
          ...(b.unitType !== undefined ? { unitType: b.unitType } : {}),
        })),
        coding: snap.codingPlan
          ? {
              level: snap.codingPlan.level,
              rows: snap.codingPlan.limits.map((l) => ({
                type: l.type,
                ...(l.remaining !== undefined ? { remaining: l.remaining } : {}),
                ...(l.percentage !== undefined ? { percentage: l.percentage } : {}),
                ...(l.unit !== undefined ? { unit: l.unit } : {}),
                ...(l.nextResetTime !== undefined ? { nextResetTime: l.nextResetTime } : {}),
              })),
            }
          : null,
        errors: snap.errors,
        error: "",
        fetchedAt: Date.now(),
      };
    } catch (err) {
      // Replace the card content with the error — stale balances shown next to
      // a failure would read as current numbers.
      state.quota = {
        status: "error",
        balances: [],
        coding: null,
        errors: [],
        error: (err as Error).message,
        fetchedAt: Date.now(),
      };
      if (!firstFetch) setToast(`quota refresh failed: ${(err as Error).message}`, "err");
    } finally {
      quotaFetchInFlight = false;
      scheduleRender();
    }
  }

  // --- proxy lifecycle (mirrors the Android startProxy/stopProxy hooks) ----
  async function startProxy(): Promise<void> {
    if (state.serverStatus === "running" || state.serverStatus === "starting") return;
    state.serverStatus = "starting";
    state.serverError = "";
    scheduleRender();
    const cred = await loadCredential().catch(() => null);
    if (!cred) {
      state.serverStatus = "stopped";
      setToast("not logged in — press l to login", "err");
      return;
    }
    auth.setOAuthCredential(cred);
    try {
      const s = await startServer(buildServerOptions(config, auth, args.debug));
      serverRef.current = s;
      state.serverStatus = "running";
      state.serverUrl = `http://${s.hostname}:${s.port}`;
      setToast(`proxy started on ${state.serverUrl}`, "ok");
      startBackgroundJobsOnce();
    } catch (err) {
      state.serverStatus = "error";
      state.serverError = (err as Error).message;
      setToast(`start failed: ${(err as Error).message}`, "err");
    }
  }

  function stopProxy(): void {
    const s = serverRef.current;
    if (!s) return;
    try {
      s.stop(false); // NOT stop(true) — must not kill the process (anti-pattern #19)
    } catch (err) {
      setToast(`stop failed: ${(err as Error).message}`, "err");
      return;
    }
    serverRef.current = null;
    state.serverStatus = "stopped";
    state.serverUrl = "";
    setToast("proxy stopped", "info");
  }

  function toggleProxy(): void {
    if (state.serverStatus === "running" || state.serverStatus === "starting") stopProxy();
    else void startProxy();
  }

  // Captcha warmup + claim scheduler start once per process, even across
  // proxy stop/start cycles — the pools and scheduler are process-global.
  let backgroundJobsStarted = false;
  function startBackgroundJobsOnce(): void {
    if (backgroundJobsStarted) return;
    backgroundJobsStarted = true;
    if (config.plan === "start-plan") {
      import("../proxy/captcha.js")
        .then((m) => m.startCaptchaPool(config.identity.appVersion))
        .catch((err) => console.error(`[captcha] pool warmup failed: ${(err as Error).message}`));
    }
    if (config.claim.enabled && config.claim.auto) {
      import("../claim/runtime.js")
        .then((m) => {
          m.startAutoClaim(config, auth);
          console.log(`[claim] auto ON (poll ${Math.round(config.claim.pollIntervalMs / 1000)}s)`);
        })
        .catch((err) => console.error(`[claim] scheduler failed to start: ${(err as Error).message}`));
    }
  }

  // --- provider / plan switching (mirrors the Android setConfig command) ---
  function switchProvider(): void {
    const next: ProviderId = state.provider === "zai" ? "bigmodel" : "zai";
    applyConfigChange(next, state.plan, `provider → ${next}`);
  }

  function switchPlan(): void {
    const next: PlanTier = state.plan === "coding-plan" ? "start-plan" : "coding-plan";
    applyConfigChange(state.provider, next, `plan → ${next}`);
  }

  function applyConfigChange(provider: ConfigProviderId, plan: PlanTier, message: string): void {
    if (state.serverStatus === "running" || state.serverStatus === "starting") {
      setToast("stop the proxy before switching (press s)", "err");
      return;
    }
    config.provider = provider;
    config.plan = plan;
    try {
      updateConfigYaml(path, { provider, plan });
      state.provider = provider;
      state.plan = plan;
      setToast(message, "ok");
      console.log(`config updated: provider=${provider} plan=${plan}`);
    } catch (err) {
      setToast(`config update failed: ${(err as Error).message}`, "err");
    }
    scheduleRender();
  }

  // --- login / logout (mirrors the control-listener startOAuth/logout) -----
  /** Page-driven login session (`l` key): temp loopback listener + flow host. */
  let activeLogin: {
    host: ReturnType<typeof createPollLoginHost>;
    server: LoginServerHandle;
    closeTimer: ReturnType<typeof setTimeout> | null;
  } | null = null;

  function closeActiveLogin(): void {
    if (!activeLogin) return;
    if (activeLogin.closeTimer !== null) clearTimeout(activeLogin.closeTimer);
    void activeLogin.host.close().catch(() => {});
    void activeLogin.server.close().catch(() => {});
    activeLogin = null;
    // The page-flow host never fires onDone after close() (its completion
    // guard sees `active === null`), so the in-flight state MUST be reset
    // here — otherwise logout/teardown mid-flow leaves `l` permanently
    // reporting "login already in progress" (review 2026-11-14 P1).
    state.loginInFlight = false;
    state.loginHint = "";
  }

  function scheduleLoginServerClose(graceMs: number): void {
    if (!activeLogin) return;
    if (activeLogin.closeTimer !== null) clearTimeout(activeLogin.closeTimer);
    const handle = activeLogin;
    const timer = setTimeout(() => {
      if (activeLogin === handle) closeActiveLogin();
    }, graceMs);
    if (typeof timer.unref === "function") timer.unref();
    handle.closeTimer = timer;
  }

  // credentialFamily (zai_cn → bigmodel fold) comes from provider/providers.js.

  async function startLogin(): Promise<void> {
    // Stop-first guard (logout/switching discipline): a login completing
    // mid-run hot-swaps the credential into the LIVE proxy (finalizeLogin),
    // silently switching the account serving traffic.
    if (state.serverStatus === "running" || state.serverStatus === "starting") {
      setToast("stop the proxy before logging in (press s)", "err");
      return;
    }
    if (state.loginInFlight) {
      setToast("login already in progress", "info");
      return;
    }
    if (activeLogin) {
      // Grace-period leftover of a finished page flow — drop it before restarting.
      closeActiveLogin();
    }

    // Poll login (zai / zai_cn) runs through the /login selection page: a
    // temporary loopback listener hosts the provider picker, the browser jumps
    // to the server-issued authorize URL (zai → chat.z.ai, zai_cn → zchat.z.ai
    // directly), and the flow completes server-side while the page polls
    // status — no local callback involved.
    const loginHost = createPollLoginHost({
      onTokens: (flavor, tokens) => finalizeLogin(flavor, tokens),
      onDone: (_flavor, error) => {
        if (error !== null) console.error(`OAuth flow ended without success: ${error}`);
        state.loginInFlight = false;
        state.loginHint = "";
        if (error !== null) setToast(`login failed: ${error}`, "err");
        void refreshAuth();
        // Keep the listener up briefly so the page can render the terminal
        // status before it dies (the page polls at 2s; failures get longer
        // to be read).
        scheduleLoginServerClose(error !== null ? 15_000 : 5_000);
      },
    });
    // Reserve the in-flight slot BEFORE the listener resolves — two `l` events
    // landing inside the listen window would otherwise both pass the guard
    // above and orphan the first listener (review 2026-11-14 P2).
    state.loginInFlight = true;
    let server: LoginServerHandle;
    try {
      server = await startLoginServer(loginHost);
    } catch (err) {
      void loginHost.close().catch(() => {});
      state.loginInFlight = false;
      setToast(`login page failed to start: ${(err as Error).message}`, "err");
      return;
    }
    activeLogin = { host: loginHost, server, closeTimer: null };
    state.loginHint = `pick a site at ${server.url}`;
    console.log(`Login page: ${server.url}`);
    console.log("Pick 国际版 / 中国版 in the browser — the flow completes here automatically.");
    openBrowser(server.url);
    scheduleRender();
  }

  /**
   * Resolve the API key, persist the credential, sync the config surface to
   * the credential's family, and hot-swap into a running proxy. The /login
   * page flow's completion tail.
   */
  async function finalizeLogin(provider: ProviderId, tokens: OAuthFlowTokens): Promise<void> {
    const resolver = new KeyResolver();
    const cred = await resolver.resolveCodingPlanCredential(tokens.accessToken, provider, tokens.userId, tokens.linkedBigModel);
    if (tokens.jwt) cred.jwt = tokens.jwt;
    await saveCredential(cred);
    if (serverRef.current) auth.setOAuthCredential(cred);
    // Family sync: a credential whose family differs from the config surface
    // (e.g. zai_cn while provider=bigmodel) would silently serve traffic
    // through the wrong upstream endpoints. The stop-first guard means the
    // proxy is stopped during login, so the yaml write is safe.
    const family = credentialFamily(provider);
    if (config.provider !== family) {
      config.provider = family;
      state.provider = family;
      try {
        updateConfigYaml(path, { provider: family, plan: state.plan });
        console.log(`config synced: provider=${family} (matches credential family)`);
      } catch (err) {
        console.error(`config sync failed: ${(err as Error).message}`);
      }
    }
    console.log(`OAuth completed for ${provider}`);
    setToast("logged in", "ok");
  }

  async function logout(): Promise<void> {
    // Stop-first guard: the running proxy keeps serving with its in-memory
    // credential until restarted, so logging out mid-run would only look applied.
    if (state.serverStatus === "running" || state.serverStatus === "starting") {
      setToast("stop the proxy before logging out (press s)", "err");
      return;
    }
    closeActiveLogin();
    try {
      clearCredential();
    } catch { /* best-effort logout */ }
    await refreshAuth();
    if (serverRef.current) setToast("logged out — restart the proxy to apply", "info");
    else setToast("logged out", "ok");
  }

  // --- input loop ------------------------------------------------------------
  const parser = new KeyParser();
  stdin.setEncoding("utf8");
  (stdin as { setRawMode(m: boolean): void }).setRawMode(true);
  stdin.resume();
  stdin.on("data", (chunk: string) => {
    for (const action of parser.feed(chunk)) handleKey(action);
  });

  function scrollUp(n: number): void {
    pane.scrollUp(n);
    scheduleRender();
  }
  function scrollDown(n: number): void {
    pane.scrollDown(n);
    scheduleRender();
  }

  function handleKey(action: KeyAction): void {
    switch (action.type) {
      case "ctrl-c":
        quit();
        return;
      case "click": {
        const hit = findRegion(activeRegions, action.y, action.x);
        if (hit) dispatchClick(hit);
        return;
      }
      case "wheel-up":
        scrollUp(3);
        return;
      case "wheel-down":
        scrollDown(3);
        return;
      case "char": {
        switch (action.key.toLowerCase()) {
          case "q": quit(); return;
          case "s": toggleProxy(); return;
          case "l": void startLogin(); return;
          case "o": void logout(); return;
          case "r": void refreshQuota(); return;
          case "u": void runUpdateCheck(true); return;
          case "p": switchProvider(); return;
          case "t": switchPlan(); return;
          case "c": pane.clear(); scheduleRender(); return;
          case "g": pane.followBottom(); scheduleRender(); return;
          case "k": scrollUp(1); return;
          case "j": scrollDown(1); return;
          default: return;
        }
      }
      case "up": scrollUp(1); return;
      case "down": scrollDown(1); return;
      case "pageup": scrollUp(PAGE_LINES); return;
      case "pagedown": scrollDown(PAGE_LINES); return;
      case "home": scrollUp(pane.count); return;
      case "end": pane.followBottom(); scheduleRender(); return;
      default: return;
    }
  }

  /** Mouse clicks hit the same actions as their keyboard shortcuts. */
  function dispatchClick(action: ClickAction): void {
    switch (action.kind) {
      case "key":
        handleKey({ type: "char", key: action.key });
        return;
      case "provider":
        applyConfigChange(action.value, state.plan, `provider → ${action.value}`);
        return;
      case "plan":
        applyConfigChange(state.provider, action.value, `plan → ${action.value}`);
        return;
      case "follow":
        pane.followBottom();
        scheduleRender();
        return;
    }
  }

  // --- teardown ---------------------------------------------------------------
  function quit(): void {
    cleanup();
    process.exit(0);
  }
  function cleanup(): void {
    restore();
    restoreConsole();
    restoreStdio();
    try { serverRef.current?.stop(false); } catch { /* already closed */ }
    closeActiveLogin();
  }
  // Render watchdog: if the 33ms render chain ever dies (stuck timer id,
  // swallowed exception in a runtime with different uncaught semantics), the
  // screen would freeze while the proxy keeps serving. The watchdog re-renders
  // whenever nothing has painted for 3s and un-pauses a stalled stdin, so the
  // worst-case freeze is bounded. Fires fine unref'd (timers only keep the
  // process alive when everything else is gone; the server handle already does).
  const watchdog = setInterval(() => {
    try { if (stdin.isPaused()) stdin.resume(); } catch { /* stdin gone */ }
    if (Date.now() - lastRenderAt > 3000) renderNow();
  }, 2000);
  if (typeof watchdog.unref === "function") watchdog.unref();
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  process.on("exit", restore);
  stdout.on("resize", scheduleRender);
  // Guest captcha-SDK errors must NOT kill the TUI. Under Bun the Aliyun/
  // FeiLin bundles run in the HOST realm, so an error escaping one of their
  // stray callbacks arrives here exactly like an internal fault. `serve` mode
  // already logs-and-continues (captcha-happy.ts); the TUI used to exit(1) for
  // everything, turning a retryable solve failure into a dead proxy (field
  // report: "tui crashed: ReferenceError: moveBy is not defined" from
  // feilin008.js). The pool retries the solve; the proxy keeps serving.
  process.on("uncaughtException", (err: Error) => {
    if (isGuestOriginError(err)) {
      emit(`[warn] captcha SDK error (ignored): ${describeGuestError(err)}`, "warn");
      return;
    }
    cleanup();
    origError(`zcode-proxy: tui crashed: ${err.stack ?? String(err)}`);
    process.exit(1);
  });

  // --- boot ---------------------------------------------------------------------
  console.log(`zcode-proxy TUI — config: ${path}`);
  console.log(`provider: ${state.provider} · plan: ${state.plan}`);
  void runUpdateCheck();
  await refreshAuth();
  renderNow();
  if (!state.loggedIn) {
    setToast("not logged in — press l to login", "err");
  } else {
    await startProxy();
  }
}
