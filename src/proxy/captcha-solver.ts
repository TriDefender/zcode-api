import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CAPTCHA_NODE_DIR = path.join(ROOT, "captcha_node");
const DAEMON_JS = path.join(CAPTCHA_NODE_DIR, "daemon.js");
const SOLVER_JS = path.join(CAPTCHA_NODE_DIR, "solver.js");

const NODE_BIN = process.env.ZCODE_NODE_PATH?.trim() || "node";
const SOLVE_TIMEOUT_MS = Number(process.env.ZCODE_CAPTCHA_TIMEOUT || 40) * 1000;
const USE_DAEMON = process.env.ZCODE_CAPTCHA_DAEMON !== "0";
const DEFAULT_CONCURRENCY = Number(
	process.env.CAPTCHA_DAEMON_CONCURRENCY ??
		(process.env.ZCODE_CAPTCHA_LOW_CPU === "1" ? 3 : 6),
);

type PendingSolve = {
  resolve: (param: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Single Node daemon — one-shot Playwright solve per child, bounded concurrency queue. */
class SolverDaemon {
  private proc: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, PendingSolve>();
  private disabled = false;
  private daemonFailures = 0;
  private concurrency = DEFAULT_CONCURRENCY;
  private shuttingDown = false;
  private restarting: Promise<void> | null = null;

  async solve(scene: string, region: string, prefix: string): Promise<string> {
    if (!USE_DAEMON || this.disabled) {
      return runOneShotSolver(scene, region, prefix);
    }
    try {
      await this.ensureReady();
      return await this.requestSolve(scene, region, prefix);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!this.shuttingDown && (msg.includes("daemon") || msg.includes("spawn"))) {
        // Transient spawn failures shouldn't permanently degrade to
        // browser-launch-per-solve (much higher CPU). Retry the daemon a few
        // times; only fall back permanently after repeated failures.
        this.daemonFailures += 1;
        if (this.daemonFailures >= 3) {
          this.disabled = true;
          this.shutdown();
        } else {
          await this.restart();
        }
        return runOneShotSolver(scene, region, prefix);
      }
      throw err;
    }
  }

  setConcurrency(n: number): void {
    const next = Math.max(1, Math.floor(n));
    if (next === this.concurrency) return;
    this.concurrency = next;
    process.env.CAPTCHA_DAEMON_CONCURRENCY = String(next);
    this.shutdown();
  }

  shutdown(): void {
    this.shuttingDown = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("solver daemon shutting down"));
    }
    this.pending.clear();
    if (this.proc) {
      try {
        this.proc.kill("SIGTERM");
      } catch {}
      this.proc = null;
    }
    this.ready = null;
    this.buffer = "";
    this.shuttingDown = false;
  }

  private async ensureReady(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = this.spawnDaemon();
    return this.ready;
  }

  /** Kill the daemon (draining nothing) and let ensureReady respawn it on
   *  next use. In-flight requests are already rejected by shutdown(). */
  private async restart(): Promise<void> {
    if (this.restarting) return this.restarting;
    this.restarting = (async () => {
      this.shutdown();
      try {
        await this.ensureReady();
      } catch {
        // next solve() call retries via ensureReady
      }
    })();
    try {
      await this.restarting;
    } finally {
      this.restarting = null;
    }
  }

  private spawnDaemon(): Promise<void> {
    if (!fs.existsSync(DAEMON_JS)) {
      return Promise.reject(new Error(`Missing ${DAEMON_JS}`));
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(NODE_BIN, [DAEMON_JS], {
        cwd: CAPTCHA_NODE_DIR,
        env: {
          ...process.env,
          CAPTCHA_DAEMON_CONCURRENCY: String(this.concurrency),
          FONTCONFIG_PATH: "/dev/null",
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      this.proc = proc;

      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        this.ready = null;
        this.proc = null;
        reject(err);
      };

      proc.on("error", (err) => fail(new Error(`cannot spawn daemon: ${err.message}`)));
      proc.on("close", (code) => {
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error(`daemon exited (${code ?? "?"})`));
        }
        this.pending.clear();
        this.proc = null;
        this.ready = null;
      });

      proc.stdout?.on("data", (chunk: Buffer) => {
        this.buffer += chunk.toString("utf8");
        if (!settled) {
          const ready = this.buffer.includes('"ready"');
          this.drainBuffer();
          if (ready) {
            settled = true;
            resolve();
          }
        } else {
          this.drainBuffer();
        }
      });

      proc.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8").trim();
        if (text) process.stderr.write(`[captcha-daemon] ${text}\n`);
      });

      setTimeout(() => {
        if (!settled) fail(new Error("daemon ready timeout"));
      }, 30_000);
    });
  }

  private drainBuffer(): void {
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as {
          id?: number;
          ok?: boolean;
          param?: string;
          error?: string;
          ready?: boolean;
        };
        if (msg.ready) continue;
        if (typeof msg.id !== "number") continue;
        const pending = this.pending.get(msg.id);
        if (!pending) continue;
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.ok && msg.param && msg.param.length > 20) {
          pending.resolve(msg.param);
        } else {
          pending.reject(new Error(msg.error || "daemon solve failed"));
        }
      } catch {
        // ignore malformed lines
      }
    }
  }

  private requestSolve(scene: string, region: string, prefix: string): Promise<string> {
    const proc = this.proc;
    if (!proc?.stdin?.writable) {
      return Promise.reject(new Error("daemon stdin unavailable"));
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`daemon solve timeout (${SOLVE_TIMEOUT_MS}ms)`));
      }, SOLVE_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
      proc.stdin!.write(JSON.stringify({ id, scene, region, prefix }) + "\n");
    });
  }
}

const daemon = new SolverDaemon();

export function setCaptchaSolverConcurrency(n: number): void {
  daemon.setConcurrency(n);
}

export function captchaSolverConcurrency(): number {
  return Number(process.env.CAPTCHA_DAEMON_CONCURRENCY || DEFAULT_CONCURRENCY);
}

export function shutdownCaptchaSolver(): void {
  daemon.shutdown();
}

export async function runCaptchaSolve(scene: string, region: string, prefix: string): Promise<string> {
  return daemon.solve(scene, region, prefix);
}

function runOneShotSolver(scene: string, region: string, prefix: string): Promise<string> {
  if (!fs.existsSync(SOLVER_JS)) {
    return Promise.reject(new Error(`Missing ${SOLVER_JS}`));
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(NODE_BIN, [SOLVER_JS, scene, region, prefix], {
      cwd: CAPTCHA_NODE_DIR,
      env: { ...process.env, FONTCONFIG_PATH: "/dev/null" },
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
      reject(new Error(`captcha solve timeout (${SOLVE_TIMEOUT_MS}ms)`));
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
          `captcha solve exit ${code ?? "?"}: ${stderr.slice(0, 200) || stdout.slice(0, 200) || "no output"}`,
        ),
      );
    });
  });
}

export { CAPTCHA_NODE_DIR };
