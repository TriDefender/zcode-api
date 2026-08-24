import {
  CaptchaCpuGovernor,
  resolveCpuGovernorConfig,
  type CpuGovernorSnapshot,
} from "./captcha-cpu-governor.js";
import {
  captchaSolverConcurrency,
  runCaptchaSolve,
  setCaptchaSolverConcurrency,
  shutdownCaptchaSolver,
} from "./captcha-solver.js";
import { isCaptchaDuplicateError, isCaptchaIpBlockError, parseCertifyId } from "./captcha-token.js";

export interface CaptchaPoolOptions {
  /** @deprecated Use poolSizeMax — kept as max cap alias. */
  poolSize?: number;
  poolSizeMin?: number;
  poolSizeMax?: number;
  /** Idle seconds before shrinking toward min (default 120). */
  scaleDownIdleMs?: number;
  /** Deep-idle floor: pool target decays to this after sustained zero traffic
   *  (default 1). First token take restores the full poolSizeMin. */
  idleFloor?: number;
  /** Zero-traffic seconds after which background solving stops entirely —
   *  target floor decays to 0 (default 900). One banked token is still kept
   *  for an instant serve on wake-up. */
  deepIdleAfterMs?: number;
  tokenTtlMs?: number;
  refillIntervalMs?: number;
  solveRetries?: number;
  staggerMs?: number;
  solveConcurrency?: number;
  /** Parallel solves raced when a take finds the pool empty (default 2). */
  emptyTakeRace?: number;
  /** Host CPU ceiling for captcha workers (default 100, 0 = off). */
  cpuLimitPercent?: number;
  cpuGovernorIntervalSec?: number;
  /**
   * Called when minting fails with an IP-level block ("too many captcha
   * requests" family). The proxy wires this to the Telegram network reset so
   * an Aliyun IP block self-heals instead of stranding the token pool.
   */
  onCaptchaIpBlock?: (reason: string) => void;
}

type TokenEntry = { param: string; cachedAt: number; certifyId: string | null };

/** Tracks certifyIds already handed out or queued — prevents F008 duplicate usage. */
class CertifyIdRegistry {
  private seen = new Map<string, number>();

  constructor(private ttlMs: number) {}

  setTtlMs(ttlMs: number): void {
    this.ttlMs = ttlMs;
  }

  prune(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, at] of this.seen) {
      if (at < cutoff) this.seen.delete(id);
    }
  }

  has(id: string): boolean {
    this.prune();
    return this.seen.has(id);
  }

  add(id: string): void {
    this.prune();
    this.seen.set(id, Date.now());
  }

  clear(): void {
    this.seen.clear();
  }
}

const DEFAULT_POOL_MIN = Number(process.env.CAPTCHA_POOL_MIN || 40);
const DEFAULT_POOL_MAX = Number(process.env.CAPTCHA_POOL_MAX || 120);
const DEFAULT_TOKEN_TTL_MS = Number(process.env.CAPTCHA_CACHE_TTL_MS || 95_000);
const DEFAULT_REFILL_INTERVAL_MS = Number(process.env.CAPTCHA_REFILL_INTERVAL_MS || 1_000);
const DEFAULT_STAGGER_MS = Number(process.env.CAPTCHA_SOLVE_STAGGER_MS || 0);
const DEFAULT_SOLVE_CONCURRENCY = Number(
	process.env.CAPTCHA_SOLVE_CONCURRENCY ||
		(process.env.ZCODE_CAPTCHA_LOW_CPU === "1" ? 3 : 8),
);
const DEFAULT_SCALE_DOWN_IDLE_MS = Number(process.env.CAPTCHA_POOL_SCALE_DOWN_IDLE_MS || 120_000);
const DEFAULT_IDLE_FLOOR = Number(process.env.CAPTCHA_POOL_IDLE_FLOOR || 1);
// Zero-traffic beyond this stops background solving entirely (floor 0): no
// mint churn, near-zero CPU. The next token take restores poolSizeMin.
const DEFAULT_DEEP_IDLE_AFTER_MS = Number(process.env.CAPTCHA_DEEP_IDLE_AFTER_MS || 900_000);
// Parallel solves raced on an empty-pool take — first success serves the
// client, the twins top up the pool. Cuts worst-case cold TTFB and widens
// odds against a bad rotated pe bundle stalling one racer.
const EMPTY_TAKE_RACE = Math.max(1, Number(process.env.CAPTCHA_EMPTY_TAKE_RACE || 3));
const SOLVE_RETRIES = Number(process.env.ZCODE_CAPTCHA_RETRIES || 4);
const SCALE_UP_STEP = 20;
const TAKE_RATE_WINDOW_MS = 120_000;

