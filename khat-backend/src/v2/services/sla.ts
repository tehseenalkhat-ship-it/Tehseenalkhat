// owner: teacher (v3; was backend-review) — 72 h divert → forward, 96 h automatic mark
//
// v3: the automatic mark is sent in the ASSIGNED TEACHER's name with a warm, human message
// (autoMarkMessage) and is PROVISIONAL: it stays in that teacher's inbox as "Confirm automatic mark"
// (one tap to confirm or change) and does not unlock the next level until confirmed.
//
// "Even if a teacher is busy, if he can give just 6, 5, 4 marks it will mean a lot to the student."
//  - unanswered for review.divert_after_hours → another teacher of the same branch (least loaded,
//    never one who already held it); nobody left → the master team (Nairobi).
//  - still open after review.auto_mark_after_days (and review.auto_mark_enabled) → automatic mark:
//    student's own average, else branch average for the step, never below the lowest pass mark,
//    warm template comment, shown as from the course team. auto_marked = 1 (staff only).
// Every step is idempotent: rows are re-checked under FOR UPDATE and only open work is touched.
import { pool } from '../../db.js';
import type { EffectivePolicies } from '../contracts.js';
import { getEffectivePolicies } from '../lib/policies.js';
import { applyDecision, autoMarkMessage, bandForMark, chooseDivertTarget, computeAutoMark, isAway, normaliseBands, OPEN_STATUSES, slaDecision } from '../lib/reviewLogic.js';
import {
  clockNow, insertAudit, loadReviewerNodes, loadStepContext, previousAssignees, toDate, withTransaction,
} from '../lib/threadData.js';
import { notifyStaffOfNewWork } from '../lib/threadNotify.js';

let running = false;

