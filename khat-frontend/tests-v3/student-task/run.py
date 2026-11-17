import asyncio, json, sys, urllib.request
from playwright.async_api import async_playwright
API='http://127.0.0.1:4100'; APP='http://127.0.0.1:5192/'
OUT='shots/'
FNK='3b9791c9-debf-4da8-b66d-5d2e4a902d08'; QSD='a0b53259-bd54-4fd1-95de-c936a5728785'; URS='50f6ac10-7940-450e-8313-b3509b9430bf'
SIZES={'phone':dict(viewport={'width':390,'height':844},is_mobile=True,has_touch=True,device_scale_factor=2),
       'ipad':dict(viewport={'width':820,'height':1180},has_touch=True),
       'desk':dict(viewport={'width':1280,'height':800})}
def login(email):
    r=urllib.request.Request(API+'/auth/login',data=json.dumps({'email':email,'password':'demo1234'}).encode(),headers={'content-type':'application/json'})
    return json.load(urllib.request.urlopen(r))
def step_id(course, prefix):
    c=json.load(open(f'/tmp/course-{course}.json'))
    for l in c['levels']:
        for s in l['steps']:
            if s['id'].startswith(prefix): return s['id']
    return prefix
async def open_task(b, *a, **k):
    for attempt in range(3):
        try: return await _open_task(b, *a, **k)
        except Exception as e:
            print('retry', attempt, str(e)[:120])
    raise RuntimeError('failed')
async def _open_task(b, size, sess, course, step, name, full=True, video=False, after=None):
    ctx=await b.new_context(**SIZES[size])
    pg=await ctx.new_page()
    errs=[]
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('response', lambda r: errs.append(f'{r.status} {r.url[:120]}') if r.status>=400 and '4100' in r.url else None)
    pg.on('console', lambda m: errs.append(m.text) if m.type=='error' else None)
    if video:
        async def h(route):
            resp=await route.fetch(); data=await resp.json()
            for l in data['levels']:
                for s in l['steps']:
                    if s['id'].startswith('d9679f3d'): s['videoUrl']='https://youtu.be/dQw4w9WgXcQ'
            await route.fulfill(response=resp, json=data)
        await pg.route(f'{API}/v2/student/courses/{FNK}', h)
    await pg.goto(APP)
    await pg.evaluate("""([t,u,c,s])=>{localStorage.setItem('khat_token',t);localStorage.setItem('khat_user',JSON.stringify(u));sessionStorage.setItem('khat.v2.param.courseId',c); if(s) sessionStorage.setItem('khat.v2.param.stepId',s); else sessionStorage.removeItem('khat.v2.param.stepId');}""", [sess['token'],sess['user'],course,step])
    await pg.goto(APP+'#v2-task'); await pg.reload()
    await pg.add_style_tag(content='.global-notification-toasts{display:none!important}')
    await pg.wait_for_selector('.v3t-step, .v3t-empty, .v2s-inline-error', timeout=20000)
    await pg.wait_for_timeout(2500)
    # scroll through to trigger lazy previews
    h=await pg.evaluate('document.body.scrollHeight')
    for y in range(0,h,600): await pg.evaluate(f'window.scrollTo(0,{y})'); await pg.wait_for_timeout(150)
    await pg.wait_for_timeout(1200); await pg.evaluate('window.scrollTo(0,0)'); await pg.wait_for_timeout(300)
    if after: await after(pg)
    await pg.screenshot(path=f'{OUT}{name}-{size}.png', full_page=full)
    errs=[e for e in errs if 'TUNNEL' not in e]
    if errs: print(name,size,'ERRORS:',errs[:6])
    return ctx,pg
async def upload(pg):
    await pg.click('.v3t-intro-send'); await pg.wait_for_timeout(900)
    await pg.screenshot(path=OUT+'upload-1-scrolled.png')
    await pg.click('[data-testid=send-for-marks]'); await pg.wait_for_timeout(600)
    await pg.locator('.v2-sheet input[type=file][multiple]').last.set_input_files('/tmp/st-test/work.png')
    await pg.wait_for_timeout(600)
    await pg.screenshot(path=OUT+'upload-2-sheet.png')
    await pg.click('.v2-sheet-foot .btn-primary'); await pg.wait_for_timeout(5000)
    await pg.evaluate('window.scrollTo(0,0)'); await pg.wait_for_timeout(300)
async def zoom(pg):
    await pg.locator('.v3t-thumb.is-ready').first.click(); await pg.wait_for_timeout(500)
    await pg.click('[aria-label="Zoom in"]'); await pg.click('[aria-label="Zoom in"]'); await pg.wait_for_timeout(300)
    await pg.screenshot(path=OUT+'zoom-viewer.png')
    await pg.click('.v3t-zoom-close'); await pg.wait_for_timeout(300)
async def main():
    which=sys.argv[1:] or ['all']
    st=login('student@demo.khat')
    async with async_playwright() as p:
        b=await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        for size in SIZES:
            for course,prefix,name,video in [(FNK,'d9679f3d','worksheet-video',True),(FNK,'e069805a','assessment-passed',False),(FNK,'d35be285','assessment-todo',False),(QSD,None,'mashq',False),(FNK,None,'next',False)]:
                sid=step_id(course,prefix) if prefix else None
                if ('all' not in which and name not in which) or (size!='phone' and 'phoneonly' in which) or ('deskonly' in which and size!='desk'): continue
                ctx,pg=await open_task(b,size,st,course,sid,name,video=video)
                await ctx.close()
        if 'upload' in which:
            print('upload test')
            ctx,pg=await open_task(b,'desk',st,FNK,step_id(FNK,'d35be285'),'after-upload',after=upload); await ctx.close()
        if 'zoom' in which:
            ctx,pg=await open_task(b,'phone',st,FNK,step_id(FNK,'d9679f3d'),'zoom-src',after=zoom); await ctx.close()
        if 'locked' in which:
            ctx,pg=await open_task(b,'phone',login('zainab@demo.khat'),FNK,step_id(FNK,'d35be285'),'locked'); await ctx.close()
        await b.close()
asyncio.run(main())
