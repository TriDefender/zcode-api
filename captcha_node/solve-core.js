process.env.FONTCONFIG_PATH = "/dev/null";
const { ProxyAgent, setGlobalDispatcher } = require("undici");
const proxyUrl = process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
if (proxyUrl) {
	try {
		setGlobalDispatcher(new ProxyAgent(proxyUrl));
	} catch (_) {}
}
const { JSDOM, VirtualConsole, requestInterceptor } = require("jsdom");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const util = require("node:util");

const CDN_CACHE_DIR = path.join(os.homedir(), ".zcode-captcha-cdn-cache");

// ── Optimization: In-memory CDN cache ──────────────────────────────────────
// Avoids fs.readFileSync on every solve for the same SDK scripts (~1.2MB total).
const _memCdnCache = new Map();

// ── Optimization: Cookie cache ─────────────────────────────────────────────
// Session cookies (acw_tc, cdn_sec_tc) are valid for ~30-60min; re-fetching
// them on every solve wastes ~300ms. Cache with a 5-minute TTL.
let _cookieCache = { cookies: [], ts: 0 };
const COOKIE_CACHE_TTL_MS = 5 * 60 * 1000;

// ── Optimization: DEBUG flag ───────────────────────────────────────────────
// Only emit [loader-*] stderr lines when CAPTCHA_DEBUG is set.
const _DEBUG = /^(1|true|yes)$/i.test(process.env.CAPTCHA_DEBUG || process.env.CAPTCHA_DEBUG_BODIES || "");

const originalPrepareStackTrace = Error.prepareStackTrace;
Error.prepareStackTrace = (err, callsites) => {
	if (!callsites || !Array.isArray(callsites)) {
		return originalPrepareStackTrace
			? originalPrepareStackTrace(err, callsites)
			: String(err);
	}
	const filtered = callsites.filter((callsite) => {
		try {
			const filename = callsite.getFileName();
			if (!filename) return true;
			const lower = filename.toLowerCase();
			return (
				!lower.includes("solve-core.js") &&
				!lower.includes("jsdom") &&
				!lower.includes("node_modules") &&
				!lower.includes("node:") &&
				!lower.includes("internal/")
			);
		} catch (_) {
			return true;
		}
	});

	return (
		err.toString() +
		"\n" +
		filtered
			.map((callsite) => {
				try {
					return "    at " + callsite.toString();
				} catch (_) {
					return "    at <anonymous>";
				}
			})
			.join("\n")
	);
};

function generateFingerprint() {
	// Fingerprint mirrors what a real headless Chromium actually reports on this
	// host (matched empirically against a passing Playwright solve). FeiLin's risk
	// model cross-checks these for internal consistency.
	const userAgent =
		"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";
	const uaMajor = "127";
	const uaFull = "127.0.0.0";
	const platform = "Linux x86_64";
	const screen = { w: 1280, h: 720, aw: 1280, ah: 720 };
	// SwiftShader is what headless Chromium actually exposes; claiming a real GPU
	// while being unable to render GL is a strong bot tell.
	const webglUnmaskedVendor = "Google Inc. (Google)";
	const webglUnmaskedRenderer =
		"ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)";
	const canvasImage =
		"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

	return {
		userAgent,
		uaMajor,
		uaFull,
		platform,
		screen,
		webglUnmaskedVendor,
		webglUnmaskedRenderer,
		canvasImage,
	};
}

const HTML = `<!DOCTYPE html><html><head></head><body>
<div id="cap"></div><button id="btn"></button>
<script src="https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js"></script>
</body></html>`;

function diskPathFor(url) {
	return path.join(
		CDN_CACHE_DIR,
		crypto.createHash("sha1").update(String(url)).digest("hex"),
	);
}

// jsdom 29 replaced ResourceLoader with requestInterceptor. The interceptor
// receives a WHATWG Request and may return a Response to short-circuit the
// fetch, or return undefined to let the request proceed via undici normally.
// We short-circuit cached bodies; for alicdn we fetch, persist, and respond.

// HARVEST-ONLY: patch the pe.* bytecode VM interpreter so its opcode-55 (call)
// handler dumps the bytecode program + stack + locals to window.__DBT when the
// callee is btoa/atob. Version-agnostic via regex (minifier may name the
// locals var s or u).
const peVmCallRegex =
	/55==A\?\(f=r\[n\+\+\],l=e\.pop\(\),h=e\.pop\(\),o=\[\],\w+\(f\)\.forEach\(function\(\)\{o\.unshift\(e\.pop\(\)\)\}\),p=null===h\?l\.apply\((\w+),o\):h\[l\]\.apply\(h,o\),r\[n\+\+\]&&e\.push\(p\)\):/;
function patchPeBundle(buf, url) {
	if (process.env.PE_PATCH === "off") return buf;
	if (!/dynamicJS\/[^/]*\/pe\.\d+\./.test(url)) return buf;
	let src = buf.toString("utf8");
	if (src.includes("__DBT")) return buf; // already patched
	const m = src.match(peVmCallRegex);
	if (!m) return buf;
	const locals = m[1];
	const hook = `55==A?(f=r[n++],l=e.pop(),h=e.pop(),o=[],v(f).forEach(function(){o.unshift(e.pop())}),p=null===h?l.apply(${locals},o):h[l].apply(h,o),r[n++]&&e.push(p),function(){try{if(l===window.btoa||l===window.atob){window.__DBT=window.__DBT||[];var __sav=[];for(var __i=0;__i<e.length;__i++){var __vv=e[__i];if(typeof __vv==="string"){__sav.push("s:"+__vv)}else if(typeof __vv==="number"){__sav.push("n:"+__vv)}else if(typeof __vv==="boolean"){__sav.push("b:"+__vv)}else if(__vv&&typeof __vv.length==="number"){__sav.push("a:"+__vv.length)}else{__sav.push("t:"+typeof __vv)}}var __ls={};for(var __k2 in ${locals}){if(__k2!=="_"&&__k2!=="*"&&__k2!=="arguments"){try{var __lv=${locals}[__k2];if(typeof __lv==="string"){__ls[__k2]="s:"+__lv}else if(typeof __lv==="number"){__ls[__k2]="n:"+__lv}else if(__lv&&typeof __lv.length==="number"){__ls[__k2]="a:"+__lv.length}else{__ls[__k2]="t:"+typeof __lv}}catch(_e){}}}window.__DBT.push({call:"btoa",ip:n,args:o.map(function(__a){return typeof __a==="string"?"s:"+__a:typeof __a==="number"?"n:"+__a:typeof __a==="function"?"fn:"+(__a.name||"?"):typeof __a==="object"&&__a?"obj":typeof __a}),stack:__sav,locals:__ls,rlen:r.length,r:r})}}catch(_e){}}()):`;
	src = src.replace(m[0], hook);
	if (_DEBUG) process.stderr.write(`[loader-patch] ${url} (VM hook applied, locals=${locals})\n`);
	return Buffer.from(src, "utf8");
}

