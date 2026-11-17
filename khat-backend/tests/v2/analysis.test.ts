// owner: analysis — run with: npx tsx --test tests/v2/analysis.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activeDaysInWindow, bandOf, buildNextSteps, classifyClause, cohortFocus, computeTrend, extractRemarkTopics, histogram,
  meritProgress, parseJsonSafe, practiceStreak, rubricAverages, shiftYmd, splitClauses, strengthsAndFocus, suggestedMessage,
  type NextStepInput,
} from '../../src/v2/lib/analysisLogic.js';
import type { CourseProgressItem, CriterionScore, MeritProgress, RemarkTopic } from '../../src/v2/lib/analysisTypes.js';

const CRITERIA = [
  { key: 'nuqta', label: 'Nuqta proportion', max: 2 },
  { key: 'form', label: 'Letter form', max: 2 },
  { key: 'spacing', label: 'Spacing', max: 2 },
  { key: 'baseline', label: 'Baseline', max: 2 },
  { key: 'pen', label: 'Pen control', max: 2 },
];
const BANDS = { revisionMax: 5, passMax: 8 };

// ---------- trend ----------
test('trend: no marks / one mark → flat with a kind sentence', () => {
  assert.equal(computeTrend([]).trend, 'flat');
  assert.match(computeTrend([]).text, /first marked piece/);
  const one = computeTrend([7]);
  assert.equal(one.trend, 'flat');
  assert.match(one.text, /7\/10/);
});

test('trend: last marks compared with the ones before', () => {
  assert.equal(computeTrend([5, 6]).trend, 'up');
  assert.equal(computeTrend([8, 6]).trend, 'down');
  assert.equal(computeTrend([7, 7.2]).trend, 'flat');
  // last 3 (8,8,9 → 8.3) vs previous 3 (5,6,6 → 5.7)
  const r = computeTrend([4, 5, 6, 6, 8, 8, 9]);
  assert.equal(r.trend, 'up');
  assert.match(r.text, /5\.7 to 8\.3/);
});

test('trend: a dip is described gently, never as failure', () => {
  const r = computeTrend([9, 9, 9, 6, 6, 6]);
  assert.equal(r.trend, 'down');
  assert.doesNotMatch(r.text, /fail|bad|poor|weak/i);
  assert.match(r.text, /lift them/);
});

