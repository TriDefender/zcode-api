// @ts-nocheck — ported from the proven Node happy-dom solver (solve-happy-lib.js)
/**
 * captcha-happy.ts — in-process happy-dom Aliyun captcha solver.
 *
 * Ported from the production-proven standalone happy-dom solver to run
 * INSIDE the Bun process so the release binary stays self-contained:
 * no external Node.js, no canvas/playwright/Chromium.
 *
 * Mechanics:
 *  1. cookie priming of https://zcode.z.ai/ (5-min cache)
 *  2. CDN disk cache at ~/.zcode-captcha-cdn-cache/<sha1(url)> + in-mem cache
 *  3. installNativeToString (mask JS-implemented platform APIs as native)
 *  4. per-request client-hint / UA / origin / referer injection (interceptor)
 *  5. guest-side patches (Event.isTrusted, HTMLDocument naming, btoa)
 *  6. solve contract: initAliyunCaptcha + getInstance().startTracelessVerification()
 */
import { GlobalWindow as Window, PropertySymbol } from "happy-dom";
import WindowBrowserContext from "happy-dom/lib/window/WindowBrowserContext.js";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

// ── Blocking fetch for sync XHR (self-contained builds) ────────────────────
// happy-dom implements sync XHR by spawning `process.argv[0] -e <script>`,
// which fails inside a compiled Bun binary (argv[0] is the binary; `-e` is
// not supported). We instead run the request on a worker thread that writes
// the result into a SharedArrayBuffer and wakes the blocked host thread via
// Atomics — no child processes, no main-thread event loop dependency (a
// postMessage-based handshake would deadlock: the main thread is blocked).
const SYNC_FETCH_BUF_BYTES = 8 * 1024 * 1024;
const SYNC_FETCH_HEADER_BYTES = 64;
// SAB layout (Int32 words): [0]=state (0=wait,1=done,2=error), [1]=httpStatus,
// [2]=statusTextLen, [3]=headersJsonLen, [4]=setCookieJsonLen, [5]=bodyLen,
// [6..]=payload bytes (statusText, headersJson, setCookieJson, body)
let _syncFetchWorker: Worker | null = null;

const SYNC_WORKER_SRC = `
  const { parentPort } = require("node:worker_threads");
  const enc = new TextEncoder();
  parentPort.on("message", (m) => {
    (async () => {
      const i32 = new Int32Array(m.sab);
      const u8 = new Uint8Array(m.sab);
      // Fixed-size header (bytes), NOT i32.length * 4 — that is the whole SAB.
      const payloadAt = 64;
      const fail = (msg) => {
        const b = enc.encode(msg);
        u8.set(b, payloadAt);
        i32[5] = b.length; i32[1] = 0; i32[2] = 0; i32[3] = 0; i32[4] = 0;
        i32[0] = 2; Atomics.notify(i32, 0);
      };
      try {
        const res = await fetch(m.url, m.init);
        const body = Buffer.from(await res.arrayBuffer());
        const headers = {};
        for (const [k, v] of res.headers) headers[k] = v;
        const setCookie = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
        const statusText = enc.encode(res.statusText || "");
        const headersJson = enc.encode(JSON.stringify(headers));
        const setCookieJson = enc.encode(JSON.stringify(setCookie));
        let off = payloadAt;
        u8.set(statusText, off); i32[2] = statusText.length; off += statusText.length;
        u8.set(headersJson, off); i32[3] = headersJson.length; off += headersJson.length;
        u8.set(setCookieJson, off); i32[4] = setCookieJson.length; off += setCookieJson.length;
        u8.set(body, off); i32[5] = body.length;
        i32[1] = res.status;
        i32[0] = 1; Atomics.notify(i32, 0);
      } catch (err) {
        fail(String((err && err.message) || err));
      }
    })();
  });
`;

function ensureSyncFetchWorker(): Worker {
  if (_syncFetchWorker) return _syncFetchWorker;
  _syncFetchWorker = new Worker(SYNC_WORKER_SRC, { eval: true });
  return _syncFetchWorker;
}

function syncFetchBlocking(url: string, init: Record<string, unknown>, timeoutMs = 30_000): {
  status: number; statusText: string; headers: Record<string, string>;
  setCookie: string[]; body: Buffer;
} | { error: string } {
  try {
    const worker = ensureSyncFetchWorker();
    const sab = new SharedArrayBuffer(SYNC_FETCH_HEADER_BYTES + SYNC_FETCH_BUF_BYTES);
    const i32 = new Int32Array(sab);
    const u8 = new Uint8Array(sab);
    worker.postMessage({ sab, url, init });
    const waitResult = Atomics.wait(i32, 0, 0, timeoutMs);
    if (waitResult === "timed-out") return { error: "sync fetch timeout" };
    const dec = new TextDecoder();
    const payloadAt = SYNC_FETCH_HEADER_BYTES;
    let off = payloadAt;
    const readSlice = (len: number) => {
      const slice = u8.subarray(off, off + len);
      off += len;
      return slice;
    };
    const statusText = dec.decode(readSlice(i32[2]));
    const headers = i32[3] ? (JSON.parse(dec.decode(readSlice(i32[3]))) as Record<string, string>) : {};
    const setCookie = i32[4] ? (JSON.parse(dec.decode(readSlice(i32[4]))) as string[]) : [];
    const body = Buffer.from(readSlice(i32[5]));
    if (i32[0] === 2) return { error: dec.decode(u8.subarray(payloadAt, payloadAt + i32[5])) || "sync fetch failed" };
    return { status: i32[1], statusText, headers, setCookie, body };
  } catch (err: any) {
    // A crashed worker must not poison later solves — reset it.
    try { _syncFetchWorker?.terminate(); } catch {}
    _syncFetchWorker = null;
    return { error: `sync fetch error: ${err?.message ?? err}` };
  }
}

function shutdownSyncFetchWorker(): void {
  try { _syncFetchWorker?.terminate(); } catch {}
  _syncFetchWorker = null;
}

const CDN_CACHE_DIR = path.join(os.homedir(), ".zcode-captcha-cdn-cache");
const _memCdnCache = new Map();
let _cookieCache = { cookies: [], ts: 0 };
const COOKIE_CACHE_TTL_MS = 5 * 60 * 1000;
const _DEBUG = /^(1|true|yes)$/i.test(
  process.env.CAPTCHA_DEBUG || process.env.CAPTCHA_DEBUG_BODIES || "",
);

const proxyUrl = process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
if (proxyUrl) {
  try {
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
  } catch (_) {}
}

// ── Globals shared across solves ────────────────────────────────────────────
const _requestLog = [];
const solveTimes = [];
// Consecutive-stall tracker per pe bundle URL: the same cached pe version
// can stall every attempt (bad rotated VM variant / stale cache). After two
// stalls on one URL, evict its memory + disk cache entry so the next init
// fetches fresh bytes from the CDN instead of re-stalling on them.
const _stallCounts = new Map();
// Set after a stall: the next solve in this process fetches dynamicJS fresh
// (bypassing mem+disk cache) instead of re-using the bytes that just stalled.
let _bypassPeCacheOnce = false;

function noteStallAndMaybeEvict(peUrl) {
  try {
    if (!peUrl || !/dynamicJS\//.test(peUrl)) return;
    _bypassPeCacheOnce = true;
    const n = (_stallCounts.get(peUrl) || 0) + 1;
    _stallCounts.set(peUrl, n);
    if (n >= 2 && !_DEBUG) {
      process.stderr.write(`[pe-cache-evict] ${peUrl.split("/").pop()} stalled ${n}x — evicting cache\n`);
    }
    if (n >= 2) {
      _memCdnCache.delete(peUrl);
      try { fs.unlinkSync(diskPathFor(peUrl)); } catch (_) {}
      _stallCounts.delete(peUrl);
    }
  } catch (_) {}
}

// ── Fingerprint ─────────────────────────────────────────────────────────────
function generateFingerprint() {
  const userAgent =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";
  const uaMajor = "127";
  const uaFull = "127.0.0.0";
  const platform = "Linux x86_64";
  const screen = { w: 1280, h: 720, aw: 1280, ah: 720 };
  const webglUnmaskedVendor = "Google Inc. (Google)";
  const webglUnmaskedRenderer =
    "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)";
  const canvasImage =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  return { userAgent, uaMajor, uaFull, platform, screen, webglUnmaskedVendor, webglUnmaskedRenderer, canvasImage };
}

const fp = generateFingerprint();

const HTML = `<!DOCTYPE html><html><head></head><body>
<div id="cap"></div><button id="btn"></button>
<script src="https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js"></script>
</body></html>`;

function diskPathFor(url) {
  return path.join(CDN_CACHE_DIR, crypto.createHash("sha1").update(String(url)).digest("hex"));
}

function sniffMime(url) {
  if (/\.js(\?|$)/i.test(url)) return "application/javascript";
  if (/\.css(\?|$)/i.test(url)) return "text/css";
  if (/\.png(\?|$)/i.test(url)) return "image/png";
  if (/\.(jpg|jpeg)(\?|$)/i.test(url)) return "image/jpeg";
  if (/\.json(\?|$)/i.test(url)) return "application/json";
  return "application/octet-stream";
}

// ── pe.* bytecode VM harvest hook (same as solve-core) ──────────────────────
const peVmCallRegex =
  /55==A\?\(f=r\[n\+\+\],l=e\.pop\(\),h=e\.pop\(\),o=\[\],\w+\(f\)\.forEach\(function\(\)\{o\.unshift\(e\.pop\(\)\)\}\),p=null===h\?l\.apply\((\w+),o\):h\[l\]\.apply\(h,o\),r\[n\+\+\]&&e\.push\(p\)\):/;
function patchPeBundle(buf, url) {
  if (process.env.PE_PATCH === "off") return buf;
  if (!/dynamicJS\/[^/]*\/pe\.\d+\./.test(url)) return buf;
  let src = buf.toString("utf8");
  if (src.includes("__DBT")) return buf;
  const m = src.match(peVmCallRegex);
  if (!m) return buf;
  const locals = m[1];
  const hook = `55==A?(f=r[n++],l=e.pop(),h=e.pop(),o=[],v(f).forEach(function(){o.unshift(e.pop())}),p=null===h?l.apply(${locals},o):h[l].apply(h,o),r[n++]&&e.push(p),function(){try{if(l===window.btoa||l===window.atob){window.__DBT=window.__DBT||[];var __sav=[];for(var __i=0;__i<e.length;__i++){var __vv=e[__i];if(typeof __vv==="string"){__sav.push("s:"+__vv)}else if(typeof __vv==="number"){__sav.push("n:"+__vv)}else if(typeof __vv==="boolean"){__sav.push("b:"+__vv)}else if(__vv&&typeof __vv.length==="number"){__sav.push("a:"+__vv.length)}else{__sav.push("t:"+typeof __vv)}}var __ls={};for(var __k2 in ${locals}){if(__k2!=="_"&&__k2!=="*"&&__k2!=="arguments"){try{var __lv=${locals}[__k2];if(typeof __lv==="string"){__ls[__k2]="s:"+__lv}else if(typeof __lv==="number"){__ls[__k2]="n:"+__lv}else if(__lv&&typeof __lv.length==="number"){__ls[__k2]="a:"+__lv.length}else{__ls[__k2]="t:"+typeof __lv}}catch(_e){}}}window.__DBT.push({call:"btoa",ip:n,args:o.map(function(__a){return typeof __a==="string"?"s:"+__a:typeof __a==="number"?"n:"+__a:typeof __a==="function"?"fn:"+(__a.name||"?"):typeof __a==="object"&&__a?"obj":typeof __a}),stack:__sav,locals:__ls,rlen:r.length,r:r})}}catch(_e){}}()):`;
  src = src.replace(m[0], hook);
  if (_DEBUG) process.stderr.write(`[loader-patch] ${url} (VM hook applied, locals=${locals})\n`);
  return Buffer.from(src, "utf8");
}

// ── CDN cache access ────────────────────────────────────────────────────────
function getCachedBody(url) {
  const mem = _memCdnCache.get(url);
  if (mem) return mem;
  try {
    const p = diskPathFor(url);
    if (fs.existsSync(p)) {
      const body = fs.readFileSync(p);
      _memCdnCache.set(url, body);
      return body;
    }
  } catch (_) {}
  return null;
}

async function fetchAndStore(url) {
  try {
    const res = await fetch(url, { headers: { "user-agent": fp.userAgent } });
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 0) {
      _memCdnCache.set(url, buf);
      try {
        const p = diskPathFor(url);
        fs.mkdirSync(CDN_CACHE_DIR, { recursive: true });
        fs.writeFileSync(p, buf);
        // verify write completed (no partial file)
        const stat = fs.statSync(p);
        if (stat.size !== buf.length) {
          process.stderr.write(`[cache-write-short] ${url} wrote ${stat.size}/${buf.length}b — rewrite\n`);
          fs.writeFileSync(p, buf);
        }
      } catch (err) {
        if (_DEBUG) process.stderr.write(`[cache-write-err] ${url}: ${err.message}\n`);
      }
    }
    return buf;
  } catch (err) {
    if (_DEBUG) process.stderr.write(`[loader-fetch-err] ${url}: ${err.message}\n`);
    return null;
  }
}

