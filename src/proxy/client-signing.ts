/**
 * Client Request Signing V4 — mirrors the ZCode 3.9.1 `ClientRequestSigningV4Signer`.
 *
 * Per-request Ed25519 signatures + proof-of-work over coding-plan traffic.
 * Everything here is fail-open, matching the client: gate disabled/unreachable
 * → unsigned; handshake failure → unsigned; two consecutive 401 VERIFY_*
 * rejections → permanent bypass for that (origin, credential) pair.
 *
 * Start-plan gateway and off-peak LLM paths are permanently exempt (the
 * client's `isUnsignedModelRequestPath` set). Credentials without the
 * `{apiKeyId}.{apiKeySecret}` separator (legacy bigmodel keys issued before
 * the copy endpoint returned secretKeys) are silently skipped — the client
 * hard-throws there; skipping is a deliberate fail-open deviation. Both
 * providers now issue two-part keys, which sign normally.
 *
 * Full protocol: `_reverse/NOTEPAD.md` "Client Request Signing V4".
 */
import type { UpstreamHeaderPair } from "./upstream.js";
import { buildIdentityHeaders } from "./identity.js";
import type { ProxyIdentity } from "../config/types.js";

const DEFAULT_ORIGIN = "https://zcode.z.ai";
const GATE_PATH = "/api/v1/agent/configs";
const HANDSHAKE_PATH = "/api/paas/c1f3a7e2/v2/client";
const APP_ID = "zcode";
const POW_BITS = 8;
const NONCE_BYTES = 16;
const POW_NONCE_BYTES = 12;
const KDF_SALT = "WD_CLIENT_SIGN_KDF_SALT";
const KDF_INFO_HMAC = "getSignKey_hmac";
const KDF_INFO_ED25519 = "ed25519_priv";
const HANDSHAKE_METHOD = "get_sign_key";
const GATE_TTL_MS = 3_600_000;
/** Negative-cache cooldown after a gate fetch network failure. */
const GATE_FAILURE_COOLDOWN_MS = 60_000;
/** Negative-cache cooldown for "unavailable" gate responses (non-2xx / bad envelope). */
const GATE_UNAVAILABLE_COOLDOWN_MS = 30_000;
const GATE_TIMEOUT_MS = 15_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
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
}

export interface SignOutcome {
  pairs: UpstreamHeaderPair[];
  signed: boolean;
}

interface ParsedCredential {
  apiKeyId: string;
  apiKeySecret: string;
}

