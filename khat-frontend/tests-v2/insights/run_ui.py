# owner: insights — Playwright UI test with mocked API. Needs: npx vite --port 5184 --strictPort
# Run: python3 tests-v2/insights/run_ui.py   (from khat-frontend)
import json, os, re, sys, datetime as dt
from playwright.sync_api import sync_playwright

BASE = 'http://localhost:5184/tests-v2/insights/harness.html'
SHOTS = os.path.join(os.path.dirname(__file__), 'shots')
os.makedirs(SHOTS, exist_ok=True)
NOW = dt.datetime.now(dt.timezone.utc)
iso = lambda days=0, hours=0: (NOW - dt.timedelta(days=days, hours=hours)).isoformat().replace('+00:00', 'Z')

NAMES = ['Mustafa Kausar', 'Burhanuddin Shakir', 'Huzaifa Jamali', 'Taher Rangwala', 'Aliasger Lokhandwala', 'Murtaza Dawooji',
         'Yusuf Bharmal', 'Hatim Kapasi', 'Qutbuddin Ezzy', 'Ammar Nagpurwala', 'Juzar Vohra', 'Abbas Merchant']
SEGS = [
    ('needs_push', 'No activity for 38 days in FNK-C101 LV02 (still waiting on 1 reply from us)', 38),
    ('needs_encouragement', '2 pieces sent back for another try; average mark 4.5 is below the pass mark (6) in FNK-C101 LV03', 2),
    ('doing_well', 'Active today in FNK-C101 LV04 — average 9.3, distinction level', 0),
    ('needs_push', 'Has not started practising since joining 27 days ago', 27),
    ('dormant', 'No activity for 214 days (about 7 months) in Naskh — Cut Pen Certification Level 3', 214),
    ('new', 'Joined 3 days ago — has not sent any work yet. A warm welcome helps.', 3),
    ('doing_well', 'Active yesterday in THL-C201 LV01 — passing with an average of 7.4', 1),
    ('needs_encouragement', 'Needed 3 attempts on one step in FNK-C101 LV02', 4),
]

def student(i):
    seg, reason, idle = SEGS[i % len(SEGS)]
    return {
        'studentId': f'stu-{i}', 'name': NAMES[i % len(NAMES)] + ('' if i < len(NAMES) else f' {i}'), 'trNumber': str(26570 + i),
        'className': f'Class {5 + i % 4}', 'branchId': 'b-nbo', 'branchName': 'Nairobi', 'segment': seg, 'reason': reason,
        'courseCode': None if seg in ('new',) else ('FNK-C101' if 'FNK' in reason else None),
        'courseTitle': 'Naskh Style One' if seg != 'new' else None, 'currentLevel': None if seg == 'new' else 'LV02',
        'levelsPassed': i % 5, 'avgMark': None if seg in ('new', 'needs_push') else round(4.5 + (i % 5), 1),
        'revisions': 2 if seg == 'needs_encouragement' else 0, 'pendingReviews': 1 if i % 3 == 0 else 0,
        'lastActiveAt': None if 'not started' in reason or seg == 'new' else iso(idle), 'lastNudgedAt': iso(12) if seg == 'dormant' else None,
    }

STUDENTS = [student(i) for i in range(24)]
COUNTS = {'doing_well': 412, 'needs_encouragement': 96, 'needs_push': 131, 'dormant': 58, 'new': 17}

