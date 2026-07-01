/**
 * Identity header builder — emits the ZCode desktop client's companion headers
 * on every upstream request so the proxy is indistinguishable from the official
 * client at the fingerprinting layer.
 *
 * Mirrors `pio` in the current ZCode bundle (`_reverse/zcode.cjs`, the
 * `buildProviderIdentityHeaders` helper). Field-for-field, order-for-order:
 *
 *   {
 *     "HTTP-Referer":        EP(env)            // refererOrigin (prod default https://zcode.z.ai)
 *     "User-Agent":          `ZCode/${n ?? "unknown"}`
 *     "X-ZCode-App-Version": n                  // ONLY when a valid version resolves
 *     "X-Title":             `Z Code@${sourceTitle}`
 *     "X-ZCode-Agent":       "glm"
 *     "X-Platform":          `${process.platform}-${os.arch()}` // when printable
 *     "X-Os-Category":       "windows" | "macos" | "linux"
 *     "X-Os-Version":        os.release()        // when printable
 *   }
 *
 * where `n = fio(...)` is the resolved appVersion, validated against
 * `/^[\x20-\x7e]+$/` (printable ASCII). When no version resolves, `pio` drops
 * `X-ZCode-App-Version` entirely and falls back the User-Agent to
 * `ZCode/unknown`. We replicate both behaviours exactly.
 *
 * We read resolved values from `ProxyIdentity` (env/YAML already merged by the
 * config loader, which mirrors `fio`'s ASCII gate). `sourceTitle` maps to
 * `t.sourceTitle ?? hio()` in the bundle (`hio()` yields "electron" under the
 * Electron app-server argv, else "cli"); the loader default is "cli".
 *
 * @see _reverse/NOTEPAD.md "How Credential is Used for LLM Calls"
 */
import os from "node:os";
import type { ProxyIdentity } from "../config/types.js";

/** Printable-ASCII gate copied from the ZCode bundle's `fio` helper. */
const ASCII_PRINTABLE = /^[\x20-\x7e]+$/;

/** Resolve the appVersion the way `fio` does: trimmed + printable ASCII, else undefined. */
function resolveAppVersion(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim();
  return v.length > 0 && ASCII_PRINTABLE.test(v) ? v : undefined;
}

function normalizePrintableHeaderValue(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim();
  return v.length > 0 && ASCII_PRINTABLE.test(v) ? v : undefined;
}

function normalizeOsCategory(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}

function buildRuntimePlatformHeaders(): Record<string, string> {
  const platform = normalizePrintableHeaderValue(process.platform);
  const arch = normalizePrintableHeaderValue(os.arch());
  const release = normalizePrintableHeaderValue(os.release());
  return {
    ...(platform && arch ? { "X-Platform": `${platform}-${arch}` } : {}),
    "X-Os-Category": normalizeOsCategory(process.platform),
    ...(release ? { "X-Os-Version": release } : {}),
  };
}

/**
 * Build the identity and runtime platform headers injected upstream, in the
 * exact order and with the exact conditional semantics of the bundle's `pio`.
 * Pure function.
 *
 * Returns `Record<string, string>` rather than a fixed interface because
 * `X-ZCode-App-Version` is conditionally omitted (matching `pio`).
 */
export function buildIdentityHeaders(id: ProxyIdentity): Record<string, string> {
  const n = resolveAppVersion(id.appVersion);
  const headers: Record<string, string> = {
    "HTTP-Referer": id.refererOrigin,
    "User-Agent": `ZCode/${n ?? "unknown"}`,
    ...(n ? { "X-ZCode-App-Version": n } : {}),
    "X-Title": `Z Code@${id.sourceTitle}`,
    "X-ZCode-Agent": "glm",
    ...buildRuntimePlatformHeaders(),
  };
  return headers;
}
