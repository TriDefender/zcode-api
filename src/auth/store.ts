/**
 * Encrypted file-based credential store.
 * @see .omo/plans/zcode-proxy.md Task 14
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import type { Credential } from "./types.js";

const STORE_DIR = join(homedir(), ".zcode-proxy");
const STORE_FILE = join(STORE_DIR, "credentials.json");
const ENV_SECRET = "ZCODE_PROXY_CREDENTIAL_SECRET";

/**
 * Derive the AES-GCM key as SHA-256(seed) (audit R2-13). The previous XOR-fold
 * construction was a pseudo-KDF: a seed shorter than 32 bytes left zero blocks
 * in the key. Scope note: on default machine-derived seeds the security gain
 * is ~0 (any same-user process can re-derive the seed either way, 0o600 only
 * stops other users) — the motivation is structural: env-secret deployments
 * (`ZCODE_PROXY_CREDENTIAL_SECRET`) get real 32-byte diffusion, and the
 * misleading "KDF" is gone.
 */
function getEncryptionKey(): Uint8Array {
  const seed = process.env[ENV_SECRET] ?? `${homedir()}-${process.platform}-${process.arch}`;
  return new Uint8Array(createHash("sha256").update(seed, "utf-8").digest());
}

/**
 * Legacy XOR-fold key (pre-SHA-256 store format). Kept ONLY for the one-shot
 * migration decrypt in {@link loadCredential} — never used for new writes.
 */
function getLegacyEncryptionKey(): Uint8Array {
  const hash = new Uint8Array(new ArrayBuffer(32));
  const encoder = new TextEncoder();

  const seed = process.env[ENV_SECRET] ?? `${homedir()}-${process.platform}-${process.arch}`;
  const seedBytes = encoder.encode(seed);
  for (let i = 0; i < seedBytes.length; i++) {
    hash[i % 32] ^= seedBytes[i];
  }
  return hash;
}

/** Atomic store write: temp file (0o600) + rename over the target. */
function atomicWriteStore(contents: string): void {
  const tmp = `${STORE_FILE}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  renameSync(tmp, STORE_FILE);
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  // Copy into a plain ArrayBuffer: bun-types types Uint8Array as
  // ArrayBufferLike, which is not assignable to BufferSource.
  const ab = new ArrayBuffer(raw.byteLength);
  new Uint8Array(ab).set(raw);
  return crypto.subtle.importKey(
    "raw",
    ab,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptWith(key: Uint8Array, plaintext: string): Promise<string> {
  const aesKey = await importAesKey(key);

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoder = new TextEncoder();
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    encoder.encode(plaintext),
  );

  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);

  return Buffer.from(combined).toString("base64");
}

async function decryptWith(key: Uint8Array, ciphertext: string): Promise<string> {
  const aesKey = await importAesKey(key);

  const combined = Buffer.from(ciphertext, "base64");
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    aesKey,
    data,
  );

  return new TextDecoder().decode(decrypted);
}

async function encrypt(plaintext: string): Promise<string> {
  return encryptWith(getEncryptionKey(), plaintext);
}

export async function saveCredential(cred: Credential): Promise<void> {
  mkdirSync(dirname(STORE_FILE), { recursive: true });
  const json = JSON.stringify(cred);
  const encrypted = await encrypt(json);
  atomicWriteStore(JSON.stringify({ encrypted }));
}

export async function loadCredential(): Promise<Credential | null> {
  if (!existsSync(STORE_FILE)) return null;
  const raw = readFileSync(STORE_FILE, "utf-8");
  const parsed = JSON.parse(raw);
  if (!parsed.encrypted) return null;

  let json: string;
  try {
    json = await decryptWith(getEncryptionKey(), parsed.encrypted);
  } catch {
    // Not decryptable under the new SHA-256 KDF — try the legacy XOR-fold key
    // (one-shot migration), then transparently re-store under the new format.
    try {
      json = await decryptWith(getLegacyEncryptionKey(), parsed.encrypted);
    } catch (e) {
      // Stale/corrupt credential file — key derivation is machine-specific
      // ({homedir}-{platform}-{arch}), so cross-machine copies or OS reinstalls
      // produce undecryptable ciphertext. Silently treat as "not logged in".
      console.warn(`Ignoring corrupted or stale credentials at ${STORE_FILE}: ${(e as Error).message}`);
      return null;
    }
    // Re-store under the new KDF. Best-effort by design: the credential is
    // already decrypted in memory, so a failed re-write (read-only dir, AV
    // lock on Windows, ...) must NOT fail this load — it retries next boot.
    try {
      atomicWriteStore(JSON.stringify({ encrypted: await encrypt(json) }));
    } catch (e) {
      console.warn(`Credential re-encryption under the new key derivation failed (will retry on next load): ${(e as Error).message}`);
    }
  }

  try {
    return JSON.parse(json) as Credential;
  } catch (e) {
    console.warn(`Ignoring corrupted credentials at ${STORE_FILE}: ${(e as Error).message}`);
    return null;
  }
}

export function clearCredential(): void {
  if (existsSync(STORE_FILE)) {
    unlinkSync(STORE_FILE);
  }
}

export function getStorePath(): string {
  return STORE_FILE;
}
