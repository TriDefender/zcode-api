/**
 * Read/write encrypted credentials in ZCode desktop store (~/.zcode/v2/credentials.json).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { dirname, join } from "node:path";

const ENC_PREFIX = "enc:v1:";
const ZCODE_V2_DIR = join(homedir(), ".zcode", "v2");
const CREDENTIALS_FILE = join(ZCODE_V2_DIR, "credentials.json");
const CONFIG_FILE = join(ZCODE_V2_DIR, "config.json");

function deriveKey(): Buffer {
  const fromEnv = process.env.ZCODE_CREDENTIAL_SECRET?.trim();
  let username = "unknown";
  try {
    username = userInfo().username;
  } catch {
    // ignore
  }
  const secret = fromEnv ?? `zcode-credential-fallback:${platform()}:${homedir()}:${username}`;
  return createHash("sha256").update(secret).digest();
}

export function encryptCredential(plaintext: string): string {
  const key = deriveKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

function decryptCredential(value: string): string {
  if (!value.startsWith(ENC_PREFIX)) return value;
  const parts = value.slice(ENC_PREFIX.length).split(".");
  if (parts.length !== 3) throw new Error("Invalid encrypted credential format");
  const [ivB64, tagB64, cipherB64] = parts;
  const key = deriveKey();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(cipherB64, "base64url")),
    decipher.final(),
  ]).toString("utf-8");
}

export function zcodeCredentialsPath(): string {
  return CREDENTIALS_FILE;
}

export function loadZcodeJwtFromDesktop(): string | null {
  if (!existsSync(CREDENTIALS_FILE)) return null;
  const store = JSON.parse(readFileSync(CREDENTIALS_FILE, "utf-8")) as Record<string, string>;
  const raw = store.zcodejwttoken;
  if (!raw) return null;
  return decryptCredential(raw).trim() || null;
}

export interface DesktopCredentialWrite {
  jwt: string;
  accessToken?: string;
  userId?: string;
  /** Full OAuth user object when available (email, avatar, name, …). */
  userInfo?: Record<string, unknown>;
  activeProvider?: string;
}

/** Write OAuth session into ZCode desktop credential store (encrypted). */
export function writeDesktopCredentials(opts: DesktopCredentialWrite): void {
  mkdirSync(dirname(CREDENTIALS_FILE), { recursive: true });

  let store: Record<string, string> = {};
  if (existsSync(CREDENTIALS_FILE)) {
    store = JSON.parse(readFileSync(CREDENTIALS_FILE, "utf-8")) as Record<string, string>;
  }

  store.zcodejwttoken = encryptCredential(opts.jwt);
  if (opts.accessToken) {
    store["oauth:zai:access_token"] = encryptCredential(opts.accessToken);
  }
  const userInfo =
    opts.userInfo ??
    (opts.userId ? { user_id: opts.userId } : undefined);
  if (userInfo) {
    store["oauth:zai:user_info"] = encryptCredential(JSON.stringify(userInfo));
  }
  store["oauth:active_provider"] = encryptCredential(opts.activeProvider ?? "zai");

  writeFileSync(CREDENTIALS_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
}

/** Point builtin:zai-start-plan at the new JWT in config.json. */
export function syncStartPlanConfigJwt(jwt: string): void {
  if (!existsSync(CONFIG_FILE)) return;

  const config = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as {
    provider?: Record<string, { options?: { apiKey?: string } }>;
  };
  const entry = config.provider?.["builtin:zai-start-plan"];
  if (!entry?.options) return;

  entry.options.apiKey = jwt;
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function decodeJwtUserId(jwt: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf-8")) as {
      user_id?: string;
      sub?: string;
    };
    return payload.user_id ?? payload.sub;
  } catch {
    return undefined;
  }
}

/** Round-trip helper for tests. */
export function decryptStoredCredential(enc: string): string {
  return decryptCredential(enc);
}
