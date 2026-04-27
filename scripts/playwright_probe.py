from __future__ import annotations

from pathlib import Path

from playwright.sync_api import sync_playwright


def main() -> None:
    edge_candidates = [
        Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
        Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
    ]
    executable = next((candidate for candidate in edge_candidates if candidate.exists()), None)

    with sync_playwright() as playwright:
        launch_kwargs = {"headless": True}
        if executable:
            launch_kwargs["executable_path"] = str(executable)
        browser = playwright.chromium.launch(**launch_kwargs)
        page = browser.new_page(viewport={"width": 1440, "height": 1024})
        page.on("console", lambda msg: print(f"console[{msg.type}]: {msg.text}"))
        page.goto("http://127.0.0.1:4173", wait_until="networkidle")
        page.get_by_label("用户名").fill("manager")
        page.get_by_label("密码").fill("manager123")
        page.get_by_role("button", name="登录").click()
        page.wait_for_timeout(5000)
        print("URL:", page.url)
        print("BODY:")
        print(page.locator("body").inner_text())
        page.screenshot(path="probe.png", full_page=True)
        browser.close()


if __name__ == "__main__":
    main()

