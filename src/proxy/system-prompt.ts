/**
 * ZCode system-prompt assembly — a faithful mirror of the desktop client's
 * ContextBuilder (ZCode 3.11.2, `_reverse/zcode.cjs` `Hre`/`nct`).
 *
 * The gateway does content inspection — if it doesn't see the ZCode identity
 * blocks in the `system` field, it rejects with 3012 "method not allowed".
 * Beyond the identity marker, the real client's assembly has a precise shape
 * (all symbols verified in the 3.11.2 bundle):
 *
 *   `assembleSystemMessages` groups the built sections into EXACTLY 3 wire
 *   blocks, each with `cache_control: {type:"ephemeral"}` (`ect`):
 *     1. cli_prefix alone                          ("You are ZCode, …")
 *     2. every other STABLE section, `\n\n`-joined (`Wre`)
 *     3. every DYNAMIC section, `\n\n`-joined, with an explicit `"\n\n"`
 *        prefix on the block text
 *
 *   The default desktop section set mirrored here (config-dependent sections
 *   — Session Guidance, Memory, Output Style, git System Context, skills —
 *   are absent, which is a real, common client state):
 *     block 2: Agent Identity (`u9o`) + ZCode Desktop Context (`Ylt`, gated
 *              on presentationSurface === "zcode_desktop")
 *     block 3: Dynamic Behavior (`wTr`/Xlt) → Environment Info (`T9o`) →
 *              Context Management (`STr`/xTr)
 *
 *   `T9o` builds the Environment lines with REAL runtime values (cwd,
 *   platform, shell, osVersion — `createNodeContextSourceAdapter`) and the
 *   conditional `- You are powered by the model named {providerId}/{modelId}.`
 *   as the section's last line (3.12.3 `eMi` + registry `p2`:
 *   zai→"zai-api", bigmodel→"bigmodel-api"). `cwd` is never "unknown" in real
 *   traffic; the proxy fills it (and platform/osVersion) from the SAME
 *   identity env chain as the X-Platform/X-Os-Version headers, so the prompt
 *   can never contradict the headers (a mixed combination no real client
 *   produces). See {@link resolveEnvPromptInfo} in identity.ts.
 *
 *   `meta_user` attachments (`assembleMetaUserAttachments`/`tct`): the client
 *   ALWAYS attaches a context_prefix to the first user turn — the currentDate
 *   section (`Vre`, `# currentDate\nToday's date is YYYY-MM-DD.`, local date
 *   via `pK`) wrapped as `<system-reminder>…</system-reminder>` (`blt`).
 *   {@link buildContextPrefixMessage} mirrors it.
 *
 * Static section texts live in zcode_system.json (sidecar asset, inlined into
 * the single-file binary via the json import attribute).
 *
 * @see zcode_system.json
 * @see PROMPT.md
 */
// Inlined as a build-time constant (Bun `json` import attribute / esbuild json
// loader) so it ships inside the single-file compiled binary — a runtime
// `readFileSync` would resolve `__dirname` to the build-time CI path and crash
// with ENOENT on every other host. @see types.d.ts
import data from "./zcode_system.json" with { type: "json" };

export interface SystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

/** Runtime environment values for the Environment section (`T9o` input). */
export interface StartPlanEnvInfo {
  cwd: string;
  platform: string;
  shell: string;
  osVersion: string;
}

const EPHEMERAL: { type: "ephemeral" } = { type: "ephemeral" };

/** Bundle `pK` (formatLocalIsoDate): local `YYYY-MM-DD`, zero-padded. */
export function formatLocalIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Bundle `p2` (3.12.3): OAuth provider → built-in model-provider id. The
 * powered-by line renders `{providerId}/{modelId}` from the client's model
 * selection descriptor, so coding-plan traffic carries e.g.
 * `- You are powered by the model named bigmodel-api/glm-4.6.`
 */
