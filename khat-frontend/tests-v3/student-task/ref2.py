import asyncio
from playwright.async_api import async_playwright
OUT='shots/ref/'
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        for name,vp in [('desk',{'width':1280,'height':800}),('phone',{'width':390,'height':844})]:
            pg = await b.new_page(viewport=vp)
            await pg.goto('http://127.0.0.1:5302')
            await pg.wait_for_timeout(1000)
            await pg.click('[data-r="student"]')
            await pg.wait_for_timeout(1000)
            await pg.click('text=Continue my task')
            await pg.wait_for_timeout(1500)
            print(pg.url)
            # hide review overlay if any
            await pg.screenshot(path=OUT+f'task-{name}.png', full_page=True)
            txt = await pg.evaluate("document.querySelector('main')?.innerText || document.body.innerText")
            if name=='desk': print(txt[:5000])
            await pg.close()
        await b.close()
asyncio.run(main())
