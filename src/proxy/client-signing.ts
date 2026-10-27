/**
 * Client Request Signing V4 — mirrors the ZCode 3.12.3 `ClientRequestSigningV4Signer`
 * (bundle `XJe`; handshake `performHandshake`, business sign `sendSigned`, PoW `vQt`,
 * HMAC `hQt`). All four signed message templates join their fields with literal
 * NEWLINES (the bundle templates contain raw `\n` line breaks inside the template
 * literals — verified byte-exact 2026-09-18 by JSON.stringify'ing the raw bundle
 * slice; live-verified: `\n` handshake → 200 + privateCipher, space-joined → rejected):
 *   handshake HMAC   "get_sign_key\n{apiKeyId}\n{ts}\n{nonce}"
 *   business Ed25519 "{apiKeyId}\n{ts}\n{clientVersion}\n{sessionId}\n{nonce}"
 *   PoW challenge    sha256("{apiKeyId}\n{appId}\n{sessionId}\n{ts}") hex[:32]
 *   PoW answer       sha256("{challenge}\n{answer}")
 * Signatures are base64 (`_Qt`), never hex. WARNING for future bundle readers:
 * do not pre-process extraction output with newline-replacing display filters —
 * a 2026-09-18 session briefly "corrected" these to spaces that way.
 *
 * Per-request Ed25519 signatures + proof-of-work over coding-plan traffic.
 * Everything here is fail-open, matching the client: handshake failure →
 * unsigned; two consecutive 401 VERIFY_* rejections → permanent bypass for
 * that (origin, credential) pair.
 *
 * Enablement mirrors ZCode 3.15.1 (`_reverse/NOTEPAD.md` §B): the client no
 * longer probes `agent/configs` for `data.codingPlanSignature` — signing is a
 * static client-side rule (`TUs` requiresClientRequestSigning): coding-plan
 * credentials (individual/team/API-key) are always signed; start-plan,
 * off-peak and highspeed modes are never signed. This proxy applies the same
 * rule structurally: the manager is wired only into the coding-plan request
 * paths, and the client's `isUnsignedModelRequestPath` set below exempts the
 * start-plan gateway + off-peak paths as defense-in-depth. The 3.12.3–3.14.4
 * gate probe (GET /api/v1/agent/configs, 1h TTL) was removed in lockstep.
 *
 * Credentials without the `{apiKeyId}.{apiKeySecret}` separator (legacy
 * bigmodel keys issued before the copy endpoint returned secretKeys) are
 * silently skipped — the client hard-throws there; skipping is a deliberate
 * fail-open deviation. Both providers now issue two-part keys, which sign
 * normally.
 *
 * Full protocol: `_reverse/NOTEPAD.md` "Client Request Signing V4".
 */
import { DEFAULT_APP_VERSION } from "../config/loader.js";
import type { UpstreamHeaderPair } from "./upstream.js";

const HANDSHAKE_PATH = "/api/paas/c1f3a7e2/v2/client";
const APP_ID = "zcode";
const POW_BITS = 8;
const NONCE_BYTES = 16;
const POW_NONCE_BYTES = 12;
const KDF_SALT = "WD_CLIENT_SIGN_KDF_SALT";
const KDF_INFO_HMAC = "getSignKey_hmac";
const KDF_INFO_ED25519 = "ed25519_priv";
const HANDSHAKE_METHOD = "get_sign_key";
const HANDSHAKE_TIMEOUT_MS = 10_000;
/** Negative cache after a failed project-token mint (stale token / biz error). */
const MINT_FAILURE_COOLDOWN_MS = 60_000;
const VERIFY_SIGNATURE_INVALID = "VERIFY_SIGNATURE_INVALID";
const VERIFY_APIKEY_EXPIRED = "VERIFY_APIKEY_EXPIRED";

/** Paths the client never signs (decoded, trailing-slash-stripped). */
const UNSIGNED_PATHS = new Set([
  "/api/v1/zcode-plan/anthropic/v1/messages",
  "/api/v1/zcode-plan/chat/completions",
  "/api/v1/off-peak/anthropic/v1/messages",
]);

