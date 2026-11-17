"""
frontend-admin UI test: mounts the v2 admin pages through harness.html (vite on :5181),
mocks every backend call on http://localhost:4000 with contract-shaped fixtures and
takes screenshots at 390x844 and 1280x800 into ./shots.

  cd khat-frontend && npx vite --port 5181 --strictPort &
  python3 tests-v2/frontend-admin/run.py [filter]
"""
import json, os, re, sys, base64
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright

BASE = 'http://localhost:5181/tests-v2/frontend-admin/harness.html'
SHOTS = os.path.join(os.path.dirname(__file__), 'shots')
os.makedirs(SHOTS, exist_ok=True)
ONLY = sys.argv[1] if len(sys.argv) > 1 else ''
ERRORS = []

BRANCHES = [{'id': 'b-nbo', 'name': 'Nairobi'}, {'id': 'b-sur', 'name': 'Surat'}, {'id': 'b-khi', 'name': 'Karachi'}, {'id': 'b-mar', 'name': 'Marol'}, {'id': 'b-sid', 'name': 'Sidhpur'}]
STAFF = [
    {'id': 'u1', 'role': 'admin', 'name': 'Husain Jamaali', 'email': 'husain@example.com', 'branch_id': 'b-nbo', 'is_coordinator': False},
    {'id': 'u2', 'role': 'teacher', 'name': 'Moiz Nagpurwala', 'email': 'moiz@example.com', 'branch_id': 'b-nbo', 'is_coordinator': True},
    {'id': 'u3', 'role': 'teacher', 'name': 'Husain Ezzy', 'email': 'ezzy@example.com', 'branch_id': 'b-khi', 'is_coordinator': False},
    {'id': 'u4', 'role': 'teacher', 'name': 'Taher Surti', 'email': 'taher@example.com', 'branch_id': 'b-sur', 'is_coordinator': False},
    {'id': 'u5', 'role': 'admin', 'name': 'Aliasgar Surat', 'email': 'ali@example.com', 'branch_id': 'b-sur', 'is_coordinator': False},
]

STEP_TYPES = [
    dict(typeKey='worksheet', label='Worksheet', fileCodes=['MT', 'PW', 'WS', 'HF'], studentAction='watch_download', feedbackMode='none', hasMarks=False, gatesProgress=False, awardsBadge=False, requiresPriorUploads=False, defaultInstructions='Watch the video, download the sheet and practise until it feels easy.', sortOrder=10, isSystem=True),
    dict(typeKey='video', label='Video', fileCodes=['VD'], studentAction='watch_download', feedbackMode='none', hasMarks=False, gatesProgress=False, awardsBadge=False, requiresPriorUploads=False, defaultInstructions='Watch the whole video once before you write.', sortOrder=15, isSystem=True),
    dict(typeKey='kitabat', label='Kitabat', fileCodes=['KT'], studentAction='watch_download', feedbackMode='none', hasMarks=False, gatesProgress=False, awardsBadge=False, requiresPriorUploads=False, defaultInstructions='', sortOrder=20, isSystem=True),
    dict(typeKey='raudat_hidayaat', label='Raudat Hidayaat', fileCodes=['RH'], studentAction='watch_download', feedbackMode='none', hasMarks=False, gatesProgress=False, awardsBadge=False, requiresPriorUploads=False, defaultInstructions='', sortOrder=30, isSystem=True),
    dict(typeKey='istinsakh', label='Istinsakh', fileCodes=['IS'], studentAction='upload', feedbackMode='feedback', hasMarks=False, gatesProgress=False, awardsBadge=False, requiresPriorUploads=False, defaultInstructions='Copy the page carefully and upload a clear photo.', sortOrder=40, isSystem=True),
    dict(typeKey='assessment', label='Assessment', fileCodes=['AW', 'AS'], studentAction='download_upload', feedbackMode='annotate_mark', hasMarks=True, gatesProgress=True, awardsBadge=True, requiresPriorUploads=True, defaultInstructions='Download the assessment sheet, write it, and upload it with your worksheets of this level.', sortOrder=50, isSystem=True),
    dict(typeKey='final_submission', label='Final submission', fileCodes=['FS'], studentAction='upload', feedbackMode='annotate_mark', hasMarks=True, gatesProgress=True, awardsBadge=True, requiresPriorUploads=False, defaultInstructions='', sortOrder=60, isSystem=True),
]
COURSE_TYPES = [
    dict(typeKey='certification', label='Certification', allowedStepTypes=['worksheet', 'video', 'kitabat', 'raudat_hidayaat', 'assessment', 'final_submission'], hasLevels=True, finalSubmission=True, sortOrder=10),
    dict(typeKey='crash', label='Crash course', allowedStepTypes=['worksheet', 'video', 'istinsakh'], hasLevels=False, finalSubmission=False, sortOrder=20),
    dict(typeKey='mashq', label='Mashq', allowedStepTypes=['worksheet', 'istinsakh'], hasLevels=False, finalSubmission=False, sortOrder=30),
]
FILE_CODES = [
    dict(fileCode='MT', stepType='worksheet', fileRole='worksheet', label='Mufradat worksheet'),
    dict(fileCode='PW', stepType='worksheet', fileRole='worksheet', label='Practice worksheet'),
    dict(fileCode='KT', stepType='kitabat', fileRole='worksheet', label='Kitabat'),
    dict(fileCode='RH', stepType='raudat_hidayaat', fileRole='worksheet', label='Raudat Hidayaat'),
    dict(fileCode='AW', stepType='assessment', fileRole='assessment_sheet', label='Assessment sheet'),
    dict(fileCode='IS', stepType='istinsakh', fileRole='worksheet', label='Istinsakh'),
    dict(fileCode='VD', stepType='video', fileRole='video', label='Video'),
    dict(fileCode='RF', stepType='', fileRole='reference', label='Reference'),
]


