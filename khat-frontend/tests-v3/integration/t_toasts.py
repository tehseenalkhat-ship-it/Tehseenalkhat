import asyncio
from playwright.async_api import async_playwright
from common import *
COURSE='3b9791c9-debf-4da8-b66d-5d2e4a902d08'; STEP='d35be285-2cbd-4e28-a452-74fd439dd3bb'
SID='85566fc3-dd21-11f1-886a-02fc00000001'; STEP2='173e99d5-e03f-11f1-93d5-02fc00000001'
def overlap(a, b):
    return not (a['x']+a['width'] <= b['x'] or b['x']+b['width'] <= a['x'] or a['y']+a['height'] <= b['y'] or b['y']+b['height'] <= a['y'])
async def toasts(pg):
    return await pg.locator('.global-notification-toast').count()
async def main():
    stu = login('student@demo.khat'); tea = login('teacher@demo.khat')
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        for s in SIZES:
            api('/notifications/read-all', stu['token'], {}, 'PATCH')
            ctx, pg = await open_as(b, s, stu, 'v2-home')
            await pg.wait_for_timeout(2000)
            assert await toasts(pg) == 0
            # two replies in one chat (→ one pop-up) + a reply in another step + a department reply → max two visible
            for i in range(2):
                r = api(f'/v2/threads/{STEP}/messages', tea['token'], {'studentId': SID, 'kind': 'text', 'body': f'Shabash, look at the alif in line {i+1} (test {s}).'})
                assert r.get('id') or r.get('message'), r
            api(f'/v2/threads/{STEP2}/messages', tea['token'], {'studentId': SID, 'kind': 'text', 'body': 'Good joins here too.'})
            api(f'/v2/dept-chat/{SID}/messages', login('master@demo.khat')['token'], {'kind': 'text', 'body': 'Salaam, class is at 5 pm today.'})
            for _ in range(32):
                await pg.wait_for_timeout(1000)
                if await toasts(pg) >= 2: break
            await pg.wait_for_timeout(1500)
            n = await toasts(pg)
            box = await pg.locator('.global-notification-toasts').bounding_box()
            hdr = [await el.bounding_box() for el in await pg.locator('.global-topbar-actions button, .mobile-hamburger-btn, .global-search').all()]
            hdr = [h for h in hdr if h and h['width'] > 0]
            covers = any(overlap(box, h) for h in hdr) if box else None
            print('   titles:', await pg.locator('.global-notification-toast strong').all_inner_texts())
            title = await pg.locator('.global-notification-toast strong').first.inner_text() if n else ''
            body = await pg.locator('.global-notification-toast small').first.inner_text() if n else ''
            print(f'{s}: visible={n} box={box and {k: round(v) for k, v in box.items()}} covers_header={covers} title="{title}" body="{body}"')
            assert n == 2, n
            assert not covers
            assert 'S0' not in body and 'LV0' not in body and 'FNK' not in body
            await pg.screenshot(path=f'shots/toasts-{s}.png')
            # tap → opens the task page for that step
            await pg.click('.global-notification-toast-body')
            await pg.wait_for_timeout(3000)
            print('   tap →', await pg.evaluate('location.hash'), await pg.evaluate('sessionStorage.getItem("khat.v2.param.stepId")') == STEP)
            await ctx.close()
        # ---- no pop-up while that step's chat is open
        api('/notifications/read-all', stu['token'], {}, 'PATCH')
        ctx, pg = await open_as(b, 'desk', stu, 'v2-task', {'courseId': COURSE, 'stepId': STEP})
        await pg.wait_for_timeout(1500)
        for _ in range(4):
            if await toasts(pg): await pg.click('.global-notification-toast-close'); await pg.wait_for_timeout(300)
        api(f'/v2/threads/{STEP}/messages', tea['token'], {'studentId': SID, 'kind': 'text', 'body': 'Reply while the chat is open.'})
        await pg.wait_for_timeout(16500)
        print('task page open, same step → toasts:', await toasts(pg))
        await ctx.close()
        # ---- department chat open → no dept_reply pop-up; elsewhere → pop-up
        api('/notifications/read-all', stu['token'], {}, 'PATCH')
        ctx, pg = await open_as(b, 'phone', stu, 'v2-dept-chat')
        await pg.wait_for_timeout(1500)
        for _ in range(4):
            if await toasts(pg): await pg.click('.global-notification-toast-close'); await pg.wait_for_timeout(300)
        print('guild guide on dept chat:', await pg.locator('text=Ask Guild Guide').count())
        r = api(f'/v2/dept-chat/{SID}/messages', login('master@demo.khat')['token'], {'kind': 'text', 'body': 'Salaam Mustafa, your mistar is ready at the office.'})
        print('dept post:', str(r)[:100])
        await pg.wait_for_timeout(16500)
        print('dept chat open → toasts:', await toasts(pg))
        await pg.screenshot(path='shots/dept-chat-phone.png')
        await ctx.close()
        await b.close()
asyncio.run(main())
