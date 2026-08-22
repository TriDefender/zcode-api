/**
 * Aliyun traceless captcha via real Chromium on https://zcode.z.ai/
 * (Vanszs/xscope0 pattern — do not intercept or replace the page origin.)
 *
 * Env toggles for isolated benchmarks:
 *   ZCODE_CAPTCHA_FAST_WAITS=1       — event-driven waits, shorter mouse priming
 *   ZCODE_CAPTCHA_BLOCK_RESOURCES=1  — abort images/fonts/css/media
 *   ZCODE_CAPTCHA_LIGHT_CHROME=1     — extra memory-saving launch flags
 *   ZCODE_CAPTCHA_LOW_CPU=1          — 4 vCPU profile: smaller viewport, block images, lean Chrome
 */
const fs = require("fs");
const { chromium } = require("playwright");

const ZCODE_ORIGIN = "https://zcode.z.ai/";
const SDK_URL =
	"https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";
const SOLVE_TIMEOUT_MS = Number(process.env.ZCODE_CAPTCHA_TIMEOUT || 40) * 1000;

const FAST_WAITS = process.env.ZCODE_CAPTCHA_FAST_WAITS === "1";
const BLOCK_RESOURCES = process.env.ZCODE_CAPTCHA_BLOCK_RESOURCES === "1";
const LIGHT_CHROME = process.env.ZCODE_CAPTCHA_LIGHT_CHROME === "1";
const LOW_CPU = process.env.ZCODE_CAPTCHA_LOW_CPU === "1";

const VIEWPORT =
	LOW_CPU || BLOCK_RESOURCES
		? { width: 640, height: 480 }
		: { width: 1280, height: 720 };

function resolveChromePath() {
	const env =
		process.env.ZCODE_CHROME_PATH?.trim() ||
		process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
	if (env && fs.existsSync(env)) return env;
	try {
		const exe = chromium.executablePath();
		if (exe && fs.existsSync(exe)) return exe;
	} catch {}
	return undefined;
}