const SIGNING_HEADER_NAMES = new Set([
  "x-client-ts",
  "x-client-version",
  "x-client-sig",
  "x-client-nonce",
  "x-app-id",
  "x-client-pow",
  "x-client-sign-verified",
]);

export interface SigningCredential {
  credential: string;
  appVersion: string;
  /**
   * Raw provider OAuth access token (bigmodel OAuth logins). When present the
   * manager mints a project-access JWT (`FSr` accessToken form) for the
   * handshake instead of the `{apiKeyId}.{secret}` form — the official
   * 3.15.1 client signs OAuth-provisioned accounts with that JWT.
   */
  oauthAccessToken?: string;
  provider?: "zai" | "bigmodel";
}

export interface SignOutcome {
  pairs: UpstreamHeaderPair[];
  signed: boolean;
}

/**
 * Dual-form signing credential — mirrors 3.15.1 `FSr`
 * (parseClientSigningCredential):
 * - JWT (3 dot-separated segments): `apiKeyId = payload.api_key`,
 *   `secret = the whole JWT`, handshake body field `accessToken`
 *   (`project_access` token, 5h, minted via `…/access_tokens`).
 * - `{apiKeyId}.{secret}`: handshake body field `apiKey` (Z.AI keys, and
 *   Bigmodel keys when no OAuth token is available).
 */
interface ParsedSigningCredential {
  apiKeyId: string;
  secret: string;
  handshakeField: "apiKey" | "accessToken";
}

interface SignerState {
  privKey?: CryptoKey;
  handshake?: Promise<CryptoKey>;
  epoch: number;
  bypass: boolean;
}

const encoder = new TextEncoder();

type Bytes = Uint8Array<ArrayBuffer>;

function encodeUtf8(value: string): Bytes {
  const bytes = encoder.encode(value);
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(byteCount: number): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(byteCount)));
}

function base64ToBytes(value: string): Bytes {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error("invalid base64");
  }
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function hkdfBytes(secret: string, info: string): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", encodeUtf8(secret), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: encodeUtf8(KDF_SALT), info: encodeUtf8(info) },
    key,
    256,
  ));
}

async function handshakeSignature(secret: string, message: string): Promise<string> {
  const bits = await hkdfBytes(secret, KDF_INFO_HMAC);
  try {
    const key = await crypto.subtle.importKey("raw", bits, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encodeUtf8(message)));
    try {
      return bytesToBase64(mac);
    } finally {
      mac.fill(0);
    }
  } finally {
    bits.fill(0);
  }
}

async function decryptSigningPrivateKey(apiKeyId: string, secret: string, privateCipher: string): Promise<CryptoKey> {
  const cipher = base64ToBytes(privateCipher);
  if (cipher.byteLength <= 12 + 16) throw new Error("privateCipher is too short");
  const aesKeyBits = await hkdfBytes(secret, KDF_INFO_ED25519);
  try {
    const aesKey = await crypto.subtle.importKey("raw", aesKeyBits, "AES-GCM", false, ["decrypt"]);
    const plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: cipher.slice(0, 12), additionalData: encodeUtf8(apiKeyId), tagLength: 128 },
        aesKey,
        cipher.slice(12),
      ),
    );
    try {
      const pkcs8 = base64ToBytes(new TextDecoder().decode(plain));
      return await crypto.subtle.importKey("pkcs8", pkcs8, "Ed25519", false, ["sign"]);
    } finally {
      plain.fill(0);
    }
  } finally {
    aesKeyBits.fill(0);
  }
}

async function signBusinessMessage(privateKey: CryptoKey, message: string): Promise<string> {
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, encodeUtf8(message)));
  try {
    return bytesToBase64(sig);
  } finally {
    sig.fill(0);
  }
}

function hasLeadingZeroBits(bytes: Uint8Array, bits: number): boolean {
  const fullBytes = Math.floor(bits / 8);
  for (let i = 0; i < fullBytes; i++) {
    if (bytes[i] !== 0) return false;
  }
  const remainder = bits % 8;
  if (remainder === 0) return true;
  const mask = (255 << (8 - remainder)) & 255;
  return ((bytes[fullBytes] ?? 255) & mask) === 0;
}

