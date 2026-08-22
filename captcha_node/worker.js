/**
 * Long-lived browser worker — one Chromium per process, context per solve.
 * Reads JSON lines on stdin: { id, scene?, region?, prefix? }
 * Writes JSON lines on stdout: { id, ok, param? | error? }
 */
const readline = require("node:readline");

process.env.FONTCONFIG_PATH = "/dev/null";
const backend = process.env.ZCODE_CAPTCHA_BACKEND || "jsdom";
const isJsdom = backend === "jsdom";
const isPlaywright = backend === "playwright";

let playwright = null;
let solvePlaywright = null;
let solveImpl = null;

if (isJsdom) {
	solveImpl = require("./solve-core").solveTraceless;
} else if (isPlaywright) {
	playwright = require("playwright");
	solvePlaywright = require("./solve-playwright");
} else {
	// happy (default alternative): happy-dom solver — no browser needed.
	solveImpl = require("./solve-happy-lib").solveTraceless;
}

const SOLVE_TIMEOUT_MS = Number(process.env.ZCODE_CAPTCHA_TIMEOUT || 40) * 1000;
const MAX_SOLVE_ATTEMPTS = Math.max(1, Number(process.env.ZCODE_CAPTCHA_RETRIES || 4));

let browser = null;
let busy = false;
const pending = [];
/** certifyIds produced by this worker — reject duplicates before returning. */
const recentCertifyIds = new Map();

let solvesCount = 0;
// Recycle workers to bound per-process memory growth (DOM/DOM-tree leaks).
// Measured leak ≈12MB/solve on happy-dom — recycle at 25 solves / 320MB.
const MAX_SOLVES_PER_WORKER = Number(
	process.env.ZCODE_CAPTCHA_MAX_SOLVES || (isJsdom ? 30 : isPlaywright ? 100 : 25),
);
// Hard RSS ceiling: recycle a worker the moment it crosses this, regardless of
// solve count (default 350MB; 0 disables).
const WORKER_MAX_RSS_MB = Number(process.env.ZCODE_CAPTCHA_WORKER_MAX_RSS_MB ?? 350);
// Playwright mode: close the idle Chromium after this long to free RAM;
// relaunched on demand by ensureBrowser().
const BROWSER_IDLE_CLOSE_MS = Number(process.env.ZCODE_CAPTCHA_BROWSER_IDLE_MS || 120) * 1000;
let browserIdleTimer = null;

function workerRssMb() {
	try {
		const status = require("node:fs").readFileSync("/proc/self/status", "utf8");
		const m = status.match(/VmRSS:\s*(\d+)/);
		return m ? Number(m[1]) / 1024 : 0;
	} catch (_) {
		return process.memoryUsage().rss / 1024 / 1024;
	}
}

function scheduleBrowserIdleClose() {
	if (!isPlaywright) return;
	if (browserIdleTimer) clearTimeout(browserIdleTimer);
	browserIdleTimer = setTimeout(() => {
		browserIdleTimer = null;
		if (busy) {
			scheduleBrowserIdleClose();
			return;
		}
		void resetBrowser();
	}, BROWSER_IDLE_CLOSE_MS);
	browserIdleTimer.unref?.();
}

function parseCertifyId(param) {
	try {
		const json = JSON.parse(Buffer.from(param, "base64").toString("utf8"));
		return typeof json.certifyId === "string" && json.certifyId ? json.certifyId : null;
	} catch {
		return null;
	}
}

function isDuplicateError(msg) {
	return /F008|"verifyCode"\s*:\s*"F008"/i.test(msg);
}

function rememberCertifyId(id) {
	recentCertifyIds.set(id, Date.now());
	const cutoff = Date.now() - 120_000;
	for (const [k, at] of recentCertifyIds) {
		if (at < cutoff) recentCertifyIds.delete(k);
	}
}

async function resetBrowser() {
	if (browserIdleTimer) {
		clearTimeout(browserIdleTimer);
		browserIdleTimer = null;
	}
	if (!isPlaywright) return;
	try {
		await browser?.close().catch(() => {});
	} catch (_) {}
	browser = null;
}

async function ensureBrowser() {
	if (isJsdom) return null;
	if (browser?.isConnected()) return browser;
	browser = await playwright.chromium.launch(solvePlaywright.launchOptions());
	return browser;
}

async function processOne(req) {
	const scene = req.scene || "11xygtvd";
	const region = req.region || "sgp";
	const prefix = req.prefix || "no8xfe";

	let lastErr = "unknown";
	for (let attempt = 1; attempt <= MAX_SOLVE_ATTEMPTS; attempt += 1) {
		const timer = setTimeout(() => {}, SOLVE_TIMEOUT_MS);
		try {
			let param;
			if (isPlaywright) {
				const b = await ensureBrowser();
				param = await solvePlaywright.solveWithBrowser(b, { scene, region, prefix });
			} else {
				param = await solveImpl({ scene, region, prefix });
			}
			clearTimeout(timer);

			const certifyId = parseCertifyId(param);
			if (certifyId && recentCertifyIds.has(certifyId)) {
				lastErr = `duplicate certifyId ${certifyId}`;
				await resetBrowser();
				continue;
			}
			if (certifyId) rememberCertifyId(certifyId);

			process.stdout.write(
				JSON.stringify({ id: req.id, ok: true, param }) + "\n",
			);
			
			// Recycle the worker after max solves OR when RSS crosses the
			// ceiling — either bound keeps memory strictly bounded per worker.
			solvesCount++;
			if (solvesCount >= MAX_SOLVES_PER_WORKER || (WORKER_MAX_RSS_MB > 0 && workerRssMb() > WORKER_MAX_RSS_MB)) {
				setTimeout(() => process.exit(0), 10);
			}
			return;
		} catch (err) {
			clearTimeout(timer);
			lastErr = err?.message || String(err);
			if (
				isDuplicateError(lastErr) ||
				(isPlaywright && /Target closed|Browser closed|crashed/i.test(lastErr))
			) {
				await resetBrowser();
				continue;
			}
			break;
		}
	}

	process.stdout.write(
		JSON.stringify({ id: req.id, ok: false, error: lastErr.slice(0, 300) }) + "\n",
	);
}

async function drain() {
	if (busy || pending.length === 0) return;
	busy = true;
	const req = pending.shift();
	try {
		await processOne(req);
	} finally {
		busy = false;
		scheduleBrowserIdleClose();
		drain();
	}
}

function enqueue(req) {
	pending.push(req);
	drain();
}

async function main() {
	if (isPlaywright) {
		// Warm launch only for playwright mode; jsdom/happy workers are ready
		// immediately (no browser). Keep this — the first solve needs the
		// browser, and warm floor workers exist for exactly that.
		await ensureBrowser();
	}
	process.stderr.write("worker ready\n");
	process.stdout.write(JSON.stringify({ workerReady: true }) + "\n");

	const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
	rl.on("line", (line) => {
		const trimmed = line.trim();
		if (!trimmed) return;
		let req;
		try {
			req = JSON.parse(trimmed);
		} catch {
			process.stdout.write(
				JSON.stringify({ id: null, ok: false, error: "invalid json" }) + "\n",
			);
			return;
		}
		if (typeof req.id !== "number") {
			process.stdout.write(
				JSON.stringify({
					id: req.id ?? null,
					ok: false,
					error: "missing id",
				}) + "\n",
			);
			return;
		}
		enqueue(req);
	});

	process.on("SIGTERM", async () => {
		await resetBrowser();
		process.exit(0);
	});
}

main().catch((err) => {
	process.stderr.write(String(err?.message || err) + "\n");
	process.exit(1);
});