type ResolvedPoolOpts = {
  poolSizeMin: number;
  poolSizeMax: number;
  idleFloor: number;
  deepIdleAfterMs: number;
  scaleDownIdleMs: number;
  tokenTtlMs: number;
  refillIntervalMs: number;
  solveRetries: number;
  staggerMs: number;
  solveConcurrency: number;
  emptyTakeRace: number;
  onCaptchaIpBlock?: (reason: string) => void;
};

function resolvePoolOpts(opts: CaptchaPoolOptions): ResolvedPoolOpts {
  const max = opts.poolSizeMax ?? opts.poolSize ?? DEFAULT_POOL_MAX;
  const min = Math.min(opts.poolSizeMin ?? DEFAULT_POOL_MIN, max);
  return {
    poolSizeMin: min,
    poolSizeMax: max,
    idleFloor: Math.min(opts.idleFloor ?? DEFAULT_IDLE_FLOOR, min),
    deepIdleAfterMs: Math.max(
      opts.deepIdleAfterMs ?? DEFAULT_DEEP_IDLE_AFTER_MS,
      opts.scaleDownIdleMs ?? DEFAULT_SCALE_DOWN_IDLE_MS,
    ),
    scaleDownIdleMs: opts.scaleDownIdleMs ?? DEFAULT_SCALE_DOWN_IDLE_MS,
    tokenTtlMs: opts.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS,
    refillIntervalMs: opts.refillIntervalMs ?? DEFAULT_REFILL_INTERVAL_MS,
    solveRetries: opts.solveRetries ?? SOLVE_RETRIES,
    staggerMs: opts.staggerMs ?? DEFAULT_STAGGER_MS,
    solveConcurrency: opts.solveConcurrency ?? DEFAULT_SOLVE_CONCURRENCY,
    emptyTakeRace: Math.max(1, opts.emptyTakeRace ?? EMPTY_TAKE_RACE),
    onCaptchaIpBlock: opts.onCaptchaIpBlock,
  };
}

export class CaptchaTokenPool {
  private tokens: TokenEntry[] = [];
  private opts: ResolvedPoolOpts;
  private effectiveTarget: number;
  private refillTimer: ReturnType<typeof setInterval> | null = null;
  private refillInFlight = false;
  private lastSolveAt = 0;
  private activeSolves = 0;
  private cfg: CaptchaConfig | null = null;
  private pausedUntil = 0;
  private lastTakeAt: number;
  private takeTimestamps: number[] = [];
  private certifyIds: CertifyIdRegistry;
  private governor: CaptchaCpuGovernor | null = null;
  // Mint-storm detection: sliding windows of failed vs successful mint
  // attempts. A burst of failures with zero successes means velocity/IP
  // flagging — fire the telegram IP reset automatically.
  private mintFailures: number[] = [];
  private mintSuccesses: number[] = [];
  private lastStormResetAt = 0;

  constructor(opts: CaptchaPoolOptions = {}) {
    // The module-level singleton constructs with no opts before config load;
    // resolvePoolOpts would fall back to env/global defaults there (e.g.
    // poolSizeMin 40) and configure()'s clamp would preserve that as the
    // starting target — minting a storm of soon-expired tokens at every
    // boot. With no explicit opts, defer sizing to the first configure().
    const hasOpts = Object.keys(opts).length > 0;
    this.opts = resolvePoolOpts(opts);
    this.effectiveTarget = hasOpts ? this.opts.poolSizeMin : 0;
    // Seed idle clock at startup so a no-traffic proxy decays to idleFloor
    // instead of solving 40-60 tokens forever (lastTakeAt=0 disabled decay).
    this.lastTakeAt = Date.now();
    this.certifyIds = new CertifyIdRegistry(this.opts.tokenTtlMs);
    this.initGovernor(opts);
    setCaptchaSolverConcurrency(this.opts.solveConcurrency);
  }

