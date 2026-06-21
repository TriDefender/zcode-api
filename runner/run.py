#!/usr/bin/env python3
"""
Headed browser runner: create Z.AI accounts and link them into zcode-proxy.

Per account:
  1. Fresh Chromium profile
  2. Sign up on Z.AI (Resend inbox for verification link/code)
  3. Manual captcha #1 (notify-send)
  4. Open proxy OAuth authorize URL
  5. Manual captcha #2 + login if needed
  6. Wait for proxy onboard (quota buckets confirmed by onboard job — no quota-cache wait)
  7. Delete profile directory

Usage:
  cd runner && cp .env.example .env   # fill RESEND_API_KEY, EMAIL_DOMAIN, etc.
  pip install -r requirements.txt
  playwright install chromium

  python run.py --count 3
  python run_spawn.py --count 4   # 4 separate processes, unique zcodeN emails
  python run.py --count 1 --no-zcode   # skip launching ZCode for quota

Requires zcode-proxy running: bun run src/index.ts
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from pathlib import Path

from dotenv import load_dotenv

# runner/ as cwd
ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
load_dotenv(ROOT / ".env")

from lib.account_store import Account, account_at_index, next_account, record_failure, save_account
from lib.token_store import save_token_backup
from lib.browser import (  # noqa: E402
    delete_profile,
    launch_fresh_context,
    new_profile_dir,
)
from lib.proxy_api import pool_summary  # noqa: E402
from lib.zai_flow import link_account_via_proxy, signup_on_zai  # noqa: E402


def run_one(account: Account | None = None, *, advance_index: bool | None = None) -> dict:
    reserved = account is not None
    acct = account if reserved else next_account()
    should_advance = False if reserved else True
    if advance_index is not None:
        should_advance = advance_index
    creds = {
        "email": acct.email,
        "password": acct.password,
        "username": acct.username,
        "index": str(acct.index),
    }
    profile_dir = new_profile_dir()
    print(f"\n{'=' * 60}")
    print(f"Account: {creds['email']} (index {acct.index})")
    print(f"Username: {creds['username']}")
    print(f"Profile: {profile_dir}")
    print(f"{'=' * 60}\n")

    result: dict = {
        "ok": False,
        "email": creds["email"],
        "index": acct.index,
        "username": creds["username"],
        "profile": str(profile_dir),
    }
    pw = None
    stage = "init"

    try:
        pw, context = launch_fresh_context(profile_dir)
        page = context.pages[0] if context.pages else context.new_page()

        stage = "signup"
        signup_on_zai(page, creds)
        stage = "proxy_link"
        link = link_account_via_proxy(context, creds)

        result.update(
            {
                "ok": True,
                "proxy_link": link,
                "pool": pool_summary(),
            }
        )
        if not link.get("quota_ready"):
            raise RuntimeError("Account onboarded but quota buckets not ready")

        save_account(
            acct,
            extra={
                "proxy_user_id": link.get("account", {}).get("userId"),
                "proxy_account_id": link.get("account_id"),
                "job_id": link.get("job_id"),
                "quota_ready": True,
            },
            advance=should_advance,
        )
        save_token_backup(
            email=acct.email,
            password=acct.password,
            username=acct.username,
            index=acct.index,
            credential=link.get("credential"),
            account=link.get("account"),
            job=link.get("job"),
        )
        context.close()
        pw.stop()
        pw = None

    except Exception as exc:
        result["error"] = str(exc)
        result["traceback"] = traceback.format_exc()
        result["stage"] = stage
        print(f"FAILED at {stage}: {exc}")
        record_failure(acct, str(exc), stage=stage, advance=should_advance)
        if pw:
            try:
                pw.stop()
            except Exception:
                pass
    finally:
        delete_profile(profile_dir)
        print(f"Deleted profile {profile_dir}")

    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Z.AI account runner for zcode-proxy")
    parser.add_argument(
        "--count",
        type=int,
        default=int(os.environ.get("BATCH_COUNT", "1")),
        help="How many accounts to create (default: 1 or BATCH_COUNT env)",
    )
    parser.add_argument(
        "--account-index",
        type=int,
        metavar="N",
        help="Use reserved email index N (from run_spawn.py; does not re-claim index)",
    )
    parser.add_argument(
        "--headless",
        action="store_true",
        help="Run without visible browser (default: headed)",
    )
    parser.add_argument(
        "--no-zcode",
        action="store_true",
        help="Do not launch ZCode desktop during quota provisioning",
    )
    args = parser.parse_args()

    if args.headless:
        os.environ["HEADLESS"] = "true"
    else:
        os.environ["HEADLESS"] = "false"

    if args.no_zcode:
        os.environ["LAUNCH_ZCODE"] = "false"

    count = max(1, args.count)
    reserved_account: Account | None = None
    if args.account_index is not None:
        reserved_account = account_at_index(args.account_index)
        count = 1

    print(f"Z.AI runner — {count} account(s), headless={os.environ['HEADLESS']}")

    results = []
    ok = 0
    for i in range(count):
        if reserved_account:
            acct = reserved_account
            print(f"\n>>> Spawned run for {acct.email} (index {acct.index})")
        else:
            acct = None
            print(f"\n>>> Run {i + 1}/{count}")
        r = run_one(acct, advance_index=False if reserved_account else None)
        results.append(r)
        if r.get("ok"):
            ok += 1

    if args.account_index is not None:
        out = ROOT / "results" / f"spawn-{args.account_index}.json"
    else:
        out = ROOT / "results" / f"batch-{ok}-of-{count}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(f"\nFinished: {ok}/{count} succeeded")
    print(f"Results → {out}")
    return 0 if ok == count else 1


if __name__ == "__main__":
    sys.exit(main())
