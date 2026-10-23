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
 *   The default desktop section set mirrored here (config-dependent sections
 *   — Session Guidance, Memory, Output Style, git System Context, skills —
 *   are absent, which is a real, common client state):
 *     block 2: Agent Identity (`BDt`-family) + ZCode Desktop Context
 *              (`Ekn`, gated on presentationSurface === "zcode_desktop").
 *              The Desktop Context carries the Interactive views subsection
 *              since 3.15.1 (always present): with a genUiOutputDirectory
 *              (the desktop norm) 3 lines incl. the JSON-stringified
 *              visualization dir, else a 1-line fallback.
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
import { resolveVisualizationDirectory } from "./identity.js";

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
 * ZCode Desktop Context section (3.16.3 `Ekn`): Interactive views subsection
 * (since 3.15.1, always present) followed by Files & URLs + Inline Code
 * Comments. With a visualization directory (desktop norm) the 3-line variant
 * renders the dir JSON-stringified — on Windows that means quoted with escaped
 * backslashes, exactly the real client's `${JSON.stringify(dir)}` output.
 */
export function buildDesktopContextSection(vizDir: string | undefined): string {
  const iv = data.desktopContext.interactiveViews;
  const dirLines = vizDir
    ? [
        iv.genUiLine,
        iv.visualizationDirectoryLine.replace("{dir}", JSON.stringify(vizDir)),
        iv.visualizeSkillLine,
      ]
    : [iv.fallbackLine];
  const interactive = [iv.heading, ...dirLines, iv.widgetLine].join("\n");
  return [data.desktopContext.heading, interactive, data.desktopContext.filesAndUrlsOnwards].join("\n\n");
}

/**
 * Prepend the official ZCode gateway blocks to the request's `system` field,
 * mirroring `assembleSystemMessages` (3 blocks: cli_prefix plain, stable and
 * dynamic blocks ephemeral, dynamic block `\n\n`-prefixed).
 *
 * The block COUNT is part of the gateway's fingerprint: the real client emits
 * exactly three `system` blocks. A fourth block (what appending a client system
 * prompt used to produce) makes the upstream risk-control layer reject the
 * request with
 * `405 {"code":3012,"msg":"request has been blocked due to unusual activity."}`
 * — which is exactly what every Claude Code request used to hit.
 *
 * Client system text therefore must NOT be appended here — callers merge it
 * into the third block via {@link clientSystemText} (see `applyStartPlanSystem`
 * in body-transformer.ts), keeping the three-block count the gateway expects.
 */
export function buildStartPlanSystem(
  currentModel: string | undefined,
  env: StartPlanEnvInfo,
  provider?: "zai" | "bigmodel",
  vizDir: string = resolveVisualizationDirectory(),
): SystemBlock[] {
  const stable = [data.stableSections.join("\n\n"), buildDesktopContextSection(vizDir)].join("\n\n");
  const dynamic = [
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
 * Flatten a client-supplied system prompt (string or Anthropic text-block
 * array) into one plain-text string, dropping empty blocks and any
 * `cache_control` markers (the official blocks already own the system cache
 * breakpoints). Returns `""` when there is nothing to carry.
 */
export function clientSystemText(system: unknown): string {
  return normalizeUserSystem(system)
    .map((block) => block.text)
    .join("\n\n");
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