const PROVIDER_MODEL_IDS: Readonly<Record<"zai" | "bigmodel", string>> = {
  zai: "zai-api",
  bigmodel: "bigmodel-api",
};

/** Environment Info section (`T9o`/`eMi`): lines joined with `\n`; powered-by last. */
export function buildEnvironmentSection(
  env: StartPlanEnvInfo,
  currentModel?: string,
  provider?: "zai" | "bigmodel",
): string {
  const e = data.environment;
  const lines = [
    e.heading,
    e.invokedLine,
    `- ${e.cwdLabel}: ${env.cwd}`,
    `- ${e.gitLabel}: ${e.gitNo}`,
    `- ${e.platformLabel}: ${env.platform}`,
    `- ${e.shellLabel}: ${env.shell}`,
    `- ${e.osVersionLabel}: ${env.osVersion}`,
  ];
  const modelId = currentModel?.trim();
  if (modelId && provider) {
    lines.push(e.poweredByLine.replace("{provider}", PROVIDER_MODEL_IDS[provider]).replace("{model}", modelId));
  }
  return lines.join("\n");
}

/**
 * Prepend the official ZCode gateway blocks to the request's `system` field,
 * mirroring `assembleSystemMessages` (3 blocks, ephemeral breakpoints, dynamic
 * block `\n\n`-prefixed). Client system blocks (if any) are preserved AFTER
 * the official blocks, with their `cache_control` stripped: the official
 * blocks already consume 3 of Anthropic's 4 cache breakpoints (the last is
 * the last-message marker applied by body-transformer), so client markers
 * would push the request over the cap — the real client never emits foreign
 * markers because it owns the whole body.
 */
export function buildStartPlanSystem(
  existingSystem: unknown,
  currentModel: string | undefined,
  env: StartPlanEnvInfo,
  provider?: "zai" | "bigmodel",
): SystemBlock[] {
  const stable = data.stableSections.join("\n\n");
  const dynamic = [
    data.dynamicSections.beforeEnvironment,
    buildEnvironmentSection(env, currentModel, provider),
    data.dynamicSections.afterEnvironment,
  ].join("\n\n");
  const official: SystemBlock[] = [
    { type: "text", text: data.cliPrefix, cache_control: { ...EPHEMERAL } },
    { type: "text", text: stable, cache_control: { ...EPHEMERAL } },
    { type: "text", text: `\n\n${dynamic}`, cache_control: { ...EPHEMERAL } },
  ];
  return [...official, ...normalizeUserSystem(existingSystem)];
}

/**
 * The meta_user context_prefix (`tct` + `Vre` + `blt`): a leading user turn
 * whose single text block is the currentDate section wrapped in
 * `<system-reminder>…</system-reminder>` (no inner padding newlines).
 */
export function buildContextPrefixMessage(now?: Date): { role: "user"; content: SystemBlock[] } {
  const cp = data.contextPrefix;
  const date = formatLocalIsoDate(now ?? new Date());
  const currentDateSection = `${cp.currentDateHeading}\n${cp.currentDateLine.replace("{date}", date)}`;
  const body = [cp.intro, currentDateSection, "", cp.outro].join("\n");
  return {
    role: "user",
    content: [{ type: "text", text: `${data.systemReminder.open}${body}${data.systemReminder.close}` }],
  };
}

function normalizeUserSystem(system: unknown): SystemBlock[] {
  if (system == null) return [];
  if (typeof system === "string") {
    const text = system.trim();
    return text ? [{ type: "text", text }] : [];
  }
  if (!Array.isArray(system)) return [];
  const out: SystemBlock[] = [];
  for (const item of system) {
    if (typeof item === "string") {
      if (item.trim()) out.push({ type: "text", text: item });
    } else if (item && typeof item === "object") {
      const b = item as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        // cache_control intentionally dropped — see buildStartPlanSystem doc.
        out.push({ type: "text", text: b.text });
      }
    }
  }
  return out;
}
