// owner: admin-comms (v3) — remind the branch admin / merit officer each month (merit is given by BRANCH admins)
//
// On merit.reminder_day (default 25) and on the last day of the month (Africa/Nairobi),
// after 08:00, the branch's merit officer (policy merit.officer_user_id; if none, the
// branch admins) gets ONE in-app notification + email per reminder, only when there are
// points to give. Idempotent: an audit_log marker (entity_type 'merit_reminder',
// entity_id '<branchId>:<YYYY-MM>:<day|last>') is written before anything is sent.
import { randomUUID } from 'node:crypto';
import { pool } from '../../db.js';
import { getEffectivePolicies } from '../lib/policies.js';
import { meritReminderKindsDue, zonedParts } from '../lib/reviewLogic.js';
import { appLink, safeEmail, safeNotify } from '../lib/threadNotify.js';

const SEND_FROM_HOUR = 8;

export async function runMeritReminderSweep(): Promise<{ reminded: number }> {
  const now = new Date();
  const parts = zonedParts(now);
  if (parts.hour < SEND_FROM_HOUR) return { reminded: 0 };
  let reminded = 0;

  const { rows: branches } = await pool.query(`SELECT id, name FROM branches`);
  for (const branch of branches) {
    try {
      const policies = await getEffectivePolicies(branch.id);
      const kinds = meritReminderKindsDue(now, policies['merit.reminder_day']);
      if (!kinds.length) continue;

      const { rows: pending } = await pool.query(
        `SELECT COUNT(DISTINCT student_id) AS students, COALESCE(SUM(points), 0) AS points
           FROM merit_ledger WHERE branch_id = $1 AND status = 'pending' AND earned_month <= $2`,
        [branch.id, parts.ym],
      );
      const students = Number(pending[0]?.students ?? 0);
      const points = Number(pending[0]?.points ?? 0);
      if (students === 0) continue;

      const officer = typeof policies['merit.officer_user_id'] === 'string' && policies['merit.officer_user_id']
        ? String(policies['merit.officer_user_id']) : null;
      const { rows: recipients } = officer
        ? await pool.query(`SELECT id, name, email FROM users WHERE id = $1 AND deleted_at IS NULL`, [officer])
        : await pool.query(
          `SELECT id, name, email FROM users WHERE role = 'admin' AND admin_scope = 'branch' AND branch_id = $1 AND deleted_at IS NULL`,
          [branch.id],
        );
      if (!recipients.length) continue;

      for (const kind of kinds) {
        const markerId = `${branch.id}:${parts.ym}:${kind}`;
        const { rows: done } = await pool.query(
          `SELECT 1 AS x FROM audit_log WHERE entity_type = 'merit_reminder' AND entity_id = $1 LIMIT 1`,
          [markerId],
        );
        if (done[0]) continue;
        await pool.query(
          `INSERT INTO audit_log (id, actor_id, branch_id, action, entity_type, entity_id, summary)
           VALUES ($1, NULL, $2, 'merit.reminder', 'merit_reminder', $3, $4)`,
          [randomUUID(), branch.id, markerId, `Merit reminder (${kind === 'last' ? 'last day of the month' : 'reminder day'}) — ${students} students, ${points} points`],
        );
        const message = kind === 'last'
          ? `Today is the last day of the month: ${students} student${students === 1 ? '' : 's'} in ${branch.name} still have ${points} merit point${points === 1 ? '' : 's'} to be given on the Jamea portal.`
          : `${students} student${students === 1 ? '' : 's'} in ${branch.name} have ${points} merit point${points === 1 ? '' : 's'} waiting to be given on the Jamea portal this month.`;
        for (const user of recipients) {
          await safeNotify(user.id, 'merit_points_to_give', { message, branchId: branch.id, month: parts.ym, students, points });
          await safeEmail(
            user.email,
            kind === 'last' ? 'Last day of the month — merit points to give' : 'Merit points to give this month',
            [
              `Salaam ${String(user.name ?? '').trim().split(/\s+/)[0] || ''},`.replace(' ,', ','),
              '',
              message,
              'Give them on the Jamea portal, then tick "Mark as given" so they leave the list:',
              appLink('v2-merit'),
              '',
              '— Funun al-Quran · Tehseen al-Khat, Al-Jamea-tus-Saifiyah',
            ].join('\n'),
            'merit_reminder',
          );
        }
        reminded++;
      }
    } catch (error) {
      console.error(`[v2 merit reminders] branch ${branch.id} failed`, error);
    }
  }
  return { reminded };
}
