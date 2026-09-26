import fs from "node:fs/promises";
import os from "node:os";

export type CpuGovernorConfig = {
  /** Host CPU ceiling — 100 = all vCPUs saturated (0 disables governor). */
  cpuLimitPercent: number;
  /** Hysteresis band below limit before ramping up again. */
  hysteresisPercent: number;
  poolSizeMin: number;
  poolSizeMax: number;
  maxSolveConcurrency: number;
  intervalMs: number;
};

export type CpuGovernorSnapshot = {
  cpuPercent: number;
  limitPercent: number;
  concurrency: number;
  maxEffectiveTarget: number;
  throttled: boolean;
};

/** 100 = entire host (all vCPUs) may be used; governor prevents exceeding that. */
const DEFAULT_CPU_LIMIT = Number(process.env.CAPTCHA_CPU_LIMIT_PCT || 100);
const DEFAULT_INTERVAL_MS = Number(process.env.CAPTCHA_CPU_GOVERNOR_INTERVAL_MS || 2_000);
const TARGET_STEP = 15;

type CpuCounters = { idle: number; total: number; source: "proc" | "os" };

/** Linux fast path: host-wide tick counters straight from /proc/stat. */
async function readProcStatCounters(): Promise<CpuCounters | null> {
  try {
    const stat = await fs.readFile("/proc/stat", "utf8");
    const line = stat.split("\n")[0] ?? "";
    const parts = line.split(/\s+/).slice(1).map((v) => Number(v) || 0);
    const idle = (parts[3] ?? 0) + (parts[4] ?? 0);
    const total = parts.reduce((sum, n) => sum + n, 0);
    if (total <= 0) return null;
    return { idle, total, source: "proc" };
  } catch {
    return null;
  }
}

/**
 * Cross-platform fallback: sum the per-core tick counters from os.cpus().
 *
 * The previous fallback used os.loadavg(), which is hard-wired to `[0,0,0]`
 * on Windows (documented in Node, inherited by Bun). The governor therefore
 * read "0% busy" forever there, so tick() always took the ramp branch: solve
 * concurrency and the pool target climbed unchecked to their maxima while the
 * host was in fact saturated — the runaway that pinned a core and grew the
 * heap to 2.8GB until every HTTP route stopped answering (2026-09-26 field
 * report). os.cpus() reports cumulative per-core milliseconds on every
 * platform, so a delta between two samples yields the same host-wide busy
 * ratio /proc/stat does (verified on win32: a 2s sample across 20 cores
 * advances `total` by ~40s of core-time).
 */
function readOsCpusCounters(): CpuCounters {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total, source: "os" };
}

async function readCpuCounters(): Promise<CpuCounters> {
  return (await readProcStatCounters()) ?? readOsCpusCounters();
}

