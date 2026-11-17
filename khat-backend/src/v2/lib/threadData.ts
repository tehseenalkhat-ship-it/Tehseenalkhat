/**
 * Thread / submission data helpers for v2 review (owner: backend-review).
 * Row → contract mapping, shared loaders, access checks, assignment candidates.
 * Every column used here exists in scripts/migrations/2026-11-10-course-builder-v2.sql
 * or the base schema (users, branches, courses, levels).
 */
import { randomUUID } from 'node:crypto';
import { pool } from '../../db.js';
import type {
  Annotation, AnnotationPin, AnnotationStroke, Attachment, InboxItem, Submission, SubmissionStatus,
  ThreadMessage, ThreadResponse,
} from '../contracts.js';
import type { Actor } from './access.js';
import { canSeeBranch } from './access.js';
import { effectiveThreshold, hoursBetween, OPEN_STATUSES, parseJson } from './reviewLogic.js';
import type { ReviewerNode } from './reviewLogic.js';

export type Tx = { query: (sql: string, params?: readonly unknown[]) => Promise<{ rows: any[]; rowCount: number }> };

export async function withTransaction<T>(fn: (client: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw error;
  } finally {
    client.release();
  }
}

export function isDuplicateKey(error: unknown): boolean {
  const e = error as { code?: string; errno?: number } | null;
  return e?.code === 'ER_DUP_ENTRY' || e?.errno === 1062;
}

/** Strictly increasing timestamps so messages written in one go keep their order. */
let lastClock = 0;
export function clockNow(): Date {
  const t = Math.max(Date.now(), lastClock + 1);
  lastClock = t;
  return new Date(t);
}

export function iso(value: unknown): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(value)) ? '' : 'Z'));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function toDate(value: unknown): Date | null {
  const s = iso(value);
  return s ? new Date(s) : null;
}

function levelCodeOf(code: unknown, orderIndex: unknown): string {
  if (typeof code === 'string' && code.trim()) return code.trim();
  const n = Number(orderIndex);
  return `LV${String((Number.isFinite(n) ? n : 0) + 1).padStart(2, '0')}`;
}

// ---------- Attachments ----------

export function sanitiseAttachments(raw: unknown, max = 50): Attachment[] {
  const list = parseJson<unknown[]>(raw, []);
  if (!Array.isArray(list)) return [];
  const out: Attachment[] = [];
  for (const item of list.slice(0, max)) {
    if (!item || typeof item !== 'object') continue;
    const a = item as Record<string, unknown>;
    const storageKey = typeof a.storageKey === 'string' ? a.storageKey.trim() : '';
    if (!storageKey || storageKey.length > 512 || storageKey.includes('..')) continue;
    out.push({
      storageKey,
      originalFilename: typeof a.originalFilename === 'string' && a.originalFilename.trim() ? a.originalFilename.trim().slice(0, 255) : storageKey.split('/').pop() ?? 'file',
      contentType: typeof a.contentType === 'string' && a.contentType.trim() ? a.contentType.trim().slice(0, 100) : 'application/octet-stream',
      forStepId: typeof a.forStepId === 'string' && a.forStepId.trim() ? a.forStepId.trim().slice(0, 36) : null,
    });
  }
  return out;
}

// ---------- Step context ----------

export type StepContext = {
  id: string; code: string; title: string; stepType: string; status: string; maxMarks: number | null; badgeCode: string | null;
  levelId: string; levelCode: string; levelDescription: string | null; levelBadgeCode: string | null; levelStatus: string; levelOrder: number;
  courseId: string; courseCode: string | null; courseTitle: string; courseType: string | null; courseStatus: string; courseLabelShort: string;
  studentAction: string | null; feedbackMode: string | null; hasMarks: boolean | null; gatesProgress: boolean | null;
  awardsBadge: boolean | null; requiresPriorUploads: boolean | null; stepTypeLabel: string | null;
};

