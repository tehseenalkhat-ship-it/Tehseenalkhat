import asyncio, subprocess
from playwright.async_api import async_playwright
from common import *
def sql(q): return subprocess.run(['mariadb','-uroot','khat_e2e','-N','-e',q],capture_output=True,text=True).stdout.strip()
async def main():
    tea = login('teacher@demo.khat')
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        for s in SIZES:
            ctx, pg = await open_as(b, s, tea, 'v2-inbox')
            await pg.screenshot(path=f'shots/inbox-{s}.png', full_page=True)
            row = pg.locator('.v3-review-btn').filter(has_text='Review')
            await row.first.click(); await pg.wait_for_timeout(2500)
            send = pg.locator('.v2-rc-send')
            await send.scroll_into_view_if_needed()
            print(s, 'before mark:', repr(await send.inner_text()), 'disabled=', await send.is_disabled(), '| why:', await pg.locator('.v2-rc-why').inner_text())
            print('   guild guide:', await pg.locator('text=Ask Guild Guide').count())
            await pg.screenshot(path=f'shots/review-nomark-{s}.png')
            await pg.click('.v3-markpad-row button[aria-label="8 out of 10"]')
            print('   after mark:', repr(await send.inner_text()), 'disabled=', await send.is_disabled(), '| qm active:', await pg.locator('.v2-qm-btn.is-active').count())
            await pg.fill('.v2-rc-comment textarea', 'Lovely even spacing — watch the nun bowls.')
            await pg.wait_for_timeout(300)
            print('   with comment:', repr(await send.inner_text()))
            # tapping a mark on the sheet must not send by itself
            if await pg.locator('.v2-qm-btn').count():
                await pg.locator('.v2-qm-btn').first.click(); await pg.wait_for_timeout(3200)
                print('   sheet mark tapped → still open:', await pg.locator('.v2-rc-send').count() == 1, '| label', repr(await send.inner_text()))
            await send.scroll_into_view_if_needed()
            await pg.screenshot(path=f'shots/review-marked-{s}.png')
            if s == 'desk':
                await pg.click('.v3-markpad-row button[aria-label="8 out of 10"]')
                await send.click(); await pg.wait_for_timeout(2500)
                print('   sent; errors on page:', await pg.locator('.v2-inline-error').count())
            if pg.errs: print('   page errors', pg.errs[:3])
            await ctx.close()
        await b.close()
    print(sql("select concat(st.email,' ',s.status,' ',s.mark) from step_submissions s join users st on st.id=s.student_id where s.reviewed_at > now() - interval 3 minute"))
asyncio.run(main())
