# Z.AI account runner

Headed Playwright runner that creates Z.AI accounts and links them into **zcode-proxy**.

## Prerequisites

1. **zcode-proxy** running locally:

   ```bash
   cd .. && bun run src/index.ts
   ```

2. **Resend** inbound domain configured (`RESEND_API_KEY`, `EMAIL_DOMAIN`).

3. **Chromium** for Playwright:

   ```bash
   pip install -r requirements.txt
   playwright install chromium
   ```

## Setup

```bash
cd runner
cp .env.example .env
# Edit .env — RESEND_API_KEY, EMAIL_DOMAIN, ACCOUNT_PASSWORD
```

## Run

```bash
python run.py --count 3
python run_spawn.py --count 4   # 4 browsers, staggered 5–10s apart, unique zcodeN@
```

Each account:


1. Fresh Chromium profile (`profiles/run-*`)
2. Sign up on Z.AI → verification email via Resend API
3. **Captcha #1** — `notify-send "please do the captcha"`, then press Enter
4. Open proxy dashboard → **Sign in with Z.AI** → OAuth tab
5. **Captcha #2** — same notification + Enter
6. Login + authorize → proxy polls OAuth and provisions quota
7. Profile directory deleted

## Account naming

Emails auto-increment: `zcode1@codexin.lol`, `zcode2@...` (configurable via `EMAIL_PREFIX`, `EMAIL_START_INDEX`).

| Env | Default |
|-----|---------|
| `EMAIL_PREFIX` | `zcode` |
| `EMAIL_DOMAIN` | `codexin.lol` |
| `ACCOUNT_PASSWORD` | `Zcode@123` |
| `ACCOUNT_USERNAME` | `Zcode` |

Successful accounts append to `state/accounts.jsonl`. **JWTs** are backed up separately to `state/tokens.jsonl` (email, password, jwt, pool id). Failures go to `state/failed.jsonl`.

After OAuth, the runner waits for the proxy **onboard job** to finish (polls every 5s by default). When the job reports `quotaReady`, it continues immediately — it does **not** wait for the dashboard quota cache refresh cycle.

## Options

| Flag | Description |
|------|-------------|
| `--count N` | Accounts to create (default: `1` or `BATCH_COUNT`) |
| `run_spawn.py --count N` | N separate `run.py` processes, unique reserved emails |
| `--headless` | Headless browser (default: **headed**) |
| `--no-zcode` | Skip launching ZCode desktop during quota provisioning |

## Env tuning

- `SIGNUP_URL`, `SIGNUP_*_SELECTOR` — if Z.AI signup UI changes
- `ONBOARD_POLL_SEC` — seconds between onboard status polls (default 5)
- `QUOTA_POLL_SEC` — only used if onboard finishes without `quotaReady` (fallback quota-cache poll; default 8)
- `USE_DASHBOARD_SIGNIN=false` — use admin API + direct authorize URL instead of dashboard button
- `CAPTCHA_NOTIFY_MSG` — desktop notification text (default: `please do the captcha`)

Results are written to `results/batch-{ok}-of-{count}.json`.
