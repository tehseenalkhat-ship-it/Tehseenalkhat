// owner: insights — dormant / inactive student nudges (manual bulk + automatic sweep)
import { pool } from '../../db.js';
import { config } from '../../config.js';
import { isAllowedInApp } from '../../services/notify.js';
import { queueEmail } from '../lib/emailTemplates.js';
import { DEFAULTS, getEffectivePolicies } from '../lib/policies.js';
import { loadStudentRecords, type StudentRecord } from '../lib/insightsData.js';
import { DAY_MS, emailBudget, pickSweepTargets, renderNudgeTemplate } from '../lib/insightsLogic.js';

export type NudgeResult = { sent: number; emailed: number; emailSkipped: number; failedEmails: number };

/** Notification type shown in the bell: title "Gentle Reminder", body = payload.message. */
export const NUDGE_NOTIFICATION_TYPE = 'gentle_reminder';

export async function emailsSentLast24h(now = new Date()): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS total FROM student_nudges WHERE emailed = 1 AND created_at >= $1`,
    [new Date(now.getTime() - DAY_MS)],
  );
  return Number(rows[0]?.total ?? 0);
}

function courseName(record: StudentRecord): string | null {
  return record.courseCode || record.courseTitle || null;
}

/**
 * Sends one personalised message to each student: in-app notification, optional
 * email (within the rolling 24-hour email budget), and a student_nudges row.
 * Inserts are batched (one statement per 200 students), emails go out 4 at a time.
 */
export async function deliverNudges(opts: {
  records: StudentRecord[];
  template: string;
  sendEmail: boolean;
  kind: 'manual' | 'auto';
  sentBy: string | null;
  senderName?: string | null;
  now?: Date;
}): Promise<NudgeResult> {
  const now = opts.now ?? new Date();
  const messages = opts.records.map(record => ({
    record,
    text: renderNudgeTemplate(opts.template, { name: record.name, course: courseName(record), days: record.idleDays }),
    emailed: false,
  }));

  let emailSkipped = 0;
  let failedEmails = 0;
  if (opts.sendEmail) {
    let budget = emailBudget(await emailsSentLast24h(now));
    const queue = messages.filter(m => m.record.email.includes('@'));
    emailSkipped += messages.length - queue.length;
    const toSend = queue.slice(0, budget);
    emailSkipped += queue.length - toSend.length;
    const link = `${config.frontendUrl.replace(/\/$/, '')}/#dashboard`;
    for (let i = 0; i < toSend.length; i += 4) {
      await Promise.all(toSend.slice(i, i + 4).map(async m => {
        try {
          // v3 (admin-comms): through the capped email queue + the editable "Gentle reminder" template.
          if (!(await queueEmail(m.record.email, 'nudge', { name: m.record.name, message: m.text, link }, { refType: 'nudge', refId: m.record.studentId, branchId: m.record.branchId }))) throw new Error('could not queue');
          m.emailed = true;
          budget -= 1;
        } catch (error) {
          failedEmails += 1;
          console.error('nudge email failed', m.record.studentId, error);
        }
      }));
    }
  }

  for (let i = 0; i < messages.length; i += 200) {
    const chunk = messages.slice(i, i + 200);
    const notifValues: unknown[] = [];
    const notifRows = chunk.map(m => {
      notifValues.push(m.record.studentId, NUDGE_NOTIFICATION_TYPE, JSON.stringify({ message: m.text, kind: opts.kind, fromName: opts.senderName ?? null }));
      const k = notifValues.length;
      return `($${k - 2}, $${k - 1}, $${k})`;
    });
    // v3 (owner note E 1.3): gentle reminders are no longer in-app pop-ups — email only (see services/notify.ts).
    if (isAllowedInApp(NUDGE_NOTIFICATION_TYPE)) await pool.query(`INSERT INTO notifications (user_id, type, payload) VALUES ${notifRows.join(', ')}`, notifValues);

    const logValues: unknown[] = [];
    const logRows = chunk.map(m => {
      logValues.push(m.record.studentId, opts.sentBy, opts.kind, m.text, m.emailed);
      const k = logValues.length;
      return `($${k - 4}, $${k - 3}, $${k - 2}, $${k - 1}, $${k})`;
    });
    await pool.query(`INSERT INTO student_nudges (student_id, sent_by, kind, message, emailed) VALUES ${logRows.join(', ')}`, logValues);
  }

  return { sent: messages.length, emailed: messages.filter(m => m.emailed).length, emailSkipped, failedEmails };
}

/**
 * Automatic sweep (hourly from server.ts): dormant students (no activity for
 * nudge.dormant_days) get the branch's template once per 30 days. Each run is
 * limited by the rolling 24-hour email budget (80, free email tier), so a large
 * backlog drips out over several days instead of all at once.
 */
export async function runNudgeSweep(now = new Date()): Promise<{ nudged: number }> {
  const budget = emailBudget(await emailsSentLast24h(now));
  if (budget <= 0) return { nudged: 0 };

  const records = await loadStudentRecords({}, now);
  const targets = pickSweepTargets(
    records.map(record => ({
      ...record,
      lastNudgedAt: record.lastNudgedAt ? new Date(record.lastNudgedAt) : null,
      idleDays: record.idleDays ?? 0,
    })),
    now,
    budget,
  );
  if (!targets.length) return { nudged: 0 };

  // Each branch may have its own template.
  const byBranch = new Map<string, StudentRecord[]>();
  for (const target of targets) {
    const record = records.find(r => r.studentId === target.studentId)!;
    (byBranch.get(record.branchId) ?? byBranch.set(record.branchId, []).get(record.branchId)!).push(record);
  }
  let nudged = 0;
  for (const [branchId, group] of byBranch) {
    const policies = await getEffectivePolicies(branchId);
    const template = typeof policies['nudge.message_template'] === 'string' && (policies['nudge.message_template'] as string).trim()
      ? policies['nudge.message_template'] as string
      : DEFAULTS['nudge.message_template'] as string;
    const result = await deliverNudges({ records: group, template, sendEmail: true, kind: 'auto', sentBy: null, senderName: 'Tehseen al-Khat', now });
    nudged += result.sent;
  }
  return { nudged };
}