const bool = (v: unknown): boolean | null => (v === null || v === undefined ? null : v === true || v === 1 || v === '1');

export async function loadStepContext(stepId: string, q: Tx = pool): Promise<StepContext | null> {
  const { rows } = await q.query(
    `SELECT ls.id, ls.code, ls.title, ls.step_type, ls.status, ls.max_marks, ls.badge_code, ls.level_id, ls.course_id,
            l.code AS level_code, l.order_index AS level_order, l.description AS level_description,
            l.badge_code AS level_badge_code, l.status AS level_status,
            c.code AS course_code, c.title AS course_title, c.course_type, c.status AS course_status,
            st.label AS step_type_label, st.student_action, st.feedback_mode, st.has_marks, st.gates_progress,
            st.awards_badge, st.requires_prior_uploads
       FROM level_steps ls
       JOIN levels l ON l.id = ls.level_id
       JOIN courses c ON c.id = ls.course_id
       LEFT JOIN step_types st ON st.type_key = ls.step_type
      WHERE ls.id = $1`,
    [stepId],
  );
  const r = rows[0];
  if (!r) return null;
  const courseCode = r.course_code ?? null;
  return {
    id: r.id,
    code: r.code,
    title: r.title ?? '',
    stepType: r.step_type,
    status: r.status,
    maxMarks: r.max_marks === null || r.max_marks === undefined ? null : Number(r.max_marks),
    badgeCode: r.badge_code ?? null,
    levelId: r.level_id,
    levelCode: levelCodeOf(r.level_code, r.level_order),
    levelDescription: r.level_description ?? null,
    levelBadgeCode: r.level_badge_code ?? null,
    levelStatus: r.level_status ?? 'published',
    levelOrder: Number(r.level_order ?? 0),
    courseId: r.course_id,
    courseCode,
    courseTitle: r.course_title ?? '',
    courseType: r.course_type ?? null,
    courseStatus: r.course_status ?? 'published',
    courseLabelShort: courseCode || (r.course_title ?? 'Course'),
    studentAction: r.student_action ?? null,
    feedbackMode: r.feedback_mode ?? null,
    hasMarks: bool(r.has_marks),
    gatesProgress: bool(r.gates_progress),
    awardsBadge: bool(r.awards_badge),
    requiresPriorUploads: bool(r.requires_prior_uploads),
    stepTypeLabel: r.step_type_label ?? null,
  };
}

export function stepSummary(ctx: StepContext): ThreadResponse['step'] {
  return {
    id: ctx.id, code: ctx.code, title: ctx.title, stepType: ctx.stepType,
    levelCode: ctx.levelCode, levelDescription: ctx.levelDescription,
    courseCode: ctx.courseCode, courseTitle: ctx.courseTitle,
  };
}

/** Upload steps own a thread; plain worksheet steps don't. */
export function isThreadStep(ctx: StepContext): boolean {
  if (ctx.studentAction === 'upload' || ctx.studentAction === 'download_upload') return true;
  if (ctx.studentAction === null) return ['istinsakh', 'assessment', 'final_submission'].includes(ctx.stepType);
  return false;
}

// ---------- Students ----------

export type StudentRow = { id: string; name: string; email: string; role: string; branchId: string; trNumber: string | null; className: string | null; branchName: string | null };

export async function loadStudent(userId: string, q: Tx = pool): Promise<StudentRow | null> {
  const { rows } = await q.query(
    `SELECT u.id, u.name, u.email, u.role, u.branch_id, u.tr_number, u.class_name, b.name AS branch_name
       FROM users u LEFT JOIN branches b ON b.id = u.branch_id
      WHERE u.id = $1 AND u.deleted_at IS NULL`,
    [userId],
  );
  const r = rows[0];
  if (!r) return null;
  return { id: r.id, name: r.name ?? '', email: r.email ?? '', role: r.role, branchId: r.branch_id, trNumber: r.tr_number ?? null, className: r.class_name ?? null, branchName: r.branch_name ?? null };
}