def sfile(i, role, size, step, lv, v=1, ext='jpg', code='FNK-C101', ftype='MT'):
    name = f'{code}_{ftype}_{lv}_{step}_P01_{size}_v{v}.{ext}' if size else f'{code}_{ftype}_{lv}_{step}_v{v}.{ext}'
    return dict(id=f'f{i}', role=role, sizeCode=size, page='P01', version=v, isCurrent=True, storageKey=f'course-files/{name}', originalFilename=name,
                canonicalName=name, contentType='video/mp4' if ext == 'mp4' else 'image/jpeg', byteSize=120000, source='upload', uploadedAt='2026-11-08T09:12:00Z', uploadedByName='Husain Jamaali')


def build_course():
    levels = []
    descs = ['مفردات', 'مركبات', 'كلمات', 'جمل']
    fid = 0
    for li in range(4):
        lv = f'LV0{li + 1}'
        steps = []
        n = [6, 5, 4, 3][li]
        for si in range(n):
            sc = f'S0{si + 1}'
            last = si == n - 1
            files = []
            if si == 0:
                fid += 1
                files.append(sfile(fid, 'video', None, sc, lv, ext='mp4', ftype='VD'))
            sizes = ['07', '10', '20'] if not (li == 1 and si == 2) else ['07', '20']
            for sz in sizes:
                fid += 1
                files.append(sfile(fid, 'assessment_sheet' if last else 'worksheet', sz, sc, lv, ftype='AW' if last else 'MT'))
            if si == 1:
                fid += 1
                files.append(dict(sfile(fid, 'reference', None, sc, lv, ftype='RF'), sizeCode=None))
            steps.append(dict(
                id=f's{li}{si}', levelId=f'l{li}', code=sc, orderIndex=si,
                title=('Assessment — ' + descs[li]) if last else ['Alif and baa', 'Jeem family', 'Daal and raa', 'Seen and sheen', 'Saad and taa', 'Ain and fa'][si],
                stepType='assessment' if last else ('video' if False else 'worksheet'), template=None,
                message='Write this sheet twice before you upload. Keep the nuqta size the same everywhere.' if (li == 0 and si == 2) else None,
                maxMarks=10 if last else None, badgeCode=None, status='hidden' if (li == 0 and si == 4) else 'published',
                source='file', files=files, missing=['worksheet 1 mm'] if (li == 1 and si == 2) else [],
            ))
        levels.append(dict(id=f'l{li}', courseId='c1', code=lv, orderIndex=li, description=descs[li],
                           instructions='1. Watch the video.\n2. Download the reference image.\n3. Do the worksheet.\n4. Upload your work.' if li == 0 else None,
                           badgeCode=None, status='published' if li < 3 else 'hidden', steps=steps))
    return dict(
        id='c1', code='FNK-C101', title='Foundation Naskh — Normal Pen', titleAr='النسخ الأساسي', penType='normal', courseType='certification', khatTypeId='k1',
        status='published', structureVersion=2, branchIds=[], mistarSizes=['07', '10', '20'],
        counts=dict(levels=4, steps=18, files=fid, missing=1, students=214), updatedAt='2026-11-09T10:00:00Z',
        description='The first certification course in Naskh with a normal pen.', instructions=None,
        driveFolderUrl='https://drive.google.com/drive/folders/abc', masterRow={'Course Code': 'FNK-C101', 'Pen Type': 'Normal', 'Course Type': 'Certification', 'Levels': '4', 'Status': 'Live'}, levels=levels,
    )


