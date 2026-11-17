"""Chat owner UI test: step chat (student + teacher) and Funun al-Quran Department chat at phone / iPad / desktop.
Run: python3 tests-v3/chat/run_chat.py  (vite on 5193 against the e2e backend 4100)."""
import asyncio, json, os, sys, urllib.request
from playwright.async_api import async_playwright

FE = 'http://127.0.0.1:5193'
API = 'http://127.0.0.1:4100'
HERE = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.join(HERE, 'shots')
SHEET = sys.argv[1] if len(sys.argv) > 1 else '/tmp/chatwork/sheet.png'
STEP = '04b4d5a8-df16-4319-b781-ab6d17d64b1b'        # FNK-C101 Level 2 assessment
FATEMA = '8556702c-dd21-11f1-886a-02fc00000001'
STEP_T = os.environ.get('STEP_T', '173e99d5-e03f-11f1-93d5-02fc00000001')  # Fatema's open final submission
SIZES = {'phone': dict(viewport={'width': 390, 'height': 844}, has_touch=True, is_mobile=True, device_scale_factor=2),
         'ipad': dict(viewport={'width': 820, 'height': 1180}, has_touch=True, device_scale_factor=1),
         'desktop': dict(viewport={'width': 1280, 'height': 800})}
ONLY = os.environ.get('ONLY')
errors = []

def login(email):
    req = urllib.request.Request(f'{API}/auth/login', data=json.dumps({'email': email, 'password': 'demo1234'}).encode(), headers={'content-type': 'application/json'})
    return json.load(urllib.request.urlopen(req))

async def page_as(browser, size, email):
    s = login(email)
    ctx = await browser.new_context(**SIZES[size], permissions=['microphone'])
    await ctx.add_init_script(f"localStorage.setItem('khat_token', {json.dumps(s['token'])}); localStorage.setItem('khat_user', {json.dumps(json.dumps(s['user']))});")
    pg = await ctx.new_page()
    pg.set_default_navigation_timeout(120000)
    pg.on('pageerror', lambda e: errors.append(f'{size} {email}: {e} {(e.stack or "")[:400]}'))
    pg.on('dialog', lambda d: asyncio.ensure_future(d.accept()))
    pg.on('response', lambda r: errors.append(f'{size} {email}: HTTP {r.status} {r.request.method} {r.url}') if r.status >= 400 and '4100' in r.url else None)
    return pg

async def shot(pg, name):
    await pg.wait_for_timeout(500)
    await pg.screenshot(path=os.path.join(SHOTS, f'{name}.png'))
    print('shot', name)

async def tap(pg, locator):
    loc = pg.locator(locator).first if isinstance(locator, str) else locator
    await loc.scroll_into_view_if_needed()
    await loc.click()

