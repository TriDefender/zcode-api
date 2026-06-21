"""Z.AI signup + zcode-proxy OAuth link flow (chat.z.ai/auth, Open WebUI)."""

from __future__ import annotations

import os
import re
import time
from typing import Any

from playwright.sync_api import BrowserContext, Page

from lib.browser import STEP_TIMEOUT_MS, human_pause
from lib.captcha import notify_batch_captcha, wait_for_captcha_on_page, wait_for_manual_captcha
from lib.proxy_api import (
    PROXY_URL,
    count_pool_accounts,
    start_onboard,
    wait_until_account_usable,
)
from lib.resend_client import wait_for_verification

SIGNUP_URL = os.environ.get("SIGNUP_URL", "https://chat.z.ai/auth")
ACCOUNT_USERNAME = os.environ.get("ACCOUNT_USERNAME", "Zcode")
LAUNCH_ZCODE = os.environ.get("LAUNCH_ZCODE", "true").lower() in ("1", "true", "yes")
USE_DASHBOARD_SIGNIN = os.environ.get("USE_DASHBOARD_SIGNIN", "true").lower() in ("1", "true", "yes")


def _click_role(page: Page, role: str, name: str) -> bool:
    loc = page.get_by_role(role, name=name).first
    try:
        if loc.count() and loc.is_visible():
            loc.click()
            return True
    except Exception:
        pass
    return False


def _fill_placeholder(page: Page, placeholder: str, value: str) -> None:
    loc = page.get_by_placeholder(placeholder).first
    loc.wait_for(state="visible", timeout=STEP_TIMEOUT_MS)
    loc.fill(value)


def _complete_email_verify_password(page: Page, password: str) -> None:
    """After verify link: set password + confirm on /auth/verify_email."""
    if "verify_email" not in page.url:
        return
    human_pause(1.0, 2.0)
    for ph in ("Enter your password", "Confirm your password"):
        box = page.get_by_placeholder(ph)
        if box.count() and box.first.is_visible():
            box.first.fill(password)
            human_pause(0.2, 0.4)
    if _click_role(page, "button", "Complete Registration"):
        page.wait_for_load_state("domcontentloaded", timeout=STEP_TIMEOUT_MS)
        human_pause(2.0, 3.0)


def prepare_signup_form(page: Page, creds: dict[str, str]) -> float:
    """Navigate and fill signup form; return timestamp before Create Account."""
    username = creds.get("username") or ACCOUNT_USERNAME
    print(f"Signup → {SIGNUP_URL} as {creds['email']}")

    page.goto(SIGNUP_URL, wait_until="domcontentloaded", timeout=STEP_TIMEOUT_MS)
    human_pause(1.5, 2.5)

    if _click_role(page, "button", "Continue with Email"):
        human_pause(0.8, 1.2)

    if not _click_role(page, "button", "Sign up"):
        raise RuntimeError('Could not find "Sign up" on /auth')

    human_pause(0.5, 0.8)
    started_at = time.time()

    _fill_placeholder(page, "Enter Your Full Name", username)
    human_pause(0.2, 0.4)
    _fill_placeholder(page, "Enter Your Email", creds["email"])
    human_pause(0.2, 0.4)
    _fill_placeholder(page, "Enter Your Password", creds["password"])
    human_pause(0.3, 0.6)
    return started_at


def click_create_account(page: Page) -> None:
    if not _click_role(page, "button", "Create Account"):
        raise RuntimeError('Could not find "Create Account" button')
    page.wait_for_load_state("domcontentloaded", timeout=STEP_TIMEOUT_MS)
    human_pause(1.0, 1.5)


def apply_email_verification(
    page: Page,
    creds: dict[str, str],
    verification: dict[str, Any],
) -> None:
    if verification.get("link"):
        link = verification["link"].replace("&amp;", "&")
        print(f"Opening verification link for {creds['email']} …")
        page.goto(link, wait_until="domcontentloaded", timeout=STEP_TIMEOUT_MS)
        human_pause(2.0, 3.0)
        _complete_email_verify_password(page, creds["password"])
    elif verification.get("code"):
        from lib.browser import fill_verification_code

        fill_verification_code(page, verification["code"])
        human_pause(0.3, 0.6)
        _click_role(page, "button", "Complete Registration")
        page.wait_for_load_state("domcontentloaded", timeout=STEP_TIMEOUT_MS)
    else:
        raise RuntimeError("Verification email had no link or code")
    print(f"Signup complete for {creds['email']} → {page.url}")


def signup_on_zai(page: Page, creds: dict[str, str]) -> None:
    """Create account: /auth → Sign up → captcha → Create Account → verify email."""
    started_at = prepare_signup_form(page, creds)
    wait_for_manual_captcha("Z.AI signup (1/2)", page=page)
    click_create_account(page)
    verification = wait_for_verification(creds["email"], after_ts=started_at)
    apply_email_verification(page, creds, verification)


