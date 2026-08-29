/**
 * PC terminal UI (`zcode-proxy tui`) — an in-process control panel mirroring
 * the Android app's three-card layout: Settings & Login / Proxy Server / Logs.
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
import { EXAMPLE_CONFIG_YAML } from "../config/template.js";
import { updateConfigYaml } from "../config/edit.js";
import { AuthManager } from "../auth/manager.js";
import { startServer, type ProxyServer } from "../server/server.js";
import { buildServerOptions } from "../server/server-options.js";
import { loadCredential, saveCredential, clearCredential } from "../auth/store.js";
import { ZaiOAuthClient, BigmodelOAuthClient, type OAuthFlowClient } from "../auth/oauth.js";
import { KeyResolver } from "../auth/resolver.js";
import { openBrowser } from "../runtime/open-browser.js";
import { ensureDeviceMidInConfig, VERSION, type ServeArgs } from "../index.js";
import { writeFileSync, existsSync, appendFileSync } from "node:fs";
import type { ProxyConfig } from "../config/types.js";
import type { ProviderId } from "../provider/types.js";
import { LogPane } from "./log-pane.js";
import { KeyParser, type KeyAction } from "./keys.js";
import { buildFrame } from "./frame.js";

type PlanTier = "coding-plan" | "start-plan";
type ServerStatus = "stopped" | "starting" | "running" | "error";

const RENDER_MS = 33;
const PAGE_LINES = 10;
const TOAST_MS = 2600;

export async function runTui(args: ServeArgs): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    process.stderr.write("zcode-proxy: tui requires an interactive terminal (TTY).\n");
    process.exit(1);
  }

  const path = args.configPath ?? process.env.ZCODE_PROXY_CONFIG ?? "config.yaml";
  let config: ProxyConfig;
  try {
    if (!existsSync(path)) {
      writeFileSync(path, EXAMPLE_CONFIG_YAML, "utf-8");
      ensureDeviceMidInConfig(path);
      process.stderr.write(`Created ${path} from bundled template.\n`);
    }
    config = loadConfig(path);
  } catch (err) {
    process.stderr.write(`zcode-proxy: config error: ${(err as Error).message}\n`);
    process.exit(1);
  }

  let auth = newAuthManager(config);
  const pane = new LogPane(2000);
  const serverRef: { current: ProxyServer | null } = { current: null };

  const state = {
    provider: config.provider as ProviderId,
    plan: config.plan as PlanTier,
    loggedIn: false,
    apiKeyPreview: "",
    serverStatus: "stopped" as ServerStatus,
    serverUrl: "",
    serverError: "",
    loginInFlight: false,
    loginHint: "",
    toast: null as { text: string; kind: "ok" | "err" | "info" } | null,
  };

  // --- terminal setup ------------------------------------------------------
  const stdout = process.stdout;
  const stdin = process.stdin;
  stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J");

  const restore = (): void => {
    try { stdout.write("\x1b[0m\x1b[?25h\x1b[?1049l"); } catch { /* terminal gone */ }
  };

  // --- console interception → log pane (Android-entry pattern) ------------
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  const logFile = process.env.ZCODE_TUI_LOGFILE;
  const emit = (text: string, level: "info" | "warn" | "error"): void => {
    pane.push(text, level);
    if (logFile) {
      try { appendFileSync(logFile, text + "\n", "utf-8"); } catch { /* best-effort tee */ }
    }
    scheduleRender();
  };
  console.log = (...a: unknown[]) => emit(a.map(String).join(" "), "info");
  console.warn = (...a: unknown[]) => emit("[warn] " + a.map(String).join(" "), "warn");
  console.error = (...a: unknown[]) => emit("[error] " + a.map(String).join(" "), "error");

  // --- rendering -----------------------------------------------------------
  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  function renderNow(): void {
    renderTimer = null;
    const width = stdout.columns || 80;
    const height = stdout.rows || 24;
    const view = pane.view(Math.max(4, height - 14));
    const frame = buildFrame({
      version: VERSION,
      configPath: path,
      provider: state.provider,
      plan: state.plan,
      authMode: config.auth.mode,
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
      logTotal: view.total,
      logView: view.lines,
      logFollowing: pane.following,
      logFromBottom: view.fromBottom,
      toast: state.toast,
      width,
      height,
    });
    try { stdout.write("\x1b[H" + frame); } catch { /* terminal gone */ }
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

  // --- auth ----------------------------------------------------------------
  async function refreshAuth(): Promise<void> {
    const cred = await loadCredential().catch(() => null);
    state.loggedIn = cred != null;
    state.apiKeyPreview = cred ? `${cred.apiKey.slice(0, 8)}…` : "";
    scheduleRender();
  }

  // --- proxy lifecycle (mirrors the Android startProxy/stopProxy hooks) ----
  async function startProxy(): Promise<void> {
    if (state.serverStatus === "running" || state.serverStatus === "starting") return;
    state.serverStatus = "starting";
    state.serverError = "";
    scheduleRender();
    if (config.auth.mode === "oauth") {
      const cred = await loadCredential().catch(() => null);
      if (!cred) {
        state.serverStatus = "stopped";
        setToast("not logged in — press l to login", "err");
        return;
      }
      auth.setOAuthCredential(cred);
    }
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
    if (config.claim.enabled && config.claim.auto && config.auth.mode === "oauth") {
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
    if (!ensureProxyStoppedForConfigChange()) return;
    const next: ProviderId = state.provider === "zai" ? "bigmodel" : "zai";
    applyConfigChange(next, state.plan, `provider → ${next}`);
  }

  function switchPlan(): void {
    if (!ensureProxyStoppedForConfigChange()) return;
    const next: PlanTier = state.plan === "coding-plan" ? "start-plan" : "coding-plan";
    applyConfigChange(state.provider, next, `plan → ${next}`);
  }

  function ensureProxyStoppedForConfigChange(): boolean {
    if (state.serverStatus === "running" || state.serverStatus === "starting") {
      setToast("stop the proxy before switching (press s)", "err");
      return false;
    }
    return true;
  }

  function applyConfigChange(provider: ProviderId, plan: PlanTier, message: string): void {
    config.provider = provider;
    config.plan = plan;
    auth = newAuthManager(config);
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
  let activeOauth: { client: OAuthFlowClient; provider: ProviderId } | null = null;

  async function startLogin(): Promise<void> {
    if (config.auth.mode !== "oauth") {
      setToast("apikey mode — set auth.apiKey in config.yaml", "info");
      return;
    }
    if (state.loginInFlight) {
      setToast("login already in progress", "info");
      return;
    }
    const provider = state.provider;
    const client: OAuthFlowClient = provider === "bigmodel" ? new BigmodelOAuthClient() : new ZaiOAuthClient();
    let started: Awaited<ReturnType<OAuthFlowClient["start"]>>;
    try {
      started = await client.start();
    } catch (err) {
      void client.close().catch(() => {});
      setToast(`login failed: ${(err as Error).message}`, "err");
      return;
    }
    activeOauth = { client, provider };
    state.loginInFlight = true;
    state.loginHint = "waiting for browser authorization…";
    console.log(`OAuth: opening ${started.authorizeUrl}`);
    console.log("If the browser did not open, copy the URL above into a browser.");
    openBrowser(started.authorizeUrl);
    scheduleRender();

    client.complete(started).then(async (tokens) => {
      const resolver = new KeyResolver();
      const cred = await resolver.resolveCodingPlanCredential(tokens.accessToken, provider, tokens.userId);
      if (tokens.jwt) cred.jwt = tokens.jwt;
      await saveCredential(cred);
      if (serverRef.current && config.auth.mode === "oauth") auth.setOAuthCredential(cred);
      console.log(`OAuth completed for ${provider}`);
      setToast("logged in", "ok");
    }).catch((err: unknown) => {
      const msg = (err as Error)?.message ?? String(err);
      console.error(`OAuth flow ended without success: ${msg}`);
      setToast(`login failed: ${msg}`, "err");
    }).finally(() => {
      // MUST run on rejection too — otherwise the callback port leaks
      // (fixed Android bug 5746857, same discipline applies here).
      void client.close().catch(() => {});
      if (activeOauth?.client === client) activeOauth = null;
      state.loginInFlight = false;
      state.loginHint = "";
      void refreshAuth();
    });
  }

  async function logout(): Promise<void> {
    if (activeOauth) {
      void activeOauth.client.close().catch(() => {});
      activeOauth = null;
      state.loginInFlight = false;
      state.loginHint = "";
    }
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
  if (typeof (stdin as { setRawMode?: (m: boolean) => void }).setRawMode !== "function") {
    restore();
    origError("zcode-proxy: tui requires a terminal with raw-mode input.\n");
    process.exit(1);
  }
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
      case "char": {
        switch (action.key.toLowerCase()) {
          case "q": quit(); return;
          case "s": toggleProxy(); return;
          case "l": void startLogin(); return;
          case "o": void logout(); return;
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

  // --- teardown ---------------------------------------------------------------
  function quit(): void {
    cleanup();
    process.exit(0);
  }
  function cleanup(): void {
    restore();
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
    try { serverRef.current?.stop(false); } catch { /* already closed */ }
  }
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  process.on("exit", restore);
  stdout.on("resize", scheduleRender);
  process.on("uncaughtException", (err: Error) => {
    cleanup();
    origError(`zcode-proxy: tui crashed: ${err.stack ?? String(err)}`);
    process.exit(1);
  });

  // --- boot ---------------------------------------------------------------------
  console.log(`zcode-proxy TUI — config: ${path}`);
  console.log(`provider: ${state.provider} · plan: ${state.plan} · auth mode: ${config.auth.mode}`);
  await refreshAuth();
  renderNow();
  if (config.auth.mode === "oauth" && !state.loggedIn) {
    setToast("not logged in — press l to login", "err");
  } else {
    await startProxy();
  }
}

function newAuthManager(config: ProxyConfig): AuthManager {
  return new AuthManager({
    mode: config.auth.mode,
    provider: config.provider,
    apiKey: config.auth.apiKey ?? config.providers[config.provider].credential,
  });
}
