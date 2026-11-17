/**
 * In-app notifications + emails for v2 threads (owner: backend-review).
 *
 * Resend's free tier is ~100 emails/day, so:
 *  - students are emailed only for real staff replies and marks (never system noise),
 *    and plain replies are throttled to one email per thread per 10 minutes;
 *  - staff get one daily digest (services/digest.ts) unless their branch policy
 *    `email.staff_mode` is 'instant'.
 * Nothing here ever throws: a failed email must not undo a teacher's work.
 */
import { config } from '../../config.js';
import { pool } from '../../db.js';
import { notify } from '../../services/notify.js';
import { normaliseVars, queueEmail, renderEmail } from './emailTemplates.js';
import type { MarkBand } from '../contracts.js';
import { getEffectivePolicies } from './policies.js';
import { friendlyStepLabel, friendlyThreadLabel, numberFromCode } from './chatLogic.js';

/**
 * v3 integration: callers pass labels like "FNK-C101 LV01 S05 — Joins"; students must never see codes,
 * so the label is rebuilt here from the step itself ("Fann al-Khat 1, Level 1 · Step 5 — Joins").
 */
export async function friendlyLabelForStep(stepId: string, fallback: string): Promise<string> {
  try {
    const { rows } = await pool.query(
      `SELECT ls.code, ls.title, l.code AS level_code, l.order_index AS level_order, c.title AS course_title, c.course_type
         FROM level_steps ls JOIN levels l ON l.id = ls.level_id JOIN courses c ON c.id = ls.course_id
        WHERE ls.id = $1`,
      [stepId],
    );
    const r = rows[0];
    if (!r) return fallback;
    return friendlyThreadLabel({
      courseTitle: r.course_title, levelCode: r.level_code, levelOrder: r.level_order == null ? null : Number(r.level_order),
      code: r.code, title: r.title, courseType: r.course_type,
    });
  } catch {
    return fallback;
  }
}

export async function safeNotify(userId: string, type: string, payload: Record<string, unknown>): Promise<void> {
  try { await notify(userId, type, payload); } catch (error) { console.error(`[v2] notify ${type} failed`, error); }
}

/**
 * v3: every email goes through the capped queue (src/v2/lib/emailTemplates.ts) — nothing is sent
 * from here directly. `key` only labels the email in the send log.
 */
export async function safeEmail(to: string | null | undefined, subject: string, body: string, key = 'staff_notice'): Promise<boolean> {
  return queueEmail(to, key, { subject, text: body });
}

export function appLink(page: string): string {
  return `${config.frontendUrl.replace(/\/+$/, '')}/#${page}`;
}

const BAND_WORDS: Record<MarkBand, string> = {
  revision: 'please try once more',
  pass: 'pass',
  distinction: 'distinction',
};

const SIGN_OFF = '— Funun al-Quran · Tehseen al-Khat, Al-Jamea-tus-Saifiyah';

export type StaffMessageNotice = {
  studentId: string;
  branchId: string;
  stepId: string;
  courseId: string;
  submissionId: string | null;
  messageId: string;
  kind: 'mark' | 'feedback' | 'reply' | 'annotation';
  mark?: number | null;
  band?: MarkBand | null;
  comment?: string | null;
  stepLabel: string;
  courseTitle: string;
  forceEmail?: boolean; // marks / feedback decisions always email (if policy allows)
  provisional?: boolean; // automatic (96 h) mark — the teacher still confirms it
};

/* ---------------- one notification + one email per teacher review (audit 8 / 19) ---------------- */

/** Notes about the same step within this many minutes are merged into ONE notification and ONE email. */
export const MERGE_MINUTES = 15;
const STEP_TYPES = ['work_marked', 'work_reviewed', 'teacher_replied'] as const;
const RANK: Record<string, number> = { teacher_replied: 1, work_reviewed: 2, work_marked: 3 };
const BAND_LABEL: Record<MarkBand, string> = { revision: 'please try once more', pass: 'Pass', distinction: 'Distinction' };