async function cachedCaptchaInterceptor(request) {
	const url = String(request.url);
	const diskPath = diskPathFor(url);

	// 1. In-memory cache (fastest path — no I/O at all)
	const memEntry = _memCdnCache.get(url);
	if (memEntry) {
		if (_DEBUG) process.stderr.write(`[loader-mem] ${url} (${memEntry.length} bytes)\n`);
		return new Response(patchPeBundle(memEntry, url), {
			headers: { "content-type": sniffMime(url) },
		});
	}

	// 2. Disk cache (warm after first run)
	try {
		if (fs.existsSync(diskPath)) {
			const body = fs.readFileSync(diskPath);
			_memCdnCache.set(url, body); // promote to memory
			if (_DEBUG) process.stderr.write(`[loader-cache] ${url} (${body.length} bytes)\n`);
			return new Response(patchPeBundle(body, url), {
				headers: { "content-type": sniffMime(url) },
			});
		}
	} catch (_) {}

	// Only alicdn CDN resources are cached and short-circuited here. Everything
	// else (Aliyun API calls, puzzle images, telemetry) must reach the network
	// via our global fetch (which honors HTTP_PROXY) to bypass datacenter IP blocks.
	const isCdn = /alicdn\.com/i.test(url);
	if (!isCdn) {
		if (_DEBUG) process.stderr.write(`[loader-passthrough] ${request.method} ${url}\n`);
		try {
			const upstream = await fetch(request);
			const buf = Buffer.from(await upstream.arrayBuffer());
			return new Response(buf, {
				status: upstream.status,
				headers: {
					"content-type": upstream.headers.get("content-type") || sniffMime(url),
				},
			});
		} catch (err) {
			if (_DEBUG) process.stderr.write(`[loader-passthrough-err] ${url}: ${err.message}\n`);
			return undefined;
		}
	}

	if (_DEBUG) process.stderr.write(`[loader-network] ${url} ...\n`);
	try {
		const upstream = await fetch(request);
		const buf = Buffer.from(await upstream.arrayBuffer());
		if (_DEBUG) process.stderr.write(`[loader-network-ok] ${url} (${buf.length} bytes)\n`);
		if (buf.length > 0) {
			_memCdnCache.set(url, buf); // store in memory
			try {
				fs.mkdirSync(CDN_CACHE_DIR, { recursive: true });
				fs.writeFileSync(diskPath, buf);
			} catch (_) {}
		}
		return new Response(patchPeBundle(buf, url), {
			status: upstream.status,
			headers: {
				"content-type": upstream.headers.get("content-type") || sniffMime(url),
			},
		});
	} catch (err) {
		if (_DEBUG) process.stderr.write(`[loader-network-err] ${url}: ${err.message}\n`);
		return undefined;
	}
}

function sniffMime(url) {
	if (/\.js(\?|$)/i.test(url)) return "application/javascript";
	if (/\.css(\?|$)/i.test(url)) return "text/css";
	if (/\.png(\?|$)/i.test(url)) return "image/png";
	if (/\.(jpg|jpeg)(\?|$)/i.test(url)) return "image/jpeg";
	if (/\.json(\?|$)/i.test(url)) return "application/json";
	return "application/octet-stream";
}

// Wrap with a post-fetch cache: requestInterceptor only short-circuits on a
// returned Response, so to *populate* the cache we layer a fetch that writes
// the body to disk for alicdn resources, then returns the original response.
const resourceLoader = {
	interceptors: [requestInterceptor(cachedCaptchaInterceptor)],
};
const virtualConsole = new VirtualConsole();
const formatConsoleArg = (arg) => {
	if (arg && typeof arg === "object") {
		const props = {};
		for (const name of Object.getOwnPropertyNames(arg)) {
			props[name] = arg[name];
		}
		try {
			let proto = Object.getPrototypeOf(arg);
			while (proto && proto !== Object.prototype) {
				for (const name of Object.getOwnPropertyNames(proto)) {
					if (!(name in props)) {
						try {
							props[name] = arg[name];
						} catch {}
					}
				}
				proto = Object.getPrototypeOf(proto);
			}
		} catch (_) {}
		return `[Object ${arg.constructor?.name || "Object"}]: ${util.inspect(props, { depth: 5 })}`;
	}
	return String(arg);
};

virtualConsole.on("error", (...args) => {
	if (_DEBUG) {
		const formatted = args.map(formatConsoleArg).join(" ");
		process.stderr.write(`[jsdom-err] ${formatted}\n`);
	}
});
virtualConsole.on("warn", (...args) => {
	if (_DEBUG) {
		const formatted = args.map(formatConsoleArg).join(" ");
		process.stderr.write(`[jsdom-warn] ${formatted}\n`);
	}
});
virtualConsole.on("log", (...args) => {
	if (_DEBUG) {
		const formatted = args.map(formatConsoleArg).join(" ");
		process.stderr.write(`[jsdom-log] ${formatted}\n`);
	}
});
virtualConsole.on("jsdomError", (err) => {
	if (_DEBUG) {
		process.stderr.write(
			`[jsdom-jsdomError] ${err.stack || err.message || String(err)}\n`,
		);
	}
});

/**
 * Make a polyfilled function masquerade as a native browser API: its toString()
 * returns `function name() { [native code] }`. FeiLin (and most bot detectors)
 * string-check methods for `[native code]`; polyfills that leak JS source are
 * an instant tell.
 */
function nativeize(fn, name = "") {
	if (typeof fn !== "function") return fn;
	try {
		const nativeRe = /\[native code\]/;
		if (nativeRe.test(Function.prototype.toString.call(fn))) return fn;
		const display = name || fn.name || "";
		const spoofed = function (...args) {
			return fn.apply(this, args);
		};
		const nativeStr = `function ${display}() { [native code] }`;
		Object.defineProperty(spoofed, "toString", {
			value: () => nativeStr,
			configurable: true,
			writable: true,
		});
		Object.defineProperty(spoofed, "name", {
			value: display || fn.name || "",
			configurable: true,
		});
		return spoofed;
	} catch (_) {
		return fn;
	}
}

/**
 * Globally mask Function#toString so jsdom's JS-implemented platform APIs read
 * as native. jsdom re-implements setTimeout, createElement, addEventListener,
 * performance.now, etc. in JavaScript; their toString() leaks source, which
 * fingerprinting SDKs (FeiLin) detect. We decide per-function whether to spoof:
 * real native code and tiny page helpers are left honest; anything multi-line
 * or carrying jsdom-internal markers is reported as `function name() { [native code] }`.
 */
