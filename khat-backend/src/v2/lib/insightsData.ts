/**
 * Insights — database side. Every figure is aggregated in SQL with GROUP BY
 * (one round of ~7 queries per request, never one query per student), then
 * combined by the pure functions in insightsLogic.ts.
 * owner: insights
 */
import { pool } from '../../db.js';
import { getEffectivePolicies } from './policies.js';
import type { BranchMetrics, StudentInsight, StudentSegment, TeamMember } from '../contracts.js';
import { friendlyLevel,
  DAY_MS, HOUR_MS, buildBranchMetrics, buildTeamMembers, daysBetween, latestDate, segmentConfigFrom,
  segmentStudent, toDate, averageMark, type BranchRaw, type SegmentConfig, type StudentFacts, type TeacherRaw,
} from './insightsLogic.js';

/** Collects positional parameters for the $n placeholders understood by db.ts. */
export class SqlParams {
  values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
  list(items: unknown[]): string {
    return items.map(item => this.add(item)).join(', ');
  }
}

const n = (value: unknown): number => {
  const x = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(x) ? x : 0;
};

export type StudentScope = { branchId?: string | null; studentIds?: string[] | null };

/** One student with facts + segment, plus what the nudge code needs (email). */
export type StudentRecord = StudentInsight & { email: string; idleDays: number | null };

function levelLabel(code: unknown, orderIndex: unknown): string | null {
  // v3 audit 22: "Level 2", never "LV02"
  return friendlyLevel(code, orderIndex === null || orderIndex === undefined ? null : n(orderIndex));
}

/** Segment config per branch (policies may be overridden by a branch). */
export async function segmentConfigs(branchIds: string[]): Promise<Map<string, SegmentConfig>> {
  const out = new Map<string, SegmentConfig>();
  await Promise.all([...new Set(branchIds)].map(async id => {
    out.set(id, segmentConfigFrom(await getEffectivePolicies(id)));
  }));
  return out;
}

