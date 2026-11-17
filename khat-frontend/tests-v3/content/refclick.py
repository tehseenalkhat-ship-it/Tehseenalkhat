import asyncio, sys
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        pg = await b.new_page(viewport={'width':1280,'height':800})
        await pg.goto('http://127.0.0.1:5302')
        await pg.wait_for_timeout(1200)
        await pg.click(f'[data-r="{sys.argv[1]}"]')
        await pg.wait_for_timeout(1500)
        await pg.locator('nav button', has_text=sys.argv[2]).first.click()
        await pg.wait_for_timeout(2000)
        print(await pg.evaluate("location.hash"))
        await pg.screenshot(path='ref/'+sys.argv[1]+'-click-'+sys.argv[2].replace(' ','_')+'.png', full_page=True)
        print(await pg.evaluate("document.querySelector('main')?.innerText?.slice(0,2500)"))
        await b.close()
asyncio.run(main())
