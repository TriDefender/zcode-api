"""Backup Start Plan JWTs from the proxy pool — separate from accounts.jsonl metadata."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

STATE_DIR = Path(os.environ.get("STATE_DIR", "state"))
TOKENS_FILE = STATE_DIR / "tokens.jsonl"


def save_token_backup(
    *,
    email: str,
    password: str,
    username: str,
    index: int,
    credential: dict[str, Any] | None,
    account: dict[str, Any] | None,
    job: dict[str, Any] | None,
) -> None:
    """Append JWT + pool metadata to state/tokens.jsonl (gitignored)."""
    STATE_DIR.mkdir(parents=True, exist_ok=True)

    entry: dict[str, Any] = {
        "email": email,
        "password": password,
        "username": username,
        "index": index,
        "saved_at": datetime.now(timezone.utc).isoformat(),
        "proxy_account_id": (credential or {}).get("id") or (account or {}).get("id"),
        "user_id": (credential or {}).get("userId") or (account or {}).get("userId"),
        "jwt": (credential or {}).get("jwt"),
        "provider": (credential or {}).get("provider"),
        "status": (credential or {}).get("status") or (account or {}).get("status"),
        "quota_ready": bool((job or {}).get("quotaReady") or (account or {}).get("balances")),
        "balance_count": (job or {}).get("balanceCount") or len((account or {}).get("balances") or []),
        "balances": (account or {}).get("balances"),
        "onboard_job_id": (job or {}).get("id"),
    }

    with TOKENS_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")

    if entry.get("jwt"):
        print(f"JWT backup → {TOKENS_FILE} ({email})")
    else:
        print(f"warning: no JWT in backup for {email} — check proxy pool")