/** Load and segment every student in scope. 700+ students per branch → 7 grouped queries in parallel. */
export async function loadStudentRecords(scope: StudentScope, now = new Date()): Promise<StudentRecord[]> {
  const p = new SqlParams();
  let uf = `u.role = 'student' AND u.deleted_at IS NULL`;
  if (scope.branchId) uf += ` AND u.branch_id = ${p.add(scope.branchId)}`;
  if (scope.studentIds) {
    if (!scope.studentIds.length) return [];
    uf += ` AND u.id IN (${p.list(scope.studentIds)})`;
  }
  const params = p.values;

  const [users, activity, v2Work, legacyWork, levels, v2Place, legacyPlace, nudges] = await Promise.all([
    pool.query(
      `SELECT u.id, u.name, u.email, u.tr_number, u.class_name, u.branch_id, b.name AS branch_name, u.created_at
       FROM users u LEFT JOIN branches b ON b.id = u.branch_id
       WHERE ${uf}`,
      params,
    ),
    // Latest sign of life from every source (each branch pre-aggregated).
    pool.query(
      `SELECT x.sid, MAX(x.t) AS last_at FROM (
         SELECT a.user_id AS sid, MAX(CAST(a.activity_date AS DATETIME)) AS t FROM activity_log a JOIN users u ON u.id = a.user_id WHERE ${uf} GROUP BY a.user_id
         UNION ALL SELECT p.student_id, MAX(p.done_at) FROM step_progress p JOIN users u ON u.id = p.student_id WHERE ${uf} GROUP BY p.student_id
         UNION ALL SELECT s.student_id, MAX(s.created_at) FROM step_submissions s JOIN users u ON u.id = s.student_id WHERE ${uf} GROUP BY s.student_id
         UNION ALL SELECT m.sender_id, MAX(m.created_at) FROM thread_messages m JOIN users u ON u.id = m.sender_id WHERE m.sender_role = 'student' AND ${uf} GROUP BY m.sender_id
         UNION ALL SELECT g.sender_id, MAX(g.created_at) FROM group_messages g JOIN users u ON u.id = g.sender_id WHERE ${uf} GROUP BY g.sender_id
         UNION ALL SELECT e.student_id, MAX(e.created_at) FROM entries e JOIN users u ON u.id = e.student_id WHERE ${uf} GROUP BY e.student_id
         UNION ALL SELECT ls.student_id, MAX(ls.submitted_at) FROM level_submissions ls JOIN users u ON u.id = ls.student_id WHERE ${uf} GROUP BY ls.student_id
         UNION ALL SELECT en.student_id, MAX(en.enrolled_at) FROM enrollments en JOIN users u ON u.id = en.student_id WHERE ${uf} GROUP BY en.student_id
       ) x GROUP BY x.sid`,
      params,
    ),
    // v2 submissions: marks, open revisions (latest attempt only), pending, attempts.
    pool.query(
      `SELECT s.student_id AS sid, COUNT(*) AS subs,
              COALESCE(SUM(s.mark), 0) AS mark_sum, COUNT(s.mark) AS mark_count,
              SUM(CASE WHEN s.status IN ('submitted', 'in_review') THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN s.status = 'revision' AND s.attempt_no = lt.max_attempt THEN 1 ELSE 0 END) AS open_revisions,
              MAX(s.attempt_no) AS max_attempts
       FROM step_submissions s
       JOIN users u ON u.id = s.student_id
       JOIN (
         SELECT s2.student_id, s2.step_id, MAX(s2.attempt_no) AS max_attempt
         FROM step_submissions s2 JOIN users u ON u.id = s2.student_id
         WHERE ${uf} GROUP BY s2.student_id, s2.step_id
       ) lt ON lt.student_id = s.student_id AND lt.step_id = s.step_id
       WHERE ${uf}
       GROUP BY s.student_id`,
      params,
    ),
    // Legacy entries (course work only, not competitions / events).
    pool.query(
      `SELECT e.student_id AS sid, COUNT(*) AS subs,
              COALESCE(SUM(e.mark_out_of_ten), 0) AS mark_sum, COUNT(e.mark_out_of_ten) AS mark_count,
              SUM(CASE WHEN e.status IN ('pending', 'assigned', 'in_review') THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN e.status = 'redo_needed' AND NOT EXISTS (SELECT 1 FROM entries r WHERE r.redo_of_entry_id = e.id) THEN 1 ELSE 0 END) AS open_revisions
       FROM entries e JOIN users u ON u.id = e.student_id
       WHERE e.competition_id IS NULL AND e.event_id IS NULL AND ${uf}
       GROUP BY e.student_id`,
      params,
    ),
    // Levels passed: v2 level badges + legacy current level index; legacy practice uploads count as work.
    pool.query(
      `SELECT 'badge' AS kind, sb.student_id AS sid, COUNT(*) AS total FROM student_badges sb JOIN users u ON u.id = sb.student_id
         WHERE sb.kind = 'level' AND ${uf} GROUP BY sb.student_id
       UNION ALL
       SELECT 'legacy', en.student_id, SUM(en.current_level_index) FROM enrollments en JOIN courses c ON c.id = en.course_id JOIN users u ON u.id = en.student_id
         WHERE c.structure_version = 1 AND ${uf} GROUP BY en.student_id
       UNION ALL
       SELECT 'practice', ls.student_id, COUNT(*) FROM level_submissions ls JOIN users u ON u.id = ls.student_id
         WHERE ${uf} GROUP BY ls.student_id`,
      params,
    ),
    // Where the student is now (v2): the course / level of their latest step activity.
    pool.query(
      `SELECT y.sid, c.code AS course_code, c.title AS course_title, l.code AS level_code, l.order_index AS level_index
       FROM (
         SELECT x.sid, x.course_id, x.level_id, ROW_NUMBER() OVER (PARTITION BY x.sid ORDER BY x.t DESC) AS rn
         FROM (
           SELECT s.student_id AS sid, s.course_id, s.level_id, s.created_at AS t FROM step_submissions s JOIN users u ON u.id = s.student_id WHERE ${uf}
           UNION ALL
           SELECT p.student_id, st.course_id, st.level_id, p.done_at FROM step_progress p JOIN level_steps st ON st.id = p.step_id JOIN users u ON u.id = p.student_id WHERE ${uf}
         ) x
       ) y
       JOIN courses c ON c.id = y.course_id
       LEFT JOIN levels l ON l.id = y.level_id
       WHERE y.rn = 1`,
      params,
    ),
    // Fallback (legacy): latest enrollment and its current level.
    pool.query(
      `SELECT y.sid, c.code AS course_code, c.title AS course_title, l.code AS level_code, y.idx AS level_index
       FROM (
         SELECT en.student_id AS sid, en.course_id, en.current_level_index AS idx,
                ROW_NUMBER() OVER (PARTITION BY en.student_id ORDER BY en.enrolled_at DESC) AS rn
         FROM enrollments en JOIN users u ON u.id = en.student_id
         WHERE ${uf}
       ) y
       JOIN courses c ON c.id = y.course_id
       LEFT JOIN levels l ON l.course_id = y.course_id AND l.order_index = y.idx
       WHERE y.rn = 1`,
      params,
    ),
    pool.query(
      `SELECT sn.student_id AS sid, MAX(sn.created_at) AS last_at
       FROM student_nudges sn JOIN users u ON u.id = sn.student_id
       WHERE ${uf} GROUP BY sn.student_id`,
      params,
    ),
  ]);

  const byId = <T>(rows: any[], map: (row: any) => T) => new Map<string, T>(rows.map(row => [String(row.sid), map(row)]));
  const lastActive = byId(activity.rows, row => toDate(row.last_at));
  const v2 = byId(v2Work.rows, row => row);
  const legacy = byId(legacyWork.rows, row => row);
  const placeV2 = byId(v2Place.rows, row => row);
  const placeLegacy = byId(legacyPlace.rows, row => row);
  const nudged = byId(nudges.rows, row => toDate(row.last_at));
  const levelRows = new Map<string, { badge: number; legacy: number; practice: number }>();
  for (const row of levels.rows) {
    const entry = levelRows.get(String(row.sid)) ?? { badge: 0, legacy: 0, practice: 0 };
    entry[row.kind as 'badge' | 'legacy' | 'practice'] = n(row.total);
    levelRows.set(String(row.sid), entry);
  }

  const configs = await segmentConfigs(users.rows.map((row: any) => String(row.branch_id)));

  return users.rows.map((u: any): StudentRecord => {
    const id = String(u.id);
    const a = v2.get(id);
    const b = legacy.get(id);
    const lv = levelRows.get(id) ?? { badge: 0, legacy: 0, practice: 0 };
    const place = placeV2.get(id) ?? placeLegacy.get(id) ?? null;
    const joinedAt = toDate(u.created_at);
    const facts: StudentFacts = {
      joinedAt,
      lastActiveAt: latestDate(lastActive.get(id)),
      submissions: n(a?.subs) + n(b?.subs) + lv.practice,
      markSum: n(a?.mark_sum) + n(b?.mark_sum),
      markCount: n(a?.mark_count) + n(b?.mark_count),
      openRevisions: n(a?.open_revisions) + n(b?.open_revisions),
      pendingReviews: n(a?.pending) + n(b?.pending),
      maxAttempts: n(a?.max_attempts),
      courseCode: place?.course_code ?? null,
      courseTitle: place?.course_title ?? null,
      currentLevel: place ? levelLabel(place.level_code, place.level_index) : null,
    };
    const cfg = configs.get(String(u.branch_id)) ?? segmentConfigFrom({});
    const { segment, reason } = segmentStudent(facts, cfg, now);
    const idleFrom = facts.lastActiveAt ?? joinedAt;
    return {
      studentId: id,
      name: String(u.name ?? ''),
      email: String(u.email ?? ''),
      trNumber: u.tr_number ?? null,
      className: u.class_name ?? null,
      branchId: String(u.branch_id),
      branchName: u.branch_name ?? null,
      segment,
      reason,
      courseCode: facts.courseCode,
      courseTitle: facts.courseTitle,
      currentLevel: facts.currentLevel,
      levelsPassed: lv.badge + lv.legacy,
      avgMark: averageMark(facts),
      revisions: facts.openRevisions,
      pendingReviews: facts.pendingReviews,
      lastActiveAt: facts.lastActiveAt ? facts.lastActiveAt.toISOString() : null,
      lastNudgedAt: nudged.get(id)?.toISOString() ?? null,
      idleDays: idleFrom ? daysBetween(idleFrom, now) : null,
    };
  });
}

