#!/usr/bin/env python3
"""
Spawn N independent run.py processes — one headed browser each, unique account numbers.

Reserves zcodeN..zcodeN+count-1 upfront (file-locked), then starts one subprocess
per account. Each child runs the normal sequential flow; no threads, no shared state.

  cd runner && python run_spawn.py --count 4
  python run_spawn.py --count 4 --no-zcode
  python run_spawn.py --count 4 --detach   # fire-and-forget

Requires zcode-proxy running: bun run src/index.ts
"""

from __future__ import annotations

import argparse
import json
import os
import random
import subprocess
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
load_dotenv(ROOT / ".env")

from lib.account_store import reserve_accounts  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Spawn parallel run.py workers with unique reserved account numbers",
    )
    parser.add_argument(
        "--count",
        type=int,
        default=int(os.environ.get("SPAWN_COUNT", "1")),
        help="How many browser processes to start (default: 1 or SPAWN_COUNT env)",
    )
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--no-zcode", action="store_true")
    parser.add_argument(
        "--detach",
        action="store_true",
        help="Start processes and exit without waiting",
    )
    parser.add_argument(
        "--stagger-min",
        type=float,
        default=float(os.environ.get("SPAWN_STAGGER_MIN_SEC", "5")),
        help="Min seconds between starting each runner (default: 5)",
    )
    parser.add_argument(
        "--stagger-max",
        type=float,
        default=float(os.environ.get("SPAWN_STAGGER_MAX_SEC", "10")),
        help="Max seconds between starting each runner (default: 10)",
    )
    args = parser.parse_args()

    count = max(1, args.count)
    stagger_min = max(0.0, args.stagger_min)
    stagger_max = max(stagger_min, args.stagger_max)
    accounts = reserve_accounts(count)

    print(f"Spawn runner — {count} process(es), indices {accounts[0].index}–{accounts[-1].index}")
    if count > 1 and stagger_max > 0:
        print(f"  stagger {stagger_min:.0f}–{stagger_max:.0f}s between each start")
    for acct in accounts:
        print(f"  reserved {acct.email}")

    run_py = ROOT / "run.py"
    children: list[tuple[object, subprocess.Popen]] = []

    for i, acct in enumerate(accounts):
        if i > 0 and stagger_max > 0:
            delay = random.uniform(stagger_min, stagger_max)
            print(f"  waiting {delay:.1f}s before next runner …")
            time.sleep(delay)

        cmd = [
            sys.executable,
            str(run_py),
            "--account-index",
            str(acct.index),
            "--count",
            "1",
        ]
        if args.headless:
            cmd.append("--headless")
        if args.no_zcode:
            cmd.append("--no-zcode")

        proc = subprocess.Popen(cmd, cwd=ROOT)
        children.append((acct, proc))
        print(f"  PID {proc.pid} → {acct.email}")

    if args.detach:
        print("\nDetached — children running independently.")
        return 0

    print("\nWaiting for all processes …")
    results: list[dict] = []
    ok = 0
    for acct, proc in children:
        code = proc.wait()
        result_path = ROOT / "results" / f"spawn-{acct.index}.json"
        if result_path.exists():
            results.append(json.loads(result_path.read_text(encoding="utf-8")))
        if code == 0:
            ok += 1
            print(f"  ✓ {acct.email} (exit {code})")
        else:
            print(f"  ✗ {acct.email} (exit {code})")

    summary = ROOT / "results" / f"spawn-{ok}-of-{count}.json"
    summary.parent.mkdir(parents=True, exist_ok=True)
    summary.write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(f"\nFinished: {ok}/{count} succeeded")
    print(f"Summary → {summary}")
    return 0 if ok == count else 1


if __name__ == "__main__":
    sys.exit(main())
