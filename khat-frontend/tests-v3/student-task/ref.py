import asyncio, sys
from playwright.async_api import async_playwright
OUT='/home/claude/work/src/tehseen_ul_khat/khat-frontend/tests-v3/student-task/shots/ref/'
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        pg = await b.new_page(viewport={'width':1280,'height':800})
        await pg.goto('http://127.0.0.1:5302')
        await pg.wait_for_timeout(1500)
        await pg.screenshot(path=OUT+'00.png')
        await pg.click('[data-r="student"]')
        await pg.wait_for_timeout(1500)
        await pg.screenshot(path=OUT+'01-home.png', full_page=True)
        print(await pg.evaluate("location.href"))
        links = await pg.evaluate("Array.from(document.querySelectorAll('a,button')).map(e=>e.textContent.trim().slice(0,50)+' | '+(e.getAttribute('href')||'')).slice(0,120)")
        print('\n'.join(links))
        await b.close()
asyncio.run(main())