// ── Request header injection (every frame request: XHR, fetch, scripts) ────
function injectRequestHeaders(request) {
  const h = request.headers;
  try {
    h.set("sec-ch-ua", '"Chromium";v="' + fp.uaMajor + '", "Not)A;Brand";v="24"');
    h.set("sec-ch-ua-mobile", "?0");
    h.set("sec-ch-ua-platform", '"Linux"');
    h.set("user-agent", fp.userAgent);
    h.set("accept-language", "en-US,en;q=0.9");
    h.set("referer", "https://zcode.z.ai/");
    let origin = null;
    try {
      const u = new URL(request.url);
      const method = String(request.method || "GET").toUpperCase();
      const crossOrigin = u.origin !== "https://zcode.z.ai";
      if (crossOrigin || (method !== "GET" && method !== "HEAD")) {
        origin = "https://zcode.z.ai";
      }
    } catch (_) {}
    if (origin) h.set("origin", origin);
  } catch (_) {}
}

function cookieHeader(request, window, browserFrame) {
  try {
    const ctx = browserFrame.page.context;
    const u = new URL(request.url);
    if (request.credentials === "omit") return null;
    const cookies = ctx.cookieContainer.getCookies(u, false);
    if (cookies.length > 0) {
      return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    }
  } catch (_) {}
  return null;
}

function storeSetCookies(res, url) {
  try {
    const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    if (list.length) {
      const cookieContainer = global.__cookieContainer;
      if (cookieContainer) {
        for (const raw of list) {
          const u = new URL(url);
          const parts = raw.split(";");
          const pair = parts[0].split("=");
          const cookie = {
            name: pair[0].trim(),
            value: pair.slice(1).join("=").trim(),
            url: u.origin,
            domain: u.hostname,
            path: "/",
          };
          for (const p of parts.slice(1)) {
            const kv = p.trim().split(/=(.*)/s);
            const k = (kv[0] || "").toLowerCase();
            if (k === "domain" && kv[1]) cookie.domain = kv[1];
            if (k === "path" && kv[1]) cookie.path = kv[1];
            if (k === "expires") cookie.expires = new Date(kv[1]).getTime();
            if (k === "max-age") cookie.maxAge = parseInt(kv[1], 10);
            if (k === "httponly") cookie.httpOnly = true;
            if (k === "secure") cookie.secure = true;
            if (k === "samesite") cookie.sameSite = kv[1];
          }
          try {
            cookieContainer.addCookies([cookie]);
          } catch (_) {}
        }
      }
    }
  } catch (_) {}
}

// ── The interceptor: replaces happy-dom's network layer completely ─────────
// All frame requests (scripts, XHR, fetch, images) funnel through here.
function makeInterceptor(bypassPeCache = false) {
  const skipPeCache = (url) => bypassPeCache && /dynamicJS\/.*\/pe\.\d+\./.test(url);
  return {
    async beforeAsyncRequest({ request, window: w }) {
      const url = request.url;
      _requestLog.push({ at: Date.now(), method: request.method, url });
      injectRequestHeaders(request);
      if (/\balicdn\.com/i.test(url)) {
        let body = skipPeCache(url) ? null : getCachedBody(url);
        if (body && /\.js(\?|$)/i.test(url)) {
          try {
            new Function(body.toString("utf8"));
          } catch (parseErr) {
            process.stderr.write(`[cache-bad-js] ${url} len=${body.length} ${parseErr.message} — refetch fresh\n`);
            _memCdnCache.delete(url);
            try { fs.unlinkSync(diskPathFor(url)); } catch (_) {}
            body = null;
          }
        }
        // sync interceptor serves only from cache; the async interceptor
        // above warms the cache on first load, so misses fall through to
        // the async fetch path handled by happy-dom.
        if (body) {
          if (/dynamicJS\/[^/]*\/pe\.\d+\./.test(url)) {
            try { w.__lastPeUrl = url; } catch (_) {}
          }
          return new w.Response(patchPeBundle(Buffer.from(body), url), {
            status: 200,
            statusText: "OK",
            headers: { "content-type": sniffMime(url) },
          });
        }
      }
      // Passthrough via global fetch (undici; honors global ProxyAgent).
      try {
        const init = { method: request.method, headers: {} };
        request.headers.forEach((value, key) => {
          init.headers[key] = value;
        });
        const bs = new URL(url);
        const cookie = cookieHeader(request, w, global.__browserFrame);
        if (cookie) init.headers.cookie = cookie;
        let hasBody = false;
        try {
          if (request.body) {
            const ab = await request.arrayBuffer();
            if (ab && ab.byteLength > 0) {
              init.body = ab;
              hasBody = true;
            }
          }
        } catch (_) {}
        const res = await fetch(url, init);
        const buf = Buffer.from(await res.arrayBuffer());
        storeSetCookies(res, url);
        if (_DEBUG && /captcha-open|verify\.|device\.saf|cloudauth-device|upload\./i.test(url) && buf.length && buf.length < 4096) {
          try {
            process.stderr.write(`[xhr-body] ${request.method} ${bs.hostname}${bs.pathname}-> ${res.status} ${buf.toString("utf8").slice(0, 1200)}\n`);
          } catch (_) {}
        }
        const headers = {};
        const ct = res.headers.get("content-type");
        if (ct) headers["content-type"] = ct;
        const logHost = bs.hostname;
        if (_DEBUG)
          process.stderr.write(
            `[xhr] ${request.method} ${logHost}${bs.pathname} -> ${res.status} (${buf.length}b)\n`,
          );
        return new w.Response(buf, {
          status: res.status,
          statusText: res.statusText || "",
          headers,
        });
      } catch (err) {
        if (_DEBUG) process.stderr.write(`[xhr-err] ${url}: ${err.message}\n`);
        return new w.Response("", { status: 503, statusText: "passthrough failed" });
      }
    },
    beforeSyncRequest({ request, window: w }) {
      const url = request.url;
      _requestLog.push({ at: Date.now(), method: request.method, url, sync: true });
      injectRequestHeaders(request);
      let body = null;
      if (/\balicdn\.com/i.test(url)) {
        body = skipPeCache(url) ? null : getCachedBody(url);
        if (body && /\.js(\?|$)/i.test(url)) {
          try {
            new Function(body.toString("utf8"));
          } catch (parseErr) {
            process.stderr.write(`[cache-bad-js:sync] ${url} len=${body.length} ${parseErr.message} — refetch fresh\n`);
            _memCdnCache.delete(url);
            try { fs.unlinkSync(diskPathFor(url)); } catch (_) {}
            body = null;
          }
        }
        // sync interceptor serves only from cache; the async interceptor
        // above warms the cache on first load, so misses fall through to
        // the async fetch path handled by happy-dom.
      }
      if (body) {
        if (/dynamicJS\/[^/]*\/pe\.\d+\./.test(url)) {
          try { w.__lastPeUrl = url; } catch (_) {}
        }
        return {
          status: 200,
          statusText: "OK",
          ok: true,
          url,
          redirected: false,
          headers: new w.Headers({ "content-type": sniffMime(url) }),
          body: patchPeBundle(Buffer.from(body), url),
          [PropertySymbol.virtualServerFile]: null,
        };
      }
      // Non-CDN sync request: serve it blocking via a worker thread. Never
      // fall through to happy-dom's own sync fetch — it spawns a child
      // process with `process.argv[0] -e`, which breaks compiled binaries.
      const init = { method: request.method, headers: {} as Record<string, string> };
      request.headers.forEach((value, key) => {
        init.headers[key] = value;
      });
      const cookie = cookieHeader(request, w, global.__browserFrame);
      if (cookie) init.headers.cookie = cookie;
      try {
        if (request.body) {
          const ab = request.body;
          if (ab && (ab as any).byteLength > 0) init.body = ab;
        }
      } catch (_) {}
      const res = syncFetchBlocking(url, init as any) as any;
      if (res.error) {
        process.stderr.write(`[sync-xhr-err] ${url}: ${res.error}\n`);
        return new w.Response("", { status: 503, statusText: "sync fetch failed" });
      }
      try {
        for (const raw of res.setCookie || []) {
          const cookieContainer = global.__cookieContainer;
          if (!cookieContainer) break;
          const u = new URL(url);
          const parts = raw.split(";");
          const pair = parts[0].split("=");
          const cookie: any = {
            name: pair[0].trim(),
            value: pair.slice(1).join("=").trim(),
            url: u.origin,
            domain: u.hostname,
            path: "/",
          };
          for (const p of parts.slice(1)) {
            const kv = p.trim().split(/=(.*)/s);
            const k = (kv[0] || "").toLowerCase();
            if (k === "domain" && kv[1]) cookie.domain = kv[1];
            if (k === "path" && kv[1]) cookie.path = kv[1];
            if (k === "expires") cookie.expires = new Date(kv[1]).getTime();
            if (k === "max-age") cookie.maxAge = parseInt(kv[1], 10);
            if (k === "httponly") cookie.httpOnly = true;
            if (k === "secure") cookie.secure = true;
            if (k === "samesite") cookie.sameSite = kv[1];
          }
          try { cookieContainer.addCookies([cookie]); } catch (_) {}
        }
      } catch (_) {}
      const hdrs: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers || {})) hdrs[k] = String(v);
      // Sync interceptor contract: PLAIN OBJECT with Buffer body (happy-dom's
      // SyncFetch reads `.body.toString()`); a window.Response here would
      // stringify its ReadableStream body and corrupt script loading.
      return {
        status: res.status,
        statusText: res.statusText || "",
        ok: res.status >= 200 && res.status < 300,
        url,
        redirected: false,
        headers: new w.Headers(hdrs),
        body: Buffer.from(res.body),
        [PropertySymbol.virtualServerFile]: null,
      };
    },
  };
}

