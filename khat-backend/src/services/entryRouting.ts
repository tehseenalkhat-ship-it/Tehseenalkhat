import { pool } from '../db.js';
import { notify, notifyAllAdmins } from './notify.js';

/**
 * Finds the least-loaded teacher assigned to `khatTypeId`, currently under
 * their own load threshold. Load is computed live from the entries table
 * (assigned + in_review count) rather than a stored counter, so it can never
 * drift out of sync.
 *
 * `branchId` narrows to teachers in that branch; omit it to search any branch.
 * `excludeTeacherId` is used on diversion, so we don't just hand it back to
 * the same teacher who already timed out or was manually diverted away from.
 */
export async function findEligibleTeacher(
  khatTypeId: string,
  opts: { branchId?: string; excludeTeacherId?: string } = {}
): Promise<string | null> {
  const conditions = [`u.role = 'teacher'`, `u.deleted_at IS NULL`, `tka.khat_type_id = $1`];
  const params: unknown[] = [khatTypeId];

  if (opts.branchId) {
    params.push(opts.branchId);
    conditions.push(`u.branch_id = $${params.length}`);
  }
  if (opts.excludeTeacherId) {
    params.push(opts.excludeTeacherId);
    conditions.push(`u.id != $${params.length}`);
  }

  const { rows } = await pool.query(
    `SELECT u.id, u.entry_load_threshold,
            COUNT(e.id) FILTER (WHERE e.status IN ('assigned', 'in_review')) AS current_load
     FROM users u
     JOIN teacher_khat_assignments tka ON tka.teacher_id = u.id
     LEFT JOIN entries e ON e.assigned_teacher_id = u.id AND e.status IN ('assigned', 'in_review')
     WHERE ${conditions.join(' AND ')}
     GROUP BY u.id, u.entry_load_threshold
     HAVING COUNT(e.id) FILTER (WHERE e.status IN ('assigned', 'in_review')) < u.entry_load_threshold
     ORDER BY current_load ASC
     LIMIT 1`,
    params
  );

  return rows[0]?.id ?? null;
}

async function loadEntryContext(entryId: string) {
  const { rows } = await pool.query(
    `SELECT en.id, en.student_id, en.level_id, l.course_id, c.khat_type_id, u.branch_id AS student_branch_id
     FROM entries en
     LEFT JOIN levels l ON l.id = en.level_id
     LEFT JOIN courses c ON c.id = l.course_id
     JOIN users u ON u.id = en.student_id
     WHERE en.id = $1`,
    [entryId]
  );
  return rows[0];
}

/**
 * Initial assignment attempt for a freshly-submitted entry: SAME BRANCH ONLY.
 * A Nairobi student's entry only ever goes to a Nairobi teacher at this stage
 * — if every eligible Nairobi teacher is at threshold, the entry stays
 * 'pending' in the queue rather than immediately spilling to another branch.
 * Cross-branch placement only happens later, via diversion (see below).
 */
export async function autoAssignEntry(entryId: string): Promise<void> {
  const entry = await loadEntryContext(entryId);
  if (!entry || !entry.khat_type_id) {
    // Event/competition entries without a course-derived khat type aren't
    // supported by this routing pass yet — left unassigned for admin to place.
    await pool.query('UPDATE entries SET status = $1 WHERE id = $2', ['pending', entryId]);
    return;
  }

  const teacherId = await findEligibleTeacher(entry.khat_type_id, { branchId: entry.student_branch_id });

  if (!teacherId) {
    await pool.query('UPDATE entries SET status = $1 WHERE id = $2', ['pending', entryId]);
    await pool.query(`INSERT INTO entry_logs (entry_id, action, notes) VALUES ($1, 'assigned', $2)`, [
      entryId,
      'No same-branch teacher under threshold — queued, will retry same-branch and consider other branches on the next sweep',
    ]);
    await notifyAllAdmins('entry_queued_unassigned', { entryId, branchId: entry.student_branch_id });
    return;
  }

  await pool.query('UPDATE entries SET status = $1, assigned_teacher_id = $2 WHERE id = $3', [
    'assigned',
    teacherId,
    entryId,
  ]);
  await pool.query(`INSERT INTO entry_logs (entry_id, action, actor_id, notes) VALUES ($1, 'assigned', $2, $3)`, [
    entryId,
    teacherId,
    'same-branch match',
  ]);
  await notify(teacherId, 'new_entry_to_check', { entryId });
}

/**
 * Used by the sweep (see diversionSweep.ts) for entries still sitting
 * 'pending'. Always retries same-branch first (a teacher may have freed up
 * since the last check). Only tries other branches if `allowAnyBranch` is
 * true — the sweep passes that once the entry has been queued past the
 * diversion window, matching "diversion stays same-branch first, other
 * branches only once that branch is genuinely full."
 */
export async function retryPendingAssignment(entryId: string, allowAnyBranch: boolean): Promise<'assigned' | 'still_pending'> {
  const entry = await loadEntryContext(entryId);
  if (!entry || !entry.khat_type_id) return 'still_pending';

  let teacherId = await findEligibleTeacher(entry.khat_type_id, { branchId: entry.student_branch_id });
  let diverted = false;

  if (!teacherId && allowAnyBranch) {
    teacherId = await findEligibleTeacher(entry.khat_type_id);
    diverted = true;
  }

  if (!teacherId) return 'still_pending';

  await pool.query(
    `UPDATE entries SET status = 'assigned', assigned_teacher_id = $1, is_diverted = $2,
       diversion_reason = COALESCE($3, diversion_reason)
     WHERE id = $4`,
    [teacherId, diverted, diverted ? 'Diverted to another branch — same-branch queue was full' : null, entryId]
  );
  await pool.query(`INSERT INTO entry_logs (entry_id, action, actor_id, notes) VALUES ($1, 'assigned', $2, $3)`, [
    entryId,
    teacherId,
    diverted ? 'any-branch match after same-branch queue overflow' : 'same-branch match (freed up on retry)',
  ]);
  await notify(teacherId, 'new_entry_to_check', { entryId });
  return 'assigned';
}