function launchOptions() {
	const args = [
		"--no-sandbox",
		"--disable-dev-shm-usage",
		"--disable-blink-features=AutomationControlled",
		"--disable-features=IsolateOrigins,site-per-process",
		`--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
	];
	if (LIGHT_CHROME || LOW_CPU) {
		args.push(
			"--disable-gpu",
			"--disable-extensions",
			"--disable-background-networking",
			"--disable-default-apps",
			"--disable-sync",
			"--disable-translate",
			"--mute-audio",
			"--no-first-run",
			"--disable-component-update",
			`--renderer-process-limit=${LOW_CPU ? 2 : 4}`,
		);
	}
	if (LOW_CPU) {
		args.push(
			"--disable-accelerated-2d-canvas",
			"--disable-smooth-scrolling",
			"--disable-threaded-animation",
			"--disable-threaded-scrolling",
		);
	}
	const opts = {
		headless: !/^(1|true|yes)$/i.test(String(process.env.PW_HEADED || "")),
		args,
		ignoreDefaultArgs: ["--enable-automation"],
	};
	if (process.env.HTTP_PROXY) {
		opts.proxy = {
			server: process.env.HTTP_PROXY,
		};
	}
	const exe = resolveChromePath();
	if (exe) opts.executablePath = exe;
	return opts;
}

function contextOptions(region) {
	return {
		userAgent:
			"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
		viewport: VIEWPORT,
		locale: "en-US",
		timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
		extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
		serviceWorkers: "block",
	};
}

function initScriptPayload(region, prefix) {
	return {
		captchaRegion: region,
		captchaPrefix: prefix,
	};
}

const INIT_SCRIPT = ({ captchaRegion, captchaPrefix }) => {
	Object.defineProperty(navigator, "webdriver", { get: () => undefined });
	Object.defineProperty(navigator, "plugins", {
		get: () => [1, 2, 3, 4, 5],
	});
	Object.defineProperty(navigator, "languages", {
		get: () => ["en-US", "en"],
	});
	window.AliyunCaptchaConfig = {
		region: captchaRegion,
		prefix: captchaPrefix,
	};
};

async function setupPage(page, region, prefix) {
	await page.route("**/*", (route) => {
		const req = route.request();
		if (req.resourceType() === "document") {
			return route.continue({
				headers: {
					...req.headers(),
					"cache-control": "no-cache",
					pragma: "no-cache",
				},
			});
		}
		if (BLOCK_RESOURCES) {
			const type = req.resourceType();
			if (["image", "font", "media", "stylesheet"].includes(type)) {
				return route.abort();
			}
		} else if (LOW_CPU) {
			const type = req.resourceType();
			if (["image", "font", "media"].includes(type)) {
				return route.abort();
			}
		}
		return route.continue();
	});

	await page.goto(ZCODE_ORIGIN, {
		waitUntil: "domcontentloaded",
		timeout: 20_000,
	});

	if (FAST_WAITS) {
		await page
			.waitForFunction(() => typeof window.initAliyunCaptcha === "function", {
				timeout: 10_000,
			})
			.catch(() => {});
		await page.mouse.move(100, 100);
		await page.mouse.move(300, 200);
		await page.waitForTimeout(150);
	} else if (LOW_CPU) {
		await page.waitForTimeout(1200);
		await page.mouse.move(100, 100);
		await page.mouse.move(300, 200);
		await page.waitForTimeout(200);
	} else {
		await page.waitForTimeout(2000);
		await page.mouse.move(100, 100);
		await page.mouse.move(300, 200);
		await page.mouse.move(500, 300);
		await page.waitForTimeout(500);
	}
}

async function runCaptchaOnPage(page, scene, region, prefix) {
	const param = await page.evaluate(
		async ({ sceneId, captchaRegion, captchaPrefix, sdkUrl, timeoutMs }) => {
			if (!window.initAliyunCaptcha) {
				await new Promise((res, rej) => {
					const s = document.createElement("script");
					s.src = sdkUrl;
					s.onload = res;
					s.onerror = () => rej(new Error("SDK script load error"));
					document.head.appendChild(s);
				});
			}
			return new Promise((resolve, reject) => {
				const timeout = setTimeout(
					() => reject(new Error(`captcha solve timeout ${timeoutMs}ms`)),
					timeoutMs,
				);
				window.initAliyunCaptcha({
					SceneId: sceneId,
					mode: "popup",
					region: captchaRegion,
					prefix: captchaPrefix,
					element: "#cap",
					button: "#btn",
					getInstance: (inst) => {
						if (
							inst &&
							typeof inst.startTracelessVerification === "function"
						) {
							inst.startTracelessVerification();
						}
					},
					success: (p) => {
						clearTimeout(timeout);
						resolve(p);
					},
					fail: (e) => {
						clearTimeout(timeout);
						reject(new Error(`fail: ${JSON.stringify(e).slice(0, 300)}`));
					},
					onError: (e) => {
						clearTimeout(timeout);
						reject(new Error(`onError: ${JSON.stringify(e).slice(0, 300)}`));
					},
				});
			});
		},
		{
			sceneId: scene,
			captchaRegion: region,
			captchaPrefix: prefix,
			sdkUrl: SDK_URL,
			timeoutMs: SOLVE_TIMEOUT_MS,
		},
	);

	const value =
		param && typeof param === "object"
			? param.verifyParam || param.param || param.data
			: param;
	const out = String(value ?? param ?? "");
	if (out.length < 20) {
		throw new Error(
			`empty verify param: ${JSON.stringify(param).slice(0, 200)}`,
		);
	}
	return out;
}

/**
 * Solve using an existing browser (worker pool). Creates and closes a context per solve.
 * @param {import('playwright').Browser} browser
 */
async function solveWithBrowser(browser, { scene, region, prefix }) {
	const ctx = await browser.newContext(contextOptions(region));
	try {
		await ctx.addInitScript(INIT_SCRIPT, initScriptPayload(region, prefix));
		const page = await ctx.newPage();
		await setupPage(page, region, prefix);
		return await runCaptchaOnPage(page, scene, region, prefix);
	} finally {
		await ctx.close().catch(() => {});
	}
}

/**
 * One-shot solve: launch browser → verify → close.
 * @param {{ scene: string, region: string, prefix: string }} opts
 * @returns {Promise<string>}
 */
async function solveTraceless(opts) {
	const browser = await chromium.launch(launchOptions());
	try {
		return await solveWithBrowser(browser, opts);
	} finally {
		await browser.close().catch(() => {});
	}
}

module.exports = {
	solveTraceless,
	solveWithBrowser,
	launchOptions,
};