async function createProofOfWork(apiKeyId: string, sessionId: string, ts: string, signal?: AbortSignal): Promise<string> {
  const seedDigest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encodeUtf8(`${apiKeyId}\n${APP_ID}\n${sessionId}\n${ts}`)),
  );
  const seed = bytesToHex(seedDigest).slice(0, 32);
  const nonce = randomHex(POW_NONCE_BYTES);
  for (let counter = 0; counter <= 4_294_967_295; counter++) {
    signal?.throwIfAborted();
    const candidate = `${nonce}${counter.toString(16).padStart(8, "0")}`;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encodeUtf8(`${seed}\n${candidate}`)));
    if (hasLeadingZeroBits(digest, POW_BITS)) return candidate;
  }
  throw new Error("Unable to solve client request proof of work");
}

/**
 * Dual-form credential parse (3.15.1 `FSr`). JWT form: `apiKeyId` comes from
 * the `api_key` payload claim, `secret` is the whole JWT, and the handshake
 * body field switches to `accessToken`.
 */
function parseSigningCredentialForm(credential: string): ParsedSigningCredential | undefined {
  const segments = credential.split(".");
  if (segments.length === 3 && segments[2]) {
    try {
      const decode = (s: string) => JSON.parse(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as Record<string, unknown>;
      const header = decode(segments[0]!) as { alg?: string; typ?: string; sign_type?: string };
      if (header.alg !== "HS256" || header.sign_type !== "SIGN") return undefined;
      const payload = decode(segments[1]!) as { token_use?: string; api_key?: string };
      if (payload.token_use !== "project_access" || typeof payload.api_key !== "string" || !payload.api_key.trim()) return undefined;
      return { apiKeyId: payload.api_key, secret: credential, handshakeField: "accessToken" };
    } catch {
      return undefined;
    }
  }
  const dot = credential.indexOf(".");
  if (dot <= 0 || dot !== credential.lastIndexOf(".")) return undefined;
  const apiKeyId = credential.slice(0, dot);
  const secret = credential.slice(dot + 1);
  if (!apiKeyId.trim() || !secret.trim()) return undefined;
  return { apiKeyId, secret, handshakeField: "apiKey" };
}

function isUnsignedPath(pathname: string): boolean {
  let path = pathname;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    // keep raw path
  }
  path = path.replace(/\/+$/u, "");
  return UNSIGNED_PATHS.has(path);
}

function findHeader(pairs: UpstreamHeaderPair[], name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of pairs) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

export class ClientSigningManager {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly states = new Map<string, SignerState>();
  private readonly notedKeys = new Set<string>();
  /** Cached project-access JWT (bigmodel OAuth): keyed by the api credential. */
  private projectJwt: { credentialKey: string; jwt: string; expMs: number } | null = null;
  /** Negative cache after a failed project-token mint (stale OAuth token etc.). */
  private mintNegUntil = 0;
  private mintInFlight: Promise<ParsedSigningCredential | undefined> | null = null;
  onEvent?: (message: string) => void;

  constructor(opts: {
    fetchImpl?: typeof fetch;
    now?: () => number;
    onEvent?: (message: string) => void;
  } = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.onEvent = opts.onEvent;
  }

  /**
   * Add the V4 signing headers to an upstream header-pair list. Returns the
   * input pairs unchanged whenever signing does not apply: exempt path,
   * bypass, non-signable credential, missing session id, or handshake
   * failure. Never throws.
   */
  async sign(url: string, pairs: UpstreamHeaderPair[], cred: SigningCredential): Promise<UpstreamHeaderPair[]> {
    return (await this.signWithStatus(url, pairs, cred)).pairs;
  }

