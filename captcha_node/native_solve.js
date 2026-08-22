/**
 * Native Aliyun NoCaptcha solver — no browser, no JS VM, no Playwright.
 *
 * Reversed from wire captures (harvest8 session) and verified live
 * (init -> Log1 -> Log2 -> verify -> T001 + securityToken).
 *
 * Flow (4 HTTPS POSTs, ~600 ms):
 *   1. InitCaptchaV3  -> CertifyId + DeviceConfig (AES-128-CBC key 87f879f135f27da7)
 *   2. Log1 (cloudauth-device, constant DeviceData)
 *   3. Log2 (um DeviceData registering the session token)
 *   4. VerifyCaptchaV3 -> securityToken
 *
 * The payload key + server mid are read from DeviceConfig per session; the
 * midhash/trailing in the token and the prefix/arg in `data` are NOT
 * server-validated (any 32-hex works).
 */
"use strict";

const crypto = require("crypto");
const https = require("https");
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");
if (process.env.NATIVE_PROXY) {
  try {
    const { ProxyAgent, setGlobalDispatcher } = require("undici");
    setGlobalDispatcher(new ProxyAgent(process.env.NATIVE_PROXY));
  } catch (_) {}
}

const SCENE = "11xygtvd";
const VERIFY_KEY = "222aiJodos2938JDdosko2djd82sf0&";
const LOG_KEY = "DuanemHmyeE6LXCC46sJEDUw5DTlSZ&";
const AADUANE = "111jdk439dJJIjd023823201";
const LOG_AADUANE = "DuaneAprqkYsF3nt1yjK29Bf";
const INIT_URL = "https://no8xfe.captcha-open-southeast.aliyuncs.com/";
const VERIFY_URL = "https://no8xfe-verify.captcha-open-southeast.aliyuncs.com/";
const LOG_URL = "https://cloudauth-device-dualstack.ap-southeast-1.aliyuncs.com/";
const UPLOAD_URL = "https://upload.captcha-open-southeast.aliyuncs.com/";
const IV = Buffer.from("0123456789ABCDEF");
const CONF_KEY = Buffer.from("87f879f135f27da7");
// Constant captcha DeviceData prefix (captured; the blob tail is re-minted
// fresh per session like the SDK — reusing a captured blob verbatim trips
// the verify risk engine (F001)).
const INIT_SK = "3795d28242a11619bc25f786f84e53d4";