/** Course and step names for students: "Fann al-Khat 1 · Certification course", "Level 1 · Step 5 — Joins". */
export async function friendlyStepParts(stepId: string): Promise<{ course: string; step: string; full: string } | null> {
  try {
    const { rows } = await pool.query(
      `SELECT ls.code, ls.title, l.code AS level_code, l.order_index AS level_order, c.title AS course_title, c.course_type
         FROM level_steps ls JOIN levels l ON l.id = ls.level_id JOIN courses c ON c.id = ls.course_id
        WHERE ls.id = $1`,
      [stepId],
    );
    const r = rows[0];
    if (!r) return null;
    const levelOrder = r.level_order == null ? null : Number(r.level_order);
    const hideLevel = (r.course_type ?? '') !== 'certification' && numberFromCode(r.level_code, levelOrder) === 1;
    const step = friendlyStepLabel({ levelCode: r.level_code, levelOrder, stepCode: r.code, title: r.title, hideLevel });
    const course = String(r.course_title ?? '').trim();
    return { course, step, full: course ? `${course} · ${step}` : step };
  } catch {
    return null;
  }
}

/** What the staff did on this step in the last few minutes (read back from the chat itself). */
export type StepDigest = {
  mark: number | null; band: MarkBand | null; marked: boolean; reviewed: boolean;
  drawing: boolean; comments: string[]; voice: number; files: number; teacherName: string | null;
};

export function emptyDigest(): StepDigest {
  return { mark: null, band: null, marked: false, reviewed: false, drawing: false, comments: [], voice: 0, files: 0, teacherName: null };
}

/** Pure: thread rows (oldest first) → digest. */
export function digestFromMessages(rows: { kind: string; body: string | null; meta: unknown; sender_name?: string | null }[]): StepDigest {
  const d = emptyDigest();
  for (const r of rows) {
    const meta = (typeof r.meta === 'string' ? safeJson(r.meta) : r.meta) as Record<string, unknown> | null;
    if (r.sender_name) d.teacherName = String(r.sender_name);
    const body = (r.body ?? '').trim();
    if (r.kind === 'mark') {
      d.marked = true;
      if (typeof meta?.mark === 'number') d.mark = meta.mark;
      if (typeof meta?.band === 'string') d.band = meta.band as MarkBand;
      if (body) d.comments.push(body);
    } else if (r.kind === 'annotation') {
      d.drawing = true;
    } else if (r.kind === 'voice') {
      d.voice += 1;
    } else if (r.kind === 'files') {
      d.files += 1;
      if (body) d.comments.push(body);
    } else if (r.kind !== 'system') {
      if (meta && (meta as { decision?: unknown }).decision === 'reviewed') d.reviewed = true;
      if (body) d.comments.push(body);
    }
  }
  return d;
}

function safeJson(s: string): unknown { try { return JSON.parse(s); } catch { return null; } }

async function loadDigest(studentId: string, stepId: string, since: Date): Promise<StepDigest> {
  try {
    const { rows } = await pool.query(
      `SELECT m.kind, m.body, m.meta, u.name AS sender_name FROM thread_messages m LEFT JOIN users u ON u.id = m.sender_id
        WHERE m.student_id = $1 AND m.step_id = $2 AND m.sender_role IN ('teacher', 'admin') AND m.created_at >= $3
        ORDER BY m.created_at ASC`,
      [studentId, stepId, since],
    );
    return digestFromMessages(rows);
  } catch {
    return emptyDigest();
  }
}

function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** Pure: the one-line notification text, written as plain English (audit 19). */
export function notificationText(d: StepDigest, label: string, opts: { provisional?: boolean } = {}): string {
  const extras: string[] = [];
  if (d.drawing) extras.push('drew corrections on your sheet');
  const notes = d.comments.length - (d.marked && d.comments.length ? 1 : 0);
  if (d.voice) extras.push(d.voice === 1 ? 'sent a voice note' : `sent ${d.voice} voice notes`);
  if (notes > 0 || (!d.marked && d.comments.length)) extras.push(notes > 1 ? `wrote ${notes} messages` : 'wrote you a message');
  const where = label ? ` (${label})` : '';
  if (d.marked || typeof d.mark === 'number') {
    const markText = typeof d.mark === 'number' ? ` ${d.mark}/10${d.band ? ` — ${BAND_LABEL[d.band]}` : ''}` : '';
    const head = opts.provisional
      ? `Your work has been given a mark:${markText}. Your teacher will confirm it soon.`
      : `Your work has been marked:${markText}.`;
    const also = extras.length ? ` Your teacher also ${joinAnd(extras)}.` : '';
    return `${head}${also} Open the step to see everything${where}.`;
  }
  if (d.reviewed) return `Your teacher has reviewed your work${extras.length ? ` and ${joinAnd(extras)}` : ''}. Open the step to read it${where}.`;
  if (extras.length) return `Your teacher ${joinAnd(extras)}. Open the step to see it${where}.`;
  return `You have a new message from your teacher${where}.`;
}

