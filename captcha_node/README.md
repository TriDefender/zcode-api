# captcha_node — solver backends & benchmarks

Aliyun NoCaptcha (traceless) solvers for the start-plan flow. The proxy (`src/proxy/captcha*.ts`)
drives these via `daemon.js`/`worker.js`; pick a backend with `ZCODE_CAPTCHA_BACKEND`.

## Backends

| Backend | `ZCODE_CAPTCHA_BACKEND` | Status | Use when |
|---|---|---|---|
| happy-dom | `happy` (or unset — see note) | **production-proven** | default choice |
| jsdom | `jsdom` (current code default) | working but slower; F001-prone on some IPs | local testing only |
| playwright | `playwright` | working; heaviest | last-resort compatibility |
| headless VM | `headless_solve.js` | **WIP — does not complete** | research only, see below |

> **Note:** the fallback in code is `process.env.ZCODE_CAPTCHA_BACKEND || "jsdom"` in
> `worker.js` / `solver.js` / `captcha-jsdom.ts`. For production use, set `happy`
> explicitly.

## Benchmarks (measured 2026-08-22, this machine + IP)

Single token = one traceless solve. CPU = `process.cpuUsage` delta, RSS via `/proc`.
Network conditions and pe-roll luck vary run-to-run (~40-60% of pe versions stall and need
a retry; retry cost is included in the averages).

### Backend comparison (fresh window per solve)

| Backend | Wall time | CPU | Notes |
|---|---|---|---|
| happy-dom | ~1.5–3.0s | **~815ms** avg (426–1235 range) | 20/30 solve-rate here; `happy` lib ~1.8k lines, no browser needed |
| jsdom | — | ~1.6s+ | 100% "degraded result (76 chars)" from this IP during these tests; historically works |
| playwright | — | higher (Chromium launch per solve) | not re-benchmarked this session |
| headless VM | n/a (boots in **68ms/74ms CPU**) | n/a | SDK executes fully but the pe bytecode VM entry never starts — see WIP section |

### happy-dom window reuse (`CAPTCHA_WINDOW_REUSE=1`)

Reuses one happy-dom window across solves instead of booting a fresh DOM per token
(implemented in `solve-happy-lib.js`, opt-in).

| Metric | Fresh window (old) | Window reuse | Delta |
|---|---|---|---|
| CPU per solve (warm) | ~815–878ms | **~260–330ms** | **~2.5–3x less** |
| Wall per solve (warm) | ~1.5–3.0s | **~0.5–0.7s** | ~2.5–4x faster |
| Success rate (8-solve A/B) | 2/8 | 7/8 | fewer wasted retries |
| Steady-state RSS (30 solves) | **~429MB avg** (320–503) | ~813MB avg (484–968) | **~1.9x more memory** |

Knobs (also settable per-call via `solveTraceless({reuseWindow:true})`):

`ZCODE_CAPTCHA_BACKEND=happy node solver.js <scene> <region> <prefix>  # one-shot solve via any backend`

On failure/stall the pooled window is destroyed and the retry boots a fresh one
(a fresh InitCaptchaV3 rolls a new pe version anyway).

**Tuning rule of thumb:**
- CPU-bound box → `CAPTCHA_WINDOW_REUSE=1` + `ZCODE_CAPTCHA_WORKER_MAX_RSS_MB=1100`
  (budget ~1GB per captcha worker; the 350MB default would recycle workers every solve
  and negate the win).
- Memory-bound box → leave reuse off; behavior is byte-identical to the old path.
- `CAPTCHA_REUSE_MAX_SOLVES=10` was tested and is *worse* (avg 860MB, peak 1161MB):
  frequent re-boots churn more than they free.

### Cost profile of one happy solve (where the CPU goes)

| Phase | Wall | CPU |
|---|---|---|
| DOM boot + SDK load + init RTT | 0–1.9s | ~800ms |
| pe bytecode VM (W mint) | 1.9–2.6s | ~770ms |
| Burst (Log3/Upload/Log2/Verify) + verify | 2.6–3.1s | ~30ms |

Window reuse amortizes the first phase; the pe-VM phase is irreducible without the
headless-VM path below.

## Which backend should an agent use?

