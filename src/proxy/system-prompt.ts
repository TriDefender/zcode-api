/**
 * ZCode system prompt blocks required by zcode.z.ai start-plan gateway.
 *
 * The gateway does content inspection — if it doesn't see the ZCode identity
 * blocks in the `system` field, it rejects with 3012 "method not allowed".
 *
 * Static blocks (CLI Prefix, Agent Identity w/ Harness, Environment Info) live
 * in zcode_system.json. The dynamic `currentModel` block is appended at runtime
 * when a model name is available — mirrors bundle 3.3.6 `buildEnvInfoSection`
 * which emits `- You are powered by the model named ${currentModel}.` as the
 * trailing line when `envInfo.currentModel` is set.
 *
 * Source: extracted from ZCode Electron app's `buildCliPrefixSection`,
 * `buildIdentitySection`, and `buildEnvInfoSection` (bundle offsets ~661815,
 * ~663472, ~665165). See PROMPT.md for the full prompt structure.
 *
 * @see zcode_system.json
 * @see PROMPT.md
 */
// Inlined as a build-time constant (Bun `json` import attribute / esbuild json
// loader) so it ships inside the single-file compiled binary — a runtime
// `readFileSync` would resolve `__dirname` to the build-time CI path and crash
// with ENOENT on every other host. @see types.d.ts
import blocks from "./zcode_system.json" with { type: "json" };

interface SystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

const ZCODE_SYSTEM_BLOCKS = blocks as SystemBlock[];

/**
 * Prepend official ZCode gateway blocks to the request's `system` field.
 * Client system blocks (if any) are preserved after the official blocks.
 *
 * When `currentModel` is a non-empty string, an additional block
 * `- You are powered by the model named ${currentModel}.` is appended after
 * the static official blocks (mirrors ZCode client behavior for
 * `envInfo.currentModel`).
 */
export function buildStartPlanSystem(existingSystem: unknown, currentModel?: string): unknown[] {
  const official = ZCODE_SYSTEM_BLOCKS.map((b) => structuredClone(b));
  if (currentModel && currentModel.trim().length > 0) {
    official.push({
      type: "text",
      text: `- You are powered by the model named ${currentModel}.`,
      cache_control: { type: "ephemeral" },
    });
  }
  const userBlocks = normalizeUserSystem(existingSystem);
  return [...official, ...userBlocks];
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
        out.push({
          type: "text",
          text: b.text,
          ...(typeof b.cache_control === "object" && b.cache_control !== null ? { cache_control: b.cache_control as { type: "ephemeral" } } : {}),
        });
      }
    }
  }
  return out;
}