  /**
   * `sign` with a `signed` flag so the retry ladder can distinguish
   * "signed but rejected" from "never signed" without identity checks on the
   * returned array reference. Cheap local eligibility checks (credential
   * separator, session id) run BEFORE the handshake fetch so non-signable
   * credentials never pay for network round-trips.
   */
  async signWithStatus(url: string, pairs: UpstreamHeaderPair[], cred: SigningCredential): Promise<SignOutcome> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { pairs, signed: false };
    }
    if (parsed.protocol !== "https:") return { pairs, signed: false };
    if (isUnsignedPath(parsed.pathname)) return { pairs, signed: false };
    if (pairs.some(([k]) => k.toLowerCase() === "x-client-sig")) return { pairs, signed: false };

    const stateKey = `${parsed.origin}\n${cred.credential}`;
    const state = this.stateFor(stateKey);
    if (state.bypass) return { pairs, signed: false };

    const parsedCred = await this.resolveParsedCredential(cred, stateKey);
    if (!parsedCred) {
      this.noteOnce(stateKey, "credential has no {apiKeyId}.{apiKeySecret} separator — signing skipped");
      return { pairs, signed: false };
    }

    const sessionId = findHeader(pairs, "x-session-id")?.trim();
    if (!sessionId) {
      this.noteOnce(stateKey, "upstream request has no x-session-id — signing skipped");
      return { pairs, signed: false };
    }

    let privateKey: CryptoKey;
    try {
      privateKey = await this.ensurePrivateKey(state, parsedCred, parsed.origin);
    } catch {
      this.noteOnce(stateKey, "signing handshake failed — sending unsigned");
      this.invalidateState(stateKey);
      return { pairs, signed: false };
    }
    const signedPairs = await this.buildSignedPairs(stateKey, pairs, privateKey, parsedCred, sessionId, cred.appVersion);
    return signedPairs ? { pairs: signedPairs, signed: true } : { pairs, signed: false };
  }

  private async buildSignedPairs(
    stateKey: string,
    pairs: UpstreamHeaderPair[],
    privateKey: CryptoKey,
    parsedCred: ParsedSigningCredential,
    sessionId: string,
    appVersion: string,
  ): Promise<UpstreamHeaderPair[] | null> {
    const ts = String(Date.now());
    const nonce = randomHex(NONCE_BYTES);
    let pow: string;
    let sig: string;
    try {
      pow = await createProofOfWork(parsedCred.apiKeyId, sessionId, ts);
      sig = await signBusinessMessage(
        privateKey,
        `${parsedCred.apiKeyId}\n${ts}\n${appVersion}\n${sessionId}\n${nonce}`,
      );
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        this.noteOnce(stateKey, `signing failed (${(err as Error).message}) — sending unsigned`);
      }
      return null;
    }
    const cleaned = pairs.filter(([k]) => {
      const lower = k.toLowerCase();
      return !SIGNING_HEADER_NAMES.has(lower) && lower !== "x-session-id";
    });
    return [
      ...cleaned,
      ["X-Client-Ts", ts],
      ["X-Client-Version", appVersion],
      ["X-Client-Sig", sig],
      // canonical case replaces the lowercase trace copy in this append position
      // (mirrors the client's i.set("X-Session-Id") Headers.set semantics)
      ["X-Session-Id", sessionId],
      ["X-Client-Nonce", nonce],
      ["X-App-Id", APP_ID],
      ["X-Client-Pow", pow],
    ];
  }

  /**
   * True when the response is a signing rejection the client retries on:
   * HTTP 401 whose envelope mentions VERIFY_SIGNATURE_INVALID / VERIFY_APIKEY_EXPIRED.
   * Reads a clone; the response body stays consumable by the caller.
   */
  async isVerifyFailure(resp: Response): Promise<boolean> {
    if (resp.status !== 401) return false;
    try {
      const body = await resp.clone().json() as Record<string, unknown>;
      if (!body || typeof body !== "object" || Array.isArray(body)) return false;
      const data = body.data as Record<string, unknown> | undefined;
      const error = body.error as Record<string, unknown> | undefined;
      const candidates = [body.msg, body.reason, data?.reason, error?.reason, error?.message];
      return candidates.some((v) => v === VERIFY_SIGNATURE_INVALID || v === VERIFY_APIKEY_EXPIRED);
    } catch {
      return false;
    }
  }

  /** Drop the cached signing key for a (origin, credential) pair after a VERIFY rejection. */
  invalidate(url: string, credential: string): void {
    try {
      const stateKey = `${new URL(url).origin}\n${credential}`;
      this.invalidateState(stateKey);
    } catch {
      // unreachable URL — nothing cached under it
    }
  }

  /** Permanently stop signing for a (origin, credential) pair (two VERIFY rejections). */
  setBypass(url: string, credential: string): void {
    try {
      const stateKey = `${new URL(url).origin}\n${credential}`;
      const state = this.stateFor(stateKey);
      state.bypass = true;
      this.invalidateState(stateKey);
      this.onEvent?.("client-signing: VERIFY rejection persisted — bypassing signing for this credential");
    } catch {
      // unreachable URL
    }
  }

  private invalidateState(stateKey: string): void {
    const state = this.states.get(stateKey);
    if (!state) return;
    state.epoch += 1;
    state.privKey = undefined;
    state.handshake = undefined;
  }

  private stateFor(stateKey: string): SignerState {
    let state = this.states.get(stateKey);
    if (!state) {
      state = { epoch: 0, bypass: false };
      this.states.set(stateKey, state);
    }
    return state;
  }

  /**
   * Resolve the signing credential form. Bigmodel OAuth logins mint a
   * project-access JWT from the raw OAuth token (live-verified 2026-10-12:
   * the apiKey form handshakes 200 but its privateCipher can never be
   * decrypted on bigmodel) and cache it until 5 minutes before the JWT exp.
   * Any mint failure falls back to the apiKey form (unsigned via the usual
   * ladder). Z.AI keys pass through unchanged (apiKey form, live-verified).
   */
  private async resolveParsedCredential(cred: SigningCredential, stateKey: string): Promise<ParsedSigningCredential | undefined> {
    const direct = parseSigningCredentialForm(cred.credential);
    if (direct?.handshakeField === "accessToken") return direct;
    if (!cred.oauthAccessToken || cred.provider !== "bigmodel") return direct;

    const now = this.now();
    if (this.projectJwt && this.projectJwt.credentialKey === cred.credential && this.projectJwt.expMs - 5 * 60_000 > now) {
      const cached = parseSigningCredentialForm(this.projectJwt.jwt);
      if (cached) return cached;
      this.projectJwt = null; // stale/malformed cache entry — fall through to a fresh mint
    }
    if (now < this.mintNegUntil) return direct;
    if (this.mintInFlight) return this.mintInFlight;

    const promise = this.mintProjectJwt(cred.oauthAccessToken, direct?.apiKeyId)
      .then((minted) => {
        if (!minted) {
          // negative-cache so a stale OAuth token can't burn two doomed
          // fetches on every request (mirrors the highspeed manager's gate)
          this.mintNegUntil = this.now() + MINT_FAILURE_COOLDOWN_MS;
          return direct;
        }
        const parsed = parseSigningCredentialForm(minted.jwt);
        if (!parsed) {
          // strict parse rejected the minted token — don't cache it, don't
          // disable signing; the apiKey form stays available
          this.mintNegUntil = this.now() + MINT_FAILURE_COOLDOWN_MS;
          this.noteOnce("pt-parse", "minted project token failed strict parse — falling back to apiKey form");
          return direct;
        }
        this.projectJwt = { credentialKey: cred.credential, jwt: minted.jwt, expMs: minted.expMs };
        // the private key is keyed to the previous secret — force a re-handshake
        this.invalidateState(stateKey);
        return parsed;
      })
      .finally(() => {
        if (this.mintInFlight === promise) this.mintInFlight = null;
      });
    this.mintInFlight = promise;
    return promise;
  }

  /**
   * Mirror of the 3.15.1 ProjectAccessTokenClient: getCustomerInfo (bare
   * OAuth token — no Bearer on bigmodel) resolves the default org/project
   * (name contains 默认机构/默认项目 preferred, else first, projectType "2"
   * excluded), then `…/api_keys/{apiKeyId}/access_tokens` (Bearer) mints the
   * `project_access` JWT.
   */
  private async mintProjectJwt(oauthAccessToken: string, apiKeyId: string | undefined): Promise<{ jwt: string; expMs: number } | null> {
    if (!apiKeyId) {
      this.noteOnce("pt-key", "project token mint skipped: credential has no apiKeyId segment");
      return null;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const bare = oauthAccessToken.startsWith("Bearer ") ? oauthAccessToken.slice(7).trim() : oauthAccessToken;
      const infoResp = await this.fetchImpl("https://bigmodel.cn/api/biz/customer/getCustomerInfo", {
        headers: { Authorization: bare, "Content-Type": "application/json" },
        redirect: "manual",
        signal: controller.signal,
      });
      const info = await infoResp.json() as {
        data?: {
          organizations?: Array<{
            organizationId?: string; organizationName?: string;
            projects?: Array<{ projectId?: string; projectName?: string; projectType?: string | number }>;
          }>;
        };
      };
      const orgs = (info.data?.organizations ?? [])
        .map((o) => ({ ...o, projects: (o.projects ?? []).filter((p) => String(p.projectType ?? "").trim() !== "2") }))
        .filter((o) => o.organizationId && o.projects.length > 0);
      const org = orgs.find((o) => o.organizationName?.includes("默认机构")) ?? orgs[0];
      const project = org?.projects.find((p) => p.projectName?.includes("默认项目")) ?? org?.projects[0];
      if (!org?.organizationId || !project?.projectId) {
        this.noteOnce("pt-project", "project token mint failed: no usable org/project in getCustomerInfo (re-login may help)");
        return null;
      }
      const ptResp = await this.fetchImpl(`https://bigmodel.cn/api/biz/v1/organization/${encodeURIComponent(org.organizationId)}/projects/${encodeURIComponent(project.projectId)}/api_keys/${encodeURIComponent(apiKeyId)}/access_tokens`, {
        method: "POST",
        headers: { Authorization: `Bearer ${bare}`, "Content-Type": "application/json" },
        body: JSON.stringify({ clientType: "zcode", clientVersion: DEFAULT_APP_VERSION }),
        redirect: "manual",
        signal: controller.signal,
      });
      const pt = await ptResp.json() as { code?: number; data?: { accessToken?: string; enabled?: boolean } };
      const jwt = pt.data?.accessToken;
      if (pt.code !== 200 || !jwt) {
        this.noteOnce("pt-mint", `project token mint rejected (code=${pt.code ?? ptResp.status})`);
        return null;
      }
      let expMs = this.now() + 60 * 60_000;
      try {
        const payload = JSON.parse(Buffer.from(jwt.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as { exp?: number };
        if (typeof payload.exp === "number") expMs = payload.exp * 1000;
      } catch { /* keep fallback expiry */ }
      this.noteOnce("pt-ok", "project access token minted — signing with the accessToken (JWT) form");
      return { jwt, expMs };
    } catch {
      this.noteOnce("pt-network", "project token mint failed (network/timeout)");
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async ensurePrivateKey(
    state: SignerState,
    parsedCred: ParsedSigningCredential,
    origin: string,
  ): Promise<CryptoKey> {
    if (state.privKey) return state.privKey;
    if (state.handshake) return state.handshake;
    const epoch = state.epoch;
    const handshake = this.performHandshake(parsedCred, origin).then((key) => {
      if (state.epoch !== epoch) throw new Error("signing key changed during handshake");
      state.privKey = key;
      return key;
    });
    const clear = () => {
      if (state.handshake === handshake) state.handshake = undefined;
    };
    handshake.then(clear, clear);
    state.handshake = handshake;
    return handshake;
  }

  private async performHandshake(parsedCred: ParsedSigningCredential, origin: string): Promise<CryptoKey> {
    const ts = String(Date.now());
    const nonce = randomHex(NONCE_BYTES);
    const sig = await handshakeSignature(
      parsedCred.secret,
      `${HANDSHAKE_METHOD}\n${parsedCred.apiKeyId}\n${ts}\n${nonce}`,
    );

    // accessToken form (project_access JWT): Bearer auth + accessToken body
    // field, live-verified 2026-10-12; apiKey form keeps the bare
    // `{id}.{secret}` auth and the full string as the apiKey body value.
    const authHeader = parsedCred.handshakeField === "accessToken"
      ? `Bearer ${parsedCred.secret}`
      : `${parsedCred.apiKeyId}.${parsedCred.secret}`;
    const authValue = parsedCred.handshakeField === "accessToken"
      ? parsedCred.secret
      : `${parsedCred.apiKeyId}.${parsedCred.secret}`;
    const bodyKey = parsedCred.handshakeField === "accessToken" ? "accessToken" : "apiKey";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HANDSHAKE_TIMEOUT_MS);
    try {
      const resp = await this.fetchImpl(`${origin}${HANDSHAKE_PATH}`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ [bodyKey]: authValue, nonce, sig, ts }),
        redirect: "manual",
        signal: controller.signal,
      });
      if (resp.status !== 200) throw new Error(`handshake_http_${resp.status}`);
      const envelope = await resp.json() as { code?: unknown; msg?: unknown; data?: { privateCipher?: unknown } };
      if (envelope.code === 500) throw new Error("handshake_server_500");
      if (envelope.code !== 200) throw new Error(`handshake_rejected: ${String(envelope.msg)}`);
      const cipher = envelope.data?.privateCipher;
      if (typeof cipher !== "string" || !cipher) throw new Error("handshake_omitted_privateCipher");
      return await decryptSigningPrivateKey(parsedCred.apiKeyId, parsedCred.secret, cipher);
    } finally {
      clearTimeout(timer);
    }
  }

  private noteOnce(stateKey: string, message: string): void {
    if (this.notedKeys.has(stateKey)) return;
    this.notedKeys.add(stateKey);
    this.onEvent?.(`client-signing: ${message}`);
  }
}