COURSE = build_course()


def summary(c):
    return {k: c[k] for k in ['id', 'code', 'title', 'titleAr', 'penType', 'courseType', 'khatTypeId', 'status', 'structureVersion', 'branchIds', 'mistarSizes', 'counts', 'updatedAt']}


COURSES = [summary(COURSE)] + [
    dict(id='c2', code='FNK-C102', title='Naskh Kitabat', titleAr='كتابة النسخ', penType='normal', courseType='certification', khatTypeId='k1', status='draft', structureVersion=2, branchIds=['b-nbo', 'b-khi'], mistarSizes=['10', '20'], counts=dict(levels=2, steps=9, files=27, missing=0, students=0), updatedAt=None),
    dict(id='c3', code='THC-C201', title='Thuluth Cut Pen', titleAr='الثلث', penType='cut', courseType='certification', khatTypeId='k2', status='held', structureVersion=2, branchIds=['b-sur'], mistarSizes=['20', '30'], counts=dict(levels=6, steps=31, files=88, missing=4, students=57), updatedAt=None),
    dict(id='c4', code='CRS-A101', title='Crash course: Naskh in 10 days', titleAr=None, penType='normal', courseType='crash', khatTypeId='k1', status='published', structureVersion=2, branchIds=[], mistarSizes=['NP'], counts=dict(levels=1, steps=10, files=10, missing=0, students=96), updatedAt=None),
    dict(id='c5', code='MSQ-M101', title='Mashq — daily practice', titleAr='مشق', penType='normal', courseType='mashq', khatTypeId='k1', status='hidden', structureVersion=2, branchIds=[], mistarSizes=['10'], counts=dict(levels=1, steps=30, files=30, missing=0, students=12), updatedAt=None),
]

HEALTH = [
    dict(severity='error', message='LV02 · S03 has no 1 mm worksheet, but the course uses 1 mm.', levelId='l1', stepId='s12'),
    dict(severity='warning', message='LV04 is hidden from students but has 3 steps.', levelId='l3'),
    dict(severity='info', message='LV02 has no instructions — the course default is used.', levelId='l1'),
]
AUDIT = [
    dict(id='a1', actorName='Husain Jamaali', action='update', entityType='step', entityId='s02', summary='LV01 · S03 message changed', createdAt='2026-11-10T08:10:00Z', canUndo=True),
    dict(id='a2', actorName='Husain Jamaali', action='ingest', entityType='course', entityId='c1', summary='12 files added from a ZIP (2 new steps)', createdAt='2026-11-09T16:40:00Z', canUndo=False),
    dict(id='a3', actorName='Moiz Nagpurwala', action='update', entityType='course', entityId='c1', summary='Course status Draft → Published', createdAt='2026-11-02T11:00:00Z', canUndo=True),
]

DEFAULTS = {
    'review.reviewers_required': 1, 'review.turnaround_days': 3, 'assessment.bands': {'revisionMax': 5, 'passMax': 8},
    'assessment.rubric': [{'key': 'nuqta', 'label': 'Nuqta proportion', 'max': 2}, {'key': 'form', 'label': 'Letter form', 'max': 2}, {'key': 'spacing', 'label': 'Spacing', 'max': 2}, {'key': 'baseline', 'label': 'Baseline', 'max': 2}, {'key': 'pen', 'label': 'Pen control', 'max': 2}],
    'assessment.max_attempts': 3,
    'print.instructions': 'Print your worksheets on A4 paper at your branch office or at home. Write your name only where the sheet asks for it.',
    'print.allow_multi': True, 'downloads.stamp_fields': ['name', 'email', 'tr', 'class', 'branch', 'date'],
    'downloads.watermark': {'storageKey': 'settings/wm.png', 'opacity': 0.12, 'position': 'center', 'scale': 0.5},
    'downloads.copyright_text': '© Tadreeb Fanni, Al-Jamea-tus-Saifiyah. For personal practice only.',
    'merit.levels_per_point': 3, 'merit.certification_points': 10, 'merit.monthly_cap': 10, 'merit.officer_user_id': 'u2', 'merit.reminder_day': 25,
    'showcase.requires_approval': True, 'uploads.max_files': 20, 'student.choose_one_size': True, 'review.divert_after_hours': 72,
    'review.auto_mark_enabled': True, 'review.auto_mark_after_days': 7, 'review.quick_marks': [4, 5, 6, 7, 8, 9, 10],
    'review.comment_templates': {'revision': ['A good effort — look again at the marked letters and send it back.'], 'pass': ['Well done — your letters are taking good shape.', 'Good, steady work.'], 'distinction': ['Excellent work, mashaAllah.']},
    'email.student_on_reply': True, 'email.staff_mode': 'daily_digest', 'nudge.inactive_days': 21, 'nudge.dormant_days': 180,
    'nudge.message_template': 'Salaam {name}, we miss your writing! It has been {days} days since your last practice in {course}.',
}
LOCKED = ['downloads.stamp_fields', 'downloads.watermark', 'downloads.copyright_text', 'assessment.bands']


