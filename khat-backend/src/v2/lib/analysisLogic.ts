/**
 * Smart analysis — pure logic (no database) so every rule can be unit-tested.
 * owner: analysis
 *
 * The data side (analysisData.ts) gathers raw facts with a few grouped SQL
 * queries; everything that turns facts into plain words lives here.
 */
import type {
  AnalysisBand, AnalysisChip, AnalysisNextStep, AnalysisSegment, CohortFocus, CourseProgressItem, CriterionScore,
  MeritProgress, RemarkTopic, TrendDirection,
} from './analysisTypes.js';

export type Bands = { revisionMax: number; passMax: number };
export type Criterion = { key: string; label: string; max: number };

const round1 = (x: number) => Math.round(x * 10) / 10;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function bandOf(mark: number, bands: Bands): AnalysisBand {
  if (mark <= bands.revisionMax) return 'revision';
  if (mark <= bands.passMax) return 'pass';
  return 'distinction';
}

/** Defensive JSON: JSON columns may arrive as strings, objects or garbage. */
export function parseJsonSafe<T>(value: unknown, fallback: T): T {
  if (value == null || value === '') return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  if (Buffer.isBuffer(value)) return parseJsonSafe(value.toString('utf8'), fallback);
  return value as T;
}

// ---------------------------------------------------------------- trend
/** Compare the latest marks with the ones before them. marks: oldest → newest. */
export function computeTrend(marks: number[]): { trend: TrendDirection; text: string } {
  const valid = marks.filter(m => Number.isFinite(m));
  if (valid.length === 0) return { trend: 'flat', text: 'No marks yet — your first marked piece will start your graph.' };
  if (valid.length === 1) return { trend: 'flat', text: `Your first mark is ${valid[0]}/10 — a good start to build on.` };
  const k = Math.min(3, Math.floor(valid.length / 2));
  const recent = valid.slice(-k);
  const before = valid.slice(-2 * k, -k);
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const now = round1(avg(recent));
  const then = round1(avg(before));
  const diff = now - then;
  if (diff >= 0.5) return { trend: 'up', text: `Your marks are rising — from about ${then} to ${now}.` };
  if (diff <= -0.5) return { trend: 'down', text: `Your latest marks dipped a little (about ${now}) — a short, calm practice will lift them again.` };
  return { trend: 'flat', text: `Your marks are steady at about ${now}.` };
}

// ---------------------------------------------------------------- days, streak
/** 'YYYY-MM-DD' shifted by n days (calendar arithmetic, timezone-free). */
export function shiftYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Consecutive days with activity ending today — or yesterday, so a streak is not
 * "lost" in the morning before the student has practiced.
 */
export function practiceStreak(dayKeys: Iterable<string>, todayYmd: string): number {
  const days = new Set(dayKeys);
  let cursor = days.has(todayYmd) ? todayYmd : shiftYmd(todayYmd, -1);
  let streak = 0;
  while (days.has(cursor)) {
    streak += 1;
    cursor = shiftYmd(cursor, -1);
  }
  return streak;
}

/** Distinct active days within the last `window` days (today included). */
export function activeDaysInWindow(dayKeys: Iterable<string>, todayYmd: string, window = 30): number {
  const from = shiftYmd(todayYmd, -(window - 1));
  let count = 0;
  for (const day of new Set(dayKeys)) if (day >= from && day <= todayYmd) count += 1;
  return count;
}

// ---------------------------------------------------------------- rubric
export type RubricSample = { rubric: unknown; at: Date | string | null };

