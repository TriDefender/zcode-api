import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  __resetCaptchaWorkerDispatchForTest,
  __setInProcessSolverForTest,
  resolveWorkerEntryCandidates,
  solveViaWorkerOrInProcess,
  stopCaptchaWorkers,
} from "./captcha-worker-dispatch.js";

// The dispatch layer must degrade, not fail, when the worker path is
// unusable. Worker mode is exercised with a REAL worker_threads round trip
// against a canned fixture entry (no happy-dom, no network); the fallback
// cases substitute the in-process solver through the test seam. Neither
// captcha-solver.js nor captcha-happy.js is module-mocked here: those mocks
// are process-wide in Bun and leak partial export surfaces into later test
// files (order-dependent across platforms).
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "cap-worker-"));
const fixturePath = path.join(fixtureDir, "fixture-worker.mjs");
fs.writeFileSync(
  fixturePath,
  [
    'import { parentPort } from "node:worker_threads";',
    "if (!parentPort) throw new Error('fixture requires parent port');",
    "parentPort.on('message', (m) => {",
    "  parentPort.postMessage({ id: m.id, ok: true, param: `fixture-param:${m.scene}:${m.region}` });",
    "});",
  ].join("\n"),
  "utf8",
);

describe("captcha worker dispatch (worker / in-process)", () => {
  // NOTE: fixtureDir outlives this describe — later describes reuse
  // fixturePath for the env-resolution test; cleanup is file-level below.
  afterAll(() => {
    __setInProcessSolverForTest(null);
  });

  test("solves via a real worker when the entry asset resolves", async () => {
    mock.module("./captcha-worker-asset.js", () => ({ default: fixturePath }));
    __resetCaptchaWorkerDispatchForTest();
    const param = await solveViaWorkerOrInProcess({ scene: "sc1", region: "rg1", prefix: "pf1" });
    expect(param).toBe("fixture-param:sc1:rg1");
  });

  test("falls back to in-process solving when the entry is unavailable", async () => {
    mock.module("./captcha-worker-asset.js", () => ({ default: null }));
    __setInProcessSolverForTest(
      async (opts) => `inproc-param:${opts.scene}`,
    );
    __resetCaptchaWorkerDispatchForTest();
    const param = await solveViaWorkerOrInProcess({ scene: "sc2", region: "rg2", prefix: "pf2" });
    expect(param).toBe("inproc-param:sc2");
  });

  test("an unloadable worker entry degrades to in-process solving", async () => {
    // A path that cannot be loaded as a worker module (a directory) surfaces
    // as an async module-not-found 'error' — it must fall back, not reject.
    mock.module("./captcha-worker-asset.js", () => ({ default: fixtureDir }));
    __setInProcessSolverForTest(
      async (opts) => `inproc-param:${opts.scene}`,
    );
    __resetCaptchaWorkerDispatchForTest();
    const param = await solveViaWorkerOrInProcess({ scene: "sc3", region: "rg3", prefix: "pf3" });
    expect(param).toBe("inproc-param:sc3");
  });
});

describe("resolveWorkerEntryCandidates (pure)", () => {
  test("env path first, then the bundle sibling; whitespace-only env is ignored", () => {
    expect(
      resolveWorkerEntryCandidates({ envPath: "/data/files/worker.cjs", bundleDir: "/data/files/bundle" }),
    ).toEqual(["/data/files/worker.cjs", path.join("/data/files/bundle", "captcha-worker-entry.cjs")]);
    expect(resolveWorkerEntryCandidates({ bundleDir: "/b" })).toEqual([
      path.join("/b", "captcha-worker-entry.cjs"),
    ]);
    expect(resolveWorkerEntryCandidates({ envPath: "   " })).toEqual([]);
    expect(resolveWorkerEntryCandidates({ bundleDir: null })).toEqual([]);
    expect(resolveWorkerEntryCandidates({})).toEqual([]);
  });
});

