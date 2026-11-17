"""Contract-shaped fixtures for /v2/* + /uploads/* (frontend-review). Stateful, records requests."""
import json, os, re, time
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse, parse_qs, unquote

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, 'fixtures')
API = 'http://localhost:4000'


def iso(dt):
    return dt.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')


NOW = datetime.now(timezone.utc)
TODAY = NOW.replace(hour=9, minute=12)
YDAY = TODAY - timedelta(days=1)


def read(name):
    with open(os.path.join(FIX, name), 'rb') as f:
        return f.read()


STUDENT = {'id': 'stu-1', 'name': 'Fatema Saifuddin', 'email': 'fatema@example.com', 'trNumber': '24117', 'className': 'Class 6 B', 'branchName': 'Nairobi'}
STEP = {'id': 'st-5', 'code': 'S05', 'title': 'Assessment — Mufradat', 'stepType': 'assessment', 'levelCode': 'LV01', 'levelDescription': 'مفردات', 'courseCode': 'FNK-C101', 'courseTitle': 'Naskh Foundations'}
FILES = [
    {'storageKey': 'sub/sheet1.png', 'originalFilename': 'sheet1.png', 'contentType': 'image/png', 'forStepId': 'st-1'},
    {'storageKey': 'sub/worksheet.pdf', 'originalFilename': 'worksheet.pdf', 'contentType': 'application/pdf', 'forStepId': 'st-2'},
    {'storageKey': 'sub/assess.png', 'originalFilename': 'assess.png', 'contentType': 'image/png', 'forStepId': 'st-5'},
]


def submission(sid, attempt, status, mark=None, band=None, code='TK-7F3K2', created=None, files=None, student_id='stu-1'):
    return {'id': sid, 'studentId': student_id, 'stepId': 'st-5', 'levelId': 'lv-1', 'courseId': 'c-101', 'attemptNo': attempt, 'status': status,
            'mark': mark, 'band': band, 'rubric': None, 'files': files or FILES, 'claimedById': None, 'claimedByName': None,
            'reviewedById': 't-2' if mark else None, 'reviewedByName': 'Sh Moiz bhai' if mark else None, 'reviewedAt': None,
            'createdAt': iso(created or YDAY), 'printCode': code, 'autoMarked': False, 'divertedCount': 0}


def msg(mid, role, kind, at, body=None, attachments=None, sub=None, ann=None, meta=None, read=True):
    names = {'student': ('stu-1', 'Fatema Saifuddin'), 'teacher': ('t-2', 'Sh Moiz bhai'), 'system': ('system', 'Course team')}
    sid, sname = names[role]
    return {'id': mid, 'studentId': 'stu-1', 'stepId': 'st-5', 'senderId': sid, 'senderName': sname, 'senderRole': role, 'kind': kind,
            'body': body, 'attachments': attachments or [], 'submissionId': sub, 'annotationId': ann, 'meta': meta or {},
            'createdAt': iso(at), 'readByStudent': read}


ANNOTATION = {'id': 'ann-1', 'submissionId': 'sub-1', 'fileStorageKey': 'sub/assess.png', 'pageIndex': 0,
              'strokes': [{'tool': 'circle', 'color': '#d62828', 'width': 5, 'points': [[0.55, 0.16], [0.75, 0.24]]},
                          {'tool': 'arrow', 'color': '#1d5fd1', 'width': 5, 'points': [[0.3, 0.42], [0.45, 0.33]]}],
              'pins': [{'n': 1, 'x': 0.65, 'y': 0.2, 'text': 'The alif leans — keep it upright, 3 nuqta tall.', 'voiceStorageKey': 'voice/v1.wav', 'durationSec': 3},
                       {'n': 2, 'x': 0.38, 'y': 0.38, 'text': None, 'voiceStorageKey': 'voice/v1.wav', 'durationSec': 3}],
              'flattenedStorageKey': None, 'createdById': 't-2', 'createdAt': iso(YDAY + timedelta(hours=5)), 'updatedAt': iso(YDAY + timedelta(hours=5))}


