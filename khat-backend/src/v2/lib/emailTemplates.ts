/**
 * Email templates + the capped email queue (owner: admin-comms, v3 notes 1.11 / 4.8).
 *
 *  renderEmail(key, vars)   → { subject, text, html }   (admin's edited text, else the default)
 *  queueEmail(to, key, vars) → puts one email in `email_queue` (never sends directly)
 *  runEmailQueueSweep()      → sends a few queued emails per run through src/email.ts
 *
 * Why a queue: the free email tier allows about 100 emails a day. The sweep sends at most
 * EMAIL_PER_RUN per run and EMAIL_DAILY_CAP per rolling 24 hours; personal emails (marks,
 * replies) go before bulk ones (announcements, surveys). Nothing is lost — what does not fit
 * today goes tomorrow. Every send is logged (status sent / failed + error).
 * Sending itself stays behind sendEmail() in src/email.ts (prints instead of sending when no key).
 */
import { config } from '../../config.js';
import { pool } from '../../db.js';
import { sendEmail } from '../../email.js';

export const EMAIL_KEYS = [
  'mark_given', 'teacher_reply', 'dept_reply', 'new_course', 'announcement', 'survey',
  'competition', 'site_update', 'nudge', 'staff_digest', 'merit_reminder',
] as const;
export type EmailKey = (typeof EMAIL_KEYS)[number];

export type EmailTemplateDef = {
  key: EmailKey;
  label: string;
  group: 'Students' | 'Everyone' | 'Staff';
  description: string;
  vars: string[];
  subject: string;
  body: string;
};

const SIGN = 'Funun al-Quran · Tehseen al-Khat\nAl-Jamea-tus-Saifiyah';