// ── Parse-fail instrumentation (host side) ─────────────────────────────────
// Wraps happy-dom's VM eval funnel (window[PropertySymbol.evaluateScript]).
// Every script tag / compiled module / dynamic chunk that happy-dom parses
// passes through here with options.filename = source URL, so any SyntaxError
// is dumped with URL + length + head/tail + sha1, and the disk cache is
// re-validated against a fresh CDN fetch when the URL is an http(s) file.
function installEvalInstrumentation(w) {
  const sym = PropertySymbol && PropertySymbol.evaluateScript;
  if (!sym || typeof w[sym] !== "function") {
    process.stderr.write("[instr] no evaluateScript symbol, host hook skipped\n");
    return;
  }
  const orig = w[sym];
  w[sym] = function (code, options) {
    try {
      return orig.call(this, code, options);
    } catch (err) {
      try {
        const src = String(code || "");
        const filename = (options && options.filename) || "?";
        const sha1 = crypto.createHash("sha1").update(src).digest("hex");
        process.stderr.write(
          `\n[EVAL-PARSE-FAIL] file=${filename} len=${src.length} sha1=${sha1}\n` +
            `  head300: ${JSON.stringify(src.slice(0, 300))}\n` +
            `  tail100: ${JSON.stringify(src.slice(-100))}\n` +
            `  err: ${err && err.message}\n`,
        );
        if (/^https?:/.test(filename)) {
          (async () => {
            try {
              const res = await fetch(filename, { headers: { "user-agent": fp.userAgent } });
              const fresh = Buffer.from(await res.arrayBuffer());
              process.stderr.write(
                `[EVAL-CACHE-COMPARE] cachedLen=${src.length} freshLen=${fresh.length} freshSha1=${crypto.createHash("sha1").update(fresh).digest("hex")} http=${res.status}\n`,
              );
              if (fresh.length > 0 && fresh.length !== src.length) {
                process.stderr.write(`[EVAL-CACHE-MISMATCH] deleting ${diskPathFor(filename)} (stale/truncated cache)\n`);
                try {
                  fs.unlinkSync(diskPathFor(filename));
                } catch (_) {}
                _memCdnCache.delete(filename);
              }
            } catch (fetchErr) {
              process.stderr.write(`[EVAL-CACHE-COMPARE-ERR] ${fetchErr.message}\n`);
            }
          })();
        }
      } catch (e2) {}
      throw err;
    }
  };
}

// ── Mask JS-implemented platform APIs as native (FeiLin toString sweep) ─────
function installNativeToString(w) {
  const realToString = Function.prototype.toString;
  const nativeRe = /\[native code\]/;
  const mask = (fn) => {
    if (typeof fn !== "function") return;
    try {
      if (nativeRe.test(realToString.call(fn))) return;
      const name = fn.name || "";
      const nativeStr = `function ${name}() { [native code] }`;
      Object.defineProperty(fn, "toString", {
        value: () => nativeStr,
        configurable: true,
        writable: true,
      });
    } catch (_) {}
  };
  const seen = new w.Set();
  const maskObj = (obj, depth) => {
    if (
      !obj ||
      (typeof obj !== "object" && typeof obj !== "function") ||
      depth > 5
    )
      return;
    // Skip host-realm objects (under Bun, installGlobalWindowAlias exposes
    // Bun internals via window getters; sweeping them crashes on native
    // internal-field slots). happy-dom objects live in the window realm.
    try {
      if (obj.constructor && obj.constructor.prototype !== Object.prototype) {
        const ctorName = obj.constructor.name;
        if (/^(WriteStream|ReadStream|Socket|Process|Timeout|Immediate)$/.test(ctorName)) return;
      }
    } catch (_) {}
    if (seen.has(obj)) return;
    try {
      seen.add(obj);
    } catch (_) {
      return;
    }
    let names = [];
    try {
      names = Object.getOwnPropertyNames(obj);
    } catch (_) {
      return;
    }
    for (const name of names) {
      if (name === "toString" || name === "constructor") continue;
      let desc;
      try {
        desc = Object.getOwnPropertyDescriptor(obj, name);
      } catch (_) {
        continue;
      }
      if (!desc) continue;
      if (typeof desc.value === "function") {
        mask(desc.value);
      } else if (typeof desc.get === "function") {
        mask(desc.get);
        try {
          const v = desc.get.call(obj);
          if (typeof v === "function") mask(v);
        } catch (_) {}
      }
      if (depth < 3) {
        try {
          const v = desc.value;
          if (v && (typeof v === "function" || typeof v === "object"))
            maskObj(v, depth + 1);
        } catch (_) {}
      }
    }
  };
  const targets = [
    w,
    w.navigator,
    w.document,
    w.Document && w.Document.prototype,
    w.Element && w.Element.prototype,
    w.HTMLElement && w.HTMLElement.prototype,
    w.Node && w.Node.prototype,
    w.EventTarget && w.EventTarget.prototype,
    w.HTMLCanvasElement && w.HTMLCanvasElement.prototype,
    w.XMLHttpRequest && w.XMLHttpRequest.prototype,
    w.Event && w.Event.prototype,
    w.Window && w.Window.prototype,
  ].filter(Boolean);
  for (const t of targets) {
    try {
      maskObj(t, 0);
    } catch (_) {}
  }
}

// ── Guest-context patches (run via window.eval inside the VM realm) ─────────
const GUEST_EVAL_PATCH = `
(function() {
  try {
    Object.defineProperty(Event.prototype, "isTrusted", {
      get() { return true; },
      configurable: true
    });
  } catch (e) {}
  try {
    if (window.HTMLDocument) {
      Object.defineProperty(window.HTMLDocument, "name", { value: "HTMLDocument", configurable: true });
      Object.defineProperty(window.HTMLDocument.prototype, Symbol.toStringTag, { value: "HTMLDocument", configurable: true });
    }
  } catch (e) {}
  try {
    Object.defineProperty(window.Document.prototype, Symbol.toStringTag, { value: "HTMLDocument", configurable: true });
  } catch (e) {}
  try {
    window.addEventListener("unhandledrejection", function(e) {
      var r = e && e.reason;
      try {
        console.error("[UH-REASON]", typeof r, r && r.stack ? r.stack.split("\\n").slice(0,6).join(" | ") : (r && r.message), JSON.stringify(r));
      } catch (e2) {}
    });
  } catch (e) {}
  try {
    window.addEventListener("error", function(e) {
      try {
        console.error("[WINDOW-ERROR]", e && e.message, e && e.error && e.error.stack ? e.error.stack.split("\\n").slice(0,6).join(" | ") : "");
      } catch (e2) {}
    });
  } catch (e) {}
  // ---- eval/Function parse-fail instrumentation (installed before pe chain) ----
  // Catches SyntaxError from guest-side eval()/new Function() (the dynamic pe.*
  // chunk is evaluated this way in some SDK paths). Host-side twin: the
  // PropertySymbol.evaluateScript wrapper in installEvalInstrumentation().
  function __capFailDump(kind, code) {
    try {
      var src = String(code || "");
      if (typeof window.__capDebugDump === "function") {
        window.__capDebugDump(window.__lastPeUrl || "?", src, kind);
      } else {
        console.error("[" + kind + "] url=" + (window.__lastPeUrl || "?") + " len=" + src.length + " head=" + JSON.stringify(src.slice(0, 300)) + " tail=" + JSON.stringify(src.slice(-100)));
      }
    } catch (e2) {}
  }
  try {
    var _origEval2 = window.eval;
    if (_origEval2) {
      window.eval = function(code) {
        try { return _origEval2.call(window, code); }
        catch (e) {
          if (e && (/unexpected|invalid|parse|syntax/i.test(String((e && e.message) || e)))) {
            __capFailDump("REALM-EVAL-FAIL", code);
          }
          throw e;
        }
      };
    }
  } catch (e) {}
  try {
    var _of = window.Function;
    if (_of) {
      var _WF = function() {
        var args = Array.prototype.slice.call(arguments);
        var body = args.length ? String(args[args.length - 1]) : "";
        try { return _of.apply(this, args); }
        catch (e) {
          if (e && (/unexpected|invalid|parse|syntax/i.test(String((e && e.message) || e)))) {
            __capFailDump("REALM-FN-FAIL", body);
          }
          throw e;
        }
      };
      _WF.prototype = _of.prototype;
      try { Object.defineProperty(_WF, "name", { value: "Function", configurable: true }); } catch (e) {}
      window.Function = _WF;
    }
  } catch (e) {}
})();
`;

