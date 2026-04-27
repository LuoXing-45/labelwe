from __future__ import annotations

from datetime import datetime
from pathlib import Path

from playwright.sync_api import Browser, Page, expect, sync_playwright


def launch_browser(playwright):
    edge_candidates = [
        Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
        Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
    ]
    executable = next((candidate for candidate in edge_candidates if candidate.exists()), None)
    launch_kwargs = {"headless": True}
    if executable:
        launch_kwargs["executable_path"] = str(executable)
    return playwright.chromium.launch(**launch_kwargs)


def new_page(browser: Browser) -> Page:
    context = browser.new_context(viewport={"width": 1440, "height": 1024})
    return context.new_page()


def login(page: Page, username: str, password: str) -> None:
    page.goto("http://127.0.0.1:4173", wait_until="networkidle")
    page.get_by_label("用户名", exact=True).fill(username)
    page.get_by_label("密码", exact=True).fill(password)
    page.get_by_role("button", name="登录").click()
    page.wait_for_load_state("networkidle")
    expect(page.get_by_text("协同检测标注控制台")).to_be_visible()


def main() -> None:
    task_title = f"自动化验收任务{datetime.now():%Y%m%d%H%M%S}"
    task_description = "Playwright smoke acceptance flow"

    with sync_playwright() as playwright:
        browser = launch_browser(playwright)

        manager_page = new_page(browser)
        manager_page.on("console", lambda msg: print(f"manager-console[{msg.type}]: {msg.text}"))
        login(manager_page, "manager", "manager123")

        expect(manager_page.get_by_text("任务分发工作台")).to_be_visible()
        manager_page.locator("label.file-card").filter(has_text="yard-overview.svg").locator("input[type='checkbox']").check()
        manager_page.get_by_label("任务标题").fill(task_title)
        manager_page.get_by_label("任务说明").fill(task_description)
        manager_page.locator(".composer-form select").nth(0).select_option(label="Annotation Owner")
        manager_page.locator(".composer-form select").nth(1).select_option(label="Primary Reviewer")
        manager_page.get_by_role("button", name="创建任务").click()
        expect(manager_page.get_by_text("任务已创建")).to_be_visible()
        manager_page.locator(".task-card-link").filter(has_text=task_title).first.click()
        manager_page.wait_for_load_state("networkidle")
        expect(manager_page.get_by_text(task_title)).to_be_visible()

        annotator_page = new_page(browser)
        annotator_page.on("console", lambda msg: print(f"annotator-console[{msg.type}]: {msg.text}"))
        login(annotator_page, "annotator", "annotator123")
        annotator_page.locator(".task-card-link").filter(has_text=task_title).first.click()
        annotator_page.wait_for_load_state("networkidle")
        expect(annotator_page.get_by_role("button", name="提交审核")).to_be_enabled()
        annotator_page.get_by_role("button", name="标记无目标").click()
        expect(annotator_page.get_by_text("NO OBJECT")).to_be_visible()
        expect(annotator_page.get_by_text("工作副本已自动保存")).to_be_visible(timeout=5000)
        annotator_page.get_by_role("button", name="提交审核").click()
        expect(annotator_page.get_by_role("button", name="提交审核")).to_be_disabled()

        reviewer_page = new_page(browser)
        reviewer_page.on("console", lambda msg: print(f"reviewer-console[{msg.type}]: {msg.text}"))
        login(reviewer_page, "reviewer", "reviewer123")
        reviewer_page.locator(".task-card-link").filter(has_text=task_title).first.click()
        reviewer_page.wait_for_load_state("networkidle")
        expect(reviewer_page.get_by_text("审核工作台")).to_be_visible()
        reviewer_page.get_by_role("button", name="批量通过").click()
        expect(reviewer_page.get_by_text("approved", exact=True)).to_be_visible()
        reviewer_page.screenshot(path="smoke-e2e.png", full_page=True)
        browser.close()


if __name__ == "__main__":
    main()
