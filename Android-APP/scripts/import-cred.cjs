const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const seed = process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
if (!seed) { console.error("ZCODE_PROXY_CREDENTIAL_SECRET not set"); process.exit(1); }

const apiKey = process.argv[2];
const provider = process.argv[3] || "bigmodel";
if (!apiKey) { console.error("Usage: import-cred.cjs <apiKey> [provider]"); process.exit(1); }

const dotIdx = apiKey.indexOf(".");
const cred = dotIdx > 0 && dotIdx < apiKey.length - 1
  ? { apiKey: apiKey.slice(0, dotIdx), secret: apiKey.slice(dotIdx + 1), provider }
  : { apiKey, provider };

const keyBytes = new Uint8Array(32);
const seedBytes = new TextEncoder().encode(seed);
for (let i = 0; i < seedBytes.length; i++) keyBytes[i % 32] ^= seedBytes[i];

const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv("aes-256-gcm", keyBytes, iv);
const plaintext = Buffer.from(JSON.stringify(cred), "utf-8");
const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
const tag = cipher.getAuthTag();
const combined = Buffer.concat([iv, encrypted, tag]);

const storeDir = path.join(os.homedir(), ".zcode-proxy");
fs.mkdirSync(storeDir, { recursive: true });
const storeFile = path.join(storeDir, "credentials.json");
fs.writeFileSync(storeFile, JSON.stringify({ encrypted: combined.toString("base64") }), { mode: 0o600 });
console.log("Credential saved to", storeFile);
console.log("Provider:", cred.provider, "Key:", cred.apiKey.substring(0, 12) + "...");
