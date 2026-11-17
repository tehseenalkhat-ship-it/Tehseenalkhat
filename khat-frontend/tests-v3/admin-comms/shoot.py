"""Usage: python3 shoot.py <role:master|branch> <hash> <name> [sizes=all] [js-before-shot]"""
import asyncio, json, sys, urllib.request
from playwright.async_api import async_playwright
EMAILS = {'master': 'master@demo.khat', 'branch': 'branchadmin@demo.khat', 'teacher': 'teacher@demo.khat', 'student': 'student@demo.khat', 'sakina': 'sakina@demo.khat'}
SIZES = {'phone': (390, 844, True), 'ipad': (820, 1180, True), 'desk': (1280, 800, False)}
def login(role):
    req = urllib.request.Request('http://127.0.0.1:4100/auth/login', data=json.dumps({'email': EMAILS[role], 'password': 'demo1234'}).encode(), headers={'Content-Type': 'application/json'})
    return json.loads(urllib.request.urlopen(req).read())
async def main():
    role, hsh, name = sys.argv[1], sys.argv[2], sys.argv[3]
    sizes = sys.argv[4].split(',') if len(sys.argv) > 4 and sys.argv[4] != 'all' else list(SIZES)
    js = sys.argv[5] if len(sys.argv) > 5 else None
    auth = login(role)
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        for s in sizes:
            w, h, touch = SIZES[s]
            ctx = await b.new_context(viewport={'width': w, 'height': h}, has_touch=touch)
            pg = await ctx.new_page()
            errs = []
            pg.on('pageerror', lambda e: errs.append(str(e)))
            pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
            await pg.goto('http://127.0.0.1:5195/', timeout=90000)
            await pg.evaluate('([t,u]) => { localStorage.setItem("khat_token", t); localStorage.setItem("khat_user", JSON.stringify(u)); }', [auth['token'], auth['user']])
            await pg.goto(f'http://127.0.0.1:5195/#{hsh}', timeout=90000)
            await pg.wait_for_timeout(4000)
            if js:
                await pg.evaluate(js)
                await pg.wait_for_timeout(1500)
            await pg.screenshot(path=f'shots/{name}-{s}.png', full_page=not __import__('os').environ.get('VIEWPORT'))
            if errs: print(s, 'ERRORS:', errs[:5])
            await ctx.close()
        await b.close()
asyncio.run(main())
