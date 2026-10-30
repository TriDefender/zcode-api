/**
 * ZCode system-prompt assembly — a faithful mirror of the desktop client's
 * ContextBuilder (ZCode 3.17.1, `_reverse/glm/zcode.cjs` `Y8e`;
 * 3.16.3 `Fje` — the 3-block wire shape is byte-identical across
 * 3.12.3→3.17.1, `_reverse/NOTEPAD.md` "3.17.1 增补" 四轮).
 *
 * The gateway does content inspection — if it doesn't see the ZCode identity
 * blocks in the `system` field, it rejects with 3012 "method not allowed".
 * Beyond the identity marker, the real client's assembly has a precise shape
 * (all symbols verified in the 3.17.1 bundle):
 *
 *   `assembleSystemMessages` (`Y8e#assembleSystemMessages`, `Lxt` join)
 *   groups the built sections into EXACTLY 3 wire blocks:
 *     1. cli_prefix alone — NO cache_control since 3.15.1 (3.12.3–3.14.4
 *        carried ephemeral here; the wire serializer maps absent cacheControl
 *        to an omitted `cache_control` key)
 *     2. every other STABLE section, `\n\n`-joined (`Lxt`), ephemeral
 *     3. every DYNAMIC section, `\n\n`-joined, with an explicit `"\n\n"`
 *        prefix on the block text, ephemeral
 *
 *   The minimal mirrored set (config-dependent sections — Session Guidance,
 *   Memory, skills, agentsMd — are absent, which is a real, common client
 *   state):
 *     block 2: Agent Identity (`wDn`/`fBa` — default branch `dBa` identity +
 *              `nBo` security notice + `SDn` Harness; bullets carry a leading
 *              space since 3.17.1, bullet 3 takes the `e=!0` default branch).
 *              The desktop client appends ZCode Desktop Context (`WDn`,
 *              presentationSurface === "zcode_desktop" gate) here; the proxy
 *              deliberately does NOT (CLI-face traffic never carries it —
 *              see buildStartPlanSystem).
 *     block 3: EMPTY (minimal-set anchoring 2026-10-30) — official 3.17.1
 *              clients ship the Dynamic Behavior (`TBo`) + Context
 *              Management (`IBo`) duo; the gateway constrains neither
 *              (probe M1/M3/N09), so the proxy omits it for token economy.
 *              3.17.1 moved Environment Info (`mSo`/`hSo`), Model Identity
 *              (`YTn`, the powered-by line) and Current Date (`fce`) out of
 *              the system blocks into meta_user attachments regardless.
 *
 *   meta_user attachments (`GDn` + request-time `$5o`): the client attaches
 *   a standalone "date" attachment — `Today's date is YYYY-MM-DD.` (local
 *   date, no heading since 3.17.1) — to the first user turn, rendered as a
 *   `<system-reminder>`-wrapped text block. {@link buildCurrentDateMessage}
 *   mirrors it (stateless per-request approximation of the fresh-session
 *   attachment; environment/model attachments are session-state reconciled
 *   and intentionally not mirrored).
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

const EPHEMERAL: { type: "ephemeral" } = { type: "ephemeral" };

/** Bundle `pK`-family (`_Ne`): local `YYYY-MM-DD`, zero-padded. */
export function formatLocalIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Prepend the official ZCode gateway blocks to the request's `system` field,
 * mirroring `assembleSystemMessages`.
 *
 * ALWAYS the 3-block shape (cli_prefix plain, stable and dynamic blocks
 * ephemeral, dynamic block `\n\n`-prefixed).
 *
 * DELIBERATE DEVIATION from the desktop client's stable block: the ZCode
 * Desktop Context section (3.17.1 `WDn`, ~1.8KB) is NOT injected. It is gated
 * on `presentationSurface === "zcode_desktop"` in the real client, so CLI-face
 * traffic never carries it — a real, common client state. The start-plan
 * gateway requires the stable block to OPEN with the full identity text but
 * does not require Desktop Context behind it (probe matrix 2026-10-27,
 * `_reverse/NOTEPAD.md` "3.16.3 增补" §J; P10/P12 both 200).
 *
 * Client system present → its normalized text becomes the ENTIRE block-3
 * content behind the `\n\n` prefix, REPLACING the official dynamic duo (C1
 * form, user-approved 2026-10-27 after the §J live matrix proved block 3 is
 * unconstrained — empty string, 1 char, whitespace-only and arbitrary client
 * text all pass). Block 2 then stays the byte-exact pure stable text, immune
 * to a prefix→exact gateway tightening, and the client text rides the
 * loosest-validated block. Client system ABSENT → EMPTY block 3 (the
 * 2026-10-30 "minimal set" anchoring: official-default duo deliberately NOT
 * mirrored, saving ~450 tokens/request; live matrix M1/M3/N09 prove block 3
 * carries no constraints — see NOTEPAD "3.17.1 增补" 六轮).
 * Multiple client text blocks are `\n\n`-joined into one string; client
 * `cache_control` is dropped (the stable block owns its single ephemeral
 * breakpoint — no new breakpoints are introduced).
 */
export function buildStartPlanSystem(existingSystem: unknown): SystemBlock[] {
  const custom = customSystemText(existingSystem);
  const stable = data.stableSections.join("\n\n");
  // C1: client text replaces the dynamic duo as block-3 content. Default
  // (no client system) path ships an EMPTY block 3 — the gateway-anchored
  // minimal set (2026-10-30 probe M1: block 3 is entirely unconstrained;
  // official-default duo omitted as a deliberate deviation, ~450 tokens
  // saved per request on the cache-miss-heavy stateless proxy traffic).
  // Empty block 3 is indistinguishable from a C1 client with an empty
  // custom system — a shape the live matrix proves passes. The duo texts
  // stay in zcode_system.json as the official-shape record for PROMPT.md
  // and future re-mirroring.
  const dynamic = custom !== undefined ? custom : "";
  return [
    { type: "text", text: data.cliPrefix },
    { type: "text", text: stable, cache_control: { ...EPHEMERAL } },
    { type: "text", text: dynamic === "" ? "" : `\n\n${dynamic}`, cache_control: { ...EPHEMERAL } },
  ];
}

/**
 * The meta_user "date" attachment (3.17.1 `$5o`/`fce`): a leading user turn
 * whose single text block is `Today's date is YYYY-MM-DD.` (no heading —
 * 3.16.x carried a `# currentDate` heading inside the context_prefix; the
 * whole context_prefix intro/outro wrapper was removed in 3.17.1) wrapped in
 * `<system-reminder>…</system-reminder>` (no inner padding newlines).
 */
export function buildCurrentDateMessage(now?: Date): { role: "user"; content: SystemBlock[] } {
  const date = formatLocalIsoDate(now ?? new Date());
  const body = data.currentDate.line.replace("{date}", date);
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
