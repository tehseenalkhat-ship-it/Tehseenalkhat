// owner: backend-review — daily staff email digest
//
// Once a day after 07:00 Africa/Nairobi, each teacher whose branch policy is
// email.staff_mode = 'daily_digest' and who has open work gets ONE email:
// how many are waiting, how long the oldest has waited, a link to the inbox.
// Teachers count the shared branch inbox; admins only work passed to them.
// Idempotent per user per day via an audit_log marker (entity_type 'staff_digest').
import { pool } from '../../db.js';
import type { EffectivePolicies } from '../contracts.js';
import { getEffectivePolicies } from '../lib/policies.js';
import { digestDue, hoursBetween, zonedParts } from '../lib/reviewLogic.js';
import { toDate } from '../lib/threadData.js';
import { appLink, safeEmail } from '../lib/threadNotify.js';
import { randomUUID } from 'node:crypto';

const MAX_EMAILS_PER_RUN = 80; // Resend free tier ≈ 100/day — leave room for student emails

export function describeWait(hours: number): string {
  if (hours < 1) return 'less than an hour';
  if (hours < 24) return `${Math.round(hours)} hour${Math.round(hours) === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

export function digestText(opts: { firstName: string; total: number; mine: number; oldestHours: number; overdue: number; divertHours: number; link: string }): { subject: string; body: string } {
  const subject = `${opts.total} piece${opts.total === 1 ? '' : 's'} of work waiting for review`;
  const lines = [
    `Salaam ${opts.firstName || ''},`.replace(' ,', ','),
    '',
    `Your review inbox has ${opts.total} piece${opts.total === 1 ? '' : 's'} of student work waiting${opts.mine ? ` (${opts.mine} passed to you personally)` : ''}.`,
    `The oldest has been waiting ${describeWait(opts.oldestHours)}.`,
  ];
  if (opts.overdue > 0) {
    lines.push(`${opts.overdue} ${opts.overdue === 1 ? 'has' : 'have'} waited more than ${opts.divertHours} hours — even a quick mark (6, 5, 4…) means a lot to a student.`);
  }
  lines.push('', 'Open the inbox (oldest first):', opts.link, '', '— Funun al-Quran · Tehseen al-Khat, Al-Jamea-tus-Saifiyah');
  return { subject, body: lines.join('\n') };
}

export type OpenItem = { branchId: string; assignee: string | null; created: Date };

/**
 * What one staff member's digest says. Teachers: their whole branch inbox plus
 * anything forwarded to them from other branches. Admins: only work assigned to them.
 */
export function summariseForStaff(open: OpenItem[], user: { id: string; role: string; branchId: string }, now: Date, divertHours: number): { total: number; mine: number; oldestHours: number; overdue: number } {
  const relevant = open.filter(o => (user.role === 'teacher' ? o.branchId === user.branchId || o.assignee === user.id : o.assignee === user.id));
  if (!relevant.length) return { total: 0, mine: 0, oldestHours: 0, overdue: 0 };
  const oldest = relevant.reduce((min, o) => (o.created < min ? o.created : min), relevant[0].created);
  return {
    total: relevant.length,
    mine: user.role === 'teacher' ? relevant.filter(o => o.assignee === user.id).length : 0,
    oldestHours: hoursBetween(oldest, now),
    overdue: relevant.filter(o => hoursBetween(o.created, now) >= divertHours).length,
  };
}

export async function runStaffDigestSweep(): Promise<{ emailed: number }> {
  const now = new Date();
  const today = zonedParts(now).ymd;
  if (!digestDue(now, null)) return { emailed: 0 }; // before 07:00 Nairobi

  const [staffRes, openRes, markerRes] = await Promise.all([
    pool.query(`SELECT id, name, email, role, branch_id FROM users WHERE role IN ('teacher', 'admin') AND deleted_at IS NULL`),
    pool.query(`SELECT branch_id, assigned_teacher_id, created_at FROM step_submissions WHERE status IN ('submitted', 'in_review') LIMIT 20000`),
    pool.query(`SELECT entity_id FROM audit_log WHERE entity_type = 'staff_digest' AND entity_id LIKE $1`, [`${today}:%`]),
  ]);
  const sent = new Set(markerRes.rows.map((r: any) => String(r.entity_id).slice(today.length + 1)));
  const open = openRes.rows.map((r: any) => ({ branchId: r.branch_id as string, assignee: (r.assigned_teacher_id ?? null) as string | null, created: toDate(r.created_at) ?? now }));

  const policyCache = new Map<string, EffectivePolicies>();
  let emailed = 0;
  for (const user of staffRes.rows) {
    if (emailed >= MAX_EMAILS_PER_RUN) break;
    if (!digestDue(now, sent.has(user.id) ? today : null)) continue;
    let policies = policyCache.get(user.branch_id);
    if (!policies) { policies = await getEffectivePolicies(user.branch_id); policyCache.set(user.branch_id, policies); }
    if ((policies['email.staff_mode'] ?? 'daily_digest') !== 'daily_digest') continue;
    const divertHours = Number(policies['review.divert_after_hours']) || 72;

    const summary = summariseForStaff(open, { id: user.id, role: user.role, branchId: user.branch_id }, now, divertHours);
    if (summary.total <= 0) continue;
    const { total, mine: personalCount, oldestHours, overdue } = summary;

    // marker first: if it cannot be written we do not risk sending twice
    try {
      await pool.query(
        `INSERT INTO audit_log (id, actor_id, branch_id, action, entity_type, entity_id, summary)
         VALUES ($1, NULL, $2, 'digest.sent', 'staff_digest', $3, $4)`,
        [randomUUID(), user.branch_id, `${today}:${user.id}`, `Daily review digest — ${total} waiting`],
      );
    } catch (error) {
      console.error('[v2 digest] marker failed; skipping', error);
      continue;
    }
    const text = digestText({
      firstName: String(user.name ?? '').trim().split(/\s+/)[0] ?? '',
      total, mine: personalCount, oldestHours, overdue, divertHours, link: appLink('v2-inbox'),
    });
    if (await safeEmail(user.email, text.subject, text.body, 'staff_digest')) emailed++;
  }
  return { emailed };
}
