"""Demo content for the v3 content pages (gallery works, showcase posts, a YouTube recording, book details).
Re-runnable: skips gallery/showcase seeding when demo items already exist."""
import json, urllib.request, io, subprocess
from PIL import Image, ImageDraw, ImageFont
API='http://127.0.0.1:4100'
def req(method, path, tok=None, body=None, raw=None, ctype='application/json', url=None):
    h={'Content-Type':ctype}
    if tok: h['Authorization']='Bearer '+tok
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    r=urllib.request.Request(url or API+path, data=data, headers=h, method=method)
    try:
        out=urllib.request.urlopen(r).read()
    except urllib.error.HTTPError as e:
        print('HTTP', e.code, path, e.read()[:200]); raise
    return json.loads(out) if out and out[:1] in b'[{' else out
def login(u): d=req('POST','/auth/login',body={'email':u+'@demo.khat','password':'demo1234'}); return d.get('token') or d.get('accessToken')
FONT='/root/.fonts/amiri.ttf'
def piece(text, sub, w=900, h=1200, bg=(246,239,224), ink=(30,24,18), border=(150,110,40)):
    im=Image.new('RGB',(w,h),bg); d=ImageDraw.Draw(im)
    d.rectangle([30,30,w-30,h-30], outline=border, width=6); d.rectangle([48,48,w-48,h-48], outline=border, width=2)
    f=ImageFont.truetype(FONT, 120, layout_engine=ImageFont.Layout.RAQM)
    lines=text.split('\n'); y=h//2-len(lines)*90
    for ln in lines:
        tw=d.textlength(ln, font=f, direction='rtl', language='ar'); d.text(((w-tw)/2,y), ln, font=f, fill=ink, direction='rtl', language='ar'); y+=190
    fs=ImageFont.truetype(FONT, 34); tw=d.textlength(sub,font=fs); d.text(((w-tw)/2,h-130), sub, font=fs, fill=border)
    b=io.BytesIO(); im.save(b,'JPEG',quality=85); return b.getvalue()
def upload(tok, prefix, name, data, ct='image/jpeg'):
    p=req('POST','/uploads/presign',tok,{'prefix':prefix,'filename':name,'contentType':ct})
    req('PUT',None,raw=data,ctype=ct,url=p['uploadUrl']); return p['storageKey']
M=login('master'); T=login('teacher'); S=login('student'); BA=login('branchadmin')
existing=req('GET','/v2/gallery',M)
if not existing:
    for title,cal,script,txt,note,tok,branch in [
        ('Basmala in Thuluth','Hashim Muhammad al-Baghdadi','Thuluth','بسم الله\nالرحمن الرحيم','Notice how the tall letters rise evenly and the space between words stays calm.',M,'all'),
        ('Surat al-Ikhlas in Naskh','Hafiz Osman','Naskh','قل هو الله أحد\nالله الصمد','A classic Naskh page — study the baseline and the size of each nuqta.',M,'all'),
        ('Nastaleeq couplet','Mir Emad','Nastaleeq','خط نستعليق','The slope of the line and the long sweeping strokes are the heart of Nastaleeq.',T,None),
    ]:
        key=upload(tok,'assets',title+'.jpg',piece(txt,cal))
        body={'title':title,'calligrapher':cal,'script':script,'note':note,'storageKey':key}
        if branch: body['branchId']=branch
        print(req('POST','/v2/gallery',tok,body)['title'])
    k=upload(BA,'assets','marol.jpg',piece('رب زدني علما','Marol reference'))
    req('POST','/v2/gallery',BA,{'title':'Marol: Rabbi zidni ilma','calligrapher':'Marol faculty','script':'Naskh','storageKey':k})
mine=req('GET','/v2/showcase/mine',T)
if not mine:
    k=upload(T,'showcase','teacher-demo.jpg',piece('الخط الحسن\nيزيد الحق وضوحا','Teacher demonstration',bg=(240,244,236)))
    req('POST','/v2/showcase/posts',T,{'storageKey':k,'question':'What should students notice in this piece?','caption':'Watch the joins between haa and alif — keep the pen angle steady at 70°.','timeMinutes':150})
smine=[p for p in req('GET','/v2/showcase/mine',S) if p['source']=='post']
if not smine:
    k=upload(S,'showcase','student-demo.jpg',piece('محمد رسول الله','Mustafa — practice'))
    p=req('POST','/v2/showcase/posts',S,{'storageKey':k,'question':'Which letter or join was hardest, and how did you fix it?','caption':'The meem kept coming out too round. I practised it twenty times on 2 mm mistar until the head was small and neat.','timeMinutes':95})
    subprocess.run(['mariadb','-uroot','khat_e2e','-e',f"UPDATE showcase_posts SET status='approved' WHERE id='{p['id']}'"])
# YouTube recording
ev=req('GET','/events',S)
if not any(e.get('recording_youtube_url') for e in ev):
    print(req('POST','/v2/events/recordings',T,{'title':'Naskh demonstration — writing the alif and baa','description':'Live class recorded in the Funun al-Quran studio.','recordedOn':'2026-11-07','youtubeUrl':'https://youtu.be/DEMO0000001'}))
# book details
langs={'Meezan Ul Huruf':('Arabic','Ibn Muqla tradition','Proportions of each letter measured with the nuqta.'),'Khat Al-Farsi':('Arabic','Fawzi Salim Afifi','A full guide to Farsi (Nastaleeq) script.'),'Khutoot Al-Arabiyah':('Arabic',None,'The main Arabic scripts side by side.'),'Qawaid-Al-Khat':('Arabic','Hashim Muhammad al-Baghdadi','The rules of Naskh and Thuluth, letter by letter.')}
for b in req('GET','/v2/books',M):
    if b['title'] in langs and not b['language']:
        l,a,dsc=langs[b['title']]; req('PATCH','/v2/books/'+b['id'],M,{'language':l,'author':a,'description':dsc})
print('seeded')
