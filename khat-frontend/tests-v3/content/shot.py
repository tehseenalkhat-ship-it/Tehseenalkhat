import asyncio, sys, json, urllib.request
from playwright.async_api import async_playwright
OUT='/home/claude/work/src/tehseen_ul_khat/khat-frontend/tests-v3/content/shots/'
SIZES={'phone':(390,844,True),'ipad':(820,1180,True),'desk':(1280,800,False)}
def login(email):
    req=urllib.request.Request('http://127.0.0.1:4100/auth/login',data=json.dumps({'email':email,'password':'demo1234'}).encode(),headers={'Content-Type':'application/json'})
    return json.loads(urllib.request.urlopen(req).read())
email=sys.argv[1]; routes=sys.argv[2].split(','); sizes=(sys.argv[3] if len(sys.argv)>3 else 'desk').split(',')
tag=sys.argv[4] if len(sys.argv)>4 else email.split('@')[0]
async def main():
    d=login(email); tok=d.get('token') or d.get('accessToken'); user=d.get('user')
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        for s in sizes:
            w,h,t=SIZES[s]
            ctx=await b.new_context(viewport={'width':w,'height':h},has_touch=t,is_mobile=(s=='phone'))
            pg=await ctx.new_page(); pg.set_default_timeout(180000)
            errs=[]
            pg.on('console', lambda m: errs.append(m.text) if m.type=='error' else None)
            pg.on('response', lambda r: errs.append(f'{r.status} {r.url}') if r.status>=400 else None)
            await pg.goto('http://127.0.0.1:5197/')
            await pg.evaluate("([t,u])=>{localStorage.setItem('khat_token',t);localStorage.setItem('khat_user',JSON.stringify(u));}",[tok,user])
            for r in routes:
                errs.clear()
                await pg.goto('http://127.0.0.1:5197/#'+r)
                await pg.wait_for_load_state('networkidle'); await pg.wait_for_timeout(1500)
                await pg.screenshot(path=OUT+f'{tag}-{r}-{s}.png', full_page=True)
                if s==sizes[0]:
                    txt=await pg.evaluate("document.querySelector('main')?.innerText?.slice(0,1800)||document.body.innerText.slice(0,600)")
                    print('=====',r,'\n',txt)
                if errs: print('ERRORS',r,s,errs[:8])
            await ctx.close()
        await b.close()
asyncio.run(main())
