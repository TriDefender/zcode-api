/**
 * native_solve2.js — profile-driven pure-HTTP Aliyun NoCaptcha solver.
 *
 * ROTATION-RESISTANT DESIGN:
 *   Everything the risk engine structurally validates is harvested from
 *   PASSING happy-dom sessions by capture_native_profile.js and stored in a
 *   profile JSON (see /tmp/native-profiles or NATIVE_PROFILE). The solver
 *   regenerates fresh sessions in that shape — nothing about the current
 *   bundle's expectations is hardcoded beyond the (so-far-stable) signing
 *   keys and the wire protocol itself.
 *
 * Today's protocol (verified from live passing captures, 2026-08-22):
 *   Init → (cert + DeviceConfig: tokenKey, mid, serverIp)
 *   ~150-450ms later: Log3, UploadLog, Log2 fired back-to-back (~2ms apart)
 *   Verify ~1-3ms after Log2. NO Log1. Log2 now goes to device.saf host.
 *   W[43] DC matrix carries literal NaN values and passes.
 *
 * Usage:
 *   node native_solve2.js                # solve once, print JSON
 *   NATIVE_PROFILE=/path/profile.json    # explicit profile (else newest in dir)
 *   NATIVE_PROFILE_DIR=/tmp/native-profiles
 */
"use strict";

const crypto = require("crypto");
const https = require("https");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { request: undiciRequest } = require("undici");
const origFetch = global.fetch;

const SCENE = "11xygtvd";
const VERIFY_KEY = "222aiJodos2938JDdosko2djd82sf0&";
const LOG_KEY = "DuanemHmyeE6LXCC46sJEDUw5DTlSZ&";
const AADUANE = "111jdk439dJJIjd023823201";
const LOG_AADUANE = "DuaneAprqkYsF3nt1yjK29Bf";
const INIT_URL = "https://no8xfe.captcha-open-southeast.aliyuncs.com/";
const VERIFY_URL = "https://no8xfe-verify.captcha-open-southeast.aliyuncs.com/";
const UPLOAD_URL = "https://upload.captcha-open-southeast.aliyuncs.com/";
// Current-era Log2 host (rotated away from cloudauth-device; Log3 stays there).
const LOG3_URL = "https://cloudauth-device-dualstack.ap-southeast-1.aliyuncs.com/";
const LOG2_URL = "https://ap-southeast-1.device.saf.aliyuncs.com/";
const IV = Buffer.from("0123456789ABCDEF");
const CONF_KEY = Buffer.from("87f879f135f27da7");
const WEB_FLAG_KEY = Buffer.from("a549a55c60a39aa0");
const INIT_DEVICE_DATA_CONST =
  "TEQYvgJq1LrMqFaBybfIzPxz2ygFyAct7X/w+LacfXWd9rGSwE/x6ZCONucD1fehuJdn/1eqeR0DPqjDoh7DP7j1GLPmBohgT/1vG1SmPu/2HiPf4AvsoZhKQpp33G7xYkh1oJKuT+89UgvvVdCOREp4SrT9vDuovvZSF7BhjrRLbVaYLPYzmgW/jReYy/RU";
const DD_TEMPLATE_PREFIX = "3795d28242a11619bc25f786f84e53d4#W#";