def policies(master=True):
    return dict(
        global_=None,
        **{'global': [dict(policyKey=k, value=v, locked=k in LOCKED, updatedAt='2026-11-01T09:00:00Z', updatedBy='u1') for k, v in DEFAULTS.items()]},
        branches={'b-sur': {'review.turnaround_days': 2, 'print.instructions': 'Print at the Surat office, ground floor, between 4 and 6 pm.', 'merit.officer_user_id': 'u5'}, 'b-khi': {'assessment.max_attempts': 4}},
        editableBranchIds=[b['id'] for b in BRANCHES] if master else ['b-sur'],
        canEditGlobal=master,
    )


def network(master=True):
    def t(id_, name, branch, p):
        return dict(teacherId=id_, name=name, branchName=branch, priority=p)
    rev = [
        dict(teacherId='u2', name='Moiz Nagpurwala', branchId='b-nbo', branchName='Nairobi', threshold=15, openNow=9, overdueNow=0, awayUntil=None, available=True, spillTo=[t('u6', 'Fatema Rangwala', 'Nairobi', 1), t('u3', 'Husain Ezzy', 'Karachi', 2)], receivesFrom=[t('u6', 'Fatema Rangwala', 'Nairobi', 1)]),
        dict(teacherId='u6', name='Fatema Rangwala', branchId='b-nbo', branchName='Nairobi', threshold=12, openNow=12, overdueNow=2, awayUntil=None, available=False, spillTo=[t('u2', 'Moiz Nagpurwala', 'Nairobi', 1)], receivesFrom=[t('u2', 'Moiz Nagpurwala', 'Nairobi', 1)]),
        dict(teacherId='u3', name='Husain Ezzy', branchId='b-khi', branchName='Karachi', threshold=20, openNow=4, overdueNow=0, awayUntil='2026-11-24T20:59:00Z', available=False, spillTo=[], receivesFrom=[t('u2', 'Moiz Nagpurwala', 'Nairobi', 2)]),
        dict(teacherId='u4', name='Taher Surti', branchId='b-sur', branchName='Surat', threshold=15, openNow=14, overdueNow=1, awayUntil=None, available=True, spillTo=[t('u7', 'Zahra Surat', 'Surat', 1)], receivesFrom=[]),
        dict(teacherId='u7', name='Zahra Surat', branchId='b-sur', branchName='Surat', threshold=15, openNow=3, overdueNow=0, awayUntil=None, available=True, spillTo=[], receivesFrom=[t('u4', 'Taher Surti', 'Surat', 1)]),
    ]
    return dict(reviewers=rev, canEditTeacherIds=[r['teacherId'] for r in rev] if master else ['u4', 'u7'], canLinkAcrossBranches=master)


def merit_entry(i, sid, name, tr, src, label, pts, month='2026-11', status='pending', given=None):
    return dict(id=f'm{i}', studentId=sid, studentName=name, trNumber=tr, branchName='Nairobi', source=src, sourceLabel=label, points=pts, earnedMonth=month, status=status, givenByName='Moiz Nagpurwala' if given else None, givenAt=given)


