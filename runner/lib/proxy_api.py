"""HTTP helpers for zcode-proxy dashboard / admin API (gentle polling)."""

from __future__ import annotations

import os
import time
from typing import Any

import requests

PROXY_URL = os.environ.get("PROXY_URL", "http://127.0.0.1:8080").rstrip("/")
# Seconds between polls — keep high enough to avoid hammering proxy / Z.AI billing cache
ONBOARD_POLL_SEC = float(os.environ.get("ONBOARD_POLL_SEC", "5"))
QUOTA_POLL_SEC = float(os.environ.get("QUOTA_POLL_SEC", "8"))
ONBOARD_TIMEOUT_SEC = float(os.environ.get("ONBOARD_TIMEOUT_SEC", "300"))
QUOTA_TIMEOUT_SEC = float(os.environ.get("QUOTA_TIMEOUT_SEC", "300"))


def start_onboard(*, launch_desktop: bool = True) -> dict[str, Any]:
    response = requests.post(
        f"{PROXY_URL}/admin/onboard/start",
        json={"launchDesktop": launch_desktop},
        timeout=30,
    )
    response.raise_for_status()
    return response.json()


def poll_onboard(job_id: str) -> dict[str, Any]:
    response = requests.get(f"{PROXY_URL}/admin/onboard/{job_id}", timeout=30)
    response.raise_for_status()
    return response.json()


def fetch_account_credential(account_id: str) -> dict[str, Any]:
    response = requests.get(f"{PROXY_URL}/admin/accounts/{account_id}/credential", timeout=30)
    response.raise_for_status()
    return response.json()


def _job_has_quota(job: dict[str, Any]) -> bool:
    return bool(job.get("quotaReady") or (job.get("balanceCount") or 0) > 0)


def _account_stub_from_job(
    job: dict[str, Any],
    credential: dict[str, Any] | None,
) -> dict[str, Any]:
    """Minimal account dict when onboard already confirmed billing buckets."""
    balance_count = int(job.get("balanceCount") or 0)
    return {
        "id": job.get("accountId"),
        "userId": (credential or {}).get("userId"),
        "balances": [{}] * balance_count if balance_count else [],
    }


def _credential_for_job(job: dict[str, Any]) -> tuple[dict[str, Any] | None, str | None]:
    account_id = job.get("accountId")
    if not account_id:
        return None, None
    try:
        credential = fetch_account_credential(str(account_id))
        return credential, credential.get("userId")
    except Exception:
        return None, None


def wait_for_onboard(job_id: str) -> dict[str, Any]:
    deadline = time.time() + ONBOARD_TIMEOUT_SEC
    last_phase: str | None = None
    while time.time() < deadline:
        job = poll_onboard(job_id)
        phase = job.get("phase")
        if phase != last_phase:
            print(f"  onboard phase → {phase}")
            last_phase = phase
        if phase == "done":
            return job
        if phase == "error":
            raise RuntimeError(job.get("error") or "onboard failed")
        time.sleep(ONBOARD_POLL_SEC)
    raise TimeoutError(f"Onboard job {job_id} timed out after {ONBOARD_TIMEOUT_SEC}s")


def wait_for_new_pool_account(before_count: int, *, user_id: str | None = None) -> dict[str, Any]:
    """Wait until pool has a new account with quota buckets (reads cached /admin/quota)."""
    deadline = time.time() + QUOTA_TIMEOUT_SEC
    attempt = 0
    while time.time() < deadline:
        attempt += 1
        response = requests.get(f"{PROXY_URL}/admin/quota", timeout=30)
        response.raise_for_status()
        data = response.json()
        accounts = data.get("accounts") or []

        candidates = accounts if len(accounts) <= before_count else accounts[before_count:]
        for acct in reversed(candidates):
            if user_id and acct.get("userId") and str(acct.get("userId")) != user_id:
                continue
            balances = acct.get("balances") or []
            if balances:
                print(f"  quota ready ({len(balances)} bucket(s)) after {attempt} poll(s)")
                return acct

        if attempt == 1 or attempt % 5 == 0:
            cache = data.get("cache") or {}
            if cache.get("refreshing"):
                print("  waiting for quota cache refresh…")
            else:
                print(f"  waiting for quota buckets… (poll {attempt})")

        time.sleep(QUOTA_POLL_SEC)
    raise TimeoutError("New pool account with quota not ready within timeout")


def wait_for_onboards_batch(job_ids: list[str]) -> dict[str, dict[str, Any]]:
    """Poll all onboard jobs in one loop (single sleep between cycles)."""
    pending = set(job_ids)
    done: dict[str, dict[str, Any]] = {}
    deadline = time.time() + ONBOARD_TIMEOUT_SEC
    last_phases: dict[str, str | None] = {jid: None for jid in job_ids}

    print(f"Batch onboard poll for {len(job_ids)} job(s) every {ONBOARD_POLL_SEC:.0f}s …")

    while pending and time.time() < deadline:
        for job_id in list(pending):
            try:
                job = poll_onboard(job_id)
            except Exception as exc:
                print(f"  onboard poll {job_id} error: {exc}")
                continue
            phase = job.get("phase")
            if phase != last_phases.get(job_id):
                print(f"  {job_id[:8]}… phase → {phase}")
                last_phases[job_id] = phase
            if phase == "done":
                done[job_id] = job
                pending.discard(job_id)
            elif phase == "error":
                raise RuntimeError(job.get("error") or f"onboard failed for {job_id}")
        if pending:
            time.sleep(ONBOARD_POLL_SEC)

    if pending:
        raise TimeoutError(
            f"Onboard jobs timed out after {ONBOARD_TIMEOUT_SEC}s: {', '.join(sorted(pending))}"
        )
    return done


