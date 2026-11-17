/**
 * Smart analysis — database side. A handful of parameterised, grouped queries
 * (never one query per student); the words come from analysisLogic.ts.
 * owner: analysis
 */
import { creditPassedLevels } from './builderLogic.js';
import { pool } from '../../db.js';
import { getEffectivePolicies } from './policies.js';
import { loadStudentRecords, SqlParams } from './insightsData.js';
import { DAY_MS, friendlyLevel, friendlyStep, toDate } from './insightsLogic.js';
import { nairobiMonth, zonedParts } from './reviewLogic.js';
import { loadCourseDetail, loadStepTypes } from './courseQueries.js';
import {
  buildStepStates, computeProgressPercent, computeUnlockedLevelIds, passedStepIdsFrom, studentLevels, type SubmissionLite,
} from './courseLogic.js';
import {
  activeDaysInWindow, bandOf, buildNextSteps, clampInt, cohortFocus, computeTrend, extractRemarkTopics, histogram,
  meritProgress, parseJsonSafe, practiceStreak, rubricAverages, strengthsAndFocus, suggestedMessage,
  type Bands, type Criterion, type RemarkText,
} from './analysisLogic.js';
import type {
  AnalysisMark, CohortAnalysis, CohortHardStep, CohortLevelAverage, CohortStuck, CourseProgressItem, CriterionScore,
  RemarkTopic, StudentAnalysis,
} from './analysisTypes.js';
import type { EffectivePolicies, StepTypeDef } from '../contracts.js';

const n = (value: unknown): number => {
  const x = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(x) ? x : 0;
};
const iso = (value: unknown): string | null => toDate(value)?.toISOString() ?? null;
const UPLOAD_ACTIONS = new Set(['upload', 'download_upload']);
const REMARK_WINDOW_DAYS = 365;
const COHORT_WINDOW_DAYS = 180;
const MAX_MARKS_SHOWN = 40;

// ---------------------------------------------------------------- policy helpers
export function bandsFrom(policies: Partial<EffectivePolicies>): Bands {
  const b = parseJsonSafe<Partial<Bands> | null>(policies['assessment.bands'], null) ?? {};
  const revisionMax = Number(b.revisionMax);
  const passMax = Number(b.passMax);
  return { revisionMax: Number.isFinite(revisionMax) ? revisionMax : 5, passMax: Number.isFinite(passMax) ? passMax : 8 };
}

export function criteriaFrom(policies: Partial<EffectivePolicies>): Criterion[] {
  const raw = parseJsonSafe<unknown>(policies['assessment.rubric'], []);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === 'object' && typeof (c as { key?: unknown }).key === 'string')
    .map(c => ({ key: String(c.key), label: typeof c.label === 'string' && c.label.trim() ? c.label : String(c.key), max: Math.max(1, n(c.max) || 2) }));
}

/** The warm template comments (chosen by the server, not written by a teacher) — ignored in remark analysis. */
export function templateTexts(policies: Partial<EffectivePolicies>): string[] {
  const raw = parseJsonSafe<Record<string, unknown> | null>(policies['review.comment_templates'], null);
  if (!raw || typeof raw !== 'object') return [];
  return Object.values(raw).flatMap(list => (Array.isArray(list) ? list.filter((t): t is string => typeof t === 'string') : []));
}

function pinTexts(rawPins: unknown, at: unknown): RemarkText[] {
  const pins = parseJsonSafe<unknown>(rawPins, []);
  if (!Array.isArray(pins)) return [];
  return pins
    .map(p => (p && typeof p === 'object' ? (p as { text?: unknown }).text : null))
    .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    .map(text => ({ text, at: toDate(at) }));
}

// ---------------------------------------------------------------- one student
type V2Row = {
  id: string; step_id: string; course_id: string; mark: unknown; band: string | null; rubric: unknown; status: string; attempt_no: unknown;
  created_at: unknown; reviewed_at: unknown; course_code: string | null; course_title: string; level_code: string | null; step_code: string | null;
};

/**
 * Everything about one student. Returns null when the id is not a (live) student.
 * `audience` decides wording and whether a suggested message for staff is included.
 */