TEAM = {
    'generatedAt': iso(),
    'branches': [
        {'branchId': 'b-nbo', 'branchName': 'Nairobi', 'students': 714, 'active30d': 463, 'teachers': 4, 'studentsPerTeacher': 179,
         'submissions30d': 386, 'answeredWithin72hPct': 87.5, 'avgWaitHours': 29.4, 'pendingNow': 23, 'overdueNow': 3, 'autoMarked30d': 2, 'levelsPassed30d': 61},
        {'branchId': 'b-sur', 'branchName': 'Surat', 'students': 702, 'active30d': 288, 'teachers': 2, 'studentsPerTeacher': 351,
         'submissions30d': 240, 'answeredWithin72hPct': 52.1, 'avgWaitHours': 70.2, 'pendingNow': 64, 'overdueNow': 19, 'autoMarked30d': 11, 'levelsPassed30d': 22},
        {'branchId': 'b-kar', 'branchName': 'Karachi', 'students': 655, 'active30d': 401, 'teachers': 3, 'studentsPerTeacher': 218,
         'submissions30d': 301, 'answeredWithin72hPct': 94.0, 'avgWaitHours': 15.8, 'pendingNow': 9, 'overdueNow': 0, 'autoMarked30d': 0, 'levelsPassed30d': 48},
    ],
    'team': [
        {'teacherId': 't1', 'name': 'Ustadha Amina Noor', 'branchName': 'Nairobi', 'reviewed30d': 182, 'avgResponseHours': 18.2, 'pendingNow': 6, 'overdueNow': 0, 'divertedAway30d': 1, 'autoMarked30d': 0, 'shareOfBranchPct': 47.2},
        {'teacherId': 't2', 'name': 'Ustadh Ismail Khatri', 'branchName': 'Nairobi', 'reviewed30d': 121, 'avgResponseHours': 33.5, 'pendingNow': 11, 'overdueNow': 3, 'divertedAway30d': 6, 'autoMarked30d': 2, 'shareOfBranchPct': 31.3},
        {'teacherId': 't3', 'name': 'Ustadha Zahra Abbas', 'branchName': 'Nairobi', 'reviewed30d': 83, 'avgResponseHours': 41.0, 'pendingNow': 6, 'overdueNow': 0, 'divertedAway30d': 2, 'autoMarked30d': 0, 'shareOfBranchPct': 21.5},
        {'teacherId': 't4', 'name': 'Ustadh Hasan Patel', 'branchName': 'Nairobi', 'reviewed30d': 0, 'avgResponseHours': None, 'pendingNow': 0, 'overdueNow': 0, 'divertedAway30d': 0, 'autoMarked30d': 0, 'shareOfBranchPct': 0},
    ],
}

GROUPS = [
    {'id': 'g1', 'name': 'Ashara decoration team', 'purpose': 'Writing the excerpts for the hall decoration', 'branchId': 'b-nbo', 'memberCount': 8, 'createdByName': 'Ustadha Amina Noor', 'createdAt': iso(10), 'lastMessageAt': iso(0, 1)},
    {'id': 'g2', 'name': 'Advanced Thuluth cohort', 'purpose': 'Weekly mashq and critique', 'branchId': 'b-nbo', 'memberCount': 14, 'createdByName': 'Ustadh Ismail Khatri', 'createdAt': iso(30), 'lastMessageAt': iso(1)},
    {'id': 'g3', 'name': 'Naskh revision circle', 'purpose': None, 'branchId': 'b-nbo', 'memberCount': 5, 'createdByName': 'Ustadha Zahra Abbas', 'createdAt': iso(3), 'lastMessageAt': None},
]
MESSAGES = [
    {'id': 'm1', 'groupId': 'g1', 'senderId': 'staff-1', 'senderName': 'Ustadha Amina Noor', 'senderRole': 'teacher', 'body': 'Salaam everyone. We have been asked to write six excerpts for the hall. Please write the first one in Thuluth, 2 mm pen, by Thursday.', 'attachments': [{'storageKey': 'groups/ex.pdf', 'originalFilename': 'Excerpt-1-guide.pdf', 'contentType': 'application/pdf'}], 'createdAt': iso(1, 2)},
    {'id': 'm2', 'groupId': 'g1', 'senderId': 'stu-1', 'senderName': 'Mustafa Kausar', 'senderRole': 'student', 'body': 'InshaAllah, I will start today.', 'attachments': [], 'createdAt': iso(1, 1)},
    {'id': 'm3', 'groupId': 'g1', 'senderId': 'stu-2', 'senderName': 'Huzaifa Jamali', 'senderRole': 'student', 'body': 'Here is my first attempt — is the spacing of the alifs right?', 'attachments': [{'storageKey': 'groups/a.png', 'originalFilename': 'attempt.png', 'contentType': 'image/png'}], 'createdAt': iso(0, 3)},
    {'id': 'm4', 'groupId': 'g1', 'senderId': 'staff-1', 'senderName': 'Ustadha Amina Noor', 'senderRole': 'teacher', 'body': 'Very good. Keep the alifs a little taller and the baseline steady.', 'attachments': [], 'createdAt': iso(0, 1)},
]
MEMBERS = [{'userId': f'stu-{i}', 'name': NAMES[i], 'trNumber': str(26570 + i), 'className': 'Class 6', 'branchName': 'Nairobi', 'role': 'student', 'memberRole': 'member'} for i in range(5)]
CANDIDATES = [{'userId': f'stu-{i}', 'name': NAMES[i], 'trNumber': str(26570 + i), 'className': 'Class 7', 'branchName': 'Nairobi'} for i in range(5, 9)]

