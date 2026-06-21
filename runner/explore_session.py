#!/usr/bin/env python3
"""
Launch fresh headed Chromium on a debug port, connect via CDP, explore flows.
Keeps the browser alive for the whole session (does not use Brave).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).parent
OUT = ROOT / "explore"
PORT = int(os.environ.get("DEBUG_PORT", "9223"))
CDP = f"http://127.0.0.1:{PORT}"
PROFILE = ROOT / "explore-chrome-profile"
CHROME = os.environ.get(
    "CHROME",
    str(Path.home() / ".cache/ms-playwright/chromium-1223/chrome-linux64/chrome"),
)


def wait_cdp(timeout: float = 30) -> None:
    deadline = time.time() + timeout
    url = f"{CDP}/json/version"
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                if r.status == 200:
                    return
        except Exception:
            time.sleep(0.25)
    raise TimeoutError(f"CDP not ready on {CDP}")


def launch_chrome() -> subprocess.Popen:
    PROFILE.mkdir(parents=True, exist_ok=True)
    for lock in PROFILE.glob("Singleton*"):
        try:
            lock.unlink()
        except OSError:
            pass

    env = os.environ.copy()
    env.setdefault("DISPLAY", ":0")

    cmd = [
        CHROME,
        f"--remote-debugging-port={PORT}",
        f"--user-data-dir={PROFILE}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-session-crashed-bubble",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "about:blank",
    ]
    print(f"Launching Chromium → CDP {CDP}")
    print(f"Profile: {PROFILE}")
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    wait_cdp()
    print("CDP ready")
    return proc


def snap(page, name: str) -> dict:
    OUT.mkdir(exist_ok=True)
    page.screenshot(path=str(OUT / f"{name}.png"), full_page=True)
    (OUT / f"{name}.url").write_text(page.url, encoding="utf-8")

    meta = {
        "url": page.url,
        "title": page.title(),
        "buttons": page.locator("button").all_inner_texts()[:25],
        "links": page.locator("a").all_inner_texts()[:25],
        "inputs": [
            {
                "type": el.get_attribute("type"),
                "name": el.get_attribute("name"),
                "placeholder": el.get_attribute("placeholder"),
                "id": el.get_attribute("id"),
                "visible": el.is_visible(),
            }
            for el in page.locator("input, textarea").all()[:25]
        ],
    }
    (OUT / f"{name}.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(f"\n[{name}] {page.url}")
    return meta


def try_clicks(page, labels: list[str]) -> None:
    for text in labels:
        for sel in [f'button:has-text("{text}")', f'a:has-text("{text}")', f'text="{text}"']:
            loc = page.locator(sel).first
            try:
                if loc.count() and loc.is_visible():
                    print(f"  click → {text}")
                    loc.click()
                    page.wait_for_timeout(2000)
                    return
            except Exception:
                pass


def explore_signup(page) -> None:
    page.goto("https://chat.z.ai/", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(3000)
    snap(page, "01_chat_home")

    # Guest / logged-out entry points
    try_clicks(page, ["Log in", "Sign in", "登录", "注册", "Sign up", "Register"])

    # Bottom-left avatar area (logged-out shows login)
    for sel in [
        '[class*="avatar"]',
        '[class*="user-info"]',
        'div[class*="sidebar"] >> nth=-1',
    ]:
        try:
            loc = page.locator(sel).first
            if loc.count() and loc.is_visible():
                loc.click()
                page.wait_for_timeout(2000)
                snap(page, "02_after_avatar")
                try_clicks(page, ["Log in", "Sign in", "登录", "注册", "Sign up"])
                break
        except Exception:
            pass

    snap(page, "03_login_state")

    # Known auth URL patterns
    for path in ["/login", "/signin", "/signup", "/register", "/auth/login"]:
        url = f"https://chat.z.ai{path}"
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(2000)
            meta = snap(page, f"04_path_{path.strip('/')}")
            if any(i.get("type") in ("email", "password", "text") for i in meta["inputs"]):
                print(f"  ** auth form at {url}")
                return
        except Exception as exc:
            print(f"  skip {url}: {exc}")

    # bigmodel passport (Zhipu account system)
    for url in [
        "https://open.bigmodel.cn/usercenter/login",
        "https://passport.bigmodel.cn/login",
    ]:
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(2000)
            snap(page, f"05_{url.split('//')[-1].replace('/', '_')}")
        except Exception as exc:
            print(f"  skip {url}: {exc}")


def explore_proxy_oauth(ctx, page) -> None:
    page.goto("http://127.0.0.1:8080/app", wait_until="domcontentloaded", timeout=30000)
    page.wait_for_timeout(2000)
    snap(page, "10_proxy_dashboard")

    sign_in = page.locator("#btn-signin:visible, #btn-signin-empty:visible").first
    if not sign_in.count():
        print("No sign-in button on dashboard")
        return

    with page.expect_response(lambda r: "/admin/onboard/start" in r.url and r.request.method == "POST") as resp_info:
        with ctx.expect_page(timeout=60000) as pop_info:
            sign_in.click()
        oauth = pop_info.value

    job = resp_info.value.json()
    print(f"onboard id={job.get('id')}")
    print(f"authorize={job.get('authorizeUrl')}")

    oauth.wait_for_load_state("domcontentloaded", timeout=60000)
    page.wait_for_timeout(3000)
    snap(oauth, "11_oauth_authorize")


def main() -> int:
  # Reuse running CDP if already up
    chrome_proc = None
    try:
        wait_cdp(timeout=2)
        print(f"Reusing existing CDP at {CDP}")
    except TimeoutError:
        chrome_proc = launch_chrome()

    pw = sync_playwright().start()
    try:
        browser = pw.chromium.connect_over_cdp(CDP)
        ctx = browser.contexts[0] if browser.contexts else browser.new_context()
        page = ctx.pages[0] if ctx.pages else ctx.new_page()

        explore_signup(page)
        explore_proxy_oauth(ctx, page)

        print(f"\nArtifacts → {OUT}/")
        print("Browser left open on CDP", CDP)
    finally:
        pw.stop()
        # Do NOT kill chrome — user can inspect manually

    return 0


if __name__ == "__main__":
    sys.exit(main())