/** Pure: the comment block of the single email. */
export function emailComment(d: StepDigest, opts: { provisional?: boolean; band?: MarkBand | null } = {}): string {
  const lines: string[] = [];
  for (const c of d.comments.slice(-4)) lines.push(`"${c.slice(0, 600)}"`);
  if (d.drawing) lines.push('Your teacher has also drawn corrections on your sheet — open the step to see them.');
  if (d.voice) lines.push(d.voice === 1 ? 'There is a voice note for you in the chat.' : `There are ${d.voice} voice notes for you in the chat.`);
  if (d.files && !d.comments.length) lines.push('Your teacher sent you photos in the chat.');
  if (opts.provisional) lines.push('Your teacher will look at your work soon and confirm this mark — until then the step shows "your teacher will confirm".');
  else if ((opts.band ?? d.band) === 'revision') lines.push('You can upload your work again from the same step when you are ready.');
  return lines.join('\n\n');
}

/** Page address for a step (the hash carries its details so email links survive refresh / new tabs). */
export function stepPage(courseId: string, stepId: string): string {
  return `v2-task?courseId=${encodeURIComponent(courseId)}&stepId=${encodeURIComponent(stepId)}`;
}

function parsePayload(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  const v = typeof raw === 'string' ? safeJson(raw) : null;
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/**
 * Student: ONE in-app notification and ONE email per teacher review. A mark, the drawing on the sheet
 * and the comment (or several quick messages) about the same step within MERGE_MINUTES become one
 * notification (updated in place, or replaced by the stronger "marked" one) and one email (a queued
 * email is rewritten; one already sent is not repeated unless a mark follows a plain reply).
 * A drawing saved while the work is still open is not announced on its own — the mark that follows does.
 */
export async function notifyStudentOfStaffMessage(input: StaffMessageNotice): Promise<void> {
  try {
    const parts = await friendlyStepParts(input.stepId);
    const label = parts?.full ?? input.stepLabel.replace(/\b[A-Z]{2,5}-[A-Z]?\d{2,4}\b|\bLV\s?\d{1,2}\b|\bS\d{1,2}\b/g, '').replace(/^[\s,·—-]+/, '').trim();

    if (input.kind === 'annotation' && input.submissionId) {
      const { rows } = await pool.query(`SELECT status FROM step_submissions WHERE id = $1`, [input.submissionId]);
      if (['submitted', 'in_review'].includes(String(rows[0]?.status ?? ''))) return; // the mark will carry it
    }

    const now = new Date();
    const since = new Date(now.getTime() - MERGE_MINUTES * 60_000);
    const digest = await loadDigest(input.studentId, input.stepId, since);
    if (input.kind === 'mark') {
      digest.marked = true;
      if (typeof input.mark === 'number') digest.mark = input.mark;
      if (input.band) digest.band = input.band;
    }
    if (input.kind === 'feedback') digest.reviewed = true;
    if (input.kind === 'annotation') digest.drawing = true;
    if ((input.kind === 'mark' || input.kind === 'feedback') && input.submissionId && !digest.drawing) {
      const { rows } = await pool.query(`SELECT COUNT(*) AS n FROM annotations WHERE submission_id = $1`, [input.submissionId]).catch(() => ({ rows: [] as { n: number }[] }));
      if (Number(rows[0]?.n ?? 0) > 0) digest.drawing = true;
    }
    if (!digest.comments.length && input.comment && input.kind !== 'annotation') digest.comments.push(input.comment);

    const thisType = input.kind === 'mark' ? 'work_marked' : input.kind === 'feedback' ? 'work_reviewed' : 'teacher_replied';

    // ---- in-app: one unread notification per step (merge window) ----
    const { rows: recent } = await pool.query(
      `SELECT id, type, payload FROM notifications
        WHERE user_id = $1 AND read = false AND type IN ($2, $3, $4) AND created_at >= $5
        ORDER BY created_at DESC LIMIT 20`,
      [input.studentId, ...STEP_TYPES, since],
    );
    const existing = recent.find(r => parsePayload(r.payload).stepId === input.stepId) ?? null;
    const existingPayload = existing ? parsePayload(existing.payload) : {};
    const type = existing && (RANK[existing.type] ?? 0) > (RANK[thisType] ?? 0) ? String(existing.type) : thisType;
    const provisional = input.kind === 'mark' ? Boolean(input.provisional) : Boolean(existingPayload.provisional);
    const payload = {
      message: notificationText(digest, label, { provisional }),
      stepId: input.stepId, courseId: input.courseId, submissionId: input.submissionId ?? existingPayload.submissionId ?? null,
      mark: digest.mark, band: digest.band, stepLabel: label, provisional,
      drawing: digest.drawing, comments: digest.comments.length, voiceNotes: digest.voice,
      page: 'v2-task', link: stepPage(input.courseId, input.stepId),
    };
    if (existing && type === existing.type) {
      await pool.query(`UPDATE notifications SET payload = $1 WHERE id = $2`, [JSON.stringify(payload), existing.id]);
    } else {
      if (existing) await pool.query(`DELETE FROM notifications WHERE id = $1`, [existing.id]);
      await safeNotify(input.studentId, type, payload);
    }

    // ---- email: one per review ----
    const policies = await getEffectivePolicies(input.branchId);
    if (policies['email.student_on_reply'] === false) return;
    const { rows: users } = await pool.query(`SELECT name, email FROM users WHERE id = $1 AND deleted_at IS NULL`, [input.studentId]);
    const student = users[0];
    if (!student?.email) return;
    const to = String(student.email).trim();
    const markEmail = digest.marked || typeof digest.mark === 'number';
    const key = markEmail ? 'mark_given' : 'teacher_reply';
    const teacher = provisional ? 'Your teacher' : digest.teacherName || 'Your teacher';
    const vars = {
      name: student.name, teacher, course: parts?.course || input.courseTitle, step: parts?.step || label,
      link: appLink(stepPage(input.courseId, input.stepId)),
      mark: typeof digest.mark === 'number' ? digest.mark : '—', band: digest.band ? BAND_LABEL[digest.band] : '',
      comment: emailComment(digest, { provisional }) || 'Open the step to read it.',
    };
    const { rows: mails } = await pool.query(
      `SELECT id, status, template_key FROM email_queue WHERE ref_type = 'step_note' AND ref_id = $1 AND to_email = $2 AND created_at >= $3
        ORDER BY created_at DESC LIMIT 1`,
      [input.stepId, to, since],
    );
    const last = mails[0];
    if (last && last.status === 'queued') {
      const email = await renderEmail(key, normaliseVars(vars));
      await pool.query(`UPDATE email_queue SET template_key = $1, subject = $2, body = $3 WHERE id = $4`, [key, email.subject.slice(0, 290), email.text, last.id]);
      return;
    }
    if (last) {
      // already emailed about this step a moment ago: only a mark after a plain reply (or a forced
      // note such as a meeting request / a changed mark) goes out again
      const upgrade = markEmail && last.template_key !== 'mark_given';
      if (!upgrade && !input.forceEmail) return;
    }
    await queueEmail(to, key, vars, { refType: 'step_note', refId: input.stepId, branchId: input.branchId });
  } catch (error) {
    console.error('[v2] student notice failed', error);
  }
}

/** Department chat: ONE unread notification per student per day — later replies update it (audit 8). */
export async function notifyDeptReply(studentId: string, preview: string, senderName: string | null): Promise<void> {
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const { rows } = await pool.query(
      `SELECT id, payload FROM notifications WHERE user_id = $1 AND type = 'dept_reply' AND read = false AND created_at >= $2
        ORDER BY created_at DESC LIMIT 1`,
      [studentId, startOfDay],
    );
    const prev = rows[0] ? parsePayload(rows[0].payload) : null;
    const count = (typeof prev?.count === 'number' ? prev.count : prev ? 1 : 0) + 1;
    const text = preview.replace(/\s+/g, ' ').trim().slice(0, 140);
    const payload = {
      message: count > 1 ? `${count} new replies. Latest${senderName ? ` from ${senderName}` : ''}: “${text}”` : `${senderName ? `${senderName}: ` : ''}“${text}”`,
      count, sender: senderName, link: 'v2-dept-chat', page: 'v2-dept-chat',
    };
    if (rows[0]) await pool.query(`UPDATE notifications SET payload = $1 WHERE id = $2`, [JSON.stringify(payload), rows[0].id]);
    else await safeNotify(studentId, 'dept_reply', payload);
  } catch (error) {
    console.error('[v2] dept notice failed', error);
  }
}

