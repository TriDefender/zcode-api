#!/usr/bin/env python3
"""Interactive CDP flow exploration — click through signup/login paths."""

from __future__ import annotations

import os

from playwright.sync_api import sync_playwright

CDP = os.environ.get("CDP_URL", "http://127.0.0.1:9223")
OUT = __import__("pathlib").Path(__file__).parent / "explore"


def snap(page, name: str) -> None:
    OUT.mkdir(exist_ok=True)
    page.screenshot(path=str(OUT / f"{name}.png"), full_page=True)
    (OUT / f"{name}.url").write_text(page.url)
    print(f"{name}: {page.url}")


def try_click(page, selectors: list[str], label: str) -> bool:
    for sel in selectors:
        loc = page.locator(sel).first
        try:
            if loc.count() and loc.is_visible():
                print(f"click {label}: {sel}")
                loc.click()
                page.wait_for_timeout(2500)
                return True
        except Exception as e:
            print(f"  skip {sel}: {e}")
    return False


def main() -> None:
    pw = sync_playwright().start()
    browser = pw.chromium.connect_over_cdp(CDP)
    ctx = browser.contexts[0]
    page = ctx.new_page()

    # --- 1. Z.AI homepage → find login/signup ---
    page.goto("https://chat.z.ai/", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(3000)
    snap(page, "01_home")

    # Bottom-left profile / login triggers
    try_click(
        page,
        [
            'text="Log in"',
            'text="Sign in"',
            'text="登录"',
            'text="注册"',
            'button:has-text("Log in")',
            'button:has-text("Sign in")',
            '[class*="avatar"]',
            '[class*="user"]',
            'img[alt*="avatar" i]',
        ],
        "login_entry",
    )
    snap(page, "02_after_login_click")

    # Try sending a message (may prompt login)
    chat = page.locator("#chat-input, textarea").first
    if chat.count() and chat.is_visible():
        chat.fill("test login prompt")
        page.keyboard.press("Enter")
        page.wait_for_timeout(3000)
        snap(page, "03_after_send")

    # Direct auth URLs to try
    for url in [
        "https://chat.z.ai/login",
        "https://chat.z.ai/signup",
        "https://chat.z.ai/register",
        "https://open.bigmodel.cn/usercenter/login",
        "https://z.ai/login",
    ]:
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(2000)
            safe = url.split("//")[-1].replace("/", "_")
            snap(page, f"04_direct_{safe}")
            if page.locator('input[type="email"], input[type="password"]').count():
                print(f"FOUND auth form at {url}")
                break
        except Exception as e:
            print(f"fail {url}: {e}")

    # --- 2. Proxy dashboard ---
    page.goto("http://127.0.0.1:8080/app", wait_until="domcontentloaded", timeout=30000)
    page.wait_for_timeout(2000)
    snap(page, "05_proxy_app")

    sign_in = page.locator("#btn-signin:visible, #btn-signin-empty:visible").first
    if sign_in.count():
        print("Found proxy sign-in button")
        with page.expect_response(lambda r: "/admin/onboard/start" in r.url) as resp_info:
            with ctx.expect_page() as pop:
                sign_in.click()
            oauth = pop.value
        job = resp_info.value.json()
        print(f"onboard job: {job.get('id')}")
        print(f"authorize: {job.get('authorizeUrl')}")
        oauth.wait_for_load_state("domcontentloaded")
        page.wait_for_timeout(3000)
        snap(oauth, "06_oauth_authorize")
        (OUT / "06_oauth_authorize.json").write_text(
            __import__("json").dumps(
                {
                    "url": oauth.url,
                    "inputs": [
                        {
                            "type": i.get_attribute("type"),
                            "name": i.get_attribute("name"),
                            "placeholder": i.get_attribute("placeholder"),
                        }
                        for i in oauth.locator("input").all()[:20]
                    ],
                    "buttons": oauth.locator("button").all_inner_texts()[:15],
                },
                indent=2,
            )
        )

    pw.stop()
    print("done — see runner/explore/")


if __name__ == "__main__":
    main()