def to_give(can=True, empty=False):
    studs = [] if empty else [
        dict(studentId='st1', studentName='Fatema Hussain', trNumber='TR 40231', branchName='Nairobi', total=4, entries=[merit_entry(1, 'st1', 'Fatema Hussain', 'TR 40231', 'levels', 'Levels 1–3 of FNK-C101', 1), merit_entry(2, 'st1', 'Fatema Hussain', 'TR 40231', 'levels', 'Levels 4–6 of THC-C201', 1, month='2026-10'), merit_entry(3, 'st1', 'Fatema Hussain', 'TR 40231', 'manual', 'Calligraphy exhibition help', 2)]),
        dict(studentId='st2', studentName='Murtaza Abbas', trNumber='TR 40877', branchName='Nairobi', total=10, entries=[merit_entry(4, 'st2', 'Murtaza Abbas', 'TR 40877', 'certification', 'Certification FNK-C101', 10)]),
        dict(studentId='st3', studentName='Sakina Ali', trNumber=None, branchName='Nairobi', total=1, entries=[merit_entry(5, 'st3', 'Sakina Ali', None, 'levels', 'Levels 1–3 of CRS-A101', 1)]),
        dict(studentId='st4', studentName='Huzaifa Taher', trNumber='TR 39114', branchName='Nairobi', total=2, entries=[merit_entry(6, 'st4', 'Huzaifa Taher', 'TR 39114', 'levels', 'Levels 1–3 of FNK-C101', 1), merit_entry(7, 'st4', 'Huzaifa Taher', 'TR 39114', 'levels', 'Levels 4–6 of FNK-C101', 1)]),
    ]
    return dict(month='2026-11', officerUserId='u2', canMarkGiven=can, students=studs)


HISTORY = [merit_entry(20 + i, f'h{i}', n, tr, s, l, p, status='given', given='2026-11-0%dT10:00:00Z' % (i + 1)) for i, (n, tr, s, l, p) in enumerate([
    ('Zainab Qutbuddin', 'TR 38811', 'levels', 'Levels 1–3 of FNK-C101', 1), ('Ammar Saifee', 'TR 40002', 'certification', 'Certification CRS-A101', 10), ('Batul Hakim', 'TR 40450', 'manual', 'Gallery decoration call', 2)])]


def plan_for(names):
    out = []
    for n in names:
        m = re.match(r'^([A-Z]{2,5}-[A-Z]\d{3})_([A-Z]{2})_(?:(LV\d+)_)?(S\d+)(?:_P(\d+))?(?:_(07|10|20|30|NP))?(?:_v(\d+))?\.(\w+)$', n, re.I)
        if not m:
            out.append(dict(filename=n, ok=False, parsed=None, stepType=None, fileRole=None, action='error', courseId=None, message='Name not understood. Expected FNK-C101_MT_LV01_S01_P01_07_v1.jpg'))
            continue
        code, ft, lv, st, pg, sz, v, ext = m.groups()
        parsed = dict(courseCode=code.upper(), fileCode=ft.upper(), level=lv, step=st, page=f'P{pg or "01"}', sizeCode=sz, version=int(v or 1), ext=ext.lower(), slug=None)
        if code.upper() == 'XYZ-A999':
            out.append(dict(filename=n, ok=False, parsed=parsed, stepType=None, fileRole=None, action='unknown_course', courseId=None, message='No course with code XYZ-A999 yet. Import it from the master list first.'))
            continue
        if lv == 'LV05':
            action, msg = 'new_level', 'Creates LV05 and its step.'
        elif st in ('S07', 'S08'):
            action, msg = 'new_step', f'Creates {lv} · {st}.'
        elif (v or '1') == '2':
            action, msg = 'new_version', 'Replaces v1 (kept in history).'
        elif n.endswith('_07_v1.jpg') and st == 'S01':
            action, msg = 'same_file', 'Already uploaded — skipped.'
        else:
            action, msg = 'add_file', 'Adds this size to the step.'
        out.append(dict(filename=n, ok=True, parsed=parsed, stepType='worksheet', fileRole='worksheet', action=action, courseId='c1', message=msg))
    return out


def master_preview():
    return dict(sourceLabel='Master Course List · Courses tab', rows=[
        dict(courseCode='FNK-C103', action='create', fields=dict(title='Naskh Raudat Hidayaat', titleAr='روضة الهداية', penType='normal', courseType='certification', branches=['Nairobi', 'Karachi'], mistarSizes=['10', '20']), changes=[], message=None),
        dict(courseCode='FNK-C101', action='update', fields=dict(title='Foundation Naskh — Normal Pen', penType='normal', courseType='certification'), changes=['mistar sizes 1 mm, 2 mm → 0.7 mm, 1 mm, 2 mm', 'branches all → Nairobi, Surat, Karachi'], message=None),
        dict(courseCode='THC-C201', action='same', fields=dict(title='Thuluth Cut Pen'), changes=[]),
        dict(courseCode='', action='error', fields=dict(title='Diwani taster'), changes=[], message='Row 14 has no Course Code — fill it in the sheet and preview again.'),
    ])


# ------------------------------------------------------------------ routing

STATE = {'master': True, 'empty': False, 'merit_can': True, 'merit_empty': False}
PNG_1x1 = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==')


