#!/usr/bin/env python3
"""
Provision quota for pool accounts that were added but have no billing buckets.

Uses live /admin/accounts/{id}/balance (not cache) and POST .../provision
with gentle delays between accounts.

  cd runner && .venv/bin/python onboard_existing.py
  .venv/bin/python onboard_existing.py --dry-run
  .venv/bin/python onboard_existing.py --ids e42a7c68c93f,27e07e475b2a
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
load_dotenv(ROOT / ".env")

import requests

from lib.token_store import save_token_backup

PROXY_URL = os.environ.get("PROXY_URL", "http://127.0.0.1:8080").rstrip("/")
GAP_SEC = float(os.environ.get("PROVISION_GAP_SEC", "10"))
BALANCE_POLL_SEC = float(os.environ.get("PROVISION_BALANCE_POLL_SEC", "5"))
STATE_DIR = Path(os.environ.get("STATE_DIR", "state"))
ACCOUNTS_FILE = STATE_DIR / "accounts.jsonl"


def api(method: str, path: str, **kwargs) -> dict:
    url = f"{PROXY_URL}{path}"
    resp = requests.request(method, url, timeout=120, **kwargs)
    resp.raise_for_status()
    return resp.json() if resp.text else {}


def live_balance(account_id: str) -> dict:
    return api("GET", f"/admin/accounts/{account_id}/balance")


def needs_provision(account_id: str) -> tuple[bool, dict]:
    bal = live_balance(account_id)
    buckets = bal.get("balances") or []
    return len(buckets) == 0, bal


def provision_account(account_id: str, *, launch_desktop: bool) -> dict:
    return api(
        "POST",
        f"/admin/accounts/{account_id}/provision",
        json={"launchDesktop": launch_desktop},
    )


def load_runner_accounts() -> list[dict]:
    if not ACCOUNTS_FILE.exists():
        return []
    rows = []
    for line in ACCOUNTS_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            rows.append(json.loads(line))
    return rows


def backfill_token(email_row: dict, cred: dict, bal: dict) -> None:
    save_token_backup(
        email=email_row.get("email", ""),
        password=email_row.get("password", ""),
        username=email_row.get("username", "Zcode"),
        index=int(email_row.get("index", 0)),
        credential=cred,
        account={"id": cred.get("id"), "userId": cred.get("userId"), "balances": bal.get("balances")},
        job={"quotaReady": bool(bal.get("balances"))},
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Provision existing pool accounts missing quota")
    parser.add_argument("--dry-run", action="store_true", help="Only list accounts needing provision")
    parser.add_argument("--ids", help="Comma-separated pool account ids (default: all in pool)")
    parser.add_argument("--no-zcode", action="store_true", help="Skip launching ZCode desktop")
    parser.add_argument("--backfill-tokens", action="store_true", help="Also write tokens.jsonl for all with JWT")
    args = parser.parse_args()

    pool = api("GET", "/admin/accounts")
    accounts = pool.get("accounts") or []
    if args.ids:
        wanted = {x.strip() for x in args.ids.split(",") if x.strip()}
        accounts = [a for a in accounts if a["id"] in wanted]

    print(f"Checking {len(accounts)} pool account(s)…\n")
    pending: list[tuple[dict, dict]] = []

    for acct in accounts:
        aid = acct["id"]
        time.sleep(BALANCE_POLL_SEC)
        need, bal = needs_provision(aid)
        buckets = len(bal.get("balances") or [])
        label = acct.get("userId") or acct.get("name") or aid
        if need:
            print(f"  NEED  {aid}  {label}  (0 buckets)")
            pending.append((acct, bal))
        else:
            print(f"  OK    {aid}  {label}  ({buckets} buckets)")

    if not pending:
        print("\nAll accounts already have quota buckets.")
        if args.backfill_tokens:
            _backfill_all(accounts)
        return 0

    print(f"\n{len(pending)} account(s) need provisioning.\n")
    if args.dry_run:
        return 0

    ok = 0
    for i, (acct, _) in enumerate(pending):
        aid = acct["id"]
        print(f"[{i + 1}/{len(pending)}] Provisioning {aid} ({acct.get('userId', '?')})…")
        try:
            result = provision_account(aid, launch_desktop=not args.no_zcode)
            if result.get("quotaReady"):
                print(f"  ✓ quota ready ({result.get('balanceCount')} buckets)")
                ok += 1
            else:
                print("  ⚠ provision finished but buckets still empty")
        except Exception as exc:
            print(f"  ✗ failed: {exc}")
        if i < len(pending) - 1:
            print(f"  waiting {GAP_SEC:.0f}s before next account…")
            time.sleep(GAP_SEC)

    print(f"\nProvisioned {ok}/{len(pending)}")
    if args.backfill_tokens or ok:
        _backfill_all(accounts)
    return 0 if ok == len(pending) else 1


def _backfill_all(accounts: list[dict]) -> None:
    rows = {r.get("proxy_user_id"): r for r in load_runner_accounts()}
    print("\nBackfilling tokens.jsonl…")
    for acct in accounts:
        aid = acct["id"]
        try:
            cred = api("GET", f"/admin/accounts/{aid}/credential")
            time.sleep(BALANCE_POLL_SEC)
            bal = live_balance(aid)
            row = rows.get(cred.get("userId")) or {
                "email": f"pool-{aid}@local",
                "password": "",
                "username": "Zcode",
                "index": 0,
            }
            backfill_token(row, cred, bal)
        except Exception as exc:
            print(f"  skip {aid}: {exc}")


if __name__ == "__main__":
    sys.exit(main())