interface SignerState {
  gateEnabled: boolean;
  gateExpiresAt: number;
  gateNegUntil: number;
  gatePromise?: Promise<boolean>;
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

function parseSigningCredential(credential: string): ParsedCredential | undefined {
  const dot = credential.indexOf(".");
  if (dot <= 0 || dot !== credential.lastIndexOf(".")) return undefined;
  const apiKeyId = credential.slice(0, dot);
  const apiKeySecret = credential.slice(dot + 1);
  if (!apiKeyId.trim() || !apiKeySecret.trim()) return undefined;
  return { apiKeyId, apiKeySecret };
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
  private readonly gateUrl: string;
  private readonly identity: ProxyIdentity;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly states = new Map<string, SignerState>();
  private readonly notedKeys = new Set<string>();
  onEvent?: (message: string) => void;

  constructor(opts: {
    identity: ProxyIdentity;
    origin?: string;
    fetchImpl?: typeof fetch;
    now?: () => number;
    onEvent?: (message: string) => void;
  }) {
    this.gateUrl = `${(opts.origin?.trim() || DEFAULT_ORIGIN).replace(/\/+$/u, "")}${GATE_PATH}`;
    this.identity = opts.identity;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.onEvent = opts.onEvent;
  }

  /**
   * Add the V4 signing headers to an upstream header-pair list. Returns the
   * input pairs unchanged whenever signing does not apply: exempt path,
   * bypass, non-signable credential, missing session id, gate off/unreachable,
   * or handshake failure. Never throws.
   */
  async sign(url: string, pairs: UpstreamHeaderPair[], cred: SigningCredential): Promise<UpstreamHeaderPair[]> {
    return (await this.signWithStatus(url, pairs, cred)).pairs;
  }

  /**
   * `sign` with a `signed` flag so the retry ladder can distinguish
   * "signed but rejected" from "never signed" without identity checks on the
   * returned array reference. Cheap local eligibility checks (credential
   * separator, session id) run BEFORE the gate probe so non-signable
   * credentials never pay for network fetches.
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

    const parsedCred = parseSigningCredential(cred.credential);
    if (!parsedCred) {
      this.noteOnce(stateKey, "credential has no {apiKeyId}.{apiKeySecret} separator — signing skipped");
      return { pairs, signed: false };
    }

    const sessionId = findHeader(pairs, "x-session-id")?.trim();
    if (!sessionId) {
      this.noteOnce(stateKey, "upstream request has no x-session-id — signing skipped");
      return { pairs, signed: false };
    }

    if (!(await this.gateEnabled(state, cred))) return { pairs, signed: false };

    let privateKey: CryptoKey;
    try {
      privateKey = await this.ensurePrivateKey(state, stateKey, parsedCred, parsed.origin);
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
    parsedCred: ParsedCredential,
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
      state = { gateEnabled: false, gateExpiresAt: 0, gateNegUntil: 0, epoch: 0, bypass: false };
      this.states.set(stateKey, state);
    }
    return state;
  }

  private async gateEnabled(state: SignerState, cred: SigningCredential): Promise<boolean> {
    const now = this.now();
    if (state.gateExpiresAt > now) return state.gateEnabled;
    if (state.gateNegUntil > now) return false;
    if (state.gatePromise) return state.gatePromise;
    const promise = this.probeGate(state, cred).finally(() => {
      if (state.gatePromise === promise) state.gatePromise = undefined;
    });
    state.gatePromise = promise;
    return promise;
  }

  private async probeGate(state: SignerState, cred: SigningCredential): Promise<boolean> {
    const now = this.now();
    let outcome: "enabled" | "disabled" | "unavailable";
    try {
      outcome = await this.fetchGate(cred);
    } catch {
      state.gateNegUntil = now + GATE_FAILURE_COOLDOWN_MS;
      return false;
    }
    state.gateEnabled = outcome === "enabled";
    if (outcome === "unavailable") {
      // proxy deviation: the client re-probes unavailable gates on every request
      // from a UI process; on the proxy hot path a short negative cache bounds
      // the worst-case per-request latency to one probe per window
      state.gateNegUntil = now + GATE_UNAVAILABLE_COOLDOWN_MS;
    } else {
      state.gateExpiresAt = now + GATE_TTL_MS;
      state.gateNegUntil = 0;
    }
    if (state.gateEnabled) this.onEvent?.("client-signing: server enabled codingPlanSignature — signing requests");
    return state.gateEnabled;
  }

  private async fetchGate(cred: SigningCredential): Promise<"enabled" | "disabled" | "unavailable"> {
    // sYr (bundle) builds the gate-fetch identity set WITHOUT X-ZCode-Agent and
    // X-Device-Mid; Bxi appends x-api-key only — this fetch carries no Accept header.
    const identityHeaders = Object.fromEntries(
      Object.entries(buildIdentityHeaders(this.identity))
        .filter(([name]) => name !== "X-ZCode-Agent" && name !== "X-Device-Mid"),
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GATE_TIMEOUT_MS);
    try {
      const resp = await this.fetchImpl(this.gateUrl, {
        method: "GET",
        headers: { ...identityHeaders, "x-api-key": cred.credential },
        redirect: "manual",
        signal: controller.signal,
      });
      if (!resp.ok) return "unavailable";
      const parsed = await resp.json() as Record<string, unknown>;
      if (!parsed || parsed.code !== 0) return "unavailable";
      const data = parsed.data as Record<string, unknown> | undefined;
      if (!data || !Object.prototype.hasOwnProperty.call(data, "codingPlanSignature")) return "disabled";
      const signature = data.codingPlanSignature as Record<string, unknown> | undefined;
      return signature?.enable === true ? "enabled" : "disabled";
    } finally {
      clearTimeout(timer);
    }
  }

  private async ensurePrivateKey(
    state: SignerState,
    stateKey: string,
    parsedCred: ParsedCredential,
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

  private async performHandshake(parsedCred: ParsedCredential, origin: string): Promise<CryptoKey> {
    const ts = String(Date.now());
    const nonce = randomHex(NONCE_BYTES);
    const sig = await handshakeSignature(
      parsedCred.apiKeySecret,
      `${HANDSHAKE_METHOD}\n${parsedCred.apiKeyId}\n${ts}\n${nonce}`,
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HANDSHAKE_TIMEOUT_MS);
    try {
      const resp = await this.fetchImpl(`${origin}${HANDSHAKE_PATH}`, {
        method: "POST",
        headers: { Authorization: `${parsedCred.apiKeyId}.${parsedCred.apiKeySecret}`, "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: `${parsedCred.apiKeyId}.${parsedCred.apiKeySecret}`, nonce, sig, ts }),
        redirect: "manual",
        signal: controller.signal,
      });
      if (resp.status !== 200) throw new Error(`handshake_http_${resp.status}`);
      const envelope = await resp.json() as { code?: unknown; msg?: unknown; data?: { privateCipher?: unknown } };
      if (envelope.code === 500) throw new Error("handshake_server_500");
      if (envelope.code !== 200) throw new Error(`handshake_rejected: ${String(envelope.msg)}`);
      const cipher = envelope.data?.privateCipher;
      if (typeof cipher !== "string" || !cipher) throw new Error("handshake_omitted_privateCipher");
      return await decryptSigningPrivateKey(parsedCred.apiKeyId, parsedCred.apiKeySecret, cipher);
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
  const { url, headerPairs, credential, appVersion, send, debug } = params;
  if (!signer) return send(headerPairs);

  const first = await signer.signWithStatus(url, headerPairs, { credential, appVersion });
  let resp = await send(first.pairs);
  if (!first.signed || !await signer.isVerifyFailure(resp)) return resp;

  debug?.("401 VERIFY_SIGNATURE_* — invalidating signing key and retrying once");
  signer.invalidate(url, credential);
  const second = await signer.signWithStatus(url, headerPairs, { credential, appVersion });
  resp = await send(second.pairs);
  if (!second.signed || !await signer.isVerifyFailure(resp)) return resp;

  signer.setBypass(url, credential);
  debug?.("401 VERIFY_SIGNATURE_* twice — sending unsigned (signing bypassed)");
  return send(headerPairs);
}

let defaultSigner: ClientSigningManager | null = null;
let defaultSignerKey = "";

function identityCacheKey(identity: ProxyIdentity): string {
  return JSON.stringify([identity.appVersion, identity.sourceTitle, identity.refererOrigin, identity.deviceMid ?? ""]);
}

/**
 * Process-wide signing manager, shared across requests (gate + key caches).
 * Returns `null` when `clientSigning.enabled` is false. Recreated when the
 * relevant config values change (Android `setConfig`) — keyed on the full
 * identity because the manager embeds it in gate-fetch headers.
 */
export function getDefaultClientSigning(config: {
  clientSigning: { enabled: boolean; origin: string };
  identity: ProxyIdentity;
}): ClientSigningManager | null {
  if (!config.clientSigning.enabled) return null;
  const key = `${config.clientSigning.origin}\n${identityCacheKey(config.identity)}`;
  if (!defaultSigner || key !== defaultSignerKey) {
    defaultSigner = new ClientSigningManager({
      identity: config.identity,
      origin: config.clientSigning.origin,
    });
    defaultSignerKey = key;
  }
  return defaultSigner;
}