def handle(route):
    req = route.request
    u = urlparse(req.url)
    p, q, m = u.path, parse_qs(u.query), req.method
    body = None
    try:
        body = req.post_data_json if req.post_data else None
    except Exception:
        body = None

    def ok(data, status=200):
        route.fulfill(status=status, content_type='application/json', body=json.dumps(data), headers={'Access-Control-Allow-Origin': '*'})

    if m == 'OPTIONS':
        return route.fulfill(status=204, headers={'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*'})
    if p == '/branches': return ok(BRANCHES)
    if p == '/admin/users':
        b = q.get('branchId', [None])[0]
        return ok([s for s in STAFF if not b or s['branch_id'] == b])
    if p == '/uploads/presign': return ok({'storageKey': 'course-files/' + (body or {}).get('filename', 'x'), 'uploadUrl': 'http://localhost:4000/fake-put'})
    if p == '/fake-put': return route.fulfill(status=200, body='', headers={'Access-Control-Allow-Origin': '*'})
    if p == '/uploads/view': return ok({'url': 'http://localhost:4000/fake-image.png'})
    if p == '/fake-image.png':
        return route.fulfill(status=200, content_type='image/svg+xml', body='<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><circle cx="100" cy="100" r="90" fill="none" stroke="#0077b6" stroke-width="10"/><text x="100" y="118" font-size="54" text-anchor="middle" fill="#0077b6" font-family="serif">خط</text></svg>', headers={'Access-Control-Allow-Origin': '*'})
    if p == '/v2/policies': return ok(policies(STATE['master']))
    if p == '/v2/step-types' and m == 'GET': return ok(STEP_TYPES)
    if p == '/v2/course-types' and m == 'GET': return ok(COURSE_TYPES)
    if p == '/v2/file-codes' and m == 'GET': return ok(FILE_CODES)
    if p == '/v2/courses' and m == 'GET': return ok([] if STATE['empty'] else COURSES)
    if p == '/v2/courses/c1' and m == 'GET': return ok(COURSE)
    if re.match(r'^/v2/courses/c\d$', p) and m == 'GET':
        cid = p.split('/')[-1]
        s = next(c for c in COURSES if c['id'] == cid)
        return ok(dict(s, description=None, instructions=None, driveFolderUrl=None, masterRow=None, levels=[]))
    if p.endswith('/health'): return ok(HEALTH)
    if p == '/v2/audit': return ok(AUDIT)
    if p == '/v2/ingest/plan': return ok(plan_for((body or {}).get('filenames', [])))
    if p == '/v2/ingest/commit': return ok([dict(filename=i['filename'], ok=True, action='add_file', stepId='s00', fileId='fx', message='Added.') for i in (body or {}).get('items', [])])
    if p == '/v2/master/preview': return ok(master_preview())
    if p == '/v2/merit/to-give': return ok(to_give(STATE['merit_can'], STATE['merit_empty']))
    if p == '/v2/merit/history': return ok(HISTORY)
    if p == '/v2/review/network' and m == 'GET': return ok(network(STATE['master']))
    if m in ('PATCH', 'PUT', 'POST', 'DELETE'): return ok({'ok': True})
    ERRORS.append(f'UNMOCKED {m} {p}')
    return ok({'error': 'not mocked'}, 404)


def shot(page, name, full=True):
    page.wait_for_timeout(350)
    w = page.viewport_size['width']
    path = os.path.join(SHOTS, f'{name}-{w}.png')
    page.screenshot(path=path, full_page=full)
    print('shot', path)


def open_page(ctx, which, theme='sky'):
    page = ctx.new_page()
    page.on('console', lambda msg: ERRORS.append(f'console[{which}] {msg.text}') if msg.type == 'error' and 'favicon' not in msg.text else None)
    page.on('pageerror', lambda e: ERRORS.append(f'pageerror[{which}] {e}'))
    page.route('http://localhost:4000/**', handle)
    page.goto(f'{BASE}?page={which}&theme={theme}')
    page.wait_for_load_state('networkidle')
    page.wait_for_timeout(500)
    return page