/** The built-in wording. Admins can change subject and body; {words} are filled in. */
export const DEFAULT_TEMPLATES: Record<EmailKey, EmailTemplateDef> = {
  mark_given: {
    key: 'mark_given', label: 'Marks given', group: 'Students',
    description: 'Sent to a student when a teacher gives a mark.',
    vars: ['name', 'course', 'step', 'mark', 'band', 'comment', 'teacher', 'link'],
    subject: 'Your work has been marked — {step}',
    body: 'Salaam {name},\n\n{teacher} has marked your work for {step} ({course}).\n\nMark: {mark}/10 — {band}\n\n{comment}\n\nOpen the step to see the corrections and the full chat:\n{link}',
  },
  teacher_reply: {
    key: 'teacher_reply', label: 'Teacher replied', group: 'Students',
    description: 'Sent to a student when a teacher writes in the step chat.',
    vars: ['name', 'course', 'step', 'comment', 'teacher', 'link'],
    subject: '{teacher} replied — {step}',
    body: 'Salaam {name},\n\n{teacher} sent you a message about {step} ({course}):\n\n{comment}\n\nReply in the chat:\n{link}',
  },
  dept_reply: {
    key: 'dept_reply', label: 'Department replied', group: 'Students',
    description: 'Sent when the Funun al-Quran Department answers a student’s chat.',
    vars: ['name', 'comment', 'teacher', 'link'],
    subject: 'Funun al-Quran Department replied',
    body: 'Salaam {name},\n\nThe Funun al-Quran Department replied to your message:\n\n{comment}\n\n— {teacher}\n\nOpen the chat:\n{link}',
  },
  new_course: {
    key: 'new_course', label: 'New course', group: 'Students',
    description: 'Sent when a new course is published for the student’s branch.',
    vars: ['name', 'course', 'kind', 'link'],
    subject: 'A new course is open: {course}',
    body: 'Salaam {name},\n\nA new {kind} is now open for you: {course}.\n\nHave a look and start when you are ready:\n{link}',
  },
  announcement: {
    key: 'announcement', label: 'Announcement', group: 'Everyone',
    description: 'Sent when an announcement is published with “Email” switched on.',
    vars: ['name', 'title', 'message', 'branch', 'link'],
    subject: '{title}',
    body: 'Salaam {name},\n\n{message}\n\nMore on Tehseen al-Khat:\n{link}',
  },
  survey: {
    key: 'survey', label: 'Survey', group: 'Everyone',
    description: 'Sent when a survey is published with “Email” switched on. {link} is each person’s own answer link (no sign-in needed) — keep it in the message.',
    vars: ['name', 'title', 'message', 'branch', 'link'],
    subject: 'A short survey: {title}',
    body: 'Salaam {name},\n\n{message}\n\nIt takes a minute and you do not need to sign in — this link is just for you:\n{link}\n\nShukran for helping us improve.',
  },
  competition: {
    key: 'competition', label: 'Competition or call', group: 'Everyone',
    description: 'For a new competition or call for calligraphers.',
    vars: ['name', 'title', 'message', 'branch', 'link'],
    subject: 'New competition: {title}',
    body: 'Salaam {name},\n\n{message}\n\nSee the details and send your entry:\n{link}',
  },
  site_update: {
    key: 'site_update', label: 'Website news', group: 'Everyone',
    description: 'For news about the website — new features, changes, events.',
    vars: ['name', 'title', 'message', 'link'],
    subject: 'What is new on Tehseen al-Khat: {title}',
    body: 'Salaam {name},\n\n{message}\n\nHave a look:\n{link}',
  },
  nudge: {
    key: 'nudge', label: 'Gentle reminder', group: 'Students',
    description: 'The gentle note to a student who has been quiet for a long time.',
    vars: ['name', 'message', 'link'],
    subject: 'A gentle note from Funun al-Quran',
    body: '{message}\n\nOpen your courses:\n{link}',
  },
  staff_digest: {
    key: 'staff_digest', label: 'Teacher morning summary', group: 'Staff',
    description: 'One email a morning to teachers with work waiting.',
    vars: ['name', 'message', 'link'],
    subject: 'Work waiting for review',
    body: 'Salaam {name},\n\n{message}\n\nOpen the inbox (oldest first):\n{link}',
  },
  merit_reminder: {
    key: 'merit_reminder', label: 'Merit points reminder', group: 'Staff',
    description: 'Monthly reminder to the branch admin to give merit points on the Jamea portal.',
    vars: ['name', 'message', 'link'],
    subject: 'Merit points to give this month',
    body: 'Salaam {name},\n\n{message}\n\nGive them on the Jamea portal, then tick “Mark as given”:\n{link}',
  },
};

export function isEmailKey(key: string): key is EmailKey {
  return (EMAIL_KEYS as readonly string[]).includes(key);
}

export type EmailVars = Record<string, string | number | null | undefined>;

/** Replaces {word} with vars.word (unknown or empty → nothing); tidies the blank lines left behind. */
export function fillTemplate(text: string, vars: EmailVars): string {
  const out = String(text ?? '').replace(/\{([a-zA-Z_]+)\}/g, (_, k: string) => {
    const v = vars[k];
    return v === null || v === undefined ? '' : String(v);
  });
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function appUrl(page = 'dashboard'): string {
  return `${config.frontendUrl.replace(/\/+$/, '')}/#${page}`;
}

/** Pure: subject/body (+ vars) → finished email with the Funun al-Quran signature. */
export function renderWith(tpl: { subject: string; body: string }, vars: EmailVars): { subject: string; text: string; html: string } {
  const full: EmailVars = { link: appUrl(), name: 'there', ...vars };
  if (!full.name) full.name = 'there';
  const subject = fillTemplate(tpl.subject, full).replace(/\s+/g, ' ').slice(0, 290) || 'Tehseen al-Khat';
  let body = fillTemplate(tpl.body, full);
  // an edited template that lost {link} still carries the personal link (e.g. a survey answer link)
  if (vars.link && !tpl.body.includes('{link}')) body = `${body}\n\n${vars.link}`;
  const text = `${body}\n\n— ${SIGN}`;
  const paragraphs = text.split(/\n{2,}/).map(p => `<p style="margin:0 0 14px">${escapeHtml(p).replace(/\n/g, '<br>').replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#0b5c8a">$1</a>')}</p>`);
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#1d2a33;max-width:560px">${paragraphs.join('')}</div>`;
  return { subject, text, html };
}

export async function loadTemplate(key: EmailKey): Promise<{ subject: string; body: string; isCustom: boolean; updatedAt: string | null }> {
  const def = DEFAULT_TEMPLATES[key];
  try {
    const { rows } = await pool.query(`SELECT subject, body, updated_at FROM email_templates WHERE template_key = $1`, [key]);
    if (rows[0]) return { subject: String(rows[0].subject), body: String(rows[0].body), isCustom: true, updatedAt: rows[0].updated_at ? new Date(rows[0].updated_at).toISOString() : null };
  } catch (error) {
    console.error('[email] template load failed, using default', error);
  }
  return { subject: def.subject, body: def.body, isCustom: false, updatedAt: null };
}

export async function renderEmail(key: EmailKey, vars: EmailVars): Promise<{ subject: string; text: string; html: string }> {
  return renderWith(await loadTemplate(key), vars);
}

export const validEmail = (to: unknown): to is string => typeof to === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.trim()) && to.length <= 320;

