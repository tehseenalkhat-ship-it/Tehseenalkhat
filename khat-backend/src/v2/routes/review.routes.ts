import type { FastifyInstance, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { pool } from '../../db.js';
import type { Annotation, InboxItem, ReviewDecision, ReviewerLoad, ReviewerSettingsUpdate, ReviewNetwork, SpillTarget, Submission } from '../contracts.js';
import type { Actor } from '../lib/access.js';
import { canManageBranch, getActor, requireStaff } from '../lib/access.js';
import { getEffectivePolicies } from '../lib/policies.js';
import {
  applyDecision, branchReviewers, buildRing, DONE_STATUSES, hoursBetween, isAvailable, normalizePrintCode, OPEN_STATUSES, ReviewError,
} from '../lib/reviewLogic.js';
import type { ReviewerNode } from '../lib/reviewLogic.js';
import {
  canStaffSeeSubmission, clockNow, insertAudit, insertThreadMessage, isDuplicateKey, loadAnnotations, loadInboxItems,
  loadReviewerNodes, loadStepContext, loadSubmission, loadSubmissionRow, mapAnnotation, sanitisePins, sanitiseStrokes, toDate, withTransaction,
} from '../lib/threadData.js';
import { notifyStudentOfStaffMessage } from '../lib/threadNotify.js';
import { lookupSheetId, normalizeSheetId } from '../lib/sheetIds.js';
import { attemptsAllowed, EXTRA_ATTEMPT_MESSAGE, extraAttemptBlock } from '../lib/teacherLogic.js';

type InboxQuery = { status?: string; courseId?: string; q?: string; branchId?: string; courseType?: string };
type AnnotationBody = {
  submissionId?: string; fileStorageKey?: string; pageIndex?: number; strokes?: unknown; pins?: unknown; flattenedStorageKey?: string | null;
};

/** v3: the review queue is split by Certification / Mashq / Crash everywhere. */
export const COURSE_KINDS = ['certification', 'mashq', 'crash'] as const;
export type CourseKind = (typeof COURSE_KINDS)[number];
export function courseKindOf(courseType: unknown): CourseKind {
  const t = typeof courseType === 'string' ? courseType.trim().toLowerCase() : '';
  return (COURSE_KINDS as readonly string[]).includes(t) ? (t as CourseKind) : 'certification';
}

/** InboxItem + courseType (extra field; contracts.ts unchanged). */
async function withCourseKinds(items: InboxItem[]): Promise<(InboxItem & { courseType: CourseKind })[]> {
  const ids = [...new Set(items.map(i => i.submission.courseId))];
  const kinds = new Map<string, CourseKind>();
  if (ids.length) {
    const { rows } = await pool.query(`SELECT id, course_type FROM courses WHERE id IN (${ids.map((_, i) => `$${i + 1}`).join(', ')})`, ids);
    for (const r of rows) kinds.set(r.id, courseKindOf(r.course_type));
  }
  return items.map(i => ({ ...i, courseType: kinds.get(i.submission.courseId) ?? 'certification' }));
}

function bad(reply: FastifyReply, code: number, error: string) {
  return reply.code(code).send({ error });
}

/**
 * The spill-over web as the caller may see it. Master: everyone (or one branch + its links);
 * others: their own branch + teachers linked to it from/to other branches.
 */
async function buildNetwork(actor: Actor, branchFilter: string | null): Promise<ReviewNetwork> {
  const { nodes, info } = await loadReviewerNodes();
  const now = new Date();
  const byId = new Map(nodes.map(n => [n.id, n]));
  let visible: ReviewerNode[];
  if (!branchFilter) {
    visible = nodes;
  } else {
    const core = new Set(nodes.filter(n => n.branchId === branchFilter).map(n => n.id));
    const linked = new Set(core);
    for (const n of nodes) {
      if (core.has(n.id)) n.spillTo.forEach(t => linked.add(t));
      if (n.spillTo.some(t => core.has(t))) linked.add(n.id);
    }
    // admins of the branch only appear when linked; teachers always
    visible = nodes.filter(n => linked.has(n.id) && (n.isTeacher !== false || !core.has(n.id) || nodes.some(o => o.spillTo.includes(n.id))));
  }

  const { rows: open } = await pool.query(
    `SELECT assigned_teacher_id, branch_id, created_at FROM step_submissions
      WHERE status IN ('submitted', 'in_review') AND assigned_teacher_id IS NOT NULL LIMIT 20000`,
  );
  const divertHoursByBranch = new Map<string, number>();
  const divertHours = async (branchId: string) => {
    if (!divertHoursByBranch.has(branchId)) {
      const p = await getEffectivePolicies(branchId);
      divertHoursByBranch.set(branchId, Number(p['review.divert_after_hours']) || 72);
    }
    return divertHoursByBranch.get(branchId)!;
  };
  const overdue = new Map<string, number>();
  for (const r of open) {
    const created = toDate(r.created_at);
    if (created && hoursBetween(created, now) >= (await divertHours(r.branch_id))) {
      overdue.set(r.assigned_teacher_id, (overdue.get(r.assigned_teacher_id) ?? 0) + 1);
    }
  }

  const target = (id: string, priority: number): SpillTarget => {
    const i = info.get(id);
    return { teacherId: id, name: i?.name ?? 'Unknown', branchName: i?.branchName ?? null, priority };
  };
  const reviewers: ReviewerLoad[] = visible
    .map(n => {
      const i = info.get(n.id);
      return {
        teacherId: n.id,
        name: i?.name ?? '',
        branchId: n.branchId,
        branchName: i?.branchName ?? null,
        threshold: n.threshold,
        openNow: n.openLoad,
        overdueNow: overdue.get(n.id) ?? 0,
        awayUntil: n.awayUntil && n.awayUntil.getTime() > now.getTime() ? n.awayUntil.toISOString() : null,
        available: isAvailable(n, now),
        spillTo: n.spillTo.filter(t => byId.has(t)).map((t, idx) => target(t, idx + 1)),
        receivesFrom: nodes.filter(o => o.spillTo.includes(n.id)).map(o => target(o.id, o.spillTo.indexOf(n.id) + 1)),
      };
    })
    .sort((a, b) => (a.branchName ?? '').localeCompare(b.branchName ?? '') || a.name.localeCompare(b.name));

  const canEditTeacherIds = reviewers
    .filter(r => actor.isMaster || r.teacherId === actor.id || (actor.isBranchAdmin && r.branchId === actor.branchId))
    .map(r => r.teacherId);
  return { reviewers, canEditTeacherIds, canLinkAcrossBranches: actor.isMaster };
}

/** 'YYYY-MM-DD' = until the end of that day in Nairobi; full ISO kept; null clears. */
export function parseAwayUntil(value: unknown): Date | null | 'invalid' {
  if (value === null || value === '' ) return null;
  if (typeof value !== 'string') return 'invalid';
  const text = /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? `${value.trim()}T23:59:59+03:00` : value.trim();
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? 'invalid' : d;
}

function sendReviewError(reply: FastifyReply, error: unknown) {
  if (error instanceof ReviewError) return bad(reply, error.statusCode, error.message);
  throw error;
}

export async function reviewV2Routes(app: FastifyInstance): Promise<void> {
  const staff = { preHandler: [app.authenticate, requireStaff(app)] };

  // ---------- GET /v2/review/inbox ----------
  app.get<{ Querystring: InboxQuery }>('/review/inbox', staff, async (request, reply) => {
    const actor = await getActor(request);
    const { status = 'open', courseId, q, branchId } = request.query;
    const kind = typeof request.query.courseType === 'string' ? request.query.courseType.trim().toLowerCase() : '';
    if (kind && !COURSE_KINDS.includes(kind as CourseKind)) return bad(reply, 400, 'Course type must be certification, mashq or crash.');
    const conditions: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, ...values: unknown[]) => {
      let out = sql;
      for (const v of values) {
        params.push(v);
        out = out.replace('?', `$${params.length}`);
      }
      conditions.push(out);
    };

    if (status === 'open') conditions.push(`s.status IN ('submitted', 'in_review')`);
    else if (status === 'done') conditions.push(`s.status IN ('revision', 'passed', 'reviewed')`);
    else if (status !== 'all') return bad(reply, 400, 'Status must be open, done or all.');

    if (actor.isMaster) {
      if (branchId) add('s.branch_id = ?', branchId);
    } else {
      if (branchId && branchId !== actor.branchId) return bad(reply, 403, 'You can only see your own branch.');
      // the shared branch inbox + anything forwarded to me personally
      add('(s.branch_id = ? OR s.assigned_teacher_id = ?)', actor.branchId, actor.id);
    }
    if (courseId) add('s.course_id = ?', courseId);
    if (kind) add(`COALESCE(c.course_type, 'certification') = ?`, kind);
    const term = typeof q === 'string' ? q.trim().slice(0, 100) : '';
    if (term) {
      const like = `%${term.replace(/[\\%_]/g, m => `\\${m}`)}%`;
      const code = normalizePrintCode(term);
      add('(u.name LIKE ? OR u.tr_number LIKE ? OR c.code LIKE ? OR c.title LIKE ? OR ls.title LIKE ? OR s.print_code = ?)', like, like, like, like, like, code ?? term.toUpperCase());
    }
    const where = conditions.length ? conditions.join(' AND ') : '1 = 1';
    const orderBy = status === 'open' ? 's.created_at ASC, s.id ASC' : 'COALESCE(s.reviewed_at, s.created_at) DESC, s.id ASC';
    const items: InboxItem[] = await loadInboxItems(where, params, orderBy, status === 'open' ? 500 : 300);
    return withCourseKinds(items);
  });

  // ---------- GET /v2/review/by-code/:printCode ----------
  app.get<{ Params: { printCode: string } }>('/review/by-code/:printCode', staff, async (request, reply) => {
    const actor = await getActor(request);
    const typed = decodeURIComponent(request.params.printCode ?? '');
    // A sheet ID (FQ-XXXXXX, printed on every stamped page) works as well as the print code.
    const sheet = normalizeSheetId(typed) ? await lookupSheetId(typed) : null;
    const code = sheet?.printCode ? normalizePrintCode(sheet.printCode) : normalizePrintCode(typed);
    if (!code && sheet?.submissionId) {
      const bySheet = await loadInboxItems('s.id = $1', [sheet.submissionId], 's.created_at ASC', 1);
      if (bySheet[0]) {
        const { rows } = await pool.query(`SELECT branch_id, assigned_teacher_id FROM step_submissions WHERE id = $1`, [bySheet[0].submission.id]);
        if (!rows[0] || !canStaffSeeSubmission(actor, rows[0].branch_id, rows[0].assigned_teacher_id)) return bad(reply, 403, 'This work belongs to another branch.');
        return (await withCourseKinds(bySheet))[0];
      }
    }
    if (!code && normalizeSheetId(typed)) return bad(reply, 404, `No sheet was found for ${normalizeSheetId(typed)}. Please check the Sheet ID printed on the page.`);
    if (!code) return bad(reply, 400, 'That code does not look right — it should look like TK-7F3K2 or FQ-7K3M2A.');
    const items = await loadInboxItems('s.print_code = $1', [code], 's.created_at ASC', 1);
    const item = items[0];
    if (!item) return bad(reply, 404, `No work was found for ${code}. Please check the code on the printed page.`);
    const { rows } = await pool.query(`SELECT branch_id, assigned_teacher_id FROM step_submissions WHERE id = $1`, [item.submission.id]);
    if (!rows[0] || !canStaffSeeSubmission(actor, rows[0].branch_id, rows[0].assigned_teacher_id)) {
      return bad(reply, 403, 'This work belongs to another branch.');
    }
    return (await withCourseKinds([item]))[0];
  });

  // ---------- POST /v2/review/submissions/:id/extra-attempt (v3: "Give one more attempt") ----------
  app.post<{ Params: { id: string }; Body: { note?: string | null } }>('/review/submissions/:id/extra-attempt', staff, async (request, reply) => {
    const actor = await getActor(request);
    const row = await loadSubmissionRow(request.params.id);
    if (!row) return bad(reply, 404, 'This submission could not be found.');
    if (!canStaffSeeSubmission(actor, row.branch_id, row.assigned_teacher_id ?? null)) return bad(reply, 403, 'This work belongs to another branch.');
    const ctx = await loadStepContext(row.step_id);
    if (!ctx) return bad(reply, 404, 'The step for this work no longer exists.');
    const { rows: subs } = await pool.query(
      `SELECT status FROM step_submissions WHERE student_id = $1 AND step_id = $2`, [row.student_id, row.step_id],
    );
    const hasMarks = Boolean(ctx.hasMarks ?? ['assessment', 'final_submission'].includes(ctx.stepType));
    const block = extraAttemptBlock({
      hasMarks,
      passed: subs.some((r: any) => r.status === 'passed'),
      open: subs.some((r: any) => OPEN_STATUSES.includes(r.status)),
    });
    if (block) return bad(reply, 409, block);
    const note = typeof request.body?.note === 'string' && request.body.note.trim() ? request.body.note.trim().slice(0, 500) : null;
    const { rows: people } = await pool.query(`SELECT name FROM users WHERE id = $1`, [row.student_id]);
    const studentFirst = String(people[0]?.name ?? '').split(/\s+/)[0];
    const body = note ?? EXTRA_ATTEMPT_MESSAGE(studentFirst, actor.name.split(/\s+/)[0]);
    const messageId = await withTransaction(async client => {
      await client.query(
        `INSERT INTO attempt_grants (id, student_id, step_id, granted_by, note) VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), row.student_id, row.step_id, actor.id, note],
      );
      const id = await insertThreadMessage(client, {
        studentId: row.student_id, stepId: row.step_id, courseId: row.course_id, branchId: row.branch_id,
        senderId: actor.id, senderRole: actor.role === 'admin' ? 'admin' : 'teacher', kind: 'text',
        body, attachments: [], submissionId: row.id, meta: { extraAttempt: true }, staffRead: true,
      });
      await insertAudit(client, {
        actorId: actor.id, branchId: row.branch_id, action: 'submission.extra_attempt', entityType: 'submission', entityId: row.id,
        summary: `One more attempt given — ${ctx.courseLabelShort} ${ctx.levelCode} ${ctx.code}`,
        before: null, after: { studentId: row.student_id, stepId: row.step_id, note },
      });
      return id;
    });
    const { rows: g } = await pool.query(`SELECT COUNT(*) AS n FROM attempt_grants WHERE student_id = $1 AND step_id = $2`, [row.student_id, row.step_id]);
    const policies = await getEffectivePolicies(row.branch_id);
    await notifyStudentOfStaffMessage({
      studentId: row.student_id, branchId: row.branch_id, stepId: row.step_id, courseId: row.course_id, submissionId: row.id, messageId,
      kind: 'reply', comment: body, stepLabel: `${ctx.courseLabelShort} ${ctx.levelCode} ${ctx.code}`, courseTitle: ctx.courseTitle,
    }).catch(err => request.log.error(err));
    return { ok: true, extraAttempts: Number(g[0]?.n ?? 1), attemptsAllowed: attemptsAllowed(policies['assessment.max_attempts'], Number(g[0]?.n ?? 1)), message: `${studentFirst || 'The student'} can now send this step once more.` };
  });

  // ---------- POST /v2/review/submissions/:id/claim ----------
  app.post<{ Params: { id: string } }>('/review/submissions/:id/claim', staff, async (request, reply) => {
    const actor = await getActor(request);
    const id = request.params.id;
    try {
      await withTransaction(async client => {
        const { rows } = await client.query(`SELECT * FROM step_submissions WHERE id = $1 FOR UPDATE`, [id]);
        const sub = rows[0];
        if (!sub) throw new ReviewError(404, 'This submission could not be found.');
        if (!canStaffSeeSubmission(actor, sub.branch_id, sub.assigned_teacher_id)) throw new ReviewError(403, 'This work belongs to another branch.');
        if (DONE_STATUSES.includes(sub.status)) {
          throw new ReviewError(409, 'This work has already been answered. You can still change the mark from the conversation.');
        }
        if (sub.status === 'in_review' && sub.claimed_by === actor.id) return; // already mine
        if (sub.status === 'in_review' && sub.claimed_by && sub.claimed_by !== actor.id) {
          const policies = await getEffectivePolicies(sub.branch_id);
          const staleHours = Number(policies['review.divert_after_hours']) || 72;
          const claimedAt = toDate(sub.claimed_at);
          const stale = !claimedAt || Date.now() - claimedAt.getTime() >= staleHours * 3_600_000;
          if (!stale) {
            const { rows: who } = await client.query(`SELECT name FROM users WHERE id = $1`, [sub.claimed_by]);
            throw new ReviewError(409, `${who[0]?.name ?? 'Another teacher'} is already reviewing this work.`);
          }
        }
        const now = clockNow();
        await client.query(
          `UPDATE step_submissions
              SET status = 'in_review', claimed_by = $1, claimed_at = $2, assigned_teacher_id = $1, assigned_at = $2
            WHERE id = $3`,
          [actor.id, now, id],
        );
        await insertAudit(client, {
          actorId: actor.id, branchId: sub.branch_id, action: 'submission.claim', entityType: 'submission', entityId: id,
          summary: `${actor.name || 'A teacher'} started reviewing (print code ${sub.print_code ?? '—'})`,
          before: { status: sub.status, assignedTeacherId: sub.assigned_teacher_id, claimedBy: sub.claimed_by },
          after: { teacherId: actor.id, status: 'in_review' },
        });
      });
    } catch (error) {
      return sendReviewError(reply, error);
    }
    return (await loadSubmission(id, { forStudent: false })) as Submission;
  });

  // ---------- POST /v2/review/submissions/:id/decision ----------
  app.post<{ Params: { id: string }; Body: ReviewDecision }>('/review/submissions/:id/decision', staff, async (request, reply) => {
    const actor = await getActor(request);
    const id = request.params.id;
    const row = await loadSubmissionRow(id);
    if (!row) return bad(reply, 404, 'This submission could not be found.');
    if (!canStaffSeeSubmission(actor, row.branch_id, row.assigned_teacher_id)) return bad(reply, 403, 'This work belongs to another branch.');
    const body = (request.body && typeof request.body === 'object' ? request.body : {}) as ReviewDecision;
    try {
      const submission = await applyDecision(id, {
        mark: body.mark ?? null,
        rubric: body.rubric ?? null,
        comment: typeof body.comment === 'string' ? body.comment : null,
        ...(body.status === 'reviewed' ? { status: 'reviewed' as const } : {}),
      }, { id: actor.id, name: actor.name, role: actor.role });
      return submission;
    } catch (error) {
      return sendReviewError(reply, error);
    }
  });

  // ---------- GET /v2/review/network?branchId= ----------
  app.get<{ Querystring: { branchId?: string } }>('/review/network', staff, async (request, reply) => {
    const actor = await getActor(request);
    const requested = request.query.branchId || null;
    if (!actor.isMaster && requested && requested !== actor.branchId) return bad(reply, 403, 'You can only see your own branch.');
    return buildNetwork(actor, actor.isMaster ? requested : actor.branchId);
  });

  // ---------- PUT /v2/review/network/:teacherId ----------
  app.put<{ Params: { teacherId: string }; Body: ReviewerSettingsUpdate }>('/review/network/:teacherId', staff, async (request, reply) => {
    const actor = await getActor(request);
    const teacherId = request.params.teacherId;
    const body = (request.body && typeof request.body === 'object' ? request.body : {}) as ReviewerSettingsUpdate;
    const { nodes, info } = await loadReviewerNodes();
    const node = nodes.find(n => n.id === teacherId);
    if (!node) return bad(reply, 404, 'This teacher could not be found.');
    if (!(actor.id === teacherId || canManageBranch(actor, node.branchId))) {
      return bad(reply, 403, 'You can change your own limit and overflow list; branch admins can change their branch.');
    }

    let threshold: number | undefined;
    if (body.threshold !== undefined) {
      const t = Number(body.threshold);
      if (!Number.isInteger(t) || t < 1 || t > 200) return bad(reply, 400, 'The limit must be a whole number from 1 to 200.');
      threshold = t;
    }
    let awayUntil: Date | null | undefined;
    if (body.awayUntil !== undefined) {
      const parsed = parseAwayUntil(body.awayUntil);
      if (parsed === 'invalid') return bad(reply, 400, 'Please choose a valid date for "away until".');
      awayUntil = parsed;
    }
    let spillTo: string[] | undefined;
    if (body.spillTo !== undefined) {
      if (!Array.isArray(body.spillTo)) return bad(reply, 400, 'Please choose who to send your overflow to.');
      const ids = [...new Set(body.spillTo.filter((v): v is string => typeof v === 'string'))].filter(id => id !== teacherId);
      if (ids.length > 10) return bad(reply, 400, 'Please choose at most 10 people to send overflow to.');
      for (const id of ids) {
        const t = nodes.find(n => n.id === id);
        if (!t) return bad(reply, 400, 'One of the chosen teachers could not be found.');
        const crossBranch = t.branchId !== node.branchId;
        if (crossBranch && !actor.isMaster && !node.spillTo.includes(id)) {
          return bad(reply, 403, `Only the master team can link to teachers of another branch (${info.get(id)?.name ?? 'this teacher'}).`);
        }
      }
      spillTo = ids;
    }

    await withTransaction(async client => {
      if (threshold !== undefined) await client.query(`UPDATE users SET entry_load_threshold = $1 WHERE id = $2`, [threshold, teacherId]);
      if (awayUntil !== undefined) await client.query(`UPDATE users SET review_away_until = $1 WHERE id = $2`, [awayUntil, teacherId]);
      if (spillTo !== undefined) {
        await client.query(`DELETE FROM reviewer_spillover WHERE teacher_id = $1`, [teacherId]);
        for (let i = 0; i < spillTo.length; i++) {
          await client.query(
            `INSERT INTO reviewer_spillover (teacher_id, target_teacher_id, priority, created_by) VALUES ($1, $2, $3, $4)`,
            [teacherId, spillTo[i], i + 1, actor.id],
          );
        }
      }
      await insertAudit(client, {
        actorId: actor.id, branchId: node.branchId, action: 'reviewer.settings', entityType: 'reviewer', entityId: teacherId,
        summary: `Review settings changed for ${info.get(teacherId)?.name ?? 'teacher'}`
          + `${threshold !== undefined ? ` · limit ${threshold}` : ''}`
          + `${awayUntil !== undefined ? (awayUntil ? ` · away until ${awayUntil.toISOString().slice(0, 10)}` : ' · back from away') : ''}`
          + `${spillTo !== undefined ? ` · overflow to ${spillTo.map(id => info.get(id)?.name ?? '?').join(', ') || 'nobody (default)'}` : ''}`,
        before: { threshold: info.get(teacherId)?.rawThreshold ?? null, awayUntil: node.awayUntil?.toISOString() ?? null, spillTo: node.spillTo },
        after: { threshold, awayUntil: awayUntil === undefined ? undefined : awayUntil?.toISOString() ?? null, spillTo },
      });
    });

    const network = await buildNetwork({ ...actor, isMaster: true } as Actor, null);
    const me = network.reviewers.find(r => r.teacherId === teacherId);
    return me as ReviewerLoad;
  });

  // ---------- POST /v2/review/network/auto {branchId, threshold?, includeNairobi} ----------
  app.post<{ Body: { branchId?: string; threshold?: number | null; includeNairobi?: boolean } }>('/review/network/auto', staff, async (request, reply) => {
    const actor = await getActor(request);
    const branchId = request.body?.branchId || (actor.isBranchAdmin ? actor.branchId : '');
    if (!branchId) return bad(reply, 400, 'Please choose a branch.');
    if (!canManageBranch(actor, branchId)) return bad(reply, 403, 'Only the branch admin of this branch or the master team can do this.');
    let threshold: number | null = null;
    if (request.body?.threshold !== undefined && request.body?.threshold !== null) {
      const t = Number(request.body.threshold);
      if (!Number.isInteger(t) || t < 1 || t > 200) return bad(reply, 400, 'The limit must be a whole number from 1 to 200.');
      threshold = t;
    }
    const includeNairobi = request.body?.includeNairobi !== false;

    const { nodes, info } = await loadReviewerNodes();
    const teachers = branchReviewers(nodes, branchId).sort((a, b) => (info.get(a.id)?.name ?? '').localeCompare(info.get(b.id)?.name ?? ''));
    if (!teachers.length) return bad(reply, 400, 'This branch has no teachers yet.');
    const isMasterBranch = teachers.some(t => t.isMasterTeam);
    const lastStops = includeNairobi && !isMasterBranch
      ? nodes
        .filter(n => n.isMasterTeam && n.branchId !== branchId)
        .sort((a, b) => Number(b.isTeacher !== false) - Number(a.isTeacher !== false) || (info.get(a.id)?.name ?? '').localeCompare(info.get(b.id)?.name ?? ''))
        .slice(0, 3)
        .map(n => n.id)
      : [];
    const ring = buildRing(teachers.map(t => t.id), lastStops);

    await withTransaction(async client => {
      for (const [teacherId, targets] of ring) {
        await client.query(`DELETE FROM reviewer_spillover WHERE teacher_id = $1`, [teacherId]);
        for (let i = 0; i < targets.length; i++) {
          await client.query(
            `INSERT INTO reviewer_spillover (teacher_id, target_teacher_id, priority, created_by) VALUES ($1, $2, $3, $4)`,
            [teacherId, targets[i], i + 1, actor.id],
          );
        }
        if (threshold !== null) await client.query(`UPDATE users SET entry_load_threshold = $1 WHERE id = $2`, [threshold, teacherId]);
      }
      await insertAudit(client, {
        actorId: actor.id, branchId, action: 'reviewer.auto_network', entityType: 'reviewer', entityId: branchId,
        summary: `Branch review network set up automatically for ${teachers.length} teacher${teachers.length === 1 ? '' : 's'}`
          + `${lastStops.length ? ' · Nairobi team as last stop' : ''}${threshold !== null ? ` · same limit ${threshold} for everyone` : ''}`,
        before: { links: teachers.map(t => ({ teacherId: t.id, spillTo: t.spillTo, threshold: info.get(t.id)?.rawThreshold ?? null })) },
        after: { links: [...ring].map(([teacherId, spillTo]) => ({ teacherId, spillTo })), threshold },
      });
    });
    return buildNetwork(actor, actor.isMaster ? branchId : actor.branchId);
  });

  // ---------- PUT /v2/annotations ----------
  app.put<{ Body: AnnotationBody }>('/annotations', staff, async (request, reply) => {
    const actor = await getActor(request);
    const body = request.body ?? {};
    const submissionId = typeof body.submissionId === 'string' ? body.submissionId : '';
    const fileKey = typeof body.fileStorageKey === 'string' ? body.fileStorageKey.trim() : '';
    const pageIndex = Number(body.pageIndex ?? 0);
    if (!submissionId) return bad(reply, 400, 'Please choose the submission to annotate.');
    if (!fileKey || fileKey.length > 512 || fileKey.includes('..')) return bad(reply, 400, 'Please choose the page to annotate.');
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex > 999) return bad(reply, 400, 'The page number is not valid.');
    const flattened = typeof body.flattenedStorageKey === 'string' && body.flattenedStorageKey.trim() && !body.flattenedStorageKey.includes('..')
      ? body.flattenedStorageKey.trim().slice(0, 1000) : null;
    const strokes = sanitiseStrokes(body.strokes);
    const pins = sanitisePins(body.pins);

    const sub = await loadSubmissionRow(submissionId);
    if (!sub) return bad(reply, 404, 'This submission could not be found.');
    if (!canStaffSeeSubmission(actor, sub.branch_id, sub.assigned_teacher_id)) return bad(reply, 403, 'This work belongs to another branch.');
    const ctx = await loadStepContext(sub.step_id);
    if (!ctx) return bad(reply, 404, 'The step for this submission no longer exists.');
    if (!ctx.hasMarks && ctx.feedbackMode === 'none') return bad(reply, 400, 'This step does not take teacher feedback.');

    const voiceNotes = pins.filter(p => p.voiceStorageKey).length;
    const messageBody = `Corrections marked on page ${pageIndex + 1}${pins.length ? ` · ${pins.length} note${pins.length === 1 ? '' : 's'}` : ''}${voiceNotes ? ` (${voiceNotes} voice)` : ''}`;
    const attachments = flattened ? [{ storageKey: flattened, originalFilename: `corrections-page-${pageIndex + 1}.png`, contentType: 'image/png', forStepId: sub.step_id }] : [];
    const meta = { pageIndex, fileStorageKey: fileKey, pins: pins.length, voiceNotes, strokes: strokes.length };

    let annotationId = '';
    let newMessageId: string | null = null;
    const save = () => withTransaction(async client => {
      const now = clockNow();
      const { rows: existing } = await client.query(
        `SELECT id FROM annotations WHERE submission_id = $1 AND file_storage_key = $2 AND page_index = $3 FOR UPDATE`,
        [submissionId, fileKey, pageIndex],
      );
      if (existing[0]) {
        annotationId = existing[0].id;
        await client.query(
          `UPDATE annotations SET strokes = $1, pins = $2, flattened_storage_key = $3, updated_at = $4 WHERE id = $5`,
          [JSON.stringify(strokes), JSON.stringify(pins), flattened, now, annotationId],
        );
      } else {
        annotationId = randomUUID();
        await client.query(
          `INSERT INTO annotations (id, submission_id, file_storage_key, page_index, strokes, pins, flattened_storage_key, created_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
          [annotationId, submissionId, fileKey, pageIndex, JSON.stringify(strokes), JSON.stringify(pins), flattened, actor.id, now],
        );
      }
      const { rows: msg } = await client.query(`SELECT id FROM thread_messages WHERE annotation_id = $1 LIMIT 1`, [annotationId]);
      if (msg[0]) {
        await client.query(
          `UPDATE thread_messages SET body = $1, attachments = $2, meta = $3, student_read_at = NULL WHERE id = $4`,
          [messageBody, JSON.stringify(attachments), JSON.stringify(meta), msg[0].id],
        );
        newMessageId = null;
      } else {
        newMessageId = await insertThreadMessage(client, {
          studentId: sub.student_id, stepId: sub.step_id, courseId: sub.course_id, branchId: sub.branch_id,
          senderId: actor.id, senderRole: actor.role === 'admin' ? 'admin' : 'teacher', kind: 'annotation',
          body: messageBody, attachments, submissionId, annotationId, meta, staffRead: true, createdAt: now,
        });
      }
      if (OPEN_STATUSES.includes(sub.status)) {
        await client.query(`UPDATE step_submissions SET first_response_at = COALESCE(first_response_at, $1) WHERE id = $2`, [now, submissionId]);
      }
    });
    try {
      await save();
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      await save(); // a parallel save created the row first — now it updates
    }

    if (newMessageId) {
      await notifyStudentOfStaffMessage({
        studentId: sub.student_id, branchId: sub.branch_id, stepId: sub.step_id, courseId: sub.course_id, submissionId,
        messageId: newMessageId, kind: 'annotation',
        stepLabel: `${ctx.courseLabelShort} ${ctx.levelCode} ${ctx.code}${ctx.title ? ` — ${ctx.title}` : ''}`, courseTitle: ctx.courseTitle,
      });
    }
    const { rows } = await pool.query(
      `SELECT id, submission_id, file_storage_key, page_index, strokes, pins, flattened_storage_key, created_by, created_at, updated_at
         FROM annotations WHERE id = $1`,
      [annotationId],
    );
    return mapAnnotation(rows[0]) as Annotation;
  });

  // ---------- GET /v2/annotations?submissionId= ----------
  app.get<{ Querystring: { submissionId?: string } }>('/annotations', { preHandler: [app.authenticate] }, async (request, reply) => {
    const actor = await getActor(request);
    const submissionId = request.query.submissionId;
    if (!submissionId) return bad(reply, 400, 'Please choose a submission.');
    const sub = await loadSubmissionRow(submissionId);
    if (!sub) return bad(reply, 404, 'This submission could not be found.');
    const allowed = actor.role === 'student' ? sub.student_id === actor.id : canStaffSeeSubmission(actor, sub.branch_id, sub.assigned_teacher_id);
    if (!allowed) return bad(reply, 403, 'Not allowed.');
    return (await loadAnnotations([submissionId])) as Annotation[];
  });
}