// ── h2d blob cipher (same as native_solve.js) ──────────────────────────────
const _SBOX_RAW = [
  1, 32, 50, 10, 51, 6, 44, 37, 16, 46, 11, 62, 19, 43, 25, 23, 30, 60, 53, 34,
  7, 26, 12, 48, 5, 2, 20, 4, 61, 13, 47, 49, 29, 27, 22, 17, 39, 56, 41, 38,
  55, 31, 15, 58, 52, 40, 8, 57, 45, 35, 59, 36, 42, 54, 63, 3, 24, 28, 14, 9,
  21,
];
function buildSbox() {
  return [
    ..._SBOX_RAW.slice(1, 18), 33, ..._SBOX_RAW.slice(18, 32), 18,
    ..._SBOX_RAW.slice(32, 35), 1, ..._SBOX_RAW.slice(35, 60), 0, 21,
  ];
}
function ksa(keyStr) {
  const S = buildSbox();
  let t = 0;
  for (let o = 0; o < 64; o++) {
    t = (((o + t + S[o] + S[t]) >> 1) + keyStr.charCodeAt(o % keyStr.length)) & 63;
    if (t !== o) { const tmp = S[o]; S[o] = S[t]; S[t] = tmp; }
  }
  return S;
}
function h2dCrypt(data, S, invert) {
  S = [...S];
  let e = 0, a = 0;
  const out = Buffer.alloc(data.length);
  for (let n = 0; n < data.length; n++) {
    a = ((e ^ a) + (S[e] ^ S[a])) & 63;
    if (a !== e) { const t = S[e]; S[e] = S[a]; S[a] = t; }
    const x = S[e] + S[a];
    const y = S[x & 63];
    let m = data[n];
    if (invert) m = ((m ^ x ^ y) + (S[a] + a) - e - S[e]) & 255;
    else m = (((m + e + S[e]) - (S[a] + a)) ^ x ^ y) & 255;
    out[n] = m;
    e = (e + 1) & 63;
  }
  return out;
}

// ── crypto helpers ─────────────────────────────────────────────────────────
function aesEnc(key, pt) {
  const c = crypto.createCipheriv("aes-128-cbc", key, IV);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(pt), c.final()]);
}
function pkcs7(buf) {
  const pad = 16 - (buf.length % 16);
  return Buffer.concat([buf, Buffer.alloc(pad, pad)]);
}
function unpad(buf) {
  const pad = buf[buf.length - 1];
  return pad >= 1 && pad <= 16 ? buf.slice(0, buf.length - pad) : buf;
}
function aesDec(key, ct) {
  const c = crypto.createDecipheriv("aes-128-cbc", key, IV);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(ct), c.final()]);
}
function decryptConfig(b64) {
  return unpad(aesDec(CONF_KEY, Buffer.from(b64, "base64"))).toString("utf8");
}
function randomHex(len) {
  return crypto.randomBytes(len / 2).toString("hex").slice(0, len);
}
function uuidV4Hex() {
  const b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  return b.toString("hex");
}
function tsNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
function pct(s) { return encodeURIComponent(String(s)); }
function sign(params, key) {
  const canon = Object.keys(params)
    .sort()
    .map((k) => `${pct(k)}=${pct(params[k])}`)
    .join("&");
  const sts = "POST&%2F&" + pct(canon);
  return crypto.createHmac("sha1", key).update(sts).digest("base64");
}

// ── profile loading (rotation resistance) ──────────────────────────────────
function loadProfiles() {
  const dir = process.env.NATIVE_PROFILE_DIR || "/tmp/native-profiles";
  let files = [];
  try {
    files = fs.readdirSync(dir)
      .filter((f) => /^profile-.*\.json$/.test(f) && !f.includes(".raw."))
      .map((f) => path.join(dir, f))
      .sort();
  } catch (_) {}
  if (process.env.NATIVE_PROFILE) files.push(process.env.NATIVE_PROFILE);
  const profs = files
    .map((f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { return null; } })
    .filter((p) => p && p.w && Array.isArray(p.w) && p.w.length >= 88);
  if (profs.length === 0) {
    throw new Error(
      "no profiles found — run: cd captcha_node && node capture_native_profile.js 8 " +
      "(the native solver needs harvested passing-session profiles)",
    );
  }
  return profs;
}

