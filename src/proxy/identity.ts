/**
 * Identity header builders — emit the ZCode desktop client's companion
 * headers so the proxy is indistinguishable from the official client at the
 * fingerprinting layer.
 *
 * TWO distinct bundle functions are mirrored (ZCode 3.11.2, `_reverse/zcode.cjs`):
 *
 *   1. `csn` = buildCliZCodeSourceHeaders (CLI LLM path, wrapped by `x4i`
 *      which appends `X-ZCode-Agent: "glm"` as the LAST header) — used for
 *      every LLM completion request → {@link buildLlmIdentityHeaders}.
 *      Shape: HTTP-Referer, User-Agent, [X-ZCode-App-Version], X-Title,
 *      X-Release-Channel (always), X-Client-Language (always, "unknown"
 *      fallback), X-Client-Timezone (always, "unknown" fallback),
 *      [X-Platform], X-Os-Category (when platform resolves), [X-Os-Version],
 *      X-ZCode-Agent ("glm", last). NO X-Device-Mid — the CLI LLM path never
 *      carried it.
 *
 *   2. `HRt` = buildZCodeSourceHeadersFromContext (host-side control-plane
 *      fetches: endpoint-routing configs, signing gate, claim/billing) —
 *      used by {@link buildIdentityHeaders}. Shape keeps the historical
 *      `pio`-derived order with conditional language/timezone and the
 *      optional X-Device-Mid (server-required on the claim/billing plane
 *      since the 0828 campaign). Consumers: endpoint-routing.ts,
 *      client-signing.ts, claim/client.ts, routes-quota.ts, async bridge.
 *
 * Both gate header values through the bundle's `fio` printable-ASCII rule;
 * `n = fio(...)` validates appVersion and, when it fails, drops
 * X-ZCode-App-Version entirely and falls the User-Agent back to
 * `ZCode/unknown`.
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

/** Normalize a header value: trimmed + printable ASCII, else undefined. */
export function normalizePrintableHeaderValue(raw: string | undefined): string | undefined {
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

interface ResolvedIdentityValues {
  n?: string;
  platform?: string;
  platformForCategory: NodeJS.Platform;
  arch?: string;
  release?: string;
  releaseChannel: string;
  clientLanguage?: string;
  clientTimezone?: string;
  deviceMid?: string;
}

/** Shared env/config resolution for both builders (values only — ordering differs per builder). */
function resolveIdentityValues(id: ProxyIdentity): ResolvedIdentityValues {
  // Env overrides (ZCODE_IDENTITY_PLATFORM/ARCH/RELEASE) let the Android entry
  // emit desktop-Linux identity headers without changing this module.
  return {
    n: resolveAppVersion(id.appVersion),
    platform: normalizePrintableHeaderValue(process.env.ZCODE_IDENTITY_PLATFORM ?? process.platform),
    platformForCategory: (process.env.ZCODE_IDENTITY_PLATFORM ?? process.platform) as NodeJS.Platform,
    arch: normalizePrintableHeaderValue(process.env.ZCODE_IDENTITY_ARCH ?? os.arch()),
    release: normalizePrintableHeaderValue(process.env.ZCODE_IDENTITY_RELEASE ?? os.release()),
    // bundle IL(): ZCODE_ENV==="test" ? "test" : "production" — always resolves.
    // Mirror that default; ZCODE_IDENTITY_RELEASE_CHANNEL stays an explicit override.
    releaseChannel: normalizePrintableHeaderValue(process.env.ZCODE_IDENTITY_RELEASE_CHANNEL)
      ?? (process.env.ZCODE_ENV?.trim().toLowerCase() === "test" ? "test" : "production"),
    clientLanguage: resolveClientLanguage(),
    clientTimezone: resolveClientTimezone(),
    // env (Android NodeRunner injection) wins over the config.yaml value (desktop
    // persistence) — both are UUIDv4 generated once and reused forever.
    deviceMid: normalizePrintableHeaderValue(process.env.ZCODE_IDENTITY_DEVICE_MID)
      ?? normalizePrintableHeaderValue(id.deviceMid),
  };
}

/**
 * Identity headers for LLM completion requests — mirrors the bundle's CLI
 * source-headers builder `csn` (buildCliZCodeSourceHeaders) + the `x4i`
 * wrapper that appends `X-ZCode-Agent: "glm"` LAST. Differences vs the
 * control-plane set (buildIdentityHeaders): language/timezone are ALWAYS
 * emitted (falling back to "unknown"), X-Release-Channel sits right after
 * X-Title, X-ZCode-Agent is the final header, and X-Device-Mid is NEVER sent.
 * Pure function.
 */
export function buildLlmIdentityHeaders(id: ProxyIdentity): Record<string, string> {
  const v = resolveIdentityValues(id);
  return {
    "HTTP-Referer": id.refererOrigin,
    "User-Agent": `ZCode/${v.n ?? "unknown"}`,
    ...(v.n ? { "X-ZCode-App-Version": v.n } : {}),
    "X-Title": `Z Code@${id.sourceTitle}`,
    "X-Release-Channel": v.releaseChannel,
    "X-Client-Language": v.clientLanguage ?? "unknown",
    "X-Client-Timezone": v.clientTimezone ?? "unknown",
    ...(v.platform && v.arch ? { "X-Platform": `${v.platform}-${v.arch}` } : {}),
    ...(v.platform ? { "X-Os-Category": normalizeOsCategory(v.platformForCategory) } : {}),
    ...(v.release ? { "X-Os-Version": v.release } : {}),
    "X-ZCode-Agent": "glm",
  };
}

/**
 * Control-plane identity headers — mirrors the host-side bundle builder
 * `HRt` (buildZCodeSourceHeadersFromContext), reached us via the historical
 * `pio` shape. Used by endpoint-routing, client-signing gate, claim/billing
 * and the async bridge — NOT for LLM completion requests (use
 * {@link buildLlmIdentityHeaders} there).
 *
 * Order (with X-ZCode-Agent kept between X-Title and X-Platform):
 *   HTTP-Referer, User-Agent, [X-ZCode-App-Version], X-Title, X-ZCode-Agent,
 *   [X-Platform], [X-Release-Channel], [X-Client-Language], [X-Client-Timezone],
 *   [X-Os-Category], [X-Os-Version], [X-Device-Mid]
 *
 * Returns `Record<string, string>` rather than a fixed interface because
 * several headers are conditionally omitted.
 */
export function buildIdentityHeaders(id: ProxyIdentity): Record<string, string> {
  const v = resolveIdentityValues(id);
  return {
    "HTTP-Referer": id.refererOrigin,
    "User-Agent": `ZCode/${v.n ?? "unknown"}`,
    ...(v.n ? { "X-ZCode-App-Version": v.n } : {}),
    "X-Title": `Z Code@${id.sourceTitle}`,
    "X-ZCode-Agent": "glm",
    ...(v.platform && v.arch ? { "X-Platform": `${v.platform}-${v.arch}` } : {}),
    ...(v.releaseChannel ? { "X-Release-Channel": v.releaseChannel } : {}),
    ...(v.clientLanguage ? { "X-Client-Language": v.clientLanguage } : {}),
    ...(v.clientTimezone ? { "X-Client-Timezone": v.clientTimezone } : {}),
    ...(v.platform ? { "X-Os-Category": normalizeOsCategory(v.platformForCategory) } : {}),
    ...(v.release ? { "X-Os-Version": v.release } : {}),
    ...(v.deviceMid ? { "X-Device-Mid": v.deviceMid } : {}),
  };
}

/**
 * Cache key for process-wide singletons that embed a `ProxyIdentity`
 * (endpoint routing, client signing): two configs producing the same key can
 * share the same service instance.
 */
export function identityCacheKey(identity: ProxyIdentity): string {
  return JSON.stringify([identity.appVersion, identity.sourceTitle, identity.refererOrigin, identity.deviceMid ?? ""]);
}
