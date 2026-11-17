import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAlerts, idleWords, isMonthEndSoon, MAX_ALERTS, monthName, shortWait, waitWords, type BranchFacts, type HomeFacts } from '../../src/v2/lib/adminHome.ts';

const branch = (over: Partial<BranchFacts> = {}): BranchFacts => ({
  branchId: 'b1', name: 'Marol', students: 700, waiting: 0, overdue: 0,
  teachers: 3, teachersFull: 0, teachersAway: 0, hasMeritOfficer: true, meritStudents: 0, ...over,
});

const facts = (over: Partial<HomeFacts> = {}): HomeFacts => ({
  isMaster: true, singleBranch: false, monthLabel: 'November', monthEndSoon: false,
  divertHours: 72, dormantDays: 180, branches: [branch()], needsPush: 0, dormantToNudge: 0,
  coursesMissingFiles: [], levelsWithoutAssessment: [], draftCourses: 0, ...over,
});

test('calm day → no alerts', () => {
  assert.deepEqual(buildAlerts(facts()), []);
});

test('overdue work names the branch and links to the inbox', () => {
  const [a] = buildAlerts(facts({ branches: [branch({ overdue: 3, waiting: 5 })] }));
  assert.equal(a.severity, 'urgent');
  assert.equal(a.text, '3 entries in Marol have waited more than 3 days');
  assert.equal(a.actionPage, 'v2-inbox');
  const [one] = buildAlerts(facts({ singleBranch: true, branches: [branch({ overdue: 1 })] }));
  assert.equal(one.text, '1 entry has waited more than 3 days');
});

test('no merit officer, full teachers, merit to give', () => {
  const alerts = buildAlerts(facts({
    branches: [
      branch({ branchId: 's', name: 'Surat', hasMeritOfficer: false }),
      branch({ branchId: 'k', name: 'Karachi', teachers: 2, teachersFull: 2, waiting: 9, meritStudents: 14 }),
    ],
  }));
  const texts = alerts.map(a => a.text);
  assert.ok(texts.includes('Surat has no merit officer yet'));
  assert.ok(texts.includes('All 2 teachers of Karachi are full — share the work or raise their limits'));
  assert.ok(texts.includes('Merit points for November are waiting to be given (14 students)'));
  const full = alerts.find(a => a.text.startsWith('All 2'))!;
  assert.equal(full.actionPage, 'v2-policies');
  assert.equal(full.actionParams?.policiesView, 'network');
  assert.equal(alerts.find(a => a.text.startsWith('Surat'))!.severity, 'info'); // nothing pending there
});

test('away teachers and branches without teachers', () => {
  const alerts = buildAlerts(facts({
    branches: [
      branch({ branchId: 'n', name: 'Sidhpur', teachers: 1, teachersAway: 1 }),
      branch({ branchId: 'x', name: 'Surat', teachers: 0, waiting: 4 }),
    ],
  }));
  assert.ok(alerts.some(a => a.text === 'The only teacher of Sidhpur is away — add a helper or raise the limit'));
  const none = alerts.find(a => a.text.startsWith('Surat has no teachers'))!;
  assert.equal(none.severity, 'urgent');
  assert.equal(none.actionPage, 'admin-users');
});

test('course alerts only for the master team, grouped by course', () => {
  const course = {
    coursesMissingFiles: [{ courseId: 'c1', code: 'FNK-C101', title: 'Naskh', missing: 6 }],
    levelsWithoutAssessment: [
      { courseId: 'c1', code: 'FNK-C101', title: 'Naskh', levelCode: 'LV02' },
      { courseId: 'c1', code: 'FNK-C101', title: 'Naskh', levelCode: 'LV03' },
    ],
    draftCourses: 2,
  };
  const master = buildAlerts(facts(course)).map(a => a.text);
  assert.ok(master.includes('FNK-C101 is missing 6 files that students need'));
  assert.ok(master.includes('FNK-C101 LV02, LV03 have no assessment yet — students move on without being checked'));
  assert.ok(master.includes('2 courses are still in draft — publish when ready'));
  const builder = buildAlerts(facts(course)).find(a => a.text.startsWith('FNK-C101 is missing'))!;
  assert.deepEqual(builder.actionParams, { courseId: 'c1' });
  assert.deepEqual(buildAlerts(facts({ ...course, isMaster: false })), []);
});

test('many course gaps collapse into one line', () => {
  const gaps = ['A', 'B', 'C'].map((c, i) => ({ courseId: c, code: `FNK-C10${i}`, title: c, missing: i + 1 }));
  const alerts = buildAlerts(facts({ coursesMissingFiles: gaps }));
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].text, '3 live courses are missing files students need — FNK-C102 has the most (3)');
});

test('students: push and dormant wording', () => {
  const alerts = buildAlerts(facts({ needsPush: 4, dormantToNudge: 12 }));
  assert.equal(alerts[0].text, '4 students are stuck and need a push — see who and why');
  assert.equal(alerts[1].text, "12 students haven't practiced for 6 months — send a gentle message");
  assert.equal(alerts[1].severity, 'info');
});

test('ordering: urgent first, at most 8 lines', () => {
  const branches = Array.from({ length: 6 }, (_, i) => branch({ branchId: `b${i}`, name: `B${i}`, overdue: i + 1, hasMeritOfficer: false, meritStudents: 1 }));
  const alerts = buildAlerts(facts({ branches, needsPush: 3, dormantToNudge: 3, draftCourses: 1 }));
  assert.equal(alerts.length, MAX_ALERTS);
  const ranks = alerts.map(a => ({ urgent: 0, soon: 1, info: 2 })[a.severity]);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  assert.equal(alerts[0].text, '6 entries in B5 have waited more than 3 days');
});

test('month end makes merit urgent', () => {
  const [a] = buildAlerts(facts({ monthEndSoon: true, branches: [branch({ meritStudents: 1 })] }));
  assert.equal(a.severity, 'urgent');
  assert.equal(a.text, 'Merit points for November are waiting to be given (1 student) — the month ends soon');
});

test('helpers', () => {
  assert.equal(waitWords(72), '3 days');
  assert.equal(waitWords(36), '36 hours');
  assert.equal(idleWords(180), '6 months');
  assert.equal(idleWords(21), '3 weeks');
  assert.equal(idleWords(365), 'a year');
  assert.equal(shortWait(null), '—');
  assert.equal(shortWait(5.4), '5 h');
  assert.equal(shortWait(80), '3 days');
  assert.equal(monthName('2026-11'), 'November');
  assert.equal(isMonthEndSoon(2026, 11, 28), true);
  assert.equal(isMonthEndSoon(2026, 11, 27), false);
  assert.equal(isMonthEndSoon(2026, 2, 26), true);
});
