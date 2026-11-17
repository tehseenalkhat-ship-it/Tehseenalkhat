import asyncio
from playwright.async_api import async_playwright
from common import *
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        for s in SIZES:
            ctx, pg = await open_as(b, s, login('teacher@demo.khat'), 'v2-inbox')
            await pg.locator('.v3-review-btn').first.click(); await pg.wait_for_timeout(2500)
            send = pg.locator('.v2-rc-send'); await send.scroll_into_view_if_needed()
            print(s, await send.inner_text(), await send.evaluate('e => getComputedStyle(e).backgroundColor + " / " + getComputedStyle(e).color'))
            await pg.screenshot(path=f'shots/review-nomark-{s}.png'); await ctx.close()
        await b.close()
asyncio.run(main())