/** Samples host-wide CPU (100% = all cores busy); /proc/stat on Linux, os.cpus() elsewhere. */
export class CaptchaCpuGovernor {
  private prevCpu: CpuCounters | null = null;
  private lastCpuPercent = 0;
  private concurrency: number;
  private maxEffectiveTarget: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private cfg: CpuGovernorConfig) {
    this.concurrency = 1;
    this.maxEffectiveTarget = cfg.poolSizeMin;
  }

  get enabled(): boolean {
    return this.cfg.cpuLimitPercent > 0;
  }

  configure(partial: Partial<CpuGovernorConfig>): void {
    this.cfg = { ...this.cfg, ...partial };
    this.maxEffectiveTarget = Math.max(
      this.cfg.poolSizeMin,
      Math.min(this.maxEffectiveTarget, this.cfg.poolSizeMax),
    );
    this.concurrency = Math.min(this.concurrency, this.cfg.maxSolveConcurrency);
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.cfg.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  snapshot(): CpuGovernorSnapshot {
    const limit = this.cfg.cpuLimitPercent;
    return {
      cpuPercent: Math.round(this.lastCpuPercent * 10) / 10,
      limitPercent: limit,
      concurrency: this.concurrency,
      maxEffectiveTarget: this.maxEffectiveTarget,
      throttled: this.lastCpuPercent >= limit - 3,
    };
  }

  /** Parallel background solves allowed right now (may be 0 when pool is warm). */
  backgroundConcurrency(readyTokens: number): number {
    if (!this.enabled) return this.cfg.maxSolveConcurrency;

    const cpu = this.lastCpuPercent;
    const limit = this.cfg.cpuLimitPercent;
    let allowed = this.concurrency;

    if (cpu >= limit) {
      allowed = 0;
    } else if (cpu >= limit - 4) {
      allowed = Math.min(allowed, 1);
    } else if (cpu >= limit - 10) {
      allowed = Math.min(allowed, 2);
    }

    if (readyTokens < this.cfg.poolSizeMin) {
      return Math.max(1, allowed);
    }

    return allowed;
  }

  maxPoolTarget(): number {
    return this.maxEffectiveTarget;
  }

  private async tick(): Promise<void> {
    const cpu = await this.sampleCpuPercent();
    this.lastCpuPercent = cpu;

    const limit = this.cfg.cpuLimitPercent;
    const rampThreshold = limit - this.cfg.hysteresisPercent;

    if (cpu >= limit) {
      this.concurrency = 1;
      this.maxEffectiveTarget = this.cfg.poolSizeMin;
    } else if (cpu >= limit - 4) {
      if (this.concurrency > 1) this.concurrency -= 1;
      this.maxEffectiveTarget = this.cfg.poolSizeMin;
    } else if (cpu >= limit - 10) {
      if (this.concurrency > 2) this.concurrency -= 1;
      this.maxEffectiveTarget = Math.max(
        this.cfg.poolSizeMin,
        this.maxEffectiveTarget - TARGET_STEP,
      );
    } else if (cpu <= rampThreshold) {
      if (this.concurrency < this.cfg.maxSolveConcurrency) {
        this.concurrency += 1;
      }
      if (this.maxEffectiveTarget < this.cfg.poolSizeMax) {
        this.maxEffectiveTarget = Math.min(
          this.cfg.poolSizeMax,
          this.maxEffectiveTarget + TARGET_STEP,
        );
      }
    }
  }

  private async sampleCpuPercent(): Promise<number> {
    const cur = await readCpuCounters();
    const prev = this.prevCpu;
    // Re-baseline instead of diffing across mismatched sources (/proc/stat
    // appears or a cgroup switch flips us onto os.cpus()): the two scales are
    // unrelated, so their difference would be meaningless noise.
    if (!prev || prev.source !== cur.source) {
      this.prevCpu = cur;
      return this.lastCpuPercent;
    }
    const idleDelta = cur.idle - prev.idle;
    const totalDelta = cur.total - prev.total;
    this.prevCpu = cur;
    // Non-positive or inverted deltas mean the counters were reset or the
    // core count changed; keep the last good reading rather than emitting a
    // bogus percentage the throttle logic would act on.
    if (totalDelta <= 0 || idleDelta < 0 || idleDelta > totalDelta) {
      return this.lastCpuPercent;
    }
    const used = ((totalDelta - idleDelta) / totalDelta) * 100;
    return Math.max(0, Math.min(100, used));
  }
}

export function resolveCpuGovernorConfig(opts: {
  poolSizeMin?: number;
  poolSizeMax?: number;
  solveConcurrency?: number;
  cpuLimitPercent?: number;
  cpuGovernorIntervalSec?: number;
}): CpuGovernorConfig {
  const poolSizeMin = opts.poolSizeMin ?? Number(process.env.CAPTCHA_POOL_MIN || 15);
  const poolSizeMax = Math.max(
    poolSizeMin,
    opts.poolSizeMax ?? Number(process.env.CAPTCHA_POOL_MAX || 60),
  );
  const maxSolveConcurrency =
    opts.solveConcurrency ??
    Number(
      process.env.CAPTCHA_SOLVE_CONCURRENCY ||
        (process.env.ZCODE_CAPTCHA_LOW_CPU === "0" ? 6 : 3),
    );

  const cpuLimitPercent =
    opts.cpuLimitPercent ??
    (process.env.CAPTCHA_CPU_GOVERNOR === "0" ? 0 : DEFAULT_CPU_LIMIT);

  const intervalMs =
    opts.cpuGovernorIntervalSec != null
      ? opts.cpuGovernorIntervalSec * 1000
      : DEFAULT_INTERVAL_MS;

  return {
    cpuLimitPercent,
    hysteresisPercent: 5,
    poolSizeMin,
    poolSizeMax,
    maxSolveConcurrency,
    intervalMs,
  };
}
