/**
 * v3 teacher — unit tests (pure logic + PDF stamping, no database).
 * Run: npx tsx --test tests/v2/v3-teacher.test.ts
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';

for (const [k, v] of Object.entries({
  DB_HOST: 'localhost', DB_NAME: 'test', DB_USER: 'test', DB_PASSWORD: 'test', JWT_SECRET: 'test',
  R2_ACCOUNT_ID: 'test', R2_ACCESS_KEY_ID: 'test', R2_SECRET_ACCESS_KEY: 'test', R2_BUCKET_NAME: 'test',
})) process.env[k] ??= v;

const S = await import('../../src/v2/lib/sheetIds.js');
const TL = await import('../../src/v2/lib/teacherLogic.js');
const L = await import('../../src/v2/lib/reviewLogic.js');
const R = await import('../../src/v2/routes/review.routes.js');
const P = await import('../../src/v2/lib/pdfStamp.js');
const DB = await import('../../src/db.js');
after(async () => { await DB.pool.end(); });

describe('sheet IDs', () => {
  test('format FQ- + 6 Crockford chars, unique-looking', () => {
    const ids = new Set(Array.from({ length: 500 }, () => S.generateSheetId()));
    for (const id of ids) assert.match(id, S.SHEET_ID_RE);
    assert.ok(ids.size > 490);
  });
  test('deterministic with a fixed random source', () => {
    assert.equal(S.generateSheetId(() => new Uint8Array([0, 1, 2, 31, 32, 63])), 'FQ-012Z0Z');
  });
  test('normalise typed IDs', () => {
    assert.equal(S.normalizeSheetId('fq-7k3m2a'), 'FQ-7K3M2A');
    assert.equal(S.normalizeSheetId('FQ 7K3M2A'), 'FQ-7K3M2A');
    assert.equal(S.normalizeSheetId('fq7k3m2a'), 'FQ-7K3M2A');
    assert.equal(S.normalizeSheetId('FQ-7K3O2L'), 'FQ-7K3021');
    assert.equal(S.normalizeSheetId('TK-7F3K2'), null);
    assert.equal(S.normalizeSheetId('FQ-12345'), null);
    assert.equal(S.normalizeSheetId(42), null);
  });
});

describe('course kinds (queue split Certification / Mashq / Crash)', () => {
  test('known kinds pass, anything else is certification', () => {
    assert.equal(R.courseKindOf('mashq'), 'mashq');
    assert.equal(R.courseKindOf(' Crash '), 'crash');
    assert.equal(R.courseKindOf('certification'), 'certification');
    assert.equal(R.courseKindOf(null), 'certification');
    assert.equal(R.courseKindOf('practice'), 'certification');
  });
});

describe('give one more attempt', () => {
  test('attempts allowed = policy max + grants; 0 = unlimited', () => {
    assert.equal(TL.attemptsAllowed(3, 0), 3);
    assert.equal(TL.attemptsAllowed(3, 2), 5);
    assert.equal(TL.attemptsAllowed('3', 1), 4);
    assert.equal(TL.attemptsAllowed(0, 4), null);
    assert.equal(TL.attemptsAllowed(undefined, 1), null);
  });
  test('only for marked, not passed, nothing waiting', () => {
    assert.equal(TL.extraAttemptBlock({ hasMarks: true, passed: false, open: false }), null);
    assert.match(TL.extraAttemptBlock({ hasMarks: false, passed: false, open: false })!, /no marks/);
    assert.match(TL.extraAttemptBlock({ hasMarks: true, passed: true, open: false })!, /passed/);
    assert.match(TL.extraAttemptBlock({ hasMarks: true, passed: false, open: true })!, /waiting/);
  });
  test('kind message names student and teacher', () => {
    const m = TL.EXTRA_ATTEMPT_MESSAGE('Zainab', 'Ali');
    assert.match(m, /Salaam Zainab/);
    assert.match(m, /— Ali$/);
  });
});

describe('automatic (96 h) mark message — written as from the teacher', () => {
  test('warm, uses first names, never says "automatic"', () => {
    for (const band of ['pass', 'distinction'] as const) {
      for (let i = 0; i < 20; i++) {
        const m = L.autoMarkMessage({ studentName: 'Fatema Burhani', teacherName: 'Ustad Ali Hakimuddin', band, seed: `s${i}` });
        assert.match(m, /Fatema/);
        assert.doesNotMatch(m, /Burhani/);
        assert.match(m, /Ustad Ali Hakimuddin$/);
        assert.doesNotMatch(m, /automatic|auto/i);
      }
    }
  });
  test('stable per submission and safe without names', () => {
    const a = L.autoMarkMessage({ band: 'pass', seed: 'x1' });
    assert.equal(a, L.autoMarkMessage({ band: 'pass', seed: 'x1' }));
    assert.match(a, /Your teacher$/);
    assert.match(a, /^[A-Z]/);
  });
});

describe('teacher accountability', () => {
  const now = new Date('2026-11-15T12:00:00Z');
  const base = { openNow: 0, overdueNow: 0, oldestWaitingHours: null, reviewed30d: 5, divertedAway30d: 0, autoMarked30d: 0, lastReviewAt: new Date('2026-11-14T12:00:00Z'), now, divertHours: 72 };
  test('answering in time → ok', () => {
    const r = TL.accountabilityStatus({ ...base, openNow: 2 });
    assert.equal(r.status, 'ok');
    assert.match(r.reason, /2 pieces open — last answered 1 day ago/);
  });
  test('overdue but answered recently → slow', () => {
    assert.equal(TL.accountabilityStatus({ ...base, openNow: 3, overdueNow: 1 }).status, 'slow');
    assert.equal(TL.accountabilityStatus({ ...base, divertedAway30d: 2 }).status, 'slow');
  });
  test('overdue and silent 3+ days, or 2 automatic marks → not responding', () => {
    const r = TL.accountabilityStatus({ ...base, openNow: 4, overdueNow: 2, lastReviewAt: new Date('2026-11-10T12:00:00Z') });
    assert.equal(r.status, 'not_responding');
    assert.match(r.reason, /2 pieces waiting over 72 hours/);
    assert.match(r.reason, /5 days ago/);
    assert.equal(TL.accountabilityStatus({ ...base, autoMarked30d: 2 }).status, 'not_responding');
    assert.equal(TL.accountabilityStatus({ ...base, overdueNow: 1, lastReviewAt: null }).status, 'not_responding');
  });
  test('nothing at all → idle; sort order puts problems first', () => {
    assert.equal(TL.accountabilityStatus({ ...base, reviewed30d: 0, lastReviewAt: null }).status, 'idle');
    const order = (['ok', 'idle', 'not_responding', 'slow'] as const).slice().sort((a, b) => TL.STATUS_ORDER[a] - TL.STATUS_ORDER[b]);
    assert.deepEqual(order, ['not_responding', 'slow', 'ok', 'idle']);
  });
});

describe('stamped PDFs carry the sheet ID', () => {
  async function blankPdf(): Promise<Uint8Array> {
    const d = await PDFDocument.create();
    d.addPage([595, 842]).drawRectangle({ x: 50, y: 50, width: 100, height: 100 });
    return d.save();
  }
  test('student download stamp with sheetId still produces one page per source page', async () => {
    const res = await P.stampFiles([{ bytes: await blankPdf(), label: 'sheet' }], {
      profile: { name: 'Zainab Najmi', trNumber: '30104', className: 'Darajah 3', branchName: 'Nairobi' },
      fields: ['name', 'tr', 'class', 'branch', 'date'], sheetId: 'FQ-7K3M2A', date: new Date('2026-11-15T09:00:00Z'),
    });
    assert.equal(res.pageCount, 1);
    assert.equal(res.skipped.length, 0);
  });
  test('print pack with sheetId keeps the QR payload KHAT:<printCode>:<page>', async () => {
    const res = await P.buildPrintPack([
      { printCode: 'TK-7F3K2', studentName: 'Zainab Najmi', trNumber: '30104', className: 'Darajah 3', branchName: 'Nairobi', sheetId: 'FQ-7K3M2A', files: [{ bytes: await blankPdf() }] },
      { printCode: 'TK-Q9M4H', studentName: 'Ammar Shakir', sheetId: null, files: [{ bytes: await blankPdf() }, { bytes: await blankPdf() }] },
    ]);
    assert.equal(res.pageCount, 3);
    assert.deepEqual(res.pages.map(p => p.payload), ['KHAT:TK-7F3K2:1', 'KHAT:TK-Q9M4H:1', 'KHAT:TK-Q9M4H:2']);
    const doc = await PDFDocument.load(res.bytes);
    assert.equal(doc.getPageCount(), 3);
  });
});

describe('v3 audit 26: status follows recent activity', () => {
  const now = new Date('2026-11-15T12:00:00Z');
  const base = { openNow: 0, overdueNow: 0, oldestWaitingHours: null, reviewed30d: 1, divertedAway30d: 0, autoMarked30d: 0, now, divertHours: 72 };
  test('work open, last answer 33 days ago → not answering lately (never "in time")', () => {
    const r = TL.accountabilityStatus({ ...base, openNow: 3, lastReviewAt: new Date('2026-10-13T12:00:00Z') });
    assert.equal(r.status, 'slow');
    assert.match(r.reason, /^Not answering lately · 3 pieces open — last answered 33 days ago/);
  });
  test('nothing open and quiet for a week → quiet, not ok', () => {
    assert.equal(TL.accountabilityStatus({ ...base, lastReviewAt: new Date('2026-11-01T12:00:00Z') }).status, 'idle');
  });
});
