import asyncio, subprocess, sys
from playwright.async_api import async_playwright
from common import *
SID = open('/tmp/e2e/survey_id').read().strip()
token = subprocess.run(['mariadb','-uroot','khat_e2e','-N','-e',f"select substring_index(substring_index(body,'survey?t=',-1),'\\n',1) from email_queue where ref_id='{SID}' and to_email='husain.b@example.com'"],capture_output=True,text=True).stdout.strip()
COURSE='3b9791c9-debf-4da8-b66d-5d2e4a902d08'; STEP='d35be285-2cbd-4e28-a452-74fd439dd3bb'
async def main():
    stu = login('student@demo.khat')
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        # ---- survey by link (no login)
        for i, s in enumerate(SIZES):
            ctx, pg = await open_as(b, s, None, f'survey?t={token}')
            txt = await pg.inner_text('body')
            assert 'Practice time at home' in txt, txt[:300]
            assert 'Salaam Husain' in txt
            await pg.screenshot(path=f'shots/survey-link-{s}.png', full_page=True)
            if i == 0:
                await pg.click('text=Send my answers'); await pg.wait_for_timeout(800)
                print('validation:', await pg.inner_text('.v2-error'))
                await pg.click('button[role=radio]:has-text("3-4")')
                await pg.click('button[aria-label="4 of 5"]')
                await pg.fill('textarea', 'I practise after Maghrib.')
                await pg.click('text=Send my answers'); await pg.wait_for_timeout(1500)
                assert 'Shukran' in await pg.inner_text('body')
                await pg.screenshot(path=f'shots/survey-link-sent-{s}.png')
            else:
                assert 'already answered' in txt, 'second open should show the earlier answer'
            if pg.errs: print(s, 'ERR', pg.errs)
            await ctx.close()
        ctx, pg = await open_as(b, 'phone', None, 'survey?t=bogus.token')
        print('bad token:', (await pg.inner_text('.v3ann-link-card'))[:120]); await ctx.close()
        # ---- provisional mark: task page, course window, dashboard, my progress
        for s in SIZES:
            ctx, pg = await open_as(b, s, stu, 'v2-task', {'courseId': COURSE, 'stepId': STEP})
            t = await pg.inner_text('.v3t-ribbon')
            assert 'Marked 7/10 · your teacher will confirm' in t, t
            await pg.screenshot(path=f'shots/provisional-task-{s}.png')
            guide = await pg.locator('text=Ask Guild Guide').count()
            assert guide == 0, 'Guild Guide hidden on task page'
            await ctx.close()
            ctx, pg = await open_as(b, s, stu, 'v2-course', {'courseId': COURSE, 'stepId': STEP})
            body = await pg.inner_text('body')
            print(s, 'course window provisional:', 'Marked 7/10 · your teacher will confirm' in body)
            await pg.screenshot(path=f'shots/provisional-course-{s}.png', full_page=True)
            await ctx.close()
            ctx, pg = await open_as(b, s, stu, 'v2-home')
            body = await pg.inner_text('body')
            print(s, 'dashboard provisional:', 'your teacher will confirm' in body, '| guide on home:', await pg.locator('text=Ask Guild Guide').count())
            await pg.screenshot(path=f'shots/provisional-home-{s}.png', full_page=True)
            await ctx.close()
        ctx, pg = await open_as(b, 'desk', stu, 'v2-my-progress')
        print('my progress provisional:', 'your teacher will confirm' in await pg.inner_text('body')); await ctx.close()
        await b.close()
asyncio.run(main())