  configure(opts: CaptchaPoolOptions): void {
    this.opts = resolvePoolOpts({ ...this.opts, ...opts });
    this.certifyIds.setTtlMs(this.opts.tokenTtlMs);
    this.effectiveTarget = Math.max(
      this.opts.poolSizeMin,
      Math.min(this.effectiveTarget, this.opts.poolSizeMax),
    );
    this.initGovernor(opts);
    // Propagate the resolved concurrency to the solver daemon — the
    // import-time constructor runs before config load and would otherwise
    // leave the daemon at its fallback (8) instead of the configured value.
    setCaptchaSolverConcurrency(this.opts.solveConcurrency);
    this.trimToTarget();
  }

  stats(): {
    ready: number;
    target: number;
    min: number;
    max: number;
    activeSolves: number;
    solverWorkers: number;
    cpu?: CpuGovernorSnapshot;
  } {
    this.pruneExpired();
    return {
      ready: this.tokens.length,
      target: this.effectiveTarget,
      min: this.opts.poolSizeMin,
      max: this.opts.poolSizeMax,
      activeSolves: this.activeSolves,
      solverWorkers: captchaSolverConcurrency(),
      cpu: this.governor?.enabled ? this.governor.snapshot() : undefined,
    };
  }

  invalidate(): void {
    this.tokens = [];
    this.certifyIds.clear();
    this.pausedUntil = Date.now() + this.opts.staggerMs;
  }

  startBackgroundRefill(cfg: CaptchaConfig): void {
    this.cfg = cfg;
    this.stopBackgroundRefill();
    this.governor?.start();
    void this.refill({ urgent: false });
    this.refillTimer = setInterval(() => {
      void this.refill({ urgent: false });
    }, this.opts.refillIntervalMs);
  }

  stopBackgroundRefill(): void {
    this.governor?.stop();
    if (this.refillTimer) {
      clearInterval(this.refillTimer);
      this.refillTimer = null;
    }
  }

