import json, urllib.request
BASE = 'http://127.0.0.1:5199'
API = 'http://127.0.0.1:4100'
SIZES = {'phone': (390, 844, True), 'ipad': (820, 1180, True), 'desk': (1280, 800, False)}
def api(path, token=None, body=None, method=None):
    headers = {'Content-Type': 'application/json'}
    if token: headers['Authorization'] = f'Bearer {token}'
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, headers=headers, method=method or ('POST' if data else 'GET'))
    try:
        return json.loads(urllib.request.urlopen(req).read() or b'null')
    except urllib.error.HTTPError as e:
        return {'_status': e.code, **json.loads(e.read() or b'{}')}
def login(email):
    return api('/auth/login', body={'email': email, 'password': 'demo1234'})
async def open_as(browser, size, auth, hsh, params=None):
    w, h, touch = SIZES[size]
    ctx = await browser.new_context(viewport={'width': w, 'height': h}, has_touch=touch)
    pg = await ctx.new_page()
    pg.errs = []
    pg.on('pageerror', lambda e: pg.errs.append(str(e)))
    await pg.goto(BASE + '/', timeout=90000)
    if auth:
        await pg.evaluate('([t,u]) => { localStorage.setItem("khat_token", t); localStorage.setItem("khat_user", JSON.stringify(u)); }', [auth['token'], auth['user']])
    for k, v in (params or {}).items():
        await pg.evaluate('([k,v]) => sessionStorage.setItem("khat.v2.param." + k, v)', [k, v])
    await pg.goto(f'{BASE}/#{hsh}', timeout=90000)
    await pg.wait_for_timeout(3500)
    return ctx, pg
