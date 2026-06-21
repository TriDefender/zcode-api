"""Sequential accounts: zcode1@codexin.lol, zcode2@..., persisted to state/."""

from __future__ import annotations

import fcntl
import json
import os
import threading
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

STATE_DIR = Path(os.environ.get("STATE_DIR", "state"))
INDEX_FILE = STATE_DIR / "email_index.json"
ACCOUNTS_FILE = STATE_DIR / "accounts.jsonl"
FAILED_FILE = STATE_DIR / "failed.jsonl"
INDEX_LOCK_FILE = STATE_DIR / ".index.lock"
_WRITE_LOCK = threading.Lock()


@contextmanager
def _index_lock():
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    with INDEX_LOCK_FILE.open("a+", encoding="utf-8") as fh:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


@dataclass
class Account:
    email: str
    index: int
    password: str
    username: str


def _account_defaults() -> tuple[str, str, str, str]:
    prefix = os.environ.get("EMAIL_PREFIX", "zcode")
    domain = os.environ.get("EMAIL_DOMAIN", "codexin.lol")
    if "@" in domain:
        domain = domain.split("@")[-1]
    password = os.environ.get("ACCOUNT_PASSWORD", "Zcode@123")
    username = os.environ.get("ACCOUNT_USERNAME", "Zcode")
    return prefix, domain, password, username


def _load_next_index() -> int:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    if not INDEX_FILE.exists():
        return int(os.environ.get("EMAIL_START_INDEX", "1"))
    data = json.loads(INDEX_FILE.read_text(encoding="utf-8"))
    return int(data["next_index"])


def _save_next_index(next_index: int) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    INDEX_FILE.write_text(json.dumps({"next_index": next_index}, indent=2) + "\n", encoding="utf-8")


def account_at_index(index: int) -> Account:
    prefix, domain, password, username = _account_defaults()
    email = f"{prefix}{index}@{domain}"
    return Account(email=email, index=index, password=password, username=username)


def reserve_accounts(count: int) -> list[Account]:
    """Reserve `count` sequential emails and advance the index upfront (parallel-safe)."""
    count = max(1, count)
    with _index_lock():
        start = _load_next_index()
        _save_next_index(start + count)
    return [account_at_index(start + i) for i in range(count)]


def next_account() -> Account:
    with _index_lock():
        index = _load_next_index()
    return account_at_index(index)


def advance_index() -> None:
    with _index_lock():
        _save_next_index(_load_next_index() + 1)


def save_account(account: Account, *, extra: dict | None = None, advance: bool = True) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    entry = {
        **asdict(account),
        "saved_at": datetime.now(timezone.utc).isoformat(),
        **(extra or {}),
    }
    with _WRITE_LOCK:
        with ACCOUNTS_FILE.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
    if advance:
        advance_index()
    print(f"Saved account → {ACCOUNTS_FILE} ({account.email})")


def record_failure(
    account: Account,
    reason: str,
    *,
    stage: str,
    advance: bool = True,
) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    entry = {
        **asdict(account),
        "reason": reason,
        "stage": stage,
        "failed_at": datetime.now(timezone.utc).isoformat(),
    }
    with _WRITE_LOCK:
        with FAILED_FILE.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
    if advance:
        advance_index()
    print(f"Failed account logged → {FAILED_FILE} ({account.email})")