export interface SendWithSigningParams {
  url: string;
  headerPairs: UpstreamHeaderPair[];
  credential: string;
  appVersion: string;
  /** Raw provider OAuth token — enables the project-access JWT signing form (bigmodel). */
  oauthAccessToken?: string;
  provider?: "zai" | "bigmodel";
  send: (headerPairs: UpstreamHeaderPair[]) => Promise<Response>;
  debug?: (message: string) => void;
}

/**
 * Send with the client's full signing retry ladder:
 * signed → on 401 VERIFY: re-handshake + re-sign → on second 401 VERIFY:
 * permanent bypass + unsigned. A `null` manager (feature disabled) sends as-is.
 */
export async function sendWithClientSigning(
  signer: ClientSigningManager | null,
  params: SendWithSigningParams,
): Promise<Response> {
  const { url, headerPairs, credential, appVersion, oauthAccessToken, provider, send, debug } = params;
  if (!signer) return send(headerPairs);

  const signingCred = { credential, appVersion, ...(oauthAccessToken ? { oauthAccessToken } : {}), ...(provider ? { provider } : {}) };
  const first = await signer.signWithStatus(url, headerPairs, signingCred);
  let resp = await send(first.pairs);
  if (!first.signed || !await signer.isVerifyFailure(resp)) return resp;

  debug?.("401 VERIFY_SIGNATURE_* — invalidating signing key and retrying once");
  signer.invalidate(url, credential);
  const second = await signer.signWithStatus(url, headerPairs, signingCred);
  resp = await send(second.pairs);
  if (!second.signed || !await signer.isVerifyFailure(resp)) return resp;

  signer.setBypass(url, credential);
  debug?.("401 VERIFY_SIGNATURE_* twice — sending unsigned (signing bypassed)");
  return send(headerPairs);
}

let defaultSigner: ClientSigningManager | null = null;

/**
 * Process-wide signing manager, shared across requests (handshake key caches).
 * Returns `null` when `clientSigning.enabled` is false. The manager holds no
 * config-derived state (3.15.1 removed the agent/configs gate), so a single
 * instance serves every request regardless of identity/config churn.
 */
export function getDefaultClientSigning(config: {
  clientSigning: { enabled: boolean };
}): ClientSigningManager | null {
  if (!config.clientSigning.enabled) return null;
  if (!defaultSigner) {
    defaultSigner = new ClientSigningManager({
      // Fail-open decisions (handshake failure, VERIFY bypass) are otherwise
      // silent in production — surface each once per (origin, cred).
      onEvent: (message) => console.log(message),
    });
  }
  return defaultSigner;
}