export async function runSlaSweep(): Promise<{ diverted: number; forwarded: number; autoMarked: number }> {
  const result = { diverted: 0, forwarded: 0, autoMarked: 0 };
  if (running) return result;
  running = true;
  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.status, s.branch_id, s.student_id, s.step_id, s.created_at, s.assigned_at, s.claimed_at, s.assigned_teacher_id, s.claimed_by, s.auto_marked,
              (SELECT MAX(tm.created_at) FROM thread_messages tm
                WHERE tm.student_id = s.student_id AND tm.step_id = s.step_id AND tm.sender_role IN ('teacher', 'admin')) AS last_staff_at
         FROM step_submissions s
        WHERE s.status IN ('submitted', 'in_review') AND COALESCE(s.auto_marked, 0) = 0
        ORDER BY s.created_at ASC
        LIMIT 3000`,
    );
    const policyCache = new Map<string, EffectivePolicies>();
    const policiesFor = async (branchId: string) => {
      let p = policyCache.get(branchId);
      if (!p) { p = await getEffectivePolicies(branchId); policyCache.set(branchId, p); }
      return p;
    };

    const now = new Date();
    const { nodes } = await loadReviewerNodes();
    const away = new Set(nodes.filter(n => isAway(n, now)).map(n => n.id));
    for (const row of rows) {
      try {
        const policies = await policiesFor(row.branch_id);
        const action = slaDecision({
          status: row.status,
          createdAt: toDate(row.created_at) ?? now,
          assignedAt: toDate(row.assigned_at),
          claimedAt: toDate(row.claimed_at),
          lastStaffActivityAt: toDate(row.last_staff_at),
          assigneeAway: Boolean(row.assigned_teacher_id && away.has(row.assigned_teacher_id)),
          now,
          divertAfterHours: Number(policies['review.divert_after_hours']),
          autoMarkEnabled: policies['review.auto_mark_enabled'] !== false,
          autoMarkAfterDays: Number(policies['review.auto_mark_after_days']),
        });
        if (action === 'auto_mark') {
          if (await autoMark(row, policies)) result.autoMarked++;
        } else if (action === 'divert') {
          const moved = await divert(row.id, policies);
          if (moved === 'diverted') result.diverted++;
          else if (moved === 'forwarded') result.forwarded++;
        }
      } catch (error) {
        console.error(`[v2 SLA] submission ${row.id} failed`, error);
      }
    }
  } finally {
    running = false;
  }
  return result;
}

async function autoMark(row: any, policies: EffectivePolicies): Promise<boolean> {
  const bands = normaliseBands(policies['assessment.bands']);
  const [own, branch] = await Promise.all([
    pool.query(
      `SELECT AVG(mark) AS avg_mark FROM step_submissions
        WHERE student_id = $1 AND mark IS NOT NULL AND auto_marked = 0 AND id <> $2`,
      [row.student_id, row.id],
    ),
    pool.query(
      `SELECT AVG(mark) AS avg_mark FROM step_submissions
        WHERE branch_id = $1 AND step_id = $2 AND mark IS NOT NULL AND auto_marked = 0`,
      [row.branch_id, row.step_id],
    ),
  ]);
  const num = (v: unknown) => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));
  const mark = computeAutoMark({ studentAverage: num(own.rows[0]?.avg_mark), branchStepAverage: num(branch.rows[0]?.avg_mark), bands });
  const teacherId: string | null = row.claimed_by ?? row.assigned_teacher_id ?? null;
  const { rows: people } = await pool.query(
    `SELECT id, name FROM users WHERE id IN ($1, $2)`,
    [row.student_id, teacherId ?? row.student_id],
  );
  const nameOf = (id: string | null) => (id ? people.find((p: any) => p.id === id)?.name ?? null : null);
  const comment = autoMarkMessage({ studentName: nameOf(row.student_id), teacherName: nameOf(teacherId), band: bandForMark(mark, bands), seed: row.id });
  const after = await applyDecision(row.id, { mark, comment }, { id: null, name: nameOf(teacherId) ?? 'Your teacher', role: 'teacher', auto: true, asTeacherId: teacherId });
  return after.autoMarked;
}

async function divert(submissionId: string, _policies: EffectivePolicies): Promise<'diverted' | 'forwarded' | 'none'> {
  const outcome = await withTransaction(async client => {
    const { rows } = await client.query(`SELECT * FROM step_submissions WHERE id = $1 FOR UPDATE`, [submissionId]);
    const sub = rows[0];
    if (!sub || !OPEN_STATUSES.includes(sub.status)) return null;
    const exclude = await previousAssignees(submissionId, [sub.assigned_teacher_id, sub.claimed_by], client);
    const { nodes } = await loadReviewerNodes(client);
    const choice = chooseDivertTarget(nodes, { currentId: sub.assigned_teacher_id, branchId: sub.branch_id, exclude, now: new Date() });
    const next = choice.teacherId;
    const reason: 'diverted' | 'forwarded' = choice.reason === 'forwarded' ? 'forwarded' : 'diverted';
    if (!next) return null; // nobody new anywhere — the 7-day automatic mark will still answer the student
    const now = clockNow();
    await client.query(
      `UPDATE step_submissions
          SET assigned_teacher_id = $1, assigned_at = $2, status = 'submitted', claimed_by = NULL, claimed_at = NULL,
              diverted_count = diverted_count + 1
        WHERE id = $3`,
      [next, now, submissionId],
    );
    await insertAudit(client, {
      actorId: null, branchId: sub.branch_id,
      action: reason === 'diverted' ? 'submission.divert' : 'submission.forward',
      entityType: 'submission', entityId: submissionId,
      summary: reason === 'diverted'
        ? 'No reply in time — passed to another teacher of the branch'
        : 'No other teacher free in the branch — passed on through the spill-over list / master team',
      before: { teacherId: sub.assigned_teacher_id, claimedBy: sub.claimed_by, status: sub.status },
      after: { teacherId: next, reason },
    });
    return { next, reason, sub };
  });
  if (!outcome) return 'none';

  const ctx = await loadStepContext(outcome.sub.step_id);
  const { rows: s } = await pool.query(`SELECT name FROM users WHERE id = $1`, [outcome.sub.student_id]);
  await notifyStaffOfNewWork({
    teacherId: outcome.next,
    branchId: outcome.sub.branch_id,
    studentName: s[0]?.name ?? 'A student',
    stepLabel: ctx ? `${ctx.courseLabelShort} ${ctx.levelCode} ${ctx.code}` : 'a step',
    submissionId,
    printCode: outcome.sub.print_code ?? '',
    reason: outcome.reason,
  });
  return outcome.reason;
}
