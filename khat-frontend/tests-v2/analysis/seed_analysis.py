"""Adds demo marks + rubric through the real API (run once against the e2e backend)."""
import json, urllib.request, sys
API = 'http://127.0.0.1:4100'
COURSE = '3b9791c9-debf-4da8-b66d-5d2e4a902d08'
LV01, LV02 = '60553820-acac-48df-8d2a-f0232aa31464', '3fe07433-4e30-4c43-b3a7-821f0680b3d1'
LV01_S05 = 'e069805a-cbd5-4908-934e-2dc5836a24b6'

def call(method, path, token=None, body=None):
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={'content-type': 'application/json', **({'authorization': 'Bearer ' + token} if token else {})})
    try:
        with urllib.request.urlopen(req) as r: return json.loads(r.read() or b'null')
    except urllib.error.HTTPError as e:
        print('ERR', method, path, e.code, e.read()[:300]); return None

def login(email): return call('POST', '/auth/login', body={'email': email, 'password': 'demo1234'})['token']

master, teacher = login('master@demo.khat'), login('teacher@demo.khat')
course = call('GET', f'/v2/courses/{COURSE}', master)
levels = {l['code']: l for l in course['levels']}
def ensure_step(level_code, code, title):
    lv = levels[level_code]
    found = next((s for s in lv['steps'] if s['code'] == code), None)
    if found: return found['id']
    st = call('POST', f"/v2/levels/{lv['id']}/steps", master, {'code': code, 'title': title, 'stepType': 'assessment'})
    return st['id']
if 'LV03' not in levels:
    call('POST', f'/v2/courses/{COURSE}/levels', master, {'code': 'LV03', 'description': 'كلمات', 'instructions': 'Write the words on the worksheet and send your assessment.'})
    course = call('GET', f'/v2/courses/{COURSE}', master); levels = {l['code']: l for l in course['levels']}
LV02_A = ensure_step('LV02', 'S03', 'Level 2 assessment')
LV03_A = ensure_step('LV03', 'S01', 'Level 3 assessment')
if 'LV04' not in levels:
    call('POST', f'/v2/courses/{COURSE}/levels', master, {'code': 'LV04', 'description': 'سطر', 'instructions': 'Write one full line and send it.'})
    course = call('GET', f'/v2/courses/{COURSE}', master); levels = {l['code']: l for l in course['levels']}
LV04_A = ensure_step('LV04', 'S01', 'Level 4 line assessment')
print('steps', LV02_A, LV03_A)

def submit(token, step, name):
    files = [{'storageKey': f'threads/demo-{name}.jpg', 'originalFilename': f'{name}.jpg', 'contentType': 'image/jpeg', 'forStepId': step}]
    return call('POST', f'/v2/threads/{step}/submit', token, {'files': files, 'note': 'Salaam, here is my work.'})

def decide(sub, mark, rubric, comment):
    return call('POST', f"/v2/review/submissions/{sub['id']}/decision", teacher, {'mark': mark, 'rubric': rubric, 'comment': comment})

plan = {
  'student@demo.khat': [
    (LV02_A, 5, {'nuqta': 2, 'form': 1, 'spacing': 1, 'baseline': 1, 'pen': 1}, 'Good effort, Mustafa. Your spacing is uneven between the Laam-Alif joins — leave a little more space. The baseline drifts upward; keep every letter on the line.'),
    (LV02_A, 7, {'nuqta': 2, 'form': 2, 'spacing': 1, 'baseline': 1, 'pen': 2}, 'Much better! Your nuqtas are neat and well placed. Watch the spacing once more and keep the baseline straight.'),
    (LV03_A, 8, {'nuqta': 2, 'form': 2, 'spacing': 1, 'baseline': 1, 'pen': 2}, 'Beautiful Alif and clean joins, mashaAllah. The spacing between words is still a little tight — farrij bayn al-sutur.'),
  ],
  'hussain@demo.khat': [
    (LV02_A, 9, {'nuqta': 2, 'form': 2, 'spacing': 2, 'baseline': 2, 'pen': 2}, 'Excellent work, Hussain. Your proportions are very fine.'),
  ],
  'fatema@demo.khat': [
    (LV01_S05, 6, {'nuqta': 1, 'form': 1, 'spacing': 2, 'baseline': 1, 'pen': 1}, 'Well done, Fatema — this passes. Keep the baseline steady and make the nuqta a little smaller.'),
    (LV02_A, 4, {'nuqta': 1, 'form': 1, 'spacing': 1, 'baseline': 0, 'pen': 1}, 'A good try. Practise the baseline again — the Baa sits above the line. Check your pen angle too.'),
  ],
}
if len(sys.argv) > 1 and sys.argv[1] == 'structure-only': sys.exit(0)
for email, items in plan.items():
    tok = login(email)
    for step, mark, rubric, comment in items:
        sub = submit(tok, step, email.split('@')[0] + '-' + step[:4])
        if not sub: continue
        res = decide(sub, mark, rubric, comment)
        print(email, step[:8], mark, res and res['status'])