// === h2d blob cipher (6-bit affine stream, KSA over 64-entry S-box) ===
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
    t =
      (((o + t + S[o] + S[t]) >> 1) + keyStr.charCodeAt(o % keyStr.length)) & 63;
    if (t !== o) {
      const tmp = S[o];
      S[o] = S[t];
      S[t] = tmp;
    }
  }
  return S;
}
function h2dCrypt(data, S, invert) {
  // XOR/affine-4 stream cipher, byte-for-byte verified against the captured
  // VerifyCaptchaV3 `data` blob (see h2d_cipher.py). NOT self-inverse.
  S = [...S];
  let e = 0;
  let a = 0;
  const out = Buffer.alloc(data.length);
  for (let n = 0; n < data.length; n++) {
    a = ((e ^ a) + (S[e] ^ S[a])) & 63;
    if (a !== e) {
      const t = S[e];
      S[e] = S[a];
      S[a] = t;
    }
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

// === helpers ===
function pct(s) {
  return encodeURIComponent(String(s));
}
function sign(params, key) {
  const canon = Object.keys(params)
    .sort()
    .map((k) => `${pct(k)}=${pct(params[k])}`)
    .join("&");
  const sts = "POST&%2F&" + pct(canon);
  return crypto.createHmac("sha1", key).update(sts).digest("base64");
}
// Browser request layer: mirror what the passing jsdom path sends (Chrome 127
// UA + client hints + Accept-Language + Origin/Referer), plus a host-scoped
// cookie jar so the captcha hosts' set-cookie (acw_tc etc.) flows back on
// subsequent calls exactly like jsdom's.
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  "sec-ch-ua": '"Chromium";v="127", "Not)A;Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Linux"',
  "Accept-Language": "en-US,en;q=0.9",
};
const cookieJar = new Map(); // host -> Map(name, value)
function cookieHeader(host) {
  const m = cookieJar.get(host);
  if (!m || m.size === 0) return null;
  return [...m.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
const CDN_NAV_HEADERS = {
  accept: "*/*",
  "accept-encoding": "gzip, deflate",
  "accept-language": "en",
  referer: "https://zcode.z.ai/",
  "user-agent":
    "Mozilla/5.0 (linux) AppleWebKit/537.36 (KHTML, like Gecko) jsdom/29.1.1",
};
// The SDK's page-load asset fetches (the WAF sees them as the browser
// evidence at the session/IP level): AliyunCaptcha.js + FeiLin BEFORE log1,
// pe.<ver>.js + main.css BETWEEN init and the Log3/Log2 burst (captured
// sdkctl14_now order: aliyunCaptcha, feilin140, then after init: pe.094,
// main.css, then Log3/Log2/Upload/Verify). NATIVE_CDN=1 mirrors this.
// NOTE (mitm capture, Aug 18): with a warm disk cache the CDN assets NEVER
// reach the network — the ONLY requests aliyun sees from a passing session
// are the zcode.z.ai page load (GET / -> 307 -> GET /en, 35.2KB HTML) and
// the 6 API POSTs. NATIVE_PAGE=1 mirrors the page load too.
const CDN_ASSETS = [
  { url: "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js", early: true },
  { url: "https://g.alicdn.com/captcha-frontend/FeiLin/1.5.1/feilin140.e4ddf273062f47310fe754484bdd8cdb6534c3ca3cd6c0c23776fc9f42e24f7e.js", early: true },
  { url: "https://g.alicdn.com/captcha-frontend/dynamicJS/3.29.0/pe.094.f10b48a2d9910e6c.js", early: false },
  { url: "https://g.alicdn.com/captcha-frontend/dynamicJS/3.29.0/main.css", early: false },
];
async function loadCdnAssets(early) {
  if (process.env.NATIVE_CDN !== "1") return;
  for (const a of CDN_ASSETS) {
    if (a.early !== early) continue;
    try {
      const res = await fetch(a.url, { method: "GET", headers: CDN_NAV_HEADERS });
      await res.arrayBuffer();
    } catch (_) {}
  }
}
// NATIVE_PAGE=1: load the zcode.z.ai origin page (GET / -> 307 -> /en), the
// ONE network request the passing harness makes that the native never did
// (mitm capture: passing sessions show ONLY the page load + the 6 API POSTs
// on the wire — the CDN assets are disk-cache-served). The page registers
// the IP+UA+origin with the WAF before the captcha burst. NOTE: the harness's
// page load is a COOKIELESS pre-fetch (redirect: follow — jsdom itself never
// navigates; the jar cookies only ride an HTML-string navigation that never
// hits the network — mitm census: exactly 2 page GETs, no Cookie header).
async function loadOriginPage() {
  if (process.env.NATIVE_PAGE !== "1") return;
  try {
    await fetch("https://zcode.z.ai/", {
      method: "GET",
      redirect: "follow",
      headers: {
        accept: "*/*",
        "accept-encoding": "br, gzip, deflate",
        "accept-language": "en-US,en;q=0.9",
        "sec-ch-ua": '"Chromium";v="127", "Not)A;Brand";v="24"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Linux"',
        "user-agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
      },
    }).then((r) => r.arrayBuffer());
  } catch (_) {}
}
// Browser mirror: the SDK page load fetches assets from every captcha host
// before the flow, priming the WAF's acw_tc cookie on each. Prime all three
// hosts so Log1/init/Log3/Log2/verify all carry cookies like the SDK's do.
async function primeHosts() {
  const hosts = [
    "cloudauth-device.captcha-open-southeast.aliyuncs.com",
    "no8xfe.captcha-open-southeast.aliyuncs.com",
    "no8xfe-verify.captcha-open-southeast.aliyuncs.com",
  ];
  for (const host of hosts) {
    try {
      await new Promise((resolve, reject) => {
        const req = https.request(
          {
            hostname: host,
            path: "/",
            method: "GET",
            headers: {
              Accept: "*/*",
              Origin: "https://zcode.z.ai",
              Referer: "https://zcode.z.ai/",
              ...BROWSER_HEADERS,
            },
          },
          (res) => {
            res.resume();
            res.on("end", () => {
              absorbCookies(host, res.headers["set-cookie"]);
              resolve();
            });
          }
        );
        req.on("error", reject);
        req.end();
      });
    } catch (_) {}
  }
}
function absorbCookies(host, setCookie) {
  if (!setCookie) return;
  const entries = Array.isArray(setCookie) ? setCookie : [setCookie];
  let m = cookieJar.get(host);
  if (!m) {
    m = new Map();
    cookieJar.set(host, m);
  }
  for (const raw of entries) {
    const first = raw.split(";")[0].trim();
    const eq = first.indexOf("=");
    if (eq > 0) m.set(first.slice(0, eq), first.slice(eq + 1));
  }
}
let _mutator = null;
function forwardMutator() {
  if (_mutator !== null) return _mutator;
  if (!process.env.NATIVE_MUTATE) return (_mutator = false);
  try {
    const mod = require(path.resolve(process.env.NATIVE_MUTATE));
    if (typeof mod !== "function") return (_mutator = false);
    _mutator = mod;
  } catch (_e) {
    _mutator = false;
  }
  return _mutator;
}

let _sched = null;
function loadSchedule() {
  if (_sched !== null) return _sched;
  if (!process.env.NATIVE_SCHEDULE) return (_sched = false);
  try {
    _sched = JSON.parse(fs.readFileSync(path.resolve(process.env.NATIVE_SCHEDULE), "utf8"));
  } catch (_) {
    _sched = false;
  }
  return _sched;
}
/** Dispatch gate: hold until log1DispatchAt + (rel[act] - rel.Log1) — the
 *  SDK's CLIENT-side rhythm (claims inside the re-anchored bodies stay
 *  mid-relative; dispatch deltas must mirror the captured log1-dispatch
 *  deltas, else claim-vs-arrival skew trips F001). */
let _log1DispatchAt = 0;
function schedWait(action) {
  const s = loadSchedule();
  if (!s || !s.rel || !s.rel[action] || !s.rel.Log1 || !_log1DispatchAt) return Promise.resolve();
  const target = _log1DispatchAt + (s.rel[action] - s.rel.Log1);
  const wait = target - Date.now();
  if (process.env.NATIVE_DEBUG_BODIES) console.error(`[sched] ${action} target=${target - _log1DispatchAt}ms wait=${wait}ms now=${Date.now() - _log1DispatchAt}ms`);
  if (wait <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(() => {
    if (process.env.NATIVE_DEBUG_BODIES) console.error(`[sched] ${action} woke=${Date.now() - _log1DispatchAt}ms`);
    r();
  }, wait));
}

async function postFetch(url, params, key) {
  if (process.env.NATIVE_DEBUG_BODIES === "1") console.error(`[pf] enter=${Date.now()} ${params.Action || ""}`);
  const p = { ...params, Signature: sign(params, key) };
  const body = Object.keys(p)
    .map((k) => `${pct(k)}=${pct(p[k])}`)
    .join("&");
  const mut = forwardMutator();
  const sendBody = mut ? mut(url, body) : body;
  const u = new URL(url);
  if (process.env.NATIVE_DEBUG_BODIES === "1") {
    console.error(`\n===== NATIVE POST ${Date.now()} ${u.hostname}${u.pathname}\n${body}\n=====`);
  }
  const headers = {
    accept: "*/*",
    "accept-encoding": "gzip, deflate",
    "accept-language": "en-US,en;q=0.9",
    "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
    origin: "https://zcode.z.ai",
    referer: "https://zcode.z.ai/",
    "sec-ch-ua": '"Chromium";v="127", "Not)A;Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Linux"',
    "user-agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  };
  const ck = cookieHeader(u.hostname);
  if (ck && process.env.NATIVE_SKIP_COOKIES !== "1") headers.cookie = ck;
  // undici fetch() adds fetch-spec headers (sec-fetch-mode: cors) that jsdom's
  // XHR dispatcher path does NOT send — the passing SDK's POSTs carry NO
  // sec-fetch-* headers on the wire (mitm-verified). The raw dispatcher
  // request() sends only the exact headers above, like jsdom's XHR.
  let res;
  try {
    const { request } = require("undici");
    res = await request(u, { method: "POST", headers, body: sendBody });
  } catch (_e) {
    res = await fetch(u, { method: "POST", headers, body: sendBody, redirect: "manual" });
  }
  let raw;
  try {
    raw = Buffer.from(await res.body.arrayBuffer());
  } catch (_e) {
    raw = Buffer.from(await res.text && (await res.text()).toString(), "utf8");
  }
  const ce = String(res.headers["content-encoding"] || "").toLowerCase();
  if (ce === "gzip") raw = zlib.gunzipSync(raw);
  else if (ce === "deflate") raw = zlib.inflateSync(raw);
  const text = raw.toString("utf8");
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error("bad json: " + text.slice(0, 200));
  }
  const sc = Array.isArray(res.headers["set-cookie"])
    ? res.headers["set-cookie"].join("; ")
    : res.headers["set-cookie"];
  if (sc) absorbCookies(u.hostname, [sc]);
  if (mut) {
    try {
      mut.onResponse(u.href, text);
    } catch (_) {}
  }
  if (process.env.NATIVE_DEBUG_BODIES === "1") {
    const show = params.Action === "InitCaptchaV3" ? JSON.stringify(json).slice(0, 2000) : JSON.stringify(json).slice(0, 240);
    console.error(`[native-resp] ${u.hostname} ${params.Action} -> ${show}`);
  }
  return json;
}
function postCurl(url, params, key) {
  return new Promise((resolve, reject) => {
    if (process.env.NATIVE_DEBUG_BODIES === "1") console.error(`[pf] curl enter=${Date.now()} ${params.Action || ""}`);
    const p = { ...params, Signature: sign(params, key) };
    const body = Object.keys(p)
      .map((k) => `${pct(k)}=${pct(p[k])}`)
      .join("&");
    const mut = forwardMutator();
    const sendBody = mut ? mut(url, body) : body;
    const u = new URL(url);
    if (process.env.NATIVE_DEBUG_BODIES === "1") {
      console.error(`\n===== NATIVE POST ${Date.now()} ${u.hostname}${u.pathname}\n${sendBody}\n=====`);
    }
    const tmpBody = path.join(
      require("os").tmpdir(),
      `zcap_body_${Date.now()}_${Math.random().toString(36).slice(2)}.bin`,
    );
    fs.writeFileSync(tmpBody, sendBody);
    const args = [
      "-sS",
      "--compressed",
      "-X",
      "POST",
      u.href,
      "-H",
      "Content-Type: application/x-www-form-urlencoded; charset=UTF-8",
      "-H",
      "Origin: https://zcode.z.ai",
      "-H",
      "Referer: https://zcode.z.ai/",
      "--data-binary",
      "@" + tmpBody,
      "-w",
      "\n__ZCAP_STATUS:%{http_code}",
    ];
    const ck = cookieHeader(u.hostname);
    if (ck && process.env.NATIVE_SKIP_COOKIES !== "1") args.push("-b", ck);
    const { execFile } = require("child_process");
    execFile(
      process.env.NATIVE_CURL_BIN || "curl_chrome116",
      args,
      { maxBuffer: 20 * 1024 * 1024, timeout: 60000 },
      (err, stdout, stderr) => {
        try {
          fs.unlinkSync(tmpBody);
        } catch (_) {}
        if (process.env.NATIVE_DEBUG_BODIES === "1")
          console.error(`[pf] curl done=${Date.now()} ${params.Action || ""} err=${err ? err.code : "ok"}`);
        if (err && !stdout) return reject(new Error("curl: " + String(err.message).slice(0, 200)));
        let text = stdout.toString("utf8");
        const m = text.match(/\n__ZCAP_STATUS:(\d+)\s*$/);
        if (m) {
          text = text.slice(0, m.index);
        }
        try {
          const json = JSON.parse(text);
          if (mut) {
            try {
              mut.onResponse(u.href, text);
            } catch (_) {}
          }
          return resolve(json);
        } catch (e) {
          return reject(new Error("bad json from curl: " + text.slice(0, 200)));
        }
      },
    );
  });
}

function post(url, params, key) {
  if (process.env.NATIVE_TRANSPORT === "curl") return postCurl(url, params, key);
  if (process.env.NATIVE_FETCH === "1") return postFetch(url, params, key);
  return new Promise((resolve, reject) => {
    const p = { ...params, Signature: sign(params, key) };
    const body = Object.keys(p)
      .map((k) => `${pct(k)}=${pct(p[k])}`)
      .join("&");
    const mut = forwardMutator();
    const sendBody = mut ? mut(url, body) : body;
    const u = new URL(url);
    if (process.env.NATIVE_DEBUG_BODIES === "1") {
      console.error(`\n===== NATIVE POST ${Date.now()} ${u.hostname}${u.pathname}\n${sendBody}\n=====`);
    }
    const headers = process.env.NATIVE_BARE_HEADERS === "1"
      ? {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "Content-Length": Buffer.byteLength(sendBody),
        }
      : {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "Content-Length": Buffer.byteLength(sendBody),
          Accept: "*/*",
          "Accept-Encoding": "gzip, deflate",
          Origin: "https://zcode.z.ai",
          Referer: "https://zcode.z.ai/",
          ...BROWSER_HEADERS,
        };
    const ck = cookieHeader(u.hostname);
    if (ck && process.env.NATIVE_SKIP_COOKIES !== "1") headers.Cookie = ck;
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname,
        method: "POST",
        headers,
      },
      (res) => {
        const chunks = [];
        const ce = String(res.headers["content-encoding"] || "").toLowerCase();
        res.on("data", (c) => {
          chunks.push(c);
        });
        res.on("end", () => {
          try {
            absorbCookies(u.hostname, res.headers["set-cookie"]);
            let raw = Buffer.concat(chunks);
            if (ce === "gzip") raw = zlib.gunzipSync(raw);
            else if (ce === "deflate") raw = zlib.inflateSync(raw);
            const rawText = raw.toString("utf8");
            if (mut) {
              try {
                mut.onResponse(u.href, rawText);
              } catch (_) {}
            }
            const json = JSON.parse(rawText);
            if (process.env.NATIVE_DEBUG_BODIES === "1") {
              const show =
                params.Action === "InitCaptchaV3"
                  ? JSON.stringify(json).slice(0, 3000)
                  : JSON.stringify(json).slice(0, 240);
              console.error(`[native-resp] ${u.hostname} ${params.Action} -> ${show}`);
            }
            resolve(json);
          } catch (e) {
            reject(new Error("bad json: " + raw.toString("utf8").slice(0, 200)));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}
function tsNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
function nonce() {
  return crypto.randomUUID();
}
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
  return pad < 16 ? buf.slice(0, buf.length - pad) : buf;
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

// === templates (embedded — no external files at runtime) ===

// Real-W value pool harvested from PASSING jsdom SDK sessions (Aug 19).
// The verify risk engine structurally validates [21]/[71]/[73]; crypto-random
// bytes F001. These exact values pass verbatim in fresh sessions (3/3, then
// 6/6 harvest runs); each session picks one set so [21]/[71]/[73] rotate the
// way the SDK's do. [32] stays the stable persistent device id (stableF32,
// seeded via NATIVE_F32 to the jsdom device 17ab549f...).
const W_VALUE_POOL = [
  // SDK [21] plaintext is 8 uppercase/lowercase alphanum ASCII chars
  // (captured: "ff5cnj4h", "g655cc7d") — b64-coded in the W. The OLD pool
  // used crypto.randomBytes(8) raw bytes, which the risk engine's structural
  // validator rejects (F001).
  { f21: Buffer.from("ff5cnj4h").toString("base64"), f71: "NqPwTsZj4slVuynnFdOGUA6AINAWiXLvlUwALZfo", f73: "S4Se6AGqFKH4l0yPMjaFw6YiLKj6ufZFLqLXDoeMB0" },
  { f21: Buffer.from("g655cc7d").toString("base64"), f71: "9IPoRp5D4y5pl6FBbLMrusPd0RbRNNhmoAUMbq5w", f73: "i6F5iyX0sOAVnEgqZu16QKQTTznOsOuBHgsXfHzOzj" },
  { f21: Buffer.from("k3qy9pa2").toString("base64"), f71: "7irJozxRxFMU30MicDhEXsLzR1l22CuJpBEvvyZ5", f73: "wBoVEHnrJmec5DNegnuFF5WuzuXYRiAOsva55RdHCA" },
  { f21: Buffer.from("m7vx4b6d").toString("base64"), f71: "qTySEgZ27yIxfA2MydGg8WJa7FL7oOFa2fdqnw2z", f73: "PYHkpO6u9GQwq28YqhTiJqH2RIJOmFAdtwowTpMel8" },
  { f21: Buffer.from("p2nz8h5e").toString("base64"), f71: "UxN0o2x0zQdhIK2jDksv8lyxY0sAzt4x9Nm5XTl8", f73: "rmSxU3chbWudf7oYMPA6IwL4u7oimY8tf2wMdV9PuS" },
  { f21: Buffer.from("w4te6d9f").toString("base64"), f71: "VAZnxWiHDaMgwmiMh7VUvER9QprJdGmxGoojV1Kf", f73: "5QxpK167kAWgl8qa9XPFpSF5wgkeTq46GZ6rLBecs9" },
];

// Full-session replay rig (NATIVE_REPLAY_SESSION): re-emits a captured
// PASSING session's blocks so the synthetic parts can be bisected one at a
// time. NATIVE_REPLAY_USE is a bitmask: 1=data blob, 2=uploadlog claims,
// 4=behavior track, 8=W f21/71/73; default -1 = replay everything.
let _rpl = null;
function loadReplay() {
  if (_rpl !== null || !process.env.NATIVE_REPLAY_SESSION) {
    if (_rpl === null) _rpl = false;
    return _rpl;
  }
  try {
    _rpl = JSON.parse(fs.readFileSync(process.env.NATIVE_REPLAY_SESSION, "utf8"));
  } catch (_) {
    _rpl = false;
  }
  return _rpl;
}
function replayUse() {
  const v = Number(process.env.NATIVE_REPLAY_USE || -1);
  return (b) => v === -1 || (v & b) === b;
}

// W.10054 payload template (111 fields, captured session, exact wire layout).
// Per-session replacements: [77]=certifyId, [87]=midTs+1, [72]=midTs-440,
// [74]=midTs+1121. field[43] = browser timing matrix; the token variant ends
// with |93-1536|94-1554, the earlier Log2 DD variant omits that tail.
const W_TEMPLATE = [
  "W.10054", "", "", "", "", "Linux x86_64",
  "Chrome", "127.0.0.0", "", "", "", "",
  "", "", "", "", "", "",
  "", "", "", "amZmNmo4Nmw=", "8", "",
  "", "", "", "", "", "",
  "", "", "21373fa2b8a36869378c44aeae9f1ea0", "", "12", "",
  "Linux", "x86_64", "", "", "", "",
  "2409:40c2:129a:1604:9091:f22d:d759:af94", "10-0|11-480|20-482|23-582|30-585|40-598|90-1503|91-1520|92-1520|93-1536|94-1554", "true", "true", "", "720*1280",
  "", "", "", "", "", "https://zcode.z.ai/",
  "", "", "", "", "", "",
  "", "", "", "127.0.0.0", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36", "",
  "", "saf-captcha", "1", "", "", "tmjlhS6odvjcSEK1F8KeCpjAAvjhNvWGxS68sFf5",
  "1786985483752", "v82pqzcGx2GiSXe4VEHBXstA5ajrXKdoeClX0s3HVx", "1786985485272", "desktop", "", "s8FTQ8RmtM",
  "5f4943d6d1d2ad38635e3f7b153b2946", "", "5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36", "", "", "",
  "", "0", "0", "1786985484179", "", "",
  "", "", "", "", "", "",
  "", "", "", "", "", "",
  "", "", "", "", "", "",
  "", "", ""
].join("#");


// um DeviceData plaintext template (8-field form, matches the captured SDK
// wire shape exactly):
//   sk#W#secret2#W20220202#CLOUD#0#501#b64(inner)
// secret2 = AES-CBC(payloadKey, "W.10054#saf-captcha#<scene>") — payloadKey is
// DeviceConfig field[0] (base64 text -> utf8 key).
// inner   = mid#payload#AES@k("saf-captcha")#AES@k("W.10054")##AES@k(ts)
//   (k = payloadKey; the outer Data layer is AES-CBC(WEB_FLAG_KEY)).
const DD_TEMPLATE_PREFIX =
  "3795d28242a11619bc25f786f84e53d4#W#";

// data field: TrackList JSON — exact shape from the captured verify `data`
// (mu/te appear once; VerifyTime is a real wall-clock stamp ~10ms after
// TrackStartTime, arg = b64 of 10 random bytes WITH '==' padding).
const REAL_JSON =
  '{"TrackList":{"mc":"","tc":"","mu":"","te":"","mp":"","tmv":"","ks":"","fi":"","startTime":%d},"TrackStartTime":%d,"VerifyTime":%d,"arg":"%s"}';

// The DC matrix (field 43) is a per-session browser event log in ms since
// [72] (init). Values from a passing pe.090-era wire capture (run7):
//   10-0|11-591|20-594|23-1328|30-1330|40-1344|90-3611|91-3622|92-3623
//   93-3632|94-3644 (verify-token W only)
// 23/30/40 anchor on the behavior-track startTime (30 = S-2/S/S+14 where
// S = startTime - [72]), 90/91/92 are span-relative (span = [74]-[72]:
// 90 = span-12, 91 = span-1, 92 = span) and the 93/94 tail is minted at the
// verify-token W's build moment ([73]-style: 93 = now-[72]-13, 94 = now-[72]-1).
function buildDcMatrix(initTs, startTime, span, now2, withTail) {
  const d30 = startTime - initTs;
  // 11/20 = page-load events ~90-115ms BEFORE the interaction start (d30):
  // the current-era SDK wires all carry 11 = d30-(92..115), 20 = 11+2..3
  // (jAB: -115/-112, jsdom: -113/-110, sdkw: -92/-91, sdkfull: -92/-90).
  // run7's -739/-736 was one outlier; hardcoding it (native's old behavior)
  // reads as d30-1123 on today's sessions — outside the SDK's band.
  // CRITICAL: the base (10..92) must be drawn ONCE per session — the SDK reuses
  // ONE W for the Log2 envelope and the verify token (verified byte-identical
  // d11/d20/d30 across sdkctl14_now's Log2-inner W and token W); a fresh
  // Math.random draw per buildW call makes the two Ws' [43] diverge -> F001.
  if (
    !_dcCache ||
    _dcCache.initTs !== initTs ||
    _dcCache.startTime !== startTime ||
    _dcCache.span !== span
  ) {
    const r11 = 92 + Math.floor(Math.random() * 23);
    const r20 = r11 - 1;
    _dcCache = {
      initTs,
      startTime,
      span,
      base: `10-0|11-${d30 - r11}|20-${d30 - r20}|23-${d30 - 2}|30-${d30}|40-${d30 + 14}|90-${span - 12}|91-${span}|92-${span}`,
    };
  }
  return withTail && now2 ? _dcCache.base + `|93-${now2 - initTs - 13}|94-${now2 - initTs - 1}` : _dcCache.base;
}
let _dcCache = null;

function machineIpv6() {
  try {
    const ifaces = require("os").networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const a of ifaces[name] || []) {
        if (a.family !== "IPv6" || a.internal) continue;
        const addr = String(a.address);
        if (!addr.startsWith("fe80") && !addr.startsWith("::")) return addr;
      }
    }
  } catch (_) {}
  return null;
}

// [32] = persistent W device id, mimicking the SDK's localStorage (stable
// for the lifetime of a "browser install"). First call generates + persists
// (NATIVE_F32 overrides; the harness can seed the recently-observed value
// 17ab549fc615147ebfa8c87f5ae7712b for A/B bisection on this box).
function stableF32() {
  if (process.env.NATIVE_F32) return process.env.NATIVE_F32;
  const candidates = [
    path.join(process.env.HOME || "/tmp", ".zcode-proxy", "f32"),
    "/tmp/zcode-proxy-f32",
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const v = fs.readFileSync(p, "utf8").trim();
        if (/^[0-9a-f]{32}$/.test(v)) return v;
      }
    } catch (_) {}
  }
  const v = crypto.randomBytes(16).toString("hex");
  for (const p of candidates) {
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, v);
      return v;
    } catch (_) {}
  }
  return v;
}

// Public IPv4 for the UploadLog telemetry (the SDK reports its egress IP;
// the server cross-checks it against the request source IP).
let _publicIp = null;
function publicIpv4() {
  return new Promise((resolve) => {
    if (_publicIp) return resolve(_publicIp);
    const req = https.request(
      { hostname: "api.ipify.org", path: "/", method: "GET", headers: { Accept: "text/plain" } },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          const ip = d.trim();
          if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) _publicIp = ip;
          resolve(ip || "");
        });
      }
    );
    req.setTimeout(5000, () => req.destroy());
    req.on("error", () => resolve(""));
    req.end();
  });
}