// ── request layer (raw undici: no sec-fetch headers, like jsdom XHR) ───────
const BROWSER_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  "sec-ch-ua": '"Chromium";v="127", "Not)A;Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Linux"',
  "accept-language": "en-US,en;q=0.9",
};
const cookieJar = new Map();
function cookieHeader(host) {
  const m = cookieJar.get(host);
  if (!m || m.size === 0) return null;
  return [...m.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
function absorbCookies(host, setCookie) {
  if (!setCookie) return;
  const entries = Array.isArray(setCookie) ? setCookie : [setCookie];
  let m = cookieJar.get(host);
  if (!m) { m = new Map(); cookieJar.set(host, m); }
  for (const raw of entries) {
    const first = raw.split(";")[0].trim();
    const eq = first.indexOf("=");
    if (eq > 0) m.set(first.slice(0, eq), first.slice(eq + 1));
  }
}
let _httpDispatcher = null;
function dispatcher() {
  if (_httpDispatcher) return _httpDispatcher;
  // Native requests stay DIRECT (they are not WAF-blocked; the proxy only
  // wraps the LLM POST). NATIVE_PROXY overrides for testing.
  const proxyUrl = process.env.NATIVE_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (proxyUrl) {
    try {
      const { ProxyAgent } = require("undici");
      _httpDispatcher = new ProxyAgent(proxyUrl);
    } catch (_) { _httpDispatcher = undefined; }
  }
  return _httpDispatcher;
}
async function post(url, params, key) {
  const p = { ...params, Signature: sign(params, key) };
  const body = Object.keys(p).map((k) => `${pct(k)}=${pct(p[k])}`).join("&");
  const u = new URL(url);
  // EXACTLY the headers the passing happy sessions send (captured on the
  // undici fetch call): fetch-spec headers (sec-fetch-mode, accept,
  // accept-encoding, content-length) are added by undici itself — do not
  // set them manually or the HTTP/2 fingerprint diverges from the SDK's.
  const headers = {
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "sec-ch-ua": '"Chromium";v="127", "Not)A;Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Linux"',
    "user-agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
    "accept-language": "en-US,en;q=0.9",
    referer: "https://zcode.z.ai/",
    origin: "https://zcode.z.ai",
  };
  const ck = cookieHeader(u.hostname);
  if (ck && process.env.NATIVE_NO_COOKIES !== "1") headers.cookie = ck;
  const opts = { method: "POST", headers, body };
  const d = dispatcher();
  if (d) opts.dispatcher = d;
  // Note: the local undici 8.x ProxyAgent is incompatible with node's global
  // fetch dispatcher protocol ("invalid onRequestStart"). When proxying, use
  // the local undici's own request(); otherwise global fetch (happy parity).
  let res;
  if (d) {
    const { request } = require("undici");
    res = await request(u, opts);
  } else {
    res = await origFetch(u, opts);
  }
  let raw;
  if (res.body && typeof res.body.arrayBuffer === "function") {
    raw = Buffer.from(await res.body.arrayBuffer());
  } else if (typeof res.arrayBuffer === "function") {
    raw = Buffer.from(await res.arrayBuffer());
  } else {
    raw = Buffer.from([]);
  }
  const ce = String(
    (res.headers.get ? res.headers.get("content-encoding") : res.headers["content-encoding"]) || "",
  ).toLowerCase();
  if (ce === "gzip") raw = zlib.gunzipSync(raw);
  else if (ce === "deflate") raw = zlib.inflateSync(raw);
  const scRaw = d
    ? res.headers["set-cookie"]
    : typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [];
  if (scRaw) absorbCookies(u.hostname, Array.isArray(scRaw) ? scRaw : [scRaw]);
  const text = raw.toString("utf8");
  let json;
  try { json = JSON.parse(text); } catch (e) { throw new Error("bad json: " + text.slice(0, 200)); }
  if (process.env.NATIVE_DEBUG === "1") {
    console.error(`[native2] ${u.hostname} ${params.Action} -> ${JSON.stringify(json).slice(0, 200)}`);
  }
  return json;
}
/** Fire-and-forget variant for the burst (Log3/UploadLog/Log2). */
function fire(url, params, key) {
  return post(url, params, key).catch(() => {});
}

// ── payload builders (profile-shaped) ──────────────────────────────────────
function rand(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/** Build a W payload array from a harvested profile, re-minted for this
 *  session: cert, mid-anchored stamps, per-session DC matrix, this session's
 *  whole-profile salt set ([21]/[71]/[73]/[78]/[85]/[86] stay correlated). */
function buildWFromProfile(profs, cert, midTs, salt, withTail, wTimes) {
  const f = salt.w.slice();  f[77] = cert;
  // [87] = cfg[7] EXACTLY (captured: W[87] === init DeviceConfig field[7]
  // byte-for-byte, which is midTs+1 or +2) — never re-roll it.
  f[87] = String(wTimes.w87 ?? midTs + rand(0, 2));  // = cfg[7] (midTs+1..2)
  f[72] = String(wTimes.initTs);                 // = mid+69..83
  f[74] = String(wTimes.wTs);                    // mint-1
  // DC matrix [43]: today's shape is `20-a|23-b|30-0|40-c|90-NaN|91-NaN|92-NaN`
  // (token W appends `|93-NaN|94-NaN`). a/b/c drawn from the observed bands.
  const a = rand(240, 665);
  const b = a + rand(31, 81);
  const c = rand(1, 9);
  f[43] = `20-${a}|23-${b}|30-0|40-${c}|90-NaN|91-NaN|92-NaN${withTail ? "|93-NaN|94-NaN" : ""}`;
  f[42] = wTimes.serverIp || f[42];
  return f.join("#");
}

function buildDeviceData(payloadKey, mid, payloadB64, innerTs, opts = {}) {
  const secret2 = aesEnc(payloadKey, pkcs7(Buffer.from(`W.10054#saf-captcha#${SCENE}`, "utf8"))).toString("base64");
  const saf = aesEnc(payloadKey, pkcs7(Buffer.from("saf-captcha", "utf8"))).toString("base64");
  const wblob = aesEnc(payloadKey, pkcs7(Buffer.from("W.10054", "utf8"))).toString("base64");
  const tsA = aesEnc(payloadKey, pkcs7(Buffer.from(String(innerTs), "utf8"))).toString("base64");
  if (opts.log3) {
    const tsB = aesEnc(payloadKey, pkcs7(Buffer.from(String(innerTs + 1), "utf8"))).toString("base64");
    const part1 = [mid, "", saf, wblob, "", tsA].join("#");
    const trackB64 = opts.track
      ? aesEnc(payloadKey, pkcs7(Buffer.from(opts.track, "utf8"))).toString("base64")
      : "";
    const part2 = [mid, trackB64, saf, wblob, "", tsB].join("#");
    const field6 = Buffer.from(
      `511#${Buffer.from(part1, "utf8").toString("base64")}-504#${Buffer.from(part2, "utf8").toString("base64")}`,
      "utf8",
    ).toString("base64");
    const plain = `${DD_TEMPLATE_PREFIX}${secret2}#W20220202#CLOUD##${field6}`;
    return aesEnc(WEB_FLAG_KEY, pkcs7(Buffer.from(plain, "utf8"))).toString("base64");
  }
  const tsBlob = aesEnc(payloadKey, pkcs7(Buffer.from(String(innerTs), "utf8"))).toString("base64");
  const inner = [mid, payloadB64, saf, wblob, "", tsBlob].join("#");
  const plain = `${DD_TEMPLATE_PREFIX}${secret2}#W20220202#CLOUD#0#501#${Buffer.from(inner, "utf8").toString("base64")}`;
  return aesEnc(WEB_FLAG_KEY, pkcs7(Buffer.from(plain, "utf8"))).toString("base64");
}

function buildData(prefix, ts, vt, arg) {
  const REAL_JSON =
    '{"TrackList":{"mc":"","tc":"","mu":"","te":"","mp":"","tmv":"","ks":"","fi":"","startTime":%d},"TrackStartTime":%d,"VerifyTime":%d,"arg":"%s"}';
  const json = prefix + REAL_JSON.replace("%d", ts).replace("%d", ts).replace("%d", vt).replace("%s", arg);
  const b64 = zlib.deflateSync(Buffer.from(json, "utf8")).toString("base64");
  const blob = h2dCrypt(Buffer.from(b64, "utf8"), ksa("3e627e1b4c63f913"), false);
  return blob.toString("base64");
}

function buildToken(mid, payloadB64, trailing) {
  return Buffer.from(`SG_WEB#${mid}#${payloadB64}#0#${trailing}`).toString("base64");
}

// ── WAF cookie priming (mirrors the happy path's page load + host pings; the
//    captured passing sessions carry acw_tc cookies on every captcha POST) ──
async function primeCookies() {
  if (process.env.NATIVE_NO_PRIME === "1") return;
  // 1. Origin page load (sets zcode WAF cookies; also registers IP+UA+origin)
  try {
    const res = await undiciRequest("https://zcode.z.ai/", {
      method: "GET",
      headers: {
        accept: "*/*",
        "accept-encoding": "gzip, deflate",
        "accept-language": "en-US,en;q=0.9",
        ...BROWSER_HEADERS,
      },
    });
    absorbCookies("zcode.z.ai", res.headers["set-cookie"]);
    await res.body.arrayBuffer().catch(() => {});
  } catch (_) {}
  // 2. Prime each captcha API host so acw_tc flows on the burst POSTs.
  for (const host of [
    "no8xfe.captcha-open-southeast.aliyuncs.com",
    "no8xfe-verify.captcha-open-southeast.aliyuncs.com",
    "cloudauth-device-dualstack.ap-southeast-1.aliyuncs.com",
    "ap-southeast-1.device.saf.aliyuncs.com",
    "upload.captcha-open-southeast.aliyuncs.com",
  ]) {
    try {
      const res = await undiciRequest(`https://${host}/`, {
        method: "GET",
        headers: { accept: "*/*", origin: "https://zcode.z.ai", referer: "https://zcode.z.ai/", ...BROWSER_HEADERS },
      });
      absorbCookies(host, res.headers["set-cookie"]);
      await res.body.arrayBuffer().catch(() => {});
    } catch (_) {}
  }
}

// ── the solve ──────────────────────────────────────────────────────────────
// (salt pool helper removed — sessions use one whole profile's salt set)

async function solveCaptcha() {
  await primeCookies();
  const profs = loadProfiles();
  // VERBATIM-REPLAY bisection (NATIVE_REPLAY_CAPTURE=1): after a fresh init,
  // re-encrypt the captured passing session's W/track/uploadLog/data with the
  // NEW tokenKey + mid + cert, shift all timestamps by (newMidTs - oldMidTs),
  // and send. If this passes, the crypto + construction are correct and the
  // bug is in my synthetic randomization; if it F001s, the diff is in the
  // environment (IP/TLS/session correlation).
  const replay = process.env.NATIVE_REPLAY_CAPTURE === "1" ? profs[profs.length - 1] : null;
  // ONE whole profile's salt set per session — [21]/[71]/[73]/[78]/[85]/[86]
  // are correlated in captures (e.g. f78 9d4568c0.. always pairs f85=1);
  // mixing fields across profiles produces combinations the SDK never emits.
  const prof = profs[crypto.randomInt(profs.length)];
  const salt = { w: prof.w };
  void salt; // salt set is carried via wTimes/prof; kept for clarity

  // 1. InitCaptchaV3 — DeviceData is the bundle's static constant (byte-
  //    identical across every captured era; verified Aug 22).
  const initSentAt = Date.now();
  const init = await post(
    INIT_URL,
    {
      AaduaneId: AADUANE,
      SignatureMethod: "HMAC-SHA1",
      SignatureVersion: "1.0",
      Format: "JSON",
      Timestamp: tsNow(),
      Version: "2023-03-05",
      Action: "InitCaptchaV3",
      SceneId: SCENE,
      Language: "en",
      Mode: "popup",
      DeviceData: INIT_DEVICE_DATA_CONST,
      SignatureNonce: crypto.randomUUID(),
    },
    VERIFY_KEY,
  );
  const cert = init.CertifyId;
  if (!cert) throw new Error("init no cert: " + JSON.stringify(init).slice(0, 300));

  const cfgFields = decryptConfig(init.DeviceConfig).split("#");
  const tokenKey = Buffer.from(Buffer.from(cfgFields[0], "base64").toString(), "utf8");
  const mid = cfgFields[2];
  const midTs = Number(mid.split("-")[2]) || Date.now();
  const serverIp = cfgFields[8] || "";
  const initDoneAt = Date.now();
  const initDurMs = initDoneAt - initSentAt;

  // 2. Wait into the observed mint band. Captured passing sessions:
  //    [72] = mid+68..81, [74] = mid+151..160, burst dispatch = mid+212..215
  //    (the W is minted ~55-60ms BEFORE the burst departs).
  // Mint target scales with the observed init response latency: fast init
  // (mid+67..113) -> burst ~mid+212; slow init (mid+471..473) -> burst ~mid+469
  // (the SDK waits for its asset loading; captured bands: mint = mid+151..160
  // fast / mid+412..583 slow). Pick band by init RTT, then dispatch = mint+60.
  const initRtt = initDoneAt - initSentAt;
  const slowBand = initRtt > 300;

  // Mirror the SDK's per-solve CDN fetch: the happy path ALWAYS re-fetches
  // the rotating pe.<ver>.js from g.alicdn.com between init and the burst
  // (bypassPeCache — network GET with UA only). The CDN/WAF correlates this
  // fetch with the session; skipping it is a verified F001 trigger.
  try {
    const sp = String(init.StaticPath || "");
    if (sp) {
      // StaticPath = "3.29.0/pe.081.a2ede546e341a1b9" (no .js)
      const peUrl = `https://g.alicdn.com/captcha-frontend/dynamicJS/${sp}${sp.endsWith(".js") ? "" : ".js"}`;
      const r = await origFetch(peUrl, { headers: { "user-agent": BROWSER_HEADERS["user-agent"] } });
      await r.arrayBuffer().catch(() => {});
    }
  } catch (_) {}

  if (replay) {
    // ── VERBATIM REPLAY BISECTION ──────────────────────────────────────────
    // Re-encrypt the captured passing session's artifacts with the new
    // session's key/mid/cert; shift all stamps by delta = newMidTs - oldMidTs;
    // dispatch at the captured rhythm (delta-shifted). Nothing synthetic.
    const delta = midTs - replay.midTs;
    const shift = (s) => String(Number(s) + delta);
    const capW = [...replay.w];
    capW[77] = cert;
    capW[72] = shift(capW[72]);
    capW[74] = shift(capW[74]);
    capW[87] = shift(capW[87]);
    const capW2 = [...replay.deviceTokenW || replay.w];
    capW2[77] = cert;
    capW2[72] = shift(capW2[72]);
    capW2[74] = shift(capW2[74]);
    capW2[87] = shift(capW2[87]);
    const capTrack = { ...replay.track, startTime: replay.track.startTime + delta, timestamp: shift(replay.track.timestamp) };
    const capUl = JSON.parse(JSON.stringify(replay.uploadLog));
    capUl.mInit.t += delta;
    capUl.js.t += delta;
    capUl.cId = cert;
    const capDataPlain = replay.dataPlain
      .replace(/("startTime":)(\d+)/g, (m, a, v) => a + (Number(v) + delta))
      .replace(/("TrackStartTime":)(\d+)/g, (m, a, v) => a + (Number(v) + delta))
      .replace(/("VerifyTime":)(\d+)/g, (m, a, v) => a + (Number(v) + delta))
      // The 32-hex prefix and b64 arg are per-session nonces — re-mint them.
      .replace(/^[0-9a-f]{32}/, randomHex(32))
      .replace(/"arg":"[^"]*"/, `"arg":"${Buffer.from(crypto.randomBytes(10)).toString("base64")}"`);
    const deflated = zlib.deflateSync(Buffer.from(capDataPlain, "utf8"));
    const capData = h2dCrypt(Buffer.from(deflated.toString("base64"), "utf8"), ksa("3e627e1b4c63f913"), false).toString("base64");

    const capDd = aesEnc(tokenKey, pkcs7(Buffer.from(capW.join("#"), "utf8"))).toString("base64");
    const capDdOuter = buildDeviceData(tokenKey, mid, capDd, Number(capW[74]) + 2);
    const t = replay.timings;
    const dispatchAt = midTs + (t.log2At ?? 213);
    const w1 = dispatchAt - Date.now();
    if (w1 > 0) await new Promise((r) => setTimeout(r, w1));
    fire(LOG3_URL, {
      AaduaneId: LOG_AADUANE, SignatureMethod: "HMAC-SHA1", SignatureVersion: "1.0",
      Format: "JSON", Version: "2020-10-15", Action: "Log3",
      Data: buildDeviceData(tokenKey, mid, "", Number(capW[74]) + 12, { log3: true, track: JSON.stringify(capTrack) }),
      SignatureNonce: crypto.randomUUID(),
    }, LOG_KEY);
    fire(UPLOAD_URL, {
      AaduaneId: AADUANE, SignatureMethod: "HMAC-SHA1", SignatureVersion: "1.0",
      Format: "JSON", Timestamp: tsNow(), Version: "2023-03-05", Action: "UploadLog",
      log: JSON.stringify(capUl), SignatureNonce: crypto.randomUUID(),
    }, VERIFY_KEY);
    fire(LOG2_URL, {
      AaduaneId: LOG_AADUANE, SignatureMethod: "HMAC-SHA1", SignatureVersion: "1.0",
      Format: "JSON", Version: "2020-10-15", Action: "Log2",
      Data: capDdOuter, SignatureNonce: crypto.randomUUID(),
    }, LOG_KEY);
    await new Promise((r) => setTimeout(r, 1));
    const capToken = buildToken(mid, aesEnc(tokenKey, pkcs7(Buffer.from(capW2.join("#"), "utf8"))).toString("base64"), crypto.randomBytes(16).toString("hex"));
    const vr2 = await post(VERIFY_URL, {
      AaduaneId: AADUANE, SignatureMethod: "HMAC-SHA1", SignatureVersion: "1.0",
      Format: "JSON", Timestamp: tsNow(), Version: "2023-03-05", Action: "VerifyCaptchaV3",
      SceneId: SCENE, CertifyId: cert,
      CaptchaVerifyParam: JSON.stringify({ sceneId: SCENE, certifyId: cert, deviceToken: capToken, data: capData }),
      SignatureNonce: crypto.randomUUID(),
    }, VERIFY_KEY);
    const r2 = vr2.Result || {};
    if (r2.VerifyResult && r2.securityToken) {
      return { certifyId: cert, sceneId: SCENE, isSign: true, securityToken: r2.securityToken };
    }
    const e2 = new Error("REPLAY verify failed: " + (r2.VerifyCode || vr2.Code));
    e2.verifyCode = r2.VerifyCode;
    throw e2;
  }

  const mintTarget = midTs + (slowBand ? rand(410, 585) : rand(150, 160));
  const wait1 = mintTarget - Date.now();
  if (wait1 > 0) await new Promise((r) => setTimeout(r, wait1));

  // 3. Claim lattice (mid-anchored, from captured bands):
  //    [72]=mid+68..81, [74]=mintTarget-1, behavior startTime=mid+120..150,
  //    data TrackStartTime=mid+130..145, VerifyTime=+8..12 after that,
  //    uploadLog mInit.t=mid+40..60 rt=initDur+40..120, js.t=mid+125..145.
  const wTimes = {
    initTs: midTs + rand(69, 83),
    wTs: mintTarget - 1,
    startTime: midTs + rand(80, 133),
    serverIp,
    w87: Number(cfgFields[7]) || midTs + 1,  // W[87] = cfg[7] verbatim
  };
  const track = {
    mousemove: [], mouseclick: [], keyup: [],
    scrollTop: [], scrollLeft: [], pointerEvent: [],
    clientType: "desktop",
    startTime: wTimes.startTime,
    timestamp: String(Number(cfgFields[7]) || midTs + 1),  // = W[87]
  };
  // ONE W for both the Log2 DD and the verify token (captured: byte-identical
  // between them except [43]'s 93/94 tail on the token variant).
  const wStr = buildWFromProfile(profs, cert, midTs, salt, false, wTimes);
  const ddPayloadB64 = aesEnc(tokenKey, pkcs7(Buffer.from(wStr, "utf8"))).toString("base64");
  const dd = buildDeviceData(tokenKey, mid, ddPayloadB64, mintTarget);

  const uploadParams = () => ({
    AaduaneId: AADUANE,
    SignatureMethod: "HMAC-SHA1",
    SignatureVersion: "1.0",
    Format: "JSON",
    Timestamp: tsNow(),
    Version: "2023-03-05",
    Action: "UploadLog",
    log: JSON.stringify({
      sId: SCENE,
      pfx: "no8xfe",
      ip: serverIp,
      mInit: { t: midTs + 47, s: true, msg: "INIT_SUCCESS", rt: initDurMs + rand(100, 150) },
      hst: "captcha-open-southeast.aliyuncs.com",
      cId: cert,
      js: { t: midTs + rand(130, 140), s: true, msg: "DYNAMICJS_LOADED", rt: rand(80, 90) },
      rt: initDurMs + rand(200, 260),
    }),
    SignatureNonce: crypto.randomUUID(),
  });

  // Build all burst payloads FIRST (the SDK's ~60ms crypto window), then
  // dispatch at the observed band mid+212..218 — the W claims [74]=mid+151
  // but the burst ARRIVES at mid+213 in every capture; dispatching at mint
  // time creates claim-vs-arrival skew (F001).
  const log3Params = {
    AaduaneId: LOG_AADUANE,
    Version: "2020-10-15",
    SignatureMethod: "HMAC-SHA1",
    SignatureVersion: "1.0",
    Format: "JSON",
    Action: "Log3",
    Data: buildDeviceData(tokenKey, mid, "", mintTarget + 11, {
      log3: true,
      track: JSON.stringify(track),
    }),
    SignatureNonce: crypto.randomUUID(),
  };
  const uploadP = uploadParams();
  const log2Params = {
    AaduaneId: LOG_AADUANE,
    Version: "2020-10-15",
    SignatureMethod: "HMAC-SHA1",
    SignatureVersion: "1.0",
    Format: "JSON",
    Action: "Log2",
    Data: dd,
    SignatureNonce: crypto.randomUUID(),
  };

  const dispatchWait = midTs + (slowBand ? rand(468, 472) : rand(212, 218)) - Date.now();
  if (dispatchWait > 0) await new Promise((r) => setTimeout(r, dispatchWait));

  // 4. The burst: Log3 -> UploadLog -> Log2 (~1ms apart), then Verify ~1-3ms
  //    after Log2 (all fired async — arrival order matters, not completion).
  fire(LOG3_URL, log3Params, LOG_KEY);
  fire(UPLOAD_URL, uploadP, VERIFY_KEY);
  const log2P = fire(LOG2_URL, log2Params, LOG_KEY);
  // Verify departs ~1-3ms after Log2 (captured: same ms or +1).
  await new Promise((r) => setTimeout(r, rand(0, 2)));

  // 5. Verify — token W is the SAME W with the 93/94 NaN tail appended to [43]
  //    (captured: only [43] differs between the Log2 W and token W).
  const dTs = wTimes.startTime + rand(4, 10);
  const data = buildData(randomHex(32), dTs, dTs + rand(8, 12), Buffer.from(crypto.randomBytes(10)).toString("base64"));
  const tokenW = wStr.replace(/92-NaN$/, "92-NaN|93-NaN|94-NaN");
  const payloadB64 = aesEnc(tokenKey, pkcs7(Buffer.from(tokenW, "utf8"))).toString("base64");
  const token = buildToken(mid, payloadB64, randomHex(32));

  const vr = await post(
    VERIFY_URL,
    {
      AaduaneId: AADUANE,
      SignatureMethod: "HMAC-SHA1",
      SignatureVersion: "1.0",
      Format: "JSON",
      Timestamp: tsNow(),
      Version: "2023-03-05",
      Action: "VerifyCaptchaV3",
      SceneId: SCENE,
      CertifyId: cert,
      CaptchaVerifyParam: JSON.stringify({ sceneId: SCENE, certifyId: cert, deviceToken: token, data }),
      SignatureNonce: crypto.randomUUID(),
    },
    VERIFY_KEY,
  );
  await log2P;
  const res = vr.Result || {};
  if (res.VerifyResult && res.securityToken) {
    return { certifyId: cert, sceneId: SCENE, isSign: true, securityToken: res.securityToken };
  }
  const err = new Error("verify failed: " + (res.VerifyCode || vr.Code) + " " + JSON.stringify(vr).slice(0, 300));
  err.verifyCode = res.VerifyCode;
  err.response = vr;
  throw err;
}

module.exports = { solveCaptcha, loadProfiles };

// CLI: solve once, print a proxy-compatible captcha param (base64 JSON with
// certifyId — same shape solve-core's extractVerifyParam produces).
if (require.main === module) {
  solveCaptcha()
    .then((r) => {
      const param = Buffer.from(JSON.stringify(r)).toString("base64");
      console.log(param);
    })
    .catch((e) => {
      console.error("native2 FAIL:", e.message);
      process.exit(1);
    });
}