export function studentSummary(s: StudentRow): ThreadResponse['student'] {
  return { id: s.id, name: s.name, email: s.email, trNumber: s.trNumber, className: s.className, branchName: s.branchName };
}

// ---------- Submissions ----------

export const SUBMISSION_COLUMNS = `s.id, s.student_id, s.branch_id, s.course_id, s.level_id, s.step_id, s.attempt_no, s.status, s.mark, s.band,
  s.rubric, s.files, s.claimed_by, s.claimed_at, s.reviewed_by, s.reviewed_at, s.created_at, s.print_code, s.auto_marked,
  s.diverted_count, s.assigned_teacher_id, s.assigned_at, s.first_response_at,
  cu.name AS claimed_by_name, ru.name AS reviewed_by_name`;
export const SUBMISSION_JOINS = `LEFT JOIN users cu ON cu.id = s.claimed_by
  LEFT JOIN users ru ON ru.id = s.reviewed_by`;

export function mapSubmission(r: any, opts: { forStudent: boolean }): Submission {
  const rubric = parseJson<Record<string, number> | null>(r.rubric, null);
  const autoMarked = r.auto_marked === true || r.auto_marked === 1 || r.auto_marked === '1';
  return {
    id: r.id,
    studentId: r.student_id,
    stepId: r.step_id,
    levelId: r.level_id,
    courseId: r.course_id,
    attemptNo: Number(r.attempt_no ?? 1),
    status: r.status as SubmissionStatus,
    mark: r.mark === null || r.mark === undefined ? null : Number(r.mark),
    band: r.band ?? null,
    rubric: rubric && typeof rubric === 'object' && !Array.isArray(rubric) ? rubric : null,
    files: sanitiseAttachments(r.files, 200),
    claimedById: opts.forStudent ? null : r.claimed_by ?? null,
    claimedByName: opts.forStudent ? null : r.claimed_by_name ?? null,
    reviewedById: r.reviewed_by ?? null,
    reviewedByName: r.reviewed_by_name ?? (r.reviewed_at ? 'Course team' : null),
    reviewedAt: iso(r.reviewed_at),
    createdAt: iso(r.created_at) ?? new Date(0).toISOString(),
    printCode: r.print_code ?? '',
    autoMarked: opts.forStudent ? false : autoMarked,
    divertedCount: opts.forStudent ? 0 : Number(r.diverted_count ?? 0),
    // v3: mark given but work still open = the automatic mark waiting for the teacher's confirmation
    provisional: r.mark !== null && r.mark !== undefined && (r.status === 'submitted' || r.status === 'in_review'),
  } as Submission & { provisional: boolean };
}

export async function loadSubmissionRow(id: string, q: Tx = pool): Promise<any | null> {
  const { rows } = await q.query(`SELECT ${SUBMISSION_COLUMNS} FROM step_submissions s ${SUBMISSION_JOINS} WHERE s.id = $1`, [id]);
  return rows[0] ?? null;
}

export async function loadSubmission(id: string, opts: { forStudent: boolean }): Promise<Submission | null> {
  const row = await loadSubmissionRow(id);
  return row ? mapSubmission(row, opts) : null;
}

// ---------- Messages ----------

export function mapMessage(r: any): ThreadMessage {
  const role = ['student', 'teacher', 'admin', 'system'].includes(r.sender_role) ? r.sender_role : 'system';
  const meta = parseJson<Record<string, unknown>>(r.meta, {});
  return {
    id: r.id,
    studentId: r.student_id,
    stepId: r.step_id,
    senderId: r.sender_id ?? '',
    senderName: r.sender_name ?? (role === 'system' ? 'Tehseen al-Khat' : 'Course team'),
    senderRole: role,
    kind: r.kind,
    body: r.body ?? null,
    attachments: sanitiseAttachments(r.attachments, 200),
    submissionId: r.submission_id ?? null,
    annotationId: r.annotation_id ?? null,
    meta: meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {},
    createdAt: iso(r.created_at) ?? new Date(0).toISOString(),
    readByStudent: role === 'student' ? true : Boolean(r.student_read_at),
  };
}