/** Averages per criterion (policy order), newest-first recent values. Unknown keys are kept with a readable label. */
export function rubricAverages(samples: RubricSample[], criteria: Criterion[]): CriterionScore[] {
  const sorted = [...samples].sort((a, b) => time(b.at) - time(a.at));
  const known = new Map(criteria.map(c => [c.key, c]));
  const values = new Map<string, number[]>();
  for (const sample of sorted) {
    const obj = parseJsonSafe<Record<string, unknown> | null>(sample.rubric, null);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
    for (const [key, raw] of Object.entries(obj)) {
      const v = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(v) || v < 0) continue;
      const list = values.get(key) ?? [];
      list.push(v);
      values.set(key, list);
    }
  }
  const order = [...criteria.map(c => c.key), ...[...values.keys()].filter(k => !known.has(k)).sort()];
  const out: CriterionScore[] = [];
  for (const key of order) {
    const list = values.get(key);
    if (!list?.length) continue;
    const def = known.get(key);
    const max = def && def.max > 0 ? def.max : Math.max(2, ...list);
    const average = list.reduce((a, b) => a + Math.min(b, max), 0) / list.length;
    out.push({
      key,
      label: def?.label ?? humanise(key),
      max,
      average: round1(average),
      percent: Math.round((average / max) * 100),
      samples: list.length,
      recent: list.slice(0, 3),
    });
  }
  return out;
}
function time(value: Date | string | null): number {
  if (!value) return 0;
  const t = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(t) ? 0 : t;
}
function humanise(key: string): string {
  const text = key.replace(/[_-]+/g, ' ').trim();
  return text ? text[0].toUpperCase() + text.slice(1) : key;
}

/** Plain words for the default rubric criteria (unknown criteria fall back to their label). */
const CRITERION_WORDS: Record<string, { strength: string; focus: string; topic: string }> = {
  nuqta: { strength: 'Neat, well-sized nuqtas', focus: 'Nuqta size and placement', topic: 'nuqta' },
  form: { strength: 'Well-shaped letters', focus: 'Letter shapes', topic: 'proportion' },
  spacing: { strength: 'Even spacing', focus: 'Spacing between letters', topic: 'spacing' },
  baseline: { strength: 'A steady baseline', focus: 'Baseline control', topic: 'baseline' },
  pen: { strength: 'Confident pen control', focus: 'Pen angle and control', topic: 'pen_angle' },
};
export function criterionTopic(key: string): string {
  return CRITERION_WORDS[key]?.topic ?? key;
}
export function criterionFocusWords(score: Pick<CriterionScore, 'key' | 'label'>): string {
  return CRITERION_WORDS[score.key]?.focus ?? score.label;
}

export const STRENGTH_MIN_PCT = 75;
export const FOCUS_MAX_PCT = 60;

// ---------------------------------------------------------------- teacher remarks
type Topic = { key: string; label: string; re: RegExp; strength: string; focus: string };