def prepare_oauth_login(page: Page, creds: dict[str, str]) -> bool:
    """Fill OAuth login form if shown. Returns True when captcha is needed."""
    page.wait_for_load_state("domcontentloaded", timeout=STEP_TIMEOUT_MS)
    human_pause(1.0, 1.5)

    if page.get_by_placeholder("Enter Your Email").count():
        if _click_role(page, "button", "Continue with Email"):
            human_pause(0.8, 1.2)
        _fill_placeholder(page, "Enter Your Email", creds["email"])
        _fill_placeholder(page, "Enter Your Password", creds["password"])
        return True
    return False


def complete_oauth_authorize(page: Page) -> None:
    """After captcha/login: accept terms and authorize."""
    if page.get_by_role("heading", name=re.compile(r"access your Z", re.I)).count():
        terms = page.get_by_text("Terms of Service and Privacy Policy")
        if terms.count():
            terms.first.click()
            human_pause(0.3, 0.6)
        _click_role(page, "button", "Continue")
        page.wait_for_load_state("domcontentloaded", timeout=STEP_TIMEOUT_MS)
        return

    for label in ("Authorize", "Allow", "Continue", "授权", "同意"):
        if _click_role(page, "button", label):
            return


def authorize_oauth_tab(page: Page, creds: dict[str, str]) -> None:
    """OAuth authorize page — login if needed, accept terms, Continue."""
    needs_captcha = prepare_oauth_login(page, creds)
    if needs_captcha:
        wait_for_manual_captcha("Z.AI OAuth login (2/2)", page=page)
        _click_role(page, "button", "Sign in")
        page.wait_for_load_state("domcontentloaded", timeout=STEP_TIMEOUT_MS)
        human_pause(1.0, 1.5)
    complete_oauth_authorize(page)


def _click_add_account(dashboard: Page) -> None:
    """Top-bar Add account button (always visible, not at bottom of list)."""
    btn = dashboard.locator("#btn-add-account:visible").first
    if not btn.count():
        btn = dashboard.get_by_role("button", name=re.compile(r"add account.*sign in", re.I)).first
    btn.wait_for(state="visible", timeout=STEP_TIMEOUT_MS)
    btn.click()


def _open_oauth_via_dashboard(context: BrowserContext) -> tuple[Page, Page, str]:
    dashboard = context.new_page()
    dashboard.goto(f"{PROXY_URL}/app", wait_until="domcontentloaded", timeout=STEP_TIMEOUT_MS)
    human_pause(0.8, 1.2)

    with dashboard.expect_response(
        lambda r: "/admin/onboard/start" in r.url and r.request.method == "POST",
        timeout=STEP_TIMEOUT_MS,
    ) as response_info:
        with context.expect_page(timeout=STEP_TIMEOUT_MS) as page_info:
            _click_add_account(dashboard)
        oauth = page_info.value

    response = response_info.value
    if not response.ok:
        raise RuntimeError(f"onboard/start failed: HTTP {response.status}")
    job = response.json()
    job_id = job["id"]
    print(f"Dashboard onboard job {job_id}")
    print(f"Authorize → {job.get('authorizeUrl')}")

    oauth.wait_for_load_state("domcontentloaded", timeout=STEP_TIMEOUT_MS)
    return dashboard, oauth, job_id


def _open_oauth_via_api(context: BrowserContext) -> tuple[Page, Page, str]:
    job = start_onboard(launch_desktop=LAUNCH_ZCODE)
    job_id = job["id"]
    authorize_url = job["authorizeUrl"]
    print(f"Onboard job {job_id}")
    print(f"Authorize → {authorize_url}")

    dashboard = context.new_page()
    dashboard.goto(f"{PROXY_URL}/app", wait_until="domcontentloaded", timeout=STEP_TIMEOUT_MS)
    human_pause(0.5, 0.8)

    oauth = context.new_page()
    oauth.goto(authorize_url, wait_until="domcontentloaded", timeout=STEP_TIMEOUT_MS)
    return dashboard, oauth, job_id


def open_proxy_oauth(context: BrowserContext) -> tuple[Page, Page, str, int]:
    """Open dashboard + OAuth tab. Returns (dashboard, oauth, job_id, before_count)."""
    before_count = count_pool_accounts()
    if USE_DASHBOARD_SIGNIN:
        dashboard, oauth, job_id = _open_oauth_via_dashboard(context)
    else:
        dashboard, oauth, job_id = _open_oauth_via_api(context)
    return dashboard, oauth, job_id, before_count


def link_account_via_proxy(
    context: BrowserContext,
    creds: dict[str, str],
) -> dict[str, Any]:
    dashboard, oauth, job_id, before_count = open_proxy_oauth(context)

    human_pause(1.0, 1.5)
    authorize_oauth_tab(oauth, creds)

    print("Waiting for proxy onboard …")
    usable = wait_until_account_usable(job_id, before_count)
    result = usable["job"]
    acct = usable["account"]
    print(
        f"Pool account ready: {acct.get('userId')} "
        f"({len(acct.get('balances') or [])} buckets, usable={usable.get('quota_ready')})"
    )

    return {
        "ok": True,
        "job": result,
        "account": acct,
        "credential": usable.get("credential"),
        "account_id": usable.get("account_id"),
        "quota_ready": usable.get("quota_ready"),
        "job_id": job_id,
        "final_oauth_url": oauth.url if not oauth.is_closed() else None,
        "dashboard_url": dashboard.url if not dashboard.is_closed() else None,
    }