1. **Production / serving inference: `happy` + window reuse** (with the raised RSS cap).
   It is the only configuration validated end-to-end through the proxy's inference path
   (identity headers + system prompt → HTTP 200).
2. **Local dev / minimal deps: `jsdom`.** Keep the old default for local work — it needs
   no Playwright/Chromium and still solves on residential IPs. (It 100% failed from this
   datacenter IP during benchmarking — "degraded result" — while happy passed 2/3, so
   happy is also more IP-tolerant.)
3. **Debugging DOM behavior: `playwright`.**
4. **Do not build on the pure-HTTP native solver** — server-side validation makes it
   infeasible (see findings below).

## Protocol findings (for future work; proven via a live field-mutation harness)

The current wire protocol (verified against live passing sessions):

```
InitCaptchaV3 -> (cert + DeviceConfig: tokenKey, mid, ip)
  ~60ms crypto window
Log3, UploadLog, Log2 (fired within ~2ms of each other, to three different hosts)
VerifyCaptchaV3 (~1-3ms after Log2)
NO Log1. Log2 host is now ap-southeast-1.device.saf.aliyuncs.com
(the old cloudauth Log2 host is only used by Log3)
```

Mutation-test results (each value = pass-rate of 3 live trials):

| Artifact | Mutated to | Result |
|---|---|---|
| Log2 W fields [43]/[21]/[72]/[74] | random/synthetic | **pass 3/3** (server does not validate Log2's W) |
| verify `data` blob | fully synthetic (own h2d cipher + deflate) | **pass 3/3** (construction is reproducible) |
| UploadLog claims, Log3 track | random/emptied | **pass 3/3** |
| token W — any field ([43],[72],[74],[21],[32],[78], 93/94 tail) | changed | **fail 3/3 (F001)** |
| token W = SDK's Log2 W + `\|93-NaN\|94-NaN` | synced pair | **pass 3/3** |
| synthetic W pair (stamps changed consistently everywhere) | — | **fail** — the W contains VM-computed values with no offline derivation |

Conclusion: pure-HTTP minting is blocked by design — the token W is bound to values the pe
bytecode VM computes (`INIT_MD5_SECRET_SALT` never even fires during traceless). The VM
must execute. `native_solve.js` / `native_solve2.js` are kept as protocol documentation
only.

The token's `#0#<trailing>` field is currently the literal string `daye,raolewoba!` —
not a hash (contrary to old comments in `native_solve.js`).

## Headless VM solver (WIP — `headless_solve.js`)

Goal: run the real SDK in a bare `node:vm` with a hand-built DOM shim (~70ms boot vs
happy-dom's ~1.9s → potential ~10x CPU cut) and zero captured constants (fully
rotation-resistant: new pe/feilin versions are fetched from CDN automatically).

Progress: loader, feilin and pe all execute cleanly; the loader's iframe mount runs; no
errors surface anywhere (instrumented catches: 0). Blocker: the pe's generator-based
bytecode interpreter never starts pumping (0 dispatches), and no SDK globals
(`__AYF`, `detectIncognito`, …) ever get registered. Eliminated causes: element
`instanceof` validation, iframe `contentWindow` (was a real loader crash — fixed),
`setImmediate`/`MessageChannel` (fixed), font-fingerprint probe (offsetWidth now varies
per `style.fontFamily`), `postMessage`, canvas 2D, `document.write`, all missing globals.

Next lead: instrument happy-dom's **sync** interceptor (`beforeSyncRequest` pe branch) to
log when `__AYF`/`initAliyunCaptcha` appear, then diff what pumps the generator.


## Benchmarking scripts

The A/B numbers above come from scripts of the shape kept in this repo history:

```bash
cd captcha_node
# CPU/wall A/B
CAPTCHA_WINDOW_REUSE=1 node -e '...'   # 8 solves, measure cpuUsage/rss per solve
# steady-state RSS (30 solves, sample per solve)
node /tmp/mem_avg.js  # re-create from the transcript of this session if needed
# per-backend latency
node scripts/bench-captcha-worker.mjs happy 5
```

When re-benchmarking, always run both sides in the same hour — stall rates drift with
pe rotations and IP reputation.
