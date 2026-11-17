/** fixer A (audit round): one notice per review, natural wording, badge naming, QR on student sheets. */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { digestFromMessages, emailComment, emptyDigest, notificationText, stepPage } from '../../src/v2/lib/threadNotify.js';
import { badgeWording } from '../../src/v2/lib/builderLogic.js';
import { ALL_STAMP_FIELDS, SHEET_QR, STAMP_LAYOUT, stampFiles } from '../../src/v2/lib/pdfStamp.js';

const DB = await import('../../src/db.js');
after(async () => { await DB.pool.end(); });

const LABEL = 'Qasaid Sharifa · Send all your sheets for assessment';

test('mark + drawing + comment → one plain-English sentence', () => {
  const d = digestFromMessages([
    { kind: 'annotation', body: 'Corrections marked on page 1', meta: {} },
    { kind: 'mark', body: 'Lovely work.', meta: { mark: 8, band: 'pass' }, sender_name: 'Ustad Ali' },
    { kind: 'text', body: 'Also practice the alif.', meta: {} },
  ]);
  assert.equal(d.mark, 8);
  assert.equal(d.drawing, true);
  assert.equal(d.teacherName, 'Ustad Ali');
  const text = notificationText(d, LABEL);
  assert.equal(text, `Your work has been marked: 8/10 — Pass. Your teacher also drew corrections on your sheet and wrote you a message. Open the step to see everything (${LABEL}).`);
  assert.doesNotMatch(text, /work work|your —/);
});

test('drawing only / reply only read naturally', () => {
  assert.equal(notificationText({ ...emptyDigest(), drawing: true }, LABEL), `Your teacher drew corrections on your sheet. Open the step to see it (${LABEL}).`);
  assert.equal(notificationText({ ...emptyDigest(), comments: ['Hi'] }, LABEL), `Your teacher wrote you a message. Open the step to see it (${LABEL}).`);
  assert.match(notificationText({ ...emptyDigest(), marked: true, mark: 7, band: 'pass' }, LABEL, { provisional: true }), /Your teacher will confirm it soon/);
});

test('email comment block carries every part once', () => {
  const d = { ...emptyDigest(), marked: true, mark: 5, band: 'revision' as const, drawing: true, comments: ['Watch the baseline.'] };
  const c = emailComment(d);
  assert.match(c, /"Watch the baseline\."/);
  assert.match(c, /drawn corrections/);
  assert.match(c, /upload your work again/);
});

test('step links carry their details in the address', () => {
  assert.equal(stepPage('c1', 's2'), 'v2-task?courseId=c1&stepId=s2');
});

test('badge wording never repeats the kind (audit 27)', () => {
  const w = badgeWording({ kind: 'course', courseTitle: "al-Urs al-Mi'awi — Mashq worksheets", courseType: 'mashq', levelOrder: null, label: '', hasLevels: false });
  assert.equal(w.subtitle, "al-Urs al-Mi'awi — Mashq worksheets");
  assert.equal(badgeWording({ kind: 'level', courseTitle: 'Urs', courseType: 'mashq', levelOrder: 0, label: '', hasLevels: false }).subtitle, 'Urs · Mashq worksheets');
});

test('student download with a sheet ID gets a QR next to it; content stays above it', async () => {
  const png = readFileSync(new URL('../../../khat-frontend/public/funun-logo-white.png', import.meta.url));
  const opts = { profile: { name: 'Test Student' }, fields: ALL_STAMP_FIELDS, copyrightText: 'c' } as const;
  const plain = await stampFiles([{ bytes: png, label: 'a' }], opts as never);
  const withId = await stampFiles([{ bytes: png, label: 'a' }], { ...opts, sheetId: 'FQ-7K3M2A' } as never);
  assert.ok(withId.bytes.length > plain.bytes.length, 'QR image embedded');
  assert.ok(withId.pages[0].content!.y >= SHEET_QR.edge + SHEET_QR.size, 'content never under the QR');
  assert.ok(plain.pages[0].content!.y >= STAMP_LAYOUT.footerH);
});