/** Calligraphy vocabulary that teachers use in comments and annotation pins. */
export const REMARK_TOPICS: Topic[] = [
  { key: 'alif', label: 'Alif', re: /\b(alif|aleph)s?\b|ألف|الف/i, strength: 'A tall, upright Alif', focus: 'The Alif' },
  { key: 'baa', label: 'Baa', re: /\b(baa|bā|beh)s?\b|باء/i, strength: 'A well-shaped Baa', focus: 'The Baa' },
  { key: 'nun', label: 'Nun', re: /\b(nun|noon|nuun)s?\b|نون/i, strength: 'A round, balanced Nun', focus: 'The Nun' },
  { key: 'yaa', label: 'Yaa', re: /\b(yaa|yā|yeh)s?\b/i, strength: 'A graceful Yaa', focus: 'The Yaa' },
  { key: 'haa', label: 'Haa / Jeem', re: /\b(haa|hā|jeem|jīm|khaa)s?\b/i, strength: 'A good Haa / Jeem', focus: 'The Haa / Jeem family' },
  { key: 'daal', label: 'Daal', re: /\b(daal|dāl|dal|zaal)s?\b/i, strength: 'A neat Daal', focus: 'The Daal' },
  { key: 'raa', label: 'Raa', re: /\b(raa|rā)s?\b/i, strength: 'A flowing Raa', focus: 'The Raa' },
  { key: 'ain', label: 'Ain', re: /\b(ain|ayn|ghain)s?\b/i, strength: 'A good Ain', focus: 'The Ain' },
  { key: 'kaaf', label: 'Kaaf', re: /\b(kaaf|kāf|kaf)s?\b/i, strength: 'A good Kaaf', focus: 'The Kaaf' },
  { key: 'laam', label: 'Laam', re: /\b(laam|lām|lam)s?\b/i, strength: 'A tall Laam', focus: 'The Laam' },
  { key: 'meem', label: 'Meem', re: /\b(meem|mīm|mim)s?\b/i, strength: 'A neat Meem', focus: 'The Meem' },
  { key: 'waw', label: 'Waw', re: /\b(waw|waaw|wāw)s?\b/i, strength: 'A good Waw', focus: 'The Waw' },
  { key: 'nuqta', label: 'Nuqta (dots)', re: /\b(nuqta|nuqtas|nuqat|nuqaat|nuqtah|dots?)\b|نقط/i, strength: 'Neat, well-sized nuqtas', focus: 'Nuqta size and placement' },
  { key: 'baseline', label: 'Baseline', re: /\b(base ?lines?|satr|on the line|sit(s|ting)? on the line)\b/i, strength: 'A steady baseline', focus: 'Baseline control' },
  { key: 'spacing', label: 'Spacing', re: /\b(spacing|spaces?|gaps?|farrij|qarmit|crowded|too close|too far apart)\b/i, strength: 'Even spacing', focus: 'Spacing between letters' },
  { key: 'proportion', label: 'Proportion', re: /\b(proportions?|proportional|size|sizes|height|heights|width|ratio|too big|too small|too tall|too short)\b/i, strength: 'Good proportions', focus: 'Letter proportions' },
  { key: 'pen_angle', label: 'Pen angle', re: /\b(pen angle|angle|angles|qalam|nib|pen hold|hold(ing)? the pen)\b/i, strength: 'A steady pen angle', focus: 'Pen angle' },
  { key: 'curve', label: 'Curves', re: /\b(curves?|curved|round|rounded|bowls?|arcs?|tails?)\b/i, strength: 'Smooth curves', focus: 'Curves and bowls' },
  { key: 'joins', label: 'Joins', re: /\b(joins?|joining|joined|joints?|connect(s|ing|ion|ions)?|ligatures?)\b/i, strength: 'Clean joins', focus: 'Joining letters' },
  { key: 'upright', label: 'Upright letters', re: /\b(upright|slant(ed|ing)?|tilt(ed|ing)?|lean(s|ing)?|vertical)\b/i, strength: 'Upright, balanced letters', focus: 'Keeping letters upright' },
  { key: 'stroke', label: 'Stroke & pressure', re: /\b(thickness|thick|thin|pressure|shaky|wobbly|stroke weight)\b/i, strength: 'Even strokes', focus: 'Even stroke thickness' },
  { key: 'neatness', label: 'Neatness', re: /\b(neat(ness|ly)?|smudges?|smudged|ink blots?|tidy|messy)\b/i, strength: 'Clean, tidy sheets', focus: 'Clean, tidy sheets' },
];
const TOPIC_BY_KEY = new Map(REMARK_TOPICS.map(t => [t.key, t]));
export function topicLabel(key: string): string {
  return TOPIC_BY_KEY.get(key)?.label ?? humanise(key);
}

