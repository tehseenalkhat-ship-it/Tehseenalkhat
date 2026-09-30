import { pool } from '../db.js';
import { getSettingNumber } from '../settings.js';
import { findEligibleTeacher, retryPendingAssignment } from './entryRouting.js';
import { notify, notifyAllAdmins } from './notify.js';

/**
 * Three jobs, run together on a schedule (see server.ts):
 *
 * 1. Pending queue retry: entries that never got assigned at all (every
 *    same-branch teacher was at threshold) get retried every sweep — a
 *    same-branch teacher may have freed up. Only once an entry has been
 *    queued past the diversion window does it become eligible for another
 *    branch — same-branch is always preferred, at every stage.
 *
 * 2. Auto-diversion: an entry sitting 'assigned' (never opened) past the
 *    diversion window moves to a different teacher — same-branch first,
 *    other branches only if same-branch has nobody eligible.
 *
 * 3. Idle-flag: an entry a teacher has LOCKED ('in_review') for longer than
 *    the diversion window plus a grace period gets flagged for admin
 *    attention. It is never auto-unlocked or reassigned — a locked entry
 *    always stays with the teacher who opened it until admin steps in
 *    manually. Two teachers must never review the same entry, so we flag
 *    rather than silently take it away.
 */
export async function runDiversionAndIdleFlagSweep(): Promise<{
  pendingAssigned: number;
  diverted: number;
  idleFlagged: number;
}> {
  const diversionWindowDays = await getSettingNumber('checkpoint_diversion_window_days', 2);
  const graceDays = await getSettingNumber('idle_flag_grace_period_days', 1);

  let pendingAssigned = 0;
  let diverted = 0;
  let idleFlagged = 0;

  // --- 1. Retry the pending queue ---
  const { rows: pending } = await pool.query(
    `SELECT id, created_at < now() - ($1 || ' days')::interval AS past_window
     FROM entries WHERE status = 'pending'`,
    [diversionWindowDays]
  );
  for (const entry of pending) {
    const result = await retryPendingAssignment(entry.id, entry.past_window);
    if (result === 'assigned') pendingAssigned++;
  }

  // --- 2. Auto-diversion of overdue-but-already-assigned entries ---
  const { rows: overdue } = await pool.query(
    `SELECT id, assigned_teacher_id, level_id
     FROM entries
     WHERE status = 'assigned'
       AND created_at < now() - ($1 || ' days')::interval`,
    [diversionWindowDays]
  );

  for (const entry of overdue) {
    const { rows: courseRows } = await pool.query(
      `SELECT c.khat_type_id, u.branch_id AS student_branch_id
       FROM entries e
       JOIN levels l ON l.id = e.level_id
       JOIN courses c ON c.id = l.course_id
       JOIN users u ON u.id = e.student_id
       WHERE e.id = $1`,
      [entry.id]
    );
    const khatTypeId = courseRows[0]?.khat_type_id;
    const studentBranchId = courseRows[0]?.student_branch_id;
    if (!khatTypeId) continue;

    // Same-branch first, excluding the teacher who just timed out — only
    // fall back to any-branch if same-branch genuinely has nobody eligible.
    let newTeacherId = await findEligibleTeacher(khatTypeId, {
      branchId: studentBranchId,
      excludeTeacherId: entry.assigned_teacher_id,
    });
    let crossBranch = false;
    if (!newTeacherId) {
      newTeacherId = await findEligibleTeacher(khatTypeId, { excludeTeacherId: entry.assigned_teacher_id });
      crossBranch = true;
    }
    if (!newTeacherId) continue; // nobody else eligible anywhere right now — stays put, visible via entry_logs

    await pool.query(
      `UPDATE entries SET assigned_teacher_id = $1, is_diverted = true, diversion_reason = $2 WHERE id = $3`,
      [
        newTeacherId,
        `Auto-diverted after ${diversionWindowDays}-day timeout${crossBranch ? ' (same-branch was full)' : ''}`,
        entry.id,
      ]
    );
    await pool.query(`INSERT INTO entry_logs (entry_id, action, notes) VALUES ($1, 'auto_diverted', $2)`, [
      entry.id,
      `From ${entry.assigned_teacher_id} to ${newTeacherId} after ${diversionWindowDays} days unopened${crossBranch ? ' — diverted cross-branch' : ' — same branch'}`,
    ]);
    await notify(newTeacherId, 'new_entry_to_check', { entryId: entry.id, diverted: true });
    await notifyAllAdmins('entry_auto_diverted', { entryId: entry.id, toTeacherId: newTeacherId, crossBranch });
    diverted++;
  }

  // --- 3. Idle-flag ---
  const { rows: idleRows } = await pool.query(
    `UPDATE entries
     SET idle_flagged = true
     WHERE status = 'in_review'
       AND idle_flagged = false
       AND locked_at < now() - (($1 + $2) || ' days')::interval
     RETURNING id, assigned_teacher_id`,
    [diversionWindowDays, graceDays]
  );
  idleFlagged = idleRows.length;

  for (const entry of idleRows) {
    await pool.query(`INSERT INTO entry_logs (entry_id, action, notes) VALUES ($1, 'idle_flagged', $2)`, [
      entry.id,
      'Locked without a decision past the grace period',
    ]);
    await notifyAllAdmins('entry_idle_flagged', { entryId: entry.id, teacherId: entry.assigned_teacher_id });
  }

  return { pendingAssigned, diverted, idleFlagged };
}