function installNativeToString(window) {
  // jsdom implements the platform in JavaScript. Node's vm/contextify bypasses
  // a plain Function.prototype.toString override for host-bound functions, but
  // it DOES honor an own `toString` property on each function. So we walk the
  // prototype chains of window, navigator, document, and common platform
  // objects, and attach a native-looking own toString to every method we find.
  const realToString = Function.prototype.toString;
  const nativeRe = /\[native code\]/;

  const mask = (fn) => {
    if (typeof fn !== 'function') return;
    try {
      const real = realToString.call(fn);
      if (nativeRe.test(real)) return;
      const name = fn.name || '';
      // Only mask jsdom platform code (multi-line or internal vars); keep
      // page-authored single-liners honest so we don't break the page's own code.
      if (!real.includes('\n') && !/\besValue\b/.test(real) && !/\blocalName\b/.test(real)) return;
      const nativeStr = `function ${name}() { [native code] }`;
      Object.defineProperty(fn, 'toString', {
        value: () => nativeStr,
        configurable: true,
        writable: true,
      });
    } catch (_) {}
  };

  const seen = new window.Set();
  const maskObj = (obj, depth) => {
    if (!obj || (typeof obj !== 'object' && typeof obj !== 'function') || depth > 4) return;
    if (seen.has(obj)) return;
    try { seen.add(obj); } catch (_) { return; }
    let names = [];
    try { names = Object.getOwnPropertyNames(obj); } catch (_) { return; }
    for (const name of names) {
      if (name === 'toString' || name === 'constructor') continue;
      let desc;
      try { desc = Object.getOwnPropertyDescriptor(obj, name); } catch (_) { continue; }
      if (!desc) continue;
      if (typeof desc.value === 'function') {
        mask(desc.value);
      } else if (typeof desc.get === 'function') {
        mask(desc.get);
        try { const v = desc.get.call(obj); if (typeof v === 'function') mask(v); } catch (_) {}
      }
      // Recurse into prototype-ish members (constructors) at shallow depth.
      if (depth < 2) {
        try {
          const v = desc.value;
          if (v && (typeof v === 'function' || typeof v === 'object')) maskObj(v, depth + 1);
        } catch (_) {}
      }
    }
  };

  const targets = [window, window.navigator, window.document, window.Document.prototype, window.Element.prototype, window.HTMLElement.prototype, window.Node.prototype, window.EventTarget.prototype, window.HTMLCanvasElement.prototype, window.XMLHttpRequest.prototype];
  for (const t of targets) {
    try { maskObj(t, 0); } catch (_) {}
  }
}

function rawTransportSend(xhr, url, body, fallback) {
	// Isolation experiment: send the POST via raw https.request (the native's
	// transport: distinct header spelling, no cookie, no undici) while keeping
	// the page/GET/SDK-execution context intact. Feeds the response back into
	// the XHR so the SDK flow continues normally.
	const https = require("https");
	const zlib = require("zlib");
	process.stderr.write(`[rawtransport] ${Date.now()} POST ${url} $(body.length) chars\n`);
	let u;
	try { u = new URL(url); } catch (e) { return fallback.call(xhr, body); }
	const headerSet = {
		"Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
		"Content-Length": Buffer.byteLength(body),
		Accept: "*/*",
		"Accept-Encoding": "gzip, deflate",
		Origin: "https://zcode.z.ai",
		Referer: "https://zcode.z.ai/",
		"User-Agent":
			"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
		"sec-ch-ua": '"Chromium";v="127", "Not)A;Brand";v="24"',
		"sec-ch-ua-mobile": "?0",
		"sec-ch-ua-platform": '"Linux"',
		"Accept-Language": "en-US,en;q=0.9",
	};
	const proxyUrl = process.env.NATIVE_XHR_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
	let req;
	if (proxyUrl) {
		let pu;
		try {
			pu = new URL(proxyUrl.startsWith("http") ? proxyUrl : "http://" + proxyUrl);
		} catch (e) { return fallback.call(xhr, body); }
		req = https.request({
			hostname: pu.hostname,
			port: pu.port || 443,
			method: "CONNECT",
			path: `${u.hostname}:443`,
			headers: { Host: `${u.hostname}:443` },
		});
		req.on("connect", (res, socket) => {
			if (res.statusCode !== 200) { socket.destroy(); return fallback.call(xhr, body); }
			req = https.request({ socket, hostname: u.hostname, path: u.path, method: "POST", headers: headerSet, servername: u.hostname });
			req.on("response", (r) => finish(r));
			req.on("error", () => { try { fallback.call(xhr, body); } catch (_) {} });
			req.end(body);
		});
		req.on("error", () => { try { fallback.call(xhr, body); } catch (_) {} });
		req.end();
	} else {
		req = https.request({ hostname: u.hostname, path: u.path, method: "POST", headers: headerSet, servername: u.hostname });
		req.on("response", (r) => finish(r));
		req.on("error", () => { try { fallback.call(xhr, body); } catch (_) {} });
		req.end(body);
	}
	function finish(r) {
		const chunks = [];
		r.on("data", (c) => chunks.push(c));
		r.on("end", () => {
			let raw = Buffer.concat(chunks);
			const ce = String(r.headers["content-encoding"] || "").toLowerCase();
			try {
				if (ce === "gzip") raw = zlib.gunzipSync(raw);
				else if (ce === "deflate") raw = zlib.inflateSync(raw);
			} catch (_) {}
			const text = raw.toString("utf8");
			try {
				Object.defineProperty(xhr, "status", { configurable: true, enumerable: true, writable: true, value: r.statusCode || 200 });
				Object.defineProperty(xhr, "readyState", { configurable: true, enumerable: true, writable: true, value: 4 });
				Object.defineProperty(xhr, "statusText", { configurable: true, enumerable: true, writable: true, value: "OK" });
				Object.defineProperty(xhr, "responseText", { configurable: true, enumerable: true, writable: true, value: text });
				Object.defineProperty(xhr, "response", { configurable: true, enumerable: true, writable: true, value: text });
			} catch (_) {}
			try { xhr.dispatchEvent(new window.Event("load")); } catch (_) {}
			try { xhr.dispatchEvent(new window.Event("readystatechange")); } catch (_) {}
			process.stderr.write(`\n===== XHR ${Date.now()} POST ${url} [rawtransport ${r.statusCode}]\n--- RESP (${text.length}b) ---\n${text.slice(0, 40000)}\n=====\n`);
		});
		r.on("error", () => { try { fallback.call(xhr, body); } catch (_) {} });
	}
}

