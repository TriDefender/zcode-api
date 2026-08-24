import { describe, expect, it } from "bun:test";
import { CaptchaCpuGovernor } from "./captcha-cpu-governor.js";

function makeGovernor(overrides: Partial<ConstructorParameters<typeof CaptchaCpuGovernor>[0]> = {}) {
  return new CaptchaCpuGovernor({
    cpuLimitPercent: 100,
    hysteresisPercent: 5,
    poolSizeMin: 40,
    poolSizeMax: 120,
    maxSolveConcurrency: 4,
    intervalMs: 3_000,
    ...overrides,
  });
}

describe("CaptchaCpuGovernor", () => {
  it("keeps background concurrency at 0 when warm and CPU is at limit", () => {
    const gov = makeGovernor();
    (gov as unknown as { lastCpuPercent: number }).lastCpuPercent = 100;
    (gov as unknown as { concurrency: number }).concurrency = 2;

    expect(gov.backgroundConcurrency(40)).toBe(0);
    expect(gov.backgroundConcurrency(50)).toBe(0);
  });

  it("allows at least 1 background solve when below pool minimum", () => {
    const gov = makeGovernor();
    (gov as unknown as { lastCpuPercent: number }).lastCpuPercent = 95;
    (gov as unknown as { concurrency: number }).concurrency = 0;

    expect(gov.backgroundConcurrency(39)).toBe(1);
    expect(gov.backgroundConcurrency(10)).toBe(1);
  });

  it("ramps concurrency and target when CPU is low", async () => {
    const gov = makeGovernor();
    const sample = gov as unknown as {
      sampleCpuPercent: () => Promise<number>;
      tick: () => Promise<void>;
    };

    sample.sampleCpuPercent = async () => 30;
    await sample.tick();

    const snap = gov.snapshot();
    expect(snap.concurrency).toBeGreaterThan(1);
    expect(snap.maxEffectiveTarget).toBeGreaterThan(40);
    expect(snap.throttled).toBe(false);
  });

  it("throttles toward pool minimum when CPU is high", async () => {
    const gov = makeGovernor();
    const sample = gov as unknown as {
      sampleCpuPercent: () => Promise<number>;
      tick: () => Promise<void>;
    };

    sample.sampleCpuPercent = async () => 98;
    await sample.tick();

    const snap = gov.snapshot();
    expect(snap.maxEffectiveTarget).toBe(40);
    expect(snap.throttled).toBe(true);
  });

  it("soft-throttles to 1 worker near the limit", () => {
    const gov = makeGovernor();
    (gov as unknown as { lastCpuPercent: number }).lastCpuPercent = 97;
    (gov as unknown as { concurrency: number }).concurrency = 3;

    expect(gov.backgroundConcurrency(50)).toBe(1);
  });

  it("is disabled when cpuLimitPercent is 0", () => {
    const gov = makeGovernor({ cpuLimitPercent: 0 });
    expect(gov.enabled).toBe(false);
    expect(gov.backgroundConcurrency(100)).toBe(4);
  });
});
