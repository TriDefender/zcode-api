"""Browser profile lifecycle — fresh profile per account run."""

from __future__ import annotations

import os
import random
import shutil
import time
import uuid
from pathlib import Path

from playwright.sync_api import BrowserContext, Page, sync_playwright

from lib.account_store import Account, next_account

PROFILES_DIR = Path(os.environ.get("PROFILES_DIR", "profiles"))
HEADLESS = os.environ.get("HEADLESS", "false").lower() in ("1", "true", "yes")
SLOW_MO_MS = int(os.environ.get("SLOW_MO_MS", "80"))
STEP_TIMEOUT_MS = int(os.environ.get("STEP_TIMEOUT_MS", "90000"))


def human_pause(min_s: float = 0.4, max_s: float = 1.0) -> None:
    time.sleep(random.uniform(min_s, max_s))


def new_credentials() -> dict[str, str]:
    acct = next_account()
    return {
        "email": acct.email,
        "password": acct.password,
        "username": acct.username,
        "index": str(acct.index),
    }


def launch_fresh_context(profile_dir: Path) -> tuple[object, BrowserContext]:
    profile_dir.mkdir(parents=True, exist_ok=True)
    pw = sync_playwright().start()
    context = pw.chromium.launch_persistent_context(
        user_data_dir=str(profile_dir),
        headless=HEADLESS,
        slow_mo=SLOW_MO_MS,
        viewport={"width": 1320, "height": 900},
        args=["--disable-blink-features=AutomationControlled"],
    )
    return pw, context


def delete_profile(profile_dir: Path) -> None:
    shutil.rmtree(profile_dir, ignore_errors=True)


def new_profile_dir() -> Path:
    return PROFILES_DIR / f"run-{uuid.uuid4().hex}"


def fill_verification_code(page: Page, code: str) -> None:
    inputs = page.locator('input[inputmode="numeric"], input[autocomplete="one-time-code"]')
    if inputs.count() >= len(code):
        for i, ch in enumerate(code):
            inputs.nth(i).fill(ch)
        return
    single = page.locator(
        'input[name="code"], input[type="text"][placeholder*="code" i], input[type="tel"]'
    ).first
    single.wait_for(state="visible", timeout=STEP_TIMEOUT_MS)
    single.fill(code)