/** Staff: in-app notification for new work; instant email only when the branch policy asks for it. */
export async function notifyStaffOfNewWork(n: { teacherId: string | null; branchId: string; studentName: string; stepLabel: string; submissionId: string; printCode: string; reason: 'new' | 'diverted' | 'forwarded' }): Promise<void> {
  if (!n.teacherId) return;
  const message = n.reason === 'new'
    ? `${n.studentName} uploaded work for ${n.stepLabel}. It is in your branch inbox.`
    : n.reason === 'diverted'
      ? `${n.studentName}'s work for ${n.stepLabel} has been waiting — it has been passed to you. Even a quick mark helps.`
      : `${n.studentName}'s work for ${n.stepLabel} had no free teacher in the branch — it has been forwarded to you.`;
  await safeNotify(n.teacherId, 'new_work_to_review', { message, submissionId: n.submissionId, printCode: n.printCode, reason: n.reason });
  try {
    const policies = await getEffectivePolicies(n.branchId);
    if (policies['email.staff_mode'] !== 'instant') return;
    const { rows } = await pool.query(`SELECT name, email FROM users WHERE id = $1 AND deleted_at IS NULL`, [n.teacherId]);
    const teacher = rows[0];
    if (!teacher) return;
    await safeEmail(
      teacher.email,
      `New work to review — ${n.stepLabel}`,
      [`Salaam ${String(teacher.name ?? '').split(/\s+/)[0] || ''},`, '', message, `Print code: ${n.printCode}`, '', appLink(`v2-inbox?submissionId=${n.submissionId}`), '', SIGN_OFF].join('\n'),
    );
  } catch (error) {
    console.error('[v2] staff instant email failed', error);
  }
}