function installTrafficLogger(window) {
	const DEBUG_HOSTS = /(cloudauth-device|captcha-open|verify|upload)/i;
	const origXHROpen = window.XMLHttpRequest.prototype.open;
	const origXHRSend = window.XMLHttpRequest.prototype.send;
	const origSetHdr = window.XMLHttpRequest.prototype.setRequestHeader;
	window.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
		this.__capMethod = method;
		this.__capUrl = url;
		return origXHROpen.call(this, method, url, ...rest);
	};
	window.XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
		const h = this.__capHdrs || (this.__capHdrs = {});
		h[String(name)] = String(value);
		return origSetHdr && origSetHdr.call(this, name, value);
	};
	window.XMLHttpRequest.prototype.send = function (body) {
		const url = String(this.__capUrl || "");
		if (/no8xfe-verify/i.test(url)) {
			try {
				const st = new Error("verify-trace").stack || "";
				process.stderr.write(`\n===== VERIFY TRACE =====\n${st}\n=====\n`);
			} catch (_) {}
		}
		if (DEBUG_HOSTS.test(url)) {
			const reqPreview =
				typeof body === "string" ? body.slice(0, 40000) : "<non-string body>";
			this.addEventListener("load", () => {
				let respPreview = "";
				try {
					respPreview = String(this.responseText || "").slice(0, 40000);
				} catch (_) {}
				process.stderr.write(
					`\n===== XHR ${Date.now()} ${String(this.__capMethod || "?")} ${url}\n--- REQ (${typeof body === "string" ? body.length : "?"} chars) ---\n${reqPreview}\n--- RESP (${respPreview.length}b) ---\n${respPreview}\n=====\n`,
				);
			});
		}
		if (global.__captchaMutator) {
			try {
				const mutated = global.__captchaMutator(String(this.__capUrl || ""), body);
				if (typeof mutated === "string" && mutated !== body) body = mutated;
			} catch (_) {}
		}
		if (process.env.NATIVE_XHR_TRANSPORT === "1" && DEBUG_HOSTS.test(url) && !/^(GET|HEAD)$/i.test(String(this.__capMethod || "POST")) && typeof body === "string" && body.length > 0) {
			rawTransportSend(this, url, body, origXHRSend);
			return;
		}
		return origXHRSend.call(this, body);
	};
	if (typeof window.fetch === "function") {
		const origFetch = window.fetch;
		window.fetch = function (input, init) {
			const url = String(typeof input === "string" ? input : input?.url || "");
			const p = origFetch.call(this, input, init);
			if (DEBUG_HOSTS.test(url)) {
				const reqBody =
					init && init.body && typeof init.body === "string"
						? init.body.slice(0, 40000)
						: "<non-string>";
				p.then((resp) => {
					resp
						.clone()
						.text()
						.then((t) => {
							process.stderr.write(
								`\n===== FETCH ${(init && init.method) || "GET"} ${url}\n--- REQ (${typeof reqBody === "string" ? reqBody.length : "?"} chars) ---\n${reqBody}\n--- RESP (${t.length}b) ---\n${t.slice(0, 40000)}\n=====\n`,
							);
						})
						.catch(() => {});
				}).catch(() => {});
			}
			return p;
		};
	}
}

