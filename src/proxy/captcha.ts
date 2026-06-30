/**
 * Aliyun Captcha V3 solver — in-process jsdom (single binary).
 *
 * The AliyunCaptcha.js SDK is bundled as a text import (no runtime dependency
 * on the alicdn CDN — the CDN is the #1 source of solve failures in restricted
 * networks, and a local file path would break under `bun build --compile`).
 * Solve attempts are retried, and errors from the SDK's `getInstance`
 * callback are propagated rather than silently swallowed (a swallowed error
 * there means `success`/`fail` never fires and we hang until the outer
 * timeout rejects).
 *
 * Static `import { JSDOM, VirtualConsole } from "jsdom"` (not dynamic) —
 * dynamic `await import("jsdom")` returns a namespace `{ default: {...} }`
 * for the CJS package under `bun build --compile`, leaving the named exports
 * undefined. Static import lets Bun's bundler fully inline jsdom (including
 * its internal `xhr-sync-worker.js` via `require.resolve`) into the binary,
 * so the compiled exe has zero runtime dependency on node_modules.
 *
 * FeiLin device-fingerprint blocking — the AliyunCaptcha SDK dynamically
 * injects a `<script src="...FeiLin...">` tag at runtime. Left to load (via
 * `resources: "usable"`), FeiLin runs inside jsdom, detects the headless
 * environment, and emits a fingerprint that fails upstream verification with
 * `verifyCode: F001`. A `FeiLinBlockingLoader` (ResourceLoader subclass)
 * intercepts FeiLin URLs and returns a no-op stub, so the fingerprint SDK
 * never runs. Polyfill values stay STABLE (not randomized) — Aliyun's risk
 * engine correlates fingerprint stability across requests; randomizing
 * per-auth is counterproductive.
 */
import { JSDOM, ResourceLoader, VirtualConsole } from "jsdom";
import type { FetchOptions } from "jsdom";
import ALIYUN_SDK_LOCAL from "./AliyunCaptcha.js.txt" with { type: "text" };

const CAPTCHA_HEADER = "x-aliyun-captcha-verify-param";
const REGION_HEADER = "x-aliyun-captcha-verify-region";
const CONFIGS_API = "https://zcode.z.ai/api/v1/client/configs";
const TOKEN_TTL_MS = 45_000;
const FAKE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** How many times to retry a single captcha solve. Overridable via env. */
const SOLVE_RETRIES = Number(process.env.ZCODE_CAPTCHA_RETRIES || 3);
/** Per-attempt solve timeout (ms). Overridable via env. */
const SOLVE_TIMEOUT_MS = Number(process.env.ZCODE_CAPTCHA_TIMEOUT_MS || 40_000);
/** Timeout (ms) waiting for the SDK to expose `initAliyunCaptcha`. */
const SDK_LOAD_TIMEOUT_MS = Number(process.env.ZCODE_CAPTCHA_SDK_LOAD_MS || 20_000);

interface FetchedCaptchaConfig { enabled: boolean; prefix: string; sceneId: string; region: string; }
let cachedConfig: { value: FetchedCaptchaConfig | null; expiresAt: number } = { value: null, expiresAt: 0 };
let cachedToken: { verifyParam: string; region: string; expiresAt: number } | null = null;

export function detectCaptchaChallenge(resp: Response): string | null {
  const v = resp.headers.get(CAPTCHA_HEADER);
  return v && v.trim().length > 0 ? v.trim() : null;
}

export function invalidateCaptchaToken(): void { cachedToken = null; }

async function fetchCaptchaConfig(appVersion: string): Promise<FetchedCaptchaConfig | null> {
  if (cachedConfig.value && cachedConfig.expiresAt > Date.now()) return cachedConfig.value;
  try {
    const resp = await fetch(`${CONFIGS_API}?app_version=${encodeURIComponent(appVersion)}&platform=win32-x64`);
    const json = (await resp.json()) as { data?: { configs?: { captcha?: FetchedCaptchaConfig } } };
    const cfg = json?.data?.configs?.captcha ?? null;
    cachedConfig = { value: cfg, expiresAt: Date.now() + 60000 };
    return cfg;
  } catch { return null; }
}