export async function loadStudentAnalysis(studentId: string, audience: 'student' | 'staff', now = new Date()): Promise<StudentAnalysis | null> {
  const [record] = await loadStudentRecords({ studentIds: [studentId] }, now);
  if (!record) return null;
  const since = new Date(now.getTime() - REMARK_WINDOW_DAYS * DAY_MS);

  const [policies, user, v2, legacy, days, msgs, pins, chat, merit, badges, enrolled, done, stepTypes] = await Promise.all([
    getEffectivePolicies(record.branchId),
    pool.query(`SELECT created_at FROM users WHERE id = $1`, [studentId]),
    pool.query(
      `SELECT s.id, s.step_id, s.course_id, s.mark, s.band, s.rubric, s.status, s.attempt_no, s.created_at, s.reviewed_at,
              c.code AS course_code, c.title AS course_title, l.code AS level_code, st.code AS step_code
       FROM step_submissions s
       JOIN courses c ON c.id = s.course_id
       LEFT JOIN levels l ON l.id = s.level_id
       LEFT JOIN level_steps st ON st.id = s.step_id
       WHERE s.student_id = $1
       ORDER BY s.created_at`, [studentId]),
    pool.query(
      `SELECT e.id, e.status, e.mark_out_of_ten, e.mark_passed, e.feedback, e.created_at, e.reviewed_at,
              l.title AS level_title, c.id AS course_id, c.title AS course_title
       FROM entries e
       LEFT JOIN levels l ON l.id = e.level_id
       LEFT JOIN courses c ON c.id = l.course_id
       WHERE e.student_id = $1 AND e.competition_id IS NULL AND e.event_id IS NULL
       ORDER BY e.created_at`, [studentId]),
    // Distinct active days in Nairobi time (UTC+3, no daylight saving), last ~400 days.
    pool.query(
      `SELECT DISTINCT x.d FROM (
         SELECT DATE_FORMAT(a.activity_date, '%Y-%m-%d') AS d FROM activity_log a WHERE a.user_id = $1 AND a.activity_date >= DATE($2)
         UNION SELECT DATE_FORMAT(DATE_ADD(p.done_at, INTERVAL 3 HOUR), '%Y-%m-%d') FROM step_progress p WHERE p.student_id = $1 AND p.done_at >= $2
         UNION SELECT DATE_FORMAT(DATE_ADD(s.created_at, INTERVAL 3 HOUR), '%Y-%m-%d') FROM step_submissions s WHERE s.student_id = $1 AND s.created_at >= $2
         UNION SELECT DATE_FORMAT(DATE_ADD(m.created_at, INTERVAL 3 HOUR), '%Y-%m-%d') FROM thread_messages m WHERE m.sender_id = $1 AND m.sender_role = 'student' AND m.created_at >= $2
         UNION SELECT DATE_FORMAT(DATE_ADD(e.created_at, INTERVAL 3 HOUR), '%Y-%m-%d') FROM entries e WHERE e.student_id = $1 AND e.created_at >= $2
         UNION SELECT DATE_FORMAT(DATE_ADD(ls.submitted_at, INTERVAL 3 HOUR), '%Y-%m-%d') FROM level_submissions ls WHERE ls.student_id = $1 AND ls.submitted_at >= $2
       ) x`, [studentId, new Date(now.getTime() - 400 * DAY_MS)]),
    pool.query(
      `SELECT m.body, m.created_at FROM thread_messages m
       WHERE m.student_id = $1 AND m.sender_role IN ('teacher', 'admin') AND m.kind IN ('text', 'mark') AND m.body IS NOT NULL AND m.created_at >= $2
       ORDER BY m.created_at DESC LIMIT 300`, [studentId, since]),
    pool.query(
      `SELECT a.pins, a.updated_at FROM annotations a JOIN step_submissions s ON s.id = a.submission_id
       WHERE s.student_id = $1 AND a.updated_at >= $2 ORDER BY a.updated_at DESC LIMIT 200`, [studentId, since]),
    pool.query(
      `SELECT cm.content, cm.created_at FROM course_chat_messages cm
       WHERE cm.student_id = $1 AND cm.sender_id <> $1 AND cm.message_type = 'text' AND cm.content IS NOT NULL AND cm.created_at >= $2
       ORDER BY cm.created_at DESC LIMIT 200`, [studentId, since]),
    pool.query(`SELECT points, status, earned_month FROM merit_ledger WHERE student_id = $1`, [studentId]),
    pool.query(`SELECT course_id, COUNT(*) AS total FROM student_badges WHERE student_id = $1 AND kind = 'level' AND course_id IS NOT NULL GROUP BY course_id`, [studentId]),
    pool.query(
      `SELECT en.course_id, en.current_level_index, en.percent_complete, en.enrolled_at, c.structure_version, c.code, c.title, c.status
       FROM enrollments en JOIN courses c ON c.id = en.course_id
       WHERE en.student_id = $1 ORDER BY en.enrolled_at DESC`, [studentId]),
    pool.query(`SELECT step_id FROM step_progress WHERE student_id = $1`, [studentId]),
    loadStepTypes(),
  ]);

  const bands = bandsFrom(policies);
  const criteria = criteriaFrom(policies);
  const todayYmd = zonedParts(now).ymd;

  // ---- marks timeline (v2 + legacy)
  const v2Rows = v2.rows as V2Row[];
  const allMarks: AnalysisMark[] = [];
  for (const r of v2Rows) {
    if (r.mark === null || r.mark === undefined) continue;
    const mark = n(r.mark);
    allMarks.push({
      date: iso(r.reviewed_at) ?? iso(r.created_at) ?? now.toISOString(),
      mark,
      band: (r.band === 'revision' || r.band === 'pass' || r.band === 'distinction') ? r.band : bandOf(mark, bands),
      label: [r.course_title ?? r.course_code, friendlyLevel(r.level_code), friendlyStep(r.step_code)].filter(Boolean).join(' · '),
      courseId: r.course_id,
      attemptNo: n(r.attempt_no) || 1,
      source: 'v2',
      provisional: r.status === 'submitted' || r.status === 'in_review',
    });
  }
  for (const e of legacy.rows as any[]) {
    if (e.mark_out_of_ten === null || e.mark_out_of_ten === undefined) continue;
    const mark = n(e.mark_out_of_ten);
    allMarks.push({
      date: iso(e.reviewed_at) ?? iso(e.created_at) ?? now.toISOString(),
      mark,
      band: bandOf(mark, bands),
      label: [e.course_title, e.level_title].filter(Boolean).join(' · ') || 'Earlier work',
      courseId: e.course_id ?? null,
      attemptNo: 1,
      source: 'legacy',
    });
  }
  allMarks.sort((a, b) => a.date.localeCompare(b.date));
  const markValues = allMarks.map(m => m.mark);
  const trend = computeTrend(markValues);

  // ---- activity
  const dayKeys = (days.rows as any[]).map(r => String(r.d)).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));

  // ---- rubric, remarks, strengths
  const rubric = rubricAverages(v2Rows.filter(r => r.rubric != null).map(r => ({ rubric: r.rubric, at: toDate(r.reviewed_at) ?? toDate(r.created_at) })), criteria);
  const remarkTexts: RemarkText[] = [
    ...(msgs.rows as any[]).map(r => ({ text: String(r.body ?? ''), at: toDate(r.created_at) })),
    ...(pins.rows as any[]).flatMap(r => pinTexts(r.pins, r.updated_at)),
    ...(chat.rows as any[]).map(r => ({ text: String(r.content ?? ''), at: toDate(r.created_at) })),
    ...(legacy.rows as any[]).filter(e => typeof e.feedback === 'string' && e.feedback.trim()).map(e => ({ text: String(e.feedback), at: toDate(e.reviewed_at) ?? toDate(e.created_at) })),
  ];
  const remarks = extractRemarkTopics(remarkTexts, { ignore: templateTexts(policies), limit: 6 });
  const { strengths, focusAreas } = strengthsAndFocus(rubric, remarks);

  // ---- courses
  const subsLite: (SubmissionLite & { courseId: string })[] = v2Rows.map(r => ({
    stepId: r.step_id, courseId: r.course_id, attemptNo: n(r.attempt_no) || 1, status: r.status as SubmissionLite['status'],
    mark: r.mark == null ? null : n(r.mark), band: (r.band ?? null) as SubmissionLite['band'], createdAt: r.created_at as string,
  }));
  const doneIds = new Set((done.rows as any[]).map(r => String(r.step_id)));
  const badgeByCourse = new Map<string, number>((badges.rows as any[]).map(r => [String(r.course_id), n(r.total)]));
  const enrolledRows = enrolled.rows as any[];
  const v2CourseIds = new Set<string>(enrolledRows.filter(r => n(r.structure_version) === 2).map(r => String(r.course_id)));
  for (const s of subsLite) v2CourseIds.add(s.courseId);
  const v2Courses = (await Promise.all([...v2CourseIds].slice(0, 12).map(id => courseProgress(id, stepTypes, doneIds, subsLite.filter(s => s.courseId === id), badgeByCourse.get(id) ?? 0))))
    .filter((c): c is CourseProgressItem => Boolean(c));
  const legacyCourses = await legacyProgress(enrolledRows.filter(r => n(r.structure_version) !== 2));
  const courses = [...v2Courses, ...legacyCourses];

  // ---- merit
  const meritInfo = meritProgress({
    ledger: (merit.rows as any[]).map(r => ({ points: n(r.points), status: String(r.status), earnedMonth: String(r.earned_month) })),
    levelBadgesPerCourse: v2Courses.filter(c => !c.completed).map(c => badgeByCourse.get(c.courseId) ?? 0),
    levelsPerPoint: policies['merit.levels_per_point'],
    monthlyCap: policies['merit.monthly_cap'],
    thisMonth: nairobiMonth(now),
  });

  const streakDays = practiceStreak(dayKeys, todayYmd);
  const nextSteps = buildNextSteps({
    audience, courses, rubric, focusAreas, remarks, merit: meritInfo, streakDays, idleDays: record.idleDays, markCount: markValues.length,
  });

  const average = markValues.length ? Math.round((markValues.reduce((a, b) => a + b, 0) / markValues.length) * 10) / 10 : null;
  const legacyRevisions = (legacy.rows as any[]).filter(e => e.status === 'redo_needed').length;

  const analysis: StudentAnalysis = {
    student: {
      id: record.studentId, name: record.name, trNumber: record.trNumber, className: record.className,
      branchId: record.branchId, branchName: record.branchName, joinedAt: iso(user.rows[0]?.created_at),
    },
    generatedAt: now.toISOString(),
    summary: {
      levelsPassed: record.levelsPassed,
      averageMark: average,
      bestMark: markValues.length ? Math.max(...markValues) : null,
      markCount: markValues.length,
      trend: trend.trend,
      trendText: trend.text,
      streakDays,
      activeDays30: activeDaysInWindow(dayKeys, todayYmd, 30),
      lastActiveAt: record.lastActiveAt,
      attempts: v2Rows.length + (legacy.rows as any[]).length,
      revisions: v2Rows.filter(r => r.status === 'revision').length + legacyRevisions,
      distinctions: allMarks.filter(m => m.band === 'distinction').length,
    },
    marks: allMarks.slice(-MAX_MARKS_SHOWN),
    bands,
    rubric,
    strengths,
    focusAreas,
    remarks,
    courses,
    merit: meritInfo,
    segment: record.segment,
    segmentReason: record.reason,
    nextSteps,
    suggestedMessage: null,
  };
  if (audience === 'staff') {
    analysis.suggestedMessage = suggestedMessage({
      name: record.name, segment: record.segment, averageMark: average, levelsPassed: record.levelsPassed, idleDays: record.idleDays,
      strengths, focusAreas, nextSteps: buildNextSteps({ audience: 'student', courses, rubric, focusAreas, remarks, merit: meritInfo, streakDays, idleDays: record.idleDays, markCount: markValues.length }), bands,
    });
  }
  return analysis;
}

