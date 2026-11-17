"""Course page redesign — screenshots against the REAL backend with demo data.

  VITE_API_BASE_URL=http://127.0.0.1:4100 npx vite --port 5182 --strictPort --host 127.0.0.1 &
  python3 -I tests-v2/frontend-student/run_redesign.py
"""
import json
import os
import re
import sys
import urllib.request

from playwright.sync_api import sync_playwright

API = "http://127.0.0.1:4100"
APP = "http://127.0.0.1:5182/"
SHOTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots")
SIZES = {"mobile": (390, 844), "desktop": (1280, 800)}
failures = []


def api(path, token=None, body=None):
    req = urllib.request.Request(API + path, data=json.dumps(body).encode() if body is not None else None, method="POST" if body is not None else "GET")
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=15) as res:
        return json.loads(res.read())


def check(cond, msg):
    if not cond:
        failures.append(msg)
        print("FAIL:", msg)


def session(browser, size, email):
    login = api("/auth/login", body={"email": email, "password": "demo1234"})
    courses = api("/v2/student/courses", login["token"])
    cid = next(c["id"] for c in courses if c["code"] == "FNK-C101")
    w, h = SIZES[size]
    ctx = browser.new_context(viewport={"width": w, "height": h})
    ctx.add_init_script(f"""localStorage.setItem('khat_token', {json.dumps(login['token'])});
localStorage.setItem('khat_user', {json.dumps(json.dumps(login['user']))});
sessionStorage.setItem('khat.v2.param.courseId', {json.dumps(cid)});
sessionStorage.removeItem('khat.v2.param.stepId');""")
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.route(re.compile(r"https://fonts\.(googleapis|gstatic)\.com/.*"), lambda r: r.abort())
    return ctx, page, errors


def shot(page, name, full=True):
    page.add_style_tag(content=".global-notification-toasts{display:none!important}")
    page.wait_for_timeout(600)
    page.screenshot(path=os.path.join(SHOTS, f"redesign-{name}.png"), full_page=full)


def main():
    os.makedirs(SHOTS, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
        for size in SIZES:
            ctx, page, errors = session(browser, size, "student@demo.khat")
            page.goto(APP + "#v2-course")
            try:
                page.wait_for_selector(".v2s-course-nav", timeout=20000)
            except Exception:
                page.screenshot(path="/tmp/fs-debug.png"); print("debug", errors); raise
            page.wait_for_timeout(1500)
            check(page.locator(".v2s-stepper-pill").count() >= 2, "stepper pills")
            check(page.get_by_text(re.compile(r"Continue: LV0\d · ")).count() == 1, "continue button names level + task")
            shot(page, f"student-lv02-{size}")
            shot(page, f"student-top-{size}", full=False)
            # nav: scroll down, nav stays visible
            page.mouse.wheel(0, 1400)
            page.wait_for_timeout(500)
            check(page.locator(".v2s-course-nav").is_visible(), "sticky nav visible after scroll")
            shot(page, f"nav-scrolled-{size}", full=False)
            # tap LV01 in the stepper → opens LV01, then expand a step
            page.locator(".v2s-stepper-pill", has_text="LV01").click()
            page.wait_for_timeout(700)
            page.locator(".v2s-step-summary", has_text="Upload assessment work").first.click()
            page.wait_for_timeout(1200)
            shot(page, f"step-expanded-{size}", full=False)
            check(page.locator(".v2s-step-row.is-open").count() == 1, "only one step open")
            # My work + badges sections
            page.locator(".v2s-nav-sections button", has_text="My work").click()
            page.wait_for_timeout(800)
            shot(page, f"mywork-{size}", full=False)
            check(not errors, f"page errors {errors}")
            ctx.close()

            ctx, page, errors = session(browser, size, "fatema@demo.khat")
            page.goto(APP + "#v2-course")
            page.wait_for_selector(".v2s-course-nav", timeout=20000)
            page.wait_for_timeout(1500)
            shot(page, f"fatema-lv01-{size}")
            ctx.close()

            ctx, page, errors = session(browser, size, "student@demo.khat")
            page.goto(APP + "#catalog"); page.wait_for_timeout(1500); page.evaluate("location.hash = 'catalog'")
            page.wait_for_timeout(2500)
            shot(page, f"catalog-{size}")
            ctx.close()
        browser.close()
    print(f"{len(failures)} failures")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
