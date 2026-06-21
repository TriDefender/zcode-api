"""Wait for manual Aliyun captcha — notify-send + auto-detect when solved."""

from __future__ import annotations

import os
import re
import subprocess
import sys
import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from playwright.sync_api import Page

POLL_INTERVAL_SEC = float(os.environ.get("CAPTCHA_POLL_INTERVAL_SEC", "1"))
POLL_TIMEOUT_SEC = float(os.environ.get("CAPTCHA_TIMEOUT_SEC", "600"))

# Z.AI Open WebUI / Aliyun captcha success markers (from manual exploration)
_PASSED_TEXT = re.compile(
    r"verification passed|verify success|验证通过|验证成功|captcha success",
    re.I,
)
_PENDING_TEXT = re.compile(
    r"click to start verification|请完成验证|滑动验证|请进行验证|点击开始验证|点击.*验证",
    re.I,
)
_START_CLICK_TEXT = re.compile(
    r"click to start verification|点击开始验证|点击按钮开始验证|请完成验证|请进行验证",
    re.I,
)
_CAPTCHA_WIDGET_SELECTORS = (
    "#aliyunCaptcha",
    "#captcha-element",
    "#captcha-button",
    '[id*="aliyunCaptcha"]',
    '[id*="captcha-element"]',
    '[class*="aliyun-captcha"]',
    '[class*="captcha-verify"]',
    '[class*="captcha"]',
)
_SLIDER_SELECTORS = (
    '[class*="slider"]',
    '[id*="slider"]',
    '[class*="slide-verify"]',
    '[class*="puzzle"]',
    "canvas",
)


def _captcha_passed(page: Page) -> bool:
    try:
        if page.get_by_text(_PASSED_TEXT).count():
            loc = page.get_by_text(_PASSED_TEXT).first
            if loc.is_visible():
                return True

        body = page.locator("body").inner_text(timeout=2000).lower()
        if "verification passed" in body or "验证通过" in body:
            return True

        # Pending UI gone and no obvious captcha modal
        if not page.get_by_text(_PENDING_TEXT).count():
            # Only treat as done if we previously had pending OR captcha widget visible
            slider = page.locator(
                '[class*="captcha"], [id*="captcha"], iframe[src*="captcha"], #aliyunCaptcha'
            )
            if slider.count() == 0:
                return False
    except Exception:
        pass
    return False


def _slider_visible(page: Page) -> bool:
    """True when the slide puzzle is already open (user can drag immediately)."""
    for sel in _SLIDER_SELECTORS:
        loc = page.locator(sel).first
        try:
            if loc.count() and loc.is_visible():
                return True
        except Exception:
            pass
    for frame in page.frames:
        url = (frame.url or "").lower()
        if "captcha" not in url and "aliyun" not in url:
            continue
        for sel in _SLIDER_SELECTORS:
            try:
                loc = frame.locator(sel).first
                if loc.count() and loc.is_visible():
                    return True
            except Exception:
                pass
    return False


def _try_click(locator, label: str) -> bool:
    try:
        if locator.count() and locator.first.is_visible():
            locator.first.click(timeout=3000)
            print(f"  clicked captcha trigger: {label}")
            time.sleep(0.8)
            return True
    except Exception:
        pass
    return False


def trigger_captcha_start(page: Page) -> bool:
    """
    Click the Aliyun 'start verification' control so the slider is open
    when the user arrives — they only need to slide.
    """
    if _captcha_passed(page):
        return False
    if _slider_visible(page):
        print("  captcha slider already open")
        return True

    time.sleep(0.4)

    if _try_click(page.get_by_text(_START_CLICK_TEXT).first, "start verification text"):
        return True
    if _try_click(
        page.get_by_role("button", name=_START_CLICK_TEXT).first,
        "start verification button",
    ):
        return True

    for sel in _CAPTCHA_WIDGET_SELECTORS:
        if _try_click(page.locator(sel).first, sel):
            return True

    for frame in page.frames:
        url = (frame.url or "").lower()
        if "captcha" not in url and "aliyun" not in url:
            continue
        if _try_click(frame.get_by_text(_START_CLICK_TEXT).first, f"iframe text ({url[:40]})"):
            return True
        for sel in ("#aliyunCaptcha", "#captcha-button", ".btn_slide", '[class*="verify"]', "button"):
            if _try_click(frame.locator(sel).first, f"iframe {sel}"):
                return True

    print("  captcha start button not found — click it manually if needed")
    return False


def notify_batch_captcha(step: str, *, count: int = 1) -> None:
    """Single desktop notification for a batch of browser windows."""
    base = os.environ.get("CAPTCHA_NOTIFY_MSG", "please do the captcha")
    message = f"{base} ({count} window{'s' if count != 1 else ''})"
    try:
        subprocess.run(["notify-send", message], check=False)
    except FileNotFoundError:
        print("(notify-send not found — check the browser windows)")

    print()
    print("=" * 60)
    print(f"CAPTCHA required: {step} — {count} browser window(s)")
    print(f"Notification sent: notify-send {message!r}")
    print("=" * 60)


def wait_for_captcha_on_page(page: Page, step: str) -> None:
    """Poll one page for captcha completion (no notify-send)."""
    print(f"  waiting for captcha on {step} …")
    trigger_captcha_start(page)
    retried = False
    deadline = time.time() + POLL_TIMEOUT_SEC
    while time.time() < deadline:
        if _captcha_passed(page):
            print("  captcha complete.")
            time.sleep(0.5)
            return
        if not retried and page.get_by_text(_PENDING_TEXT).count():
            try:
                if page.get_by_text(_PENDING_TEXT).first.is_visible():
                    trigger_captcha_start(page)
                    retried = True
            except Exception:
                pass
        time.sleep(POLL_INTERVAL_SEC)
    raise TimeoutError(f"Captcha not completed within {POLL_TIMEOUT_SEC:.0f}s ({step})")


def wait_for_manual_captcha(step: str, *, page: Page | None = None) -> None:
    notify_batch_captcha(step, count=1)
    if page is not None:
        print(f"Polling every {POLL_INTERVAL_SEC:.0f}s for captcha completion…")
    elif sys.stdin.isatty():
        print("Complete the captcha in the browser, then press Enter here.")
    else:
        print(f"Waiting up to {POLL_TIMEOUT_SEC:.0f}s for manual captcha …")
    print("=" * 60)

    if page is not None:
        wait_for_captcha_on_page(page, step)
        return

    if sys.stdin.isatty():
        input("Press Enter when captcha is done… ")
        return

    time.sleep(POLL_TIMEOUT_SEC)


def wait_for_captcha_on_pages(step: str, *pages: Page) -> None:
    """Poll multiple tabs for captcha completion (caller sends notify)."""
    print(f"\nCAPTCHA required: {step} — polling {len(pages)} tab(s) every {POLL_INTERVAL_SEC:.0f}s")

    deadline = time.time() + POLL_TIMEOUT_SEC
    while time.time() < deadline:
        for page in pages:
            try:
                if not page.is_closed() and _captcha_passed(page):
                    print("Captcha detected as complete.")
                    time.sleep(0.5)
                    return
            except Exception:
                pass
        time.sleep(POLL_INTERVAL_SEC)
    raise TimeoutError(f"Captcha not completed within {POLL_TIMEOUT_SEC:.0f}s ({step})")
