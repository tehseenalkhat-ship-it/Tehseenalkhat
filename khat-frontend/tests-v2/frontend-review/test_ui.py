"""frontend-review UI test. Needs: npx vite --port 5183 --strictPort (from khat-frontend).
Run: python3 tests-v2/frontend-review/test_ui.py"""
import io, os, sys, time, zipfile
from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mock import Mock  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.join(HERE, 'shots')
FIX = os.path.join(HERE, 'fixtures')
BASE = 'http://localhost:5183/tests-v2/frontend-review/harness.html'
VIEWPORTS = {'phone': (390, 844, True), 'ipad': (820, 1180, True), 'desktop': (1280, 800, False)}
results = []


def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(('PASS ' if cond else 'FAIL ') + name + (f' — {detail}' if detail and not cond else ''))


def ctx_for(browser, vp):
    w, h, touch = VIEWPORTS[vp]
    return browser.new_context(viewport={'width': w, 'height': h}, has_touch=touch, is_mobile=touch and vp == 'phone',
                               device_scale_factor=2 if touch else 1, accept_downloads=True)


def open_page(browser, vp, view, theme='sky', mock=None):
    mock = mock or Mock()
    ctx = ctx_for(browser, vp)
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.route('http://localhost:4000/**', mock.handle)
    page.goto(f'{BASE}?view={view}&theme={theme}')
    return ctx, page, mock, errors


def shot(page, name, full=False):
    page.wait_for_timeout(350)
    page.screenshot(path=os.path.join(SHOTS, f'{name}.png'), full_page=full)


def touch(cdp, kind, pts):
    cdp.send('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': [{'x': x, 'y': y, 'id': i} for i, (x, y) in enumerate(pts)]})


def stage_box(page):
    return page.locator('[data-testid=annotator-stage] .v2-ann-layer').bounding_box()