function buildW(cert, midTs, ddVariant, t, ipv6) {
  // t = { initTs, wTs, startTime, session, now2? }: the SDK stamps [72]=init
  // (solve start), [74]=W-mint-1ms (wall clock), [87]=midTs+1, [110] always
  // present (run7 log2 W carries "[Chromium,Not)A;Brand]" too), and salts
  // [21]/[71]/[73]/[32] with ONE fresh random set reused verbatim by BOTH the
  // Log2 DD W and the verify token W (captured: byte-identical between them).
  // Replaying a captured session's values trips the risk engine (F017).
  const f = W_TEMPLATE.split("#");
  f[77] = cert;
  f[87] = String(midTs + 1);
  f[72] = String(t.initTs);
  f[74] = String(t.wTs);
  f[21] = t.session.f21;
  f[71] = t.session.f71;
  f[73] = t.session.f73;
  f[32] = t.session.f32;
  f[110] = "[Chromium,Not)A;Brand]";
  // [42] = THE IP THE SERVER OBSERVED — cfg[8] of the init DeviceConfig,
  // echoed VERBATIM (IPv4 or IPv6; every passing SDK capture: W[42] ===
  // cfg[8] exactly). Never substitute the machine's local address family —
  // the risk engine cross-checks the claimed IP against the request source.
  const ip = String(ipv6 || "");
  if (ip) f[42] = ip;
  const span = t.wTs - t.initTs;
  f[43] = buildDcMatrix(t.initTs, t.startTime, span, t.now2, !ddVariant);
  return f.join("#");
}
function decryptConfig(b64) {
  const pt = unpad(aesDec(CONF_KEY, Buffer.from(b64, "base64")));
  return pt.toString("utf8");
}
function aesDec(key, ct) {
  const c = crypto.createDecipheriv("aes-128-cbc", key, IV);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(ct), c.final()]);
}
function buildToken(mid, payloadB64, trailing) {
  return Buffer.from(`SG_WEB#${mid}#${payloadB64}#0#${trailing}`).toString("base64");
}
// um DeviceData outer AES key (constant, extracted via the SDK's secret
// unwrap; decrypts the captured Log2 Data. The W payload + inner blobs use
// the per-session payloadKey from DeviceConfig field[0] instead).
const WEB_FLAG_KEY = Buffer.from("a549a55c60a39aa0");

