import asyncio, json, urllib.request
from playwright.async_api import async_playwright
d=json.loads(urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:4100/auth/login',data=json.dumps({'email':'student@demo.khat','password':'demo1234'}).encode(),headers={'Content-Type':'application/json'})).read())
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        pg=await b.new_page(); pg.set_default_timeout(180000)
        await pg.goto('http://127.0.0.1:5197/')
        await pg.evaluate("([t,u])=>{localStorage.setItem('khat_token',t);localStorage.setItem('khat_user',JSON.stringify(u));}",[d.get('token') or d.get('accessToken'),d['user']])
        await pg.goto('http://127.0.0.1:5197/#achievements'); await pg.wait_for_load_state('networkidle')
        async with pg.expect_download() as dl:
            await pg.locator('.v3c-ach-card button:has-text("Download")').first.click()
        x=await dl.value; path=await x.path(); print(x.suggested_filename, open(path,'rb').read(5))
        await b.close()
asyncio.run(main())
