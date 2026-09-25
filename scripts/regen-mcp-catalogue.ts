/**
 * Regenerate src/mcp/official-catalogue.json from ZCode's official plugin
 * marketplace (maintainer-side, offline tooling — NOT part of the runtime).
 *
 * What it does (mirrors the ZCode desktop plugin-install dance, minus the
 * installation): fetch marketplace.json → download every plugin.zip → verify
 * sha256 against the marketplace pin → unzip → parse .mcp.json +
 * .zcode-plugin/plugin.json → emit the static server table the gateway serves
 * at /mcp/{server-key}.
 *
 * Run when ZCode ships new plugins, then cut a release:
 *   bun run scripts/regen-mcp-catalogue.ts
 *
 * Self-contained on purpose (no imports from src/): the runtime never parses
 * zips; this script is the only zip consumer in the repo.
 */
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const MARKETPLACE_URL = "https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json";
const OUT_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "mcp", "official-catalogue.json");
// Production fallback (`jee`) per the desktop glm bundle `p1`/`air`; the test
// env fallback is https://zcode.chatglm.site (`sYe`).
const DEFAULT_UPSTREAM_ORIGIN = "https://zcode.z.ai";
const OFFICIAL_UPSTREAM_ORIGINS = new Set(["https://zcode.z.ai", "https://zcode.chatglm.site"]);
const URL_TEMPLATE_PREFIX = "${ZCODE_BASE_URL}";
const DOWNLOAD_CONCURRENCY = 6;

// ─────────────────────────────────────────────────────────────────────────────
// Minimal zip reader (central-directory walk; methods 0=stored and 8=deflate).
// These plugin zips are tiny and zip64-free; a full archive lib would break
// the 3-dependency runtime budget for zero benefit.
// ─────────────────────────────────────────────────────────────────────────────

interface ZipEntry {
  name: string;
  data: Buffer;
}

function readZip(buf: Buffer): ZipEntry[] {
  // Locate EOCD (signature 0x06054b50) scanning backwards over the comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip: end of central directory not found");
  const entryCount = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16); // central directory offset

  const entries: ZipEntry[] = [];
  for (let n = 0; n < entryCount; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error(`zip: bad central directory entry #${n}`);
    const method = buf.readUInt16LE(off + 10);
    const compressedSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOffset = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString("utf8");

    // Local header: fixed 30 bytes, then its OWN name/extra lengths (data
    // descriptor flag makes local sizes unreliable — always slice by the
    // central directory's compressedSize).
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`zip: bad local header for ${name}`);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);

    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`zip: unsupported compression method ${method} for ${name}`);

    if (name.endsWith("/")) continue; // directory entry
    entries.push({ name, data });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Match an entry by path suffix — archives nest content under `{plugin}/`. */