function applyPolyfills(window, fp) {
	if (process.env.CAPTCHA_DEBUG_BODIES === "1") {
		installTrafficLogger(window);
	}

	// jsdom implements browser APIs in JavaScript, so every method (even
	// genuinely-native ones like setTimeout / createElement / addEventListener)
	// leaks its JS source via Function#toString. A real browser returns
	// `function name() { [native code] }`. Fingerprinting SDKs like FeiLin sweep
	// toString across the platform, so we override it globally: any function not
	// authored by the page itself is reported as native.
	installNativeToString(window);

	// Global Observers and events stubs
	window.IntersectionObserver =
		window.IntersectionObserver ||
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

	window.ResizeObserver =
		window.ResizeObserver ||
		class {
			constructor(cb) {
				this.cb = cb;
			}
			observe() {}
			unobserve() {}
			disconnect() {}
		};

	window.DeviceOrientationEvent =
		window.DeviceOrientationEvent ||
		class extends window.Event {
			constructor(type, opts) {
				super(type, opts);
			}
			alpha = null;
			beta = null;
			gamma = null;
			absolute = false;
		};

	window.DeviceMotionEvent =
		window.DeviceMotionEvent ||
		class extends window.Event {
			constructor(type, opts) {
				super(type, opts);
			}
			acceleration = null;
			accelerationIncludingGravity = null;
			rotationRate = null;
			interval = 16;
		};

	window.requestIdleCallback =
		window.requestIdleCallback ||
		((cb) =>
			setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 10 }), 1));
	window.cancelIdleCallback =
		window.cancelIdleCallback || ((id) => clearTimeout(id));

	window.matchMedia = () => ({
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
	});

	// HTML5 Viewport and storage stubs
	if (!window.visualViewport) {
		const VisualViewport = () => {};
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
		window.VisualViewport = VisualViewport;
		window.visualViewport = Object.create(window.VisualViewport.prototype);
	}

	if (!window.indexedDB) {
		const IDBFactory = () => {};
		IDBFactory.prototype = {
			open: () => ({ onupgradeneeded: null, onsuccess: null, onerror: null }),
			deleteDatabase: () => ({}),
			databases: () => Promise.resolve([]),
		};
		window.IDBFactory = IDBFactory;
		window.indexedDB = Object.create(window.IDBFactory.prototype);
	}

	if (!window.speechSynthesis) {
		const SpeechSynthesis = () => {};
		SpeechSynthesis.prototype = {
			speak() {},
			cancel() {},
			pause() {},
			resume() {},
			getVoices: () => [],
		};
		window.SpeechSynthesis = SpeechSynthesis;
		window.speechSynthesis = Object.create(window.SpeechSynthesis.prototype);
		window.SpeechSynthesisUtterance = () => {};
	}

	// WebGL and Canvas stubs
	const proto = window.HTMLCanvasElement.prototype;
	// Preserve the native 2D context (provided by the optional `canvas` npm package)
	// so FeiLin's canvas fingerprint is real, not a constant. We only mock WebGL,
	// which the `canvas` package does not provide.
	const nativeGetContext = proto.getContext;
	proto.getContext = function (type, ...rest) {
		if (/webgl/i.test(type)) {
			return makeWebGLMock(this);
		}
		// 2D and other contexts: use the native implementation when available.
		if (typeof nativeGetContext === "function") {
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
				// WebGL constant parameters mock
				if (p === 7936) return "WebKit"; // VENDOR
				if (p === 7937) return "WebKit WebGL"; // RENDERER
				if (p === 7938) return "WebGL 1.0 (OpenGL ES 2.0 Chromium)"; // VERSION
				if (p === 35724)
					return "WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)"; // SHADING_LANGUAGE_VERSION
				if (p === 0x9245) return fp.webglUnmaskedVendor; // UNMASKED_VENDOR_WEBGL
				if (p === 0x9246) return fp.webglUnmaskedRenderer; // UNMASKED_RENDERER_WEBGL
				return "Intel Inc.";
			},
			getExtension(name) {
				if (name === "WEBGL_debug_renderer_info") {
					return {
						UNMASKED_VENDOR_WEBGL: 0x9245,
						UNMASKED_RENDERER_WEBGL: 0x9246,
					};
				}
				return null;
			},
			getSupportedExtensions() {
				return [
					"ANGLE_instanced_arrays",
					"EXT_blend_minmax",
					"EXT_color_buffer_half_float",
					"EXT_disjoint_timer_query",
					"EXT_float_blend",
					"EXT_frag_depth",
					"EXT_shader_texture_lod",
					"EXT_texture_compression_bptc",
					"EXT_texture_compression_rgtc",
					"EXT_texture_filter_anisotropic",
					"EXT_sRGB",
					"KHR_parallel_shader_compile",
					"OES_element_index_uint",
					"OES_fbo_render_mipmap",
					"OES_standard_derivatives",
					"OES_texture_float",
					"OES_texture_float_linear",
					"OES_texture_half_float",
					"OES_texture_half_float_linear",
					"OES_vertex_array_object",
					"WEBGL_color_buffer_float",
					"WEBGL_compressed_texture_astc",
					"WEBGL_compressed_texture_etc",
					"WEBGL_compressed_texture_etc1",
					"WEBGL_compressed_texture_s3tc",
					"WEBGL_compressed_texture_s3tc_srgb",
					"WEBGL_debug_renderer_info",
					"WEBGL_debug_shaders",
					"WEBGL_depth_texture",
					"WEBGL_draw_buffers",
					"WEBGL_lose_context",
					"WEBGL_multi_draw",
				];
			},
			getContextAttributes() {
				return {
					alpha: true,
					antialias: true,
					depth: true,
					failIfMajorPerformanceCaveat: false,
					powerPreference: "default",
					premultipliedAlpha: true,
					preserveDrawingBuffer: false,
					stencil: false,
					desynchronized: false,
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
			getImageData: (_x, _y, w = 1, h = 1) => new window.ImageData(w, h),
			putImageData() {},
			createImageData: (w = 1, h = 1) => new window.ImageData(w, h),
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

	// toDataURL/toBlob: prefer the native canvas implementation (real fingerprint)
	// and only fall back to a stub if the native impl is absent.
	if (typeof proto.toDataURL !== "function" || proto.toDataURL.length === 0) {
		const nativeToDataURL = proto.toDataURL;
		proto.toDataURL = function (...a) {
			try {
				if (typeof nativeToDataURL === "function")
					return nativeToDataURL.apply(this, a);
			} catch (_) {}
			return fp.canvasImage;
		};
	}
	const nativeToBlob = proto.toBlob;
	if (!nativeToBlob) {
		proto.toBlob = (cb) => cb && cb(new window.Blob());
	}

	window.Worker = class {
		postMessage() {}
		terminate() {}
		addEventListener() {}
		removeEventListener() {}
	};

	window.OffscreenCanvas =
		window.OffscreenCanvas ||
		class {
			constructor(w, h) {
				this.width = w;
				this.height = h;
			}
			getContext() {
				return proto.getContext.call(this);
			}
		};

	// Audio API Mocks
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
			return {
				gain: { value: 1 },
				connect() {},
			};
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
	window.AudioContext = window.AudioContext || audioMock;
	// Real Chrome 127+ does not expose webkitAudioContext
	window.OfflineAudioContext =
		window.OfflineAudioContext ||
		class extends audioMock {
			constructor(_channels, length, sampleRate) {
				super();
			this.length = length;
			this.sampleRate = sampleRate;
		}
			startRendering() {
				// Real Chromium renders a deterministic, non-zero waveform from the
			// oscillator+DynamicsCompressor chain. An all-zero buffer is a classic
			// bot tell, so synthesize a plausible decaying signal.
				const len = this.length || 44100;
				const sr = this.sampleRate || 44100;
				const buf = new Float32Array(len);
				for (let i = 0; i < len; i += 1) {
					const t = i / sr;
					// 1kHz tone + harmonics, exponentially decaying (compressor envelope)
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

	// Animation Mocks
	window.requestAnimationFrame =
		window.requestAnimationFrame ||
		((cb) => setTimeout(() => cb(Date.now()), 16));
	window.cancelAnimationFrame =
		window.cancelAnimationFrame || ((id) => clearTimeout(id));

	// Visibility stubs
	try {
		Object.defineProperty(window.document, "hidden", {
			value: false,
			configurable: true,
		});
		Object.defineProperty(window.document, "visibilityState", {
			value: "visible",
			configurable: true,
		});
	} catch (_) {}

	// Fonts and permissions
	if (!window.document.fonts) {
		window.document.fonts = {
			ready: Promise.resolve(),
			check: () => true,
			addEventListener() {},
			removeEventListener() {},
		};
	}

	// Emulate Chrome constructors and prototype chains to pass instanceof checks
	const NetworkInformation = () => {};
	NetworkInformation.prototype = {
		onchange: null,
		effectiveType: "4g",
		rtt: 50,
		downlink: 10,
		saveData: false,
	};
	window.NetworkInformation = NetworkInformation;
	Object.defineProperty(NetworkInformation.prototype, Symbol.toStringTag, {
		value: "NetworkInformation",
		configurable: true
	});

	const NavigatorUAData = () => {};
	NavigatorUAData.prototype = {
		brands: [
			{ brand: "Chromium", version: fp.uaMajor },
			{ brand: "Not)A;Brand", version: "24" },
		],
		mobile: false,
		platform: "Linux",
		getHighEntropyValues: (_hints) => {
			const res = {
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
			};
			return Promise.resolve(res);
		},
	};
	window.NavigatorUAData = NavigatorUAData;
	Object.defineProperty(NavigatorUAData.prototype, Symbol.toStringTag, {
		value: "NavigatorUAData",
		configurable: true
	});

	const Permissions = () => {};
	Permissions.prototype = {
		query: (param) => {
			return Promise.resolve({
				state: param.name === "notifications" ? "prompt" : "granted",
				onchange: null,
			});
		},
	};
	window.Permissions = Permissions;
	Object.defineProperty(Permissions.prototype, Symbol.toStringTag, {
		value: "Permissions",
		configurable: true
	});

	const Clipboard = () => {};
	Clipboard.prototype = {
		readText: () => Promise.resolve(""),
		writeText: () => Promise.resolve(),
	};
	window.Clipboard = Clipboard;
	Object.defineProperty(Clipboard.prototype, Symbol.toStringTag, {
		value: "Clipboard",
		configurable: true
	});

	const Geolocation = () => {};
	Geolocation.prototype = {
		getCurrentPosition: (success) =>
			success &&
			success({ coords: { latitude: 0, longitude: 0, accuracy: 1 } }),
		watchPosition: () => 1,
		clearWatch: () => {},
	};
	window.Geolocation = Geolocation;
	Object.defineProperty(Geolocation.prototype, Symbol.toStringTag, {
		value: "Geolocation",
		configurable: true
	});

	const CredentialsContainer = () => {};
	CredentialsContainer.prototype = {
		get: () => Promise.resolve(null),
		create: () => Promise.resolve(null),
		store: () => Promise.resolve(),
		preventSilentAccess: () => Promise.resolve(),
	};
	window.CredentialsContainer = CredentialsContainer;
	Object.defineProperty(CredentialsContainer.prototype, Symbol.toStringTag, {
		value: "CredentialsContainer",
		configurable: true
	});

	const StorageManager = () => {};
	StorageManager.prototype = {
		estimate: () => Promise.resolve({ quota: 100000000, usage: 0 }),
		persisted: () => Promise.resolve(false),
		persist: () => Promise.resolve(false),
	};
	window.StorageManager = StorageManager;
	Object.defineProperty(StorageManager.prototype, Symbol.toStringTag, {
		value: "StorageManager",
		configurable: true
	});

	const USB = () => {};
	USB.prototype = {
		getDevices: () => Promise.resolve([]),
		requestDevice: () => Promise.reject(new Error("no devices")),
	};
	window.USB = USB;
	Object.defineProperty(USB.prototype, Symbol.toStringTag, {
		value: "USB",
		configurable: true
	});

	const MediaDevices = () => {};
	MediaDevices.prototype = {
		enumerateDevices: () => Promise.resolve([]),
		getUserMedia: () => Promise.reject(new Error("NotAllowedError")),
	};
	window.MediaDevices = MediaDevices;
	Object.defineProperty(MediaDevices.prototype, Symbol.toStringTag, {
		value: "MediaDevices",
		configurable: true
	});

	const nav = window.navigator;
	const { plugins, mimeTypes } = createNavigatorPlugins(window);
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
		plugins,
		mimeTypes,
		connection: Object.create(window.NetworkInformation.prototype),
		userAgentData: Object.create(window.NavigatorUAData.prototype),
		permissions: Object.create(window.Permissions.prototype),
		clipboard: Object.create(window.Clipboard.prototype),
		geolocation: Object.create(window.Geolocation.prototype),
		credentials: Object.create(window.CredentialsContainer.prototype),
		storage: Object.create(window.StorageManager.prototype),
		usb: Object.create(window.USB.prototype),
		mediaDevices: Object.create(window.MediaDevices.prototype),
		sendBeacon: (url, data) => {
			try {
				const xhr = new window.XMLHttpRequest();
				xhr.open("POST", url, true);
				xhr.send(data);
				return true;
			} catch (_) {
				return false;
			}
		},
		appVersion: fp.userAgent.replace(/^Mozilla\//, ""),
		appName: "Netscape",
		appCodeName: "Mozilla",
		product: "Gecko",
		productSub: "20030107",
		vendorSub: "",
		oscpu: undefined,
	};
	for (const [k, v] of Object.entries(navPatch)) {
		try {
			Object.defineProperty(nav, k, { value: v, configurable: true });
		} catch (_) {}
	}

	// Chrome runtime stubs
	window.chrome = {
		app: {
			isInstalled: false,
			InstallState: { DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" },
			RunningState: { CANNOT_RUN: "cannot_run", CAN_RUN: "can_run", RUNNING: "running" },
			getDetails() { return null; },
			getIsInstalled() { return false; },
			installState(cb) { if (cb) cb("not_installed"); },
			runningState(cb) { if (cb) cb("cannot_run"); }
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
				connectionInfo: "h2"
			};
		}
	};

	const screenPatch = {
		width: fp.screen.w,
		height: fp.screen.h,
		availWidth: fp.screen.w,
		availHeight: fp.screen.ah,
		availLeft: 0,
		availTop: 0,
		colorDepth: 24,
		pixelDepth: 24,
		orientation: { angle: 0, type: "landscape-primary", onchange: null }
	};
	for (const [k, v] of Object.entries(screenPatch)) {
		try {
			Object.defineProperty(window.screen, k, { get() { return v; }, configurable: true });
		} catch (_) {}
	}

	window.outerWidth = fp.screen.w;
	window.outerHeight = fp.screen.h - 40;
	window.innerWidth = fp.screen.w - 16;
	window.innerHeight = fp.screen.h - 120;
	window.devicePixelRatio = 1;

	// Masquerade every polyfilled method as a native browser API so that
	// Function#toString checks (a staple of fingerprinting SDKs like FeiLin)
	// see `[native code]` instead of leaked JS source.
	nativeize(window.navigator.sendBeacon, "sendBeacon");
	if (window.navigator.permissions)
		nativeize(window.navigator.permissions.query, "query");
	if (window.navigator.clipboard) {
		nativeize(window.navigator.clipboard.readText, "readText");
		nativeize(window.navigator.clipboard.writeText, "writeText");
	}
	if (window.navigator.credentials) {
		nativeize(window.navigator.credentials.get, "get");
		nativeize(window.navigator.credentials.create, "create");
		nativeize(window.navigator.credentials.store, "store");
	}
	if (window.navigator.storage)
		nativeize(window.navigator.storage.estimate, "estimate");
	if (window.navigator.mediaDevices)
		nativeize(
			window.navigator.mediaDevices.enumerateDevices,
			"enumerateDevices",
		);
	nativeize(proto.toDataURL, "toDataURL");
	if (proto.toBlob) nativeize(proto.toBlob, "toBlob");
	nativeize(proto.getContext, "getContext");
}

function createNavigatorPlugins(window) {
	// FeiLin 1.4.2 reads navigator.plugins[0].__proto__ to fingerprint the
	// plugin prototype chain. A plain object with no indexed entries makes
	// plugins[0] undefined and crashes that probe (-> F001 risk rejection).
	// Build a real PluginArray on every platform, not just win32.
	const indexed = [
		{
			name: "PDF Viewer",
			filename: "internal-pdf-viewer",
			description: "Portable Document Format",
		},
		{
			name: "Chrome PDF Viewer",
			filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai",
			description: "",
		},
		{
			name: "Chromium PDF Viewer",
			filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai",
			description: "",
		},
	];
	const plugins = Object.create(window.PluginArray.prototype);
	const mockIndexed = [];
	for (let i = 0; i < indexed.length; i++) {
		const p = Object.create(window.Plugin.prototype);
		Object.defineProperty(p, "name", {
			value: indexed[i].name,
			configurable: true,
			enumerable: true,
		});
		Object.defineProperty(p, "filename", {
			value: indexed[i].filename,
			configurable: true,
			enumerable: true,
		});
		Object.defineProperty(p, "description", {
			value: indexed[i].description,
			configurable: true,
			enumerable: true,
		});
		Object.defineProperty(p, "length", {
			value: 1,
			configurable: true,
			enumerable: true,
		});
		Object.defineProperty(p, "0", {
			value: p,
			configurable: true,
			enumerable: true,
		});
		p.item = () => p;
		p.namedItem = () => p;
		plugins[i] = p;
		mockIndexed.push(p);
	}
	Object.defineProperty(plugins, "length", {
		value: indexed.length,
		configurable: true,
		enumerable: true,
	});
	plugins.item = (i) => plugins[i] ?? null;
	plugins.namedItem = (name) =>
		mockIndexed.find((p) => p.name === name) ?? null;
	plugins.refresh = () => {};
	const mimeTypes = Object.create(window.MimeTypeArray.prototype);
	Object.defineProperty(mimeTypes, "length", {
		value: 0,
		configurable: true,
		enumerable: true,
	});
	mimeTypes.item = () => null;
	mimeTypes.namedItem = () => null;
	return { plugins, mimeTypes };
}

function waitFor(cond, timeoutMs = 12_000, intervalMs = 50) {
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

function mapHostPrototypes(window) {
	const HostFunctionProto = Function.prototype;
	const GuestFunctionProto = window.Function.prototype;

	const seen = new Set();
	function walk(obj, depth = 0) {
		// Optimization: reduced max depth from 5 to 3 — FeiLin doesn't probe
		// deeper than 3 levels of nested constructors/prototypes.
		if (!obj || depth > 3 || (typeof obj !== "object" && typeof obj !== "function")) return;
		if (seen.has(obj)) return;
		seen.add(obj);

		let keys = [];
		try { keys = Object.getOwnPropertyNames(obj); } catch(_) { return; }

		for (const k of keys) {
			try {
				const desc = Object.getOwnPropertyDescriptor(obj, k);
				if (!desc) continue;

				if (typeof desc.value === "function") {
					if (Object.getPrototypeOf(desc.value) === HostFunctionProto) {
						Object.setPrototypeOf(desc.value, GuestFunctionProto);
					}
					walk(desc.value, depth + 1);
				}

				if (typeof desc.get === "function") {
					if (Object.getPrototypeOf(desc.get) === HostFunctionProto) {
						Object.setPrototypeOf(desc.get, GuestFunctionProto);
					}
				}
				if (typeof desc.set === "function") {
					if (Object.getPrototypeOf(desc.set) === HostFunctionProto) {
						Object.setPrototypeOf(desc.set, GuestFunctionProto);
					}
				}

				if (desc.value && (typeof desc.value === "object" || typeof desc.value === "function")) {
					walk(desc.value, depth + 1);
				}
			} catch (_) {}
		}

		try {
			const proto = Object.getPrototypeOf(obj);
			if (proto && proto !== Object.prototype) {
				walk(proto, depth + 1);
			}
		} catch (_) {}
	}

	walk(window);
}

// ── Optimization: Pre-compute guest-context eval string ────────────────────
// This is a constant; building it once avoids repeated string concatenation.
const GUEST_EVAL_PATCH = `
(function() {
	Object.defineProperty(Event.prototype, "isTrusted", {
		get() { return true; },
		configurable: true
	});
	const OrigDocument = window.Document;
	class HTMLDocument extends OrigDocument {}
	Object.defineProperty(HTMLDocument, "name", { value: "HTMLDocument", configurable: true });
	Object.setPrototypeOf(HTMLDocument.prototype, OrigDocument.prototype);
	Object.defineProperty(HTMLDocument.prototype, Symbol.toStringTag, {
		value: "HTMLDocument",
		configurable: true
	});
	Object.defineProperty(window, "HTMLDocument", {
		value: HTMLDocument,
		writable: true,
		configurable: true
	});
	Object.setPrototypeOf(window.document, HTMLDocument.prototype);
	const origGetOwnPropertyNames = Object.getOwnPropertyNames;
	const origOwnKeys = Reflect.ownKeys;
	const origGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
	const origGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
	const blacklist = new Set([
		"CSSStyleProperties", "XPathException", "SharedArrayBuffer"
	]);
	const filterKeys = (keys) => {
		return keys.filter(k => {
			if (typeof k === "string") {
				return !k.startsWith("_") && !blacklist.has(k);
			}
			return true;
		});
	};
	Object.getOwnPropertyNames = function getOwnPropertyNames(obj) {
		const keys = origGetOwnPropertyNames.call(this, obj);
		return obj === window ? filterKeys(keys) : keys;
	};
	Reflect.ownKeys = function ownKeys(target) {
		const keys = origOwnKeys.call(this, target);
		return target === window ? filterKeys(keys) : keys;
	};
	Object.getOwnPropertyDescriptors = function getOwnPropertyDescriptors(obj) {
		const descs = origGetOwnPropertyDescriptors.call(this, obj);
		if (obj === window) {
			for (const k of Object.keys(descs)) {
				if (k.startsWith("_") || blacklist.has(k)) {
					delete descs[k];
				}
			}
		}
		return descs;
	};
	Object.getOwnPropertyDescriptor = function getOwnPropertyDescriptor(obj, prop) {
		if (obj === window && (String(prop).startsWith("_") || blacklist.has(prop))) {
			return undefined;
		}
		return origGetOwnPropertyDescriptor.call(this, obj, prop);
	};
	const allKeys = origGetOwnPropertyNames(window);
	for (const k of allKeys) {
		if (blacklist.has(k)) {
			try { delete window[k]; } catch (_) {}
		} else if (k.startsWith("_")) {
			try {
				const desc = origGetOwnPropertyDescriptor(window, k);
				if (desc && desc.configurable) {
					Object.defineProperty(window, k, { enumerable: false });
				}
			} catch (_) {}
		}
	}
})();
`;

async function createDom(region, prefix) {
	const fp = generateFingerprint();

	// Optimization: Cached cookie fetch — reuses cookies for 5 minutes
	let initialCookies = [];
	const now = Date.now();
	if (_cookieCache.ts > 0 && (now - _cookieCache.ts) < COOKIE_CACHE_TTL_MS) {
		initialCookies = _cookieCache.cookies;
	} else {
		try {
			const res = await fetch("https://zcode.z.ai/", {
				headers: {
					"User-Agent": fp.userAgent,
					"sec-ch-ua": '"Chromium";v="' + fp.uaMajor + '", "Not)A;Brand";v="24"',
					"sec-ch-ua-mobile": "?0",
					"sec-ch-ua-platform": '"Linux"',
					"Accept-Language": "en-US,en;q=0.9"
				}
			});
			initialCookies = res.headers.getSetCookie?.() || [];
			_cookieCache = { cookies: initialCookies, ts: Date.now() };
		} catch (_) {}
	}

	const dom = new JSDOM(HTML, {
		url: "https://zcode.z.ai/",
		runScripts: "dangerously",
		resources: resourceLoader,
		pretendToBeVisual: true,
		virtualConsole,
		userAgent: fp.userAgent,
		beforeParse(window) {
			if (window.Error) {
				window.Error.prepareStackTrace = Error.prepareStackTrace;
			}
			applyPolyfills(window, fp);
			mapHostPrototypes(window);

			// Hook JSDOM dispatcher to inject Chromium client hints
			if (window._dispatcher && typeof window._dispatcher.request === "function") {
				const origRequest = window._dispatcher.request;
				window._dispatcher.request = function(opts) {
					const headers = opts.headers;
					if (headers && typeof headers.set === "function") {
						headers.set("sec-ch-ua", '"Chromium";v="' + fp.uaMajor + '", "Not)A;Brand";v="24"');
						headers.set("sec-ch-ua-mobile", "?0");
						headers.set("sec-ch-ua-platform", '"Linux"');
						headers.set("user-agent", fp.userAgent);
						headers.set("accept-language", "en-US,en;q=0.9");
					}
					return origRequest.call(this, opts);
				};
			}

			// Guest-context patches (pre-computed string — avoids repeated concat)
			window.eval(GUEST_EVAL_PATCH);

			window.AliyunCaptchaConfig = { region, prefix };
		},
	});

	// Inject pre-fetched cookies
	for (const cookieStr of initialCookies) {
		try { dom.cookieJar.setCookieSync(cookieStr, "https://zcode.z.ai/"); } catch (_) {}
	}
	const visitorId = crypto.randomUUID();
	const deviceMid = crypto.randomUUID();
	dom.cookieJar.setCookieSync(`zcode_visitor_id=${visitorId}; path=/; domain=zcode.z.ai; Secure`, "https://zcode.z.ai/");
	dom.cookieJar.setCookieSync(`zcode_device_mid=${deviceMid}; path=/; domain=zcode.z.ai; Secure`, "https://zcode.z.ai/");
	dom.cookieJar.setCookieSync(`visitor_id=${visitorId}; path=/; domain=zcode.z.ai; HttpOnly`, "https://zcode.z.ai/");

	return dom;
}

function destroyDom(dom) {
	if (!dom) return;
	try {
		const cap = dom.window.document.getElementById("cap");
		if (cap) cap.replaceChildren();
		dom.window.close();
	} catch (_) {}
}

function extractVerifyParam(param) {
	let verifyParam = param;
	if (param && typeof param === "object") {
		verifyParam = param.verifyParam || param.data || param.param;
	}
	if (!verifyParam || String(verifyParam).length < 20) {
		throw new Error("solver returned empty param");
	}
	// Strict validation (same rule as solve-happy-lib): a REAL Aliyun verify
	// param is ~280 chars of base64 JSON carrying certifyId + a long
	// securityToken. Degraded SDK success paths emit ~76-char params with no
	// securityToken that always 3007 upstream — refuse them here so they can
	// be retried instead of poisoning the token pool.
	const str = String(verifyParam);
	if (str.length < 200) {
		throw new Error(
			"verify param too short (" + str.length + " chars) — degraded result, refusing",
		);
	}
	try {
		const decoded = JSON.parse(Buffer.from(str, "base64").toString("utf8"));
		const secTok = decoded && (decoded.securityToken || decoded.SecurityToken);
		if (!secTok || String(secTok).length < 50) {
			throw new Error("verify param missing securityToken — degraded result, refusing");
		}
	} catch (err) {
		if (err instanceof SyntaxError) {
			throw new Error("verify param not base64-JSON: " + str.slice(0, 80));
		}
		throw err;
	}
	return str;
}

function handleCaptchaResult(result) {
	if (result && typeof result === "object" && result.verifyResult === false) {
		throw new Error(
			"verify rejected: " +
				JSON.stringify({
					verifyCode: result.verifyCode,
					certifyId: result.certifyId,
				}),
		);
	}
	return result;
}

/**
 * Dispatch a realistic interaction trajectory so FeiLin's behavioral collectors
 * record human-like input. Traceless verification grades this heavily — without
 * it the server returns F001 ("suspected attack").
 *
 * FeiLin subscribes (via EventTarget.addEventListener) to: mousemove, mousedown,
 * mouseup, click, keyup, touchstart, touchmove, touchend, pointerdown, scroll,
 * focusin, focusout. We synthesize a coherent mouse-down→move→up→click arc with
 * a keystroke, dispatching on document (where the collectors are bound).
 */
function simulateBehavior(window, durationMs = 600) {
	const { document, MouseEvent, KeyboardEvent, UIEvent } = window;
	if (!document || !MouseEvent) return;

	const fire = (type, ctor, opts) => {
		try {
			const Ctor = ctor || UIEvent;
			const ev = new Ctor(type, {
				bubbles: true,
				cancelable: true,
				view: window,
				...opts,
			});
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
		// ease toward target with jitter
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
			// conclude with a click at the landing point
			fire("mousedown", MouseEvent, {
				clientX: Math.round(x),
				clientY: Math.round(y),
				button: 0,
				buttons: 1,
			});
			fire("mouseup", MouseEvent, {
				clientX: Math.round(x),
				clientY: Math.round(y),
				button: 0,
				buttons: 0,
			});
			fire("click", MouseEvent, {
				clientX: Math.round(x),
				clientY: Math.round(y),
				button: 0,
			});
			// a keystroke (human presence signal)
			try {
				fire("keyup", KeyboardEvent, {
					key: "a",
					code: "KeyA",
					keyCode: 65,
					which: 65,
				});
			} catch (_) {}
		}
	};
	moveStep();
}

/**
 * One-shot solve: create jsdom → verify → destroy. Memory is freed after each token.
 * @param {{ scene: string, region: string, prefix: string, timeoutMs?: number }} opts
 */
async function solveTraceless(opts) {
	const scene = opts.scene || "11xygtvd";
	const region = opts.region || "sgp";
	const prefix = opts.prefix || "no8xfe";
	const timeoutMs = opts.timeoutMs ?? 25_000;

	const dom = await createDom(region, prefix);
	try {
		const { window } = dom;
		await waitFor(
			() => typeof window.initAliyunCaptcha === "function",
			timeoutMs,
		);

		// Prime FeiLin's behavioral buffer with a human-like mouse trajectory before
		// the traceless verification snapshot is taken.
		// Optimization: reduced from 1500ms to 600ms — Playwright only needs
		// ~500ms of mouse priming; 600ms gives margin without wasting time.
		simulateBehavior(window, 600);

		const param = await new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("captcha solve timeout")),
				timeoutMs,
			);
			const finish = (fn) => (value) => {
				clearTimeout(timer);
				fn(value);
			};

			try {
				window.initAliyunCaptcha({
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
					fail: (err) =>
						finish(reject)(new Error(`fail: ${JSON.stringify(err)}`)),
					onError: (err) =>
						finish(reject)(new Error(`onError: ${JSON.stringify(err)}`)),
				});
			} catch (err) {
				clearTimeout(timer);
				reject(err);
			}
		});

		return extractVerifyParam(param);
	} finally {
		destroyDom(dom);
	}
}

module.exports = { solveTraceless, createDom, destroyDom, generateFingerprint };