# 1x1 coloured PNG for image attachments
PNG = bytes.fromhex('89504e470d0a1a0a0000000d4948445200000001000000010806000000'
                    '1f15c4890000000d49444154789c63f8cfc0f01f0005000201e2a1b6c90000000049454e44ae426082')

def handler(route):
    url = route.request.url
    path = re.sub(r'^https?://[^/]+', '', url)
    method = route.request.method
    j = lambda body, status=200: route.fulfill(status=status, content_type='application/json', body=json.dumps(body), headers={'Access-Control-Allow-Origin': '*'})
    if method == 'OPTIONS':
        return route.fulfill(status=204, headers={'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*'})
    if path.startswith('/branches'):
        return j([{'id': 'b-kar', 'name': 'Karachi'}, {'id': 'b-nbo', 'name': 'Nairobi'}, {'id': 'b-sur', 'name': 'Surat'}])
    if path.startswith('/v2/policies/effective'):
        return j({'nudge.message_template': 'Salaam {name}, we miss your writing! It has been {days} days since your last practice in {course}. Even ten minutes today will keep your pen moving — we are here to help.'})
    if path.startswith('/v2/policies'):
        return j({'global': [], 'branches': {}, 'editableBranchIds': [], 'canEditGlobal': True})
    if path.startswith('/v2/insights/students'):
        q = dict(x.split('=', 1) for x in path.split('?', 1)[1].split('&')) if '?' in path else {}
        rows = [s for s in STUDENTS if not q.get('segment') or s['segment'] == q['segment']]
        lim = int(q.get('limit', 50)); off = int(q.get('offset', 0))
        total = sum(COUNTS.values()) if not q.get('segment') else COUNTS[q['segment']]
        return j({'counts': COUNTS, 'students': rows[off:off + min(lim, 12)], 'total': total})
    if path.startswith('/v2/insights/nudge'):
        body = json.loads(route.request.post_data or '{}')
        n = len(body.get('studentIds', []))
        return j({'sent': n, 'emailed': n, 'emailSkipped': 0, 'failedEmails': 0, 'skipped': 0, 'message': f'Sent to {n} students. {n} emails sent.'})
    if path.startswith('/v2/insights/team'):
        if 'branchId=b-nbo' in path:
            return j({**TEAM, 'branches': TEAM['branches'][:1]})
        return j(TEAM)
    if re.match(r'^/v2/groups/[^/]+/messages', path):
        if method == 'POST':
            body = json.loads(route.request.post_data or '{}')
            return j({'id': 'm-new', 'groupId': 'g1', 'senderId': 'staff-1', 'senderName': 'Ustadha Amina Noor', 'senderRole': 'teacher', 'body': body.get('body'), 'attachments': body.get('attachments', []), 'createdAt': iso()}, 201)
        return j([] if 'after=' in path else MESSAGES)
    if re.match(r'^/v2/groups/[^/]+/members', path):
        return j(MEMBERS if method == 'GET' else {'added': 1, 'skipped': 0})
    if re.match(r'^/v2/groups/[^/]+/candidates', path):
        return j(CANDIDATES)
    if path.startswith('/v2/groups'):
        return j(GROUPS)
    if path.startswith('/uploads/view'):
        return j({'url': 'http://localhost:4000/img/attempt.png'})
    if path.startswith('/img/'):
        return route.fulfill(status=200, content_type='image/png', body=PNG)
    return j({'error': 'not mocked ' + path}, 404)

