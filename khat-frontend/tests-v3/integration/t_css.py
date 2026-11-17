import asyncio
from playwright.async_api import async_playwright
from common import *
PAGES = [('teacher@demo.khat','v2-teacher-courses','.v3tc-kind-tabs'), ('teacher@demo.khat','teacher-dashboard','.v3tc-kind-tag'),
         ('teacher@demo.khat','v2-inbox','.v3rv-kind-tabs'), ('master@demo.khat','v2-insights','.v3in-bar-row'),
         ('master@demo.khat','v2-admin-home','.v3-page, .v3cm-bar, main'), ('branchadmin@demo.khat','v2-announcements','.v3-toolbar'),
         ('student@demo.khat','v2-dept-chat','.v3dc-avatar')]
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        for email, hsh, sel in PAGES:
            auth = login(email)
            for s in SIZES:
                ctx, pg = await open_as(b, s, auth, hsh)
                n = await pg.locator(sel).count()
                styled = await pg.evaluate("""(sel) => { const el = document.querySelector(sel); if (!el) return null; const cs = getComputedStyle(el); return cs.display + ' ' + cs.backgroundColor; }""", sel.split(',')[0])
                await pg.screenshot(path=f'shots/css-{hsh}-{s}.png', full_page=True)
                print(hsh, s, sel, 'found', n, 'style', styled, 'errors', pg.errs[:2])
                await ctx.close()
        # announcements → open survey results (bars)
        auth = login('branchadmin@demo.khat')
        ctx, pg = await open_as(b, 'desk', auth, 'v2-announcements')
        try:
            await pg.click('text=Surveys'); await pg.wait_for_timeout(1500)
            await pg.locator('text=Results').first.click(); await pg.wait_for_timeout(2000)
        except Exception as e: print('results nav', str(e)[:120])
        print('survey result bars:', await pg.locator('.v3cm-bar-row').count())
        await pg.screenshot(path='shots/css-survey-results-desk.png', full_page=True)
        await ctx.close(); await b.close()
asyncio.run(main())
