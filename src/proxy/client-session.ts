/**
 * Local client-session inference for cache-affinity experiments.
 *
 * The resolver stores only hashes and generated IDs. It deliberately avoids
 * prompt markers, response mutation, and full prompt persistence.
 */
import type { Format } from "../translator/types.js";
import type { ClientIdentityConfig } from "../config/types.js";

export type ClientSessionSource = "none" | "explicit" | "lineage";
export type ClientSessionAction = "off" | "observe" | "enforce";

export interface ClientSessionResult {
  source: ClientSessionSource;
  action: ClientSessionAction;
  confidence: number;
  sessionId?: string;
  upstreamSessionId?: string;
}

interface StoredNode {
  nodeHash: string;
  sessionId: string;
  upstreamSessionId: string;
  lastSeenAt: number;
}

interface CanonicalRequest {
  model: string;
  identity: unknown;
  messages: unknown[];
}

export interface ClientSessionResolver {
  resolve(req: Request, body: string | undefined, format: Format, model: string, config: ClientIdentityConfig): ClientSessionResult;
}

export function createClientSessionResolver(now: () => number = () => Date.now()): ClientSessionResolver {
  const nodes = new Map<string, StoredNode>();
  const sessions = new Map<string, StoredNode>();

  function remember(nodeHash: string, session: StoredNode, config: ClientIdentityConfig): void {
    const stored = { ...session, nodeHash, lastSeenAt: now() };
    nodes.set(nodeHash, stored);
    sessions.set(stored.sessionId, stored);
    prune(config);
  }

  function prune(config: ClientIdentityConfig): void {
    const cutoff = now() - config.ttlSeconds * 1000;
    for (const [hash, node] of nodes.entries()) {
      if (node.lastSeenAt < cutoff) nodes.delete(hash);
    }
    for (const [id, node] of sessions.entries()) {
      if (node.lastSeenAt < cutoff) sessions.delete(id);
    }
    while (sessions.size > config.maxSessions) {
      let oldestId = "";
      let oldestAt = Infinity;
      for (const [id, node] of sessions.entries()) {
        if (node.lastSeenAt < oldestAt) {
          oldestAt = node.lastSeenAt;
          oldestId = id;
        }
      }
      if (!oldestId) break;
      sessions.delete(oldestId);
      for (const [hash, node] of nodes.entries()) {
        if (node.sessionId === oldestId) nodes.delete(hash);
      }
    }
  }

  function action(config: ClientIdentityConfig): ClientSessionAction {
    return config.mode;
  }

  return {
    resolve(req, body, format, model, config) {
      if (config.mode === "off") return { source: "none", action: "off", confidence: 0 };

      prune(config);
      const explicit = resolveExplicit(req, body, config);
      if (explicit) return { ...explicit, action: action(config) };

      const canonical = canonicalize(body, format, model);
      if (!canonical) return { source: "none", action: action(config), confidence: 0 };

      const nodeHash = hashJson(canonical.identity);
      const existing = nodes.get(nodeHash);
      if (existing) {
        remember(nodeHash, existing, config);
        return result("lineage", action(config), existing, 0.95);
      }

      const parent = findLinearParent(canonical, nodes);
      if (parent) {
        remember(nodeHash, parent, config);
        return result("lineage", action(config), parent, 0.9);
      }

      const fresh = newSession();
      remember(nodeHash, fresh, config);
      return result("lineage", action(config), fresh, 0.75);
    },
  };
}

export const defaultClientSessionResolver = createClientSessionResolver();

function result(source: ClientSessionSource, action: ClientSessionAction, node: StoredNode, confidence: number): ClientSessionResult {
  return {
    source,
    action,
    confidence,
    sessionId: node.sessionId,
    upstreamSessionId: node.upstreamSessionId,
  };
}

function resolveExplicit(req: Request, body: string | undefined, config: ClientIdentityConfig): ClientSessionResult | null {
  const headerValue = firstHeader(req.headers, ["x-opencode-session", "x-session-id", "x-parent-session-id", "helicone-session-id"]);
  const bodyValue = bodyMetadataSession(body);
  const raw = headerValue ?? bodyValue;
  if (!raw) return null;
  const sessionId = `ses_${hashString(raw).slice(0, 12)}`;
  return {
    source: "explicit",
    action: config.mode,
    confidence: 1,
    sessionId,
    upstreamSessionId: uuidFromHash(raw),
  };
}

function firstHeader(headers: Headers, names: string[]): string | null {
  for (const name of names) {
    const value = headers.get(name);
    if (value && value.trim()) return value.trim();
  }
  return null;
}

function bodyMetadataSession(body: string | undefined): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as any;
    const metadata = parsed?.metadata;
    const raw = metadata?.session_id ?? metadata?.conversation_id;
    return typeof raw === "string" && raw.trim() ? raw.trim() : null;
  } catch {
    return null;
  }
}

function canonicalize(body: string | undefined, format: Format, fallbackModel: string): CanonicalRequest | null {
  if (!body) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const model = typeof parsed.model === "string" ? parsed.model : fallbackModel;
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  if (messages.length === 0) return null;

  const identity = {
    format,
    model,
    system: parsed.system,
    developer: messages.filter((m: any) => m?.role === "developer"),
    tools: parsed.tools,
    tool_choice: parsed.tool_choice,
    messages,
  };
  return { model, identity, messages };
}

function findLinearParent(canonical: CanonicalRequest, nodes: Map<string, StoredNode>): StoredNode | null {
  if (canonical.messages.length < 3) return null;
  const prefix = {
    ...(canonical.identity as Record<string, unknown>),
    messages: canonical.messages.slice(0, -2),
  };
  if ((prefix.messages as unknown[]).length === 0) return null;
  return nodes.get(hashJson(prefix)) ?? null;
}

function newSession(): StoredNode {
  const upstreamSessionId = crypto.randomUUID();
  return {
    nodeHash: "",
    sessionId: `ses_${upstreamSessionId.replace(/-/g, "").slice(0, 12)}`,
    upstreamSessionId,
    lastSeenAt: Date.now(),
  };
}

function hashJson(value: unknown): string {
  return hashString(stableStringify(value));
}

function hashString(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  return String(digest);
}

function uuidFromHash(value: string): string {
  const hex = hashString(value).slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ((parseInt(hex[16] ?? "8", 16) & 0x3) | 0x8).toString(16);
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