describe("entry resolution & strict mode", () => {
  const saved = {
    worker: process.env.ZCODE_CAPTCHA_WORKER,
    strict: process.env.ZCODE_CAPTCHA_REQUIRE_WORKER,
  };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v as string;
    }
    __setInProcessSolverForTest(null);
    __resetCaptchaWorkerDispatchForTest();
  });

  test("ZCODE_CAPTCHA_WORKER wins over the bundled asset", async () => {
    process.env.ZCODE_CAPTCHA_WORKER = fixturePath;
    mock.module("./captcha-worker-asset.js", () => ({ default: null }));
    __resetCaptchaWorkerDispatchForTest();
    const param = await solveViaWorkerOrInProcess({ scene: "env", region: "rg", prefix: "pf" });
    expect(param).toBe("fixture-param:env:rg");
  });

  test("strict mode fails hard when no entry resolves — the in-process solver must stay untouched", async () => {
    delete process.env.ZCODE_CAPTCHA_WORKER;
    process.env.ZCODE_CAPTCHA_REQUIRE_WORKER = "1";
    mock.module("./captcha-worker-asset.js", () => ({ default: null }));
    let inprocCalls = 0;
    __setInProcessSolverForTest(async () => {
      inprocCalls += 1;
      return "must-not-happen";
    });
    __resetCaptchaWorkerDispatchForTest();
    let err: unknown = null;
    try {
      await solveViaWorkerOrInProcess({ scene: "s", region: "r", prefix: "p" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("no in-process fallback");
    expect(inprocCalls).toBe(0);
  });
});

describe("warm worker pool", () => {
  const saved = {
    warm: process.env.ZCODE_CAPTCHA_WARM_WORKERS,
    worker: process.env.ZCODE_CAPTCHA_WORKER,
  };
  const warmDir = fs.mkdtempSync(path.join(os.tmpdir(), "cap-warm-"));
  const markerPath = path.join(warmDir, "spawns.txt");
  const warmFixture = path.join(warmDir, "warm-worker.mjs");
  fs.writeFileSync(
    warmFixture,
    [
      'import { parentPort } from "node:worker_threads";',
      'import { appendFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(markerPath)}, "spawn\\n");`,
      "if (!parentPort) throw new Error('warm fixture requires parent port');",
      "parentPort.on('message', (m) => {",
      "  parentPort.postMessage({ id: m.id, ok: true, param: `warm:${m.scene}` });",
      "});",
    ].join("\n"),
    "utf8",
  );
  const spawnCount = (): number =>
    fs.existsSync(markerPath)
      ? fs.readFileSync(markerPath, "utf8").split("\n").filter((l) => l === "spawn").length
      : 0;

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v as string;
    }
    stopCaptchaWorkers();
  });
  afterAll(() => {
    try { fs.rmSync(warmDir, { recursive: true, force: true }); } catch {}
  });

  test("reuses one persistent worker across solves; stopCaptchaWorkers forces a respawn", async () => {
    process.env.ZCODE_CAPTCHA_WORKER = warmFixture;
    process.env.ZCODE_CAPTCHA_WARM_WORKERS = "1";
    mock.module("./captcha-worker-asset.js", () => ({ default: null }));
    __resetCaptchaWorkerDispatchForTest();

    const a = await solveViaWorkerOrInProcess({ scene: "w1", region: "r", prefix: "p" });
    const b = await solveViaWorkerOrInProcess({ scene: "w2", region: "r", prefix: "p" });
    expect(a).toBe("warm:w1");
    expect(b).toBe("warm:w2");
    // Both solves were served by the SAME persistent worker.
    expect(spawnCount()).toBe(1);

    stopCaptchaWorkers();
    const c = await solveViaWorkerOrInProcess({ scene: "w3", region: "r", prefix: "p" });
    expect(c).toBe("warm:w3");
    // The pool was emptied -> the next solve had to spawn a fresh worker.
    expect(spawnCount()).toBe(2);
  });
});

// File-level cleanup: runs after every describe above, so shared fixtures
// stay alive for the whole file.
afterAll(() => {
  __setInProcessSolverForTest(null);
  stopCaptchaWorkers();
  try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch {}
});