  async takeToken(cfg: CaptchaConfig): Promise<string> {
    this.cfg = cfg;

    const readyBefore = this.tokens.length;
    const token = this.popFresh();
    if (token) {
      this.onTokenTaken(false, readyBefore - 1);
      void this.refill({ urgent: true });
      return token;
    }

    this.onTokenTaken(true, 0);
    // Re-size immediately from current demand (this take is already in the
    // window) so an empty-pool arrival widens the buffer right away.
    this.effectiveTarget = Math.max(this.effectiveTarget, this.computeActiveTarget());
    let param: string;
    try {
      // Overall deadline for the racing chain: during mint storms a racer can
      // grind through its retry budget (~30-45s) — cap the client-facing wait
      // and let the background waves finish the job instead.
      const raceDeadlineMs = Number(process.env.CAPTCHA_SOLVE_RACE_DEADLINE_MS || 25_000);
      param = await Promise.race([
        this.solveRaced(cfg),
        new Promise<never>((_, rej) =>
          setTimeout(
            () => rej(new Error(`captcha take deadline (${raceDeadlineMs}ms)`)),
            Math.max(1_000, raceDeadlineMs),
          ),
        ),
      ]);
    } catch (err) {
      // Mints fail in clusters (pe-stall storms, F008 velocity). Background
      // refill waves keep retrying — give them a short window to land a
      // token before surfacing a failure to the client. This converts most
      // storm-window 503s into slower successes.
      const graceMs = Number(process.env.CAPTCHA_TAKE_GRACE_MS || 10_000);
      const deadline = Date.now() + Math.max(0, graceMs);
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 400));
        const token = this.popFresh();
        if (token) {
          this.markParamIssued(token);
          void this.refill({ urgent: true });
          return token;
        }
      }
      throw err;
    }
    this.markParamIssued(param);
    void this.refill({ urgent: true });
    return param;
  }

  async prefill(cfg: CaptchaConfig, count?: number): Promise<void> {
    this.cfg = cfg;
    const target = Math.min(count ?? this.effectiveTarget, this.effectiveTarget);
    while (this.tokens.length + this.activeSolves < target) {
      const need = target - this.tokens.length - this.activeSolves;
      if (need <= 0) break;
      const concurrency = this.governor?.enabled
        ? this.governor.backgroundConcurrency(this.tokens.length)
        : this.opts.solveConcurrency;
      await this.solveBatch(cfg, need, Math.max(1, concurrency));
    }
  }

  requestUrgentRefill(): void {
    void this.refill({ urgent: true });
  }

  private poolHasCertifyId(certifyId: string): boolean {
    return this.tokens.some((t) => t.certifyId === certifyId);
  }

  private isDuplicateParam(param: string): boolean {
    const certifyId = parseCertifyId(param);
    if (!certifyId) return false;
    return this.certifyIds.has(certifyId) || this.poolHasCertifyId(certifyId);
  }

  private markParamIssued(param: string): void {
    const certifyId = parseCertifyId(param);
    if (certifyId) this.certifyIds.add(certifyId);
  }

  private popFresh(): string | null {
    this.pruneExpired();
    while (this.tokens.length > 0) {
      const entry = this.tokens.pop()!;
      if (entry.certifyId && this.certifyIds.has(entry.certifyId)) continue;
      this.markParamIssued(entry.param);
      return entry.param;
    }
    return null;
  }

  private pushToken(param: string): void {
    this.pruneExpired();
    if (this.tokens.length >= this.effectiveTarget) return;
    const certifyId = parseCertifyId(param);
    if (certifyId && (this.certifyIds.has(certifyId) || this.poolHasCertifyId(certifyId))) {
      return;
    }
    this.tokens.push({ param, cachedAt: Date.now(), certifyId });
  }

  private pruneExpired(): void {
    const now = Date.now();
    this.tokens = this.tokens.filter((t) => now - t.cachedAt < this.opts.tokenTtlMs);
  }

  private deficit(): number {
    this.pruneExpired();
    return Math.max(0, this.effectiveTarget - this.tokens.length - this.activeSolves);
  }

  private pruneTakeWindow(): void {
    const cutoff = Date.now() - TAKE_RATE_WINDOW_MS;
    this.takeTimestamps = this.takeTimestamps.filter((t) => t > cutoff);
  }

  private demandTarget(): number {
    this.pruneTakeWindow();
    if (this.takeTimestamps.length === 0) return this.opts.poolSizeMin;
    const ratePerSec = this.takeTimestamps.length / (TAKE_RATE_WINDOW_MS / 1000);
    const ttlSec = this.opts.tokenTtlMs / 1000;
    return Math.ceil(ratePerSec * ttlSec * 1.25);
  }

  /**
   * Target while traffic is recent: measured demand (take rate × TTL ×
   * margin) plus one token of arrival-jitter headroom, floored at
   * poolSizeMin, capped by governor + poolSizeMax. This is the ONLY sizing
   * authority while active — bursts raise demand, quiet periods drain it.
   */
  private computeActiveTarget(): number {
    const demand = Math.max(this.demandTarget(), this.opts.poolSizeMin);
    const raw = Math.ceil(demand * 1.25) + 1;
    const governorMax = this.governor?.maxPoolTarget() ?? this.opts.poolSizeMax;
    return Math.max(
      this.currentFloor(),
      Math.min(this.opts.poolSizeMax, governorMax, raw),
    );
  }

  private onTokenTaken(wasEmpty: boolean, readyAfter: number): void {
    this.lastTakeAt = Date.now();
    this.takeTimestamps.push(this.lastTakeAt);
    this.pruneTakeWindow();
    this.wakeFromIdle();
    // Sizing is demand-driven via computeActiveTarget() on the next refill
    // tick; takes only need to restore the active floor instantly.
  }

  private maybeScaleDown(): void {
    if (this.lastTakeAt === 0) return;
    const idleMs = Date.now() - this.lastTakeAt;
    if (idleMs < this.opts.scaleDownIdleMs) return;

    this.pruneTakeWindow();
    const recentTakes = this.takeTimestamps.filter((t) => t > Date.now() - 60_000).length;
    if (recentTakes > 1) return;

    // Deep idle: decay the effective floor itself so Chromium workers and
    // solve churn wind down — first toward idleFloor, then to zero after
    // deepIdleAfterMs (no background mints at all). Any token take snaps the
    // floor back to full poolSizeMin.
    const floor = this.currentFloor();
    if (this.effectiveTarget > floor) {
      this.effectiveTarget = Math.max(floor, this.effectiveTarget - SCALE_UP_STEP);
      this.trimToTarget();
    }
  }

  /**
   * Active traffic → poolSizeMin. After scaleDownIdleMs of no takes →
   * idleFloor (keeper churn ≈ 1 mint/TTL). After deepIdleAfterMs → 0:
   * background solving stops; the banked token still serves a wake-up take.
   */
  private currentFloor(): number {
    if (this.lastTakeAt === 0) return this.opts.poolSizeMin;
    const idleMs = Date.now() - this.lastTakeAt;
    if (idleMs >= this.opts.deepIdleAfterMs) return 0;
    if (idleMs >= this.opts.scaleDownIdleMs) {
      return Math.min(this.opts.idleFloor, this.opts.poolSizeMin);
    }
    return this.opts.poolSizeMin;
  }

  /** Traffic returned: restore the full configured floor immediately. */
  private wakeFromIdle(): void {
    if (this.effectiveTarget < this.opts.poolSizeMin) {
      this.effectiveTarget = this.opts.poolSizeMin;
    }
  }

  private trimToTarget(): void {
    this.pruneExpired();
    // Never trim the last banked token: it serves a wake-up take instantly
    // (free TTFB) and expires naturally via pruneExpired.
    const floor = Math.max(this.effectiveTarget, 1);
    while (this.tokens.length > floor) {
      this.tokens.shift();
    }
  }

  private applyGovernorCaps(): void {
    if (!this.governor?.enabled) return;
    const governorMax = this.governor.maxPoolTarget();
    // Floor is idle-aware (idleFloor → 0 past deepIdleAfterMs) — don't clamp
    // it back up (that would refill forever during idle).
    const floor = this.currentFloor();
    this.effectiveTarget = Math.max(
      floor,
      Math.min(this.effectiveTarget, governorMax, this.opts.poolSizeMax),
    );
  }

  private async refill(opts: { urgent: boolean }): Promise<void> {
    if (!this.cfg) return;
    // Refresh sizing BEFORE the in-flight guard: a fill batch with slow or
    // stalling solves can hold refillInFlight for minutes, and freezing the
    // target that whole time starves the buffer exactly when demand exists.
    const idleDecay =
      this.lastTakeAt > 0 && Date.now() - this.lastTakeAt >= this.opts.scaleDownIdleMs;
    if (!idleDecay) {
      this.effectiveTarget = this.computeActiveTarget();
    } else {
      this.maybeScaleDown();
    }

    // Idle decay: drop the target toward the current floor (idleFloor → 0
    // past deepIdleAfterMs) and skip background solves while enough banked
    // tokens remain. This is what stops mint churn at zero traffic.
    if (!opts.urgent && idleDecay) {
      if (this.tokens.length >= Math.max(this.currentFloor(), 1)) return;
    }

    if (this.refillInFlight || Date.now() < this.pausedUntil) return;

    this.applyGovernorCaps();

    const ready = this.tokens.length;
    const concurrency = this.governor?.enabled
      ? opts.urgent
        ? Math.max(1, this.governor.backgroundConcurrency(ready) || this.governor.snapshot().concurrency)
        : this.governor.backgroundConcurrency(ready)
      : this.opts.solveConcurrency;

    if (!opts.urgent && concurrency === 0 && ready >= this.opts.poolSizeMin) {
      return;
    }

    const need = this.deficit();
    if (need <= 0) return;

    this.refillInFlight = true;
    try {
      await this.solveBatch(this.cfg, need, Math.max(1, concurrency));
    } finally {
      this.refillInFlight = false;
    }
  }

  /** Fire up to `need` solves in parallel waves of solveConcurrency. */
  private async solveBatch(cfg: CaptchaConfig, need: number, concurrency = this.opts.solveConcurrency): Promise<void> {
    let remaining = need;
    while (remaining > 0 && this.tokens.length + this.activeSolves < this.effectiveTarget) {
      const wave = Math.min(remaining, concurrency, this.deficit());
      if (wave <= 0) break;
      if (this.opts.staggerMs > 0) await this.waitForStagger();
      const results = await Promise.allSettled(
        Array.from({ length: wave }, () => this.solveOne(cfg)),
      );
      for (const r of results) {
        if (r.status === "fulfilled") {
          this.pushToken(r.value);
        } else {
          console.warn("[captcha-pool] parallel solve failed:", r.reason);
        }
      }
      remaining -= wave;
      if (results.every((r) => r.status === "rejected")) break;
    }
  }

  private async waitForStagger(): Promise<void> {
    const elapsed = Date.now() - this.lastSolveAt;
    const wait = this.opts.staggerMs - elapsed;
    if (wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  private noteMintFailure(reason: string): void {
    const now = Date.now();
    this.mintFailures.push(now);
    const cutoff = now - 360_000;
    this.mintFailures = this.mintFailures.filter((t) => t > cutoff);
    this.maybeFireMintStormReset(reason);
  }

  private noteMintSuccess(): void {
    const now = Date.now();
    this.mintSuccesses.push(now);
    const cutoff = now - 360_000;
    this.mintSuccesses = this.mintSuccesses.filter((t) => t > cutoff);
  }

  /** Velocity/IP flagging signature: many failed mints in the last 5 min
   *  while nothing succeeded in the last 3. Fires the telegram IP reset at
   *  most once per cooldown — requestCaptchaIpResetSync dedupes further. */
  private maybeFireMintStormReset(latestReason: string): void {
    const now = Date.now();
    const fails = this.mintFailures.filter((t) => t > now - 300_000).length;
    const succs = this.mintSuccesses.filter((t) => t > now - 180_000).length;
    if (fails < 8 || succs > 0) return;
    if (now - this.lastStormResetAt < 12 * 60_000) return;
    this.lastStormResetAt = now;
    console.warn(
      `[captcha] mint storm detected (${fails} failures/5min, ${succs} successes/3min; latest: ${latestReason.slice(0, 120)}) -> requesting IP reset`,
    );
    try {
      this.opts.onCaptchaIpBlock?.(`mint storm: ${fails} failed mints in 5min`);
    } catch {
      // callback is best-effort; never break the pool
    }
  }

  private async solveFresh(cfg: CaptchaConfig): Promise<string> {
    this.activeSolves += 1;
    this.lastSolveAt = Date.now();
    try {
      let lastErr: string | null = null;
      let sawIpBlock = false;
      for (let attempt = 1; attempt <= this.opts.solveRetries; attempt += 1) {
        try {
          const param = await runCaptchaSolve(cfg.sceneId, cfg.region, cfg.prefix);
          if (!param) {
            lastErr = "solver returned empty";
            continue;
          }
          if (this.isDuplicateParam(param)) {
            lastErr = `duplicate certifyId ${parseCertifyId(param) ?? "?"}`;
            continue;
          }
          this.noteMintSuccess();
          return param;
        } catch (err) {
          lastErr = err instanceof Error ? err.message : String(err);
          if (isCaptchaDuplicateError(lastErr)) {
            lastErr = `duplicate certifyId (F008)`;
          } else if (isCaptchaIpBlockError(lastErr)) {
            sawIpBlock = true;
          }
          this.noteMintFailure(lastErr);
        }
      }
      // All retries failed. If any failure was an IP-level block, ask the
      // caller to rotate the egress (Telegram network reset) so the next
      // mint has a fresh IP instead of being stuck unable to mint.
      if (sawIpBlock && this.opts.onCaptchaIpBlock) {
        try {
          this.opts.onCaptchaIpBlock(lastErr ?? "captcha ip block");
        } catch (_) {
          // callback is best-effort; never let it break the pool
        }
      }
      throw new Error(`captcha failed after ${this.opts.solveRetries} attempts: ${lastErr ?? "unknown"}`);
    } finally {
      this.activeSolves -= 1;
    }
  }

  private async solveOne(cfg: CaptchaConfig): Promise<string> {
    return this.solveFresh(cfg);
  }

  /**
   * Empty-pool serve: race up to `emptyTakeRace` solves in parallel and
   * resolve with the first success so the client waits for one mint, not a
   * sequential retry chain. Extra successes are banked into the pool instead
   * of being wasted; the race only rejects when every racer fails.
   */
  private solveRaced(cfg: CaptchaConfig): Promise<string> {
    const racers = Math.max(1, Math.min(this.opts.emptyTakeRace, this.opts.solveConcurrency));
    if (racers <= 1) return this.solveFresh(cfg);

    return new Promise<string>((resolve, reject) => {
      let pending = racers;
      let served = false;
      let lastErr: unknown = null;
      for (let i = 0; i < racers; i += 1) {
        this.solveFresh(cfg).then(
          (param) => {
            if (served) {
              // Lost the race but minted a valid token — bank it.
              this.pushToken(param);
            } else {
              served = true;
              resolve(param);
            }
          },
          (err) => {
            lastErr = err ?? lastErr;
          },
        ).finally(() => {
          pending -= 1;
          if (pending === 0 && !served) {
            reject(
              lastErr instanceof Error
                ? lastErr
                : new Error(String(lastErr ?? "captcha race failed")),
            );
          }
        });
      }
    });
  }

  private initGovernor(opts: CaptchaPoolOptions): void {
    const cfg = resolveCpuGovernorConfig({
      poolSizeMin: this.opts.poolSizeMin,
      poolSizeMax: this.opts.poolSizeMax,
      solveConcurrency: this.opts.solveConcurrency,
      cpuLimitPercent: opts.cpuLimitPercent,
      cpuGovernorIntervalSec: opts.cpuGovernorIntervalSec,
    });
    if (!this.governor) {
      this.governor = new CaptchaCpuGovernor(cfg);
    } else {
      this.governor.configure(cfg);
    }
  }
}

export interface CaptchaConfig {
  enabled: boolean;
  prefix: string;
  sceneId: string;
  region: string;
}

const pool = new CaptchaTokenPool();

export function configureCaptchaPool(opts: CaptchaPoolOptions): void {
  pool.configure(opts);
}

export function getCaptchaPoolStats(): {
  ready: number;
  target: number;
  min?: number;
  max?: number;
  activeSolves: number;
  solverWorkers?: number;
} {
  return pool.stats();
}

export function stopCaptchaPool(): void {
  pool.stopBackgroundRefill();
  shutdownCaptchaSolver();
}

export async function takeCaptchaToken(cfg: CaptchaConfig): Promise<string> {
  if (!cfg.enabled || !cfg.prefix || !cfg.sceneId) {
    throw new Error("Captcha config unavailable from ZCode API");
  }
  return pool.takeToken(cfg);
}

export function startCaptchaPoolRefill(cfg: CaptchaConfig): void {
  if (!cfg.enabled || !cfg.prefix || !cfg.sceneId) return;
  pool.startBackgroundRefill(cfg);
}

export async function prefillCaptchaPool(cfg: CaptchaConfig, count?: number): Promise<void> {
  if (!cfg.enabled || !cfg.prefix || !cfg.sceneId) return;
  await pool.prefill(cfg, count);
}

export function urgentCaptchaRefill(): void {
  pool.requestUrgentRefill();
}