/** Progress of one v2 course, computed exactly like the student course page does. */
async function courseProgress(
  courseId: string, stepTypes: StepTypeDef[], doneIds: Set<string>, subs: SubmissionLite[], levelBadges: number,
): Promise<CourseProgressItem | null> {
  const detail = await loadCourseDetail(courseId);
  if (!detail || detail.structureVersion !== 2) return null;
  const levels = studentLevels(detail.levels, stepTypes, null, false);
  const steps = levels.flatMap(l => l.steps);
  const states = creditPassedLevels(levels, stepTypes, buildStepStates(steps, stepTypes, doneIds, subs, new Map())); // v3 builder: passed level = its worksheets done
  const unlocked = computeUnlockedLevelIds(levels, stepTypes, passedStepIdsFrom(subs));
  const typeOf = (key: string) => stepTypes.find(t => t.typeKey === key);
  const isUpload = (key: string) => UPLOAD_ACTIONS.has(typeOf(key)?.studentAction ?? '');

  const openLevels = levels.filter(l => unlocked.includes(l.id));
  const current = openLevels[openLevels.length - 1] ?? levels[0] ?? null;
  const openRevision = steps.some(s => states[s.id]?.submissionStatus === 'revision' && !states[s.id]?.done);
  const waiting = steps.some(s => states[s.id]?.submissionStatus === 'submitted' || states[s.id]?.submissionStatus === 'in_review');

  // Next step: a step sent back first, then the first unfinished step of the newest open level, then older leftovers.
  const pendingStatus = (id: string) => states[id]?.submissionStatus === 'submitted' || states[id]?.submissionStatus === 'in_review';
  const candidates = [current, ...openLevels.slice(0, -1)].filter(Boolean) as typeof levels;
  let next: { step: (typeof steps)[number]; level: (typeof levels)[number] } | null = null;
  for (const level of candidates) {
    const revision = level.steps.find(s => states[s.id]?.submissionStatus === 'revision' && !states[s.id]?.done);
    if (revision) { next = { step: revision, level }; break; }
  }
  if (!next) {
    for (const level of candidates) {
      const step = level.steps.find(s => !states[s.id]?.done && !pendingStatus(s.id));
      if (step) { next = { step, level }; break; }
    }
  }
  let unlocksLevel: string | null = null;
  if (next && typeOf(next.step.stepType)?.gatesProgress) {
    const idx = levels.findIndex(l => l.id === next!.level.id);
    const otherGates = next.level.steps.filter(s => s.id !== next!.step.id && typeOf(s.stepType)?.gatesProgress && !states[s.id]?.done);
    if (idx >= 0 && idx < levels.length - 1 && !otherGates.length) unlocksLevel = friendlyLevel(levels[idx + 1].code, idx + 1);
  }
  const allDone = steps.length > 0 && steps.every(s => states[s.id]?.done);
  const lastLevel = levels[levels.length - 1];
  const lastGates = lastLevel?.steps.filter(s => typeOf(s.stepType)?.gatesProgress) ?? [];
  const completed = Boolean(lastLevel) && unlocked.length === levels.length && (allDone || (lastGates.length > 0 && lastGates.every(s => states[s.id]?.done)));

  return {
    courseId,
    code: detail.code,
    title: detail.title,
    structureVersion: 2,
    progressPercent: computeProgressPercent(steps.map(s => s.id), states),
    levelsPassed: levelBadges,
    totalLevels: levels.length,
    currentLevel: current ? friendlyLevel(current.code, levels.findIndex(l => l.id === current.id)) : null,
    currentLevelDescription: current?.description ?? null,
    waitingForReview: waiting,
    openRevision,
    completed,
    nextStep: next && !completed ? {
      stepId: next.step.id, code: friendlyStep(next.step.code), title: next.step.title ?? '', levelCode: friendlyLevel(next.level.code, levels.findIndex(l => l.id === next!.level.id)) ?? '',
      isUpload: isUpload(next.step.stepType), unlocksLevel,
    } : null,
  };
}