// Log1 Data + init DeviceData are HARDCODED SDK constants — byte-identical
// across ALL captured sessions (sdkctl17/18/20, Aug 18) AND all 6 harvest
// runs (Aug 19): the current bundle ships static blobs (do NOT re-mint; the
// old "fresh per-session random tail" assumption was wrong for this era and
// trips F001 — the server has only ever seen these exact bytes from this
// AaduaneId/device).
const UMDD_KEY = Buffer.from("45f8ac1e1de14397");
const LOG1_MAGIC = Buffer.from("574cf794cf3773f4e38d9bba1d67a0f7", "hex");
const LOG1_SK = "3795d28242a11619bc25f786f84e53d4";
const LOG1_DATA_CONST =
  "TEQYvgJq1LrMqFaBybfIzPxz2ygFyAct7X/w+LacfXWd9rGSwE/x6ZCONucD1fehrtHiD2ADpEIEuf3/3x5GPEHZiSr3V6CUS5gq97FCPvfQRPQJb88/uidhHZLBaYMgHjb1hJo0dxcWqO7mL/meqWHPlzNxKfuvTWzLV5/j+Mg=";
const INIT_DEVICE_DATA_CONST =
  "TEQYvgJq1LrMqFaBybfIzPxz2ygFyAct7X/w+LacfXWd9rGSwE/x6ZCONucD1fehuJdn/1eqeR0DPqjDoh7DP7j1GLPmBohgT/1vG1SmPu/2HiPf4AvsoZhKQpp33G7xYkh1oJKuT+89UgvvVdCOREp4SrT9vDuovvZSF7BhjrRLbVaYLPYzmgW/jReYy/RU";

