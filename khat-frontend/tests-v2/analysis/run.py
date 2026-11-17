"""
Smart analysis UI test against the REAL backend (http://127.0.0.1:4100, demo data).
  VITE_API_BASE_URL=http://127.0.0.1:4100 npx vite --port 5186 --strictPort --host 127.0.0.1 &
  python3 tests-v2/analysis/run.py
"""
import json, os, sys, urllib.request
from playwright.sync_api import sync_playwright

API = 'http://127.0.0.1:4100'
BASE = 'http://127.0.0.1:5186/tests-v2/analysis/harness.html'
SHOTS = os.path.join(os.path.dirname(__file__), 'shots')
os.makedirs(SHOTS, exist_ok=True)
ERRORS = []
SIZES = [(390, 844), (1280, 800)]

def login(email):
    req = urllib.request.Request(f'{API}/auth/login', data=json.dumps({'email': email, 'password': 'demo1234'}).encode(), headers={'content-type': 'application/json'})
    return json.load(urllib.request.urlopen(req))

def open_page(browser, who, email, query, w, h):
    data = login(email)
    ctx = browser.new_context(viewport={'width': w, 'height': h})
    page = ctx.new_page()
    page.on('response', lambda r: r.status >= 400 and '/auth' not in r.url and ERRORS.append(f'{who}: {r.status} {r.url}'))
    page.on('pageerror', lambda e: ERRORS.append(f'{who}: {e}'))
    page.on('console', lambda m: m.type == 'error' and 'Failed to load resource' not in m.text and ERRORS.append(f'{who} console: {m.text}'))
    page.goto(BASE + '?boot=1')
    page.evaluate("([t,u]) => { localStorage.setItem('khat_token', t); localStorage.setItem('khat_user', JSON.stringify(u)); sessionStorage.clear(); }", [data['token'], data['user']])
    ERRORS[:] = [e for e in ERRORS if '/v2/analysis/me' not in e or '401' not in e]  # boot page has no session yet
    page.goto(f'{BASE}?{query}')
    return ctx, page

def shot(page, name):
    page.screenshot(path=os.path.join(SHOTS, name), full_page=True)

def main():
    theme = sys.argv[1] if len(sys.argv) > 1 else ''
    suffix = f'-{theme}' if theme else ''
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        for w, h in SIZES:
            # 1) student: My progress
            ctx, page = open_page(browser, 'student', 'student@demo.khat', f'page=my-progress&theme={theme}', w, h)
            page.wait_for_selector('.v2-an-steps', timeout=20000)
            page.wait_for_selector('.v2-an-line svg', timeout=5000)
            page.wait_for_timeout(500)
            body = page.inner_text('main')
            for must in ['Salaam Mustafa', 'Your next steps', 'What your teachers keep telling you', 'more level', 'Levels passed']:
                assert must in body, must
            for bad in ['fail', 'weak', 'poor', 'bad ']:
                assert bad not in body.lower(), f'discouraging word: {bad}'
            shot(page, f'student-my-progress{suffix}-{w}.png')
            if w == 1280 and not theme:
                page.locator('.v2-an-step-btn').first.click()
                page.wait_for_timeout(300)
                assert page.evaluate('location.hash') == '#v2-course', page.evaluate('location.hash')
                assert page.evaluate("sessionStorage.getItem('khat.v2.param.courseId')"), 'courseId param not set'
            ctx.close()

            # 2) teacher: insights → drawer
            ctx, page = open_page(browser, 'teacher', 'teacher@demo.khat', f'page=insights&theme={theme}', w, h)
            page.wait_for_selector('.v2-ins-row', timeout=20000)
            page.locator('.v2-an-name-btn', has_text='Mustafa Saifee').click()
            page.wait_for_selector('.v2-an-drawer .v2-an-message textarea', timeout=20000)
            page.wait_for_timeout(500)
            msg = page.input_value('.v2-an-drawer .v2-an-message textarea')
            assert msg.startswith('Salaam Mustafa'), msg
            page.screenshot(path=os.path.join(SHOTS, f'staff-drawer{suffix}-{w}.png'))
            if w == 390:  # also the whole drawer content, scrolled
                page.locator('.v2-an-drawer-body').evaluate('el => el.scrollTop = 900')
                page.wait_for_timeout(200)
                page.screenshot(path=os.path.join(SHOTS, f'staff-drawer-scrolled{suffix}-{w}.png'))
            if w == 1280 and not theme:
                page.click('.v2-an-send')
                page.wait_for_selector('.v2-an-sent', timeout=10000)
                page.screenshot(path=os.path.join(SHOTS, f'staff-drawer-sent-{w}.png'))
            page.keyboard.press('Escape')
            page.wait_for_selector('.v2-an-drawer', state='detached', timeout=3000)

            # 3) class view
            page.get_by_role('tab', name='Class view').click()
            page.wait_for_selector('.v2-an-hist', timeout=20000)
            page.wait_for_timeout(600)
            assert 'Stuck on the same level' in page.inner_text('main')
            shot(page, f'staff-class-view{suffix}-{w}.png')
            if w == 1280 and not theme:
                # course filter + one-tap nudge + open drawer from stuck list
                page.select_option('.v2-an-class-filters select >> nth=0', index=1)
                page.wait_for_timeout(800)
                btn = page.locator('.v2-an-nudge').first
                if btn.count():
                    btn.click()
                    page.wait_for_selector('.v2-an-nudge:has-text("Sent")', timeout=10000)
                    page.locator('.v2-an-stuck-who').first.click()
                    page.wait_for_selector('.v2-an-drawer .v2-an-cards', timeout=15000)
                    page.wait_for_timeout(400)
                    page.screenshot(path=os.path.join(SHOTS, f'staff-class-drawer-{w}.png'))
            ctx.close()

            # 4) master admin: class view across all branches
            if not theme:
                ctx, page = open_page(browser, 'master', 'master@demo.khat', 'page=insights', w, h)
                page.wait_for_selector('.v2-ins-row', timeout=20000)
                page.get_by_role('tab', name='Class view').click()
                page.wait_for_selector('.v2-an-kpis', timeout=20000)
                page.wait_for_timeout(500)
                shot(page, f'master-class-view-{w}.png')
                ctx.close()
        browser.close()
    print('\n'.join(ERRORS) if ERRORS else 'no errors')
    print('OK')

main()