errors = []
def shoot(page, name):
    page.wait_for_timeout(700)
    page.screenshot(path=os.path.join(SHOTS, name), full_page=True)
    print('shot', name)

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    for label, vw, vh in [('mobile', 390, 844), ('desktop', 1280, 800)]:
        ctx = browser.new_context(viewport={'width': vw, 'height': vh}, device_scale_factor=1)
        page = ctx.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        page.route('http://localhost:4000/**', handler)

        # Insights (teacher, then master admin with branch switcher)
        page.goto(f'{BASE}?page=insights&theme=sky')
        page.wait_for_selector('.v2-ins-row')
        shoot(page, f'insights-{label}.png')
        page.click('.v2-seg-card.v2-tone-danger')
        page.wait_for_timeout(400)
        page.locator('.v2-ins-check input').nth(0).check()
        page.locator('.v2-ins-check input').nth(1).check()
        shoot(page, f'insights-selected-{label}.png')
        if label == 'mobile':
            page.click('.v2-ins-sendbar .btn-primary')
        else:
            page.click('.v2-ins-send-desktop')
        page.wait_for_selector('.v2-ins-preview')
        page.screenshot(path=os.path.join(SHOTS, f'insights-composer-{label}.png'))
        print('shot', f'insights-composer-{label}.png')
        page.click('.v2-ins-modal-actions .btn-primary')
        page.wait_for_selector('.v2-ins-notice')
        assert 'Sent to 2 students' in page.inner_text('.v2-ins-notice')

        page.goto(f'{BASE}?page=insights&role=admin&theme=lavender')
        page.wait_for_selector('.v2-ins-branch select')
        shoot(page, f'insights-master-lavender-{label}.png')

        # Team report (master: all branches; teacher: single)
        page.goto(f'{BASE}?page=team&role=admin&theme=sky')
        page.wait_for_selector('.v2-team-branch')
        shoot(page, f'team-{label}.png')
        page.goto(f'{BASE}?page=team&theme=sage')
        page.wait_for_selector('.v2-team-who')
        page.route('http://localhost:4000/v2/insights/team**', lambda r: r.fulfill(status=200, content_type='application/json', body=json.dumps({**TEAM, 'branches': TEAM['branches'][:1]}), headers={'Access-Control-Allow-Origin': '*'}))
        page.click('.v2-range button:nth-child(1)')
        page.wait_for_timeout(500)
        shoot(page, f'team-teacher-sage-{label}.png')

        # Community — staff
        page.goto(f'{BASE}?page=community&mode=staff&theme=rose')
        page.wait_for_selector('.v2-com-item')
        shoot(page, f'community-list-{label}.png')
        page.click('.v2-com-item')
        page.wait_for_selector('.v2-com-msg')
        page.screenshot(path=os.path.join(SHOTS, f'community-chat-{label}.png'))
        print('shot', f'community-chat-{label}.png')
        page.fill('.v2-com-composer textarea', 'JazakAllah — please send by Thursday.')
        page.click('.v2-com-send')
        page.wait_for_selector('text=please send by Thursday')
        page.click('.v2-com-head-btn')
        page.wait_for_selector('.v2-com-candidates .v2-com-person')
        page.locator('.v2-com-candidates input').first.check()
        page.screenshot(path=os.path.join(SHOTS, f'community-members-{label}.png'))
        print('shot', f'community-members-{label}.png')
        page.keyboard.press('Escape')

        # Community — student
        page.goto(f'{BASE}?page=community&mode=student&theme=sky')
        page.wait_for_selector('.v2-com-item')
        page.click('.v2-com-item')
        page.wait_for_selector('.v2-com-msg')
        page.screenshot(path=os.path.join(SHOTS, f'community-student-{label}.png'))
        print('shot', f'community-student-{label}.png')

        # New group modal
        page.goto(f'{BASE}?page=community&mode=staff&theme=sky')
        page.wait_for_selector('.v2-com-hero .btn-primary')
        page.click('.v2-com-hero .btn-primary')
        page.wait_for_selector('.v2-com-modal input')
        page.screenshot(path=os.path.join(SHOTS, f'community-new-{label}.png'))
        print('shot', f'community-new-{label}.png')
        ctx.close()
    browser.close()

bad = [e for e in errors if 'not mocked' in e or 'Error' in e]
print('console errors:', len(errors))
for e in errors[:20]:
    print('  ', e[:200])
sys.exit(1 if bad else 0)
