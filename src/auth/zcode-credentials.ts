/**
 * Read encrypted JWT from ZCode desktop credentials (~/.zcode/v2/credentials.json).
 * Same scheme as zcode-pool / ZCode Electron store.
 */
import { createDecipheriv, createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { join } from "node:path";

const ENC_PREFIX = "enc:v1:";

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

export function loadZcodeJwtFromDesktop(): string | null {
  const file = join(homedir(), ".zcode", "v2", "credentials.json");
  if (!existsSync(file)) return null;
  const store = JSON.parse(readFileSync(file, "utf-8")) as Record<string, string>;
  const raw = store.zcodejwttoken;
  if (!raw) return null;
  return decryptCredential(raw).trim() || null;
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