/* ---------------- faculty copies (owner note 3.10) ---------------- */

/** One faculty copy per piece of work per 30 minutes — shared by the review decision and the chat. */
export async function recentFacultyCopy(to: string, refId: string, minutes = 30): Promise<boolean> {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*) AS n FROM email_queue WHERE ref_type = 'faculty_copy' AND ref_id = $1 AND to_email = $2 AND created_at >= $3`,
      [refId, to.trim(), new Date(Date.now() - minutes * 60_000)],
    );
    return Number(rows[0]?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * The teacher responsible for a piece of work (its assigned teacher) gets an email when someone else
 * gave its mark — a colleague, an admin, or the automatic 96-hour mark. Marking your own work sends
 * nothing (you know already). De-duplicated with the chat's "a colleague replied" copy.
 */
export async function emailFacultyOfMark(n: {
  teacherId: string | null; reviewerId: string | null; reviewerName: string | null; auto: boolean; provisional: boolean;
  studentId: string; stepId: string; submissionId: string; branchId: string;
  mark: number | null; band: MarkBand | null; comment: string | null; stepLabel: string;
}): Promise<boolean> {
  try {
    if (!n.teacherId || (!n.auto && n.teacherId === n.reviewerId)) return false;
    const { rows } = await pool.query(`SELECT name, email FROM users WHERE id = $1 AND deleted_at IS NULL`, [n.teacherId]);
    const t = rows[0];
    if (!t?.email) return false;
    if (await recentFacultyCopy(t.email, n.submissionId)) return false;
    const { rows: s } = await pool.query(`SELECT name FROM users WHERE id = $1`, [n.studentId]);
    const studentName = s[0]?.name ?? 'A student';
    const label = await friendlyLabelForStep(n.stepId, n.stepLabel);
    const markText = typeof n.mark === 'number' ? `${n.mark}/10${n.band ? ` (${BAND_WORDS[n.band]})` : ''}` : 'feedback given';
    const who = n.auto ? 'The automatic 96-hour mark' : `${n.reviewerName || 'A colleague'}`;
    const subject = n.auto
      ? `Please confirm: automatic mark for ${studentName} — ${label}`
      : `${studentName}'s work was marked — ${label}`;
    const text = [
      `Salaam ${String(t.name ?? '').split(/\s+/)[0] || ''},`, '',
      n.auto
        ? `${studentName}'s work for ${label} waited 96 hours, so it was given an automatic mark of ${markText} with a warm message in your name. Please open it and confirm or change the mark — the next level opens only after you confirm.`
        : `${who} marked ${studentName}'s work for ${label}: ${markText}.`,
      n.comment ? `\nComment sent to the student:\n"${n.comment.slice(0, 600)}"` : '',
      '', appLink(`v2-inbox?submissionId=${n.submissionId}`), '', SIGN_OFF,
    ].join('\n');
    return await queueEmail(t.email, 'mark_given', { staffName: t.name, subject, text }, { refType: 'faculty_copy', refId: n.submissionId, branchId: n.branchId });
  } catch (error) {
    console.error('[v2] faculty mark email failed', error);
    return false;
  }
}
