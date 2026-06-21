/**
 * Multi-account pool for start-plan JWT rotation (~/.zcode-proxy/accounts.json).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Credential } from "./types.js";
import type { ProviderId } from "../provider/types.js";
import { loadCredential } from "./store.js";
import { decodeJwtUserId } from "./zcode-credentials.js";

export type AccountStatus = "active" | "exhausted" | "blocked" | "disabled";

export interface PoolAccount {
  id: string;
  name: string;
  provider: ProviderId;
  jwt: string;
  apiKey?: string;
  userId?: string;
  status: AccountStatus;
  enabled: boolean;
  addedAt: string;
  lastUsedAt: string | null;
  lastError: string | null;
  usageCount: number;
}

interface AccountsFile {
  accounts: PoolAccount[];
}

const STORE_DIR = join(homedir(), ".zcode-proxy");
const ACCOUNTS_FILE = join(STORE_DIR, "accounts.json");

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  return randomBytes(6).toString("hex");
}

export function getAccountsStorePath(): string {
  return ACCOUNTS_FILE;
}

export class AccountPool {
  private accounts = new Map<string, PoolAccount>();
  private roundRobinIndex = 0;

  constructor() {
    this.load();
  }

  private load(): void {
    if (!existsSync(ACCOUNTS_FILE)) return;
    try {
      const data = JSON.parse(readFileSync(ACCOUNTS_FILE, "utf-8")) as AccountsFile;
      for (const entry of data.accounts ?? []) {
        if (entry.jwt?.trim()) {
          this.accounts.set(entry.id, { ...entry, jwt: entry.jwt.trim() });
        }
      }
    } catch (err) {
      console.error("[pool] failed to load accounts:", err);
    }
  }

  persist(): void {
    mkdirSync(dirname(ACCOUNTS_FILE), { recursive: true });
    const data: AccountsFile = { accounts: [...this.accounts.values()] };
    const tmp = `${ACCOUNTS_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, ACCOUNTS_FILE);
  }

  /** Import legacy single credential from ~/.zcode-proxy/credentials.json once. */
  async migrateFromLegacyCredential(): Promise<boolean> {
    if (this.accounts.size > 0) return false;
    const cred = await loadCredential();
    if (!cred?.jwt?.trim()) return false;
    this.addFromCredential(cred);
    return true;
  }

  size(): number {
    return this.accounts.size;
  }

  activeCount(): number {
    return this.listSelectable().length;
  }

  list(): PoolAccount[] {
    return [...this.accounts.values()].sort((a, b) => a.addedAt.localeCompare(b.addedAt));
  }

  listPublic(): Array<Omit<PoolAccount, "jwt" | "apiKey"> & { jwtPrefix: string }> {
    return this.list().map(({ jwt, apiKey: _apiKey, ...rest }) => ({
      ...rest,
      jwtPrefix: `${jwt.slice(0, 16)}...`,
    }));
  }

  get(id: string): PoolAccount | undefined {
    return this.accounts.get(id);
  }

  addFromCredential(cred: Credential): string {
    const jwt = cred.jwt?.trim();
    if (!jwt) throw new Error("Credential has no start-plan JWT");

    const existing = this.list().find((a) => a.jwt === jwt);
    if (existing) {
      existing.apiKey = cred.apiKey;
      existing.userId = cred.userId ?? existing.userId;
      existing.name = cred.userId ?? existing.name;
      existing.status = "active";
      existing.enabled = true;
      existing.lastError = null;
      this.persist();
      return existing.id;
    }

    const id = newId();
    const userId = cred.userId ?? decodeJwtUserId(jwt);
    const entry: PoolAccount = {
      id,
      name: userId ?? id,
      provider: cred.provider,
      jwt,
      apiKey: cred.apiKey,
      userId: cred.userId,
      status: "active",
      enabled: true,
      addedAt: nowIso(),
      lastUsedAt: null,
      lastError: null,
      usageCount: 0,
    };
    this.accounts.set(id, entry);
    this.persist();
    return id;
  }

  remove(id: string): boolean {
    const ok = this.accounts.delete(id);
    if (ok) this.persist();
    return ok;
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const entry = this.accounts.get(id);
    if (!entry) return false;
    entry.enabled = enabled;
    if (enabled && entry.status !== "blocked") entry.status = "active";
    this.persist();
    return true;
  }

  clear(): void {
    this.accounts.clear();
    this.persist();
  }

  private listSelectable(excludeIds: string[] = []): PoolAccount[] {
    const exclude = new Set(excludeIds);
    return this.list().filter(
      (a) => a.enabled && a.status === "active" && a.jwt.length > 0 && !exclude.has(a.id),
    );
  }

  acquire(excludeIds: string[] = []): PoolAccount | null {
    const candidates = this.listSelectable(excludeIds);
    if (candidates.length === 0) return null;
    const idx = this.roundRobinIndex % candidates.length;
    this.roundRobinIndex += 1;
    return candidates[idx];
  }

  release(id: string): void {
    const entry = this.accounts.get(id);
    if (!entry) return;
    entry.usageCount += 1;
    entry.lastUsedAt = nowIso();
    this.persist();
  }

  markExhausted(id: string, message: string): void {
    const entry = this.accounts.get(id);
    if (!entry) return;
    entry.status = "exhausted";
    entry.lastError = message;
    this.persist();
  }

  /** Restore an exhausted account to the rotation pool. */
  markActive(id: string): boolean {
    const entry = this.accounts.get(id);
    if (!entry || entry.status === "blocked" || !entry.enabled) return false;
    if (entry.status === "active") return true;
    entry.status = "active";
    entry.lastError = null;
    this.persist();
    return true;
  }

  markBlocked(id: string, message: string): void {
    const entry = this.accounts.get(id);
    if (!entry) return;
    entry.status = "blocked";
    entry.enabled = false;
    entry.lastError = message;
    this.persist();
  }

  markAuthError(id: string, message: string): void {
    const entry = this.accounts.get(id);
    if (!entry) return;
    entry.status = "disabled";
    entry.lastError = message;
    this.persist();
  }

  toCredential(account: PoolAccount): Credential {
    return {
      apiKey: account.apiKey ?? "start-plan",
      provider: account.provider,
      jwt: account.jwt,
      userId: account.userId,
    };
  }
}
