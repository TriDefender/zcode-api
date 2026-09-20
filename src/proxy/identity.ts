/**
 * Identity header builders — emit the ZCode desktop client's companion
 * headers so the proxy is indistinguishable from the official client at the
 * fingerprinting layer.
 *
 * TWO distinct bundle functions are mirrored (ZCode 3.12.3, `_reverse/NOTEPAD.md`):
 *
 *   1. `g6n` = buildCliZCodeSourceHeaders — the single 3.12.3 source for the
 *      LLM completion defaultHeaders AND the coding-plan-signature gate /
 *      feature-gate fetches (`ESs`). Used for every LLM completion request →
 *      {@link buildLlmIdentityHeaders} and the gate header set in
 *      client-signing.ts. Shape: HTTP-Referer, User-Agent, [X-ZCode-App-Version],
 *      X-Title, X-Release-Channel, X-Client-Language (always, "unknown"
 *      fallback), X-Client-Timezone (always, "unknown" fallback),
 *      X-ZCode-Agent ("glm", 8th — inline since 3.12.3 dropped the 3.11 `x4i`
 *      wrapper that appended it last), [X-Platform], X-Os-Category (always —
 *      `CSs` bypasses the printable gate), [X-Os-Version]. NO X-Device-Mid.
 *
 *   2. `TV` = buildZCodeSourceHeadersFromContext (host chunk-ZH56ETHO) — the
 *      endpoint-routing `sourceHeaders` (built by `V6n` from
 *      `~/.zcode/v2/telemetry-state.json`'s deviceMid on the real client) —
 *      used by {@link buildIdentityHeaders}. 3.12.3 dropped X-ZCode-Agent
 *      entirely on this plane and made language/timezone always-present with
 *      the "unknown" fallback. Order: HTTP-Referer, User-Agent,
 *      [X-ZCode-App-Version], X-Title, [X-Platform], [X-Release-Channel],
 *      X-Client-Language, X-Client-Timezone, [X-Os-Category], [X-Os-Version],
 *      [X-Device-Mid].
 *
 * Both gate header values through the bundle's printable-ASCII rule (`tq`/
 * `Oe`); `n = fio(...)` validates appVersion and, when it fails, drops
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
 * @see _reverse/NOTEPAD.md "2. Identity Headers"
 */
import os from "node:os";
import { basename } from "node:path";
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
 * Identity headers for LLM completion requests and the 3.12.3 feature-gate /
 * client-signing gate fetches — mirrors the bundle's `g6n`
 * (buildCliZCodeSourceHeaders; the `x4i` append-last wrapper is gone in
 * 3.12.3). X-ZCode-Agent sits 8th (after timezone, before platform),
 * X-Os-Category is unconditional (`CSs` maps the raw platform), and
 * X-Device-Mid is NEVER sent. Pure function.
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
    "X-ZCode-Agent": "glm",
    ...(v.platform && v.arch ? { "X-Platform": `${v.platform}-${v.arch}` } : {}),
    "X-Os-Category": normalizeOsCategory(v.platformForCategory),
    ...(v.release ? { "X-Os-Version": v.release } : {}),
  };
}

/**
 * Context-shaped identity headers — mirrors the host builder
 * `TV` (3.12.3 chunk-ZH56ETHO) / `c5` (3.14.0 chunk-WFF5YMZO) / bundle `IJt`
 * (buildZCodeSourceHeadersFromContext), reached via the endpoint-routing
 * source-headers factory (`V6n`). X-ZCode-Agent is GONE from this plane, and
 * language/timezone are always present with the "unknown" fallback. Consumers:
 * endpoint-routing.ts (source headers), claim/client.ts, routes-quota.ts,
 * async bridge.
 *
 * Order — RUNTIME INSERTION order, not source written order (2026-09-19
 * correction, `_reverse/NOTEPAD.md` §E): the official builder spreads a
 * 3-key base first (`yE`/`cU`/`Llr` = `{"User-Agent","HTTP-Referer","X-Title"}`)
 * and then overrides/adds keys. JS spread semantics keep overridden keys at
 * their base positions, so the wire order is:
 *   User-Agent, HTTP-Referer, X-Title, [X-ZCode-App-Version], [X-Platform],
 *   [X-Release-Channel], X-Client-Language, X-Client-Timezone,
 *   [X-Os-Category], [X-Os-Version], [X-Device-Mid]
 * (verified byte-level against both the 3.12.3 and 3.14.0 bundles/hosts).
 *
 * Returns `Record<string, string>` rather than a fixed interface because
 * several headers are conditionally omitted.
 */
export function buildIdentityHeaders(id: ProxyIdentity): Record<string, string> {
  const v = resolveIdentityValues(id);
  return {
    "User-Agent": `ZCode/${v.n ?? "unknown"}`,
    "HTTP-Referer": id.refererOrigin,
    "X-Title": `Z Code@${id.sourceTitle}`,
    ...(v.n ? { "X-ZCode-App-Version": v.n } : {}),
    ...(v.platform && v.arch ? { "X-Platform": `${v.platform}-${v.arch}` } : {}),
    ...(v.releaseChannel ? { "X-Release-Channel": v.releaseChannel } : {}),
    "X-Client-Language": v.clientLanguage ?? "unknown",
    "X-Client-Timezone": v.clientTimezone ?? "unknown",
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

/**
 * Environment-info values for the start-plan system prompt's Environment
 * section — mirrors the bundle's `createNodeContextSourceAdapter`
 * (cwd/platform/shell/osVersion feeding `T9o`).
 *
 * platform/arch/release ride the SAME `ZCODE_IDENTITY_*` env chain as the
 * identity headers, so the prompt's `Platform:`/`OS Version:` lines can never
 * contradict `X-Platform`/`X-Os-Version` — real traffic is either all-real
 * (desktop) or all-"unknown" (headless fallback); a mixed combination is a
 * distinguisher no real client produces. `osVersion` keeps the bundle's
 * `${platform} ${release} ${arch}` composition.
 *
 * `shell` follows the bundle algorithm verbatim (`SHELL` ?? `ComSpec` ?? ""
 * → basename, else "unknown" — "unknown" is a legal shell value when
 * detection fails). `cwd` is `ZCODE_IDENTITY_ENV_CWD` if set (Android /
 * masked-identity deployments), else `process.cwd()` — the real client sends
 * its actual working directory, and `cwd` is NEVER "unknown" in real traffic.
 */
export interface EnvPromptInfo {
  cwd: string;
  platform: string;
  shell: string;
  osVersion: string;
}

export function resolveEnvPromptInfo(): EnvPromptInfo {
  const platform = normalizePrintableHeaderValue(process.env.ZCODE_IDENTITY_PLATFORM ?? process.platform) ?? "unknown";
  const release = normalizePrintableHeaderValue(process.env.ZCODE_IDENTITY_RELEASE ?? os.release()) ?? "";
  const arch = normalizePrintableHeaderValue(process.env.ZCODE_IDENTITY_ARCH ?? os.arch()) ?? "";
  const osVersion = [platform, release, arch].filter((part) => part.length > 0).join(" ");
  const shellRaw = process.env.SHELL ?? process.env.ComSpec ?? process.env.COMSPEC ?? "";
  const shell = shellRaw ? basename(shellRaw) : "unknown";
  const cwd = process.env.ZCODE_IDENTITY_ENV_CWD?.trim() || process.cwd();
  return { cwd, platform, shell, osVersion };
}
