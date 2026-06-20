import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CAPTCHA_NODE_DIR = path.join(ROOT, "captcha_node");
const SOLVER_JS = path.join(CAPTCHA_NODE_DIR, "solver.js");

const CACHE_TTL_MS = Number(process.env.CAPTCHA_CACHE_TTL_MS || 45_000);
const SOLVE_RETRIES = Number(process.env.ZCODE_CAPTCHA_RETRIES || 4);
const SOLVE_TIMEOUT_MS = Number(process.env.ZCODE_CAPTCHA_TIMEOUT || 40) * 1000;
const NODE_BIN = process.env.ZCODE_NODE_PATH?.trim() || "node";

type CacheEntry = { param: string; cachedAt: number };

class JsdomCaptchaManager {
  private cache: CacheEntry | null = null;
  private lock: Promise<string> | null = null;

  invalidate(): void {
    this.cache = null;
  }

  async getVerifyParam(cfg: CaptchaConfig): Promise<string> {
    const now = Date.now();
    if (this.cache && now - this.cache.cachedAt < CACHE_TTL_MS) {
      return this.cache.param;
    }

    if (this.lock) return this.lock;

    const work = this.solveFresh(cfg).finally(() => {
      this.lock = null;
    });
    this.lock = work;
    return work;
  }

  private async solveFresh(cfg: CaptchaConfig): Promise<string> {
    const now = Date.now();
    if (this.cache && now - this.cache.cachedAt < CACHE_TTL_MS) {
      return this.cache.param;
    }

    let lastErr: string | null = null;
    for (let attempt = 1; attempt <= SOLVE_RETRIES; attempt++) {
      try {
        const param = await runSolver(cfg.sceneId, cfg.region, cfg.prefix);
        if (param) {
          this.cache = { param, cachedAt: Date.now() };
          return param;
        }
        lastErr = "solver returned empty";
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
      }
    }

    throw new Error(`jsdom captcha failed after ${SOLVE_RETRIES} attempts: ${lastErr ?? "unknown"}`);
  }
}

export interface CaptchaConfig {
  enabled: boolean;
  prefix: string;
  sceneId: string;
  region: string;
}

const manager = new JsdomCaptchaManager();

export function invalidateJsdomCaptcha(): void {
  manager.invalidate();
}

export async function solveCaptchaJsdom(cfg: CaptchaConfig): Promise<string> {
  if (!cfg.enabled || !cfg.prefix || !cfg.sceneId) {
    throw new Error("Captcha config unavailable from ZCode API");
  }
  return manager.getVerifyParam(cfg);
}

function runSolver(scene: string, region: string, prefix: string): Promise<string> {
  if (!fs.existsSync(SOLVER_JS)) {
    return Promise.reject(
      new Error(`Missing ${SOLVER_JS}. Run: cd captcha_node && npm install`),
    );
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(NODE_BIN, [SOLVER_JS, scene, region, prefix], {
      cwd: CAPTCHA_NODE_DIR,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`jsdom captcha timeout (${SOLVE_TIMEOUT_MS}ms)`));
    }, SOLVE_TIMEOUT_MS);

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`cannot spawn ${NODE_BIN}: ${err.message}`));
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      for (const line of stdout.split(/\r?\n/)) {
        if (line.startsWith("VERIFY_PARAM=")) {
          const param = line.slice("VERIFY_PARAM=".length).trim();
          if (param.length > 20) {
            resolve(param);
            return;
          }
        }
      }
      reject(
        new Error(
          `jsdom captcha exit ${code ?? "?"}: ${stderr.slice(0, 200) || stdout.slice(0, 200) || "no output"}`,
        ),
      );
    });
  });
}