async def student_step(browser, size):
    pg = await page_as(browser, size, 'fatema@demo.khat')
    await pg.goto(f'{FE}/tests-v3/chat/harness.html?stepId={STEP}&mode=student&compact=1&submit=1')
    await pg.wait_for_selector('[data-testid=thread-feed]')
    await shot(pg, f'{size}-student-step-chat')
    # text
    await pg.fill('.v3ch-pill textarea', f'Salaam ustad, test message from {size} 🙂')
    await shot(pg, f'{size}-student-typing')
    await tap(pg, 'button[aria-label="Send"]')
    await pg.wait_for_timeout(1500)
    # emoji
    await tap(pg, 'button[aria-label="Emoji"]')
    await shot(pg, f'{size}-student-emoji')
    await tap(pg, 'button[aria-label="Insert 🤲"]')
    await tap(pg, 'button[aria-label="Send"]')
    await pg.wait_for_timeout(1200)
    # voice: tap = hands-free
    mic = pg.locator('.v3ch-mic')
    await mic.click()
    await pg.wait_for_selector('.v3ch-recbar', timeout=5000)
    await pg.wait_for_timeout(2200)
    await shot(pg, f'{size}-student-voice-recording')
    await tap(pg, 'button[aria-label="Pause recording"]')
    await pg.wait_for_timeout(400)
    await tap(pg, 'button[aria-label="Continue recording"]')
    await pg.wait_for_timeout(800)
    await tap(pg, '.v3ch-recbar .v2-recbar-send')
    await pg.wait_for_timeout(2500)
    # voice: hold to record (mouse) and release to send
    if size == 'desktop':
        box = await mic.bounding_box()
        await pg.mouse.move(box['x'] + 20, box['y'] + 20)
        await pg.mouse.down()
        await pg.wait_for_timeout(1800)
        await shot(pg, f'{size}-student-voice-holding')
        await pg.mouse.up()
        await pg.wait_for_timeout(2500)
    await shot(pg, f'{size}-student-after-voice')
    # play the latest voice note + speed
    plays = pg.locator('.v3ch-voice .v2-voice-play')
    if await plays.count():
        await plays.last.click()
        await pg.wait_for_timeout(700)
        sp = pg.locator('.v3ch-voice-speed')
        if await sp.count():
            await sp.last.click()
        await shot(pg, f'{size}-student-voice-playing')
    # image
    await pg.set_input_files('input[type=file][accept="image/*"][multiple]', SHEET)
    await shot(pg, f'{size}-student-image-tray')
    await tap(pg, 'button[aria-label="Send"]')
    await pg.wait_for_timeout(3000)
    # tap the image → draw on it → send
    await pg.locator('.v2-bubble.is-media .v2-thumb').last.click()
    await pg.wait_for_selector('.v2-viewer')
    await shot(pg, f'{size}-student-viewer')
    await tap(pg, '.v3ch-viewer-draw')
    await pg.wait_for_selector('[data-testid=annotator-stage] canvas')
    await pg.wait_for_timeout(1200)
    st = await pg.locator('[data-testid=annotator-stage]').bounding_box()
    await pg.mouse.move(st['x'] + st['width'] * .3, st['y'] + st['height'] * .4)
    await pg.mouse.down()
    for i in range(12):
        await pg.mouse.move(st['x'] + st['width'] * (.3 + i * .03), st['y'] + st['height'] * (.4 + (i % 3) * .02))
    await pg.mouse.up()
    await shot(pg, f'{size}-student-draw')
    await tap(pg, '[data-testid=annotate-send]')
    await pg.wait_for_timeout(3500)
    await shot(pg, f'{size}-student-after-draw')
    await pg.context.close()

async def teacher_step(browser, size, send_mark):
    pg = await page_as(browser, size, 'teacher@demo.khat')
    await pg.goto(f'{FE}/tests-v3/chat/harness.html?stepId={STEP_T}&studentId={FATEMA}&mode=staff')
    await pg.wait_for_selector('[data-testid=thread-feed]')
    await pg.wait_for_timeout(800)
    await shot(pg, f'{size}-teacher-chat')
    marks = pg.locator('.v3ch-tools .v3ch-mark')
    if await marks.count():
        await marks.nth(6).click()
        await shot(pg, f'{size}-teacher-mark-meaning')
        await marks.nth(3).click()
        await shot(pg, f'{size}-teacher-mark-meaning-revision')
        await tap(pg, '.v3ch-mark-meaning .v3ch-ghost')
    else:
        print('no open submission for marks on', size)
    # text size
    await tap(pg, '.v3ch-chip:has-text("text")')
    await tap(pg, '.v3ch-chip:has-text("text")')
    await shot(pg, f'{size}-teacher-font-xl')
    await tap(pg, '.v3ch-chip:has-text("text")')
    await tap(pg, '.v3ch-chip:has-text("text")')
    # AI helper
    await pg.fill('.v3ch-pill textarea', 'your alif is slanting, nuqta too big')
    await tap(pg, '.v3ch-chip.is-ai')
    await pg.wait_for_selector('.v3ch-ai')
    await tap(pg, '.v3ch-ai .v3ch-ai-run')
    await pg.wait_for_selector('.v3ch-ai-answer', timeout=20000)
    await shot(pg, f'{size}-teacher-ai-polish')
    await tap(pg, '.v3ch-seg button:has-text("Ask a question")')
    await pg.fill('.v3ch-ai textarea', 'How do I explain the baseline to a young student?')
    await tap(pg, '.v3ch-ai .v3ch-ai-run')
    await pg.wait_for_selector('.v3ch-ai-answer', timeout=20000)
    await shot(pg, f'{size}-teacher-ai-ask')
    await tap(pg, '.v3ch-ai button[aria-label="Close"]')
    # mark on the sheet
    ann = pg.locator('.v3ch-chip:has-text("Mark on the sheet")')
    if await ann.count():
        await ann.click()
        await pg.wait_for_selector('[data-testid=annotator-stage] canvas')
        await pg.wait_for_timeout(1500)
        st = await pg.locator('[data-testid=annotator-stage]').bounding_box()
        await pg.mouse.move(st['x'] + st['width'] * .4, st['y'] + st['height'] * .3)
        await pg.mouse.down()
        for i in range(14):
            await pg.mouse.move(st['x'] + st['width'] * (.4 + i * .02), st['y'] + st['height'] * (.3 + i * .015))
        await pg.mouse.up()
        await shot(pg, f'{size}-teacher-annotate')
        if send_mark:
            m = pg.locator('.v3ch-annotate-foot .v3ch-mark')
            await m.nth(6).click()
            await shot(pg, f'{size}-teacher-annotate-mark')
            await tap(pg, '.v3ch-annotate-foot .v3ch-solid')
            await pg.wait_for_timeout(4000)
            await shot(pg, f'{size}-teacher-after-mark')
        else:
            await tap(pg, '[data-testid=annotate-send]')
            await pg.wait_for_timeout(3500)
            await shot(pg, f'{size}-teacher-after-annotation')
    # meet request
    await tap(pg, '.v3ch-chip:has-text("Ask to meet")')
    await pg.wait_for_timeout(2500)
    await shot(pg, f'{size}-teacher-after-meet')
    await pg.context.close()