export async function getCaptchaToken(appVersion: string): Promise<{ verifyParam: string; region: string }> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return { verifyParam: cachedToken.verifyParam, region: cachedToken.region };
  const cfg = await fetchCaptchaConfig(appVersion);
  if (!cfg || !cfg.enabled || !cfg.prefix || !cfg.sceneId) throw new Error("Captcha config unavailable");
  const verifyParam = await solveInJsdomWithRetry(cfg);
  cachedToken = { verifyParam, region: cfg.region, expiresAt: Date.now() + TOKEN_TTL_MS };
  return { verifyParam, region: cfg.region };
}

async function solveInJsdomWithRetry(cfg: FetchedCaptchaConfig): Promise<string> {
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= SOLVE_RETRIES; attempt++) {
    try {
      return await solveInJsdom(cfg);
    } catch (err) {
      lastErr = err as Error;
      console.error(`[captcha] solve attempt ${attempt}/${SOLVE_RETRIES} failed: ${lastErr.message}`);
    }
  }
  throw new Error(`captcha solve failed after ${SOLVE_RETRIES} attempts: ${lastErr?.message ?? "unknown"}`);
}

async function solveInJsdom(cfg: FetchedCaptchaConfig): Promise<string> {
  const vc = new VirtualConsole();
  const sdkSafe = ALIYUN_SDK_LOCAL.replace(/<\/script>/gi, "<\\/script>");
  const html = `<!DOCTYPE html><html><head></head><body><div id="captcha-element"></div><button id="captcha-button"></button><script>${sdkSafe}</script></body></html>`;
  const dom = new JSDOM(html, {
    url: "https://zcode.z.ai/", runScripts: "dangerously", resources: new FeiLinBlockingLoader(),
    pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window: any) { applyPolyfills(window); window.AliyunCaptchaConfig = { region: cfg.region, prefix: cfg.prefix }; },
  });
  const w = dom.window as any;
  try {
    await waitFor(() => typeof w.initAliyunCaptcha === "function", SDK_LOAD_TIMEOUT_MS);
    return await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`captcha solve timeout after ${SOLVE_TIMEOUT_MS}ms`)),
        SOLVE_TIMEOUT_MS,
      );
      w.initAliyunCaptcha({
        SceneId: cfg.sceneId, mode: "popup", region: cfg.region, prefix: cfg.prefix, language: "en",
        element: "#captcha-element", button: "#captcha-button", captchaLogoImg: "", showErrorTip: false,
        getInstance: (inst: any) => {
          const fn = inst.startTracelessVerification || inst.show;
          if (typeof fn !== "function") {
            clearTimeout(timeout);
            reject(new Error("Aliyun SDK instance has no startTracelessVerification or show method"));
            return;
          }
          try {
            fn.call(inst);
          } catch (err) {
            clearTimeout(timeout);
            reject(new Error(`Aliyun SDK startTracelessVerification threw: ${(err as Error).message}`));
          }
        },
        success: (param: string) => { clearTimeout(timeout); resolve(param); },
        fail: (err: unknown) => { clearTimeout(timeout); reject(new Error(`SDK fail: ${JSON.stringify(err)}`)); },
        onError: (err: unknown) => { clearTimeout(timeout); reject(new Error(`SDK error: ${JSON.stringify(err)}`)); },
      });
    });
  } finally {
    try { w.close(); } catch {}
  }
}

function waitFor(cond: () => boolean, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = Date.now();
    const id = setInterval(() => { let ok = false; try { ok = cond(); } catch {} if (ok) { clearInterval(id); resolve(); } else if (Date.now() - s > ms) { clearInterval(id); reject(new Error("SDK load timeout")); } }, 80);
  });
}

/**
 * Resource loader that blocks the FeiLin device-fingerprint SDK.
 *
 * The AliyunCaptcha SDK injects a `<script>` for FeiLin at runtime. In jsdom
 * that SDK executes, detects the non-browser environment, and produces a
 * fingerprint rejected upstream as `verifyCode: F001`. Intercepting the URL
 * and returning a no-op stub prevents FeiLin from running at all, so the
 * captcha solve relies on the stable polyfill values instead.
 */
