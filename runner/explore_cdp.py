#!/usr/bin/env python3
"""Connect to headed Chrome/Brave on CDP and dump page state for flow exploration."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

CDP_URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:9223"
OUT = Path(__file__).parent / "explore"
OUT.mkdir(exist_ok=True)


def dump(page, label: str) -> None:
    safe = label.replace("/", "_").replace(" ", "_")[:80]
    page.screenshot(path=str(OUT / f"{safe}.png"), full_page=True)
    (OUT / f"{safe}.url").write_text(page.url, encoding="utf-8")
    (OUT / f"{safe}.html").write_text(page.content(), encoding="utf-8")

    roles: dict[str, list[str]] = {}
    for role in ["heading", "button", "link", "textbox", "checkbox", "tab"]:
        names: list[str] = []
        for node in page.get_by_role(role).all()[:40]:
            try:
                t = node.inner_text(timeout=500).strip().replace("\n", " ")[:120]
                if t:
                    names.append(t)
            except Exception:
                pass
        if names:
            roles[role] = names

    inputs = []
    for inp in page.locator("input, textarea, select").all()[:30]:
        try:
            inputs.append(
                {
                    "tag": inp.evaluate("el => el.tagName"),
                    "type": inp.get_attribute("type"),
                    "name": inp.get_attribute("name"),
                    "placeholder": inp.get_attribute("placeholder"),
                    "id": inp.get_attribute("id"),
                    "visible": inp.is_visible(),
                }
            )
        except Exception:
            pass

    meta = {"url": page.url, "title": page.title(), "roles": roles, "inputs": inputs}
    (OUT / f"{safe}.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(f"\n=== {label} ===")
    print(f"URL: {page.url}")
    print(f"Title: {page.title()}")
    for role, names in roles.items():
        print(f"  {role}: {names[:8]}")
    print(f"  inputs: {len(inputs)}")
    print(f"  saved → explore/{safe}.*")


def main() -> None:
    steps = sys.argv[2:] if len(sys.argv) > 2 else ["status"]
    pw = sync_playwright().start()
    browser = pw.chromium.connect_over_cdp(CDP_URL)
    context = browser.contexts[0] if browser.contexts else browser.new_context()
    page = context.pages[0] if context.pages else context.new_page()

    if "status" in steps:
        print(f"Connected CDP {CDP_URL}")
        print(f"Contexts: {len(browser.contexts)}")
        for i, p in enumerate(context.pages):
            print(f"  tab[{i}] {p.url}")

    for step in steps:
        if step == "status":
            continue
        if step.startswith("goto:"):
            url = step[5:]
            print(f"Navigating → {url}")
            page.goto(url, wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(2000)
            dump(page, url.split("//")[-1].replace("?", "_")[:60])
        elif step.startswith("dump:"):
            dump(page, step[5:])
        elif step == "tabs":
            for i, p in enumerate(context.pages):
                print(f"tab[{i}] {p.url}")

    pw.stop()


if __name__ == "__main__":
    main()