function findEntry(entries: ZipEntry[], suffix: string): ZipEntry | undefined {
  const normalized = suffix.replace(/^\//, "");
  return entries.find((e) => e.name === normalized || e.name.endsWith(`/${normalized}`));
}

// ─────────────────────────────────────────────────────────────────────────────
// Marketplace parsing
// ─────────────────────────────────────────────────────────────────────────────

interface MarketplacePlugin {
  name: string;
  version: string;
  description?: string;
  description_i18n?: Record<string, string>;
  displayName?: string;
  displayName_i18n?: Record<string, string>;
  requiresPaidPlan?: boolean;
  category?: string;
  source?: { url?: string; sha256?: string };
}

interface CatalogueServer {
  key: string;
  routeId: string;
  path: string;
  plugin: string;
  version: string;
  marketplace: string;
  requiresPaidPlan: boolean;
  displayName: Record<string, string>;
  description: Record<string, string>;
  category?: string;
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function pickI18n(base: string | undefined, i18n: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = { en: i18n?.en ?? base ?? "" };
  const zh = i18n?.["zh-CN"] ?? i18n?.zh;
  if (zh) out["zh-CN"] = zh;
  return out;
}

/**
 * Accept only the verified official shape: type http + zcode_official/jwt_token
 * auth + a ${ZCODE_BASE_URL}/api/v1/mcp/server/{route} URL. Anything else
 * (stdio servers, third-party URLs, unknown auth) is reported and skipped —
 * the gateway must never point at origins it cannot trust-inject creds into
 * (desktop enforces the same via `official_mcp_origin_untrusted`).
 */
function extractRoutePath(url: string): { path: string; routeId: string } | null {
  let rest: string | null = null;
  if (url.startsWith(URL_TEMPLATE_PREFIX)) rest = url.slice(URL_TEMPLATE_PREFIX.length);
  else {
    try {
      const u = new URL(url);
      if (OFFICIAL_UPSTREAM_ORIGINS.has(u.origin)) rest = u.pathname;
    } catch {
      rest = null;
    }
  }
  if (!rest || !rest.startsWith("/api/v1/mcp/server/")) return null;
  const routeId = rest.slice("/api/v1/mcp/server/".length).replace(/\/+$/, "");
  if (!routeId || routeId.includes("/")) return null;
  return { path: rest, routeId };
}

async function main(): Promise<void> {
  console.log(`Fetching marketplace: ${MARKETPLACE_URL}`);
  const mpResp = await fetch(MARKETPLACE_URL);
  if (!mpResp.ok) throw new Error(`marketplace fetch failed: ${mpResp.status}`);
  const marketplace = (await mpResp.json()) as { plugins?: MarketplacePlugin[] };
  const plugins = marketplace.plugins ?? [];
  console.log(`Marketplace lists ${plugins.length} plugins`);

  const results: CatalogueServer[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];

  const queue = [...plugins];
  const worker = async (): Promise<void> => {
    while (queue.length > 0) {
      const p = queue.shift();
      if (!p) return;
      try {
        if (!p.source?.url || !p.source.sha256) {
          skipped.push(`${p.name}: no pinned artifact`);
          continue;
        }
        const resp = await fetch(p.source.url);
        if (!resp.ok) throw new Error(`zip fetch ${resp.status}`);
        const zipBuf = Buffer.from(await resp.arrayBuffer());
        const actual = sha256Hex(zipBuf);
        if (actual !== p.source.sha256) throw new Error(`sha256 mismatch (marketplace ${p.source.sha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`);

        const entries = readZip(zipBuf);
        const mcpEntry = findEntry(entries, ".mcp.json");
        if (!mcpEntry) {
          skipped.push(`${p.name}@${p.version}: no .mcp.json (non-MCP plugin)`);
          continue;
        }
        let mcp: { mcpServers?: Record<string, { type?: string; url?: string; auth?: { type?: string; provider?: string } }> };
        try {
          mcp = JSON.parse(mcpEntry.data.toString("utf8"));
        } catch (err) {
          throw new Error(`.mcp.json parse failed: ${(err as Error).message}`);
        }
        const servers = mcp.mcpServers ?? {};
        let any = false;
        for (const [key, def] of Object.entries(servers)) {
          if (def.type !== "http") {
            warnings.push(`${p.name}/${key}: unsupported type ${String(def.type)} — skipped`);
            continue;
          }
          if (def.auth?.type !== "zcode_official" || def.auth.provider !== "jwt_token") {
            warnings.push(`${p.name}/${key}: auth ${String(def.auth?.type)}/${String(def.auth?.provider)} != zcode_official/jwt_token — skipped`);
            continue;
          }
          const route = def.url ? extractRoutePath(def.url) : null;
          if (!route) {
            warnings.push(`${p.name}/${key}: url not an official gateway route (${String(def.url)}) — skipped`);
            continue;
          }
          const dup = results.find((r) => r.key === key);
          if (dup) throw new Error(`server key collision: "${key}" declared by both ${dup.plugin} and ${p.name}`);
          const pluginEntry = findEntry(entries, ".zcode-plugin/plugin.json");
          let meta: MarketplacePlugin = p;
          if (pluginEntry) {
            try {
              meta = { ...p, ...(JSON.parse(pluginEntry.data.toString("utf8")) as MarketplacePlugin) };
            } catch { /* marketplace metadata is enough */ }
          }
          results.push({
            key,
            routeId: route.routeId,
            path: route.path,
            plugin: p.name,
            version: p.version,
            marketplace: "zcode-plugins-official",
            requiresPaidPlan: meta.requiresPaidPlan === true,
            displayName: pickI18n(meta.displayName, meta.displayName_i18n),
            description: pickI18n(meta.description, meta.description_i18n),
            ...(meta.category ? { category: meta.category } : {}),
          });
          any = true;
        }
        if (!any) skipped.push(`${p.name}@${p.version}: no supported MCP servers in .mcp.json`);
      } catch (err) {
        warnings.push(`${p.name}@${p.version}: ${(err as Error).message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: DOWNLOAD_CONCURRENCY }, worker));

  results.sort((a, b) => a.key.localeCompare(b.key));
  const catalogue = {
    generatedAt: new Date().toISOString(),
    marketplaceUrl: MARKETPLACE_URL,
    defaultUpstreamOrigin: DEFAULT_UPSTREAM_ORIGIN,
    servers: results,
  };
  writeFileSync(OUT_FILE, `${JSON.stringify(catalogue, null, 2)}\n`, "utf8");

  console.log(`\nCatalogue: ${results.length} MCP servers → ${OUT_FILE}`);
  for (const s of results) console.log(`  ${s.key.padEnd(24)} → ${s.routeId}  (${s.plugin}@${s.version}${s.requiresPaidPlan ? ", paid-plan" : ""})`);
  if (skipped.length > 0) {
    console.log(`\nSkipped (${skipped.length}):`);
    for (const s of skipped) console.log(`  - ${s}`);
  }
  if (warnings.length > 0) {
    console.log(`\nWarnings (${warnings.length}):`);
    for (const w of warnings) console.log(`  ! ${w}`);
  }
}

main().catch((err) => {
  console.error(`regen failed: ${(err as Error).message}`);
  process.exit(1);
});