export type NewMessage = {
  studentId: string; stepId: string; courseId: string; branchId: string;
  senderId: string | null; senderRole: ThreadMessage['senderRole']; kind: ThreadMessage['kind'];
  body: string | null; attachments: Attachment[]; submissionId?: string | null; annotationId?: string | null;
  meta?: Record<string, unknown>; staffRead?: boolean; studentRead?: boolean; createdAt?: Date;
};

export async function insertThreadMessage(q: Tx, m: NewMessage): Promise<string> {
  const id = randomUUID();
  const at = m.createdAt ?? clockNow();
  await q.query(
    `INSERT INTO thread_messages (id, student_id, step_id, course_id, branch_id, sender_id, sender_role, kind, body, attachments,
       submission_id, annotation_id, meta, created_at, student_read_at, staff_read_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
    [
      id, m.studentId, m.stepId, m.courseId, m.branchId, m.senderId, m.senderRole, m.kind, m.body,
      JSON.stringify(m.attachments ?? []), m.submissionId ?? null, m.annotationId ?? null, JSON.stringify(m.meta ?? {}), at,
      m.studentRead ? at : null, m.staffRead ? at : null,
    ],
  );
  return id;
}

export async function loadMessage(id: string): Promise<ThreadMessage | null> {
  const { rows } = await pool.query(
    `SELECT tm.*, u.name AS sender_name FROM thread_messages tm LEFT JOIN users u ON u.id = tm.sender_id WHERE tm.id = $1`,
    [id],
  );
  return rows[0] ? mapMessage(rows[0]) : null;
}

// ---------- Annotations ----------

const TOOLS = new Set(['pen', 'highlighter', 'circle', 'arrow', 'eraser']);
const clamp01 = (n: unknown) => Math.min(1, Math.max(0, Number.isFinite(Number(n)) ? Number(n) : 0));

export function sanitiseStrokes(raw: unknown): AnnotationStroke[] {
  const list = parseJson<unknown[]>(raw, []);
  if (!Array.isArray(list)) return [];
  const out: AnnotationStroke[] = [];
  let budget = 50_000; // total points
  for (const item of list.slice(0, 2000)) {
    if (!item || typeof item !== 'object') continue;
    const s = item as Record<string, unknown>;
    const tool = typeof s.tool === 'string' && TOOLS.has(s.tool) ? (s.tool as AnnotationStroke['tool']) : 'pen';
    const pts = Array.isArray(s.points) ? s.points : [];
    const points: [number, number][] = [];
    for (const p of pts) {
      if (budget <= 0) break;
      if (Array.isArray(p) && p.length >= 2) { points.push([clamp01(p[0]), clamp01(p[1])]); budget--; }
    }
    if (!points.length) continue;
    const width = Number(s.width);
    out.push({
      tool,
      color: typeof s.color === 'string' && /^#?[0-9a-z(),.%\s]{1,40}$/i.test(s.color) ? s.color : '#d9480f',
      width: Number.isFinite(width) ? Math.min(100, Math.max(0.1, width)) : 3,
      points,
    });
  }
  return out;
}

export function sanitisePins(raw: unknown): AnnotationPin[] {
  const list = parseJson<unknown[]>(raw, []);
  if (!Array.isArray(list)) return [];
  return list.slice(0, 200).filter(p => p && typeof p === 'object').map((item, i) => {
    const p = item as Record<string, unknown>;
    const n = Number(p.n);
    const dur = Number(p.durationSec);
    return {
      n: Number.isInteger(n) && n > 0 ? n : i + 1,
      x: clamp01(p.x),
      y: clamp01(p.y),
      text: typeof p.text === 'string' && p.text.trim() ? p.text.trim().slice(0, 2000) : null,
      voiceStorageKey: typeof p.voiceStorageKey === 'string' && p.voiceStorageKey.trim() && !p.voiceStorageKey.includes('..') ? p.voiceStorageKey.trim().slice(0, 512) : null,
      durationSec: Number.isFinite(dur) && dur >= 0 ? Math.round(dur * 10) / 10 : null,
    };
  });
}

export function mapAnnotation(r: any): Annotation {
  return {
    id: r.id,
    submissionId: r.submission_id,
    fileStorageKey: r.file_storage_key,
    pageIndex: Number(r.page_index ?? 0),
    strokes: sanitiseStrokes(r.strokes),
    pins: sanitisePins(r.pins),
    flattenedStorageKey: r.flattened_storage_key ?? null,
    createdById: r.created_by,
    createdAt: iso(r.created_at) ?? new Date(0).toISOString(),
    updatedAt: iso(r.updated_at) ?? iso(r.created_at) ?? new Date(0).toISOString(),
  };
}

export async function loadAnnotations(submissionIds: string[]): Promise<Annotation[]> {
  if (!submissionIds.length) return [];
  const ph = submissionIds.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await pool.query(
    `SELECT id, submission_id, file_storage_key, page_index, strokes, pins, flattened_storage_key, created_by, created_at, updated_at
       FROM annotations WHERE submission_id IN (${ph}) ORDER BY created_at ASC`,
    submissionIds,
  );
  return rows.map(mapAnnotation);
}

// ---------- Audit inside a transaction ----------

export async function insertAudit(q: Tx, a: { actorId: string | null; branchId: string | null; action: string; entityType: string; entityId: string; summary: string; before?: unknown; after?: unknown }): Promise<void> {
  await q.query(
    `INSERT INTO audit_log (id, actor_id, branch_id, action, entity_type, entity_id, summary, before_json, after_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      randomUUID(), a.actorId, a.branchId, a.action, a.entityType, a.entityId, a.summary,
      a.before === undefined ? null : JSON.stringify(a.before),
      a.after === undefined ? null : JSON.stringify(a.after),
    ],
  );
}

