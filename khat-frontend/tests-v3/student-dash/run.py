# student-dash v3 UI test: dashboard, guide tour, course window, progress, badges at phone/iPad/desktop.
import asyncio, json, sys, urllib.request
from playwright.async_api import async_playwright
BASE = 'http://127.0.0.1:5191/'
API = 'http://127.0.0.1:4100'
OUT = '/home/claude/work/src/tehseen_ul_khat/khat-frontend/tests-v3/student-dash/shots/'
SIZES = {'phone': dict(viewport={'width': 390, 'height': 844}, has_touch=True, is_mobile=True, device_scale_factor=2),
         'ipad': dict(viewport={'width': 820, 'height': 1180}, has_touch=True, device_scale_factor=1),
         'desk': dict(viewport={'width': 1280, 'height': 800})}
ONLY = sys.argv[1:] or list(SIZES)

def login(email):
    req = urllib.request.Request(API + '/auth/login', data=json.dumps({'email': email, 'password': 'demo1234'}).encode(), headers={'content-type': 'application/json'})
    return json.load(urllib.request.urlopen(req))

errors = []
async def run(p, who, size):
    auth = login(who + '@demo.khat')
    b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx = await b.new_context(**SIZES[size])
    await ctx.add_init_script(f"localStorage.setItem('khat_token', {json.dumps(auth['token'])}); localStorage.setItem('khat_user', {json.dumps(json.dumps(auth['user']))});" + "new MutationObserver(()=>document.querySelectorAll('vite-error-overlay').forEach(e=>e.remove())).observe(document, {childList:true, subtree:true});")
    pg = await ctx.new_page()
    pg.on('pageerror', lambda e: errors.append(f'{who}/{size}: {e}'))
    pg.on('console', lambda m: m.type == 'error' and errors.append(f'{who}/{size} console: {m.text[:200]}'))
    tag = f'{who}_{size}'
    await pg.goto(BASE + '#v2-home'); await pg.wait_for_selector('.v3-sd-now', timeout=20000); await pg.wait_for_timeout(1200)
    await pg.screenshot(path=OUT + f'{tag}_home.png', full_page=True)
    # the shell's notification toasts (not ours) sit over the top-right of the page; close them for the clicks
    await pg.add_style_tag(content='.global-notification-toasts{display:none!important}')
    # Guide me tour: walk all steps
    await pg.click('[data-guide="guide"]'); await pg.wait_for_timeout(900)
    n = 0
    while await pg.locator('.v3-sd-tour-card').count():
        if n < 3 or size == 'phone' and n < 7: await pg.screenshot(path=OUT + f'{tag}_guide{n}.png')
        btn = pg.locator('.v3-sd-tour-actions .v3-sd-btn.is-solid')
        await btn.click(); await pg.wait_for_timeout(700); n += 1
        if n > 10: break
    print(tag, 'guide steps', n)
    # pen tab switch
    tabs = pg.locator('.v3-sd-pen')
    for i in range(await tabs.count()):
        await tabs.nth(i).click(); await pg.wait_for_timeout(200)
    # open a badge from the dashboard
    if await pg.locator('.v3-sd-badge-tile').count():
        await pg.locator('.v3-sd-badge-tile').first.click(); await pg.wait_for_timeout(600)
        await pg.screenshot(path=OUT + f'{tag}_badge.png')
        async with pg.expect_download(timeout=15000) as dl:
            await pg.click('.v3-sd-badge-view-actions .v3-sd-btn >> nth=0')
        try: print(tag, 'badge download', (await dl.value).suggested_filename)
        except Exception as e: print(tag, 'badge download failed', e)
        await pg.keyboard.press('Escape'); await pg.wait_for_timeout(300)
    # course window via "See all steps" / Open course on first now card or first card title
    if await pg.locator('.v3-sd-course-name button').count():
        await pg.locator('.v3-sd-course-name button').first.evaluate("e => e.scrollIntoView({block: 'center'})")
        await pg.locator('.v3-sd-course-name button').first.click()
    await pg.wait_for_selector('.v3-sd-course-hero', timeout=15000); await pg.wait_for_timeout(1000)
    await pg.screenshot(path=OUT + f'{tag}_course.png', full_page=True)
    # click each "See steps"
    see = pg.locator('.v3-sd-level-actions .v3-sd-btn.is-ghost')
    if await see.count():
        await see.first.click(); await pg.wait_for_timeout(700)
        await pg.screenshot(path=OUT + f'{tag}_course_steps.png', full_page=False)
    if await pg.locator('.v3-sd-badge-earned').count():
        await pg.locator('.v3-sd-badge-earned').first.click(); await pg.wait_for_timeout(500)
        await pg.screenshot(path=OUT + f'{tag}_course_badge.png'); await pg.keyboard.press('Escape')
    # step row → task route
    if await pg.locator('.v3-sd-step-row:not([disabled])').count():
        await pg.locator('.v3-sd-step-row:not([disabled])').first.click(); await pg.wait_for_timeout(500)
        print(tag, 'step row ->', pg.url.split('#')[-1])
    # other courses (crash / mashq)
    for page_name in ['v2-my-progress', 'v2-my-merit', 'catalog']:
        await pg.goto(BASE + '#' + page_name); await pg.wait_for_timeout(2500)
        await pg.screenshot(path=OUT + f'{tag}_{page_name}.png', full_page=True)
    await b.close()

async def main():
    async with async_playwright() as p:
        for size in ONLY:
            for who in ['student', 'zainab']:
                await run(p, who, size)
    print('ERRORS:', *errors[:30], sep='\n  ')
asyncio.run(main())
