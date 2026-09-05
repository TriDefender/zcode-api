/**
 * Cross-platform default-browser launcher, shared by the CLI auth flows and
 * the TUI login action. Best-effort: a failure leaves the URL on screen for
 * the user to copy manually.
 */
import { spawn, type SpawnOptions } from "node:child_process";

export function openBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      spawnDetached("cmd.exe", ["/c", `start "" "${url}"`], {
        windowsHide: true, windowsVerbatimArguments: true,
      });
    } else if (process.platform === "darwin") {
      spawnDetached("open", [url]);
    } else {
      spawnDetached("xdg-open", [url]);
    }
  } catch { /* user copies URL manually */ }
}

/**
 * Spawn a fire-and-forget browser opener. Spawn failures surface
 * asynchronously on the child (ENOENT for xdg-open on headless boxes — there
 * is no browser to open), not as a synchronous throw, so an "error" listener
 * MUST be attached or the crash takes down the whole login process. Either
 * way the authorize URL is already on screen for manual copying.
 */
function spawnDetached(cmd: string, args: string[], extra: SpawnOptions = {}): void {
  const child = spawn(cmd, args, { detached: true, stdio: "ignore", ...extra });
  child.on("error", () => { /* headless — user copies URL manually */ });
  child.unref();
}
