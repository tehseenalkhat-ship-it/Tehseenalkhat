"""Playwright UI test for the frontend-student v2 pages (mocked backend on localhost:4000).

Run from khat-frontend:
  npx vite --config tests-v2/frontend-student/vite.harness.config.ts --port 5182 --strictPort &
  python3 -I tests-v2/frontend-student/run_ui.py
"""
import json
import os
import re
import sys
from urllib.parse import urlparse, parse_qs

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fixtures as fx  # noqa: E402

BASE = "http://localhost:5182/tests-v2/frontend-student/harness.html"
SHOTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots")
PDF = b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF"
SIZES = {"mobile": (390, 844), "desktop": (1280, 800)}
calls = []
DONE = set()
failures = []


def svg_for(key: str) -> str:
    seed = sum(ord(c) for c in key)
    hue = seed % 360
    return f"""<svg xmlns='http://www.w3.org/2000/svg' width='600' height='450' viewBox='0 0 600 450'>
<rect width='600' height='450' fill='hsl({hue},30%,95%)'/>
<g stroke='hsl({hue},20%,80%)'>{''.join(f"<line x1='30' x2='570' y1='{y}' y2='{y}'/>" for y in range(70, 430, 60))}</g>
<text x='300' y='250' font-size='120' text-anchor='middle' fill='hsl({hue},45%,25%)' font-family='serif'>ب ت ث</text></svg>"""


def make_handler(scenario: str):
    def handle(route):
        req = route.request
        url = urlparse(req.url)
        path, q, method = url.path, parse_qs(url.query), req.method
        calls.append(f"{method} {path}{'?' + url.query if url.query else ''}")

        def ok(data, status=200):
            route.fulfill(status=status, content_type="application/json", body=json.dumps(data))

        if path.startswith("/img/"):
            return route.fulfill(status=200, content_type="image/svg+xml", body=svg_for(path))
        if path == "/uploads/view":
            return ok({"url": f"http://localhost:4000/img/{q.get('key', ['x'])[0].replace('/', '_')}.svg"})
        if path in ("/notifications",):
            return ok([])
        if path == "/notifications/unread-count":
            return ok({"count": 0})
        if path == "/chat/threads":
            return ok({"courses": [], "teachers": []})
        if path.endswith("/profile"):
            return ok({})
        if path == "/branches":
            return ok(fx.BRANCHES)
        if path == "/v2/policies/effective":
            return ok(fx.EFFECTIVE)
        if path == "/v2/student/courses":
            if scenario == "catalog-empty":
                return ok([])
            if scenario == "catalog-error":
                return ok({"error": "The server is resting. Please try again in a minute."}, 500)
            return ok(fx.COURSE_LIST)
        m = re.match(r"^/v2/student/courses/([^/]+)$", path)
        if m:
            if scenario == "course-error":
                return ok({"error": "This course is not available for your branch."}, 403)
            cid = m.group(1)
            if scenario == "notenrolled":
                return ok(fx.COURSE_NOT_ENROLLED)
            if scenario == "nosize":
                return ok(fx.COURSE_NO_SIZE)
            data = json.loads(json.dumps(fx.COURSE_C2 if cid == "c2" else fx.COURSE_C1))
            for sid in DONE:
                if sid in data["stepStates"]:
                    data["stepStates"][sid]["done"] = True
                else:
                    data["stepStates"][sid] = {"stepId": sid, "done": True, "submissionStatus": None, "mark": None, "band": None, "attemptsUsed": 0, "unreadMessages": 0}
            return ok(data)
        if re.match(r"^/v2/student/courses/[^/]+/enroll$", path):
            return ok({"ok": True})
        if re.match(r"^/v2/student/steps/[^/]+/done$", path):
            sid = path.split("/")[4]
            (DONE.add if method == "POST" else DONE.discard)(sid)
            return route.fulfill(status=204, body="")
        if path == "/v2/student/preferences":
            return ok({"mistarSize": json.loads(req.post_data or "{}").get("mistarSize")})
        if path.startswith("/v2/downloads/"):
            return route.fulfill(status=200, content_type="application/pdf", headers={"Content-Disposition": 'attachment; filename="FNK-C101_LV02_worksheets.pdf"'}, body=PDF)
        if path.startswith("/v2/threads/"):
            return ok(fx.THREAD)
        if path == "/v2/badges/me":
            return ok([] if scenario == "merit-empty" else fx.BADGES)
        if path == "/v2/merit/me":
            return ok([] if scenario == "merit-empty" else fx.MERIT)
        if path == "/v2/competitions":
            if method == "POST":
                return ok({"id": "new"})
            return ok([] if scenario == "comp-empty" else fx.COMPETITIONS)
        if re.match(r"^/v2/competitions/[^/]+/entries$", path):
            return ok(fx.ENTRIES if method == "GET" else {"id": "e-new"})
        if re.match(r"^/v2/competitions/[^/]+/results$", path):
            return ok({"ok": True})
        if path == "/v2/highlights":
            return ok(fx.HIGHLIGHTS)
        if path == "/v2/showcase/requests":
            return ok(fx.SHOWCASE_REQUESTS if method == "GET" else {"id": "r9"})
        if re.match(r"^/v2/showcase/requests/[^/]+/decision$", path):
            return ok({"ok": True})
        if path == "/uploads/presign":
            return ok({"storageKey": "uploads/x.jpg", "uploadUrl": "http://localhost:4000/put"})
        if path == "/put":
            return route.fulfill(status=200, body="")
        return ok({"error": f"unmocked {path}"}, 404)
    return handle