const CHEER_RE = /\bkeep (going|it up|this|the same|practi[sc]ing|writing)\b/i;
const ADVICE_RE = /\b(keep|try|again|more|less|practi[sc]e|watch|careful(ly)?|should|needs?|must|make|work on|improve|flatter|thinner|thicker|longer|shorter|bigger|smaller|wider|narrower|higher|lower|too|not|don'?t|avoid|fix|correct|attention|tighten|straighten|look at|check|remember)\b/i;
const PRAISE_RE = /\b(good|well done|well|excellent|beautiful(ly)?|great|nice|lovely|fine|strong|masha ?allah|perfect|neat|tall|steady|clean|improved|better|bravo|shabash)\b/i;

/** Split a comment into short clauses ("Your Alif stands tall — keep the Baa flatter" → 2 clauses). */
export function splitClauses(text: string): string[] {
  return text
    .split(/(?<=[.!?؟])\s+|\s+[—–]\s+|;\s+|\n+/)
    .map(s => s.trim())
    .filter(s => s.length > 1);
}

export function classifyClause(clause: string): 'advice' | 'praise' {
  const cleaned = clause.replace(CHEER_RE, '');
  if (ADVICE_RE.test(cleaned)) return 'advice';
  if (PRAISE_RE.test(clause)) return 'praise';
  return 'advice'; // a bare mention ("Alif here") on a correction is a pointer to improve
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

export type RemarkText = { text: string; at?: Date | string | null };

/**
 * Keyword frequency over teacher comments + annotation pin texts.
 * Counted once per remark per topic; warm template comments (not written by a teacher) are ignored.
 */
export function extractRemarkTopics(remarks: RemarkText[], opts: { ignore?: string[]; limit?: number } = {}): RemarkTopic[] {
  const ignore = new Set((opts.ignore ?? []).map(norm));
  const sorted = [...remarks].sort((a, b) => time(b.at ?? null) - time(a.at ?? null)); // newest first → examples are recent
  const acc = new Map<string, RemarkTopic & { adviceExample: string | null; praiseExample: string | null }>();
  for (const remark of sorted) {
    const text = typeof remark.text === 'string' ? remark.text.trim() : '';
    if (!text || ignore.has(norm(text))) continue;
    const seen = new Map<string, { advice: boolean; praise: boolean; adviceClause: string | null; praiseClause: string | null }>();
    for (const clause of splitClauses(text)) {
      const kind = classifyClause(clause);
      for (const topic of REMARK_TOPICS) {
        if (!topic.re.test(clause)) continue;
        const s = seen.get(topic.key) ?? { advice: false, praise: false, adviceClause: null, praiseClause: null };
        if (kind === 'advice') { s.advice = true; s.adviceClause ??= clause; } else { s.praise = true; s.praiseClause ??= clause; }
        seen.set(topic.key, s);
      }
    }
    for (const [key, s] of seen) {
      const entry = acc.get(key) ?? { key, label: topicLabel(key), count: 0, advice: 0, praise: 0, example: null, adviceExample: null, praiseExample: null };
      entry.count += 1;
      if (s.advice) entry.advice += 1;
      if (s.praise) entry.praise += 1;
      entry.adviceExample ??= s.adviceClause;
      entry.praiseExample ??= s.praiseClause;
      acc.set(key, entry);
    }
  }
  return [...acc.values()]
    .map(({ adviceExample, praiseExample, ...topic }) => ({ ...topic, example: tidyExample(adviceExample ?? praiseExample) }))
    .sort((a, b) => b.count - a.count || b.advice - a.advice || a.label.localeCompare(b.label))
    .slice(0, opts.limit ?? 8);
}
function tidyExample(text: string | null): string | null {
  if (!text) return null;
  const t = text.length > 140 ? `${text.slice(0, 137).trimEnd()}…` : text;
  return t[0].toUpperCase() + t.slice(1);
}

// ---------------------------------------------------------------- strengths & focus
/** Top criteria → strengths; low criteria → focus areas; teacher remarks fill gaps. Never more than 3 each. */
export function strengthsAndFocus(rubric: CriterionScore[], remarks: RemarkTopic[]): { strengths: AnalysisChip[]; focusAreas: AnalysisChip[] } {
  const strengths: AnalysisChip[] = [];
  const focus: AnalysisChip[] = [];
  const usedTopics = new Set<string>();
  const byPct = [...rubric].sort((a, b) => b.percent - a.percent || b.samples - a.samples);

  for (const c of byPct) {
    if (strengths.length >= 2) break;
    if (c.percent >= STRENGTH_MIN_PCT) {
      strengths.push({ key: c.key, label: c.label, text: CRITERION_WORDS[c.key]?.strength ?? `Good ${c.label.toLowerCase()}`, source: 'marks' });
      usedTopics.add(criterionTopic(c.key));
    }
  }
  const lowFirst = [...byPct].reverse();
  for (const c of lowFirst) {
    if (focus.length >= 2) break;
    if (c.percent < FOCUS_MAX_PCT && !strengths.some(s => s.key === c.key)) {
      focus.push({ key: c.key, label: c.label, text: criterionFocusWords(c), source: 'marks' });
      usedTopics.add(criterionTopic(c.key));
    }
  }
  // Nothing clearly low, but one criterion trails the best by a margin → gentle "next to polish".
  if (!focus.length && byPct.length >= 3) {
    const lowest = lowFirst[0];
    if (byPct[0].percent - lowest.percent >= 15 && !strengths.some(s => s.key === lowest.key)) {
      focus.push({ key: lowest.key, label: lowest.label, text: criterionFocusWords(lowest), source: 'marks' });
      usedTopics.add(criterionTopic(lowest.key));
    }
  }

  for (const topic of remarks) {
    if (usedTopics.has(topic.key)) continue;
    const def = TOPIC_BY_KEY.get(topic.key);
    if (!def) continue;
    const adviceLeads = rubric.length ? topic.advice >= 2 && topic.advice > topic.praise : topic.advice >= 1 && topic.advice >= topic.praise;
    if (focus.length < 3 && adviceLeads) {
      focus.push({ key: topic.key, label: topic.label, text: def.focus, source: 'remarks' });
      usedTopics.add(topic.key);
    } else if (strengths.length < 3 && topic.praise > 0 && topic.advice === 0) {
      strengths.push({ key: topic.key, label: topic.label, text: def.strength, source: 'remarks' });
      usedTopics.add(topic.key);
    }
  }
  return { strengths: strengths.slice(0, 3), focusAreas: focus.slice(0, 3) };
}

// ---------------------------------------------------------------- merit
export function meritProgress(input: {
  ledger: { points: number; status: string; earnedMonth: string }[];
  levelBadgesPerCourse: number[];
  levelsPerPoint: unknown;
  monthlyCap: unknown;
  thisMonth: string;
}): MeritProgress {
  const per = Math.max(1, Math.floor(Number(input.levelsPerPoint) || 3));
  const cap = Math.max(0, Math.floor(Number(input.monthlyCap) || 10));
  let pointsThisMonth = 0, pending = 0, given = 0;
  for (const row of input.ledger) {
    if (row.status === 'void') continue;
    const pts = Number(row.points) || 0;
    if (row.earnedMonth === input.thisMonth) pointsThisMonth += pts;
    if (row.status === 'pending') pending += pts;
    if (row.status === 'given') given += pts;
  }
  const toward = input.levelBadgesPerCourse.reduce((best, n) => Math.max(best, Math.max(0, Math.floor(n)) % per), 0);
  return { pointsThisMonth, pending, given, levelsPerPoint: per, levelsTowardNext: toward, levelsUntilNextPoint: per - toward, monthlyCap: cap };
}

// ---------------------------------------------------------------- next steps
export type NextStepInput = {
  audience: 'student' | 'staff';
  courses: CourseProgressItem[];
  rubric: CriterionScore[];
  focusAreas: AnalysisChip[];
  remarks: RemarkTopic[];
  merit: MeritProgress;
  streakDays: number;
  idleDays: number | null;
  markCount: number;
};

/** 2–4 personal next steps, most useful first. Wording is always encouraging. */
export function buildNextSteps(input: NextStepInput): AnalysisNextStep[] {
  const you = input.audience === 'student';
  const cand: (AnalysisNextStep & { priority: number })[] = [];
  const active = input.courses.filter(c => c.structureVersion === 2 && !c.completed);
  const main = active.find(c => c.nextStep || c.openRevision || c.waitingForReview) ?? active[0] ?? null;
  const name = (c: CourseProgressItem) => c.title || c.code || "your course";

  for (const c of active) {
    if (c.openRevision) {
      cand.push({
        key: `revision:${c.courseId}`, priority: 100, tone: 'go',
        text: `${you ? 'Try' : 'Encourage another try at'} the ${c.nextStep?.levelCode ?? c.currentLevel ?? ''} ${c.nextStep?.isUpload === false ? 'step' : 'assessment'} of ${name(c)} once more`.replace(/\s+/g, ' '),
        detail: you ? 'Your teacher’s notes show exactly what to change — you are very close.' : 'Work was sent back for another try.',
        action: { label: 'Open', courseId: c.courseId, stepId: c.nextStep?.stepId ?? null },
      });
    } else if (c.nextStep?.isUpload) {
      const level = c.nextStep.levelCode;
      cand.push({
        key: `upload:${c.courseId}`, priority: 90, tone: 'go',
        text: c.nextStep.unlocksLevel
          ? `${you ? 'Send your' : 'Next: send the'} ${level} assessment — it opens ${c.nextStep.unlocksLevel}`
          : `${you ? 'Send your' : 'Next: send the'} ${level} work — it completes ${name(c)}`,
        detail: c.nextStep.title || null,
        action: { label: you ? 'Go to step' : 'Open course', courseId: c.courseId, stepId: c.nextStep.stepId },
      });
    } else if (c.nextStep) {
      cand.push({
        key: `continue:${c.courseId}`, priority: 60, tone: 'go',
        text: `${you ? 'Continue with' : 'Next:'} ${[c.nextStep.levelCode, c.nextStep.code].filter(Boolean).join(' · ')}${c.nextStep.title ? ` — ${c.nextStep.title}` : ''}`,
        detail: `${name(c)} — ${c.progressPercent}% done`,
        action: { label: 'Continue', courseId: c.courseId, stepId: c.nextStep.stepId },
      });
    } else if (c.waitingForReview) {
      cand.push({
        key: `waiting:${c.courseId}`, priority: 35, tone: 'cheer',
        text: you ? `Your ${c.currentLevel ?? ''} work is with your teacher`.replace('  ', ' ') : `${c.currentLevel ?? 'Work'} is waiting for our reply`,
        detail: you ? 'The reply will appear in the same step. Keep practicing meanwhile.' : 'Reply from the review inbox.',
        action: { label: 'View', courseId: c.courseId, stepId: null },
      });
    }
  }

  for (const c of input.courses.filter(x => x.structureVersion === 2 && x.completed).slice(0, 1)) {
    cand.push({
      key: `done:${c.courseId}`, priority: active.length ? 40 : 85, tone: 'cheer',
      text: you ? `You completed ${name(c)} — mashaAllah! Choose your next course` : `Completed ${name(c)}`,
      detail: you ? 'Your next course is waiting on your dashboard.' : 'Suggest the next course.',
      action: null,
    });
  }

  const per = input.merit.levelsPerPoint;
  if (active.length && input.merit.levelsUntilNextPoint <= Math.min(2, per)) {
    const n = input.merit.levelsUntilNextPoint;
    cand.push({
      key: 'merit', priority: n === 1 ? 80 : 50, tone: 'merit',
      text: you ? `You are ${plural(n, 'level')} away from your next merit point` : `${plural(n, 'level')} away from the next merit point`,
      detail: `Every ${plural(per, 'level')} passed = 1 merit point on the Jamea portal.`,
      action: main ? { label: 'Keep going', courseId: main.courseId, stepId: main.nextStep?.stepId ?? null } : null,
    });
  }

  // Rubric focus: the last three marks on one criterion were all on the low side.
  const lowRecent = input.rubric
    .filter(c => c.recent.length >= 3 && c.recent.every(x => (x / c.max) * 100 < FOCUS_MAX_PCT))
    .sort((a, b) => a.percent - b.percent)[0];
  if (lowRecent) {
    cand.push({
      key: `focus:${lowRecent.key}`, priority: 70, tone: 'practice',
      text: `Practice ${lowerFirst(criterionFocusWords(lowRecent))} — ${you ? 'your' : 'the'} last 3 marks on ${lowRecent.label.toLowerCase()} were the lightest`,
      detail: 'One extra sheet focused on this alone makes a visible difference.',
      action: null,
    });
  } else if (input.focusAreas[0]) {
    const f = input.focusAreas[0];
    cand.push({
      key: `focus:${f.key}`, priority: 45, tone: 'practice',
      text: `Give ${lowerFirst(f.text)} a little extra care in the next sheet`,
      detail: f.source === 'remarks' ? 'Your teachers mention this often.' : `Lowest rubric score so far: ${f.label}.`,
      action: null,
    });
  }

  const remark = input.remarks.find(r => r.advice >= 2 && !cand.some(c => c.key === `focus:${r.key}`) && !input.focusAreas.some(f => criterionTopic(f.key) === r.key));
  if (remark) {
    cand.push({
      key: `remark:${remark.key}`, priority: 55, tone: 'practice',
      text: `${you ? 'Your teachers' : 'Teachers'} often mention the ${remark.label} — look at the reference again before the next sheet`,
      detail: remark.example,
      action: null,
    });
  }

  if (input.idleDays != null && input.idleDays >= 7 && main) {
    cand.push({
      key: 'restart', priority: 75, tone: 'cheer',
      text: you ? 'Ten minutes of practice today will get your pen moving again' : `${input.idleDays} days since the last practice — a warm word helps`,
      detail: null,
      action: { label: 'Practice now', courseId: main.courseId, stepId: main.nextStep?.stepId ?? null },
    });
  } else if (input.streakDays >= 2) {
    cand.push({
      key: 'streak', priority: 30, tone: 'cheer',
      text: you ? `Keep your ${input.streakDays}-day streak going — a few minutes today counts` : `On a ${input.streakDays}-day practice streak`,
      detail: null, action: null,
    });
  }

  // Fallbacks so there are always at least two.
  if (main && !cand.some(c => c.tone === 'go' && c.action?.courseId === main.courseId)) {
    cand.push({ key: `open:${main.courseId}`, priority: 10, tone: 'go', text: you ? `Open ${name(main)} and continue where you left off` : `Continue ${name(main)}`, detail: null, action: { label: 'Open', courseId: main.courseId, stepId: null } });
  } else if (!input.courses.length) {
    cand.push({ key: 'start', priority: 10, tone: 'go', text: you ? 'Choose a course to begin your journey' : 'Has not joined a course yet', detail: you ? 'Your courses are listed on your dashboard.' : null, action: null });
  }
  cand.push({ key: 'cheer', priority: 5, tone: 'cheer', text: you ? 'Every sheet you practice brings your hand closer to beautiful writing' : 'Steady practice is the whole secret', detail: null, action: null });

  const seen = new Set<string>();
  return cand
    .sort((a, b) => b.priority - a.priority)
    .filter(c => (seen.has(c.key) ? false : (seen.add(c.key), true)))
    .slice(0, 4)
    .map(({ priority: _p, ...step }) => step);
}

// ---------------------------------------------------------------- suggested message (staff)
export function suggestedMessage(input: {
  name: string;
  segment: AnalysisSegment;
  averageMark: number | null;
  levelsPassed: number;
  idleDays: number | null;
  strengths: AnalysisChip[];
  focusAreas: AnalysisChip[];
  nextSteps: AnalysisNextStep[];
  bands: Bands;
}): string {
  const first = input.name.trim().split(/\s+/)[0] || 'dear student';
  const parts: string[] = [];
  const strength = input.strengths[0];
  let praise: string;
  if (strength) praise = `I can see ${lowerFirst(strength.text)} in your work — well done.`;
  else if (input.averageMark != null && input.averageMark > input.bands.revisionMax) praise = `Your average of ${input.averageMark}/10 is a lovely result.`;
  else if (input.levelsPassed > 0) praise = `Well done on passing ${plural(input.levelsPassed, 'level')} so far.`;
  else praise = 'Thank you for the effort you are putting into your writing.';

  if (input.segment === 'needs_push' || input.segment === 'dormant') {
    parts.push(`Salaam ${first}, we miss your writing!`);
    if (input.idleDays != null && input.idleDays > 0) parts.push(`It has been ${plural(input.idleDays, 'day')} since your last practice.`);
    parts.push(praise);
    parts.push('Ten minutes today will keep your pen moving.');
  } else if (input.segment === 'new') {
    parts.push(`Salaam ${first}, welcome to Tehseen al-Khat!`);
    parts.push('We are happy to have you — start with the first worksheet and send us your work whenever you are ready.');
  } else {
    parts.push(`Salaam ${first}, ${lowerFirst(praise)}`);
  }

  const go = input.nextSteps.find(s => s.tone === 'go' || s.tone === 'merit');
  if (go && input.segment !== 'new') parts.push(`Next, ${lowerFirst(go.text.replace(/^Next:\s*/i, ''))}.`);
  const focus = input.focusAreas[0];
  if (focus && input.segment !== 'new') parts.push(`Give ${lowerFirst(focus.text)} a little extra care.`);

  if (input.segment !== 'needs_push' && input.segment !== 'dormant' && input.segment !== 'new') {
    parts.push(input.segment === 'needs_encouragement'
      ? 'Every fine calligrapher needed many tries — we are with you.'
      : 'We are proud of your progress — keep going!');
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}
const lowerFirst = (s: string) => (s && !/^([A-Z]{2}|I\s)/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);

// ---------------------------------------------------------------- cohort helpers
export function histogram(marks: number[]): { mark: number; count: number }[] {
  const counts = Array.from({ length: 10 }, (_, i) => ({ mark: i + 1, count: 0 }));
  for (const m of marks) {
    const r = Math.round(Number(m));
    if (r >= 1 && r <= 10) counts[r - 1].count += 1;
  }
  return counts;
}

/**
 * Focus areas shared by many students: low rubric average (marks) and/or
 * repeated teacher advice (remarks), counted per student, merged by topic.
 */
export function cohortFocus(
  rubricByStudent: Map<string, CriterionScore[]>,
  topicsByStudent: Map<string, RemarkTopic[]>,
  limit = 8,
): CohortFocus[] {
  const acc = new Map<string, { label: string; marks: Set<string>; remarks: Set<string> }>();
  const get = (key: string, label: string) => {
    const e = acc.get(key) ?? { label, marks: new Set<string>(), remarks: new Set<string>() };
    acc.set(key, e);
    return e;
  };
  for (const [student, scores] of rubricByStudent) {
    for (const s of scores) if (s.percent < FOCUS_MAX_PCT) get(criterionTopic(s.key), TOPIC_BY_KEY.get(criterionTopic(s.key))?.label ?? s.label).marks.add(student);
  }
  for (const [student, topics] of topicsByStudent) {
    for (const t of topics) if (t.advice > 0) get(t.key, t.label).remarks.add(student);
  }
  return [...acc.entries()]
    .map(([key, e]) => {
      const all = new Set([...e.marks, ...e.remarks]);
      const source: CohortFocus['source'] = e.marks.size && e.remarks.size ? 'both' : e.marks.size ? 'marks' : 'remarks';
      const n = all.size;
      return { key, label: e.label, students: n, source, text: `${plural(n, 'student')} ${n === 1 ? 'needs' : 'need'} help with ${lowerFirst(TOPIC_BY_KEY.get(key)?.focus ?? e.label)}` };
    })
    .filter(f => f.students > 0)
    .sort((a, b) => b.students - a.students || a.label.localeCompare(b.label))
    .slice(0, limit);
}

export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