// ---------- Access ----------

/** Staff may act on a submission of their branch, one assigned to them (forwarded), or anything if master. */
export function canStaffSeeSubmission(actor: Actor, branchId: string, assignedTeacherId: string | null): boolean {
  if (!actor.isStaff) return false;
  return canSeeBranch(actor, branchId) || (Boolean(assignedTeacherId) && assignedTeacherId === actor.id);
}

/** Staff access to a whole (student, step) thread. */
export async function staffCanSeeThread(actor: Actor, studentBranchId: string, studentId: string, stepId: string): Promise<boolean> {
  if (!actor.isStaff) return false;
  if (canSeeBranch(actor, studentBranchId)) return true;
  const { rows } = await pool.query(
    `SELECT 1 AS ok FROM step_submissions WHERE student_id = $1 AND step_id = $2 AND assigned_teacher_id = $3 LIMIT 1`,
    [studentId, stepId, actor.id],
  );
  return Boolean(rows[0]);
}

// ---------- Assignment candidates ----------

const LOAD_SQL = `(SELECT COUNT(*) FROM step_submissions so WHERE so.assigned_teacher_id = u.id AND so.status IN ('submitted', 'in_review'))`;

export async function loadBranchTeachers(branchId: string, q: Tx = pool): Promise<{ id: string; openLoad: number }[]> {
  const { rows } = await q.query(
    `SELECT u.id, ${LOAD_SQL} AS open_load FROM users u
      WHERE u.role = 'teacher' AND u.branch_id = $1 AND u.deleted_at IS NULL`,
    [branchId],
  );
  return rows.map(r => ({ id: r.id, openLoad: Number(r.open_load ?? 0) }));
}