def shot(page, name):
    page.wait_for_timeout(500)
    # sheets/bars are position:fixed — capture the viewport so they show where the student sees them
    fixed = page.locator(".v2s-sheet, .v2s-print-bar, .v2s-lightbox").count() > 0
    page.screenshot(path=os.path.join(SHOTS, f"{name}.png"), full_page=not fixed)


def open_view(browser, size, query, scenario="default"):
    w, h = SIZES[size]
    ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=1, accept_downloads=True)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text else None)
    page.route("http://localhost:4000/**", make_handler(scenario))
    page.route(re.compile(r"https://fonts\.(googleapis|gstatic)\.com/.*"), lambda r: r.abort())
    page.goto(f"{BASE}?{query}")
    page.wait_for_load_state("load")
    page.wait_for_timeout(1500)
    return ctx, page, errors


def check(cond, msg):
    if not cond:
        failures.append(msg)
        print("FAIL:", msg)


def run():
    os.makedirs(SHOTS, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
        for size in SIZES:
            # course page: enrolled, LV02 current with revision
            ctx, page, errors = open_view(browser, size, "view=course")
            check(page.get_by_text("Instructions for LV02").count() == 1, "LV02 instructions visible")
            check(page.get_by_text("Almost there").count() >= 1, "try again message")
            check(page.get_by_text("Opens when you pass the level assessment of LV02").count() == 1, "locked reason")
            shot(page, f"course-{size}")
            # open LV01 to see celebration
            page.get_by_role("button", name=re.compile("LV01")).first.click()
            page.wait_for_timeout(300)
            check(page.get_by_text("Distinction").count() >= 1, "distinction celebration")
            page.locator("#v2s-step-s13").scroll_into_view_if_needed()
            page.locator("#v2s-step-s13").screenshot(path=os.path.join(SHOTS, f"course-celebrate-{size}.png"))
            # mark done (optimistic)
            page.locator("#v2s-step-s22").get_by_role("button", name="Mark as done").click()
            page.wait_for_timeout(300)
            check(page.locator("#v2s-step-s22").get_by_text("Marked as done").count() == 1, "mark as done optimistic")
            check(any("POST /v2/student/steps/s22/done" in c for c in calls), "done POST called")
            # single download
            page.locator("#v2s-step-s21").get_by_role("button", name="Open step").click()
            with page.expect_download() as dl:
                page.locator("#v2s-step-s21").get_by_role("button", name=re.compile("Download Worksheet")).first.click()
            check(dl.value.suggested_filename.endswith(".pdf"), "download is pdf")
            check(any("/v2/downloads/step-file/" in c for c in calls), "stamped download endpoint")
            # print several
            page.get_by_role("button", name="Print several sheets").nth(1 if page.get_by_role("button", name="Print several sheets").count() > 1 else 0).click()
            page.wait_for_timeout(300)
            shot(page, f"course-print-mode-{size}")
            page.get_by_role("button", name=re.compile("Make one PDF")).click()
            page.wait_for_timeout(500)
            check(page.get_by_text("Your PDF is ready").count() == 1, "bundle ready sheet")
            check(any("POST /v2/downloads/bundle" in c for c in calls), "bundle POST")
            shot(page, f"course-pdf-ready-{size}")
            page.keyboard.press("Escape")
            # size picker
            page.get_by_role("button", name=re.compile("Mistar size")).click()
            page.wait_for_timeout(300)
            shot(page, f"course-size-picker-{size}")
            page.get_by_role("radio", name=re.compile("2 mm")).click()
            page.wait_for_timeout(400)
            check(any("PATCH /v2/student/preferences" in c for c in calls), "preferences PATCH")
            # showcase from passed step
            page.get_by_role("button", name="Showcase it").first.click()
            page.wait_for_timeout(600)
            shot(page, f"course-showcase-sheet-{size}")
            check(not [e for e in errors if "unmocked" not in e], f"course console errors: {errors}")
            ctx.close()
            DONE.clear()

            for scenario, name in (("notenrolled", "course-not-enrolled"), ("nosize", "course-first-size"), ("course-error", "course-error")):
                ctx, page, errors = open_view(browser, size, "view=course&clearSize=1", scenario)
                shot(page, f"{name}-{size}")
                ctx.close()

            ctx, page, errors = open_view(browser, size, "view=course&courseId=c2&clearSize=1")
            shot(page, f"course-flat-crash-{size}")
            ctx.close()

            for scenario, name in (("default", "catalog"), ("catalog-empty", "catalog-empty"), ("catalog-error", "catalog-error")):
                ctx, page, errors = open_view(browser, size, "view=catalog", scenario)
                if scenario == "default":
                    names = page.locator(".v2s-catalog-pen-title").all_inner_texts()
                    check(names[:2] == ["Normal pen", "Cut pen"], f"pen order {names}")
                shot(page, f"{name}-{size}")
                ctx.close()

            for scenario, name in (("default", "merit"), ("merit-empty", "merit-empty")):
                ctx, page, errors = open_view(browser, size, "view=merit", scenario)
                page.wait_for_timeout(500)
                shot(page, f"{name}-{size}")
                ctx.close()

            ctx, page, errors = open_view(browser, size, "view=comp-student")
            shot(page, f"comp-student-{size}")
            page.get_by_role("button", name=re.compile("Send my entry")).first.click()
            page.wait_for_timeout(300)
            shot(page, f"comp-student-entry-{size}")
            page.keyboard.press("Escape")
            page.get_by_role("tab", name="Results").click()
            shot(page, f"comp-student-results-{size}")
            ctx.close()

            ctx, page, errors = open_view(browser, size, "view=comp-admin")
            shot(page, f"comp-admin-{size}")
            page.get_by_role("button", name=re.compile("Create")).first.click()
            page.wait_for_timeout(400)
            shot(page, f"comp-admin-create-{size}")
            page.keyboard.press("Escape")
            page.wait_for_timeout(400)
            check(page.locator(".v2s-sheet").count() == 0, "create sheet closes on Escape")
            page.locator(".v2s-staff-row").first.click()
            page.wait_for_timeout(600)
            page.locator(".v2s-entry").nth(0).click()
            page.wait_for_timeout(300)
            shot(page, f"comp-admin-select-{size}")
            page.get_by_role("button", name="Select", exact=True).click()
            page.wait_for_timeout(300)
            shot(page, f"comp-admin-entries-{size}")
            page.get_by_role("button", name=re.compile("Publish results")).click()
            page.get_by_role("button", name="Publish now").click()
            page.wait_for_timeout(400)
            check(any("POST /v2/competitions/k1/results" in c for c in calls), "results POST")
            page.get_by_role("button", name=re.compile("All competitions")).click()
            page.get_by_role("tab", name="Showcase requests").click()
            page.wait_for_timeout(500)
            shot(page, f"comp-admin-showcase-{size}")
            ctx.close()

            ctx, page, errors = open_view(browser, size, "view=comp-staff", "comp-empty")
            shot(page, f"comp-staff-empty-{size}")
            ctx.close()

            ctx, page, errors = open_view(browser, size, "view=highlights")
            shot(page, f"highlights-{size}")
            check(page.get_by_text("Fatema from Marol was selected for the Ashara decoration").count() == 1, "highlight sentence")
            ctx.close()

        # dark-ish alternate theme check
        ctx, page, errors = open_view(browser, "mobile", "view=course&theme=lavender")
        shot(page, "course-theme-lavender-mobile")
        ctx.close()
        browser.close()
    print(f"{len(failures)} failures")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(run())