def thread(staff):
    subs = [submission('sub-1', 1, 'revision', 5, 'revision', created=YDAY)]
    msgs = [
        msg('m0', 'system', 'system', YDAY, 'Fatema opened step S05 — Assessment'),
        msg('m1', 'student', 'files', YDAY + timedelta(minutes=3), 'Salaam, here are my sheets for level 1.', FILES, sub='sub-1'),
        msg('m2', 'system', 'system', YDAY + timedelta(minutes=3), 'Sent for review · attempt 1'),
        msg('m3', 'teacher', 'voice', YDAY + timedelta(hours=5), None, [{'storageKey': 'voice/v1.wav', 'originalFilename': 'v.wav', 'contentType': 'audio/wav'}], meta={'durationSec': 3}),
        msg('m4', 'teacher', 'annotation', YDAY + timedelta(hours=5, minutes=1), None, sub='sub-1', ann='ann-1'),
        msg('m5', 'teacher', 'mark', YDAY + timedelta(hours=5, minutes=2), 'A good effort — look again at the alif height and the spacing between words, then send it back.', sub='sub-1', meta={'mark': 5, 'band': 'revision'}),
        msg('m6', 'student', 'text', TODAY, 'Shukran! I will practise the alif again tonight.'),
        msg('m7', 'teacher', 'text', TODAY + timedelta(minutes=20), 'Take your time. Use the 2 mm mistar for this one.', read=False),
    ]
    if staff:
        subs.append(submission('sub-2', 2, 'submitted', created=TODAY + timedelta(hours=1)))
        msgs.append(msg('m8', 'student', 'files', TODAY + timedelta(hours=1), 'Second try 🙏', FILES, sub='sub-2'))
    return {'student': STUDENT, 'step': STEP, 'messages': msgs, 'submissions': subs, 'annotations': [ANNOTATION], 'canReview': staff}


NAMES = [('Fatema Saifuddin', 'TK-7F3K2', 80, 2, 2), ('Mustafa Ezzi', 'TK-AB12C', 55, 0, 1), ('Zainab Husain', 'TK-Q2W3E', 30, 1, 1),
         ('Ammar Bhaiji', 'TK-R5T6Y', 12, 0, 1), ('Sakina Jamali', 'TK-U7I8O', 3, 0, 3), ('Ali Asgar', 'TK-P9L0K', 0.5, 0, 1)]


def inbox_items(status='open'):
    out = []
    for i, (name, code, hours, unread, attempt) in enumerate(NAMES):
        sid = 'sub-2' if i == 0 else f'sub-{10 + i}'
        stu = {**STUDENT, 'id': 'stu-1' if i == 0 else f'stu-{10 + i}', 'name': name, 'trNumber': str(24117 + i)}
        step = STEP if i % 2 == 0 else {**STEP, 'id': 'st-9', 'code': 'S03', 'title': 'Istinsakh — copy the line', 'stepType': 'istinsakh', 'levelCode': 'LV02', 'courseCode': 'THL-C201', 'courseTitle': 'Thuluth Intermediate'}
        sub = submission(sid, attempt, 'submitted' if status == 'open' else 'passed', None if status == 'open' else 8, None if status == 'open' else 'pass',
                         code=code, created=NOW - timedelta(hours=hours), student_id=stu['id'])
        if i % 2:
            sub['courseId'] = 'c-201'
            sub['files'] = [FILES[2]]
        out.append({'submission': sub, 'student': stu, 'step': step,
                    'lastMessage': {'body': 'Second try 🙏' if i == 0 else 'Please check my sheet', 'kind': 'files' if i != 2 else 'text', 'createdAt': iso(NOW - timedelta(hours=hours)), 'senderName': name},
                    'unreadForStaff': unread, 'waitingHours': hours})
    return out


