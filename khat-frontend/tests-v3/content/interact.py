import asyncio, json, urllib.request
from playwright.async_api import async_playwright
OUT='shots/'
def login(email):
    req=urllib.request.Request('http://127.0.0.1:4100/auth/login',data=json.dumps({'email':email,'password':'demo1234'}).encode(),headers={'Content-Type':'application/json'})
    return json.loads(urllib.request.urlopen(req).read())
async def ctx_for(b, email, w, h, touch):
    d=login(email); ctx=await b.new_context(viewport={'width':w,'height':h},has_touch=touch)
    pg=await ctx.new_page(); pg.set_default_timeout(180000)
    await pg.goto('http://127.0.0.1:5197/')
    await pg.evaluate("([t,u])=>{localStorage.setItem('khat_token',t);localStorage.setItem('khat_user',JSON.stringify(u));}",[d.get('token') or d.get('accessToken'),d['user']])
    # hide other agents' toasts for clean shots
    await pg.add_init_script("new MutationObserver(()=>document.querySelectorAll('.toast-stack,.notification-toasts,[class*=toast]').forEach(e=>e.style.display='none')).observe(document,{subtree:true,childList:true})")
    return ctx, pg
async def go(pg, r):
    await pg.goto('http://127.0.0.1:5197/#'+r); await pg.wait_for_load_state('networkidle'); await pg.wait_for_timeout(1200)
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        for size,(w,h,t) in {'ipad':(820,1180,True),'phone':(390,844,True),'desk':(1280,800,False)}.items():
            ctx,pg=await ctx_for(b,'student@demo.khat',w,h,t)
            await go(pg,'gallery')
            await pg.click('.v3c-ref-card'); await pg.wait_for_timeout(800)
            await pg.click('button[aria-label="Zoom in"]'); await pg.wait_for_timeout(300)
            await pg.screenshot(path=OUT+f'i-stu-gallery-viewer-{size}.png')
            await pg.click('.v3c-layer-close')
            await pg.click('text=Student showcase'); await pg.wait_for_timeout(1500)
            await pg.screenshot(path=OUT+f'i-stu-gallery-students-{size}.png', full_page=True)
            await pg.click('text=Teacher showcase'); await pg.wait_for_timeout(1500)
            await pg.screenshot(path=OUT+f'i-stu-gallery-teachers-{size}.png', full_page=True)
            print(size,'add-button visible for student:', await pg.locator('text=Add a reference piece').count())
            await go(pg,'events')
            await pg.click('.v3c-rec-card'); await pg.wait_for_timeout(1000)
            await pg.screenshot(path=OUT+f'i-stu-events-player-{size}.png')
            print(size,'iframe src', await pg.get_attribute('.v3c-yt-frame iframe','src'))
            await pg.click('.v3c-layer-close')
            await go(pg,'achievements')
            async with pg.expect_download() as dl:
                await pg.locator('.v3c-ach-card button:has-text("Download")').first.click()
            d=await dl.value; print(size,'badge download', d.suggested_filename)
            await ctx.close()
            ctx,pg=await ctx_for(b,'teacher@demo.khat',w,h,t)
            for r in ['showcase','events-host','gallery']:
                await go(pg,r); await pg.screenshot(path=OUT+f'i-tch-{r}-{size}.png', full_page=True)
            await pg.click('text=Add a reference piece'); await pg.wait_for_timeout(600)
            await pg.screenshot(path=OUT+f'i-tch-gallery-add-{size}.png')
            await pg.keyboard.press('Escape')
            await go(pg,'events-host')
            await pg.click('text=Add a recording'); await pg.wait_for_timeout(500)
            await pg.fill('input[placeholder="https://youtu.be/…"]','not a link'); await pg.wait_for_timeout(200)
            await pg.screenshot(path=OUT+f'i-tch-recording-dialog-{size}.png')
            await ctx.close()
        await b.close()
asyncio.run(main())
