"""
admin-home UI test against the REAL backend (http://127.0.0.1:4100, demo data) + one "busy day" fixture.
  VITE_API_BASE_URL=http://127.0.0.1:4100 npx vite --port 5185 --strictPort --host 127.0.0.1 &
  python3 tests-v2/admin-home/run.py
"""
import json, os, urllib.request
from playwright.sync_api import sync_playwright

API = 'http://127.0.0.1:4100'
BASE = 'http://127.0.0.1:5185/tests-v2/admin-home/harness.html'
SHOTS = os.path.join(os.path.dirname(__file__), 'shots')
os.makedirs(SHOTS, exist_ok=True)
ERRORS = []

def login(email):
    req = urllib.request.Request(f'{API}/auth/login', data=json.dumps({'email': email, 'password': 'demo1234'}).encode(), headers={'content-type': 'application/json'})
    return json.load(urllib.request.urlopen(req))

B = lambda i, name, **kw: dict(dict(branchId=f'b{i}', name=name, students=700, active30d=420, waiting=6, overdue=0, avgWaitHours=20.5, answeredWithin72hPct=92, meritPending=0, teachersFull=0, teachers=3), **kw)
BUSY = {
    'scope': {'branchId': None, 'branchName': None, 'isMaster': True},
    'counts': {'waitingReview': 41, 'overdue72h': 5, 'oldestWaitHours': 101, 'meritToGiveThisMonth': 14, 'studentsNeedPush': 9, 'dormant': 12, 'coursesWithMissingFiles': 2, 'draftCourses': 1},
    'alerts': [
        {'severity': 'urgent', 'text': '3 entries in Marol have waited more than 3 days', 'actionLabel': 'Review inbox', 'actionPage': 'v2-inbox'},
        {'severity': 'urgent', 'text': 'All 2 teachers of Karachi are full — share the work or raise their limits', 'actionLabel': 'Review network', 'actionPage': 'v2-policies', 'actionParams': {'policiesView': 'network'}},
        {'severity': 'urgent', 'text': 'FNK-C101 is missing 6 files that students need', 'actionLabel': 'Course builder', 'actionPage': 'v2-builder', 'actionParams': {'courseId': 'c1'}},
        {'severity': 'soon', 'text': 'Merit points for November are waiting to be given (14 students)', 'actionLabel': 'Merit points', 'actionPage': 'v2-merit'},
        {'severity': 'soon', 'text': 'FNK-C101 LV02 has no assessment yet — students move on without being checked', 'actionLabel': 'Course builder', 'actionPage': 'v2-builder'},
        {'severity': 'soon', 'text': '9 students are stuck and need a push — see who and why', 'actionLabel': 'Student insights', 'actionPage': 'v2-insights'},
        {'severity': 'info', 'text': 'Surat has no merit officer yet', 'actionLabel': 'Branch policies', 'actionPage': 'v2-policies'},
        {'severity': 'info', 'text': "12 students haven't practised for 6 months — send a gentle message", 'actionLabel': 'Student insights', 'actionPage': 'v2-insights'},
    ],
    'branches': [B(1, 'Karachi', waiting=14, teachersFull=2, teachers=2, meritPending=6), B(2, 'Marol', overdue=3, waiting=9, avgWaitHours=61, answeredWithin72hPct=71),
                 B(3, 'Nairobi', teachers=4, meritPending=8), B(4, 'Sidhpur', students=310, waiting=2, teachers=2), B(5, 'Surat', overdue=2, waiting=10, avgWaitHours=50)],
    'month': '2026-11', 'generatedAt': '2026-11-10T09:00:00Z',
}

def run(p, who, email, busy=False, theme=''):
    data = login(email)
    browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    for w, h in [(390, 844), (1280, 800)]:
        ctx = browser.new_context(viewport={'width': w, 'height': h})
        page = ctx.new_page()
        page.on('response', lambda r: r.status >= 400 and '/auth' not in r.url and ERRORS.append(f'{who}: {r.status} {r.url}'))
        page.on('pageerror', lambda e: ERRORS.append(f'{who}: {e}'))
        if busy:
            page.route('**/v2/admin/today*', lambda r: r.fulfill(status=200, content_type='application/json', body=json.dumps(BUSY)))
        page.goto(BASE + '?boot=1')  # boot once to set the session (its 401 is expected)
        page.evaluate("([t,u]) => { localStorage.setItem('khat_token', t); localStorage.setItem('khat_user', JSON.stringify(u)); sessionStorage.clear(); }", [data['token'], data['user']])
        page.goto(f'{BASE}?theme={theme}')
        page.wait_for_selector('.v2-home-section', timeout=15000)
        page.wait_for_timeout(600)
        name = f"{who}{'-busy' if busy else ''}{'-' + theme if theme else ''}-{w}.png"
        page.screenshot(path=os.path.join(SHOTS, name), full_page=True)
        if who == 'master' and not busy and w == 1280:
            # branch switch through the select → Nairobi only
            opts = page.locator('.v2-home-switch select option').all_text_contents()
            assert 'All branches' in opts, opts
            page.select_option('.v2-home-switch select', label='Nairobi')
            page.wait_for_selector('#v2-home-branch', timeout=10000)
            page.wait_for_timeout(400)
            page.screenshot(path=os.path.join(SHOTS, f'master-nairobi-{w}.png'), full_page=True)
            # one-tap action → hash + param
            page.locator('.v2-home-todo-btn').first.click()
            print('after tap:', page.evaluate('location.hash'), page.evaluate('JSON.stringify(Object.assign({}, sessionStorage))'))
        if who == 'branchadmin' and w == 1280:
            tiles = page.locator('.v2-home-tile strong').all_text_contents()
            assert 'Logic sets' not in tiles and 'Data governance' not in tiles, tiles
            assert page.locator('.v2-home-switch').count() == 0
            print('branch admin tiles:', tiles)
        ctx.close()
    browser.close()

with sync_playwright() as p:
    run(p, 'master', 'master@demo.khat')
    run(p, 'branchadmin', 'branchadmin@demo.khat')
    run(p, 'master', 'master@demo.khat', busy=True)
    run(p, 'master', 'master@demo.khat', busy=True, theme='sage')
print('console errors:', ERRORS or 'none')
