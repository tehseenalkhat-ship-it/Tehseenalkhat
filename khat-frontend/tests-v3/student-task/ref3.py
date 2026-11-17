import asyncio
from playwright.async_api import async_playwright
OUT='shots/ref/'
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        pg = await b.new_page(viewport={'width':1280,'height':800})
        await pg.goto('http://127.0.0.1:5302')
        await pg.wait_for_timeout(1000)
        await pg.click('[data-r="student"]')
        await pg.wait_for_timeout(1000)
        await pg.evaluate("document.querySelectorAll('[class*=review], [class*=preview-bar]').forEach(e=>{})")
        await pg.click('text=Continue my task')
        await pg.wait_for_timeout(1200)
        for i in range(3):
            await pg.click('text=Next task')
            await pg.wait_for_timeout(1200)
            await pg.screenshot(path=OUT+f'task-next{i}.png', full_page=True)
            t = await pg.evaluate("document.querySelector('main')?.innerText")
            print('-----',i); print(t[:1500])
        await pg.click('text=Back to course'); await pg.wait_for_timeout(1200)
        await pg.screenshot(path=OUT+'course.png', full_page=True)
        await b.close()
asyncio.run(main())
