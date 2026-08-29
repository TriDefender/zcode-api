/**
 * Cross-platform default-browser launcher, shared by the CLI auth flows and
 * the TUI login action. Best-effort: a failure leaves the URL on screen for
 * the user to copy manually.
 */
import { spawn } from "node:child_process";

export function openBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      spawn("cmd.exe", ["/c", `start "" "${url}"`], {
        detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true,
      }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch { /* user copies URL manually */ }
}