/** Master team = master admins + teachers of the master admins' branch (Nairobi). */
export async function loadMasterTeam(q: Tx = pool): Promise<{ id: string; openLoad: number }[]> {
  const { rows } = await q.query(
    `SELECT u.id, ${LOAD_SQL} AS open_load FROM users u
      WHERE u.deleted_at IS NULL AND (
        (u.role = 'admin' AND u.admin_scope = 'master')
        OR (u.role = 'teacher' AND u.branch_id IN (
              SELECT m.branch_id FROM users m WHERE m.role = 'admin' AND m.admin_scope = 'master' AND m.deleted_at IS NULL)))`,
  );
  return rows.map(r => ({ id: r.id, openLoad: Number(r.open_load ?? 0) }));
}

export type ReviewerInfo = { name: string; role: string; branchId: string; branchName: string | null; rawThreshold: number | null };

/**
 * Every possible reviewer (teachers + master admins) with open load, limit, away date and
 * ordered spill-over list — the whole web. Small: a few dozen staff across all branches.
 */
export async function loadReviewerNodes(q: Tx = pool): Promise<{ nodes: ReviewerNode[]; info: Map<string, ReviewerInfo> }> {
  const [users, links] = await Promise.all([
    q.query(
      `SELECT u.id, u.name, u.role, u.admin_scope, u.branch_id, u.entry_load_threshold, u.review_away_until, b.name AS branch_name,
              ${LOAD_SQL} AS open_load
         FROM users u LEFT JOIN branches b ON b.id = u.branch_id
        WHERE u.deleted_at IS NULL AND (u.role = 'teacher' OR (u.role = 'admin' AND u.admin_scope = 'master'))`,
    ),
    q.query(`SELECT teacher_id, target_teacher_id, priority FROM reviewer_spillover ORDER BY teacher_id ASC, priority ASC`),
  ]);
  const masterBranches = new Set(users.rows.filter((r: any) => r.role === 'admin').map((r: any) => r.branch_id));
  const spill = new Map<string, string[]>();
  for (const l of links.rows) {
    const list = spill.get(l.teacher_id) ?? [];
    list.push(l.target_teacher_id);
    spill.set(l.teacher_id, list);
  }
  const info = new Map<string, ReviewerInfo>();
  const nodes: ReviewerNode[] = users.rows.map((r: any) => {
    const raw = r.entry_load_threshold === null || r.entry_load_threshold === undefined ? null : Number(r.entry_load_threshold);
    info.set(r.id, { name: r.name ?? '', role: r.role, branchId: r.branch_id, branchName: r.branch_name ?? null, rawThreshold: raw });
    return {
      id: r.id,
      branchId: r.branch_id,
      openLoad: Number(r.open_load ?? 0),
      threshold: effectiveThreshold(raw),
      awayUntil: toDate(r.review_away_until),
      spillTo: spill.get(r.id) ?? [],
      isMasterTeam: r.role === 'admin' || masterBranches.has(r.branch_id),
      isTeacher: r.role === 'teacher',
    };
  });
  return { nodes, info };
}

export const ASSIGN_ACTIONS = ['submission.assign', 'submission.divert', 'submission.forward', 'submission.claim'];

/** Everyone who has held this submission (from the audit trail) + the current holder. */
export async function previousAssignees(submissionId: string, current: (string | null)[], q: Tx = pool): Promise<Set<string>> {
  const ph = ASSIGN_ACTIONS.map((_, i) => `$${i + 2}`).join(', ');
  const { rows } = await q.query(
    `SELECT after_json FROM audit_log WHERE entity_type = 'submission' AND entity_id = $1 AND action IN (${ph})`,
    [submissionId, ...ASSIGN_ACTIONS],
  );
  const set = new Set<string>();
  for (const r of rows) {
    const after = parseJson<Record<string, unknown>>(r.after_json, {});
    if (after && typeof after.teacherId === 'string') set.add(after.teacherId);
  }
  for (const id of current) if (id) set.add(id);
  return set;
}

// ---------- Inbox ----------

