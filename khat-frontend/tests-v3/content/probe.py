import asyncio, sys, json, urllib.request
from playwright.async_api import async_playwright
def login(email):
    req=urllib.request.Request('http://127.0.0.1:4100/auth/login',data=json.dumps({'email':email,'password':'demo1234'}).encode(),headers={'Content-Type':'application/json'})
    return json.loads(urllib.request.urlopen(req).read())
async def main():
    d=login(sys.argv[1]); 
    async with async_playwright() as p:
        b=await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        pg=await b.new_page(viewport={'width':1280,'height':800}); pg.set_default_timeout(180000)
        await pg.goto('http://127.0.0.1:5197/')
        await pg.evaluate("([t,u])=>{localStorage.setItem('khat_token',t);localStorage.setItem('khat_user',JSON.stringify(u));}",[d.get('token') or d.get('accessToken'),d['user']])
        await pg.goto('http://127.0.0.1:5197/#'+sys.argv[2]); await pg.wait_for_load_state('networkidle'); await pg.wait_for_timeout(1500)
        print(await pg.evaluate(sys.argv[3]))
        await b.close()
asyncio.run(main())
