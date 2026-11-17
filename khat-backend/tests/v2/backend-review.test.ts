/**
 * backend-review unit tests — pure logic only (no database).
 * Run: npx tsx --test tests/v2/backend-review.test.ts
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

// config.ts requires these at import time; the pool is lazy and never connects in these tests.
for (const [k, v] of Object.entries({
  DB_HOST: 'localhost', DB_NAME: 'test', DB_USER: 'test', DB_PASSWORD: 'test', JWT_SECRET: 'test',
  R2_ACCOUNT_ID: 'test', R2_ACCESS_KEY_ID: 'test', R2_SECRET_ACCESS_KEY: 'test', R2_BUCKET_NAME: 'test',
})) process.env[k] ??= v;

const L = await import('../../src/v2/lib/reviewLogic.js');
const T = await import('../../src/v2/lib/threadData.js');
const D = await import('../../src/v2/services/digest.js');
const AI = await import('../../src/v2/routes/ai.routes.js');
const DB = await import('../../src/db.js');
// the mysql2 pool keeps an idle timer alive; close it so the test process exits
after(async () => { await DB.pool.end(); });

const DEFAULT_BANDS = { revisionMax: 5, passMax: 8 };
const at = (s: string) => new Date(s);

describe('bands + decision outcome', () => {
  test('normaliseBands: defaults, JSON strings, clamping', () => {
    assert.deepEqual(L.normaliseBands(undefined), DEFAULT_BANDS);
    assert.deepEqual(L.normaliseBands('not json'), DEFAULT_BANDS);
    assert.deepEqual(L.normaliseBands('{"revisionMax":4,"passMax":7}'), { revisionMax: 4, passMax: 7 });
    assert.deepEqual(L.normaliseBands({ revisionMax: 12, passMax: 3 }), { revisionMax: 9, passMax: 9 });
    assert.deepEqual(L.normaliseBands({ revisionMax: -2, passMax: 99 }), { revisionMax: 0, passMax: 10 });
  });

  test('default bands: ≤5 revision, 6–8 pass, 9–10 distinction', () => {
    const want: Record<number, string> = { 1: 'revision', 5: 'revision', 6: 'pass', 8: 'pass', 9: 'distinction', 10: 'distinction' };
    for (const [mark, band] of Object.entries(want)) assert.equal(L.bandForMark(Number(mark), DEFAULT_BANDS), band);
  });

  test('decideOutcome for marked steps', () => {
    assert.deepEqual(L.decideOutcome({ hasMarks: true, mark: 5, bands: DEFAULT_BANDS }), { ok: true, status: 'revision', band: 'revision', mark: 5 });
    assert.deepEqual(L.decideOutcome({ hasMarks: true, mark: 6, bands: DEFAULT_BANDS }), { ok: true, status: 'passed', band: 'pass', mark: 6 });
    assert.deepEqual(L.decideOutcome({ hasMarks: true, mark: 9, bands: DEFAULT_BANDS }), { ok: true, status: 'passed', band: 'distinction', mark: 9 });
    assert.deepEqual(L.decideOutcome({ hasMarks: true, mark: '7', bands: DEFAULT_BANDS }), { ok: true, status: 'passed', band: 'pass', mark: 7 });
    // branch with stricter bands
    assert.deepEqual(L.decideOutcome({ hasMarks: true, mark: 6, bands: { revisionMax: 6, passMax: 8 } }), { ok: true, status: 'revision', band: 'revision', mark: 6 });
    for (const bad of [null, undefined, '', 0, 11, 7.5, 'abc', -1]) {
      const r = L.decideOutcome({ hasMarks: true, mark: bad, bands: DEFAULT_BANDS });
      assert.equal(r.ok, false, `mark ${String(bad)} must be rejected`);
      if (!r.ok) assert.match(r.error, /1 to 10/);
    }
  });

  test('decideOutcome for feedback-only steps (istinsakh) ignores marks', () => {
    assert.deepEqual(L.decideOutcome({ hasMarks: false, mark: 9, bands: DEFAULT_BANDS }), { ok: true, status: 'reviewed', band: null, mark: null });
    assert.deepEqual(L.decideOutcome({ hasMarks: false, mark: null, bands: DEFAULT_BANDS }), { ok: true, status: 'reviewed', band: null, mark: null });
  });

  test('lowestPassMark', () => {
    assert.equal(L.lowestPassMark(DEFAULT_BANDS), 6);
    assert.equal(L.lowestPassMark({ revisionMax: 4, passMax: 7 }), 5);
    assert.equal(L.lowestPassMark({ revisionMax: 0, passMax: 7 }), 1);
  });
});

describe('warm comment templates', () => {
  const policy = { revision: ['R1', 'R2'], pass: ['P1', 'P2', 'P3'], distinction: ['D1'] };
  test('stable per seed and taken from the band', () => {
    const a = L.pickTemplate(policy, 'pass', 'sub-1:7');
    assert.ok(policy.pass.includes(a));
    assert.equal(L.pickTemplate(policy, 'pass', 'sub-1:7'), a);
    assert.equal(L.pickTemplate(policy, 'distinction', 'x'), 'D1');
    assert.ok(policy.revision.includes(L.pickTemplate(JSON.stringify(policy), 'revision', 'y')));
  });
  test('falls back to built-in warm comments when the policy is empty or broken', () => {
    for (const raw of [null, 'oops', { pass: [] }, { pass: [42, '  '] }]) {
      const t = L.pickTemplate(raw, 'pass', 'seed');
      assert.ok(t.length > 20, 'a real sentence');
      assert.doesNotMatch(t, /auto/i, 'never says automatic');
    }
  });
  test('different seeds spread over the list', () => {
    const seen = new Set(Array.from({ length: 30 }, (_, i) => L.pickTemplate(policy, 'pass', `s${i}`)));
    assert.ok(seen.size >= 2);
  });
});

describe('automatic mark value', () => {
  test("uses the student's own average, rounded", () => {
    assert.equal(L.computeAutoMark({ studentAverage: 7.4, branchStepAverage: 9, bands: DEFAULT_BANDS }), 7);
    assert.equal(L.computeAutoMark({ studentAverage: 7.5, branchStepAverage: null, bands: DEFAULT_BANDS }), 8);
  });
  test('else the branch average for the step', () => {
    assert.equal(L.computeAutoMark({ studentAverage: null, branchStepAverage: 8.6, bands: DEFAULT_BANDS }), 9);
  });
  test('never below the lowest pass mark, never above 10', () => {
    assert.equal(L.computeAutoMark({ studentAverage: 3.2, branchStepAverage: 9, bands: DEFAULT_BANDS }), 6);
    assert.equal(L.computeAutoMark({ studentAverage: null, branchStepAverage: 2, bands: DEFAULT_BANDS }), 6);
    assert.equal(L.computeAutoMark({ studentAverage: null, branchStepAverage: null, bands: DEFAULT_BANDS }), 6);
    assert.equal(L.computeAutoMark({ studentAverage: null, branchStepAverage: null, bands: { revisionMax: 4, passMax: 7 } }), 5);
    assert.equal(L.computeAutoMark({ studentAverage: 10.4, branchStepAverage: null, bands: DEFAULT_BANDS }), 10);
    assert.equal(L.computeAutoMark({ studentAverage: Number.NaN, branchStepAverage: 7, bands: DEFAULT_BANDS }), 7);
  });
  test('an automatic mark always passes', () => {
    for (const avg of [1, 4, 5.4, 6, 9.9]) {
      const mark = L.computeAutoMark({ studentAverage: avg, branchStepAverage: null, bands: DEFAULT_BANDS });
      assert.notEqual(L.bandForMark(mark, DEFAULT_BANDS), 'revision');
    }
  });
});

describe('merit accrual with monthly cap and carry-over', () => {
  test('addMonths crosses years', () => {
    assert.equal(L.addMonths('2026-11', 1), '2026-12');
    assert.equal(L.addMonths('2026-12', 1), '2027-01');
    assert.equal(L.addMonths('2027-01', -1), '2026-12');
    assert.equal(L.addMonths('2026-05', 14), '2027-07');
  });
  test('fits in the month when there is room', () => {
    assert.deepEqual(L.allocateMeritPoints(1, '2026-11', {}, 10), [{ month: '2026-11', points: 1 }]);
    assert.deepEqual(L.allocateMeritPoints(10, '2026-11', {}, 10), [{ month: '2026-11', points: 10 }]);
  });
  test('overflow carries to the next month — never lost', () => {
    const chunks = L.allocateMeritPoints(10, '2026-11', { '2026-11': 4 }, 10);
    assert.deepEqual(chunks, [{ month: '2026-11', points: 6 }, { month: '2026-12', points: 4 }]);
    assert.equal(chunks.reduce((s, c) => s + c.points, 0), 10);
  });
  test('a full month is skipped; partly-used later months are respected', () => {
    assert.deepEqual(
      L.allocateMeritPoints(12, '2026-12', { '2026-12': 10, '2027-01': 7 }, 10),
      [{ month: '2027-01', points: 3 }, { month: '2027-02', points: 9 }],
    );
  });
  test('large awards spread over several months', () => {
    assert.deepEqual(L.allocateMeritPoints(25, '2026-11', {}, 10), [
      { month: '2026-11', points: 10 }, { month: '2026-12', points: 10 }, { month: '2027-01', points: 5 },
    ]);
  });
  test('no cap (0) and zero points', () => {
    assert.deepEqual(L.allocateMeritPoints(30, '2026-11', { '2026-11': 50 }, 0), [{ month: '2026-11', points: 30 }]);
    assert.deepEqual(L.allocateMeritPoints(0, '2026-11', {}, 10), []);
    assert.deepEqual(L.allocateMeritPoints(-3, '2026-11', {}, 10), []);
  });
  test('over-booked months (cap lowered later) do not go negative', () => {
    assert.deepEqual(L.allocateMeritPoints(2, '2026-11', { '2026-11': 15 }, 10), [{ month: '2026-12', points: 2 }]);
  });
  test('every 3 passed levels = 1 point', () => {
    assert.equal(L.levelPointBlocks(0, 3), 0);
    assert.equal(L.levelPointBlocks(2, 3), 0);
    assert.equal(L.levelPointBlocks(3, 3), 1);
    assert.equal(L.levelPointBlocks(7, 3), 2);
    assert.equal(L.levelPointBlocks(9, 3), 3);
    assert.equal(L.levelPointBlocks(5, 0), 0);
    assert.equal(L.levelBlockLabel(1, 3, 'FNK-C101'), 'Levels 1–3 of FNK-C101');
    assert.equal(L.levelBlockLabel(2, 3, 'FNK-C101'), 'Levels 4–6 of FNK-C101');
    assert.equal(L.levelBlockLabel(4, 1, 'FNK-C101'), 'Level 4 of FNK-C101');
  });
});

describe('next assignee', () => {
  const team = [{ id: 'b', openLoad: 3 }, { id: 'a', openLoad: 5 }, { id: 'c', openLoad: 1 }];
  test('least loaded first', () => assert.equal(L.chooseNextAssignee(team), 'c'));
  test('never back to a previous reviewer', () => {
    assert.equal(L.chooseNextAssignee(team, ['c']), 'b');
    assert.equal(L.chooseNextAssignee(team, new Set(['c', 'b'])), 'a');
    assert.equal(L.chooseNextAssignee(team, ['a', 'b', 'c']), null);
  });
  test('ties broken by id so the choice is stable', () => {
    assert.equal(L.chooseNextAssignee([{ id: 'z', openLoad: 2 }, { id: 'm', openLoad: 2 }]), 'm');
  });
  test('empty team and odd loads', () => {
    assert.equal(L.chooseNextAssignee([]), null);
    assert.equal(L.chooseNextAssignee([{ id: 'x', openLoad: Number.NaN }, { id: 'y', openLoad: 1 }]), 'x');
  });
});

describe('SLA decision', () => {
  const base = {
    status: 'submitted', createdAt: at('2026-11-01T08:00:00Z'), assignedAt: at('2026-11-01T08:00:00Z'), claimedAt: null,
    lastStaffActivityAt: null, now: at('2026-11-01T08:00:00Z'), divertAfterHours: 72, autoMarkEnabled: true, autoMarkAfterDays: 7,
  };
  test('closed work is never touched', () => {
    for (const status of ['passed', 'revision', 'reviewed']) {
      assert.equal(L.slaDecision({ ...base, status, now: at('2026-12-01T00:00:00Z') }), 'none');
    }
  });
  test('divert at 72 hours unanswered, not before', () => {
    assert.equal(L.slaDecision({ ...base, now: at('2026-11-04T07:59:00Z') }), 'none');
    assert.equal(L.slaDecision({ ...base, now: at('2026-11-04T08:00:00Z') }), 'divert');
  });
  test('a staff reply after assignment counts as an answer', () => {
    assert.equal(L.slaDecision({ ...base, lastStaffActivityAt: at('2026-11-02T08:00:00Z'), now: at('2026-11-05T09:00:00Z') }), 'none');
  });
  test('a staff reply before the current assignment does not', () => {
    assert.equal(L.slaDecision({
      ...base, assignedAt: at('2026-11-02T00:00:00Z'), lastStaffActivityAt: at('2026-11-01T10:00:00Z'), now: at('2026-11-05T01:00:00Z'),
    }), 'divert');
  });
  test('after a divert the new teacher gets a fresh 72 hours', () => {
    assert.equal(L.slaDecision({ ...base, assignedAt: at('2026-11-04T08:00:00Z'), now: at('2026-11-06T08:00:00Z') }), 'none');
  });
  test('a fresh claim restarts the clock; a stale claim is diverted', () => {
    const claimed = { ...base, status: 'in_review', claimedAt: at('2026-11-03T08:00:00Z') };
    assert.equal(L.slaDecision({ ...claimed, now: at('2026-11-05T08:00:00Z') }), 'none');
    assert.equal(L.slaDecision({ ...claimed, now: at('2026-11-06T08:00:00Z') }), 'divert');
  });
  test('automatic mark after 7 days even if a teacher talked but did not mark', () => {
    assert.equal(L.slaDecision({ ...base, now: at('2026-11-08T08:00:00Z') }), 'auto_mark');
    assert.equal(L.slaDecision({ ...base, lastStaffActivityAt: at('2026-11-07T08:00:00Z'), now: at('2026-11-08T08:00:00Z') }), 'auto_mark');
    assert.equal(L.slaDecision({ ...base, now: at('2026-11-08T07:59:00Z') }), 'divert');
  });
  test('auto mark disabled → keeps diverting; divert disabled with 0 hours', () => {
    assert.equal(L.slaDecision({ ...base, autoMarkEnabled: false, now: at('2026-11-20T08:00:00Z') }), 'divert');
    assert.equal(L.slaDecision({ ...base, autoMarkEnabled: false, divertAfterHours: 0, now: at('2026-11-20T08:00:00Z') }), 'none');
  });
  test('missing assignedAt falls back to createdAt', () => {
    assert.equal(L.slaDecision({ ...base, assignedAt: null, now: at('2026-11-04T08:00:00Z') }), 'divert');
  });
  test('hoursBetween', () => {
    assert.equal(L.hoursBetween(at('2026-11-01T00:00:00Z'), at('2026-11-01T01:30:00Z')), 1.5);
    assert.equal(L.hoursBetween(at('2026-11-02T00:00:00Z'), at('2026-11-01T00:00:00Z')), 0);
  });
});

describe('print codes', () => {
  test('generator format and alphabet', () => {
    for (let i = 0; i < 500; i++) {
      const code = L.generatePrintCode();
      assert.match(code, /^TK-[0-9A-HJKMNP-TV-Z]{5}$/);
      assert.ok(L.isValidPrintCode(code));
    }
    assert.equal(L.generatePrintCode(() => new Uint8Array([0, 1, 31, 32, 255])), 'TK-01Z0Z');
  });
  test('codes are varied', () => {
    const set = new Set(Array.from({ length: 2000 }, () => L.generatePrintCode()));
    assert.ok(set.size > 1990);
  });
  test('format check', () => {
    assert.ok(L.isValidPrintCode('TK-7F3K2'));
    for (const bad of ['TK-7F3K', 'TK-7F3K22', 'tk-7f3k2', 'TK-7F3KU', 'TK-7F3KI', 'XX-7F3K2', 'TK7F3K2']) assert.equal(L.isValidPrintCode(bad), false, bad);
  });
  test('normalise what teachers type or the scanner reads', () => {
    assert.equal(L.normalizePrintCode('TK-7F3K2'), 'TK-7F3K2');
    assert.equal(L.normalizePrintCode(' tk 7f3k2 '), 'TK-7F3K2');
    assert.equal(L.normalizePrintCode('7f3k2'), 'TK-7F3K2');
    assert.equal(L.normalizePrintCode('TK-7F3KO'), 'TK-7F3K0');
    assert.equal(L.normalizePrintCode('TK-1L1I0'), 'TK-11110');
    assert.equal(L.normalizePrintCode('KHAT:TK-7F3K2:3'), 'TK-7F3K2');
    for (const bad of ['', 'TK-', 'TK-7F3', 'TK-7F3KU', 'hello world', null, 42]) assert.equal(L.normalizePrintCode(bad), null, String(bad));
  });
  test('QR payload', () => {
    assert.deepEqual(L.parseQrPayload('KHAT:TK-7F3K2:3'), { printCode: 'TK-7F3K2', page: 3 });
    assert.deepEqual(L.parseQrPayload('khat:tk-7f3k2'), { printCode: 'TK-7F3K2', page: null });
    assert.equal(L.parseQrPayload('https://example.com'), null);
    assert.equal(L.parseQrPayload('KHAT:nope:1'), null);
  });
});

describe('Nairobi calendar, reminders, digest timing', () => {
  test('zonedParts uses Africa/Nairobi (UTC+3)', () => {
    const p = L.zonedParts(at('2026-11-10T21:30:00Z'));
    assert.equal(p.ymd, '2026-11-11');
    assert.equal(p.hour, 0);
    assert.equal(L.nairobiMonth(at('2026-11-30T21:00:00Z')), '2026-12');
    assert.equal(L.nairobiMonth(at('2026-11-30T20:59:00Z')), '2026-11');
  });
  test('isValidMonth', () => {
    assert.ok(L.isValidMonth('2026-11'));
    for (const bad of ['2026-13', '2026-1', '26-11', '', null]) assert.equal(L.isValidMonth(bad), false);
  });
  test('reminder on the reminder day and the last day, once each', () => {
    assert.deepEqual(L.meritReminderKindsDue(at('2026-11-25T06:00:00Z'), 25), ['day']);
    assert.deepEqual(L.meritReminderKindsDue(at('2026-11-30T06:00:00Z'), 25), ['last']);
    assert.deepEqual(L.meritReminderKindsDue(at('2026-11-24T06:00:00Z'), 25), []);
    // last day as seen in Nairobi, not UTC
    assert.deepEqual(L.meritReminderKindsDue(at('2026-11-30T22:00:00Z'), 25), []);
    assert.deepEqual(L.meritReminderKindsDue(at('2026-12-31T05:00:00Z'), 25), ['last']);
  });
  test('reminder day beyond the month is clamped; same day sends one reminder', () => {
    assert.deepEqual(L.meritReminderKindsDue(at('2026-02-28T06:00:00Z'), 30), ['last']);
    assert.deepEqual(L.meritReminderKindsDue(at('2026-02-27T06:00:00Z'), 30), []);
    assert.deepEqual(L.meritReminderKindsDue(at('2026-11-10T06:00:00Z'), '10'), ['day']);
    assert.deepEqual(L.meritReminderKindsDue(at('2026-11-25T06:00:00Z'), 'junk'), ['day']);
  });
  test('daily digest after 07:00 Nairobi, once a day', () => {
    assert.equal(L.digestDue(at('2026-11-10T03:59:00Z'), null), false); // 06:59 Nairobi
    assert.equal(L.digestDue(at('2026-11-10T04:00:00Z'), null), true);  // 07:00 Nairobi
    assert.equal(L.digestDue(at('2026-11-10T10:00:00Z'), '2026-11-10'), false);
    assert.equal(L.digestDue(at('2026-11-10T10:00:00Z'), '2026-11-09'), true);
    assert.equal(L.digestDue(at('2026-11-10T22:00:00Z'), '2026-11-10'), false); // 01:00 on the 11th, before 07:00
  });
});

describe('digest content', () => {
  const now = at('2026-11-10T08:00:00Z');
  const open = [
    { branchId: 'NBO', assignee: 't1', created: at('2026-11-06T08:00:00Z') },
    { branchId: 'NBO', assignee: 't2', created: at('2026-11-10T02:00:00Z') },
    { branchId: 'SRT', assignee: 't1', created: at('2026-11-09T08:00:00Z') }, // forwarded to t1
    { branchId: 'SRT', assignee: 's1', created: at('2026-11-01T08:00:00Z') },
    { branchId: 'SRT', assignee: 'admin1', created: at('2026-11-08T08:00:00Z') },
  ];
  test('teacher: whole branch inbox + work forwarded to them', () => {
    assert.deepEqual(D.summariseForStaff(open, { id: 't1', role: 'teacher', branchId: 'NBO' }, now, 72), { total: 3, mine: 2, oldestHours: 96, overdue: 1 });
    assert.deepEqual(D.summariseForStaff(open, { id: 't2', role: 'teacher', branchId: 'NBO' }, now, 72), { total: 2, mine: 1, oldestHours: 96, overdue: 1 });
  });
  test('admin: only work assigned to them; nobody → nothing', () => {
    assert.deepEqual(D.summariseForStaff(open, { id: 'admin1', role: 'admin', branchId: 'NBO' }, now, 72), { total: 1, mine: 0, oldestHours: 48, overdue: 0 });
    assert.equal(D.summariseForStaff(open, { id: 'x', role: 'teacher', branchId: 'KHI' }, now, 72).total, 0);
  });
  test('email text is short and encouraging', () => {
    const t = D.digestText({ firstName: 'Ian', total: 3, mine: 2, oldestHours: 96, overdue: 1, divertHours: 72, link: 'https://x/#v2-inbox' });
    assert.equal(t.subject, '3 pieces of work waiting for review');
    assert.match(t.body, /Salaam Ian,/);
    assert.match(t.body, /4 days/);
    assert.match(t.body, /quick mark/);
    assert.match(t.body, /#v2-inbox/);
    assert.equal(D.describeWait(0.5), 'less than an hour');
    assert.equal(D.describeWait(5), '5 hours');
    assert.equal(D.describeWait(25), '1 day');
  });
});

describe('comment polish (AI fallback) and AI tidy', () => {
  test("keeps the teacher's words, adds warmth, ≤ 3 sentences", () => {
    const out = L.polishComment('your alifat are not straight, vertical huruf not going well', { studentName: 'Murtaza Ali', mark: 5 });
    assert.match(out, /^Thank you for your careful effort, Murtaza\./);
    assert.match(out, /Your alifat are not straight, vertical huruf not going well\./);
    assert.ok(L.splitSentences(out).length <= 3, out);
  });
  test('band-aware openers and closings', () => {
    assert.match(L.polishComment('nice nuqta', { mark: 9 }), /^Excellent work\. Nice nuqta\. Keep this standard/);
    assert.match(L.polishComment('baseline is steady', { mark: 7 }), /^Well done — your practice is showing\./);
  });
  test('tidies spacing, i → I, punctuation; empty text still gives a warm line', () => {
    assert.match(L.polishComment('i think   the kursi is low ,try again'), /I think the kursi is low, try again\./);
    const empty = L.polishComment('   ', { mark: 6 });
    assert.ok(empty.length > 10);
    const long = L.polishComment('One. Two. Three. Four. Five.');
    assert.ok(L.splitSentences(long).length <= 3, long);
  });
  test('tidyAiComment strips quotes/markdown and caps sentences', () => {
    assert.equal(L.tidyAiComment('"**Good** work. Second. Third. Fourth."'), 'Good work. Second. Third.');
  });
  test('refine prompt keeps meaning and calligraphy vocabulary rules', () => {
    const p = AI.buildRefinePrompt({ text: 'alif not straight', studentName: 'Huzaifa Shabbir', mark: 5, band: 'revision', tone: 'warm', language: 'ur' });
    assert.match(p.system, /at most 3/);
    assert.match(p.system, /alif, nuqta, baseline/);
    assert.match(p.system, /Urdu/);
    assert.match(p.user, /Huzaifa\n/);
    assert.match(p.user, /alif not straight/);
    assert.match(p.user, /5\/10 \(revision\)/);
  });
});

describe('badge codes', () => {
  test('level badge: step badge, else level badge, else BDG_<CODE>_<LV>', () => {
    assert.equal(L.levelBadgeCode({ stepBadge: 'X', levelBadge: 'Y', courseCode: 'FNK-C101', courseId: 'id', levelCode: 'LV01' }), 'X');
    assert.equal(L.levelBadgeCode({ stepBadge: ' ', levelBadge: 'Y', courseCode: 'FNK-C101', courseId: 'id', levelCode: 'LV01' }), 'Y');
    assert.equal(L.levelBadgeCode({ stepBadge: null, levelBadge: null, courseCode: 'FNK-C101', courseId: 'id', levelCode: 'LV02' }), 'BDG_FNK-C101_LV02');
    assert.equal(L.levelBadgeCode({ stepBadge: null, levelBadge: null, courseCode: null, courseId: 'ab12cd34-0000', levelCode: 'LV01' }), 'BDG_CAB12CD_LV01');
  });
  test('course badge', () => {
    assert.equal(L.courseBadgeCode({ stepBadge: 'FINAL', courseCode: 'FNK-C101', courseId: 'id', isFinalStep: true }), 'FINAL');
    assert.equal(L.courseBadgeCode({ stepBadge: 'FINAL', courseCode: 'FNK-C101', courseId: 'id', isFinalStep: false }), 'BDG_FNK-C101_COURSE');
  });
});

describe('defensive parsing + sanitising', () => {
  test('parseJson', () => {
    assert.deepEqual(L.parseJson('{"a":1}', {}), { a: 1 });
    assert.deepEqual(L.parseJson('nope', { d: 1 }), { d: 1 });
    assert.deepEqual(L.parseJson(null, []), []);
    assert.deepEqual(L.parseJson(Buffer.from('[1,2]'), []), [1, 2]);
  });
  test('attachments', () => {
    const out = T.sanitiseAttachments(JSON.stringify([
      { storageKey: 'submissions/a.jpg', originalFilename: 'a.jpg', contentType: 'image/jpeg', forStepId: 'step-1' },
      { storageKey: '../etc/passwd' },
      { storageKey: '' },
      'junk',
      { storageKey: 'submissions/b.pdf' },
    ]));
    assert.equal(out.length, 2);
    assert.deepEqual(out[1], { storageKey: 'submissions/b.pdf', originalFilename: 'b.pdf', contentType: 'application/octet-stream', forStepId: null });
    assert.deepEqual(T.sanitiseAttachments('not json'), []);
    assert.equal(T.sanitiseAttachments(Array.from({ length: 30 }, (_, i) => ({ storageKey: `k${i}` })), 20).length, 20);
  });
  test('strokes are normalised 0..1 and tools checked', () => {
    const strokes = T.sanitiseStrokes([{ tool: 'laser', color: '#ff0000', width: 500, points: [[-1, 0.5], [2, 'x'], 'bad'] }, { tool: 'pen', points: [] }]);
    assert.deepEqual(strokes, [{ tool: 'pen', color: '#ff0000', width: 100, points: [[0, 0.5], [1, 0]] }]);
  });
  test('pins keep numbers, text and voice keys', () => {
    const pins = T.sanitisePins([{ n: 2, x: 0.3, y: 1.4, text: '  alif slant ', voiceStorageKey: 'voice/1.webm', durationSec: 4.26 }, { x: 0.1, y: 0.1 }]);
    assert.deepEqual(pins[0], { n: 2, x: 0.3, y: 1, text: 'alif slant', voiceStorageKey: 'voice/1.webm', durationSec: 4.3 });
    assert.equal(pins[1].n, 2);
    assert.equal(pins[1].text, null);
  });
  test('mapSubmission hides staff-only facts from students', () => {
    const row = {
      id: 's1', student_id: 'u1', step_id: 'st', level_id: 'l', course_id: 'c', attempt_no: 2, status: 'passed', mark: 7, band: 'pass',
      rubric: '{"form":2}', files: '[{"storageKey":"k"}]', claimed_by: null, claimed_by_name: null, reviewed_by: null, reviewed_by_name: null,
      reviewed_at: new Date('2026-11-08T08:00:00Z'), created_at: new Date('2026-11-01T08:00:00Z'), print_code: 'TK-7F3K2', auto_marked: true, diverted_count: 2,
    };
    const staff = T.mapSubmission(row, { forStudent: false });
    const student = T.mapSubmission(row, { forStudent: true });
    assert.equal(staff.autoMarked, true);
    assert.equal(staff.divertedCount, 2);
    assert.equal(student.autoMarked, false);
    assert.equal(student.divertedCount, 0);
    assert.equal(student.reviewedByName, 'Course team');
    assert.deepEqual(student.rubric, { form: 2 });
    assert.equal(student.files[0].storageKey, 'k');
  });
  test('mapMessage names the course team for automatic / system messages', () => {
    const m = T.mapMessage({ id: 'm', student_id: 'u', step_id: 's', sender_id: null, sender_role: 'teacher', kind: 'mark', body: 'Well done', attachments: null, meta: '{"mark":7,"band":"pass"}', created_at: new Date(), student_read_at: null });
    assert.equal(m.senderName, 'Course team');
    assert.deepEqual(m.meta, { mark: 7, band: 'pass' });
    assert.equal(m.readByStudent, false);
    const s = T.mapMessage({ id: 'm2', student_id: 'u', step_id: 's', sender_id: null, sender_role: 'system', kind: 'system', body: 'x', created_at: new Date() });
    assert.equal(s.senderName, 'Tehseen al-Khat');
  });
});

describe('spill-over network (limits, away, overflow web)', () => {
  const now = at('2026-11-10T08:00:00Z');
  const node = (id: string, branchId: string, openLoad: number, spillTo: string[] = [], extra: Partial<import('../../src/v2/lib/reviewLogic.js').ReviewerNode> = {}) =>
    ({ id, branchId, openLoad, threshold: 15, awayUntil: null, spillTo, isTeacher: true, isMasterTeam: branchId === 'NBO', ...extra });

  test('effectiveThreshold: zero setup = 15, explicit values kept', () => {
    assert.equal(L.effectiveThreshold(null), 15);
    assert.equal(L.effectiveThreshold(0), 15);
    assert.equal(L.effectiveThreshold('junk'), 15);
    assert.equal(L.effectiveThreshold(5), 5);
    assert.equal(L.effectiveThreshold('30'), 30);
  });

  test('availability: away or at the limit', () => {
    assert.equal(L.isAvailable(node('a', 'SRT', 14), now), true);
    assert.equal(L.isAvailable(node('a', 'SRT', 15), now), false);
    assert.equal(L.isAvailable(node('a', 'SRT', 0, [], { awayUntil: at('2026-11-12T00:00:00Z') }), now), false);
    assert.equal(L.isAvailable(node('a', 'SRT', 0, [], { awayUntil: at('2026-11-09T00:00:00Z') }), now), true); // away date passed
  });

  test('new work: least-loaded available teacher of the branch', () => {
    const nodes = [node('s1', 'SRT', 9), node('s2', 'SRT', 3), node('s3', 'SRT', 3, [], { awayUntil: at('2026-12-01T00:00:00Z') }), node('n1', 'NBO', 0)];
    assert.deepEqual(L.chooseInitialAssignee(nodes, 'SRT', now), { teacherId: 's2', route: 'branch' });
  });

  test('admins are not part of the branch pool', () => {
    const nodes = [node('adm', 'SRT', 0, [], { isTeacher: false }), node('s1', 'SRT', 4)];
    assert.equal(L.chooseInitialAssignee(nodes, 'SRT', now).teacherId, 's1');
  });

  test('branch full → follows the spill web breadth-first, across branches', () => {
    const nodes = [
      node('s1', 'SRT', 15, ['s2', 'k1']),
      node('s2', 'SRT', 15, ['m1']),
      node('k1', 'KHI', 15, ['k2']),
      node('m1', 'MRL', 2),
      node('k2', 'KHI', 0),
    ];
    // BFS order from s1/s2: s2's own targets come after s1's (k1 full) → m1 (from s2) before k2 (from k1)
    assert.deepEqual(L.chooseInitialAssignee(nodes, 'SRT', now), { teacherId: 'm1', route: 'spill' });
  });

  test('cycles in the web do not loop forever', () => {
    const nodes = [node('a', 'SRT', 15, ['b']), node('b', 'SRT', 15, ['c']), node('c', 'KHI', 15, ['a', 'b'])];
    assert.deepEqual(L.chooseInitialAssignee(nodes, 'SRT', now), { teacherId: 'a', route: 'fallback' });
    assert.equal(L.walkSpillWeb(new Map(nodes.map(n => [n.id, n])), ['a'], () => false), null);
  });

  test('everyone full → least-loaded branch teacher anyway (never block a student)', () => {
    const nodes = [node('s1', 'SRT', 20), node('s2', 'SRT', 16), node('s3', 'SRT', 1, [], { awayUntil: at('2026-12-01T00:00:00Z') })];
    assert.deepEqual(L.chooseInitialAssignee(nodes, 'SRT', now), { teacherId: 's2', route: 'fallback' });
  });

  test('everyone away → still assigned to someone', () => {
    const away = { awayUntil: at('2026-12-01T00:00:00Z') };
    const nodes = [node('s1', 'SRT', 4, [], away), node('s2', 'SRT', 2, [], away)];
    assert.deepEqual(L.chooseInitialAssignee(nodes, 'SRT', now), { teacherId: 's2', route: 'fallback' });
  });

  test('branch without teachers → master team', () => {
    const nodes = [node('n1', 'NBO', 15), node('n2', 'NBO', 3), node('adm', 'NBO', 0, [], { isTeacher: false, isMasterTeam: true, threshold: 1 })];
    assert.deepEqual(L.chooseInitialAssignee(nodes, 'SID', now), { teacherId: 'adm', route: 'master' });
    assert.deepEqual(L.chooseInitialAssignee([], 'SID', now), { teacherId: null, route: 'none' });
  });

  test('divert: the current teacher’s own overflow list first', () => {
    const nodes = [node('s1', 'SRT', 2, ['s3', 's2']), node('s2', 'SRT', 0), node('s3', 'SRT', 5)];
    assert.deepEqual(L.chooseDivertTarget(nodes, { currentId: 's1', branchId: 'SRT', exclude: [], now }), { teacherId: 's3', reason: 'diverted' });
  });

  test('divert: no list → rest of branch least busy first, then the master team', () => {
    const nodes = [node('s1', 'SRT', 2), node('s2', 'SRT', 7), node('s3', 'SRT', 4), node('n1', 'NBO', 0)];
    assert.deepEqual(L.chooseDivertTarget(nodes, { currentId: 's1', branchId: 'SRT', exclude: [], now }), { teacherId: 's3', reason: 'diverted' });
    assert.deepEqual(L.chooseDivertTarget(nodes, { currentId: 's1', branchId: 'SRT', exclude: ['s2', 's3'], now }), { teacherId: 'n1', reason: 'forwarded' });
  });

  test('divert: never back to a previous reviewer, even via the web', () => {
    const nodes = [node('s1', 'SRT', 2, ['s2']), node('s2', 'SRT', 0, ['s1', 'k1']), node('k1', 'KHI', 1)];
    assert.deepEqual(L.chooseDivertTarget(nodes, { currentId: 's1', branchId: 'SRT', exclude: ['s2'], now }), { teacherId: 'k1', reason: 'forwarded' });
    assert.deepEqual(L.chooseDivertTarget(nodes, { currentId: 's1', branchId: 'SRT', exclude: ['s2', 'k1'], now }), { teacherId: null, reason: 'none' });
  });

  test('divert: away targets are skipped; when all are full, a not-away teacher still gets it', () => {
    const away = { awayUntil: at('2026-12-01T00:00:00Z') };
    const nodes = [node('s1', 'SRT', 2, ['s2']), node('s2', 'SRT', 0, [], away), node('s3', 'SRT', 30), node('n1', 'NBO', 20)];
    assert.deepEqual(L.chooseDivertTarget(nodes, { currentId: 's1', branchId: 'SRT', exclude: [], now }), { teacherId: 's3', reason: 'diverted' });
  });

  test('away teacher’s open work spills on the next sweep', () => {
    const input = {
      status: 'submitted', createdAt: now, assignedAt: now, claimedAt: null, lastStaffActivityAt: null,
      now: at('2026-11-10T09:00:00Z'), divertAfterHours: 72, autoMarkEnabled: true, autoMarkAfterDays: 7,
    };
    assert.equal(L.slaDecision(input), 'none');
    assert.equal(L.slaDecision({ ...input, assigneeAway: true }), 'divert');
    assert.equal(L.slaDecision({ ...input, assigneeAway: true, status: 'passed' }), 'none');
  });

  test('"Set up my branch automatically" builds a ring + Nairobi as last stop', () => {
    const ring = L.buildRing(['a', 'b', 'c'], ['n1', 'n2']);
    assert.deepEqual(ring.get('a'), ['b', 'n1', 'n2']);
    assert.deepEqual(ring.get('c'), ['a', 'n1', 'n2']);
    assert.deepEqual(L.buildRing(['solo'], ['n1']).get('solo'), ['n1']);
    assert.deepEqual(L.buildRing(['solo']).get('solo'), []);
    assert.deepEqual(L.buildRing(['a', 'b'], ['a']).get('a'), ['b']); // a branch member is never its own last stop
  });
});

describe('away-until parsing', () => {
  test('date only = end of that day in Nairobi; null clears; junk rejected', async () => {
    const R = await import('../../src/v2/routes/review.routes.js');
    assert.equal((R.parseAwayUntil('2026-11-20') as Date).toISOString(), '2026-11-20T20:59:59.000Z');
    assert.equal((R.parseAwayUntil('2026-11-20T10:00:00Z') as Date).toISOString(), '2026-11-20T10:00:00.000Z');
    assert.equal(R.parseAwayUntil(null), null);
    assert.equal(R.parseAwayUntil(''), null);
    assert.equal(R.parseAwayUntil('soon'), 'invalid');
    assert.equal(R.parseAwayUntil(42), 'invalid');
  });
});
