// owner: insights — run with: npx tsx --test tests/v2/insights.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DAY_MS, DEFAULT_SEGMENT_CONFIG, averageMark, buildBranchMetrics, buildTeamMembers, canNudge, clampDays,
  compareInsights, daysBetween, emailBudget, hoursFromSeconds, latestDate, pct, pickSweepTargets,
  renderNudgeTemplate, segmentConfigFrom, segmentStudent, toDate, type StudentFacts,
} from '../../src/v2/lib/insightsLogic.js';

const NOW = new Date('2026-11-10T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY_MS);
const cfg = DEFAULT_SEGMENT_CONFIG;

function facts(over: Partial<StudentFacts> = {}): StudentFacts {
  return {
    joinedAt: daysAgo(100), lastActiveAt: daysAgo(2), submissions: 3, markSum: 0, markCount: 0,
    openRevisions: 0, pendingReviews: 0, maxAttempts: 1,
    courseCode: 'FNK-C101', courseTitle: 'Naskh Style One', currentLevel: 'Level 2',
    ...over,
  };
}

// ---------- segmentation ----------

test('new: joined < 14 days and nothing submitted', () => {
  const r = segmentStudent(facts({ joinedAt: daysAgo(5), lastActiveAt: daysAgo(1), submissions: 0 }), cfg, NOW);
  assert.equal(r.segment, 'new');
  assert.match(r.reason, /Joined 5 days ago/);
});

test('new ends once something is submitted, or after 14 days', () => {
  assert.notEqual(segmentStudent(facts({ joinedAt: daysAgo(5), submissions: 1 }), cfg, NOW).segment, 'new');
  assert.notEqual(segmentStudent(facts({ joinedAt: daysAgo(14), lastActiveAt: daysAgo(1), submissions: 0 }), cfg, NOW).segment, 'new');
});

test('needs_push exactly at nudge.inactive_days (21), not at 20', () => {
  assert.equal(segmentStudent(facts({ lastActiveAt: daysAgo(20) }), cfg, NOW).segment, 'doing_well');
  const r = segmentStudent(facts({ lastActiveAt: daysAgo(21) }), cfg, NOW);
  assert.equal(r.segment, 'needs_push');
  assert.equal(r.reason, 'No activity for 21 days in Naskh Style One, Level 2');
});

test('needs_push mentions replies we still owe', () => {
  const r = segmentStudent(facts({ lastActiveAt: daysAgo(38), pendingReviews: 1 }), cfg, NOW);
  assert.equal(r.reason, 'No activity for 38 days in Naskh Style One, Level 2 (still waiting on 1 reply from us)');
});

test('dormant exactly at nudge.dormant_days (180), with months in words', () => {
  assert.equal(segmentStudent(facts({ lastActiveAt: daysAgo(179) }), cfg, NOW).segment, 'needs_push');
  const r = segmentStudent(facts({ lastActiveAt: daysAgo(214) }), cfg, NOW);
  assert.equal(r.segment, 'dormant');
  assert.equal(r.reason, 'No activity for 214 days (about 7 months) in Naskh Style One, Level 2');
});

test('never active: idle counted from the joining date', () => {
  const push = segmentStudent(facts({ joinedAt: daysAgo(40), lastActiveAt: null, submissions: 0 }), cfg, NOW);
  assert.equal(push.segment, 'needs_push');
  assert.match(push.reason, /^Has not started practicing since joining 40 days ago/);
  const dormant = segmentStudent(facts({ joinedAt: daysAgo(400), lastActiveAt: null, submissions: 0 }), cfg, NOW);
  assert.equal(dormant.segment, 'dormant');
  assert.match(dormant.reason, /since joining 400 days/);
  assert.equal(segmentStudent(facts({ joinedAt: null, lastActiveAt: null }), cfg, NOW).segment, 'dormant');
});

test('branch thresholds from policies are respected', () => {
  const custom = segmentConfigFrom({ 'nudge.inactive_days': 10, 'nudge.dormant_days': 60, 'assessment.bands': { revisionMax: 6, passMax: 8 } });
  assert.deepEqual(custom, { inactiveDays: 10, dormantDays: 60, bands: { revisionMax: 6, passMax: 8 } });
  assert.equal(segmentStudent(facts({ lastActiveAt: daysAgo(10) }), custom, NOW).segment, 'needs_push');
  assert.equal(segmentStudent(facts({ lastActiveAt: daysAgo(60) }), custom, NOW).segment, 'dormant');
  // average 6 is a pass by default but a revision with revisionMax 6
  assert.equal(segmentStudent(facts({ markSum: 12, markCount: 2 }), cfg, NOW).segment, 'doing_well');
  assert.equal(segmentStudent(facts({ markSum: 12, markCount: 2 }), custom, NOW).segment, 'needs_encouragement');
});

test('segmentConfigFrom tolerates strings, JSON text and nonsense', () => {
  assert.deepEqual(segmentConfigFrom({}), DEFAULT_SEGMENT_CONFIG);
  const c = segmentConfigFrom({ 'nudge.inactive_days': '14', 'assessment.bands': '{"revisionMax":4,"passMax":7}' });
  assert.equal(c.inactiveDays, 14);
  assert.deepEqual(c.bands, { revisionMax: 4, passMax: 7 });
  // dormant must stay above inactive
  assert.equal(segmentConfigFrom({ 'nudge.inactive_days': 30, 'nudge.dormant_days': 10 }).dormantDays, 31);
});

test('needs_encouragement: open revision, low average, many attempts — all in one sentence', () => {
  const r = segmentStudent(facts({ openRevisions: 2, markSum: 9, markCount: 2, maxAttempts: 3 }), cfg, NOW);
  assert.equal(r.segment, 'needs_encouragement');
  assert.equal(r.reason, '2 pieces sent back for another try; average mark 4.5 is below the pass mark (6); needed 3 attempts on one step in Naskh Style One, Level 2');
  assert.equal(segmentStudent(facts({ maxAttempts: 3 }), cfg, NOW).reason, 'Needed 3 attempts on one step in Naskh Style One, Level 2');
});

test('doing_well reasons: distinction, passing, waiting, steady', () => {
  assert.equal(segmentStudent(facts({ markSum: 28, markCount: 3, lastActiveAt: daysAgo(0) }), cfg, NOW).reason, 'Active today in Naskh Style One, Level 2 — average 9.3, distinction level');
  assert.equal(segmentStudent(facts({ markSum: 14, markCount: 2, lastActiveAt: daysAgo(1) }), cfg, NOW).reason, 'Active yesterday in Naskh Style One, Level 2 — passing with an average of 7');
  assert.equal(segmentStudent(facts({ pendingReviews: 1, lastActiveAt: daysAgo(4) }), cfg, NOW).reason, 'Active 4 days ago in Naskh Style One, Level 2 — work sent, waiting for our reply');
  assert.equal(segmentStudent(facts({ courseCode: null, courseTitle: null, currentLevel: null }), cfg, NOW).reason, 'Active 2 days ago — practicing steadily');
});

test('legacy course without a code uses its title', () => {
  const r = segmentStudent(facts({ lastActiveAt: daysAgo(30), courseCode: null, courseTitle: 'Naskh — Cut Pen Certification', currentLevel: 'Level 3' }), cfg, NOW);
  assert.equal(r.reason, 'No activity for 30 days in Naskh — Cut Pen Certification, Level 3');
});

test('averageMark rounds to one decimal, null without marks', () => {
  assert.equal(averageMark({ markSum: 0, markCount: 0 }), null);
  assert.equal(averageMark({ markSum: 20, markCount: 3 }), 6.7);
});

test('sorting puts needs_push first, longest idle first', () => {
  const rows = [
    { segment: 'doing_well' as const, lastActiveAt: daysAgo(1).toISOString(), name: 'A' },
    { segment: 'needs_push' as const, lastActiveAt: daysAgo(30).toISOString(), name: 'B' },
    { segment: 'needs_push' as const, lastActiveAt: daysAgo(90).toISOString(), name: 'C' },
    { segment: 'dormant' as const, lastActiveAt: null, name: 'D' },
  ].sort(compareInsights);
  assert.deepEqual(rows.map(r => r.name), ['C', 'B', 'D', 'A']);
});

// ---------- dates ----------

test('toDate / latestDate / daysBetween handle driver shapes', () => {
  assert.equal(toDate('2026-09-16')?.toISOString(), '2026-09-16T00:00:00.000Z');
  assert.equal(toDate('2026-09-16 10:30:00')?.toISOString(), '2026-09-16T10:30:00.000Z');
  assert.equal(toDate(null), null);
  assert.equal(toDate('nonsense'), null);
  assert.equal(latestDate(null, '2026-01-01', new Date('2026-03-01T00:00:00Z'), undefined)?.toISOString(), '2026-03-01T00:00:00.000Z');
  assert.equal(daysBetween(daysAgo(3), NOW), 3);
  assert.equal(daysBetween(NOW, daysAgo(3)), 0);
});

// ---------- nudges ----------

test('nudge eligibility: at most once per 30 days', () => {
  assert.equal(canNudge(null, NOW), true);
  assert.equal(canNudge(daysAgo(29), NOW), false);
  assert.equal(canNudge(daysAgo(30), NOW), true);
});

test('template fills {name} (first name), {course}, {days} with gentle fallbacks', () => {
  const t = 'Salaam {name}, it has been {days} days since your last practice in {course}.';
  assert.equal(renderNudgeTemplate(t, { name: 'Mustafa Kausar', course: 'FNK-C101', days: 38 }), 'Salaam Mustafa, it has been 38 days since your last practice in FNK-C101.');
  assert.equal(renderNudgeTemplate(t, { name: 'Mustafa', course: null, days: null }), 'Salaam Mustafa, it has been many days since your last practice in your course.');
  assert.equal(renderNudgeTemplate(t, { name: 'Ali', course: 'FNK-C101', days: 1 }), 'Salaam Ali, it has been 1 day since your last practice in FNK-C101.');
});

test('daily email budget (80 by default)', () => {
  assert.equal(emailBudget(0), 80);
  assert.equal(emailBudget(79), 1);
  assert.equal(emailBudget(95), 0);
  assert.equal(emailBudget(-3), 80);
});

test('sweep picks only dormant, eligible students: never-nudged first, then oldest nudge, then longest idle', () => {
  const c = [
    { studentId: 'active', segment: 'needs_push' as const, lastNudgedAt: null, idleDays: 40 },
    { studentId: 'recent', segment: 'dormant' as const, lastNudgedAt: daysAgo(10), idleDays: 300 },
    { studentId: 'old-nudge', segment: 'dormant' as const, lastNudgedAt: daysAgo(90), idleDays: 400 },
    { studentId: 'older-nudge', segment: 'dormant' as const, lastNudgedAt: daysAgo(120), idleDays: 200 },
    { studentId: 'never-a', segment: 'dormant' as const, lastNudgedAt: null, idleDays: 190 },
    { studentId: 'never-b', segment: 'dormant' as const, lastNudgedAt: null, idleDays: 500 },
  ];
  assert.deepEqual(pickSweepTargets(c, NOW, 10).map(x => x.studentId), ['never-b', 'never-a', 'older-nudge', 'old-nudge']);
  assert.deepEqual(pickSweepTargets(c, NOW, 2).map(x => x.studentId), ['never-b', 'never-a']);
  assert.deepEqual(pickSweepTargets(c, NOW, 0), []);
});

// ---------- team maths ----------

test('pct and hours helpers', () => {
  assert.equal(pct(1, 3), 33.3);
  assert.equal(pct(0, 0), null);
  assert.equal(hoursFromSeconds(3 * 3600 + 1800, 1), 3.5);
  assert.equal(hoursFromSeconds(100, 0), null);
  assert.equal(clampDays('7'), 7);
  assert.equal(clampDays('abc'), 30);
  assert.equal(clampDays(9999), 365);
  assert.equal(clampDays(0), 1);
});

test('branch metrics: students per teacher, within-72h share, average wait', () => {
  const m = buildBranchMetrics({
    branchId: 'b1', branchName: 'Surat', students: 700, active: 410, teachers: 3, submissions: 120,
    judged: 100, answeredWithin72h: 85, waitSeconds: 120 * 30 * 3600, waitCount: 120,
    pendingNow: 14, overdueNow: 4, autoMarked: 2, levelsPassed: 37,
  });
  assert.equal(m.studentsPerTeacher, 233);
  assert.equal(m.answeredWithin72hPct, 85);
  assert.equal(m.avgWaitHours, 30);
  assert.equal(m.active30d, 410);
  assert.equal(m.submissions30d, 120);
  const empty = buildBranchMetrics({ branchId: 'b2', branchName: 'Sidhpur', students: 50, active: 0, teachers: 0, submissions: 0, judged: 0, answeredWithin72h: 0, waitSeconds: 0, waitCount: 0, pendingNow: 0, overdueNow: 0, autoMarked: 0, levelsPassed: 0 });
  assert.equal(empty.studentsPerTeacher, null);
  assert.equal(empty.answeredWithin72hPct, null);
  assert.equal(empty.avgWaitHours, null);
});

test('team members: share of own branch, response hours, sorted by branch then reviews', () => {
  const base = { pendingNow: 0, overdueNow: 0, divertedAway: 0, autoMarked: 0 };
  const team = buildTeamMembers([
    { ...base, teacherId: 't1', name: 'Amina', branchId: 'b1', branchName: 'Nairobi', reviewed: 30, reviewedHomeBranch: 30, responseSeconds: 30 * 10 * 3600, responseCount: 30 },
    { ...base, teacherId: 't2', name: 'Ismail', branchId: 'b1', branchName: 'Nairobi', reviewed: 60, reviewedHomeBranch: 50, responseSeconds: 60 * 20 * 3600, responseCount: 60, divertedAway: 4 },
    { ...base, teacherId: 't3', name: 'Zahra', branchId: 'b2', branchName: 'Karachi', reviewed: 0, reviewedHomeBranch: 0, responseSeconds: 0, responseCount: 0 },
  ], { b1: 80, b2: 0 });
  assert.deepEqual(team.map(t => t.teacherId), ['t3', 't2', 't1']);
  const ismail = team.find(t => t.teacherId === 't2')!;
  assert.equal(ismail.shareOfBranchPct, 62.5);
  assert.equal(ismail.avgResponseHours, 20);
  assert.equal(ismail.divertedAway30d, 4);
  assert.equal(team.find(t => t.teacherId === 't1')!.shareOfBranchPct, 37.5);
  assert.equal(team.find(t => t.teacherId === 't3')!.shareOfBranchPct, 0);
  assert.equal(team.find(t => t.teacherId === 't3')!.avgResponseHours, null);
});

test('v3 audit 22: friendly level/step words, never codes', async () => {
  const { friendlyLevel, friendlyStep } = await import('../../src/v2/lib/insightsLogic.js');
  assert.equal(friendlyLevel('LV02'), 'Level 2');
  assert.equal(friendlyLevel(null, 0), 'Level 1');
  assert.equal(friendlyLevel('Level 4'), 'Level 4');
  assert.equal(friendlyStep('S05'), 'Step 5');
  assert.equal(friendlyStep('FS'), 'Final submission');
});
