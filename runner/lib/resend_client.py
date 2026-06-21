"""Resend inbound email: poll API, extract verification codes and links."""

from __future__ import annotations

import os
import re
import time
from typing import Any
from urllib.parse import unquote

import requests

RESEND_API_KEY = os.environ.get("RESEND_API_KEY", "")
POLL_INTERVAL_SEC = float(os.environ.get("RESEND_POLL_INTERVAL_SEC", "3"))
POLL_TIMEOUT_SEC = float(os.environ.get("RESEND_POLL_TIMEOUT_SEC", "180"))

CODE_PATTERNS = [
    r"verification code[\s\S]{0,120}?(\d{6})",
    r"验证码[\s\S]{0,80}?(\d{6})",
    r">\s*(\d{6})\s*<",
    r"(?<![#A-Za-z0-9])(\d{6})(?![A-Za-z0-9])",
]

LINK_PATTERNS = [
    r'href=["\'](https://[^"\']+(?:verify|confirm|activate|magic|oauth)[^"\']*)["\']',
    r'(https://chat\.z\.ai[^\s"\'<>]+)',
    r'(https://z\.ai[^\s"\'<>]+)',
    r'(https://zcode\.z\.ai[^\s"\'<>]+)',
]


def _headers() -> dict[str, str]:
    if not RESEND_API_KEY:
        raise RuntimeError("RESEND_API_KEY is not set")
    return {"Authorization": f"Bearer {RESEND_API_KEY}"}


def list_received(limit: int = 20) -> list[dict[str, Any]]:
    response = requests.get(
        "https://api.resend.com/emails/receiving",
        headers=_headers(),
        params={"limit": limit},
        timeout=30,
    )
    response.raise_for_status()
    payload = response.json()
    return payload.get("data") or payload.get("emails") or []


def fetch_received(email_id: str) -> dict[str, Any]:
    response = requests.get(
        f"https://api.resend.com/emails/receiving/{email_id}",
        headers=_headers(),
        timeout=30,
    )
    response.raise_for_status()
    return response.json()


def _normalize_to(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value.lower()]
    if isinstance(value, list):
        return [str(v).lower() for v in value]
    return []


def _matches_recipient(meta: dict[str, Any], email: str) -> bool:
    target = email.lower()
    for key in ("to", "recipient", "recipients"):
        for addr in _normalize_to(meta.get(key)):
            if addr == target or target in addr:
                return True
    return False


def extract_code(text: str) -> str | None:
    if not text:
        return None
    for pattern in CODE_PATTERNS:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            return match.group(1)
    return None


def extract_link(text: str) -> str | None:
    if not text:
        return None
    for pattern in LINK_PATTERNS:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            return unquote(match.group(1))
    return None


def verification_from_email(email_payload: dict[str, Any]) -> tuple[str | None, str | None]:
    """Return (code, link) — whichever is found first in body."""
    bodies = [
        email_payload.get("text") or "",
        email_payload.get("html") or "",
        email_payload.get("subject") or "",
    ]
    code = None
    link = None
    for body in bodies:
        if not code:
            code = extract_code(body)
        if not link:
            link = extract_link(body)
        if code and link:
            break
    return code, link


def wait_for_verification(
    email: str,
    *,
    timeout_sec: float | None = None,
    after_ts: float | None = None,
) -> dict[str, Any]:
    """Poll Resend until an email arrives for `email`. Returns {code?, link?, email_id, subject}."""
    deadline = time.time() + (timeout_sec if timeout_sec is not None else POLL_TIMEOUT_SEC)
    seen_ids: set[str] = set()

    print(f"Polling Resend inbox for {email} …")

    while time.time() < deadline:
        try:
            items = list_received()
        except Exception as exc:
            print(f"  Resend list error: {exc}")
            time.sleep(POLL_INTERVAL_SEC)
            continue

        for item in items:
            email_id = str(item.get("id") or item.get("email_id") or "")
            if not email_id or email_id in seen_ids:
                continue
            if not _matches_recipient(item, email):
                continue

            received_at = item.get("created_at") or item.get("received_at")
            if after_ts and received_at:
                try:
                    from datetime import datetime

                    if isinstance(received_at, str):
                        ts = datetime.fromisoformat(received_at.replace("Z", "+00:00")).timestamp()
                        if ts < after_ts - 5:
                            continue
                except Exception:
                    pass

            try:
                full = fetch_received(email_id)
            except Exception as exc:
                print(f"  fetch {email_id} failed: {exc}")
                continue

            code, link = verification_from_email(full)
            if code or link:
                print(f"  got verification for {email} (code={bool(code)}, link={bool(link)})")
                return {
                    "code": code,
                    "link": link,
                    "email_id": email_id,
                    "subject": full.get("subject") or item.get("subject"),
                }
            seen_ids.add(email_id)

        time.sleep(POLL_INTERVAL_SEC)

    raise TimeoutError(f"No verification email for {email} within {POLL_TIMEOUT_SEC}s")


def wait_for_verifications_batch(
    emails: list[str],
    *,
    after_ts: dict[str, float] | None = None,
    timeout_sec: float | None = None,
) -> dict[str, dict[str, Any]]:
    """
    Poll Resend once per interval until every email has a verification message.
    Avoids N parallel pollers hammering the API and staggering results.
    """
    pending = {e.lower(): e for e in emails}
    results: dict[str, dict[str, Any]] = {}
    after_ts = after_ts or {}
    deadline = time.time() + (timeout_sec if timeout_sec is not None else POLL_TIMEOUT_SEC)
    seen_ids: set[str] = set()

    print(f"Polling Resend for {len(pending)} verification email(s) in one loop …")

    while pending and time.time() < deadline:
        try:
            items = list_received(limit=max(20, len(emails) * 3))
        except Exception as exc:
            print(f"  Resend list error: {exc}")
            time.sleep(POLL_INTERVAL_SEC)
            continue

        for item in items:
            email_id = str(item.get("id") or item.get("email_id") or "")
            if not email_id or email_id in seen_ids:
                continue

            matched = None
            for key in ("to", "recipient", "recipients"):
                for addr in _normalize_to(item.get(key)):
                    if addr in pending:
                        matched = pending[addr]
                        break
                if matched:
                    break
            if not matched:
                continue

            received_at = item.get("created_at") or item.get("received_at")
            cutoff = after_ts.get(matched)
            if cutoff and received_at:
                try:
                    from datetime import datetime

                    if isinstance(received_at, str):
                        ts = datetime.fromisoformat(received_at.replace("Z", "+00:00")).timestamp()
                        if ts < cutoff - 5:
                            continue
                except Exception:
                    pass

            try:
                full = fetch_received(email_id)
            except Exception as exc:
                print(f"  fetch {email_id} failed: {exc}")
                continue

            code, link = verification_from_email(full)
            if code or link:
                print(f"  got verification for {matched} (code={bool(code)}, link={bool(link)})")
                results[matched] = {
                    "code": code,
                    "link": link,
                    "email_id": email_id,
                    "subject": full.get("subject") or item.get("subject"),
                }
                del pending[matched.lower()]
                seen_ids.add(email_id)

        if pending:
            time.sleep(POLL_INTERVAL_SEC)

    if pending:
        missing = ", ".join(pending.values())
        raise TimeoutError(
            f"No verification email for [{missing}] within "
            f"{timeout_sec if timeout_sec is not None else POLL_TIMEOUT_SEC}s"
        )
    return results
