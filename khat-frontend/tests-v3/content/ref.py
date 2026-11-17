import asyncio, sys
from playwright.async_api import async_playwright
OUT='/home/claude/work/src/tehseen_ul_khat/khat-frontend/tests-v3/content/ref/'
role=sys.argv[1]; routes=sys.argv[2].split(',')
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        pg = await b.new_page(viewport={'width':1280,'height':800})
        await pg.goto('http://127.0.0.1:5302')
        await pg.wait_for_timeout(1200)
        await pg.click(f'[data-r="{role}"]')
        await pg.wait_for_timeout(1500)
        for r in routes:
            await pg.evaluate(f"location.hash='{r}'")
            await pg.wait_for_timeout(1500)
            await pg.screenshot(path=OUT+f'{role}-{r}.png', full_page=True)
            txt = await pg.evaluate("document.querySelector('main')?.innerText?.slice(0,1500)||document.body.innerText.slice(0,800)")
            print('=====',r,'\n',txt)
        await b.close()
asyncio.run(main())