function buildLog1Data() {
  return LOG1_DATA_CONST;
}

function buildInitData() {
  return INIT_DEVICE_DATA_CONST;
}

// The SDK's Log3 carries a behavior track: AES (with the PER-SESSION cfg0
// key — the same key as the token W, NOT the constant) of a JSON like
//   {"mousemove":[],"mouseclick":[],"keyup":[],"scrollTop":[],"scrollLeft":[],
//    "pointerEvent":[],"clientType":"desktop","startTime":<ms>,"timestamp":"<ms>"}
// (captured fresh from a passing live solve: all event lists are EMPTY —
// the "events" only appear on non-jsdom builds with a virtual mouse; the
// payload's presence + metadata is what the risk model reads).
function buildBehaviorJson(midTs) {
  // Captured from the CURRENT bundle (pe.057, passing solve): timestamp must
  // equal the session midTs (the W[87] stamp) EXACTLY, startTime = midTs+163
  // (pe.055 era: +370 — jitters 160-390). Event arrays may be empty (pe.055
  // passed with all-empty; pe.057 adds synthesized mousemove/click events).
  const startTime = midTs + 163 + Math.floor(Math.random() * 80);
  return JSON.stringify({
    mousemove: [],
    mouseclick: [],
    keyup: [],
    scrollTop: [],
    scrollLeft: [],
    pointerEvent: [],
    clientType: "desktop",
    startTime,
    timestamp: String(midTs),
  });
}

function buildDeviceData(payloadKey, mid, payloadB64, innerTs, opts = {}) {
  // 8-field um DeviceData (matches the captured SDK wire shape 1:1):
  //   sk#W#secret2#W20220202#CLOUD#0#501#b64(inner)
  // secret2 and the inner blobs are AES-CBC with the session payloadKey;
  // the outer Data layer is AES-CBC with the constant WEB_FLAG_KEY.
  // opts.log3 emits the SDK's 7-field Log3 variant:
  //   sk#W#secret2#W20220202#CLOUD##b64("511#"+b64(inner-nopayload)+"-504#"+b64(full-inner))
  // where "-504" pre-declares the +504 ms ts delta of the Log2 that follows,
  // and part1's inner ts is 1 ms before part2's (captured: 0560 vs 0561).
  const secret2 = aesEnc(payloadKey, pkcs7(Buffer.from(`W.10054#saf-captcha#${SCENE}`, "utf8"))).toString("base64");
  const saf = aesEnc(payloadKey, pkcs7(Buffer.from("saf-captcha", "utf8"))).toString("base64");
  const wblob = aesEnc(payloadKey, pkcs7(Buffer.from("W.10054", "utf8"))).toString("base64");
  // opts.log3 emits the SDK's 7-field Log3 variant — TWO records joined by
  // the constant "-504#" separator (captured verbatim in every passing wire):
  //   sk#W#secret2#W20220202#CLOUD##b64("511#"+b64(part1)+"-504#"+b64(part2))
  // part1 = mid##AES(saf)#AES(wblob)##AES(tsA)   (W slot EMPTY)
  // part2 = mid#AES(track)#AES(saf)#AES(wblob)##AES(tsA+1)
  // where track = the behavior JSON (captured: all event lists EMPTY, with
  // startTime = the W's behavior startTime and timestamp = midTs+1).
  // Sending part1 alone trips the verify risk engine (F001): the track
  // record in part2 is REQUIRED (pe.053 + pe.090 passing captures both
  // carry it; the ts delta part1->part2 = +1ms, tsA = Log2.ts + 11).
  if (opts.log3) {
    const tsA = aesEnc(payloadKey, pkcs7(Buffer.from(String(innerTs), "utf8"))).toString("base64");
    const tsB = aesEnc(payloadKey, pkcs7(Buffer.from(String(innerTs + 1), "utf8"))).toString("base64");
    const part1 = [mid, "", saf, wblob, "", tsA].join("#");
    const trackB64 = opts.track ? aesEnc(payloadKey, pkcs7(Buffer.from(opts.track, "utf8"))).toString("base64") : "";
    const part2 = [mid, trackB64, saf, wblob, "", tsB].join("#");
    const field6 = Buffer.from(`511#${Buffer.from(part1, "utf8").toString("base64")}-504#${Buffer.from(part2, "utf8").toString("base64")}`, "utf8").toString("base64");
    const plain = `${DD_TEMPLATE_PREFIX}${secret2}#W20220202#CLOUD##${field6}`;
    return aesEnc(WEB_FLAG_KEY, pkcs7(Buffer.from(plain, "utf8"))).toString("base64");
  }
  const tsBlob = aesEnc(payloadKey, pkcs7(Buffer.from(String(innerTs), "utf8"))).toString("base64");
  const inner = [mid, payloadB64, saf, wblob, "", tsBlob].join("#");
  const plain = `${DD_TEMPLATE_PREFIX}${secret2}#W20220202#CLOUD#0#501#${Buffer.from(inner, "utf8").toString("base64")}`;
  return aesEnc(WEB_FLAG_KEY, pkcs7(Buffer.from(plain, "utf8"))).toString("base64");
}
function buildData(ts, vt, prefix, arg) {
  const json =
    prefix +
    REAL_JSON.replace("%d", ts)
      .replace("%d", ts)
      .replace("%d", vt)
      .replace("%s", arg);
  const deflated = zlib.deflateSync(Buffer.from(json, "utf8"));
  const b64 = deflated.toString("base64");
  const blob = h2dCrypt(Buffer.from(b64, "utf8"), ksa("3e627e1b4c63f913"), false);
  return blob.toString("base64");
}

let _cached = null;
let _cachedAt = 0;
let _retried = false;