export type QueueOpts = { refType?: string; refId?: string; branchId?: string | null };

/**
 * Callers use slightly different words for the same thing (studentName, senderName, message …).
 * Map them onto the template words so an edited template always fills in.
 */
export function normaliseVars(vars: Record<string, unknown>): EmailVars {
  const v: EmailVars = {};
  for (const [k, value] of Object.entries(vars)) {
    if (value === null || value === undefined || typeof value === 'string' || typeof value === 'number') v[k] = value as EmailVars[string];
  }
  const firstWord = (s: unknown) => String(s ?? '').trim().split(/\s+/)[0] || '';
  if (!v.name && (v.studentName || v.staffName)) v.name = firstWord(v.staffName || v.studentName);
  else if (v.name) v.name = firstWord(v.name);
  if (!v.teacher && (v.senderName || v.teacherName)) v.teacher = v.senderName || v.teacherName;
  if (!v.teacher) v.teacher = 'Your teacher';
  if (!v.comment && v.message) v.comment = v.message;
  if (!v.message && v.comment) v.message = v.comment;
  if (!v.course && v.courseTitle) v.course = v.courseTitle;
  if (!v.step && v.stepLabel) v.step = v.stepLabel;
  return v;
}

/** Puts one email in the queue. Never throws; returns false for a bad address or a database problem. */
export async function queueEmail(to: string | null | undefined, key: EmailKey | string, rawVars: Record<string, unknown>, opts: QueueOpts = {}): Promise<boolean> {
  if (!validEmail(to)) return false;
  try {
    const vars = normaliseVars(rawVars);
    let email: { subject: string; text: string };
    const tpl = isEmailKey(key) ? await loadTemplate(key) : null;
    // A caller's own finished wording (subject + text) is used when the admin has not edited the
    // template, or when the email is for staff (staffName) — the editable templates speak to students.
    const own = typeof rawVars.subject === 'string' && typeof rawVars.text === 'string';
    if (own && (!tpl || !tpl.isCustom || rawVars.staffName)) email = { subject: String(rawVars.subject), text: String(rawVars.text) };
    else if (tpl) email = renderWith(tpl, vars);
    else return false;
    await pool.query(
      `INSERT INTO email_queue (to_email, template_key, subject, body, ref_type, ref_id, branch_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [to.trim(), String(key).slice(0, 40), email.subject.slice(0, 290), email.text, opts.refType ?? null, opts.refId ?? null, opts.branchId ?? null],
    );
    return true;
  } catch (error) {
    console.error('[email] queue failed', error);
    return false;
  }
}

/** Many recipients, one template (announcements, surveys). Rendered per person, inserted in chunks. */
export async function queueEmailMany(list: { to: string | null | undefined; vars: EmailVars }[], key: EmailKey, opts: QueueOpts = {}): Promise<number> {
  const tpl = await loadTemplate(key);
  const seen = new Set<string>();
  const rows: unknown[][] = [];
  for (const item of list) {
    if (!validEmail(item.to)) continue;
    const to = item.to.trim().toLowerCase();
    if (seen.has(to)) continue;
    seen.add(to);
    const email = renderWith(tpl, item.vars);
    rows.push([to, key, email.subject, email.text, opts.refType ?? null, opts.refId ?? null, opts.branchId ?? null]);
  }
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const values: unknown[] = [];
    const tuples = chunk.map(r => {
      const start = values.length;
      values.push(...r);
      return `(${r.map((_, n) => `$${start + n + 1}`).join(', ')})`;
    });
    await pool.query(`INSERT INTO email_queue (to_email, template_key, subject, body, ref_type, ref_id, branch_id) VALUES ${tuples.join(', ')}`, values);
  }
  return rows.length;
}

// ---------------------------------------------------------------- sending (capped)
export const EMAIL_DAILY_CAP = Math.max(1, Number(process.env.EMAIL_DAILY_CAP) || 95);
export const EMAIL_PER_RUN = Math.max(1, Number(process.env.EMAIL_PER_RUN) || 12);
export const PERSONAL_KEYS: EmailKey[] = ['mark_given', 'teacher_reply', 'dept_reply'];
const MAX_ATTEMPTS = 3;

/** Pure: how many may go out in this run. */
export function sendAllowance(sentLast24h: number, dailyCap = EMAIL_DAILY_CAP, perRun = EMAIL_PER_RUN): number {
  return Math.max(0, Math.min(perRun, dailyCap - Math.max(0, sentLast24h)));
}

export async function sentInLast24h(now = new Date()): Promise<number> {
  const { rows } = await pool.query(`SELECT COUNT(*) AS n FROM email_queue WHERE status = 'sent' AND sent_at >= $1`, [new Date(now.getTime() - 86_400_000)]);
  return Number(rows[0]?.n ?? 0);
}

let sweeping = false;

export async function runEmailQueueSweep(now = new Date(), send: (to: string, subject: string, body: string) => Promise<void> = sendEmail): Promise<{ sent: number; failed: number; waiting: number }> {
  if (sweeping) return { sent: 0, failed: 0, waiting: 0 };
  sweeping = true;
  try {
    const allowance = sendAllowance(await sentInLast24h(now));
    let sent = 0;
    let failed = 0;
    if (allowance > 0) {
      const personal = PERSONAL_KEYS.map((_, i) => `$${i + 1}`).join(', ');
      const { rows } = await pool.query(
        `SELECT id, to_email, subject, body, attempts FROM email_queue WHERE status = 'queued'
          ORDER BY CASE WHEN template_key IN (${personal}) THEN 0 ELSE 1 END, created_at ASC LIMIT ${allowance}`,
        [...PERSONAL_KEYS],
      );
      for (const row of rows) {
        try {
          await send(row.to_email, row.subject, row.body);
          await pool.query(`UPDATE email_queue SET status = 'sent', sent_at = $1, attempts = attempts + 1, last_error = NULL WHERE id = $2`, [new Date(), row.id]);
          sent++;
        } catch (error) {
          const attempts = Number(row.attempts ?? 0) + 1;
          await pool.query(
            `UPDATE email_queue SET attempts = $1, status = $2, last_error = $3 WHERE id = $4`,
            [attempts, attempts >= MAX_ATTEMPTS ? 'failed' : 'queued', String(error instanceof Error ? error.message : error).slice(0, 490), row.id],
          );
          failed++;
        }
      }
    }
    const { rows: w } = await pool.query(`SELECT COUNT(*) AS n FROM email_queue WHERE status = 'queued'`);
    return { sent, failed, waiting: Number(w[0]?.n ?? 0) };
  } finally {
    sweeping = false;
  }
}
