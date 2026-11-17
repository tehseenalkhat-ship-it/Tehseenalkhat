import type { FastifyInstance } from 'fastify';
import { pool } from '../../db.js';
import { getActor, requireAnyAdmin } from '../lib/access.js';
import { getEffectivePolicies } from '../lib/policies.js';
import { loadStudentRecords, loadTeamReport, SqlParams } from '../lib/insightsData.js';
import { canNudge, toDate } from '../lib/insightsLogic.js';
import { loadCourseSummaries } from '../lib/courseQueries.js';
import { loadReviewerNodes } from '../lib/threadData.js';
import { branchReviewers, isAway, zonedParts } from '../lib/reviewLogic.js';
import {
  buildAlerts, isMonthEndSoon, monthName,
  type AdminToday, type AdminTodayBranch, type BranchFacts, type CourseGap, type LevelGap,
} from '../lib/adminHome.js';

// owner: admin-home — GET /v2/admin/today (admins). Registered under prefix '/v2'.

const n = (v: unknown): number => {
  const x = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};
const positive = (v: unknown, fallback: number): number => {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? x : fallback;
};
const LIVE_COURSE = `('published', 'held')`;

export async function adminHomeV2Routes(app: FastifyInstance): Promise<void> {
  const admins = { preHandler: [app.authenticate, requireAnyAdmin(app)] };

  app.get<{ Querystring: { branchId?: string } }>('/admin/today', admins, async (request, reply) => {
    const actor = await getActor(request);
    const requested = request.query.branchId?.trim() || null;
    if (!actor.isMaster && requested && requested !== actor.branchId) {
      return reply.code(403).send({ error: 'You can only see your own branch.' });
    }
    const branchId = actor.isMaster ? requested : actor.branchId;
    const now = new Date();
    const zp = zonedParts(now);
    const month = zp.ym;

    const branchRows = (await pool.query(
      branchId ? `SELECT id, name FROM branches WHERE id = $1` : `SELECT id, name FROM branches ORDER BY name`,
      branchId ? [branchId] : [],
    )).rows as { id: string; name: string }[];
    if (branchId && !branchRows.length) return reply.code(404).send({ error: 'That branch was not found.' });

    // ---- grouped SQL, all in parallel ----
    const p = new SqlParams();
    const monthP = p.add(month);
    const bScope = (col: string) => (branchId ? `${col} = ${p.add(branchId)}` : '1 = 1');
    const sSub = bScope('s.branch_id');
    const sUser = bScope('u.branch_id');
    const sMerit = bScope('m.branch_id');
    const courseBranch = branchId
      ? `AND (NOT EXISTS (SELECT 1 FROM course_branches cb WHERE cb.course_id = c.id) OR EXISTS (SELECT 1 FROM course_branches cb2 WHERE cb2.course_id = c.id AND cb2.branch_id = ${p.add(branchId)}))`
      : '';
    const v = p.values;

    const [team, records, courses, reviewers, oldest, merit, noAssessment, policies] = await Promise.all([
      loadTeamReport(branchId, 30, now),
      loadStudentRecords({ branchId }, now),
      loadCourseSummaries({ structureVersion: 2, ...(branchId ? { branchId } : {}) }),
      loadReviewerNodes(),
      pool.query(
        `SELECT x.bid, MIN(x.t) AS oldest FROM (
           SELECT s.branch_id AS bid, MIN(s.created_at) AS t FROM step_submissions s
             WHERE s.status IN ('submitted', 'in_review') AND ${sSub} GROUP BY s.branch_id
           UNION ALL
           SELECT u.branch_id, MIN(e.created_at) FROM entries e JOIN users u ON u.id = e.student_id
             WHERE e.status IN ('pending', 'assigned', 'in_review') AND e.competition_id IS NULL AND e.event_id IS NULL AND ${sUser}
             GROUP BY u.branch_id
         ) x GROUP BY x.bid`, v),
      pool.query(
        `SELECT m.branch_id AS bid, COUNT(DISTINCT m.student_id) AS students, SUM(m.points) AS points
           FROM merit_ledger m
          WHERE m.status = 'pending' AND m.earned_month <= ${monthP} AND ${sMerit}
          GROUP BY m.branch_id`, v),
      pool.query(
        `SELECT c.id AS course_id, c.code, c.title, l.code AS level_code, l.order_index
           FROM levels l JOIN courses c ON c.id = l.course_id
          WHERE c.structure_version = 2 AND c.status IN ${LIVE_COURSE} AND c.course_type = 'certification'
            AND l.status = 'published'
            AND EXISTS (SELECT 1 FROM level_steps st WHERE st.level_id = l.id AND st.status = 'published')
            AND NOT EXISTS (
              SELECT 1 FROM level_steps st JOIN step_types t ON t.type_key = st.step_type
               WHERE st.level_id = l.id AND st.status = 'published' AND t.gates_progress = 1)
            ${courseBranch}
          ORDER BY c.code, l.order_index`, v),
      Promise.all(branchRows.map(async b => [b.id, await getEffectivePolicies(b.id)] as const)),
    ]);

    const policyBy = new Map(policies);
    const global: Partial<Record<string, unknown>> = (branchId ? policyBy.get(branchId) : null) ?? await getEffectivePolicies(null);
    const oldestBy = new Map<string, Date | null>(oldest.rows.map((r: any) => [String(r.bid), toDate(r.oldest)]));
    const meritBy = new Map<string, any>(merit.rows.map((r: any) => [String(r.bid), r]));
    const metricsBy = new Map(team.branches.map(b => [b.branchId, b]));

    // ---- teachers: full / away per branch ----
    const branchFacts: BranchFacts[] = [];
    const branches: AdminTodayBranch[] = [];
    let oldestWaitHours: number | null = null;
    for (const b of branchRows) {
      const m = metricsBy.get(b.id);
      const teachers = branchReviewers(reviewers.nodes, b.id);
      const away = teachers.filter(t => isAway(t, now)).length;
      const full = teachers.filter(t => !isAway(t, now) && t.openLoad >= t.threshold).length;
      const pol: Partial<Record<string, unknown>> = policyBy.get(b.id) ?? {};
      const officer = pol['merit.officer_user_id'];
      const meritRow = meritBy.get(b.id);
      const oldestAt = oldestBy.get(b.id) ?? null;
      if (oldestAt) {
        const hrs = Math.max(0, (now.getTime() - oldestAt.getTime()) / 3_600_000);
        oldestWaitHours = Math.max(oldestWaitHours ?? 0, Math.round(hrs * 10) / 10);
      }
      branchFacts.push({
        branchId: b.id, name: b.name,
        students: m?.students ?? 0, waiting: m?.pendingNow ?? 0, overdue: m?.overdueNow ?? 0,
        teachers: teachers.length, teachersFull: full, teachersAway: away,
        hasMeritOfficer: typeof officer === 'string' && officer.trim().length > 0,
        meritStudents: n(meritRow?.students),
      });
      branches.push({
        branchId: b.id, name: b.name,
        students: m?.students ?? 0, active30d: m?.active30d ?? 0,
        waiting: m?.pendingNow ?? 0, overdue: m?.overdueNow ?? 0,
        avgWaitHours: m?.avgWaitHours ?? null, answeredWithin72hPct: m?.answeredWithin72hPct ?? null,
        meritPending: n(meritRow?.students), teachersFull: full + away, teachers: teachers.length,
      });
    }

    // ---- students ----
    let needsPush = 0;
    let dormant = 0;
    let dormantToNudge = 0;
    for (const r of records) {
      if (r.segment === 'needs_push') needsPush += 1;
      if (r.segment === 'dormant') {
        dormant += 1;
        if (canNudge(r.lastNudgedAt ? new Date(r.lastNudgedAt) : null, now)) dormantToNudge += 1;
      }
    }

    // ---- courses ----
    const live = courses.filter(c => c.status === 'published' || c.status === 'held');
    const coursesMissingFiles: CourseGap[] = live
      .filter(c => c.counts.missing > 0)
      .map(c => ({ courseId: c.id, code: c.code, title: c.title, missing: c.counts.missing }));
    const draftCourses = courses.filter(c => c.status === 'draft').length;
    const levelsWithoutAssessment: LevelGap[] = noAssessment.rows.map((r: any) => ({
      courseId: String(r.course_id), code: r.code ?? null, title: String(r.title ?? ''),
      levelCode: r.level_code ? String(r.level_code) : `LV${String(n(r.order_index) + 1).padStart(2, '0')}`,
    }));

    const alerts = buildAlerts({
      isMaster: actor.isMaster,
      singleBranch: Boolean(branchId),
      monthLabel: monthName(month),
      monthEndSoon: isMonthEndSoon(zp.year, zp.month, zp.day),
      divertHours: positive(global['review.divert_after_hours'], 72),
      dormantDays: positive(global['nudge.dormant_days'], 180),
      branches: branchFacts,
      needsPush,
      dormantToNudge,
      coursesMissingFiles,
      levelsWithoutAssessment,
      draftCourses,
    });

    const body: AdminToday = {
      scope: { branchId, branchName: branchId ? branchRows[0]?.name ?? null : null, isMaster: actor.isMaster },
      counts: {
        waitingReview: branches.reduce((s, b) => s + b.waiting, 0),
        overdue72h: branches.reduce((s, b) => s + b.overdue, 0),
        oldestWaitHours,
        meritToGiveThisMonth: branches.reduce((s, b) => s + b.meritPending, 0),
        studentsNeedPush: needsPush,
        dormant,
        coursesWithMissingFiles: coursesMissingFiles.length,
        draftCourses,
      },
      alerts,
      branches,
      month,
      generatedAt: now.toISOString(),
    };
    return body;
  });
}