/** Legacy (structure 1) enrollments: percent + current level title, no step-level detail. */
async function legacyProgress(rows: any[]): Promise<CourseProgressItem[]> {
  if (!rows.length) return [];
  const p = new SqlParams();
  const ids = rows.map(r => String(r.course_id));
  const { rows: levelRows } = await pool.query(
    `SELECT course_id, order_index, title FROM levels WHERE course_id IN (${p.list(ids)}) ORDER BY course_id, order_index`, p.values);
  const byCourse = new Map<string, { order_index: number; title: string }[]>();
  for (const l of levelRows as any[]) {
    const list = byCourse.get(String(l.course_id)) ?? [];
    list.push({ order_index: n(l.order_index), title: String(l.title ?? '') });
    byCourse.set(String(l.course_id), list);
  }
  return rows.map(r => {
    const levels = byCourse.get(String(r.course_id)) ?? [];
    const idx = n(r.current_level_index);
    const level = levels.find(l => l.order_index === idx) ?? null;
    const pct = Math.round(n(r.percent_complete));
    return {
      courseId: String(r.course_id), code: r.code ?? null, title: String(r.title ?? ''), structureVersion: 1 as const,
      progressPercent: Math.min(100, Math.max(0, pct)), levelsPassed: idx, totalLevels: levels.length,
      currentLevel: level ? `Level ${idx + 1}` : null, currentLevelDescription: level?.title ?? null,
      waitingForReview: false, openRevision: false, completed: pct >= 100, nextStep: null,
    };
  });
}

