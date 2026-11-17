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
        print(await pg.evaluate("location.hash"))
        print(await pg.evaluate("Array.from(document.querySelectorAll('nav button, nav a, aside button')).map(e=>e.textContent.trim()+' -> '+(e.getAttribute('data-page')||e.getAttribute('href')||'')).join('\\n')"))
        await b.close()
asyncio.run(main())
