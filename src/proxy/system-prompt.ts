/**
 * ZCode system-prompt assembly — a faithful mirror of the desktop client's
 * ContextBuilder (ZCode 3.16.3, `_reverse/glm/zcode.cjs` `Fje`;
 * 3.12.3 `Dle` — assembly structure byte-identical across 3.12.3→3.16.3,
 * `_reverse/NOTEPAD.md` "3.16.3 增补" §F).
 *
 * The gateway does content inspection — if it doesn't see the ZCode identity
 * blocks in the `system` field, it rejects with 3012 "method not allowed".
 * Beyond the identity marker, the real client's assembly has a precise shape
 * (all symbols verified in the 3.16.3 bundle):
 *
 *   `assembleSystemMessages` (`Fje#assembleSystemMessages`, 3.12.3
 *   `Hre`/`ect`) groups the built sections into EXACTLY 3 wire blocks:
 *     1. cli_prefix alone — NO cache_control since 3.15.1 (3.12.3–3.14.4
 *        carried ephemeral here; the wire serializer maps absent cacheControl
 *        to an omitted `cache_control` key)
 *     2. every other STABLE section, `\n\n`-joined (`Lje`), ephemeral
 *     3. every DYNAMIC section, `\n\n`-joined, with an explicit `"\n\n"`
 *        prefix on the block text, ephemeral
 *
 *   The default section set mirrored here (config-dependent sections
 *   — Session Guidance, Memory, Output Style, git System Context, skills —
 *   are absent, which is a real, common client state):
 *     block 2: Agent Identity (`BDt`-family). The desktop client appends
 *              ZCode Desktop Context (`Ekn`, presentationSurface ===
 *              "zcode_desktop" gate) here; the proxy deliberately does NOT
 *              (CLI-face traffic never carries it — see buildStartPlanSystem).
 *     block 3: Dynamic Behavior (`N0o`) → Environment Info (`ckn`/`Eua`) →
 *              Context Management (`F0o`)
 *
 *   `Eua` builds the Environment lines with REAL runtime values (cwd,
 *   platform, shell, osVersion — `createNodeContextSourceAdapter`) and the
 *   conditional `- You are powered by the model named {providerId}/{modelId}.`
 *   as the section's last line (registry `p2`/`XQ`:
 *   zai→"zai-api", bigmodel→"bigmodel-api"). `cwd` is never "unknown" in real
 *   traffic; the proxy fills it (and platform/osVersion) from the SAME
 *   identity env chain as the X-Platform/X-Os-Version headers, so the prompt
 *   can never contradict the headers (a mixed combination no real client
 *   produces). See {@link resolveEnvPromptInfo} in identity.ts.
 *
 *   `meta_user` attachments (`assembleMetaUserAttachments`): the client
 *   ALWAYS attaches a context_prefix to the first user turn — the currentDate
 *   section (`Mje`/`Ple`, `# currentDate\nToday's date is YYYY-MM-DD.`, local
 *   date via `pK`) wrapped as `<system-reminder>…</system-reminder>`.
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
 * mirroring `assembleSystemMessages`.
 *
 * ALWAYS the 3-block shape (cli_prefix plain, stable and dynamic blocks
 * ephemeral, dynamic block `\n\n`-prefixed).
 *
 * DELIBERATE DEVIATION from the desktop client's stable block: the ZCode
 * Desktop Context section (3.16.3 `Ekn`, ~1.8KB) is NOT injected. It is gated
 * on `presentationSurface === "zcode_desktop"` in the real client, so CLI-face
 * traffic never carries it — a real, common client state. The start-plan
 * gateway requires the stable block to OPEN with the full identity text but
 * does not require Desktop Context behind it (probe matrix 2026-10-27,
 * `_reverse/NOTEPAD.md` "3.16.3 增补" §J; P10/P12 both 200).
 *
 * Client system present → its normalized text becomes the ENTIRE block-3
 * content behind the `\n\n` prefix, REPLACING the dynamic trio (C1 form,
 * user-approved 2026-10-27 after the §J live matrix proved block 3 is
 * unconstrained — empty string, 1 char, whitespace-only and arbitrary client
 * text all pass). Block 2 then stays the byte-exact pure stable text, immune
 * to a prefix→exact gateway tightening, and the client text rides the
 * loosest-validated block. Gateway rule history (issue #71 + §J):
 *   - 2026-10-23: 2-block custom/subagent shape passed (that day's #68 fix).
 *   - 2026-10-24: that shape rejected under both session types; stable-suffix
 *     folding (§I) passed and is live re-verified 2026-10-27 (T1).
 *   - 2026-10-27 §J unified rules: system REQUIRED (absent → 3012), block 1
 *     exact-match, block 2 must OPEN with the full stable text (suffix
 *     allowed), block 3 UNCONSTRAINED, block count NOT checked (2-block
 *     [cli_prefix, stable] passes).
 * Client system ABSENT → the official default trio (dynamic behavior →
 * environment → context management), the shape of every real desktop request.
 * Multiple client text blocks are `\n\n`-joined into one string; client
 * `cache_control` is dropped (the stable block owns its single ephemeral
 * breakpoint — no new breakpoints are introduced).
 */
export function buildStartPlanSystem(
  existingSystem: unknown,
  currentModel: string | undefined,
  env: StartPlanEnvInfo,
  provider?: "zai" | "bigmodel",
): SystemBlock[] {
  const custom = customSystemText(existingSystem);
  const stable = data.stableSections.join("\n\n");
  // C1: client text replaces the dynamic trio as block-3 content; the official
  // trio stays only on the default (no client system) path.
  const dynamic = custom !== undefined
    ? custom
    : [
        data.dynamicSections.beforeEnvironment,
        buildEnvironmentSection(env, currentModel, provider),
        data.dynamicSections.afterEnvironment,
      ].join("\n\n");
  return [
    { type: "text", text: data.cliPrefix },
    { type: "text", text: stable, cache_control: { ...EPHEMERAL } },
    { type: "text", text: `\n\n${dynamic}`, cache_control: { ...EPHEMERAL } },
  ];
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

/**
 * Client system → the single customSystemPrompt string (bundle semantic:
 * `customSystemPrompt?.trim()`). String input is used as-is (trimmed);
 * array input's text blocks are `\n\n`-joined into one string — the real
 * client carries exactly one custom prompt string, never a block list.
 * Returns undefined when there is no non-empty text (whitespace-only
 * systems take the default identity path, matching `!!o` in the bundle).
 */
function customSystemText(system: unknown): string | undefined {
  if (system == null) return undefined;
  if (typeof system === "string") {
    const text = system.trim();
    return text ? text : undefined;
  }
  if (!Array.isArray(system)) return undefined;
  const parts: string[] = [];
  for (const item of system) {
    if (typeof item === "string") {
      if (item.trim()) parts.push(item);
    } else if (item && typeof item === "object") {
      const b = item as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        // cache_control intentionally dropped — see buildStartPlanSystem doc.
        parts.push(b.text);
      }
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}