def wait_for_new_pool_accounts_batch(
    specs: list[tuple[str, str | None, str | None]],
) -> dict[str, dict[str, Any]]:
    """
    Wait for multiple pool accounts. Each spec is (key, account_id, user_id).
    Returns key -> account dict.
    """
    pending = {key: (account_id, user_id) for key, account_id, user_id in specs}
    found: dict[str, dict[str, Any]] = {}
    deadline = time.time() + QUOTA_TIMEOUT_SEC
    attempt = 0

    print(f"Batch quota poll for {len(specs)} account(s) every {QUOTA_POLL_SEC:.0f}s …")

    while pending and time.time() < deadline:
        attempt += 1
        try:
            response = requests.get(f"{PROXY_URL}/admin/quota", timeout=30)
            response.raise_for_status()
            data = response.json()
        except Exception as exc:
            print(f"  quota poll error: {exc}")
            time.sleep(QUOTA_POLL_SEC)
            continue

        accounts = data.get("accounts") or []
        for key, (account_id, user_id) in list(pending.items()):
            for acct in accounts:
                if account_id and acct.get("id") != account_id:
                    continue
                if user_id and acct.get("userId") and str(acct.get("userId")) != user_id:
                    continue
                if account_id or user_id:
                    balances = acct.get("balances") or []
                    if balances:
                        print(f"  {key[:8]}… quota ready ({len(balances)} bucket(s))")
                        found[key] = acct
                        del pending[key]
                        break

        if pending:
            if attempt == 1 or attempt % 5 == 0:
                cache = data.get("cache") or {}
                if cache.get("refreshing"):
                    print("  waiting for quota cache refresh…")
                else:
                    print(f"  waiting for quota buckets… (poll {attempt}, {len(pending)} left)")
            time.sleep(QUOTA_POLL_SEC)

    if pending:
        raise TimeoutError(
            f"Quota not ready for {len(pending)} account(s) within {QUOTA_TIMEOUT_SEC}s"
        )
    return found


def wait_until_accounts_usable_batch(
    jobs: list[tuple[str, int]],
) -> dict[str, dict[str, Any]]:
    """
    Post-OAuth for multiple accounts. jobs: [(job_id, before_count), ...].
    before_count is kept for logging only; matching uses accountId/userId from the job.
    Returns job_id -> {job, account, credential, account_id, quota_ready}.
    """
    job_ids = [jid for jid, _ in jobs]
    onboarded = wait_for_onboards_batch(job_ids)

    specs: list[tuple[str, str | None, str | None]] = []
    prefilled: dict[str, dict[str, Any]] = {}
    credentials: dict[str, dict[str, Any] | None] = {}

    for job_id, job in onboarded.items():
        credential, user_id = _credential_for_job(job)
        credentials[job_id] = credential
        if _job_has_quota(job):
            prefilled[job_id] = _account_stub_from_job(job, credential)
            print(
                f"  {job_id[:8]}… quota ready from onboard "
                f"({job.get('balanceCount', '?')} bucket(s))"
            )
            continue
        account_id = job.get("accountId")
        specs.append((job_id, str(account_id) if account_id else None, user_id))

    accounts = wait_for_new_pool_accounts_batch(specs) if specs else {}
    accounts.update(prefilled)

    results: dict[str, dict[str, Any]] = {}
    for job_id, job in onboarded.items():
        acct = accounts[job_id]
        credential = credentials.get(job_id)
        pool_id = job.get("accountId") or acct.get("id")
        results[job_id] = {
            "job": job,
            "account": acct,
            "credential": credential,
            "account_id": pool_id,
            "quota_ready": _job_has_quota(job) or bool(acct.get("balances")),
        }
    return results


def wait_until_account_usable(job_id: str, before_count: int) -> dict[str, Any]:
    """
    Full post-OAuth pipeline: onboard job → provisioning → JWT export.
    When the onboard job reports quotaReady, skip polling the dashboard quota cache.
    """
    print(f"Onboarding (poll every {ONBOARD_POLL_SEC:.0f}s)…")
    job = wait_for_onboard(job_id)

    credential, user_id = _credential_for_job(job)

    if _job_has_quota(job):
        print(f"  quota ready from onboard ({job.get('balanceCount', '?')} bucket(s))")
        acct = _account_stub_from_job(job, credential)
    else:
        print("  provision finished — waiting for billing buckets in quota cache…")
        acct = wait_for_new_pool_account(before_count, user_id=user_id)
        if pool_id := job.get("accountId") or acct.get("id"):
            try:
                credential = fetch_account_credential(str(pool_id))
            except Exception as exc:
                print(f"  warning: could not fetch JWT backup: {exc}")

    pool_id = job.get("accountId") or acct.get("id")

    return {
        "job": job,
        "account": acct,
        "credential": credential,
        "account_id": pool_id,
        "quota_ready": _job_has_quota(job) or bool(acct.get("balances")),
    }


def pool_summary() -> dict[str, Any]:
    status = requests.get(f"{PROXY_URL}/admin/status", timeout=15).json()
    quota = requests.get(f"{PROXY_URL}/admin/quota", timeout=15).json()
    return {"status": status, "quota": quota}


def count_pool_accounts() -> int:
    response = requests.get(f"{PROXY_URL}/admin/quota", timeout=15)
    response.raise_for_status()
    data = response.json()
    return len(data.get("accounts") or [])
