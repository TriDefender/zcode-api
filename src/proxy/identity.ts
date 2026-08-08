/**
 * Identity header builder — emits the ZCode desktop client's companion headers
 * on every upstream request so the proxy is indistinguishable from the official
 * client at the fingerprinting layer.
 *
 * Mirrors `pio` (`buildProviderIdentityHeaders`) in the current ZCode bundle
 * (`_reverse/zcode.cjs` L43, refreshed 2026-08-07). Field-for-field,
 * order-for-order. The bundle's `pio` emits, in this exact sequence:
 *
 *   HTTP-Referer            EP(env)                          // refererOrigin
 *   User-Agent              `ZCode/${n ?? "unknown"}`
 *   X-ZCode-App-Version     n                                // ONLY when appVersion resolves (ASCII gate)
 *   X-Title                 `Z Code@${sourceTitle}`
 *   X-Platform              `${platform}-${arch}`            // when both resolve
 *   X-Release-Channel       c                                // when releaseChannel resolves
 *   X-Client-Language       lsa() = Intl locale              // when Intl resolves
 *   X-Client-Timezone       csa() = Intl timezone            // when Intl resolves
 *   X-Os-Category           Nno(platform)                    // when platform resolves
 *   X-Os-Version            u                                // when osVersion resolves
 *   X-Device-Mid            i                                // when deviceMid resolves
 *
 * We additionally send `X-ZCode-Agent: "glm"` (from the bundle's `Wna` helper,
 * L3265) between X-Title and X-Platform — it has been accepted upstream since
 * v2.0 and is kept for continuity.
 *
 * `n = fio(...)` validates appVersion against `/^[\x20-\x7e]+$/` (printable
 * ASCII). When no version resolves, `pio` drops `X-ZCode-App-Version` entirely
 * and falls back the User-Agent to `ZCode/unknown`. We replicate both
 * behaviours exactly. The same ASCII gate applies to every runtime header value.
 *
 * Runtime values are read via env overrides (matching the existing
 * ZCODE_IDENTITY_PLATFORM/ARCH/RELEASE pattern) so the Android entry can emit
 * desktop-Linux identity without changing this module:
 *   - ZCODE_IDENTITY_RELEASE_CHANNEL
 *   - ZCODE_IDENTITY_CLIENT_LANGUAGE   (default: Intl locale, e.g. "zh-CN")
 *   - ZCODE_IDENTITY_CLIENT_TIMEZONE   (default: Intl timezone, e.g. "Asia/Shanghai")
 *   - ZCODE_IDENTITY_DEVICE_MID        (no default; omitted unless set)
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

/** Mirrors the bundle's `lsa()` / `V8i()`: Intl locale, wrapped in try/catch. */
function resolveClientLanguage(): string | undefined {
  const override = normalizePrintableHeaderValue(process.env.ZCODE_IDENTITY_CLIENT_LANGUAGE);
  if (override) return override;
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || undefined;
  } catch {
    return undefined;
  }
}

/** Mirrors the bundle's `csa()`: Intl timezone, wrapped in try/catch. */
function resolveClientTimezone(): string | undefined {
  const override = normalizePrintableHeaderValue(process.env.ZCODE_IDENTITY_CLIENT_TIMEZONE);
  if (override) return override;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the identity and runtime platform headers injected upstream, in the
 * exact order and with the exact conditional semantics of the bundle's `pio`.
 * Pure function.
 *
 * Order (with X-ZCode-Agent kept between X-Title and X-Platform):
 *   HTTP-Referer, User-Agent, [X-ZCode-App-Version], X-Title, X-ZCode-Agent,
 *   [X-Platform], [X-Release-Channel], [X-Client-Language], [X-Client-Timezone],
 *   [X-Os-Category], [X-Os-Version], [X-Device-Mid]
 *
 * Returns `Record<string, string>` rather than a fixed interface because
 * several headers are conditionally omitted (matching `pio`).
 */
export function buildIdentityHeaders(id: ProxyIdentity): Record<string, string> {
  // Env overrides (ZCODE_IDENTITY_PLATFORM/ARCH/RELEASE) let the Android entry
  // emit desktop-Linux identity headers without changing this module.
  const n = resolveAppVersion(id.appVersion);
  const platform = normalizePrintableHeaderValue(process.env.ZCODE_IDENTITY_PLATFORM ?? process.platform);
  const arch = normalizePrintableHeaderValue(process.env.ZCODE_IDENTITY_ARCH ?? os.arch());
  const release = normalizePrintableHeaderValue(process.env.ZCODE_IDENTITY_RELEASE ?? os.release());
  const platformForCategory = (process.env.ZCODE_IDENTITY_PLATFORM ?? process.platform) as NodeJS.Platform;
  const releaseChannel = normalizePrintableHeaderValue(process.env.ZCODE_IDENTITY_RELEASE_CHANNEL);
  const clientLanguage = resolveClientLanguage();
  const clientTimezone = resolveClientTimezone();
  const deviceMid = normalizePrintableHeaderValue(process.env.ZCODE_IDENTITY_DEVICE_MID);

  const headers: Record<string, string> = {
    "HTTP-Referer": id.refererOrigin,
    "User-Agent": `ZCode/${n ?? "unknown"}`,
    ...(n ? { "X-ZCode-App-Version": n } : {}),
    "X-Title": `Z Code@${id.sourceTitle}`,
    "X-ZCode-Agent": "glm",
    ...(platform && arch ? { "X-Platform": `${platform}-${arch}` } : {}),
    ...(releaseChannel ? { "X-Release-Channel": releaseChannel } : {}),
    ...(clientLanguage ? { "X-Client-Language": clientLanguage } : {}),
    ...(clientTimezone ? { "X-Client-Timezone": clientTimezone } : {}),
    ...(platform ? { "X-Os-Category": normalizeOsCategory(platformForCategory) } : {}),
    ...(release ? { "X-Os-Version": release } : {}),
    ...(deviceMid ? { "X-Device-Mid": deviceMid } : {}),
  };
  return headers;
}