ONLY = os.environ.get('ONLY')
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'])

    if not ONLY or 'inbox' in ONLY:
        # ---------- Inbox list on 3 sizes ----------
        for vp in VIEWPORTS:
            ctx, page, mock, errors = open_page(browser, vp, 'inbox')
            page.wait_for_selector('.v2-inbox-row')
            check(f'inbox rows render ({vp})', page.locator('.v2-inbox-row').count() == 6)
            first = page.locator('.v2-inbox-row').first.inner_text()
            check(f'inbox oldest first ({vp})', 'Fatema' in first, first[:60])
            shot(page, f'inbox-{vp}')
            # workload panel
            page.get_by_role('button', name='My workload').click()
            page.wait_for_selector('.v2-side.is-open .v2-wl-limit')
            shot(page, f'workload-{vp}')
            if vp == 'ipad':
                page.get_by_role('button', name='Raise my limit').click()
                page.wait_for_timeout(900)
                puts = mock.find('PUT', '/v2/review/network/t-1')
                check('workload: limit saved', puts and puts[-1]['body'].get('threshold') == 16, str(puts[-1:]))
                page.get_by_role('button', name='Add').click()
                page.get_by_placeholder('Search a teacher').fill('tahir')
                page.locator('.v2-wl-results button').first.click()
                page.wait_for_timeout(500)
                puts = mock.find('PUT', '/v2/review/network/t-1')
                check('workload: overflow chip added', puts[-1]['body'].get('spillTo') == ['t-2', 't-3'], str(puts[-1]['body']))
                page.locator('.v2-chip-main').nth(1).click()
                page.get_by_role('button', name='Move Sh Tahir bhai up').click()
                page.wait_for_timeout(500)
                check('workload: reorder', mock.find('PUT', '/v2/review/network/t-1')[-1]['body'].get('spillTo') == ['t-3', 't-2'])
                shot(page, 'workload-ipad-edited')
                page.get_by_role('button', name='Remove Sh Tahir bhai').click()  # still open after moving up
                page.locator('.v2-chip-main').first.click()
                page.get_by_role('button', name='Remove Sh Moiz bhai').click()
                page.wait_for_timeout(500)
                check('workload: empty hint', page.locator('.v2-wl-hint').is_visible())
                shot(page, 'workload-ipad-empty')
            check(f'no page errors inbox ({vp})', not errors, '; '.join(errors))
            ctx.close()

        # other themes (desktop)
        for theme in ('lavender', 'sage', 'rose'):
            ctx, page, mock, errors = open_page(browser, 'desktop', 'inbox', theme)
            page.wait_for_selector('.v2-inbox-row')
            shot(page, f'inbox-desktop-{theme}')
            ctx.close()

    if not ONLY or 'workspace' in ONLY:
        # ---------- Split view on iPad: touch draw, pinch, long-press pin, mark + send, auto-next ----------
        ctx, page, mock, errors = open_page(browser, 'ipad', 'inbox')
        page.wait_for_selector('.v2-inbox-row')
        page.locator('.v2-inbox-open').first.click()
        page.wait_for_selector('[data-testid=review-workspace]')
        page.wait_for_function("document.querySelector('.v2-ann-layer') && document.querySelector('.v2-ann-layer').style.visibility === 'visible'")
        check('claim posted', bool(mock.find('POST', '/claim')))
        cdp = ctx.new_cdp_session(page)
        b = stage_box(page)
        x0, y0 = b['x'] + b['width'] * 0.3, b['y'] + b['height'] * 0.3
        touch(cdp, 'touchStart', [(x0, y0)])
        for i in range(1, 16):
            touch(cdp, 'touchMove', [(x0 + i * 12, y0 + (i % 5) * 6)])
        touch(cdp, 'touchEnd', [])
        page.wait_for_timeout(200)
        check('touch stroke drawn (undo enabled)', page.get_by_role('button', name='Undo').is_enabled())
        # long-press → pin
        lx, ly = b['x'] + b['width'] * 0.6, b['y'] + b['height'] * 0.5
        touch(cdp, 'touchStart', [(lx, ly)])
        page.wait_for_timeout(700)
        touch(cdp, 'touchEnd', [])
        page.wait_for_selector('.v2-pin-editor')
        check('long-press creates pin 1', page.locator('.v2-ann-pin').count() == 1)
        page.locator('.v2-pin-text').fill('Keep the baa flat on the baseline.')
        shot(page, 'workspace-ipad-pin')
        page.get_by_role('button', name='Done').click()
        # pinch zoom (re-measure: the page may have scrolled)
        b = stage_box(page)
        cx, cy = b['x'] + b['width'] / 2, b['y'] + b['height'] / 2
        touch(cdp, 'touchStart', [(cx - 40, cy), (cx + 40, cy)])
        for i in range(1, 8):
            touch(cdp, 'touchMove', [(cx - 40 - i * 15, cy), (cx + 40 + i * 15, cy)])
        touch(cdp, 'touchEnd', [])
        zoom = page.locator('.v2-ann-zoom span').inner_text()
        check('pinch zooms', int(zoom.rstrip('%')) > 150, zoom)
        check('pinch did not draw a stroke', page.locator('.v2-ann-pin').count() == 1)
        page.get_by_role('button', name='Fit to screen').click()
        # rubric + comment + AI refine
        page.locator('.v2-rc-comment textarea').fill('good, alif lean, more space')
        page.get_by_role('button', name='✨ Refine with AI').click()
        page.wait_for_selector('.v2-rc-suggestion')
        shot(page, 'workspace-ipad-refine')
        page.get_by_role('button', name='Use this').click()
        check('AI suggestion accepted', 'Fatema' in page.locator('.v2-rc-comment textarea').input_value())
        page.evaluate('document.activeElement && document.activeElement.blur()')
        page.keyboard.press('7')
        check('key 7 selects mark', page.locator('.v2-rc-mark strong').inner_text() == '7')
        page.keyboard.press('Enter')
        page.wait_for_function("document.querySelector('.v2-ws-title strong') && document.querySelector('.v2-ws-title strong').textContent !== 'Fatema Saifuddin'", timeout=15000)
        puts = mock.find('PUT', '/v2/annotations')
        check('annotation saved with stroke + pin', puts and len(puts[-1]['body']['strokes']) >= 1 and puts[-1]['body']['pins'][0]['text'].startswith('Keep'), str(puts[-1]['body'] if puts else None)[:200])
        check('flattened image uploaded', any(k.startswith('annotations/') for k in mock.store))
        dec = mock.find('POST', '/decision')
        check('decision mark 7 with comment', dec and dec[-1]['body']['mark'] == 7 and dec[-1]['body']['comment'], str(dec[-1]['body'] if dec else None))
        check('auto-advanced to next item', 'Mustafa' in page.locator('.v2-ws-title strong').inner_text())
        # Mustafa = istinsakh (feedback only) → no quick marks
        check('feedback-only step hides quick marks', page.locator('.v2-ann-overlay .v2-qm').count() == 0)
        page.keyboard.press('j')
        page.wait_for_timeout(300)
        # Zainab (assessment): one-tap quick mark with countdown
        page.wait_for_selector('.v2-ann-overlay .v2-qm-btn')
        page.locator('.v2-ann-overlay .v2-qm-btn', has_text='9').first.tap()
        page.wait_for_selector('.v2-qm.is-countdown')
        shot(page, 'workspace-ipad-countdown')
        page.wait_for_timeout(3300)
        dec = mock.find('POST', '/decision')
        check('one-tap mark sends after countdown', dec[-1]['path'].endswith('sub-12/decision') and dec[-1]['body']['mark'] == 9, str(dec[-1]))
        shot(page, 'workspace-ipad')
        check('no page errors workspace', not errors, '; '.join(errors))
        ctx.close()

        # split view desktop + phone screenshots, mouse draw + right-click pin
        for vp in ('desktop', 'phone'):
            ctx, page, mock, errors = open_page(browser, vp, 'inbox')
            page.wait_for_selector('.v2-inbox-row')
            page.locator('.v2-inbox-open').first.click()
            page.wait_for_function("document.querySelector('.v2-ann-layer') && document.querySelector('.v2-ann-layer').style.visibility === 'visible'")
            b = stage_box(page)
            if vp == 'desktop':
                page.mouse.move(b['x'] + 200, b['y'] + 150)
                page.mouse.down()
                for i in range(20):
                    page.mouse.move(b['x'] + 200 + i * 8, b['y'] + 150 + (i % 4) * 5)
                page.mouse.up()
                page.mouse.click(b['x'] + 330, b['y'] + 260, button='right')
                page.wait_for_selector('.v2-pin-editor')
                check('right-click creates pin', page.locator('.v2-ann-pin').count() == 1)
                page.get_by_role('button', name='Done').click()
            else:
                cdp = ctx.new_cdp_session(page)
                x0, y0 = b['x'] + b['width'] * 0.2, b['y'] + b['height'] * 0.4
                touch(cdp, 'touchStart', [(x0, y0)])
                for i in range(1, 12):
                    touch(cdp, 'touchMove', [(x0 + i * 10, y0 - i * 4)])
                touch(cdp, 'touchEnd', [])
            shot(page, f'workspace-{vp}')
            if vp == 'phone':
                page.locator('.v2-ws-thread').scroll_into_view_if_needed()
                shot(page, 'workspace-phone-thread')
            check(f'no page errors split ({vp})', not errors, '; '.join(errors))
            ctx.close()

    if not ONLY or 'bulk' in ONLY:
        # ---------- Bulk: ZIP + print pack ----------
        ctx, page, mock, errors = open_page(browser, 'desktop', 'inbox')
        page.wait_for_selector('.v2-inbox-row')
        page.locator('.v2-inbox-check input').nth(0).check()
        page.locator('.v2-inbox-check input').nth(1).check()
        shot(page, 'inbox-desktop-selected')
        with page.expect_download() as dl:
            page.get_by_role('button', name='Download all').click()
        path = dl.value.path()
        names = zipfile.ZipFile(path).namelist()
        check('zip names <printCode>_<student>_<step>_<n>', 'TK-7F3K2_Fatema-Saifuddin_LV01-S05_1.png' in names and len(names) == 4, str(names))
        with ctx.expect_page() as newp:
            page.get_by_role('button', name='Print all').click()
        page.wait_for_timeout(800)
        pp = mock.find('POST', '/v2/review/print-pack')
        check('print pack requested', pp and pp[-1]['body']['submissionIds'] == ['sub-2', 'sub-11'] and pp[-1]['body']['include'] == 'assessment_only', str(pp[-1:]))
        ctx.close()

    if not ONLY or 'thread' in ONLY:
        # ---------- Student thread: bubbles, viewer, annotation pins, submit flow ----------
        for vp in VIEWPORTS:
            ctx, page, mock, errors = open_page(browser, vp, 'thread-student')
            page.wait_for_selector('.v2-markcard')
            page.wait_for_timeout(800)
            shot(page, f'thread-student-{vp}')
            if vp == 'phone':
                check('day separators', page.locator('.v2-day').count() == 2)
                check('unread divider shown', page.locator('.v2-unread-line').count() == 1)
                check('mark card 5/10 + band', '5' in page.locator('.v2-markcard-mark').inner_text() and 'Try again' in page.locator('.v2-markcard').inner_text())
                page.locator('.v2-annthumb').click()
                page.wait_for_selector('.v2-viewer .v2-ann-pin.is-view')
                page.locator('.v2-viewer .v2-ann-pin.is-view').first.tap()
                page.wait_for_selector('.v2-viewer-note .v2-voice')
                check('tapping pin opens its voice note', page.locator('.v2-viewer-note').inner_text().find('alif') >= 0)
                shot(page, 'annotation-view-phone')
                page.get_by_role('button', name='Close').click()
                page.locator('.v2-bubble.is-submission .v2-thumb').first.click()
                page.wait_for_selector('.v2-viewer-layer img')
                shot(page, 'media-viewer-phone')
                page.get_by_role('button', name='Close').click()
                # submit flow
                page.get_by_role('button', name='Send again').click()
                page.wait_for_selector('.v2-sheet')
                page.get_by_role('button', name='Send for review').last.click()
                check('validation shows missing photos', page.locator('.v2-slot.is-missing').count() == 3)
                shot(page, 'submit-sheet-missing-phone')
                inputs = page.locator('.v2-slot input[type=file][multiple]')
                inputs.nth(0).set_input_files(os.path.join(FIX, 'sheet1.png'))
                inputs.nth(1).set_input_files(os.path.join(FIX, 'worksheet.pdf'))
                inputs.nth(2).set_input_files([os.path.join(FIX, 'assess.png'), os.path.join(FIX, 'sheet2.png')])
                page.wait_for_timeout(700)
                shot(page, 'submit-sheet-ready-phone')
                page.get_by_role('button', name='Send for review').last.click()
                page.wait_for_selector('.v2-sheet', state='detached', timeout=15000)
                sub = mock.find('POST', '/submit')
                files = sub[-1]['body']['files'] if sub else []
                check('submit: 4 files with forStepId per slot', [f.get('forStepId') for f in files] == ['st-1', 'st-2', 'st-5', 'st-5'], str(files)[:300])
                page.wait_for_selector('.v2-submitbar.is-quiet')
                # text + attach
                page.get_by_label('Message', exact=True).fill('Sent my second try')
                page.get_by_role('button', name='Send', exact=True).click()
                page.wait_for_timeout(800)
                check('text message posted', any(c['body'] and c['body'].get('kind') == 'text' for c in mock.find('POST', '/messages')))
                page.get_by_role('button', name='Attach photos or PDF').click()
                shot(page, 'thread-attach-menu-phone')
                check('attach menu: camera/photos/pdf', page.locator('.v2-attach-menu button').count() == 3)
                page.locator('.v2-attach input[accept="image/*"][multiple]').set_input_files(os.path.join(FIX, 'sheet2.png'))
                page.get_by_role('button', name='Send', exact=True).click()
                page.wait_for_timeout(1000)
                check('files message posted', any(c['body'] and c['body'].get('kind') == 'files' for c in mock.find('POST', '/messages')))
                # voice note via fake mic
                page.get_by_role('button', name='Record a voice note').click()
                page.wait_for_selector('.v2-recbar')
                page.wait_for_timeout(1300)
                shot(page, 'thread-recording-phone')
                page.get_by_role('button', name='Send voice note').click()
                page.wait_for_timeout(1500)
                vm = [c for c in mock.find('POST', '/messages') if c['body'] and c['body'].get('kind') == 'voice']
                check('voice note uploaded + posted', vm and vm[-1]['body']['attachments'][0]['storageKey'].startswith('voice/'), str(vm[-1:])[:200])
                shot(page, 'thread-student-after-phone')
            check(f'no page errors thread ({vp})', not errors, '; '.join(errors))
            ctx.close()

        ctx, page, mock, errors = open_page(browser, 'ipad', 'thread-staff')
        page.wait_for_selector('.v2-reviewbar')
        page.wait_for_timeout(600)
        shot(page, 'thread-staff-ipad')
        page.get_by_role('button', name='Mark on the sheet').click()
        page.wait_for_selector('.v2-annotate-overlay .v2-ann-layer')
        page.wait_for_timeout(600)
        shot(page, 'thread-staff-annotate-ipad')
        check('no page errors staff thread', not errors, '; '.join(errors))
        ctx.close()

    if not ONLY or 'scan' in ONLY:
        # ---------- Scan return: real QR decode from a print-pack-like PDF ----------
        for vp in ('desktop', 'phone', 'ipad'):
            ctx, page, mock, errors = open_page(browser, vp, 'scan')
            page.wait_for_selector('[data-testid=scan-input]', state='attached')
            if vp != 'desktop':
                shot(page, f'scan-empty-{vp}')
            page.locator('[data-testid=scan-input]').set_input_files(os.path.join(FIX, 'scan.pdf'))
            try:
                page.wait_for_selector('[data-testid=scan-unmatched]', timeout=30000)
            except Exception:
                print('SCAN PAGE TEXT:', page.locator('main').inner_text()[:800], errors)
                raise
            page.wait_for_function("document.querySelectorAll('[data-testid=scan-group]').length === 2 && !document.querySelector('.v2-scan-who .v2-spin')", timeout=30000)
            groups = page.locator('[data-testid=scan-group]')
            texts = [groups.nth(i).inner_text() for i in range(groups.count())]
            check(f'scan: 2 students found ({vp})', any('Fatema' in t for t in texts) and any('Mustafa' in t for t in texts), str(texts)[:200])
            check(f'scan: upside-down page decoded ({vp})', any('Mustafa' in t for t in texts))
            check(f'scan: Fatema has pages p1,p2 ({vp})', any('Fatema' in t and 'p1' in t and 'p2' in t for t in texts))
            check(f'scan: 1 unmatched page ({vp})', page.locator('[data-testid=scan-unmatched]').count() == 1)
            check(f'scan: by-code lookups ({vp})', len(mock.find('GET', '/v2/review/by-code/')) == 2)
            shot(page, f'scan-found-{vp}', full=True)
            if vp == 'desktop':
                um = page.locator('[data-testid=scan-unmatched]')
                um.locator('input').fill('TK-7F3K2')
                um.get_by_role('button', name='Use code').click()
                page.wait_for_timeout(300)
                check('scan: typed code moves page to Fatema', page.locator('[data-testid=scan-unmatched]').count() == 0)
                g0 = page.locator('[data-testid=scan-group]').filter(has_text='Fatema')
                g0.locator('.v2-qm-btn', has_text='8').click()
                g0.locator('input.field').fill('Good correction work')
                page.get_by_role('button', name='Send all').click()
                page.wait_for_selector('.v2-scan-results', timeout=20000)
                body = mock.find('POST', '/v2/review/scan-return')[-1]['body']
                fat = next(i for i in body['items'] if i['submissionId'] == 'sub-2')
                check('scan-return: Fatema 3 pages + mark 8', len(fat['pageStorageKeys']) == 3 and fat['mark'] == 8 and fat['comment'] == 'Good correction work', str(fat))
                check('scan-return: pages uploaded to scan-returns/', all(k.startswith('scan-returns/') for k in fat['pageStorageKeys']))
                check('scan-return: 2 items', len(body['items']) == 2)
                shot(page, 'scan-results-desktop', full=True)
            check(f'no page errors scan ({vp})', not errors, '; '.join(errors))
            ctx.close()

    browser.close()

failed = [r for r in results if not r[1]]
print(f'\n{len(results) - len(failed)}/{len(results)} checks passed')
sys.exit(1 if failed else 0)