def network():
    def r(tid, name, branch, bname, th, open_, away=None, spill=None):
        return {'teacherId': tid, 'name': name, 'branchId': branch, 'branchName': bname, 'threshold': th, 'openNow': open_, 'overdueNow': 0,
                'awayUntil': away, 'available': (away is None and open_ < th), 'spillTo': spill or [], 'receivesFrom': []}
    return {'reviewers': [
        r('t-1', 'Husain Teacher', 'nbo', 'Nairobi', 15, 8, spill=[{'teacherId': 't-2', 'name': 'Sh Moiz bhai', 'branchName': 'Nairobi', 'priority': 1}]),
        r('t-2', 'Sh Moiz bhai', 'nbo', 'Nairobi', 15, 14),
        r('t-3', 'Sh Tahir bhai', 'nbo', 'Nairobi', 10, 2, away=iso(NOW + timedelta(days=4))),
        r('t-4', 'Husain Ezzy', 'khi', 'Karachi', 20, 5),
    ], 'canEditTeacherIds': ['t-1'], 'canLinkAcrossBranches': False}


class Mock:
    def __init__(self):
        self.calls = []
        self.store = {
            'sub/sheet1.png': (read('sheet1.png'), 'image/png'),
            'sub/assess.png': (read('assess.png'), 'image/png'),
            'sub/worksheet.pdf': (read('worksheet.pdf'), 'application/pdf'),
            'voice/v1.wav': (read('voice.wav'), 'audio/wav'),
        }
        self.inbox = inbox_items()
        self.net = network()
        self.extra_msgs = []
        self.n = 0

    def find(self, method, part):
        return [c for c in self.calls if c['method'] == method and part in c['path']]

    def handle(self, route, request):
        cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*'}
        u = urlparse(request.url)
        path, q = u.path, parse_qs(u.query)
        if request.method == 'OPTIONS':
            return route.fulfill(status=204, headers=cors)
        body = None
        if request.post_data_buffer and 'application/json' in (request.headers.get('content-type') or ''):
            try:
                body = json.loads(request.post_data_buffer)
            except Exception:
                body = None
        self.calls.append({'method': request.method, 'path': path, 'query': q, 'body': body, 't': time.time()})

        def js(data, status=200):
            return route.fulfill(status=status, headers={**cors, 'Content-Type': 'application/json'}, body=json.dumps(data))

        def raw(data, ctype):
            return route.fulfill(status=200, headers={**cors, 'Content-Type': ctype}, body=data)

        if path == '/uploads/presign':
            self.n += 1
            key = f"{body['prefix']}/{self.n}-{body['filename']}"
            return js({'storageKey': key, 'uploadUrl': f'{API}/put/{key}'})
        if path.startswith('/put/'):
            self.store[path[5:]] = (request.post_data_buffer or b'', request.headers.get('content-type', 'application/octet-stream'))
            return route.fulfill(status=200, headers=cors, body='')
        if path == '/uploads/view':
            return js({'url': f"{API}/files/{q['key'][0]}"})
        if path in ('/uploads/file',) or path.startswith('/files/'):
            key = q['key'][0] if path == '/uploads/file' else unquote(path[7:])
            data, ctype = self.store.get(key, (read('assess.png'), 'image/png'))
            return raw(data, ctype)

        if path == '/v2/policies/effective':
            return js({'review.quick_marks': [4, 5, 6, 7, 8, 9, 10], 'assessment.rubric': [
                {'key': 'nuqta', 'label': 'Nuqta proportion', 'max': 2}, {'key': 'form', 'label': 'Letter form', 'max': 2},
                {'key': 'spacing', 'label': 'Spacing', 'max': 2}, {'key': 'baseline', 'label': 'Baseline', 'max': 2}, {'key': 'pen', 'label': 'Pen control', 'max': 2}],
                'assessment.bands': {'revisionMax': 5, 'passMax': 8}, 'uploads.max_files': 20, 'assessment.max_attempts': 3})
        if path == '/v2/step-types':
            return js([{'typeKey': 'assessment', 'label': 'Assessment', 'fileCodes': ['AW'], 'studentAction': 'download_upload', 'feedbackMode': 'annotate_mark', 'hasMarks': True, 'gatesProgress': True, 'awardsBadge': True, 'requiresPriorUploads': True, 'defaultInstructions': '', 'sortOrder': 1, 'isSystem': True},
                       {'typeKey': 'istinsakh', 'label': 'Istinsakh', 'fileCodes': ['IS'], 'studentAction': 'upload', 'feedbackMode': 'feedback', 'hasMarks': False, 'gatesProgress': False, 'awardsBadge': False, 'requiresPriorUploads': False, 'defaultInstructions': '', 'sortOrder': 2, 'isSystem': True}])
        if path == '/v2/review/inbox':
            st = (q.get('status') or ['open'])[0]
            items = self.inbox if st == 'open' else inbox_items('done')[:3]
            term = (q.get('q') or [''])[0].lower()
            if term:
                items = [i for i in items if term in i['student']['name'].lower()]
            return js(items)
        m = re.match(r'^/v2/review/submissions/([^/]+)/(claim|decision)$', path)
        if m:
            sid, action = m.groups()
            item = next((i for i in self.inbox if i['submission']['id'] == sid), None)
            sub = dict(item['submission']) if item else submission(sid, 1, 'submitted')
            if action == 'decision':
                self.inbox = [i for i in self.inbox if i['submission']['id'] != sid]
                mark = (body or {}).get('mark')
                sub.update({'status': 'passed' if (mark or 0) > 5 else ('reviewed' if mark is None else 'revision'), 'mark': mark})
            return js(sub)
        if path == '/v2/annotations':
            if request.method == 'PUT':
                return js({**body, 'id': 'ann-new', 'createdById': 't-1', 'createdAt': iso(NOW), 'updatedAt': iso(NOW)})
            return js([ANNOTATION] if q.get('submissionId', [''])[0] in ('sub-1', 'sub-2') else [])
        m = re.match(r'^/v2/threads/([^/]+)(/messages|/submit)?$', path)
        if m:
            if m.group(2) == '/messages':
                mm = msg(f'x{len(self.extra_msgs)}', 'teacher' if body.get('studentId') else 'student', body['kind'], datetime.now(timezone.utc), body.get('body'), body.get('attachments'), meta=body.get('meta'))
                self.extra_msgs.append(mm)
                return js(mm)
            if m.group(2) == '/submit':
                s = submission('sub-9', 2, 'submitted', files=body['files'], created=datetime.now(timezone.utc))
                self.extra_msgs.append(msg('xs', 'student', 'files', datetime.now(timezone.utc), body.get('note'), body['files'], sub='sub-9'))
                self.submitted = s
                return js(s)
            t = thread(staff='studentId' in q)
            t['messages'] += self.extra_msgs
            if getattr(self, 'submitted', None):
                t['submissions'].append(self.submitted)
            return js(t)
        if path == '/v2/ai/refine-comment':
            return js({'refined': f"Well done, {body.get('studentName') or 'dear student'} — your letters are taking shape. Keep the alif upright and give each word a little more space on the baseline.", 'usedAi': True})
        m = re.match(r'^/v2/review/by-code/(.+)$', path)
        if m:
            code = unquote(m.group(1))
            item = next((i for i in inbox_items() if i['submission']['printCode'] == code), None)
            return js(item) if item else js({'error': 'No submission with this code'}, 404)
        if path == '/v2/review/scan-return':
            names = {i['submission']['id']: i['student']['name'] for i in inbox_items()}
            return js([{'submissionId': it['submissionId'], 'ok': True, 'studentName': names.get(it['submissionId'], '?'), 'message': f"{len(it['pageStorageKeys'])} pages sent" + (f", mark {it['mark']}/10" if it.get('mark') else '')} for it in body['items']])
        if path == '/v2/review/print-pack':
            return raw(read('scan.pdf'), 'application/pdf')
        if path == '/v2/review/network':
            return js(self.net)
        m = re.match(r'^/v2/review/network/([^/]+)$', path)
        if m:
            me = next(r for r in self.net['reviewers'] if r['teacherId'] == m.group(1))
            if 'threshold' in body: me['threshold'] = body['threshold']
            if 'awayUntil' in body: me['awayUntil'] = body['awayUntil']
            if 'spillTo' in body:
                byid = {r['teacherId']: r for r in self.net['reviewers']}
                me['spillTo'] = [{'teacherId': t, 'name': byid[t]['name'], 'branchName': byid[t]['branchName'], 'priority': i + 1} for i, t in enumerate(body['spillTo'])]
            me['available'] = not me['awayUntil'] and me['openNow'] < me['threshold']
            return js(me)
        return js({'error': f'not mocked: {request.method} {path}'}, 404)