// ---------------------------------------------------------------- class view
export type CohortScope = { branchId: string | null; courseId: string | null; stuckDays: number };

export async function loadCohortAnalysis(scope: CohortScope, now = new Date()): Promise<CohortAnalysis> {
  const stuckDays = clampInt(scope.stuckDays, 14, 3, 365);
  const since = new Date(now.getTime() - COHORT_WINDOW_DAYS * DAY_MS);
  const stuckCut = new Date(now.getTime() - stuckDays * DAY_MS);

  const p = new SqlParams();
  let uf = `u.role = 'student' AND u.deleted_at IS NULL`;
  if (scope.branchId) uf += ` AND u.branch_id = ${p.add(scope.branchId)}`;
  const course = scope.courseId ? p.add(scope.courseId) : null;
  const cS = course ? ` AND s.course_id = ${course}` : '';
  const cL = course ? ` AND l.course_id = ${course}` : '';
  const cM = course ? ` AND m.course_id = ${course}` : '';
  const sinceP = p.add(since);
  const stuckP = p.add(stuckCut);
  const branchP = scope.branchId ? p.add(scope.branchId) : null;
  const v = p.values;
  const legacyWork = `e.competition_id IS NULL AND e.event_id IS NULL`;

  const [
    studentCount, v2Hist, lgHist, withMarks, v2Levels, lgLevels, hard, firstV2, firstLg, rubricRows, remarkRows, pinRows, lgFeedback, stuckRows, courseRows, branchRow,
  ] = await Promise.all([
    course
      ? pool.query(`SELECT COUNT(DISTINCT x.sid) AS total FROM (
           SELECT en.student_id AS sid FROM enrollments en JOIN users u ON u.id = en.student_id WHERE ${uf} AND en.course_id = ${course}
           UNION SELECT s.student_id FROM step_submissions s JOIN users u ON u.id = s.student_id WHERE ${uf}${cS}) x`, v)
      : pool.query(`SELECT COUNT(*) AS total FROM users u WHERE ${uf}`, v),
    pool.query(`SELECT s.mark, COUNT(*) AS total FROM step_submissions s JOIN users u ON u.id = s.student_id
                WHERE ${uf} AND s.mark IS NOT NULL${cS} GROUP BY s.mark`, v),
    pool.query(`SELECT e.mark_out_of_ten AS mark, COUNT(*) AS total FROM entries e JOIN users u ON u.id = e.student_id LEFT JOIN levels l ON l.id = e.level_id
                WHERE ${uf} AND ${legacyWork} AND e.mark_out_of_ten IS NOT NULL${cL} GROUP BY e.mark_out_of_ten`, v),
    pool.query(`SELECT COUNT(DISTINCT x.sid) AS total FROM (
                  SELECT s.student_id AS sid FROM step_submissions s JOIN users u ON u.id = s.student_id WHERE ${uf} AND s.mark IS NOT NULL${cS}
                  UNION SELECT e.student_id FROM entries e JOIN users u ON u.id = e.student_id LEFT JOIN levels l ON l.id = e.level_id
                    WHERE ${uf} AND ${legacyWork} AND e.mark_out_of_ten IS NOT NULL${cL}) x`, v),
    pool.query(`SELECT s.course_id, c.code AS course_code, c.title AS course_title, l.code AS level_code, l.description, l.order_index,
                       AVG(s.mark) AS avg_mark, COUNT(s.mark) AS marked, COUNT(DISTINCT s.student_id) AS students
                FROM step_submissions s JOIN users u ON u.id = s.student_id JOIN courses c ON c.id = s.course_id JOIN levels l ON l.id = s.level_id
                WHERE ${uf} AND s.mark IS NOT NULL${cS}
                GROUP BY s.course_id, c.code, c.title, l.id, l.code, l.description, l.order_index
                ORDER BY c.code, l.order_index LIMIT 60`, v),
    pool.query(`SELECT c.id AS course_id, c.title AS course_title, l.title AS level_title, l.order_index,
                       AVG(e.mark_out_of_ten) AS avg_mark, COUNT(e.mark_out_of_ten) AS marked, COUNT(DISTINCT e.student_id) AS students
                FROM entries e JOIN users u ON u.id = e.student_id JOIN levels l ON l.id = e.level_id JOIN courses c ON c.id = l.course_id
                WHERE ${uf} AND ${legacyWork} AND e.mark_out_of_ten IS NOT NULL AND c.structure_version = 1${cL}
                GROUP BY c.id, c.title, l.id, l.title, l.order_index
                ORDER BY c.title, l.order_index LIMIT 40`, v),
    pool.query(`SELECT s.step_id, c.code AS course_code, c.title AS course_title, l.code AS level_code, st.code AS step_code, st.title,
                       SUM(CASE WHEN s.status = 'revision' THEN 1 ELSE 0 END) AS revisions, COUNT(*) AS attempts,
                       COUNT(DISTINCT s.student_id) AS students, AVG(s.mark) AS avg_mark
                FROM step_submissions s JOIN users u ON u.id = s.student_id JOIN courses c ON c.id = s.course_id
                JOIN levels l ON l.id = s.level_id JOIN level_steps st ON st.id = s.step_id
                WHERE ${uf}${cS}
                GROUP BY s.step_id, c.code, c.title, l.code, st.code, st.title
                ORDER BY revisions DESC, (COUNT(*) / COUNT(DISTINCT s.student_id)) DESC, avg_mark ASC
                LIMIT 12`, v),
    pool.query(`SELECT COUNT(*) AS total, SUM(CASE WHEN s.status = 'passed' THEN 1 ELSE 0 END) AS passed
                FROM step_submissions s JOIN users u ON u.id = s.student_id
                WHERE ${uf} AND s.attempt_no = 1 AND s.status IN ('passed', 'revision')${cS}`, v),
    pool.query(`SELECT COUNT(*) AS total, SUM(CASE WHEN e.mark_passed = 1 AND e.status <> 'redo_needed' THEN 1 ELSE 0 END) AS passed
                FROM entries e JOIN users u ON u.id = e.student_id LEFT JOIN levels l ON l.id = e.level_id
                WHERE ${uf} AND ${legacyWork} AND e.redo_of_entry_id IS NULL AND (e.mark_passed IS NOT NULL OR e.status = 'redo_needed')${cL}`, v),
    pool.query(`SELECT s.student_id, s.rubric, s.reviewed_at FROM step_submissions s JOIN users u ON u.id = s.student_id
                WHERE ${uf} AND s.rubric IS NOT NULL AND s.created_at >= ${sinceP}${cS} LIMIT 20000`, v),
    pool.query(`SELECT m.student_id, m.body, m.created_at FROM thread_messages m JOIN users u ON u.id = m.student_id
                WHERE ${uf} AND m.sender_role IN ('teacher', 'admin') AND m.kind IN ('text', 'mark') AND m.body IS NOT NULL AND m.created_at >= ${sinceP}${cM}
                ORDER BY m.created_at DESC LIMIT 15000`, v),
    pool.query(`SELECT s.student_id, a.pins, a.updated_at FROM annotations a JOIN step_submissions s ON s.id = a.submission_id JOIN users u ON u.id = s.student_id
                WHERE ${uf} AND a.updated_at >= ${sinceP}${cS} LIMIT 10000`, v),
    pool.query(`SELECT e.student_id, e.feedback, e.reviewed_at FROM entries e JOIN users u ON u.id = e.student_id LEFT JOIN levels l ON l.id = e.level_id
                WHERE ${uf} AND ${legacyWork} AND e.feedback IS NOT NULL AND e.feedback <> '' AND e.created_at >= ${sinceP}${cL} LIMIT 10000`, v),
    // Stuck: enrolled in a live v2 course, no new level badge (or enrollment) since the cut-off, nothing waiting for our reply.
    pool.query(`SELECT en.student_id, u.name, u.tr_number, u.class_name, c.id AS course_id, c.code AS course_code, c.title AS course_title,
                       COALESCE(b.total, 0) AS badges, COALESCE(b.last_at, en.enrolled_at) AS since_at
                FROM enrollments en
                JOIN users u ON u.id = en.student_id
                JOIN courses c ON c.id = en.course_id
                LEFT JOIN (SELECT sb.student_id, sb.course_id, COUNT(*) AS total, MAX(sb.awarded_at) AS last_at
                           FROM student_badges sb JOIN users u ON u.id = sb.student_id
                           WHERE sb.kind = 'level' AND ${uf} GROUP BY sb.student_id, sb.course_id) b
                  ON b.student_id = en.student_id AND b.course_id = en.course_id
                WHERE ${uf} AND c.structure_version = 2 AND c.status IN ('published', 'held')${course ? ` AND c.id = ${course}` : ''}
                  AND COALESCE(b.last_at, en.enrolled_at) < ${stuckP}
                  AND NOT EXISTS (SELECT 1 FROM step_submissions ps WHERE ps.student_id = en.student_id AND ps.course_id = en.course_id AND ps.status IN ('submitted', 'in_review'))
                  AND NOT EXISTS (SELECT 1 FROM student_badges cb WHERE cb.student_id = en.student_id AND cb.course_id = en.course_id AND cb.kind = 'course')
                ORDER BY since_at ASC LIMIT 1000`, v),
    pool.query(`SELECT c.id, c.code, c.title FROM courses c
                WHERE c.structure_version = 2 AND c.status IN ('published', 'held')
                ${branchP ? `AND (NOT EXISTS (SELECT 1 FROM course_branches cb WHERE cb.course_id = c.id) OR EXISTS (SELECT 1 FROM course_branches cb WHERE cb.course_id = c.id AND cb.branch_id = ${branchP}))` : ''}
                ORDER BY c.code`, v),
    scope.branchId ? pool.query(`SELECT name FROM branches WHERE id = $1`, [scope.branchId]) : Promise.resolve({ rows: [] as any[] }),
  ]);

  // Policies (bands, rubric labels, templates) of the branch — or the global ones for "all branches".
  const policies = await getEffectivePolicies(scope.branchId);
  const bands = bandsFrom(policies);
  const criteria = criteriaFrom(policies);
  let templates = templateTexts(policies);
  if (!scope.branchId) {
    const { rows: branchIds } = await pool.query(`SELECT id FROM branches`);
    const all = await Promise.all((branchIds as any[]).map(b => getEffectivePolicies(String(b.id)).then(templateTexts).catch(() => [] as string[])));
    templates = [...new Set([...templates, ...all.flat()])];
  }

  // Histogram + average
  const markCounts = new Map<number, number>();
  for (const r of [...v2Hist.rows, ...lgHist.rows] as any[]) markCounts.set(n(r.mark), (markCounts.get(n(r.mark)) ?? 0) + n(r.total));
  const flat: number[] = [];
  for (const [mark, count] of markCounts) for (let i = 0; i < count; i++) flat.push(mark);
  const hist = histogram(flat);
  const markedWork = hist.reduce((a, b) => a + b.count, 0);
  const sum = hist.reduce((a, b) => a + b.mark * b.count, 0);

  // Level averages
  const round1 = (x: number) => Math.round(x * 10) / 10;
  const levelAverages: CohortLevelAverage[] = [
    ...(v2Levels.rows as any[]).map(r => ({
      courseId: String(r.course_id), courseLabel: r.course_title ?? r.course_code, levelCode: friendlyLevel(r.level_code, r.order_index) ?? `Level ${n(r.order_index) + 1}`,
      levelLabel: [friendlyLevel(r.level_code, r.order_index), r.description].filter(Boolean).join(' · '), average: round1(n(r.avg_mark)), marked: n(r.marked), students: n(r.students),
    })),
    ...(lgLevels.rows as any[]).map(r => ({
      courseId: String(r.course_id), courseLabel: String(r.course_title), levelCode: `Level ${n(r.order_index) + 1}`,
      levelLabel: String(r.level_title ?? `Level ${n(r.order_index) + 1}`), average: round1(n(r.avg_mark)), marked: n(r.marked), students: n(r.students),
    })),
  ];

  // Hardest steps: sent back most, or needing more than one try on average.
  const hardestSteps: CohortHardStep[] = (hard.rows as any[])
    .map(r => ({
      stepId: String(r.step_id), courseLabel: r.course_title ?? r.course_code, levelCode: friendlyLevel(r.level_code) ?? '', stepCode: friendlyStep(r.step_code),
      title: r.title ?? '', revisions: n(r.revisions), attempts: n(r.attempts), students: n(r.students),
      averageMark: r.avg_mark == null ? null : round1(n(r.avg_mark)),
    }))
    .filter(s => s.revisions > 0 || s.attempts > s.students)
    .slice(0, 6);

  // Common focus areas (per student, merged by topic)
  const rubricSamples = new Map<string, { rubric: unknown; at: Date | null }[]>();
  for (const r of rubricRows.rows as any[]) {
    const list = rubricSamples.get(String(r.student_id)) ?? [];
    list.push({ rubric: r.rubric, at: toDate(r.reviewed_at) });
    rubricSamples.set(String(r.student_id), list);
  }
  const rubricByStudent = new Map<string, CriterionScore[]>();
  for (const [sid, samples] of rubricSamples) rubricByStudent.set(sid, rubricAverages(samples, criteria));
  const textsByStudent = new Map<string, RemarkText[]>();
  const pushText = (sid: string, items: RemarkText[]) => { if (items.length) textsByStudent.set(sid, [...(textsByStudent.get(sid) ?? []), ...items]); };
  for (const r of remarkRows.rows as any[]) pushText(String(r.student_id), [{ text: String(r.body ?? ''), at: toDate(r.created_at) }]);
  for (const r of pinRows.rows as any[]) pushText(String(r.student_id), pinTexts(r.pins, r.updated_at));
  for (const r of lgFeedback.rows as any[]) pushText(String(r.student_id), [{ text: String(r.feedback ?? ''), at: toDate(r.reviewed_at) }]);
  const topicsByStudent = new Map<string, RemarkTopic[]>();
  for (const [sid, texts] of textsByStudent) topicsByStudent.set(sid, extractRemarkTopics(texts, { ignore: templates, limit: 30 }));
  const commonFocus = cohortFocus(rubricByStudent, topicsByStudent, 8);

  // First-attempt pass rate (v2 + legacy)
  const faTotal = n(firstV2.rows[0]?.total) + n(firstLg.rows[0]?.total);
  const faPassed = n(firstV2.rows[0]?.passed) + n(firstLg.rows[0]?.passed);

  // Stuck students: level label = the level after their last badge.
  const stuckList = stuckRows.rows as any[];
  const stuckCourseIds = [...new Set(stuckList.map(r => String(r.course_id)))];
  const levelsByCourse = new Map<string, string[]>();
  if (stuckCourseIds.length) {
    const q = new SqlParams();
    const { rows } = await pool.query(
      `SELECT l.course_id, l.code FROM levels l WHERE l.status = 'published' AND l.course_id IN (${q.list(stuckCourseIds)}) ORDER BY l.course_id, l.order_index`, q.values);
    for (const r of rows as any[]) levelsByCourse.set(String(r.course_id), [...(levelsByCourse.get(String(r.course_id)) ?? []), String(r.code ?? '')]);
  }
  const stuckCandidates = stuckList
    .map(r => {
      const codes = levelsByCourse.get(String(r.course_id)) ?? [];
      const badgesN = n(r.badges);
      if (codes.length && badgesN >= codes.length) return null; // finished every level
      const since = toDate(r.since_at);
      return {
        studentId: String(r.student_id), name: String(r.name ?? ''), trNumber: r.tr_number ?? null, className: r.class_name ?? null,
        courseId: String(r.course_id), courseLabel: r.course_title ?? r.course_code, levelCode: codes[badgesN] ? friendlyLevel(codes[badgesN], badgesN) ?? `Level ${badgesN + 1}` : `Level ${badgesN + 1}`,
        days: since ? Math.floor((now.getTime() - since.getTime()) / DAY_MS) : stuckDays,
        lastActiveAt: null as string | null, lastNudgedAt: null as string | null,
      } satisfies CohortStuck;
    })
    .filter((s): s is CohortStuck => Boolean(s))
    .sort((a, b) => b.days - a.days || a.name.localeCompare(b.name));
  const shown = stuckCandidates.slice(0, 150);
  if (shown.length) {
    const records = await loadStudentRecords({ studentIds: [...new Set(shown.map(s => s.studentId))] }, now);
    const byId = new Map(records.map(r => [r.studentId, r]));
    for (const s of shown) {
      s.lastActiveAt = byId.get(s.studentId)?.lastActiveAt ?? null;
      s.lastNudgedAt = byId.get(s.studentId)?.lastNudgedAt ?? null;
    }
  }

  const courses = (courseRows.rows as any[]).map(r => ({ id: String(r.id), label: String(r.title ?? r.code ?? '') }));
  const courseLabel = scope.courseId ? courses.find(c => c.id === scope.courseId)?.label ?? null : null;

  return {
    generatedAt: now.toISOString(),
    scope: { branchId: scope.branchId, branchName: branchRow.rows[0]?.name ?? null, courseId: scope.courseId, courseLabel },
    courses,
    students: n(studentCount.rows[0]?.total),
    studentsWithMarks: n(withMarks.rows[0]?.total),
    markedWork,
    averageMark: markedWork ? round1(sum / markedWork) : null,
    histogram: hist,
    bands,
    levelAverages,
    hardestSteps,
    commonFocus,
    firstAttempt: { total: faTotal, passed: faPassed, rate: faTotal ? Math.round((faPassed / faTotal) * 100) : null },
    stuckDays,
    stuck: shown,
    stuckTotal: stuckCandidates.length,
  };
}

/** Branch of a student (null when not a live student). */
export async function studentBranch(studentId: string): Promise<string | null> {
  const { rows } = await pool.query(`SELECT branch_id FROM users WHERE id = $1 AND role = 'student' AND deleted_at IS NULL`, [studentId]);
  return rows[0]?.branch_id ?? null;
}