class FeiLinBlockingLoader extends ResourceLoader {
  fetch(url: string, options: FetchOptions) {
    if (/FeiLin/i.test(url)) {
      return Object.assign(
        Promise.resolve(Buffer.from("window.__feilin_blocked=true;")),
        { abort() {} },
      );
    }
    return super.fetch(url, options);
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function applyPolyfills(window: any): void {
  window.matchMedia = () => ({ matches: false, media: "", onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } });
  let rafCount = 0;
  window.requestAnimationFrame = (cb: (t: number) => void) => { const id = ++rafCount; setTimeout(() => cb(Date.now()), 16); return id; };
  window.cancelAnimationFrame = (id: number) => clearTimeout(id);
  const proto = window.HTMLCanvasElement.prototype;
  proto.getContext = function (type: string) {
    if (/webgl/i.test(type)) return { canvas: this, getParameter: (p: number) => { if (p === 37445) return "Intel Inc."; if (p === 37446) return "Intel Iris OpenGL Engine"; return "Intel"; }, getExtension: () => null, getSupportedExtensions: () => ["WEBGL_debug_renderer_info"], getContextAttributes: () => ({}), getShaderPrecisionFormat: () => ({ precision: 23, rangeMin: 127, rangeMax: 127 }) };
    return { canvas: this, fillRect() {}, clearRect() {}, getImageData: (x: number, y: number, w = 1, h = 1) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {}, createImageData: (w = 1, h = 1) => ({ data: new Uint8ClampedArray(w * h * 4) }), setTransform() {}, transform() {}, drawImage() {}, save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, bezierCurveTo() {}, quadraticCurveTo() {}, closePath() {}, clip() {}, stroke() {}, fill() {}, arc() {}, rect() {}, ellipse() {}, translate() {}, scale() {}, rotate() {}, fillText() {}, strokeText() {}, measureText: (t: string) => ({ width: ("" + t).length * 8 }), createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }), createPattern: () => ({}), isPointInPath: () => false, font: "10px sans-serif", textBaseline: "alphabetic", textAlign: "start", fillStyle: "#000", strokeStyle: "#000", globalAlpha: 1, lineWidth: 1, shadowBlur: 0, shadowColor: "" };
  };
  proto.toDataURL = () => "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  proto.toBlob = (cb: any) => cb && cb(null);
  window.Worker = class { postMessage() {} terminate() {} addEventListener() {} removeEventListener() {} onmessage = null; onerror = null; };
  window.OffscreenCanvas = class { width = 0; height = 0; constructor(w: number, h: number) { this.width = w; this.height = h; } getContext() { return proto.getContext.call(this); } };
  try { Object.defineProperty(window.document, "hidden", { value: false, configurable: true }); Object.defineProperty(window.document, "visibilityState", { value: "visible", configurable: true }); } catch {}
  const nav = window.navigator;
  for (const [k, v] of Object.entries({ userAgent: FAKE_UA, platform: "Win32", language: "en-US", languages: ["en-US", "en"], vendor: "Google Inc.", webdriver: false, hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 0, cookieEnabled: true, plugins: { length: 3, item: (): null => null, namedItem: (): null => null, refresh() {} }, mimeTypes: { length: 0, item: (): null => null, namedItem: (): null => null } })) { try { Object.defineProperty(nav, k, { value: v, configurable: true }); } catch {} }
  window.screen = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelDepth: 24 };
  window.chrome = { runtime: {} }; window.outerWidth = 1920; window.outerHeight = 1080; window.innerWidth = 1280; window.innerHeight = 720; window.devicePixelRatio = 1;
  try { window.localStorage = window.localStorage || { _data: {} as Record<string, string>, getItem(k: string) { return this._data[k] || null; }, setItem(k: string, v: string) { this._data[k] = String(v); }, removeItem(k: string) { delete this._data[k]; }, clear() { this._data = {}; }, key(i: number) { return Object.keys(this._data)[i] || null; }, get length() { return Object.keys(this._data).length; } }; } catch {}
}

export const RETRY_HEADERS = { PARAM: CAPTCHA_HEADER, REGION: REGION_HEADER };