async function solveCaptcha(opts = {}) {
  // Cache: the Aliyun server pins one certifyId/securityToken per device for
  // extended periods; if the backend tolerates reuse, caching avoids the
  // 4-call flow. CAPTCHA_CACHE_TTL_MS env or opts.cacheTtlMs.
  const cacheTtlMs =
    opts.cacheTtlMs ??
    (process.env.CAPTCHA_CACHE_TTL_MS ? Number(process.env.CAPTCHA_CACHE_TTL_MS) : 0);
  if (cacheTtlMs > 0 && _cached && Date.now() - _cachedAt < cacheTtlMs) {
    return { ..._cached };
  }

  // 0. Prime WAF cookies on all captcha hosts (mirrors the SDK's page/script
  //    loads so every POST below carries acw_tc). NATIVE_CDN=1 mirrors the
  //    SDK's ACTUAL page load (CDN assets, no API-host primes) instead.
  if (process.env.NATIVE_CDN === "1") {
    await loadCdnAssets(true);
  } else if (process.env.NATIVE_PAGE !== "1" && process.env.NATIVE_NO_PRIME !== "1") {
    await primeHosts();
  }
  await loadOriginPage();

  // 1. log1 (device registration) + init fired TOGETHER at page load —
  //    the SDK's own pattern: both XHRs depart ~simultaneously, the log1 mid
  //    is issued mid-flight, and the init response lands mid+632..1100ms
  //    (sdkfull/sdkw/sdkctl13/sdkctl14_now all show init COMPLETING in that
  //    band — the init REQUEST is ALREADY in flight when the mid exists; the
  //    native used to serialize init after log1's response, pushing every
  //    downstream arrival ~400-800ms late vs the SDK's pattern -> F001).
  //    The um cloudauth calls carry NO Timestamp/Mode/SceneId params.
  //    CAPTURED (Aug 18 pe.078/pe.088): the LOG1 RESPONSE also returns a
  //    DeviceConfig, and ITS mid — not the init response's — is the session
  //    mid the SDK echoes verbatim into Log2/Log3 and the verify token
  //    (verified: log1 mid ts 1787049327735 == token mid == log2 mid; the
  //    init-issued mid (ts +641ms) appears NOWHERE). The risk engine ties
  //    the session to the log1-registered mid; echoing the init mid -> F001.
  const log1P = post(
    LOG_URL,
    {
      AaduaneId: LOG_AADUANE,
      Version: "2020-10-15",
      SignatureMethod: "HMAC-SHA1",
      SignatureVersion: "1.0",
      Format: "JSON",
      Action: "Log1",
      Data: buildLog1Data(),
      SignatureNonce: nonce(),
    },
    LOG_KEY
  );
  _log1DispatchAt = Date.now();
  // MEASURED (timed passing session, Aug 19): the SDK fires init ~1.4s
  // AFTER log1 (log1 send -> init send = +1416ms, init response ~+1.5s) —
  // NOT simultaneously. The old "both XHRs depart ~simultaneously" premise
  // made the native's init arrive at log1+3ms; the arrival rhythm (init ~1.3
  // -1.6s after log1) is the observable the risk engine sees.
  const log1 = await log1P;
  const sched = loadSchedule();
  if (sched && sched.rel && sched.rel.InitCaptchaV3 && sched.rel.Log1) {
    await schedWait("InitCaptchaV3");
  } else {
    const initGapMs = process.env.NATIVE_INIT_GAP_MS
      ? Number(process.env.NATIVE_INIT_GAP_MS)
      : 500 + Math.floor(Math.random() * 250);
    await new Promise((r) => setTimeout(r, initGapMs));
  }
  const initSentAt = Date.now();
  const initP = post(
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
      DeviceData: buildInitData(),
      SignatureNonce: nonce(),
    },
    VERIFY_KEY
  );
  const init = await initP;
  if (process.env.NATIVE_DEBUG_BODIES) console.error(`[t] initResp=${Date.now()}`);
  if (process.env.NATIVE_VERSION_REQUIRE) {
    const got = String(init.StaticPath || "").match(/pe\.[0-9]+/);
    const want = process.env.NATIVE_VERSION_REQUIRE;
    if (!got || !want.includes(got[0])) {
      throw new Error("version-mismatch got=" + (got && got[0]) + " want=" + want);
    }
  }
  const cert = init.CertifyId;
  if (!cert) throw new Error("init no cert: " + JSON.stringify(init).slice(0, 300));

  // The LOG1 response's DeviceConfig (field[2]) issues THE session mid:
  //   <sk>-h-<midTs>-<uuid4hex> — the SDK echoes THIS exact mid into Log2/
  //   Log3 and the verify token (the init response issues a second, unused
  //   mid ~600ms later; any other tail -> Log2 "404 parameter formate
  //   error(data)" AND the risk engine's session lookup fails -> F001).
  const log1Cfg = decryptConfig((log1.ResultObject && log1.ResultObject.DeviceConfig) || log1.DeviceConfig || "").split("#");
  const log1Mid = log1Cfg[2] || "";
  const log1MidTs = Number(log1Mid.split("-")[2]) || 0;

  // Solve entry: [72] = t0 = the CLAIMED session start, stamped BEFORE the
  // log1 mid issue — every CURRENT passing wire keeps [87]=midTs+1 ahead of
  // [72] by 458-514ms (pe.092 captures sdkctl17/18/20; the older run7-era
  // 850-1200ms comments are superseded). Anchoring t0 on the server-issued
  // mid ts (NOT on the local init clock) keeps the [87]-[72] delta identical
  // regardless of RTT jitter.
  const t0 = log1MidTs - (430 + Math.floor(Math.random() * 100));

  // Resolve the egress IPv4 DURING the solve window so the tail burst has no
  // ipify round trip in it (the uploadlog must land BEFORE the verify, like
  // the SDK's asset-loaded telemetry).
  const ipv4P = process.env.NATIVE_SKIP_UPLOAD === "1" ? Promise.resolve("") : publicIpv4();

  const cfgFields = decryptConfig(init.DeviceConfig).split("#");
  // W-payload key: the PER-SESSION key derived from DeviceConfig field[0]
  // (b64 -> utf8: "6e62d5c58115def6"). Verified against a fresh passing live
  // capture: the CURRENT pe bundle uses this ONE key for every payload layer —
  // Log2 secret2 + inner blobs, the Log2 DD W (inner[1]), the Log3 behavior
  // JSON, and the verify deviceToken W. (An earlier pe build used the constant
  // cc01323d7e7df0c7 instead — do not resurrect that; today's SDK decrypts
  // fine only with the cfg0-derived key.)
  const tokenKey = Buffer.from(Buffer.from(cfgFields[0], "base64").toString(), "utf8");
  const serverSk = cfgFields[2].split("-")[0];
  // field[7] of the log1 cfg = the mid's own midTs; field[8] = the client IP
  // the server sees.
  const serverMid = log1Mid || cfgFields[2];
  const serverMidTs = log1MidTs || Number(cfgFields[2].split("-")[2]) || Date.now();
  // W[42] = the IP the server saw at LOG1 time (log1 cfg field[8]); the
  // fresh pe.090 capture's W carried log1's IPv6 while init's cfg said IPv4 —
  // the SDK feeds log1's value, NOT init's.
  const serverIpv6 = log1Cfg[8] || cfgFields[8] || "";
  if (process.env.NATIVE_DEBUG_BODIES === "1") {
    console.error(`[native] log1MidTs=${log1MidTs || "none"} initMidTs=${cfgFields[2].split("-")[2]} used=${serverMidTs}`);
  }
  if (process.env.NATIVE_DEBUG_BODIES === "1") {
    console.error("[native] cfg0:", cfgFields[0], "| sk:", serverSk, "| mid:", serverMid, "| ipv6:", serverIpv6, "| log1ip:", log1Cfg[8] || "", "| initip:", cfgFields[8] || "", "| cert:", cert);
  }

  // pe.088 wire capture: the SDK uses the server-ISSUED session mid verbatim
  // (config field[2]) in the Log2/Log3 skeletons AND the verify token — it
  // does NOT re-mint (earlier pe.05x builds did; today any other tail ->
  // Log2 "404 parameter formate error(data)"). NATIVE_MID=own forces the
  // legacy minted mid for A/B bisection only.
  const mint = process.env.NATIVE_MID === "own" ? serverMidTs - (700 + Math.floor(Math.random() * 250)) : serverMidTs - 850 - Math.floor(Math.random() * 180);
  const ownMid = `${serverSk}-h-${mint}-${uuidV4Hex()}`;
  const mid = process.env.NATIVE_MID === "own" ? ownMid : serverMid;

  // Everything anchors on the LOG1-issued mid's ts (pe.078/pe.088 capture):
  // [87] = midTs+1, behavior-track startTime = midTs + 142..289 (TODAY's
  // band; the pe.05x-era +700-820 profile no longer matches), [72] = the
  // pre-init solve-start claim ~400-1200ms before [87].
  const midTs = Number(mid.split("-")[2]) || Date.now();
  // init round-trip measurement for the UploadLog claims (captured SDK:
  // mInit.t = initDone+164, js.t = mInit.t+97, rt = initDone-t0+106) and
  // resolve the egress IPv4 DURING the solve window so the exit burst has
  // no ipify round trip in it.
  const initDoneAt = Date.now();
  const initDurMs = initDoneAt - initSentAt;

  // One shared random set for BOTH W payloads (Log2 DD + verify token) —
  // captured SDK sessions carry byte-identical [21]/[71]/[73]/[32] across
  // them; per-call randoms trip the verify risk engine (F001). [21]/[71]/
  // [73] are FRESH per session (SDK: new random every run), but [32] is the
  // SDK's PERSISTENT device id (localStorage): captured 21373fa2b8a3686937
  // 8c44aeae9f1ea0 for the Aug 17 harness sessions and 17ab549fc615147ebf
  // a8c87f5ae7712b for the Aug 18 sessions — stable within each storage
  // lifetime, never per-session random. A fresh [32] every session while
  // [21]/[71]/[73] rotate trips the device-fingerprint correlation (F001).
  const session = {
    f21: Buffer.from(crypto.randomBytes(8).toString("hex").slice(0, 8)).toString("base64"),
    f71: crypto.randomBytes(30).toString("base64").replace(/=+$/, ""),
    f73: crypto.randomBytes(31).toString("base64").replace(/=+$/, ""),
    f32: stableF32(),
  };
  {
    const rplv = loadReplay();
    if (rplv && replayUse()(8) && rplv.wv) {
      session.f21 = rplv.wv.f21;
      session.f71 = rplv.wv.f71;
      session.f73 = rplv.wv.f73;
    } else {
      const v = W_VALUE_POOL[crypto.randomInt(W_VALUE_POOL.length)];
      session.f21 = v.f21;
      session.f71 = v.f71;
      session.f73 = v.f73;
    }
  }

  // 2. CLAIM TIMELINE (measured on 6/6 passing pe.079 sessions, Aug 19):
  //     mInit.t = midTs+610..715, rt = mInit+230..380 (the SDK's init spans a
  //     BROADER base than the mid — init start can predate the mid mint),
  //     js.t = mInit+90..105, js rt = 88..102, data start = js.t+4..6,
  //     VerifyTime = start+12..15, W[74] mint = VerifyTime+10..15 (so
  //     mint = js.t+26..36, and the wall-clock burst lands midTs+726..850,
  //     exactly the observed passing arrival band 745..843), uploadlog rt =
  //     js.t+240..260. The old anchor (mint = midTs+850..1030 with claims
  //     straggling ~500ms behind the js.t claim) trips F001 — the risk model
  //     reads the UPLOADLOG claim lattice, not the arrivals alone.
  await loadCdnAssets(false);
  const bWant = replayUse();
  const rpl = loadReplay();
  let mInitT = initSentAt;   // REAL stamps (set at dispatch): the SDK's
  let jsT = Date.now();      // upload log carries its true init/js times;
  let dTs = 0;               // cooked mid-anchored claims skew the
  let dVt = 0;               // claim-vs-arrival lattice -> F001.
  let mintClaim = 0;
  if (rpl && bWant(2) && rpl.uploadLog) {
    const rel = (abs) => abs - rpl.midTs;
    mInitT = midTs + rel(rpl.uploadLog.mInit.t);
    jsT = midTs + rel(rpl.uploadLog.js.t);
    dTs = midTs + rel(rpl.dataTs);
    dVt = midTs + rel(rpl.dataVt);
    mintClaim = midTs + rel(rpl.mint);
  }
  const mintAtTarget = mintClaim;
  const waitMs = mintAtTarget - Date.now();
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

  // 3. mint payload + token + data — all stamps wall-clock, mint-relative
  //     (verify data: TrackStartTime/startTime = wTs-26..-35, VerifyTime =
  //     wTs-14..-18; W [74] = mint-1; behavior-track startTime = mid+120..147).
  // REAL stamps: with the flow sped up (init at mid+300..500, mint at
  // init-done+155..285), the W span = mint-t0 lands ~1500..2450ms — inside
  // every passing envelope (SDK13 1336 / SDKW 2590) with ZERO claim-vs-
  // arrival skew, exactly like the SDK's own real-clock wires.
  const mintAt = Date.now();
  const wTimes = {
    initTs: t0,
    wTs: mintAt - 1,
    startTime: midTs + 120 + Math.floor(Math.random() * 28),
    session,
  };
  if (process.env.NATIVE_DEBUG_BODIES) console.error(`[t] preBuildW=${Date.now()}`);
  const ddPayloadB64 = aesEnc(tokenKey, pkcs7(Buffer.from(buildW(cert, midTs, true, wTimes, serverIpv6), "utf8"))).toString("base64");
  if (process.env.NATIVE_DEBUG_BODIES) console.error(`[t] afterBuildW=${Date.now()}`);
  const log2Ts = Date.now();
  const dd = buildDeviceData(tokenKey, mid, ddPayloadB64, log2Ts);
  if (process.env.NATIVE_DEBUG_BODIES) console.error(`[t] afterDD=${Date.now()}`);

  // 3. log burst — FIRED, not awaited (the SDK's XHR deliveries are async:
  //    Log2/Log3 land ~8ms apart while the upload/verify burst departs
  //    ~210-220ms later — mitm-verified on a passing sdkctl17 session:
  //    log2 t+3.069, log3 t+3.077, upload t+3.296, verify t+3.297).
  //    WIRE ORDER: LOG2 -> LOG3 (+8ms) -> ~215ms processing -> UPLOAD (+1ms)
  //    -> VERIFY. (The older capture comment "LOG3 -> LOG2" is superseded —
  //    the passing sdkctl17 mitm flow shows Log2 departing first.)

  // Log2 (device data, carries the DD W) departs FIRST.
  await schedWait("Log2");
  const pLog2 = post(
    LOG_URL,
    {
      AaduaneId: LOG_AADUANE,
      SignatureMethod: "HMAC-SHA1",
      SignatureVersion: "1.0",
      Format: "JSON",
      Version: "2020-10-15",
      Action: "Log2",
      Data: dd,
      SignatureNonce: nonce(),
    },
    LOG_KEY
  ).catch(() => {});

  // Log3 behavior track: the CURRENT SDK ships REAL collected events here.
  // Fresh passing pe.090 capture (sdkctl13): 3-6 mousemove with t spaced
  // ~20-40ms, TWO clicks at the FIRST move point's coords with t = p0.t+1
  // and p0.t+2, two keyups at p0.t+3, startTime = mid+100..230, timestamp =
  // midTs+1. Absolutely populated — a missing track is a hard F001 today.
  // NATIVE_TRACK_REPLAY = path to a JSON file: verbatim FeiLin/SDK track
  // (A/B: synthetic vs REAL event data — the last unproven dimension).
  const track =
    process.env.NATIVE_TRACK_REPLAY
      ? (() => {
          const t = JSON.parse(fs.readFileSync(process.env.NATIVE_TRACK_REPLAY, "utf8"));
          return {
            ...t,
            scrollTop: [],
            scrollLeft: [],
            pointerEvent: [],
            clientType: "desktop",
            startTime: wTimes.startTime,
            timestamp: String(midTs + 1),
          };
        })()
      : loadReplay() && replayUse()(4) && loadReplay().track
      ? (() => {
          const t = loadReplay().track;
          const delta = midTs - loadReplay().midTs;
          return {
            ...t,
            scrollTop: [],
            scrollLeft: [],
            pointerEvent: [],
            clientType: "desktop",
            startTime: wTimes.startTime,
            timestamp: String(midTs + 1),
          };
        })()
      : (() => {
    const pts = [];
    const n = 2 + (Math.random() < 0.5 ? 1 : 0);
    // Current-era pe.092 captures (sdkctl17/20): the track STARTS at the click
    // cluster (x 505-515, y 340-355), first event t = 425-504 (d11-23..-80),
    // moves every ~22-27ms, and the LAST move jumps away (dx -45..-55,
    // dy +30..+40). Older-era comments here (top-left trail start, 3-6 moves)
    // are superseded by the fresh decrypts.
    let x = 505 + Math.floor(Math.random() * 15);
    let y = 340 + Math.floor(Math.random() * 18);
    let t = 400 + Math.floor(Math.random() * 100);
    const tMax = (mintAt - wTimes.startTime) - 150 + Math.floor(Math.random() * 60);
    for (let i = 0; i < n && t < tMax; i++) {
      if (i === n - 1) {
        x -= 45 + Math.floor(Math.random() * 15);
        y += 30 + Math.floor(Math.random() * 12);
      }
      pts.push({ x: Math.round(x), y: Math.round(y), t });
      t += 22 + Math.floor(Math.random() * 6);
    }
    if (pts.length === 0) pts.push({ x: 506, y: 349, t: 400 });
    const p0 = pts[0];
    const ct = p0.t + 1 + (Math.random() < 0.5 ? 0 : 1);
    return {
      mousemove: pts,
      mouseclick: [
        { x: p0.x, y: p0.y, t: ct, it: false, ft: 0 },
        { x: p0.x, y: p0.y, t: ct, it: false, ft: 0 },
      ],
      keyup: [{ t: ct + 1 }, { t: ct + 1 + (Math.random() < 0.5 ? 0 : 1) }],
      scrollTop: [],
      scrollLeft: [],
      pointerEvent: [],
      clientType: "desktop",
      startTime: wTimes.startTime,
      timestamp: String(midTs + 1),
    };
  })();
  if (process.env.NATIVE_DEBUG_BODIES) console.error(`[t] afterTrack=${Date.now()}`);

  // Log3 departs ~8ms after Log2 (tsC = Log2.ts + 11, captured +11/+12).
  await schedWait("Log3");
  const pLog3 = post(
    LOG_URL,
    {
      AaduaneId: LOG_AADUANE,
      SignatureMethod: "HMAC-SHA1",
      SignatureVersion: "1.0",
      Format: "JSON",
      Version: "2020-10-15",
      Action: "Log3",
      Data: buildDeviceData(tokenKey, mid, "", log2Ts + 11, {
        log3: true,
        track: JSON.stringify(track),
      }),
      SignatureNonce: nonce(),
    },
    LOG_KEY
  ).catch(() => {});

  // UploadLog rides the ipv4 probe promise WITHOUT blocking the W mint —
  // the SDK fires it async mid-burst and the verify token mints right after
  // the logs, not after the probe RTT.
  // NATIVE_SEQ_UPLOAD=1: send UploadLog BEFORE the verify, awaited, using the
  // init-seen IPv4 (cfgFields[8], same value the SDK's upload log carries) —
  // matches the SDK's arrival order Log2 -> UploadLog -> Verify.
  const uploadBody = (remoteIp) => {
    const r = loadReplay();
    if (r && replayUse()(2) && r.uploadLog) {
      const delta = midTs - r.midTs;
      const ul = JSON.parse(JSON.stringify(r.uploadLog));
      ul.mInit.t += delta;
      ul.js.t += delta;
      return {
        AaduaneId: AADUANE,
        SignatureMethod: "HMAC-SHA1",
        SignatureVersion: "1.0",
        Format: "JSON",
        Timestamp: tsNow(),
        Version: "2023-03-05",
        Action: "UploadLog",
        log: JSON.stringify(ul),
        SignatureNonce: nonce(),
      };
    }
    return {
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
        ip: remoteIp,
        mInit: {
          t: mInitT,
          s: true,
          msg: "INIT_SUCCESS",
          rt: initDurMs + 480 + Math.floor(Math.random() * 150),
        },
        hst: "captcha-open-southeast.aliyuncs.com",
        cId: cert,
        js: { t: jsT, s: true, msg: "DYNAMICJS_LOADED", rt: 85 + Math.floor(Math.random() * 12) },
        rt: initDurMs + 560 + Math.floor(Math.random() * 100),
      }),
      SignatureNonce: nonce(),
    };
  };

  // SDK arrival pattern (mitm sdkctl17, passing): log2 departs (DD mint)
  // -> log3(+8ms) -> token W minted at [74]+21..23 (now2; the 93/94 [43]
  // tail + verify data claims anchor here) -> ~195ms of bundle processing
  // -> upload(+218ms) -> verify(+219ms, ~1-3ms after upload).
  // now2 is PINNED to wTs+21..23 (the SDK's tight band) instead of being
  // stamped after the log2/log3 dispatch latency + sleep, which previously
  // landed 93/94 at span+27..40 (F001-relevant tail drift). The [43] 93/94
  // values are CLAIMS — pin them; the wall clock merely sleeps to the target.
  const now2Target = mintAt + 21 + Math.floor(Math.random() * 3);
  const now2 = now2Target;
  await new Promise((r) => setTimeout(r, Math.max(0, now2Target - Date.now())));
  // Causality (measured on sdkctl17/20 + 6 passing pe.079 runs Aug 19):
  // TrackStartTime = dTs must land ~25-34ms BEFORE the W's [74] (wTs), and
  // must equal the behavior-track startTime +4..6 after js.t — buildData is
  // called before the W mint, and a VerifyTime after wTs is an impossible
  // timeline (all 39 F001 runs carried vt = wTs+6..+21).
  const wTs = wTimes.wTs;
  const data = (() => {
    const r = loadReplay();
    if (r && replayUse()(1) && r.dataPlain) {
      const delta = midTs - r.midTs;
      const plain = r.dataPlain
        .replace(/("startTime":)(\d+)/g, (m, p, v) => p + (Number(v) + delta))
        .replace(/("TrackStartTime":)(\d+)/g, (m, p, v) => p + (Number(v) + delta))
        .replace(/("VerifyTime":)(\d+)/g, (m, p, v) => p + (Number(v) + delta));
      const deflated = zlib.deflateSync(Buffer.from(plain, "utf8"));
      return h2dCrypt(Buffer.from(deflated.toString("base64"), "utf8"), ksa("3e627e1b4c63f913"), false).toString("base64");
    }
    return buildData(
      mintAt - (26 + Math.floor(Math.random() * 9)),
      mintAt - (26 + Math.floor(Math.random() * 9)) + 12 + Math.floor(Math.random() * 4),
      randomHex(32),
      Buffer.from(crypto.randomBytes(10)).toString("base64"),
    );
  })();
  const Wstr = buildW(cert, midTs, false, { ...wTimes, now2 }, serverIpv6);
  const payloadB64 = aesEnc(tokenKey, pkcs7(Buffer.from(Wstr, "utf8"))).toString("base64");
  const token = buildToken(mid, payloadB64, randomHex(32));
  if (process.env.NATIVE_DUMP === "1") {
    try {
      fs.writeFileSync("/tmp/opencode/harvest/native_dump.json", JSON.stringify({ mid, cert, midTs, w: Wstr.split("#"), data }));
    } catch (_) {}
  }
  await schedWait("UploadLog");
  if (process.env.NATIVE_SKIP_UPLOAD !== "1") {
    if (process.env.NATIVE_SEQ_UPLOAD === "1") {
      await post(UPLOAD_URL, uploadBody(cfgFields[8] || "152.59.63.67"), VERIFY_KEY).catch(() => {});
    } else {
      void post(UPLOAD_URL, uploadBody(cfgFields[8] || "152.59.63.67"), VERIFY_KEY).catch(() => {});
    }
  }
  await schedWait("VerifyCaptchaV3");
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
      SignatureNonce: nonce(),
    },
    VERIFY_KEY
  );
  await Promise.allSettled([pLog2, pLog3]);
  const res = vr.Result || {};
  if (res.VerifyResult && res.securityToken) {
    const out = { certifyId: cert, sceneId: SCENE, isSign: true, securityToken: res.securityToken };
    _cached = out;
    _cachedAt = Date.now();
    return { ...out };
  }
  // Consumed/replaced certifyId between init and verify: retry the flow once.
  if ((res.VerifyCode === "F008" || res.VerifyCode === "F002") && !_retried) {
    _retried = true;
    try {
      return await solveCaptcha(opts);
    } finally {
      _retried = false;
    }
  }
  const err = new Error("verify failed: " + (res.VerifyCode || vr.Code) + " " + JSON.stringify(vr).slice(0, 300));
  err.verifyCode = res.VerifyCode;
  err.response = vr;
  throw err;
}

module.exports = { solveCaptcha };