def run(width, height):
    tag = f'{width}'
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        ctx = browser.new_context(viewport={'width': width, 'height': height}, device_scale_factor=1)
        ctx.add_init_script("localStorage.setItem('khat_token','test');localStorage.setItem('khat_user',JSON.stringify({id:'u1',name:'Husain',email:'h@x',role:'admin',branchId:'b-nbo'}));sessionStorage.clear();")
        mobile = width < 700

        def want(n):
            return not ONLY or ONLY in n

        # ---------- builder ----------
        if want('builder'):
            STATE.update(master=True, empty=False)
            pg = open_page(ctx, 'builder')
            shot(pg, '01-builder-list')
            if mobile:
                pg.click('text=Filters')
                shot(pg, '01b-builder-filters-open', full=False)
            pg.click('text=Import master list')
            pg.fill('input[placeholder^="https://docs.google.com"]', 'https://docs.google.com/spreadsheets/d/abc/edit#gid=0')
            pg.click('.v2-dialog button:has-text("Preview")')
            shot(pg, '02-builder-master-import', full=False)
            pg.keyboard.press('Escape')
            pg.click('.v2-course-card:has-text("FNK-C101")')
            pg.wait_for_timeout(500)
            shot(pg, '03-builder-course-detail')
            # step expanded
            pg.click('.v2-level.is-open .v2-chev >> nth=2')
            pg.locator('.v2-step.is-open').scroll_into_view_if_needed()
            shot(pg, '04-builder-step-open', full=False)
            pg.click('.v2-level.is-open .v2-chev >> nth=2')
            # select steps -> bulk bar
            boxes = pg.locator('.v2-level.is-open .v2-step-check input')
            for i in range(3):
                boxes.nth(i).check()
            shot(pg, '05-builder-bulk-selected', full=False)
            pg.click('.v2-bulkbar button:has-text("Type")')
            shot(pg, '05b-builder-bulk-type', full=False)
            pg.keyboard.press('Escape')
            pg.click('.v2-bulkbar [aria-label="Clear selection"]')
            # ingest via course drop zone
            files = [
                ('FNK-C101_MT_LV01_S01_P01_07_v1.jpg'), ('FNK-C101_MT_LV01_S02_P01_10_v2.jpg'), ('FNK-C101_MT_LV02_S07_P01_20_v1.jpg'),
                ('FNK-C101_MT_LV02_S08_P01_07_v1.jpg'), ('FNK-C101_AW_LV05_S01_P01_10_v1.pdf'), ('FNK-C101_VD_LV05_S01_v1.mp4'),
                ('IMG_2041.jpg'), ('XYZ-A999_MT_LV01_S01_P01_07_v1.jpg'), ('FNK-C102_MT_LV01_S01_P01_10_v1.jpg'),
            ]
            pg.evaluate('window.scrollTo(0,0)')
            pg.locator('.v2-drop-course input[type=file]:not([webkitdirectory])').first.set_input_files([{'name': n, 'mimeType': 'image/jpeg', 'buffer': PNG_1x1} for n in files])
            pg.wait_for_timeout(700)
            pg.locator('.v2-ingest').scroll_into_view_if_needed()
            shot(pg, '06-builder-ingest-review', full=False)
            pg.click('.v2-ingest-foot .btn-primary')
            pg.wait_for_timeout(1200)
            pg.locator('.v2-ingest').scroll_into_view_if_needed()
            shot(pg, '07-builder-ingest-done', full=False)
            pg.click('.v2-ingest-foot button:has-text("Done")')
            for t, n in [('Details', '08-builder-details'), ('Health', '09-builder-health'), ('History', '10-builder-history')]:
                pg.click(f'.v2-tabs button:has-text("{t}")')
                pg.wait_for_timeout(300)
                shot(pg, n)
            pg.click('.v2-tabs button:has-text("Levels")')
            pg.click('button:has-text("Copy course")')
            shot(pg, '11-builder-copy-dialog', full=False)
            pg.keyboard.press('Escape')
            pg.close()
            # empty course + empty list
            pg = open_page(ctx, 'builder')
            pg.click('.v2-course-card:has-text("FNK-C102")')
            pg.wait_for_timeout(400)
            shot(pg, '12-builder-course-empty')
            pg.close()
            STATE['empty'] = True
            pg = open_page(ctx, 'builder')
            shot(pg, '13-builder-no-courses')
            pg.close()
            STATE['empty'] = False
            # branch admin read-only + crash course (steps only)
            STATE['master'] = False
            pg = open_page(ctx, 'builder')
            pg.click('.v2-course-card:has-text("FNK-C101")')
            pg.wait_for_timeout(400)
            shot(pg, '14-builder-readonly-detail', full=False)
            pg.goto(f'{BASE}?page=builder&theme=sky'); pg.wait_for_timeout(600)
            pg.click('.v2-course-card:has-text("CRS-A101")'); pg.wait_for_timeout(400)
            shot(pg, '14b-builder-steps-only-empty-readonly', full=False)
            pg.close()
            STATE['master'] = True
            # other themes
            for th in ['lavender', 'rose']:
                pg = open_page(ctx, 'builder', th)
                pg.click('.v2-course-card:has-text("FNK-C101")')
                pg.wait_for_timeout(400)
                shot(pg, f'15-builder-theme-{th}', full=False)
                pg.close()

        # ---------- logic ----------
        if want('logic'):
            STATE['master'] = True
            pg = open_page(ctx, 'logic')
            if mobile:
                shot(pg, '20-logic-step-list')
                pg.click('.v2-md-list button:has-text("Assessment")')
            else:
                pg.click('.v2-md-list button:has-text("Assessment")')
            shot(pg, '21-logic-step-assessment')
            pg.click('.v2-choice-card:has-text("Upload") >> nth=0')
            shot(pg, '22-logic-unsaved-bar', full=False)
            pg.click('.v2-savebar button:has-text("Discard")')
            pg.click('.v2-tabs button:has-text("Course types")')
            shot(pg, '23-logic-course-types')
            pg.click('.v2-tabs button:has-text("File codes")')
            shot(pg, '24-logic-file-codes')
            pg.close()
            STATE['master'] = False
            pg = open_page(ctx, 'logic')
            shot(pg, '25-logic-readonly', full=False)
            pg.close()
            STATE['master'] = True

        # ---------- policies ----------
        if want('policies'):
            STATE['master'] = True
            pg = open_page(ctx, 'policies')
            shot(pg, '30-policies-checking')
            pg.click('.v2-stepper button[aria-label^="More"] >> nth=1')
            shot(pg, '31-policies-dirty', full=False)
            pg.click('.v2-section-nav button:has-text("Printing")')
            shot(pg, '32-policies-printing')
            pg.click('.v2-section-nav button:has-text("Merit")')
            shot(pg, '33-policies-merit')
            pg.click('.v2-section-nav button:has-text("Emails")')
            shot(pg, '34-policies-emails')
            pg.click('.v2-scope-pills button:has-text("Surat")')
            pg.click('.v2-section-nav button:has-text("Checking")')
            shot(pg, '35-policies-branch-view')
            pg.click('.v2-scope-pills button:has-text("All branches")')
            pg.click('.v2-tabs button:has-text("Review network")')
            pg.wait_for_timeout(400)
            shot(pg, '36-network-all')
            pg.click('.v2-net-card >> nth=0')
            shot(pg, '37-network-edit', full=False)
            pg.keyboard.press('Escape')
            pg.click('.v2-net-presets button:has-text("Same limit") >> nth=0')
            shot(pg, '38-network-same-limit', full=False)
            pg.keyboard.press('Escape')
            pg.close()
            STATE['master'] = False
            pg = open_page(ctx, 'policies')
            shot(pg, '39-policies-branch-admin')
            pg.click('.v2-section-nav button:has-text("Printing")')
            shot(pg, '40-policies-branch-admin-locked')
            pg.click('.v2-tabs button:has-text("Review network")')
            pg.wait_for_timeout(400)
            shot(pg, '41-network-branch-admin')
            pg.close()
            STATE['master'] = True

        # ---------- merit ----------
        if want('merit'):
            STATE.update(merit_can=True, merit_empty=False, master=True)
            pg = open_page(ctx, 'merit')
            shot(pg, '50-merit-to-give')
            pg.locator('.v2-merit-row .v2-check input').nth(0).check()
            pg.locator('.v2-merit-row .v2-check input').nth(1).check()
            shot(pg, '51-merit-selected', full=False)
            pg.click('button:has-text("Mark as given")')
            shot(pg, '52-merit-confirm', full=False)
            pg.click('.v2-dialog-foot .btn-primary')
            pg.wait_for_timeout(500)
            shot(pg, '53-merit-after-given')
            pg.click('.v2-tabs button:has-text("Given")')
            pg.wait_for_timeout(400)
            shot(pg, '54-merit-history')
            pg.close()
            STATE.update(merit_can=False, master=False)
            pg = open_page(ctx, 'merit')
            shot(pg, '55-merit-not-officer')
            pg.close()
            STATE.update(merit_can=True, merit_empty=True, master=True)
            pg = open_page(ctx, 'merit')
            shot(pg, '56-merit-empty')
            pg.close()
            STATE['merit_empty'] = False

        browser.close()


if __name__ == '__main__':
    run(390, 844)
    run(1280, 800)
    real = [e for e in ERRORS if 'not mocked' not in e]
    print('\n'.join(sorted(set(ERRORS))) or 'no console errors')
    sys.exit(1 if any(e.startswith('pageerror') for e in ERRORS) else 0)