async def dept(browser, size):
    pg = await page_as(browser, size, 'zainab@demo.khat')
    await pg.goto(f'{FE}/#v2-dept-chat')
    await pg.wait_for_selector('[data-testid=dept-conversation]', timeout=15000)
    await shot(pg, f'{size}-dept-student-empty')
    await pg.fill('.v3ch-pill textarea', 'Salaam, can I join the Thuluth class this term?')
    await tap(pg, 'button[aria-label="Send"]')
    await pg.wait_for_timeout(1800)
    await shot(pg, f'{size}-dept-student')
    await pg.context.close()
    pg = await page_as(browser, size, 'teacher2@demo.khat')
    await pg.goto(f'{FE}/#v2-dept-chat')
    await pg.wait_for_selector('[data-testid=dept-list] .v3ch-dept-item', timeout=15000)
    await shot(pg, f'{size}-dept-staff-list')
    await pg.locator('.v3ch-dept-item:has-text("Zainab")').first.click()
    await pg.wait_for_selector('[data-testid=dept-conversation]')
    await pg.fill('.v3ch-pill textarea', 'Wa alaikum salaam Zainab, yes — come on Monday at 4.')
    await tap(pg, 'button[aria-label="Send"]')
    await pg.wait_for_timeout(1800)
    await shot(pg, f'{size}-dept-staff-chat')
    await tap(pg, '.v3ch-dept-conv .v3ch-chip:has-text("Ask to meet")')
    await pg.wait_for_timeout(1800)
    await shot(pg, f'{size}-dept-staff-meet')
    back = pg.locator('button[aria-label="Back to all chats"]')
    if await back.is_visible():
        await back.click()
    await tap(pg, 'button[aria-label="Start a new chat"]')
    await pg.fill('.v3ch-dept-search input', 'Amm')
    await pg.wait_for_timeout(1200)
    await shot(pg, f'{size}-dept-staff-newchat')
    await pg.context.close()

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'])
        for size in ['phone', 'ipad', 'desktop']:
            if ONLY and ONLY not in size: continue
            for name, fn in [('student', lambda: student_step(b, size)), ('teacher', lambda: teacher_step(b, size, size == 'desktop')), ('dept', lambda: dept(b, size))]:
                if os.environ.get('PART') and os.environ['PART'] != name: continue
                try:
                    await fn()
                except Exception as e:
                    errors.append(f'{size} {name}: {e}')
                    print('FAILED', size, name, e)
        await b.close()
    print('ERRORS:', *errors, sep='\n  ')
asyncio.run(main())