export function toInsight(record: StudentRecord): StudentInsight {
  const { email: _email, idleDays: _idle, ...insight } = record;
  return insight;
}

export function matchesQuery(record: StudentInsight, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [record.name, record.trNumber, record.className, record.courseCode, record.courseTitle]
    .some(value => typeof value === 'string' && value.toLowerCase().includes(needle));
}

export const SEGMENTS: StudentSegment[] = ['doing_well', 'needs_encouragement', 'needs_push', 'dormant', 'new'];

// ---------------------------------------------------------------------------
// Team self-assessment
// ---------------------------------------------------------------------------

export async function loadTeamReport(branchId: string | null, days: number, now = new Date()): Promise<{ branches: BranchMetrics[]; team: TeamMember[] }> {
  const branchRows = (await pool.query(
    branchId ? `SELECT id, name FROM branches WHERE id = $1` : `SELECT id, name FROM branches ORDER BY name`,
    branchId ? [branchId] : [],
  )).rows as { id: string; name: string }[];
  if (!branchRows.length) return { branches: [], team: [] };

  // Overdue threshold (review.divert_after_hours) per branch, as a tiny derived table.
  const divertHours = new Map<string, number>();
  await Promise.all(branchRows.map(async b => {
    const value = Number((await getEffectivePolicies(b.id))['review.divert_after_hours']);
    divertHours.set(b.id, Number.isFinite(value) && value > 0 ? value : 72);
  }));

  const p = new SqlParams();
  const cut = p.add(new Date(now.getTime() - days * DAY_MS));
  const nowP = p.add(now);
  const cut72 = p.add(new Date(now.getTime() - 72 * HOUR_MS));
  const th = `(${branchRows.map(b => `SELECT ${p.add(b.id)} AS bid, ${p.add(divertHours.get(b.id) ?? 72)} AS hrs`).join(' UNION ALL ')})`;
  const scope = (col: string) => (branchId ? `${col} = ${p.add(branchId)}` : '1 = 1');
  // Build every scope fragment up-front so all queries share one parameter list.
  const sUsers = scope('u.branch_id');
  const sSub = scope('s.branch_id');
  const sStudent = scope('su.branch_id');
  const v = p.values;

  const [people, active, v2Branch, legacyBranch, levelsPassed, teachers, v2Teacher, legacyTeacher, v2Load, legacyLoad, divertV2, divertLegacy] = await Promise.all([
    pool.query(
      `SELECT u.branch_id AS bid,
              SUM(CASE WHEN u.role = 'student' THEN 1 ELSE 0 END) AS students,
              SUM(CASE WHEN u.role = 'teacher' THEN 1 ELSE 0 END) AS teachers
       FROM users u WHERE u.deleted_at IS NULL AND ${sUsers} GROUP BY u.branch_id`, v),
    pool.query(
      `SELECT u.branch_id AS bid, COUNT(DISTINCT x.sid) AS active FROM (
         SELECT a.user_id AS sid FROM activity_log a WHERE a.activity_date >= DATE(${cut})
         UNION SELECT p.student_id FROM step_progress p WHERE p.done_at >= ${cut}
         UNION SELECT s.student_id FROM step_submissions s WHERE s.created_at >= ${cut}
         UNION SELECT m.sender_id FROM thread_messages m WHERE m.sender_role = 'student' AND m.created_at >= ${cut}
         UNION SELECT g.sender_id FROM group_messages g WHERE g.created_at >= ${cut}
         UNION SELECT e.student_id FROM entries e WHERE e.created_at >= ${cut}
         UNION SELECT ls.student_id FROM level_submissions ls WHERE ls.submitted_at >= ${cut}
       ) x JOIN users u ON u.id = x.sid
       WHERE u.role = 'student' AND u.deleted_at IS NULL AND ${sUsers}
       GROUP BY u.branch_id`, v),
    pool.query(
      `SELECT s.branch_id AS bid,
              SUM(CASE WHEN s.created_at >= ${cut} THEN 1 ELSE 0 END) AS subs,
              SUM(CASE WHEN s.created_at >= ${cut} AND (COALESCE(s.first_response_at, s.reviewed_at) IS NOT NULL OR s.created_at < ${cut72}) THEN 1 ELSE 0 END) AS judged,
              SUM(CASE WHEN s.created_at >= ${cut} AND COALESCE(s.first_response_at, s.reviewed_at) IS NOT NULL
                        AND TIMESTAMPDIFF(SECOND, s.created_at, COALESCE(s.first_response_at, s.reviewed_at)) <= 259200 THEN 1 ELSE 0 END) AS within72,
              SUM(CASE WHEN s.created_at >= ${cut} THEN GREATEST(0, TIMESTAMPDIFF(SECOND, s.created_at, COALESCE(s.first_response_at, s.reviewed_at, ${nowP}))) ELSE 0 END) AS wait_seconds,
              SUM(CASE WHEN s.status IN ('submitted', 'in_review') THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN s.status IN ('submitted', 'in_review') AND TIMESTAMPDIFF(HOUR, s.created_at, ${nowP}) >= COALESCE(th.hrs, 72) THEN 1 ELSE 0 END) AS overdue,
              SUM(CASE WHEN s.auto_marked = 1 AND s.reviewed_at >= ${cut} THEN 1 ELSE 0 END) AS auto_marked,
              SUM(CASE WHEN s.auto_marked = 0 AND s.reviewed_by IS NOT NULL AND s.reviewed_at >= ${cut} THEN 1 ELSE 0 END) AS reviews
       FROM step_submissions s LEFT JOIN ${th} th ON th.bid = s.branch_id
       WHERE (s.created_at >= ${cut} OR s.reviewed_at >= ${cut} OR s.status IN ('submitted', 'in_review')) AND ${sSub}
       GROUP BY s.branch_id`, v),
    pool.query(
      `SELECT u.branch_id AS bid,
              SUM(CASE WHEN e.created_at >= ${cut} THEN 1 ELSE 0 END) AS subs,
              SUM(CASE WHEN e.created_at >= ${cut} AND (e.reviewed_at IS NOT NULL OR e.created_at < ${cut72}) THEN 1 ELSE 0 END) AS judged,
              SUM(CASE WHEN e.created_at >= ${cut} AND e.reviewed_at IS NOT NULL AND TIMESTAMPDIFF(SECOND, e.created_at, e.reviewed_at) <= 259200 THEN 1 ELSE 0 END) AS within72,
              SUM(CASE WHEN e.created_at >= ${cut} THEN GREATEST(0, TIMESTAMPDIFF(SECOND, e.created_at, COALESCE(e.reviewed_at, ${nowP}))) ELSE 0 END) AS wait_seconds,
              SUM(CASE WHEN e.status IN ('pending', 'assigned', 'in_review') THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN e.status IN ('pending', 'assigned', 'in_review') AND TIMESTAMPDIFF(HOUR, e.created_at, ${nowP}) >= COALESCE(th.hrs, 72) THEN 1 ELSE 0 END) AS overdue,
              SUM(CASE WHEN e.reviewed_by IS NOT NULL AND e.reviewed_at >= ${cut} THEN 1 ELSE 0 END) AS reviews
       FROM entries e JOIN users u ON u.id = e.student_id LEFT JOIN ${th} th ON th.bid = u.branch_id
       WHERE e.competition_id IS NULL AND e.event_id IS NULL
         AND (e.created_at >= ${cut} OR e.reviewed_at >= ${cut} OR e.status IN ('pending', 'assigned', 'in_review'))
         AND ${sUsers}
       GROUP BY u.branch_id`, v),
    pool.query(
      `SELECT x.bid, SUM(x.total) AS total FROM (
         SELECT u.branch_id AS bid, COUNT(*) AS total FROM student_badges sb JOIN users u ON u.id = sb.student_id
           WHERE sb.kind = 'level' AND sb.awarded_at >= ${cut} AND ${sUsers} GROUP BY u.branch_id
         UNION ALL
         SELECT u.branch_id, COUNT(*) FROM entries e JOIN users u ON u.id = e.student_id
           WHERE e.entry_kind = 'checkpoint_assessment' AND e.status = 'reviewed' AND e.reviewed_at >= ${cut} AND ${sUsers} GROUP BY u.branch_id
       ) x GROUP BY x.bid`, v),
    // Team = teachers of the branch(es) + anyone who answered this scope's work in the window.
    pool.query(
      `SELECT u.id, u.name, u.branch_id, b.name AS branch_name FROM users u LEFT JOIN branches b ON b.id = u.branch_id
       WHERE u.deleted_at IS NULL AND (
         (u.role = 'teacher' AND ${sUsers})
         OR u.id IN (SELECT s.reviewed_by FROM step_submissions s WHERE s.reviewed_at >= ${cut} AND s.auto_marked = 0 AND ${sSub})
         OR u.id IN (SELECT e.reviewed_by FROM entries e JOIN users su ON su.id = e.student_id WHERE e.reviewed_at >= ${cut} AND ${sStudent})
       )`, v),
    pool.query(
      `SELECT s.reviewed_by AS tid, COUNT(*) AS reviewed,
              SUM(CASE WHEN s.branch_id = rv.branch_id THEN 1 ELSE 0 END) AS home,
              SUM(GREATEST(0, TIMESTAMPDIFF(SECOND, COALESCE(s.assigned_at, s.created_at), COALESCE(s.first_response_at, s.reviewed_at)))) AS resp_seconds
       FROM step_submissions s JOIN users rv ON rv.id = s.reviewed_by
       WHERE s.reviewed_at >= ${cut} AND s.auto_marked = 0 AND ${sSub}
       GROUP BY s.reviewed_by`, v),
    pool.query(
      `SELECT e.reviewed_by AS tid, COUNT(*) AS reviewed,
              SUM(CASE WHEN u.branch_id = rv.branch_id THEN 1 ELSE 0 END) AS home,
              SUM(GREATEST(0, TIMESTAMPDIFF(SECOND, e.created_at, e.reviewed_at))) AS resp_seconds
       FROM entries e JOIN users u ON u.id = e.student_id JOIN users rv ON rv.id = e.reviewed_by
       WHERE e.reviewed_at >= ${cut} AND e.competition_id IS NULL AND e.event_id IS NULL AND ${sUsers}
       GROUP BY e.reviewed_by`, v),
    pool.query(
      `SELECT s.assigned_teacher_id AS tid,
              SUM(CASE WHEN s.status IN ('submitted', 'in_review') THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN s.status IN ('submitted', 'in_review') AND TIMESTAMPDIFF(HOUR, COALESCE(s.assigned_at, s.created_at), ${nowP}) >= COALESCE(th.hrs, 72) THEN 1 ELSE 0 END) AS overdue,
              SUM(CASE WHEN s.auto_marked = 1 AND s.reviewed_at >= ${cut} THEN 1 ELSE 0 END) AS auto_marked
       FROM step_submissions s LEFT JOIN ${th} th ON th.bid = s.branch_id
       WHERE s.assigned_teacher_id IS NOT NULL AND (s.status IN ('submitted', 'in_review') OR (s.auto_marked = 1 AND s.reviewed_at >= ${cut})) AND ${sSub}
       GROUP BY s.assigned_teacher_id`, v),
    pool.query(
      `SELECT e.assigned_teacher_id AS tid, COUNT(*) AS pending,
              SUM(CASE WHEN TIMESTAMPDIFF(HOUR, e.created_at, ${nowP}) >= COALESCE(th.hrs, 72) THEN 1 ELSE 0 END) AS overdue
       FROM entries e JOIN users u ON u.id = e.student_id LEFT JOIN ${th} th ON th.bid = u.branch_id
       WHERE e.assigned_teacher_id IS NOT NULL AND e.status IN ('pending', 'assigned', 'in_review') AND ${sUsers}
       GROUP BY e.assigned_teacher_id`, v),
    // v2 diversions are written to audit_log by the SLA sweep (before_json carries the previous teacher).
    pool.query(
      `SELECT x.tid, COUNT(*) AS total FROM (
         SELECT COALESCE(
                  JSON_UNQUOTE(JSON_EXTRACT(a.before_json, '$.teacherId')),
                  JSON_UNQUOTE(JSON_EXTRACT(a.before_json, '$.assignedTeacherId')),
                  JSON_UNQUOTE(JSON_EXTRACT(a.before_json, '$.assigned_teacher_id')),
                  JSON_UNQUOTE(JSON_EXTRACT(a.before_json, '$.fromTeacherId'))) AS tid
         FROM audit_log a
         WHERE a.entity_type = 'submission' AND (a.action LIKE '%divert%' OR a.action LIKE '%forward%') AND a.created_at >= ${cut}
       ) x WHERE x.tid IS NOT NULL GROUP BY x.tid`, v),
    // Legacy diversions: entry_logs notes look like "From <teacher uuid> to <uuid> after …".
    pool.query(
      `SELECT SUBSTRING(l.notes, 6, 36) AS tid, COUNT(*) AS total
       FROM entry_logs l
       WHERE l.action = 'auto_diverted' AND l.notes LIKE 'From %' AND l.created_at >= ${cut}
       GROUP BY SUBSTRING(l.notes, 6, 36)`, v),
  ]);

  const map = (rows: any[], key = 'bid') => new Map<string, any>(rows.map(row => [String(row[key]), row]));
  const peopleBy = map(people.rows);
  const activeBy = map(active.rows);
  const v2B = map(v2Branch.rows);
  const lgB = map(legacyBranch.rows);
  const lvB = map(levelsPassed.rows);

  const branchReviewTotals: Record<string, number> = {};
  const branches = branchRows.map(b => {
    const a = v2B.get(b.id);
    const l = lgB.get(b.id);
    branchReviewTotals[b.id] = n(a?.reviews) + n(l?.reviews);
    const raw: BranchRaw = {
      branchId: b.id,
      branchName: b.name,
      students: n(peopleBy.get(b.id)?.students),
      active: n(activeBy.get(b.id)?.active),
      teachers: n(peopleBy.get(b.id)?.teachers),
      submissions: n(a?.subs) + n(l?.subs),
      judged: n(a?.judged) + n(l?.judged),
      answeredWithin72h: n(a?.within72) + n(l?.within72),
      waitSeconds: n(a?.wait_seconds) + n(l?.wait_seconds),
      waitCount: n(a?.subs) + n(l?.subs),
      pendingNow: n(a?.pending) + n(l?.pending),
      overdueNow: n(a?.overdue) + n(l?.overdue),
      autoMarked: n(a?.auto_marked),
      levelsPassed: n(lvB.get(b.id)?.total),
    };
    return buildBranchMetrics(raw);
  });

  const v2T = map(v2Teacher.rows, 'tid');
  const lgT = map(legacyTeacher.rows, 'tid');
  const v2L = map(v2Load.rows, 'tid');
  const lgL = map(legacyLoad.rows, 'tid');
  const dv2 = map(divertV2.rows, 'tid');
  const dlg = map(divertLegacy.rows, 'tid');
  const teacherRows: TeacherRaw[] = teachers.rows.map((t: any) => {
    const id = String(t.id);
    const a = v2T.get(id);
    const l = lgT.get(id);
    return {
      teacherId: id,
      name: String(t.name ?? ''),
      branchId: t.branch_id ?? null,
      branchName: t.branch_name ?? null,
      reviewed: n(a?.reviewed) + n(l?.reviewed),
      reviewedHomeBranch: n(a?.home) + n(l?.home),
      responseSeconds: n(a?.resp_seconds) + n(l?.resp_seconds),
      responseCount: n(a?.reviewed) + n(l?.reviewed),
      pendingNow: n(v2L.get(id)?.pending) + n(lgL.get(id)?.pending),
      overdueNow: n(v2L.get(id)?.overdue) + n(lgL.get(id)?.overdue),
      divertedAway: n(dv2.get(id)?.total) + n(dlg.get(id)?.total),
      autoMarked: n(v2L.get(id)?.auto_marked),
    };
  });

  return { branches, team: buildTeamMembers(teacherRows, branchReviewTotals) };
}