// ---------- streak + active days ----------
test('shiftYmd crosses month and year boundaries', () => {
  assert.equal(shiftYmd('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftYmd('2026-12-31', 1), '2027-01-01');
});

test('streak counts consecutive days ending today', () => {
  assert.equal(practiceStreak(['2026-11-10', '2026-11-09', '2026-11-08', '2026-11-05'], '2026-11-10'), 3);
});

test('streak still alive when the student has not practised yet today', () => {
  assert.equal(practiceStreak(['2026-11-09', '2026-11-08'], '2026-11-10'), 2);
});

test('streak broken by a missing day; empty → 0', () => {
  assert.equal(practiceStreak(['2026-11-08', '2026-11-07'], '2026-11-10'), 0);
  assert.equal(practiceStreak([], '2026-11-10'), 0);
});

test('active days in the last 30 (duplicates and older days ignored)', () => {
  const days = ['2026-11-10', '2026-11-10', '2026-10-12', '2026-10-11', '2026-09-01'];
  assert.equal(activeDaysInWindow(days, '2026-11-10', 30), 2); // 10 Nov + 12 Oct (window starts 12 Oct)
});

// ---------- rubric → strengths / focus ----------
test('rubricAverages: parses JSON strings, keeps policy order, recent newest first, ignores junk', () => {
  const scores = rubricAverages([
    { rubric: '{"nuqta":2,"spacing":1,"baseline":0}', at: '2026-11-01T00:00:00Z' },
    { rubric: { nuqta: 2, spacing: 1, baseline: 1, extra_key: 1 }, at: '2026-11-05T00:00:00Z' },
    { rubric: 'not json', at: '2026-11-06T00:00:00Z' },
    { rubric: null, at: null },
    { rubric: { nuqta: 'x' }, at: '2026-11-07T00:00:00Z' },
  ], CRITERIA);
  assert.deepEqual(scores.map(s => s.key), ['nuqta', 'spacing', 'baseline', 'extra_key']);
  const baseline = scores.find(s => s.key === 'baseline')!;
  assert.equal(baseline.average, 0.5);
  assert.equal(baseline.percent, 25);
  assert.deepEqual(baseline.recent, [1, 0]);
  assert.equal(scores.find(s => s.key === 'extra_key')!.label, 'Extra key');
});

function score(key: string, percent: number, recent: number[] = [1, 1, 1]): CriterionScore {
  const c = CRITERIA.find(x => x.key === key)!;
  return { key, label: c.label, max: 2, average: (percent / 100) * 2, percent, samples: recent.length, recent };
}

test('strengths are the top criteria, focus areas the low ones, in plain words', () => {
  const { strengths, focusAreas } = strengthsAndFocus(
    [score('nuqta', 100), score('form', 85), score('pen', 80), score('spacing', 50), score('baseline', 40)], [],
  );
  assert.deepEqual(strengths.map(s => s.key), ['nuqta', 'form']);
  assert.equal(strengths[0].text, 'Neat, well-sized nuqtas');
  assert.deepEqual(focusAreas.map(s => s.key), ['baseline', 'spacing']);
  assert.equal(focusAreas[0].text, 'Baseline control');
});

test('no low criterion but one clearly trails → one gentle focus area', () => {
  const { focusAreas } = strengthsAndFocus([score('nuqta', 100), score('form', 90), score('spacing', 70)], []);
  assert.deepEqual(focusAreas.map(f => f.key), ['spacing']);
});

test('without rubric, teacher remarks give focus (advice) and strengths (praise only)', () => {
  const remarks: RemarkTopic[] = [
    { key: 'alif', label: 'Alif', count: 3, advice: 3, praise: 0, example: null },
    { key: 'curve', label: 'Curves', count: 1, advice: 0, praise: 1, example: null },
  ];
  const { strengths, focusAreas } = strengthsAndFocus([], remarks);
  assert.deepEqual(focusAreas.map(f => [f.key, f.source]), [['alif', 'remarks']]);
  assert.deepEqual(strengths.map(s => s.key), ['curve']);
});

test('a remark topic already covered by a rubric criterion is not repeated', () => {
  const remarks: RemarkTopic[] = [{ key: 'baseline', label: 'Baseline', count: 4, advice: 4, praise: 0, example: null }];
  const { focusAreas } = strengthsAndFocus([score('baseline', 40)], remarks);
  assert.equal(focusAreas.filter(f => f.key === 'baseline').length, 1);
});

// ---------- keyword extraction ----------
test('splitClauses splits on sentences, dashes and semicolons', () => {
  assert.deepEqual(splitClauses('Your Alif stands tall — keep the Baa flatter. Good; watch the nuqta!'),
    ['Your Alif stands tall', 'keep the Baa flatter.', 'Good', 'watch the nuqta!']);
});

test('classifyClause: praise vs advice ("keep going" is cheering, not advice)', () => {
  assert.equal(classifyClause('Your Alif stands tall'), 'praise');
  assert.equal(classifyClause('Keep the Baa a little flatter'), 'advice');
  assert.equal(classifyClause('Beautiful joins, keep going'), 'praise');
  assert.equal(classifyClause('Alif here'), 'advice');
});

test('extractRemarkTopics: counts once per remark, splits praise/advice, latest advice as example', () => {
  const topics = extractRemarkTopics([
    { text: 'Very good, Mustafa. Your Alif stands tall — keep the Baa a little flatter at the base.', at: '2026-11-01T00:00:00Z' },
    { text: 'Keep the Alif fully upright here.', at: '2026-11-05T00:00:00Z' },
    { text: 'The spacing between words is tight. Spacing again!', at: '2026-11-04T00:00:00Z' },
    { text: 'Watch the base line and the nuqta dots.', at: '2026-11-03T00:00:00Z' },
  ]);
  const byKey = Object.fromEntries(topics.map(t => [t.key, t]));
  assert.equal(byKey.alif.count, 2);
  assert.equal(byKey.alif.praise, 1);
  assert.equal(byKey.alif.advice, 1);
  assert.equal(byKey.alif.example, 'Keep the Alif fully upright here.');
  assert.equal(byKey.spacing.count, 1); // twice in one remark → counted once
  assert.equal(byKey.baa.advice, 1);
  assert.equal(byKey.baseline.count, 1);
  assert.equal(byKey.nuqta.count, 1);
  assert.equal(byKey.upright.count, 1);
  assert.equal(topics[0].key, 'alif'); // most frequent first
});

test('extractRemarkTopics ignores warm template comments and empty texts', () => {
  const template = 'Well done — your letters are taking good shape. Keep the same care in the next level, and keep watching the baseline and spacing.';
  const topics = extractRemarkTopics([{ text: template }, { text: `  ${template.toUpperCase()} ` }, { text: '' }], { ignore: [template] });
  assert.deepEqual(topics, []);
});

test('extractRemarkTopics: words inside other words do not match (e.g. "salaam" ≠ laam, "spaced" handled)', () => {
  const topics = extractRemarkTopics([{ text: 'Salaam, thank you.' }]);
  assert.equal(topics.find(t => t.key === 'laam'), undefined);
});

// ---------- merit ----------
test('meritProgress: this month, pending, given, levels to next point (closest course)', () => {
  const m = meritProgress({
    ledger: [
      { points: 1, status: 'pending', earnedMonth: '2026-11' },
      { points: 10, status: 'given', earnedMonth: '2026-10' },
      { points: 2, status: 'pending', earnedMonth: '2026-12' },
      { points: 5, status: 'void', earnedMonth: '2026-11' },
    ],
    levelBadgesPerCourse: [1, 5],
    levelsPerPoint: '3',
    monthlyCap: 10,
    thisMonth: '2026-11',
  });
  assert.equal(m.pointsThisMonth, 1);
  assert.equal(m.pending, 3);
  assert.equal(m.given, 10);
  assert.equal(m.levelsTowardNext, 2); // 5 % 3
  assert.equal(m.levelsUntilNextPoint, 1);
});

test('meritProgress: defaults when policy is missing / no courses', () => {
  const m = meritProgress({ ledger: [], levelBadgesPerCourse: [], levelsPerPoint: undefined, monthlyCap: null, thisMonth: '2026-11' });
  assert.equal(m.levelsPerPoint, 3);
  assert.equal(m.levelsUntilNextPoint, 3);
  assert.equal(m.monthlyCap, 10);
});

// ---------- next steps ----------
const merit = (until: number): MeritProgress => ({ pointsThisMonth: 0, pending: 0, given: 0, levelsPerPoint: 3, levelsTowardNext: 3 - until, levelsUntilNextPoint: until, monthlyCap: 10 });
function course(over: Partial<CourseProgressItem> = {}): CourseProgressItem {
  return {
    courseId: 'c1', code: 'FNK-C101', title: 'Fann al-Khat 1', structureVersion: 2, progressPercent: 40, levelsPassed: 1, totalLevels: 4,
    currentLevel: 'LV02', currentLevelDescription: null, waitingForReview: false, openRevision: false, completed: false,
    nextStep: { stepId: 's9', code: 'S05', title: 'Assessment', levelCode: 'LV02', isUpload: true, unlocksLevel: 'LV03' },
    ...over,
  };
}
function input(over: Partial<NextStepInput> = {}): NextStepInput {
  return { audience: 'student', courses: [course()], rubric: [], focusAreas: [], remarks: [], merit: merit(3), streakDays: 0, idleDays: 1, markCount: 2, ...over };
}

test('next steps: assessment that unlocks the next level comes first, with a course button', () => {
  const steps = buildNextSteps(input());
  assert.equal(steps[0].text, 'Send your LV02 assessment — it opens LV03');
  assert.deepEqual(steps[0].action, { label: 'Go to step', courseId: 'c1', stepId: 's9' });
  assert.ok(steps.length >= 2 && steps.length <= 4);
});

test('next steps: 1 level from a merit point', () => {
  const steps = buildNextSteps(input({ merit: merit(1) }));
  assert.ok(steps.some(s => s.text === 'You are 1 level away from your next merit point'));
});

test('next steps: last 3 rubric marks low → practise that criterion', () => {
  const steps = buildNextSteps(input({ rubric: [score('spacing', 50, [1, 1, 0]), score('nuqta', 100, [2, 2, 2])] }));
  const s = steps.find(x => x.key === 'focus:spacing');
  assert.ok(s);
  assert.match(s!.text, /^Practice spacing between letters — your last 3 marks on spacing/);
});

test('next steps: a piece sent back ranks above everything, wording stays positive', () => {
  const steps = buildNextSteps(input({ courses: [course({ openRevision: true })], merit: merit(1) }));
  assert.match(steps[0].text, /^Try the LV02 assessment of Fann al-Khat 1 once more/);
  for (const s of steps) assert.doesNotMatch(`${s.text} ${s.detail ?? ''}`, /fail|bad|poor|weak|wrong/i);
});

test('next steps: idle student gets a restart step; never fewer than 2, never more than 4', () => {
  const idle = buildNextSteps(input({ idleDays: 12 }));
  assert.ok(idle.some(s => s.key === 'restart'));
  const none = buildNextSteps(input({ courses: [] }));
  assert.ok(none.length >= 2);
  assert.equal(none[0].text, 'Choose a course to begin your journey');
  const lots = buildNextSteps(input({ merit: merit(1), idleDays: 10, rubric: [score('spacing', 30, [0, 1, 0])], remarks: [{ key: 'alif', label: 'Alif', count: 3, advice: 3, praise: 0, example: null }] }));
  assert.equal(lots.length, 4);
});

test('next steps: completed course → choose the next course', () => {
  const steps = buildNextSteps(input({ courses: [course({ completed: true, nextStep: null })] }));
  assert.match(steps[0].text, /You completed Fann al-Khat 1/);
});

test('suggested message: greets by first name, praises a strength, gives the next step', () => {
  const nextSteps = buildNextSteps(input());
  const msg = suggestedMessage({
    name: 'Mustafa Saifee', segment: 'doing_well', averageMark: 7.5, levelsPassed: 2, idleDays: 1,
    strengths: [{ key: 'nuqta', label: 'Nuqta', text: 'Neat, well-sized nuqtas', source: 'marks' }],
    focusAreas: [{ key: 'baseline', label: 'Baseline', text: 'Baseline control', source: 'marks' }],
    nextSteps, bands: BANDS,
  });
  assert.match(msg, /^Salaam Mustafa, I can see neat, well-sized nuqtas in your work/);
  assert.match(msg, /send your LV02 assessment — it opens LV03/);
  assert.match(msg, /baseline control a little extra care/);
});

test('suggested message for a quiet student mentions the days, warmly', () => {
  const msg = suggestedMessage({ name: 'Zainab', segment: 'needs_push', averageMark: null, levelsPassed: 0, idleDays: 25, strengths: [], focusAreas: [], nextSteps: [], bands: BANDS });
  assert.match(msg, /we miss your writing/);
  assert.match(msg, /25 days/);
});

// ---------- cohort ----------
test('histogram buckets marks 1..10 and ignores out-of-range values', () => {
  const h = histogram([1, 4, 4, 9.6, 0, 11, Number.NaN]);
  assert.equal(h.length, 10);
  assert.equal(h[3].count, 2);
  assert.equal(h[9].count, 1);
  assert.equal(h.reduce((a, b) => a + b.count, 0), 4);
});

test('cohortFocus merges low rubric criteria and teacher advice per student', () => {
  const rubricBy = new Map([['s1', [score('baseline', 40)]], ['s2', [score('baseline', 50), score('nuqta', 100)]]]);
  const topicsBy = new Map<string, RemarkTopic[]>([
    ['s2', [{ key: 'baseline', label: 'Baseline', count: 1, advice: 1, praise: 0, example: null }]],
    ['s3', [{ key: 'baseline', label: 'Baseline', count: 1, advice: 1, praise: 0, example: null }, { key: 'alif', label: 'Alif', count: 1, advice: 0, praise: 1, example: null }]],
  ]);
  const focus = cohortFocus(rubricBy, topicsBy);
  assert.equal(focus[0].key, 'baseline');
  assert.equal(focus[0].students, 3);
  assert.equal(focus[0].source, 'both');
  assert.equal(focus[0].text, '3 students need help with baseline control');
  assert.equal(focus.find(f => f.key === 'alif'), undefined); // praise only
});

test('helpers: bandOf + parseJsonSafe', () => {
  assert.equal(bandOf(5, BANDS), 'revision');
  assert.equal(bandOf(6, BANDS), 'pass');
  assert.equal(bandOf(9, BANDS), 'distinction');
  assert.deepEqual(parseJsonSafe('{"a":1}', {}), { a: 1 });
  assert.deepEqual(parseJsonSafe('{oops', { ok: false }), { ok: false });
  assert.deepEqual(parseJsonSafe(Buffer.from('[1]'), []), [1]);
});