export const INBOX_SELECT = `SELECT ${SUBMISSION_COLUMNS},
    u.name AS student_name, u.email AS student_email, u.tr_number AS student_tr, u.class_name AS student_class, b.name AS branch_name,
    ls.code AS step_code, ls.title AS step_title, ls.step_type, l.code AS level_code, l.order_index AS level_order,
    l.description AS level_description, c.code AS course_code, c.title AS course_title,
    (SELECT COUNT(*) FROM thread_messages tu
      WHERE tu.student_id = s.student_id AND tu.step_id = s.step_id AND tu.sender_role = 'student' AND tu.staff_read_at IS NULL) AS unread_for_staff
  FROM step_submissions s
  JOIN users u ON u.id = s.student_id
  LEFT JOIN branches b ON b.id = s.branch_id
  JOIN level_steps ls ON ls.id = s.step_id
  JOIN levels l ON l.id = s.level_id
  JOIN courses c ON c.id = s.course_id
  ${SUBMISSION_JOINS}`;

export function mapInboxRow(r: any, now: Date, last: InboxItem['lastMessage']): InboxItem {
  const created = toDate(r.created_at) ?? now;
  const open = OPEN_STATUSES.includes(r.status);
  const end = open ? now : toDate(r.reviewed_at) ?? now;
  return {
    submission: mapSubmission(r, { forStudent: false }),
    student: { id: r.student_id, name: r.student_name ?? '', email: r.student_email ?? '', trNumber: r.student_tr ?? null, className: r.student_class ?? null, branchName: r.branch_name ?? null },
    step: {
      id: r.step_id, code: r.step_code, title: r.step_title ?? '', stepType: r.step_type,
      levelCode: levelCodeOf(r.level_code, r.level_order), levelDescription: r.level_description ?? null,
      courseCode: r.course_code ?? null, courseTitle: r.course_title ?? '',
    },
    lastMessage: last,
    unreadForStaff: Number(r.unread_for_staff ?? 0),
    waitingHours: hoursBetween(created, end),
  };
}

/** Latest message per (student, step) pair. */
export async function loadLastMessages(pairs: { studentId: string; stepId: string }[]): Promise<Map<string, InboxItem['lastMessage']>> {
  const out = new Map<string, InboxItem['lastMessage']>();
  const unique = [...new Map(pairs.map(p => [`${p.studentId}|${p.stepId}`, p])).values()];
  for (let i = 0; i < unique.length; i += 200) {
    const chunk = unique.slice(i, i + 200);
    const params: string[] = [];
    const tuples = chunk.map(p => {
      params.push(p.studentId, p.stepId);
      return `($${params.length - 1}, $${params.length})`;
    }).join(', ');
    const { rows } = await pool.query(
      `SELECT tm.student_id, tm.step_id, tm.body, tm.kind, tm.created_at, tm.sender_role, u.name AS sender_name
         FROM thread_messages tm LEFT JOIN users u ON u.id = tm.sender_id
        WHERE (tm.student_id, tm.step_id) IN (${tuples})
        ORDER BY tm.created_at DESC`,
      params,
    );
    for (const r of rows) {
      const key = `${r.student_id}|${r.step_id}`;
      if (out.has(key)) continue;
      const m = mapMessage({ ...r, id: '', attachments: null, meta: null });
      out.set(key, { body: m.body, kind: m.kind, createdAt: m.createdAt, senderName: m.senderName });
    }
  }
  return out;
}

export async function loadInboxItems(where: string, params: unknown[], orderBy: string, limit = 300): Promise<InboxItem[]> {
  const { rows } = await pool.query(`${INBOX_SELECT} WHERE ${where} ORDER BY ${orderBy} LIMIT ${Math.max(1, Math.min(1000, limit))}`, params);
  const last = await loadLastMessages(rows.map((r: any) => ({ studentId: r.student_id, stepId: r.step_id })));
  const now = new Date();
  return rows.map((r: any) => mapInboxRow(r, now, last.get(`${r.student_id}|${r.step_id}`) ?? null));
}