// ── Browser-ish polyfills (ported from solve-core applyPolyfills) ───────────
function applyPolyfills(w) {
  if (process.env.CAPTCHA_DEBUG_BODIES === "1") {
    installTrafficLogger(w);
  }

  // Element constructor shortcuts every real browser exposes. The FeiLin
  // fingerprint SDK references `Option` as a bare identifier; missing it
  // throws inside its probe chain and degrades the fingerprint.
  if (typeof w.Option !== "function") {
    w.Option = class Option extends w.HTMLOptionElement {
      constructor(text, value, defaultSelected, selected) {
        super();
        if (text !== undefined) {
          const el = w.document.createElement("option");
          el.text = text;
          if (value !== undefined) el.value = value;
          if (defaultSelected) el.defaultSelected = true;
          if (selected) el.selected = true;
          return el;
        }
      }
    };
  }
  if (typeof w.Video !== "function" && w.HTMLVideoElement) {
    w.Video = class Video extends w.HTMLVideoElement {
      constructor() { return w.document.createElement("video"); }
    };
  }

  // happy-dom lacks alert/prompt/confirm/open/close (same stubs as
  // solve-shim.js line ~559-561)
  if (typeof w.alert !== "function") w.alert = () => {};
  if (typeof w.prompt !== "function") w.prompt = () => null;
  if (typeof w.confirm !== "function") w.confirm = () => false;
  if (typeof w.open !== "function") w.open = () => null;
  if (typeof w.close !== "function") w.close = () => {};
  try { Object.defineProperty(w, "alert", { value: w.alert, configurable: true, writable: true }); } catch (_) {}
  try { Object.defineProperty(w, "prompt", { value: w.prompt, configurable: true, writable: true }); } catch (_) {}
  try { Object.defineProperty(w, "confirm", { value: w.confirm, configurable: true, writable: true }); } catch (_) {}
  try { Object.defineProperty(w, "open", { value: w.open, configurable: true, writable: true }); } catch (_) {}
  try { Object.defineProperty(w, "close", { value: w.close, configurable: true, writable: true }); } catch (_) {}

  // happy-dom lacks browser globals that FeiLin / the pe risk engine probe.
  // A missing one throws ReferenceError inside the VM machine → breaks the
  // collection chain. Ported from solve-shim.js's stub list.
  const extraGlobals = {
    print: () => {},
    stop: () => {},
    moveTo: () => {},
    moveBy: () => {},
    showModalDialog: () => null,
    find: () => false,
  };
  for (const [k, v] of Object.entries(extraGlobals)) {
    try { Object.defineProperty(w, k, { value: v, configurable: true, writable: true }); } catch (_) {}
  }
  // happy-dom's own open()/close() are destructive (close() tears the window
  // down); the risk engine probes them → neutralize.
  try { Object.defineProperty(w, "open", { value: () => null, configurable: true, writable: true }); } catch (_) {}
  try { Object.defineProperty(w, "close", { value: () => {}, configurable: true, writable: true }); } catch (_) {}

  if (!w.Option) {
    w.Option = class {
      constructor(text, value, defaultSelected, selected) {
        this.text = text ?? "";
        this.value = value ?? "";
        this.selected = selected ?? defaultSelected ?? false;
        this.defaultSelected = !!defaultSelected;
        this.disabled = false;
        this.label = this.text;
        this.index = 0;
      }
    };
  }

  if (!w.EventSource) {
    w.EventSource = class {
      constructor() {
        this.readyState = 2;
        this.onopen = null;
        this.onmessage = null;
        this.onerror = null;
      }
      close() {
        this.readyState = 2;
      }
      addEventListener() {}
      removeEventListener() {}
    };
  }

  if (!w.Beacon) w.Beacon = class {};

  if (!w.RTCPeerConnection) {
    w.RTCPeerConnection = class {
      constructor() {}
      createDataChannel() { return {}; }
      close() {}
      createOffer() { return Promise.resolve({}); }
      setLocalDescription() { return Promise.resolve(); }
      addEventListener() {}
      removeEventListener() {}
    };
  }

  if (!w.MessageChannel) {
    w.MessageChannel = class {
      constructor() {
        this.port1 = { onmessage: null, postMessage() {}, start() {}, close() {}, addEventListener() {}, removeEventListener() {} };
        this.port2 = { onmessage: null, postMessage() {}, start() {}, close() {}, addEventListener() {}, removeEventListener() {} };
      }
    };
  }

  w.IntersectionObserver =
    w.IntersectionObserver ||
    class {
      constructor(cb) {
        this.cb = cb;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    };

  w.ResizeObserver =
    w.ResizeObserver ||
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };

  w.DeviceOrientationEvent =
    w.DeviceOrientationEvent ||
    class extends w.Event {
      constructor(type, opts) {
        super(type, opts);
      }
      alpha = null;
      beta = null;
      gamma = null;
      absolute = false;
    };

  w.DeviceMotionEvent =
    w.DeviceMotionEvent ||
    class extends w.Event {
      constructor(type, opts) {
        super(type, opts);
      }
      acceleration = null;
      accelerationIncludingGravity = null;
      rotationRate = null;
      interval = 16;
    };

  w.requestIdleCallback = w.requestIdleCallback || ((cb) => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 10 }), 1));
  w.cancelIdleCallback = w.cancelIdleCallback || ((id) => clearTimeout(id));

  w.matchMedia =
    w.matchMedia ||
    (() => ({
      matches: false,
      media: "",
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return false;
      },
    }));

  if (!w.visualViewport) {
    const VisualViewport = function () {};
    VisualViewport.prototype = {
      width: fp.screen.w - 16,
      height: fp.screen.h - 120,
      scale: 1,
      offsetLeft: 0,
      offsetTop: 0,
      pageLeft: 0,
      pageTop: 0,
      onresize: null,
      onscroll: null,
      onscrollend: null,
    };
    w.VisualViewport = VisualViewport;
    w.visualViewport = Object.create(w.VisualViewport.prototype);
  }

  if (!w.indexedDB) {
    const IDBFactory = function () {};
    IDBFactory.prototype = {
      open: () => ({ onupgradeneeded: null, onsuccess: null, onerror: null }),
      deleteDatabase: () => ({}),
      databases: () => Promise.resolve([]),
    };
    w.IDBFactory = IDBFactory;
    w.indexedDB = Object.create(w.IDBFactory.prototype);
  }

  if (!w.speechSynthesis) {
    const SpeechSynthesis = function () {};
    SpeechSynthesis.prototype = {
      speak() {},
      cancel() {},
      pause() {},
      resume() {},
      getVoices: () => [],
    };
    w.SpeechSynthesis = SpeechSynthesis;
    w.speechSynthesis = Object.create(w.SpeechSynthesis.prototype);
    w.SpeechSynthesisUtterance = function () {};
  }

  w.Worker =
    w.Worker ||
    class {
      postMessage() {}
      terminate() {}
      addEventListener() {}
      removeEventListener() {}
    };

  w.Notification =
    w.Notification ||
    class {
      static permission = "default";
      static requestPermission() {
        return Promise.resolve("default");
      }
      close() {}
    };

  // Canvas / WebGL
  const proto = w.HTMLCanvasElement.prototype;
  const nativeGetContext = typeof proto.getContext === "function" ? proto.getContext : null;
  proto.getContext = function (type, ...rest) {
    if (/webgl/i.test(type)) {
      return makeWebGLMock(this);
    }
    if (nativeGetContext) {
      try {
        const ctx = nativeGetContext.call(this, type, ...rest);
        if (ctx) return ctx;
      } catch (_) {}
    }
    return make2DStub(this);
  };

  function makeWebGLMock(canvas) {
    return {
      canvas,
      getParameter(p) {
        if (p === 7936) return "WebKit";
        if (p === 7937) return "WebKit WebGL";
        if (p === 7938) return "WebGL 1.0 (OpenGL ES 2.0 Chromium)";
        if (p === 35724) return "WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)";
        if (p === 0x9245) return fp.webglUnmaskedVendor;
        if (p === 0x9246) return fp.webglUnmaskedRenderer;
        return "Intel Inc.";
      },
      getExtension(name) {
        if (name === "WEBGL_debug_renderer_info") {
          return { UNMASKED_VENDOR_WEBGL: 0x9245, UNMASKED_RENDERER_WEBGL: 0x9246 };
        }
        return null;
      },
      getSupportedExtensions() {
        return [
          "ANGLE_instanced_arrays", "EXT_blend_minmax", "EXT_color_buffer_half_float",
          "EXT_disjoint_timer_query", "EXT_float_blend", "EXT_frag_depth",
          "EXT_shader_texture_lod", "EXT_texture_compression_bptc",
          "EXT_texture_compression_rgtc", "EXT_texture_filter_anisotropic",
          "EXT_sRGB", "KHR_parallel_shader_compile", "OES_element_index_uint",
          "OES_fbo_render_mipmap", "OES_standard_derivatives",
          "OES_texture_float", "OES_texture_float_linear",
          "OES_texture_half_float", "OES_texture_half_float_linear",
          "OES_vertex_array_object", "WEBGL_color_buffer_float",
          "WEBGL_compressed_texture_astc", "WEBGL_compressed_texture_etc",
          "WEBGL_compressed_texture_etc1", "WEBGL_compressed_texture_s3tc",
          "WEBGL_compressed_texture_s3tc_srgb", "WEBGL_debug_renderer_info",
          "WEBGL_debug_shaders", "WEBGL_depth_texture", "WEBGL_draw_buffers",
          "WEBGL_lose_context", "WEBGL_multi_draw",
        ];
      },
      getContextAttributes() {
        return {
          alpha: true, antialias: true, depth: true,
          failIfMajorPerformanceCaveat: false, powerPreference: "default",
          premultipliedAlpha: true, preserveDrawingBuffer: false,
          stencil: false, desynchronized: false,
        };
      },
      getShaderPrecisionFormat() {
        return { precision: 23, rangeMin: 127, rangeMax: 127 };
      },
    };
  }

  function make2DStub(canvas) {
    return {
      canvas,
      fillRect() {},
      clearRect() {},
      getImageData: (_x, _y, w2 = 1, h2 = 1) => new w.ImageData(w2, h2),
      putImageData() {},
      createImageData: (w2 = 1, h2 = 1) => new w.ImageData(w2, h2),
      setTransform() {},
      transform() {},
      drawImage() {},
      save() {},
      restore() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      bezierCurveTo() {},
      quadraticCurveTo() {},
      closePath() {},
      clip() {},
      stroke() {},
      fill() {},
      arc() {},
      rect() {},
      ellipse() {},
      translate() {},
      scale() {},
      rotate() {},
      fillText() {},
      strokeText() {},
      measureText: (t) => ({ width: String(t).length * 8 }),
      createLinearGradient: () => ({ addColorStop() {} }),
      createRadialGradient: () => ({ addColorStop() {} }),
      createPattern: () => ({}),
      isPointInPath: () => false,
      font: "10px sans-serif",
      textBaseline: "alphabetic",
      textAlign: "start",
      fillStyle: "#000",
      strokeStyle: "#000",
      globalAlpha: 1,
      lineWidth: 1,
      shadowBlur: 0,
      shadowColor: "",
    };
  }

  const nativeToDataURL = typeof proto.toDataURL === "function" ? proto.toDataURL : null;
  proto.toDataURL = function (...a) {
    try {
      if (nativeToDataURL) return nativeToDataURL.apply(this, a);
    } catch (_) {}
    return fp.canvasImage;
  };
  if (typeof proto.toBlob !== "function") {
    proto.toBlob = (cb) => cb && cb(new w.Blob());
  }

  w.OffscreenCanvas =
    w.OffscreenCanvas ||
    class {
      constructor(width, height) {
        this.width = width;
        this.height = height;
      }
      getContext() {
        return proto.getContext.call(this);
      }
    };

  const audioMock = class {
    constructor() {
      this.sampleRate = 44100;
      this.currentTime = 0;
      this.state = "suspended";
    }
    createOscillator() {
      return {
        type: "sine",
        frequency: { value: 440, setValueAtTime() {} },
        connect() {},
        start() {},
        stop() {},
      };
    }
    createDynamicsCompressor() {
      return {
        threshold: { value: -24, setValueAtTime() {} },
        knee: { value: 30, setValueAtTime() {} },
        ratio: { value: 12, setValueAtTime() {} },
        attack: { value: 0.003, setValueAtTime() {} },
        release: { value: 0.25, setValueAtTime() {} },
        connect() {},
      };
    }
    createAnalyser() {
      return {
        fftSize: 2048,
        frequencyBinCount: 1024,
        getByteFrequencyData() {},
        getByteTimeDomainData() {},
        connect() {},
      };
    }
    createGain() {
      return { gain: { value: 1 }, connect() {} };
    }
    destination = {};
    resume() {
      this.state = "running";
      return Promise.resolve();
    }
    close() {
      this.state = "closed";
      return Promise.resolve();
    }
  };
  w.AudioContext = w.AudioContext || audioMock;
  w.OfflineAudioContext =
    w.OfflineAudioContext ||
    class extends audioMock {
      constructor(_channels, length, sampleRate) {
        super();
        this.length = length;
        this.sampleRate = sampleRate;
      }
      startRendering() {
        const len = this.length || 44100;
        const sr = this.sampleRate || 44100;
        const buf = new Float32Array(len);
        for (let i = 0; i < len; i += 1) {
          const t = i / sr;
          buf[i] =
            Math.sin(2 * Math.PI * 1000 * t) * Math.exp(-t * 1.2) * 0.6 +
            Math.sin(2 * Math.PI * 3000 * t) * Math.exp(-t * 1.5) * 0.25 +
            Math.sin(2 * Math.PI * 5000 * t) * Math.exp(-t * 2.0) * 0.12;
        }
        return Promise.resolve({
          numberOfChannels: 1,
          length: len,
          sampleRate: sr,
          getChannelData: () => buf,
        });
      }
    };

  w.requestAnimationFrame = w.requestAnimationFrame || ((cb) => setTimeout(() => cb(Date.now()), 16));
  w.cancelAnimationFrame = w.cancelAnimationFrame || ((id) => clearTimeout(id));

  try {
    Object.defineProperty(w.document, "hidden", { value: false, configurable: true });
    Object.defineProperty(w.document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
  } catch (_) {}

  if (!w.document.fonts) {
    w.document.fonts = {
      ready: Promise.resolve(),
      check: () => true,
      addEventListener() {},
      removeEventListener() {},
    };
  }

  if (!w.chrome) {
    w.chrome = {
      app: {
        isInstalled: false,
        InstallState: { DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" },
        RunningState: { CANNOT_RUN: "cannot_run", CAN_RUN: "can_run", RUNNING: "running" },
        getDetails() { return null; },
        getIsInstalled() { return false; },
        installState(cb) { if (cb) cb("not_installed"); },
        runningState(cb) { if (cb) cb("cannot_run"); },
      },
      csi() {
        const now = Date.now();
        return { startE: now - 100, onloadT: now, pageT: 100, tran: 15 };
      },
      loadTimes() {
        const now = Date.now() / 1000;
        return {
          requestTime: now - 0.1, startLoadTime: now - 0.1,
          commitLoadTime: now - 0.05, finishDocumentLoadTime: now,
          finishLoadTime: now, firstPaintTime: now - 0.02,
          firstPaintAfterLoadTime: 0, navigationType: "Other",
          wasFetchedViaSpdy: true, wasNpnNegotiated: true,
          npnNegotiatedProtocol: "h2", wasAlternateProtocolAvailable: false,
          connectionInfo: "h2",
        };
      },
    };
  }

  // navigator patch
  const nav = w.navigator;
  const plugins = createNavigatorPlugins(w);
  const navPatch = {
    userAgent: fp.userAgent,
    platform: fp.platform,
    language: "en-US",
    languages: ["en-US", "en"],
    vendor: "Google Inc.",
    webdriver: false,
    hardwareConcurrency: 12,
    deviceMemory: 8,
    maxTouchPoints: 0,
    cookieEnabled: true,
    plugins: plugins.plugins,
    mimeTypes: plugins.mimeTypes,
    appVersion: fp.userAgent.replace(/^Mozilla\//, ""),
    appName: "Netscape",
    appCodeName: "Mozilla",
    product: "Gecko",
    productSub: "20030107",
    vendorSub: "",
    oscpu: undefined,
    doNotTrack: null,
    sendBeacon: (url, data) => {
      try {
        const xhr = new w.XMLHttpRequest();
        xhr.open("POST", url, true);
        xhr.send(data);
        return true;
      } catch (_) {
        return false;
      }
    },
  };
  for (const [k, v] of Object.entries(navPatch)) {
    try {
      Object.defineProperty(nav, k, { value: v, configurable: true });
    } catch (_) {}
  }

  // polyfill navigator sub-objects that happy-dom lacks
  const makeNS = (protoObj) => {
    const C = new w.Function();
    C.prototype = protoObj;
    return new C();
  };

  if (!nav.connection) {
    const NetInfo = () => {};
    NetInfo.prototype = { onchange: null, effectiveType: "4g", rtt: 50, downlink: 10, saveData: false };
    w.NetworkInformation = NetInfo;
    try {
      Object.defineProperty(nav, "connection", { value: makeNS(NetInfo.prototype), configurable: true });
    } catch (_) {}
  }
  if (!nav.userAgentData) {
    const UAData = function () {};
    UAData.prototype = {
      brands: [
        { brand: "Chromium", version: fp.uaMajor },
        { brand: "Not)A;Brand", version: "24" },
      ],
      mobile: false,
      platform: "Linux",
      getHighEntropyValues: () =>
        Promise.resolve({
          brands: [
            { brand: "Chromium", version: fp.uaMajor },
            { brand: "Not)A;Brand", version: "24" },
          ],
          mobile: false,
          platform: "Linux",
          platformVersion: "6.5.0",
          architecture: "x86",
          model: "",
          uaFullVersion: fp.uaFull,
          fullVersionList: [
            { brand: "Chromium", version: fp.uaFull },
            { brand: "Not)A;Brand", version: "24.0.0.0" },
          ],
        }),
    };
    try {
      Object.defineProperty(nav, "userAgentData", { value: makeNS(UAData.prototype), configurable: true });
    } catch (_) {}
  }
  if (!w.Permissions) {
    const Perms = () => {};
    Perms.prototype = {
      query: (param) =>
        Promise.resolve({ state: param.name === "notifications" ? "prompt" : "granted", onchange: null }),
    };
    w.Permissions = Perms;
  }
  try {
    if (!nav.permissions) Object.defineProperty(nav, "permissions", { value: makeNS(w.Permissions.prototype), configurable: true });
  } catch (_) {}
  try {
    if (!nav.clipboard)
      Object.defineProperty(nav, "clipboard", {
        value: makeNS({ readText: () => Promise.resolve(""), writeText: () => Promise.resolve() }),
        configurable: true,
      });
  } catch (_) {}
  try {
    if (!nav.geolocation)
      Object.defineProperty(nav, "geolocation", {
        value: makeNS({
          getCurrentPosition: (s) => s && s({ coords: { latitude: 0, longitude: 0, accuracy: 1 } }),
          watchPosition: () => 1,
          clearWatch: () => {},
        }),
        configurable: true,
      });
  } catch (_) {}
  try {
    if (!nav.credentials)
      Object.defineProperty(nav, "credentials", {
        value: makeNS({ get: () => Promise.resolve(null), create: () => Promise.resolve(null), store: () => Promise.resolve(), preventSilentAccess: () => Promise.resolve() }),
        configurable: true,
      });
  } catch (_) {}
  try {
    if (!nav.storage)
      Object.defineProperty(nav, "storage", {
        value: makeNS({ estimate: () => Promise.resolve({ quota: 1e8, usage: 0 }), persisted: () => Promise.resolve(false), persist: () => Promise.resolve(false) }),
        configurable: true,
      });
  } catch (_) {}
  try {
    if (!nav.usb)
      Object.defineProperty(nav, "usb", {
        value: makeNS({ getDevices: () => Promise.resolve([]), requestDevice: () => Promise.reject(new Error("no devices")) }),
        configurable: true,
      });
  } catch (_) {}
  try {
    if (!nav.mediaDevices)
      Object.defineProperty(nav, "mediaDevices", {
        value: makeNS({ enumerateDevices: () => Promise.resolve([]), getUserMedia: () => Promise.reject(new Error("NotAllowedError")) }),
        configurable: true,
      });
  } catch (_) {}

  // screen
  const screenPatch = {
    width: fp.screen.w,
    height: fp.screen.h,
    availWidth: fp.screen.w,
    availHeight: fp.screen.ah,
    availLeft: 0,
    availTop: 0,
    colorDepth: 24,
    pixelDepth: 24,
    orientation: { angle: 0, type: "landscape-primary", onchange: null },
  };
  for (const [k, v] of Object.entries(screenPatch)) {
    try {
      Object.defineProperty(w.screen, k, { get: () => v, configurable: true });
    } catch (_) {}
  }

  w.outerWidth = fp.screen.w;
  w.outerHeight = fp.screen.h - 40;
  w.innerWidth = fp.screen.w - 16;
  w.innerHeight = fp.screen.h - 120;
  w.devicePixelRatio = 1;
}

function createNavigatorPlugins(w) {
  const indexed = [
    { name: "PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
    { name: "Chrome PDF Viewer", filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai", description: "" },
    { name: "Chromium PDF Viewer", filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai", description: "" },
  ];
  const plugins = w.PluginArray ? Object.create(w.PluginArray.prototype) : {};
  const mockIndexed = [];
  for (let i = 0; i < indexed.length; i++) {
    const p = Object.create((w.Plugin && w.Plugin.prototype) || Object.prototype);
    Object.defineProperty(p, "name", { value: indexed[i].name, configurable: true, enumerable: true });
    Object.defineProperty(p, "filename", { value: indexed[i].filename, configurable: true, enumerable: true });
    Object.defineProperty(p, "description", { value: indexed[i].description, configurable: true, enumerable: true });
    Object.defineProperty(p, "length", { value: 1, configurable: true, enumerable: true });
    Object.defineProperty(p, "0", { value: p, configurable: true, enumerable: true });
    p.item = () => p;
    p.namedItem = () => p;
    plugins[i] = p;
    mockIndexed.push(p);
  }
  Object.defineProperty(plugins, "length", { value: indexed.length, configurable: true, enumerable: true });
  plugins.item = (i) => plugins[i] ?? null;
  plugins.namedItem = (name) => mockIndexed.find((p) => p.name === name) ?? null;
  plugins.refresh = () => {};
  const mimeTypes =
    w.MimeTypeArray ? Object.create(w.MimeTypeArray.prototype) : {};
  Object.defineProperty(mimeTypes, "length", { value: 0, configurable: true, enumerable: true });
  mimeTypes.item = () => null;
  mimeTypes.namedItem = () => null;
  return { plugins, mimeTypes };
}

// ── Traffic logger (XHR/fetch URL capture per solve) ───────────────────────
function installTrafficLogger(w) {
  const origOpen = w.XMLHttpRequest.prototype.open;
  const origSend = w.XMLHttpRequest.prototype.send;
  w.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__capMethod = method;
    this.__capUrl = url;
    return origOpen.call(this, method, url, ...rest);
  };
  w.XMLHttpRequest.prototype.send = function (body) {
    const url = String(this.__capUrl || "");
    const DEBUG_HOSTS = /(cloudauth-device|captcha-open|verify|upload|nocaptcha|aliyuncs)/i;
    if (DEBUG_HOSTS.test(url)) {
      this.addEventListener("load", () => {
        let respPreview = "";
        try {
          respPreview = String(this.responseText || "").slice(0, 3000);
        } catch (_) {}
        try {
          process.stderr.write(
            `\n===== XHR ${String(this.__capMethod || "?")} ${url}\n--- RESP (${respPreview.length}b) ---\n${respPreview}\n=====\n`,
          );
        } catch (_) {}
      });
    }
    return origSend.call(this, body);
  };
}

function safeJson(x) {
  try {
    if (x instanceof Error) return `Error: ${x.message}\n${(x.stack || "").slice(0, 1500)}`;
    const s = JSON.stringify(x);
    return s !== undefined && s.length < 3000 ? s : String(x);
  } catch (_) {
    return String(x);
  }
}

// ── Behavioral priming (FeiLin human-motion buffer) ────────────────────────
function simulateBehavior(w, durationMs = 600) {
  const { document, MouseEvent, KeyboardEvent, UIEvent } = w;
  if (!document || !MouseEvent) return;
  const fire = (type, ctor, opts) => {
    try {
      const Ctor = ctor || UIEvent;
      const ev = new Ctor(type, { bubbles: true, cancelable: true, view: w, ...opts });
      document.dispatchEvent(ev);
      if (document.body) document.body.dispatchEvent(ev);
    } catch (_) {}
  };
  let x = 140 + Math.random() * 30;
  let y = 110 + Math.random() * 20;
  const targetX = 540 + Math.random() * 40;
  const targetY = 380 + Math.random() * 30;
  const steps = 22;
  let i = 0;
  const start = Date.now();
  const moveStep = () => {
    if (i > steps) return;
    x += (targetX - x) * 0.16 + (Math.random() - 0.5) * 5;
    y += (targetY - y) * 0.16 + (Math.random() - 0.5) * 4;
    fire("mousemove", MouseEvent, {
      screenX: Math.round(x),
      screenY: Math.round(y),
      clientX: Math.round(x),
      clientY: Math.round(y),
      button: 0,
      buttons: 1,
    });
    i += 1;
    const done = Date.now() - start >= durationMs;
    if (i <= steps && !done) {
      setTimeout(moveStep, 26 + Math.floor(Math.random() * 32));
    } else {
      fire("mousedown", MouseEvent, { clientX: Math.round(x), clientY: Math.round(y), button: 0, buttons: 1 });
      fire("mouseup", MouseEvent, { clientX: Math.round(x), clientY: Math.round(y), button: 0, buttons: 0 });
      fire("click", MouseEvent, { clientX: Math.round(x), clientY: Math.round(y), button: 0 });
      try {
        fire("keyup", KeyboardEvent, { key: "a", code: "KeyA", keyCode: 65, which: 65 });
      } catch (_) {}
    }
  };
  moveStep();
}

function waitFor(cond, timeoutMs = 15_000, intervalMs = 40) {
  return new Promise((res, rej) => {
    const started = Date.now();
    const timer = setInterval(() => {
      let ok = false;
      try {
        ok = cond();
      } catch (_) {}
      if (ok) {
        clearInterval(timer);
        res();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        rej(new Error("timeout"));
      }
    }, intervalMs);
  });
}

// ── createDom ──────────────────────────────────────────────────────────────
async function createDom(region, prefix) {
  let cookies = [];
  const now = Date.now();
  if (_cookieCache.ts > 0 && now - _cookieCache.ts < COOKIE_CACHE_TTL_MS) {
    cookies = _cookieCache.cookies;
  } else {
    try {
      const res = await fetch("https://zcode.z.ai/", {
        headers: {
          "User-Agent": fp.userAgent,
          "sec-ch-ua": '"Chromium";v="' + fp.uaMajor + '", "Not)A;Brand";v="24"',
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": '"Linux"',
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
      cookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
      _cookieCache = { cookies, ts: Date.now() };
    } catch (_) {}
  }

  const interceptor = makeInterceptor(_bypassPeCacheOnce);
  _bypassPeCacheOnce = false;
  // Registered once per process — adding it inside createDom leaked a new
  // EventEmitter listener per solve (MaxListenersExceededWarning + growth).
  if (!process.__capUnhandledRejectionHooked) {
    process.__capUnhandledRejectionHooked = true;
    process.on("unhandledRejection", (reason) => {
      if (!_DEBUG) return;
      try {
        const r = reason && reason.stack ? reason.stack : String(reason);
        process.stderr.write(`[host-unhandledRejection] ${typeof reason} ${JSON.stringify(reason).slice(0, 200)} ${r}\n`);
      } catch (_) {}
    });
    // Guest scripts (rotated pe/FeiLin bundles) can throw synchronous errors
    // that surface as uncaughtExceptions. Without a handler, happy-dom's
    // exception observer (or Bun's default) terminates the whole proxy —
    // a single bad pe version must only fail that one solve, not the server.
    process.on("uncaughtException", (err) => {
      try {
        const msg = err && err.message ? err.message : String(err);
        process.stderr.write(`[captcha-guest-uncaught] ${msg}\n`);
      } catch (_) {}
    });
  }
  // Guest console is silent unless CAPTCHA_DEBUG — piping every SDK log to
  // stderr spams journald and slows mints under systemd.
  const noop = () => {};
  const guestConsole = _DEBUG
    ? {
        log: (...a) => process.stderr.write(`[guest-log] ${a.map((x) => (typeof x === "object" ? safeJson(x) : String(x))).join(" ")}\n`),
        warn: (...a) => process.stderr.write(`[guest-warn] ${a.map((x) => (typeof x === "object" ? safeJson(x) : String(x))).join(" ")}\n`),
        error: (...a) => process.stderr.write(`[guest-err] ${a.map((x) => (typeof x === "object" ? safeJson(x) : String(x))).join(" ")}\n`),
        info: (...a) => process.stderr.write(`[guest-info] ${a.map((x) => (typeof x === "object" ? safeJson(x) : String(x))).join(" ")}\n`),
        debug: (...a) => process.stderr.write(`[guest-debug] ${a.map((x) => (typeof x === "object" ? safeJson(x) : String(x))).join(" ")}\n`),
        trace: (...a) => process.stderr.write(`[guest-trace] ${a.map((x) => (typeof x === "object" ? safeJson(x) : String(x))).join(" ")}\n`),
      }
    : { log: noop, warn: noop, error: noop, info: noop, debug: noop, trace: noop };
  const w = new Window({
    url: "https://zcode.z.ai/",
    console: guestConsole,
    settings: {
      enableJavaScriptEvaluation: true,
      enableImageFileLoading: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
      navigator: { userAgent: fp.userAgent },
      viewport: { width: fp.screen.w, height: fp.screen.h, devicePixelRatio: 1 },
      fetch: {
        disableSameOriginPolicy: true,
        interceptor,
      },
    },
  });

  // Reach into the frame for cookie container + frame ref (host side helpers).
  // WindowBrowserContext imported at module scope
  const browserFrame = new WindowBrowserContext(w).getBrowserFrame();
  global.__browserFrame = browserFrame;
  global.__cookieContainer = browserFrame.page.context.cookieContainer;

  // Cookie priming
  for (const raw of cookies) {
    try {
      const u = new URL("https://zcode.z.ai/");
      const parts = raw.split(";");
      const pair = parts[0].split("=");
      const cookie = {
        name: pair[0].trim(),
        value: pair.slice(1).join("=").trim(),
        url: u.origin,
        domain: u.hostname,
        path: "/",
      };
      for (const p of parts.slice(1)) {
        const kv = p.trim().split(/=(.*)/s);
        const k = (kv[0] || "").toLowerCase();
        if (k === "domain" && kv[1]) cookie.domain = kv[1];
        if (k === "path" && kv[1]) cookie.path = kv[1];
        if (k === "expires") cookie.expires = new Date(kv[1]).getTime();
        if (k === "max-age") cookie.maxAge = parseInt(kv[1], 10);
        if (k === "httponly") cookie.httpOnly = true;
        if (k === "secure") cookie.secure = true;
        if (k === "samesite") cookie.sameSite = kv[1];
      }
      browserFrame.page.context.cookieContainer.addCookies([cookie]);
    } catch (_) {}
  }

  const visitorId = crypto.randomUUID();
  const deviceMid = crypto.randomUUID();
  const pre = [
    { name: "zcode_visitor_id", value: visitorId, domain: "zcode.z.ai" },
    { name: "zcode_device_mid", value: deviceMid, domain: "zcode.z.ai" },
    { name: "visitor_id", value: visitorId, domain: "zcode.z.ai", httpOnly: true },
  ];
  for (const c of pre) {
    try {
      browserFrame.page.context.cookieContainer.addCookies([{ ...c, url: "https://zcode.z.ai", path: "/" }]);
    } catch (_) {}
  }

  // Apply polyfills + masking BEFORE the SDK script runs.
  // Bun compatibility: happy-dom's VM realm isolation doesn't apply under
  // Bun — script tags execute against the host globalThis, where bare
  // `window`/`document`/`location` identifiers don't exist. Node needs none
  // of this (its VM context resolves them natively). We alias the current
  // solve's window on globalThis and remove the aliases when the window is
  // destroyed, so concurrent solves with window reuse stay consistent.
  applyPolyfills(w);
  installNativeToString(w);
  installEvalInstrumentation(w);
  // Bun alias pass runs AFTER polyfills so polyfilled props (Option, Video,
  // alert, ...) are visible to guest scripts via globalThis too.
  const needsGlobalAlias = typeof Bun !== "undefined";
  if (needsGlobalAlias) {
    const g = globalThis;
    installGlobalWindowAlias(g, w);
  }
  if (w.Error) {
    w.Error.prepareStackTrace = Error.prepareStackTrace;
  }
  // Host-side recorder the guest dump helper calls: computes sha1 of the failing
  // source (guest realm has no node crypto) and re-checks the pe disk cache.
  w.__capDebugDump = (url, src, kind) => {
    try {
      const s = String(src || "");
      const sha1 = crypto.createHash("sha1").update(s).digest("hex");
      process.stderr.write(
        `\n[${kind}] url=${url} len=${s.length} sha1=${sha1}\n` +
          `  head300: ${JSON.stringify(s.slice(0, 300))}\n` +
          `  tail100: ${JSON.stringify(s.slice(-100))}\n`,
      );
      if (/^https?:/.test(String(url))) {
        (async () => {
          try {
            const res = await fetch(url, { headers: { "user-agent": fp.userAgent } });
            const fresh = Buffer.from(await res.arrayBuffer());
            process.stderr.write(
              `[${kind}-CACHE-COMPARE] cachedLen=${s.length} freshLen=${fresh.length} freshSha1=${crypto.createHash("sha1").update(fresh).digest("hex")} http=${res.status}\n`,
            );
            if (fresh.length > 0 && fresh.length !== s.length) {
              process.stderr.write(`[${kind}-MISMATCH] deleting ${diskPathFor(url)} (stale/truncated cache)\n`);
              try {
                fs.unlinkSync(diskPathFor(url));
              } catch (_) {}
              _memCdnCache.delete(url);
            }
          } catch (fetchErr) {
            process.stderr.write(`[${kind}-CACHE-COMPARE-ERR] ${fetchErr.message}\n`);
          }
        })();
      }
    } catch (_) {}
  };
  w.eval(GUEST_EVAL_PATCH);

  // Write the page HTML (loads the SDK script)
  w.document.write(HTML);

  w.AliyunCaptchaConfig = { region, prefix };

  return { window: w, browserFrame };
}

// Bun-only: alias the active window on globalThis (script tags run in the
// Bun-only: alias the active window on globalThis (script tags run in the
// host realm under Bun). Every own enumerable window property is exposed as a
// getter so guest scripts resolving bare identifiers (window, document,
// XMLHttpRequest, Range, HTMLElement, ...) find them, exactly as Node's VM
// realm would. Removed again in destroyDom.
// Names that must NOT be shadowed on globalThis — Bun/Node host internals the
// window happens to expose but the host runtime depends on.
const HOST_CRITICAL_GLOBALS = new Set([
  "process", "Bun", "console", "performance", "crypto", "fetch",
  "queueMicrotask", "structuredClone", "TextEncoder", "TextDecoder",
  "requestAnimationFrame", "cancelAnimationFrame",
  // NOTE: `print` was removed from this list (2026-08-29). The polyfill
  // defines a harmless no-op on the window, but the alias pass skipped it,
  // so under Bun (guest scripts run in the HOST realm) the Aliyun pe risk
  // engine hit a bare `print` reference → ReferenceError → broken
  // fingerprint chain → degraded solve success rate (711 WINDOW-ERRORs in
  // one day). Bun's host global has no native `print`, so aliasing the
  // stub shadows nothing critical.
  "URL", "URLSearchParams", "AbortController", "AbortSignal",
  "ReadableStream", "WritableStream", "TransformStream", "Blob", "File",
  "FormData", "Headers", "Request", "Response", "Event", "EventTarget",
  "MessageChannel", "MessagePort", "Buffer", "global", "globalThis",
  // JS intrinsics — GlobalWindow re-exposes them as class fields; the host
  // versions are fine, so never shadow them.
  "Array", "ArrayBuffer", "Boolean", "DataView", "Date", "Error",
  "EvalError", "Float32Array", "Float64Array", "Function", "Infinity",
  "Int8Array", "Int16Array", "Int32Array", "Intl", "JSON", "Map", "Math",
  "NaN", "Number", "Object", "Promise", "RangeError", "ReferenceError",
  "RegExp", "Reflect", "Set", "String", "Symbol", "SyntaxError", "TypeError",
  "URIError", "Uint8Array", "Uint8ClampedArray", "Uint16Array", "Uint32Array",
  "WeakMap", "WeakSet", "decodeURI", "decodeURIComponent", "encodeURI",
  "encodeURIComponent", "escape", "isFinite", "isNaN", "parseFloat",
  "parseInt", "unescape", "eval",
]);
// Window methods that exist as prototype members, not own props — the alias
// pass must include them so guest bare-name references resolve (moveBy,
// scrollTo, ... are referenced by the FeiLin fingerprint SDK).
const EXTRA_WINDOW_PROPS = [
  "moveBy", "moveTo", "resizeBy", "resizeTo", "scrollTo", "scrollBy", "scroll",
  "open", "close", "stop", "focus", "blur", "print", "alert", "confirm",
  "prompt", "getSelection", "find",
];

// Ref-count: the pool solves in parallel waves; each window must keep the
// aliases alive until the LAST concurrent window is destroyed, otherwise one
// destroyDom() pulls `window` out from under a sibling mid-solve.
let _aliasRefCount = 0;

function installGlobalWindowAlias(g, w) {
  _aliasRefCount += 1;
  const props = new Set(Object.getOwnPropertyNames(w));
  for (const name of EXTRA_WINDOW_PROPS) props.add(name);
  // also walk the prototype chain one level (BrowserWindow getters like
  // navigator/location live there in some versions)
  for (const proto = Object.getPrototypeOf(w); proto && proto !== Object.prototype;) {
    for (const name of Object.getOwnPropertyNames(proto)) props.add(name);
    break;
  }
  for (const prop of props) {
    if (HOST_CRITICAL_GLOBALS.has(prop)) continue;
    try {
      Object.defineProperty(g, prop, {
        get() {
          return w[prop];
        },
        set(v) {
          try { w[prop] = v; } catch (_) {}
        },
        configurable: true,
      });
    } catch (_) {}
  }
  // w.window/self may not exist as own props on this happy-dom build
  for (const prop of ["window", "self", "top", "parent"]) {
    try {
      Object.defineProperty(g, prop, { get() { return w; }, configurable: true });
    } catch (_) {}
  }
  // Guest timers must live on the window's timer registry (destroyed with
  // the window). The host's setTimeout would let pe-VM callbacks fire after
  // destroyDom, when the `window` alias is gone ("window is not defined").
  for (const prop of ["setTimeout", "setInterval", "clearTimeout", "clearInterval"]) {
    try {
      Object.defineProperty(g, prop, {
        get() { return w[prop]?.bind(w); },
        configurable: true,
      });
    } catch (_) {}
  }
  // Dynamic catch-all: guest code occasionally references window methods that
  // only exist on the prototype (moveBy, scrollTo, ...) or lands mid-solve on
  // new props. Proxy fallback for any still-missing global property.
  try {
    Object.defineProperty(g, "__capWindowFor", {
      get() { return w; },
      configurable: true,
    });
  } catch (_) {}
}
function removeGlobalWindowAlias(g, w) {
  _aliasRefCount -= 1;
  if (_aliasRefCount > 0) return;
  for (const name of Object.getOwnPropertyNames(w)) {
    try {
      const d = Object.getOwnPropertyDescriptor(g, name);
      if (d?.get) delete g[name];
    } catch (_) {}
  }
  for (const prop of ["window", "self", "top", "parent"]) {
    try { delete g[prop]; } catch (_) {}
  }
}

function destroyDom(win) {
  try {
    const cap = win.document.getElementById("cap");
    if (cap) cap.replaceChildren();
    win.happyDOM.close();
  } catch (_) {}
  try {
    global.__cookieContainer = null;
    global.__browserFrame = null;
  } catch (_) {}
  try {
    if (typeof Bun !== "undefined") removeGlobalWindowAlias(globalThis, win);
  } catch (_) {}
  try { shutdownSyncFetchWorker(); } catch (_) {}
}

function extractVerifyParam(param) {
  let verifyParam = param;
  if (param && typeof param === "object") {
    verifyParam = param.verifyParam || param.data || param.param;
  }
  if (!verifyParam || String(verifyParam).length < 20) {
    throw new Error("solver returned empty param: " + JSON.stringify(param));
  }
  const str = String(verifyParam);
  // Strict validation: a REAL Aliyun verify param is ~280 chars of base64
  // JSON containing certifyId + sceneId + isSign + a long securityToken.
  // Len-76 junk like {"certifyId":"70bdb",...,"isSign":true} (no securityToken)
  // comes from a degraded SDK result path and WILL 3007 upstream — never let
  // it out of the solver.
  if (str.length < 200) {
    throw new Error(
      "verify param too short (" + str.length + " chars) — degraded result, refusing: " + str.slice(0, 80),
    );
  }
  try {
    const decoded = JSON.parse(Buffer.from(str, "base64").toString("utf8"));
    const secTok = decoded && (decoded.securityToken || decoded.SecurityToken);
    if (!secTok || String(secTok).length < 50) {
      throw new Error(
        "verify param missing securityToken — refusing degraded result: " + str.slice(0, 80),
      );
    }
  } catch (err) {
    if (err instanceof SyntaxError || /securityToken/.test(String(err.message))) {
      throw err instanceof SyntaxError
        ? new Error("verify param not base64-JSON: " + str.slice(0, 80))
        : err;
    }
    throw err;
  }
  return str;
}

function handleCaptchaResult(result) {
  if (result && typeof result === "object" && result.verifyResult === false) {
    throw new Error(
      "verify rejected: " +
        JSON.stringify({ verifyCode: result.verifyCode, certifyId: result.certifyId }),
    );
  }
  return result;
}

// ── Window reuse pool ──────────────────────────────────────────────────────
// Reusing one happy-dom window across solves cuts CPU ~48% (measured: 426ms vs
// 815ms per solve) by amortizing the DOM boot + SDK script load. Enabled via
// CAPTCHA_WINDOW_REUSE=1 (or solveTraceless({reuseWindow:true})). The window
// is discarded after `maxSolves` (memory growth), after any stall/failure
// (fresh InitCaptchaV3 rolls a new pe version), or after `maxIdleMs` idle.
const _reusePool = { window: null, browserFrame: null, solves: 0, lastUsedAt: 0 };
const REUSE_MAX_SOLVES = Number(process.env.CAPTCHA_REUSE_MAX_SOLVES || 25);
const REUSE_MAX_IDLE_MS = Number(process.env.CAPTCHA_REUSE_MAX_IDLE_MS || 120_000);

function takeReusableWindow() {
  const p = _reusePool;
  if (!p.window) return null;
  if (p.solves >= REUSE_MAX_SOLVES) { discardReusableWindow(); return null; }
  if (Date.now() - p.lastUsedAt > REUSE_MAX_IDLE_MS) { discardReusableWindow(); return null; }
  return { window: p.window, browserFrame: p.browserFrame, reused: true };
}
function stageReusableWindow(window, browserFrame) {
  _reusePool.window = window;
  _reusePool.browserFrame = browserFrame;
  _reusePool.solves = 0;
  _reusePool.lastUsedAt = Date.now();
}
function discardReusableWindow() {
  const p = _reusePool;
  if (p.window) {
    try { destroyDom(p.window); } catch (_) {}
  }
  p.window = null;
  p.browserFrame = null;
  p.solves = 0;
}
function noteWindowSolved() {
  _reusePool.solves += 1;
  _reusePool.lastUsedAt = Date.now();
}

async function solveTraceless(opts) {
  const scene = opts.scene || "11xygtvd";
  const region = opts.region || "sgp";
  const prefix = opts.prefix || "no8xfe";
  const timeoutMs = opts.timeoutMs ?? 30_000;

  const wantReuse = opts.reuseWindow ?? process.env.CAPTCHA_WINDOW_REUSE === "1";
  let dom;
  let reused = false;
  if (wantReuse) {
    dom = takeReusableWindow();
    if (dom) reused = true;
  }
  if (!dom) {
    dom = await createDom(region, prefix);
  }
  const { window: w, browserFrame } = dom;
  const solveStart = Date.now();
  let solveSucceeded = false;
  let keepWindow = false;
  try {
    await waitFor(() => typeof w.initAliyunCaptcha === "function", timeoutMs, 50);

    simulateBehavior(w, 600);

    const param = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const peUrl = (() => { try { return w.__lastPeUrl || "?"; } catch (_) { return "?"; } })();
        const reqs = _requestLog
          .filter((r) => r.at >= solveStart)
          .map((r) => `${(r.at - solveStart)}ms ${r.method} ${String(r.url).replace(/^https?:\/\//, "").slice(0, 60)}`)
          .slice(-12);
        reject(new Error(`captcha solve timeout pe=${peUrl.split("/").pop() || peUrl} reqs=${JSON.stringify(reqs)}`));
      }, timeoutMs);      // Fail-fast stall detector: healthy solves keep firing XHRs until verify
      // (~3s). If no XHR for stallMs and none pending, this pe-VM variant
      // stalled (seen across rotated pe.0xx versions) — abort early so the
      // caller can retry with a fresh InitCaptchaV3 (new pe version).
      // Fail-fast stall detector: healthy solves keep firing XHRs until
      // verify (~3s, gaps <2s). If no XHR for 6s, this pe-VM variant stalled
      // (seen across rotated pe.0xx versions) — abort early so the caller
      // can retry with a fresh InitCaptchaV3 (new pe version).
      const stallMs = opts.stallMs ?? Number(process.env.CAPTCHA_STALL_MS || 6_000);
      const stallTimer = setInterval(() => {
        const last = _requestLog[_requestLog.length - 1];
        if (last && Date.now() - last.at > stallMs) {
          const peUrl = (() => { try { return w.__lastPeUrl || "?"; } catch (_) { return "?"; } })();
          noteStallAndMaybeEvict(peUrl);
          const reqs = _requestLog
            .filter((r) => r.at >= solveStart)
            .map((r) => `${(r.at - solveStart)}ms ${r.method} ${String(r.url).replace(/^https?:\/\//, "").slice(0, 60)}`)
            .slice(-12);
          clearTimeout(timer);
          clearInterval(stallTimer);
          reject(new Error(`captcha solve stall pe=${peUrl.split("/").pop() || peUrl} lastXhr=${(last.at - solveStart)}ms reqs=${JSON.stringify(reqs)}`));
        }
      }, 500);
      const finish = (fn) => (value) => {
        clearTimeout(timer);
        clearInterval(stallTimer);
        fn(value);
      };
      try {
        w.initAliyunCaptcha({
          SceneId: scene,
          mode: "popup",
          region,
          prefix,
          language: "en",
          element: "#cap",
          button: "#btn",
          captchaLogoImg: "",
          showErrorTip: false,
          getInstance: (inst) => {
            try {
              (inst.startTracelessVerification || inst.show).call(inst);
            } catch (e) {
              finish(reject)(new Error(`start: ${e.message}`));
            }
          },
          success: (result) => {
            try {
              finish(resolve)(handleCaptchaResult(result));
            } catch (err) {
              finish(reject)(err);
            }
          },
          fail: (err) => finish(reject)(new Error(`fail: ${JSON.stringify(err)}`)),
          onError: (err) => finish(reject)(new Error(`onError: ${JSON.stringify(err)}`)),
        });
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });

    // Success clears this pe's stall history so future isolated stalls can
    // still trigger eviction after two genuine consecutive failures.
    try {
      const okPe = w.__lastPeUrl;
      if (okPe) _stallCounts.delete(okPe);
    } catch (_) {}

    // Dump the pe-VM btoa tracer if requested (rotation forensics).
    if (process.env.CAPTCHA_DUMP_DBT === "1") {
      try {
        const dbt = w.__DBT || [];
        fs.writeFileSync(
          process.env.CAPTCHA_DBT_FILE || "/tmp/pe-dbt.json",
          JSON.stringify({ count: dbt.length, last: dbt.slice(-8), all: dbt }, null, 1),
        );
      } catch (_) {}
    }

    solveSucceeded = true;
    const out = extractVerifyParam(param);
    if (wantReuse) {
      if (reused) noteWindowSolved();
      else stageReusableWindow(w, browserFrame);
      keepWindow = true;
    }
    return out;
  } finally {
    // Reuse mode: on success the window stays pooled (keepWindow) for the next
    // solve — a ~48% CPU cut. On failure it is destroyed: a stalled window must
    // not poison later solves, and the retry rolls a fresh pe anyway.
    if (!keepWindow) {
      if (_reusePool.window === w) _reusePool.window = null;
      destroyDom(w);
    }
  }
}

export { solveTraceless, createDom, destroyDom };
