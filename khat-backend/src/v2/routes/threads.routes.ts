import type { FastifyInstance, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { pool } from '../../db.js';
import type { Attachment, Submission, ThreadMessage, ThreadResponse } from '../contracts.js';
import { getActor } from '../lib/access.js';
import { getEffectivePolicies } from '../lib/policies.js';
import { chooseInitialAssignee, generatePrintCode, OPEN_STATUSES } from '../lib/reviewLogic.js';
import {
  clockNow, insertAudit, insertThreadMessage, isDuplicateKey, isThreadStep, loadAnnotations, loadMessage, loadReviewerNodes, loadStepContext, loadStudent, loadSubmission, mapMessage, mapSubmission,
  sanitiseAttachments, staffCanSeeThread, stepSummary, studentSummary, SUBMISSION_COLUMNS, SUBMISSION_JOINS, withTransaction,
} from '../lib/threadData.js';
import type { StepContext } from '../lib/threadData.js';
import { notifyStaffOfNewWork, notifyStudentOfStaffMessage, recentFacultyCopy } from '../lib/threadNotify.js';
import { queueEmail } from '../lib/emailTemplates.js';
import { courseKindLabel, friendlyStepLabel, friendlyThreadLabel, MEET_REQUEST_TEXT, numberFromCode, sanitiseVoiceMeta, shouldEmailStaff } from '../lib/chatLogic.js';
import { CHAT_SIGN_OFF, chatLink, sendChatEmail } from '../lib/chatEmail.js';

type MessageBody = { studentId?: string; kind?: string; body?: string | null; attachments?: unknown; meta?: unknown };
type MeetBody = { studentId?: string; note?: string | null };
type SubmitBody = { files?: unknown; note?: string | null };

const UUIDish = /^[0-9a-f-]{8,36}$/i;

function bad(reply: FastifyReply, code: number, error: string) {
  return reply.code(code).send({ error });
}

/** Plain words for emails/notifications: "Fann al-Khat 1, Level 1 · Step 2 — Two-letter joins" (no codes). */
function stepLabel(ctx: StepContext): string {
  return friendlyThreadLabel({ courseTitle: ctx.courseTitle, levelCode: ctx.levelCode, levelOrder: ctx.levelOrder, code: ctx.code, title: ctx.title, courseType: ctx.courseType });
}

/** Extra, non-contract fields on ThreadResponse.step for friendlier headers (v3 chat). */
function stepExtras(ctx: StepContext) {
  const levelNumber = numberFromCode(ctx.levelCode, ctx.levelOrder);
  const stepNumber = numberFromCode(ctx.code, null);
  const hideLevel = (ctx.courseType ?? '') !== 'certification' && levelNumber === 1;
  return {
    courseType: ctx.courseType,
    courseKind: courseKindLabel(ctx.courseType),
    levelNumber,
    stepNumber,
    friendlyLabel: friendlyStepLabel({ levelCode: ctx.levelCode, levelOrder: ctx.levelOrder, stepCode: ctx.code, title: ctx.title, hideLevel }),
    hasMarks: Boolean(ctx.hasMarks ?? ['assessment', 'final_submission'].includes(ctx.stepType)),
  };
}

/** Faculty copy (owner note 3.10): tell the responsible teacher, at most once per 30 minutes per thread. */
async function emailFaculty(opts: { teacherId: string | null; excludeId: string; submissionId?: string | null; studentName: string; ctx: StepContext; studentId: string; preview: string; fromStudent: boolean; since: Date | null }) {
  if (!opts.teacherId || opts.teacherId === opts.excludeId) return;
  if (!shouldEmailStaff(opts.since, new Date(), 30)) return;
  const { rows } = await pool.query(`SELECT name, email FROM users WHERE id = $1 AND deleted_at IS NULL`, [opts.teacherId]);
  const t = rows[0];
  if (!t) return;
  const label = stepLabel(opts.ctx);
  // v3 integration: a staff reply right after a mark (or a second colleague reply) → one faculty copy, not two.
  const refId = opts.submissionId ?? `${opts.ctx.id}`;
  if (!opts.fromStudent && t.email && (await recentFacultyCopy(t.email, refId))) return;
  if (!opts.fromStudent && t.email) {
    await queueEmail(t.email, 'teacher_reply', {
      staffName: t.name,
      subject: `A colleague replied to ${opts.studentName} — ${label}`,
      text: [`Salaam ${String(t.name ?? '').split(/\s+/)[0]},`, '', `A teacher of your branch replied to ${opts.studentName} about ${label}:`, '', `"${opts.preview.slice(0, 600)}"`, '', chatLink(opts.submissionId ? `v2-inbox?submissionId=${opts.submissionId}` : 'v2-inbox'), '', CHAT_SIGN_OFF].join('\n'),
    }, { refType: 'faculty_copy', refId });
    return;
  }
  await sendChatEmail(t.email, 'teacher_reply', { staffName: t.name, studentName: opts.studentName, step: label, message: opts.preview, link: chatLink(opts.submissionId ? `v2-inbox?submissionId=${opts.submissionId}` : 'v2-inbox') }, {
    subject: opts.fromStudent ? `${opts.studentName} wrote about ${label}` : `A colleague replied to ${opts.studentName} — ${label}`,
    text: [`Salaam ${String(t.name ?? '').split(/\s+/)[0]},`, '', opts.fromStudent ? `${opts.studentName} wrote about ${label}:` : `A teacher of your branch replied to ${opts.studentName} about ${label}:`, '', `"${opts.preview.slice(0, 600)}"`, '', chatLink(opts.submissionId ? `v2-inbox?submissionId=${opts.submissionId}` : 'v2-inbox'), '', CHAT_SIGN_OFF].join('\n'),
  });
}

function takesFeedback(ctx: StepContext): boolean {
  if (ctx.hasMarks) return true;
  if (ctx.feedbackMode) return ctx.feedbackMode !== 'none';
  return isThreadStep(ctx);
}

export async function threadsV2Routes(app: FastifyInstance): Promise<void> {
  // ---------- GET /v2/threads/:stepId?studentId= ----------
  app.get<{ Params: { stepId: string }; Querystring: { studentId?: string } }>(
    '/threads/:stepId',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const actor = await getActor(request);
      const { stepId } = request.params;
      if (!UUIDish.test(stepId)) return bad(reply, 404, 'This step could not be found.');
      const ctx = await loadStepContext(stepId);
      if (!ctx) return bad(reply, 404, 'This step could not be found.');

      let studentId: string;
      if (actor.role === 'student') {
        if (request.query.studentId && request.query.studentId !== actor.id) return bad(reply, 403, 'You can only open your own conversations.');
        studentId = actor.id;
      } else if (actor.isStaff) {
        if (!request.query.studentId) return bad(reply, 400, 'Please choose a student.');
        studentId = request.query.studentId;
      } else {
        return bad(reply, 403, 'Not allowed.');
      }
      const student = await loadStudent(studentId);
      if (!student || student.role !== 'student') return bad(reply, 404, 'This student could not be found.');
      if (actor.isStaff && !(await staffCanSeeThread(actor, student.branchId, studentId, stepId))) {
        return bad(reply, 403, 'This student belongs to another branch.');
      }

      const forStudent = actor.role === 'student';
      const [msgRes, subRes] = await Promise.all([
        pool.query(
          `SELECT tm.*, u.name AS sender_name FROM thread_messages tm LEFT JOIN users u ON u.id = tm.sender_id
            WHERE tm.student_id = $1 AND tm.step_id = $2 ORDER BY tm.created_at ASC, tm.id ASC LIMIT 2000`,
          [studentId, stepId],
        ),
        pool.query(
          `SELECT ${SUBMISSION_COLUMNS} FROM step_submissions s ${SUBMISSION_JOINS}
            WHERE s.student_id = $1 AND s.step_id = $2 ORDER BY s.attempt_no ASC, s.created_at ASC`,
          [studentId, stepId],
        ),
      ]);
      const submissions = subRes.rows.map((r: any) => mapSubmission(r, { forStudent }));
      const annotations = await loadAnnotations(submissions.map(s => s.id));

      // mark as read for the caller (after reading, so the client can still show what was new)
      const now = new Date();
      if (forStudent) {
        await pool.query(
          `UPDATE thread_messages SET student_read_at = $1
            WHERE student_id = $2 AND step_id = $3 AND student_read_at IS NULL AND sender_role <> 'student'`,
          [now, studentId, stepId],
        );
      } else {
        await pool.query(
          `UPDATE thread_messages SET staff_read_at = $1
            WHERE student_id = $2 AND step_id = $3 AND staff_read_at IS NULL AND sender_role = 'student'`,
          [now, studentId, stepId],
        );
      }

      const response: ThreadResponse = {
        student: studentSummary(student),
        step: { ...stepSummary(ctx), ...stepExtras(ctx) } as ThreadResponse['step'],
        messages: msgRes.rows.map(mapMessage),
        submissions,
        annotations,
        canReview: actor.isStaff && takesFeedback(ctx),
      };
      return response;
    },
  );

  // ---------- POST /v2/threads/:stepId/messages ----------
  app.post<{ Params: { stepId: string }; Body: MessageBody }>(
    '/threads/:stepId/messages',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const actor = await getActor(request);
      const { stepId } = request.params;
      const body = request.body ?? {};
      const ctx = UUIDish.test(stepId) ? await loadStepContext(stepId) : null;
      if (!ctx) return bad(reply, 404, 'This step could not be found.');
      if (!isThreadStep(ctx) || !takesFeedback(ctx)) {
        return bad(reply, 400, 'This step is practice only — there is no conversation here. Just mark it as done when finished.');
      }

      let studentId: string;
      if (actor.role === 'student') {
        if (body.studentId && body.studentId !== actor.id) return bad(reply, 403, 'You can only write in your own conversations.');
        studentId = actor.id;
      } else if (actor.isStaff) {
        if (!body.studentId) return bad(reply, 400, 'Please choose a student.');
        studentId = body.studentId;
      } else {
        return bad(reply, 403, 'Not allowed.');
      }
      const student = await loadStudent(studentId);
      if (!student || student.role !== 'student') return bad(reply, 404, 'This student could not be found.');
      if (actor.isStaff && !(await staffCanSeeThread(actor, student.branchId, studentId, stepId))) {
        return bad(reply, 403, 'This student belongs to another branch.');
      }

      const kind = body.kind;
      if (kind !== 'text' && kind !== 'files' && kind !== 'voice') return bad(reply, 400, 'Please send a text, files or a voice note.');
      const text = typeof body.body === 'string' ? body.body.trim() : '';
      if (text.length > 4000) return bad(reply, 400, 'This message is too long — please keep it under 4000 characters.');
      const attachments = sanitiseAttachments(body.attachments, 20);
      if (kind === 'text' && !text) return bad(reply, 400, 'Please write a message first.');
      if (kind === 'files' && attachments.length === 0) return bad(reply, 400, 'Please attach at least one file.');
      if (kind === 'voice' && attachments.length !== 1) return bad(reply, 400, 'Please attach one voice recording.');

      const meta: Record<string, unknown> = kind === 'voice' ? sanitiseVoiceMeta(body.meta) : {};

      const isStaff = actor.isStaff;
      const { rows: latestRows } = await pool.query(
        `SELECT id, status, assigned_teacher_id FROM step_submissions
          WHERE student_id = $1 AND step_id = $2 ORDER BY attempt_no DESC, created_at DESC LIMIT 1`,
        [studentId, stepId],
      );
      const latest = latestRows[0] ?? null;
      const { rows: prevRows } = await pool.query(
        `SELECT created_at FROM thread_messages WHERE student_id = $1 AND step_id = $2 AND sender_role = 'student' ORDER BY created_at DESC LIMIT 1`,
        [studentId, stepId],
      );
      const prevStudentAt = prevRows[0]?.created_at ? new Date(prevRows[0].created_at) : null;

      const messageId = await withTransaction(async client => {
        const at = clockNow();
        const id = await insertThreadMessage(client, {
          studentId, stepId, courseId: ctx.courseId, branchId: student.branchId,
          senderId: actor.id, senderRole: isStaff ? (actor.role === 'admin' ? 'admin' : 'teacher') : 'student',
          kind, body: text || null, attachments, submissionId: latest?.id ?? null, meta,
          staffRead: isStaff, studentRead: !isStaff, createdAt: at,
        });
        if (isStaff && latest && OPEN_STATUSES.includes(latest.status)) {
          await client.query(
            `UPDATE step_submissions SET first_response_at = COALESCE(first_response_at, $1) WHERE id = $2`,
            [at, latest.id],
          );
        }
        return id;
      });

      if (isStaff) {
        await notifyStudentOfStaffMessage({
          studentId, branchId: student.branchId, stepId, courseId: ctx.courseId, submissionId: latest?.id ?? null, messageId,
          kind: 'reply', comment: text || (kind === 'voice' ? 'Your teacher sent you a voice note.' : 'Your teacher sent you files.'),
          stepLabel: stepLabel(ctx), courseTitle: ctx.courseTitle,
        });
        // faculty copy: the teacher responsible for this work hears that a colleague replied
        await emailFaculty({ teacherId: latest?.assigned_teacher_id ?? null, excludeId: actor.id, submissionId: latest?.id ?? null, studentName: student.name, ctx, studentId, preview: text || (kind === 'voice' ? 'a voice note' : 'files'), fromStudent: false, since: null });
      } else if (latest?.assigned_teacher_id) {
        // student wrote: email (not a pop-up) to the responsible teacher, at most every 30 minutes
        await emailFaculty({ teacherId: latest.assigned_teacher_id, excludeId: actor.id, submissionId: latest.id, studentName: student.name, ctx, studentId, preview: text || (kind === 'voice' ? 'a voice note' : 'photos'), fromStudent: true, since: prevStudentAt });
      }

      const message = await loadMessage(messageId);
      return reply.code(201).send(message as ThreadMessage);
    },
  );

  // ---------- POST /v2/threads/:stepId/meet-request ----------
  // Staff: one tap → ready message inviting the student to the Funun al-Quran office.
  app.post<{ Params: { stepId: string }; Body: MeetBody }>(
    '/threads/:stepId/meet-request',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const actor = await getActor(request);
      if (!actor.isStaff) return bad(reply, 403, 'Only teachers can send a meeting request.');
      const { stepId } = request.params;
      const body = request.body ?? {};
      const ctx = UUIDish.test(stepId) ? await loadStepContext(stepId) : null;
      if (!ctx) return bad(reply, 404, 'This step could not be found.');
      if (!body.studentId || !UUIDish.test(body.studentId)) return bad(reply, 400, 'Please choose a student.');
      const student = await loadStudent(body.studentId);
      if (!student || student.role !== 'student') return bad(reply, 404, 'This student could not be found.');
      if (!(await staffCanSeeThread(actor, student.branchId, student.id, stepId))) return bad(reply, 403, 'This student belongs to another branch.');
      const note = typeof body.note === 'string' ? body.note.trim().slice(0, 1000) : '';
      const text = note ? `${MEET_REQUEST_TEXT}\n${note}` : MEET_REQUEST_TEXT;
      const { rows: latestRows } = await pool.query(
        `SELECT id, status FROM step_submissions WHERE student_id = $1 AND step_id = $2 ORDER BY attempt_no DESC, created_at DESC LIMIT 1`,
        [student.id, stepId],
      );
      const latest = latestRows[0] ?? null;
      const messageId = await withTransaction(async client => insertThreadMessage(client, {
        studentId: student.id, stepId, courseId: ctx.courseId, branchId: student.branchId,
        senderId: actor.id, senderRole: actor.role === 'admin' ? 'admin' : 'teacher', kind: 'text', body: text, attachments: [],
        submissionId: latest?.id ?? null, meta: { event: 'meet_request' }, staffRead: true, studentRead: false,
      }));
      await notifyStudentOfStaffMessage({
        studentId: student.id, branchId: student.branchId, stepId, courseId: ctx.courseId, submissionId: latest?.id ?? null, messageId,
        kind: 'reply', comment: text, stepLabel: stepLabel(ctx), courseTitle: ctx.courseTitle, forceEmail: true,
      });
      const message = await loadMessage(messageId);
      return reply.code(201).send(message as ThreadMessage);
    },
  );

  // ---------- POST /v2/threads/:stepId/submit ----------
  app.post<{ Params: { stepId: string }; Body: SubmitBody }>(
    '/threads/:stepId/submit',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const actor = await getActor(request);
      if (actor.role !== 'student') return bad(reply, 403, 'Only students upload work here.');
      const { stepId } = request.params;
      const ctx = UUIDish.test(stepId) ? await loadStepContext(stepId) : null;
      if (!ctx) return bad(reply, 404, 'This step could not be found.');
      if (!isThreadStep(ctx)) return bad(reply, 400, 'This step is practice only — there is nothing to upload. Press "Mark as done" when you have finished.');
      if (ctx.status !== 'published' || ctx.levelStatus !== 'published' || !['published', 'held'].includes(ctx.courseStatus)) {
        return bad(reply, 403, 'This step is not open for uploads at the moment.');
      }
      const student = await loadStudent(actor.id);
      if (!student) return bad(reply, 404, 'Your account could not be found.');

      // branch + enrolment
      const { rows: branchRows } = await pool.query(`SELECT branch_id FROM course_branches WHERE course_id = $1`, [ctx.courseId]);
      if (branchRows.length && !branchRows.some((r: any) => r.branch_id === student.branchId)) {
        return bad(reply, 403, 'This course is not offered in your branch.');
      }
      if (ctx.courseStatus === 'held') {
        const { rows } = await pool.query(`SELECT 1 AS ok FROM enrollments WHERE student_id = $1 AND course_id = $2`, [student.id, ctx.courseId]);
        if (!rows[0]) return bad(reply, 403, 'This course is paused for new students.');
      }

      // earlier levels must be passed (every gating step of every earlier level)
      const { rows: blocking } = await pool.query(
        `SELECT COUNT(*) AS n
           FROM level_steps ls
           JOIN levels l ON l.id = ls.level_id
           JOIN step_types st ON st.type_key = ls.step_type
          WHERE ls.course_id = $1 AND l.order_index < $2 AND l.status = 'published' AND ls.status = 'published'
            AND st.gates_progress = 1
            AND NOT EXISTS (SELECT 1 FROM step_submissions s WHERE s.student_id = $3 AND s.step_id = ls.id AND s.status = 'passed')`,
        [ctx.courseId, ctx.levelOrder, student.id],
      );
      if (Number(blocking[0]?.n ?? 0) > 0) return bad(reply, 403, 'Please finish the earlier level first — this level opens when its assessment is passed.');

      const policies = await getEffectivePolicies(student.branchId);
      const maxFiles = Math.max(1, Number(policies['uploads.max_files']) || 20);
      const body = request.body ?? {};
      const rawCount = Array.isArray(body.files) ? body.files.length : 0;
      if (rawCount > maxFiles) return bad(reply, 400, `Please upload at most ${maxFiles} files at a time.`);
      let files: Attachment[] = sanitiseAttachments(body.files, maxFiles);
      if (!files.length) return bad(reply, 400, 'Please add at least one photo or PDF of your work.');
      const note = typeof body.note === 'string' ? body.note.trim().slice(0, 2000) : '';

      // forStepId must point at a step of the same level (assessment: earlier worksheets)
      const { rows: levelSteps } = await pool.query(`SELECT id FROM level_steps WHERE level_id = $1`, [ctx.levelId]);
      const allowed = new Set(levelSteps.map((r: any) => r.id));
      files = files.map(f => ({ ...f, forStepId: f.forStepId && allowed.has(f.forStepId) ? f.forStepId : stepId }));

      // attempts
      const { rows: previous } = await pool.query(
        `SELECT status, attempt_no FROM step_submissions WHERE student_id = $1 AND step_id = $2 ORDER BY attempt_no DESC`,
        [student.id, stepId],
      );
      if (previous.some((p: any) => OPEN_STATUSES.includes(p.status))) {
        return bad(reply, 409, 'Your last upload is still with your teacher. You will get a reply in this chat soon — you can add a message meanwhile.');
      }
      const hasMarks = Boolean(ctx.hasMarks ?? ['assessment', 'final_submission'].includes(ctx.stepType));
      if (hasMarks) {
        if (previous.some((p: any) => p.status === 'passed')) return bad(reply, 409, 'You have already passed this step — well done! Move on to the next one.');
        // v3 (teacher): + "Give one more attempt" grants (table attempt_grants)
        const { rows: grants } = await pool.query(`SELECT COUNT(*) AS n FROM attempt_grants WHERE student_id = $1 AND step_id = $2`, [student.id, stepId]).catch(() => ({ rows: [{ n: 0 }] }));
        const maxAttempts = Number(policies['assessment.max_attempts']) > 0 ? Number(policies['assessment.max_attempts']) + Number(grants[0]?.n ?? 0) : Number(policies['assessment.max_attempts']);
        if (Number.isFinite(maxAttempts) && maxAttempts > 0 && previous.length >= maxAttempts) {
          return bad(reply, 409, `You have used all ${maxAttempts} attempts for this step. Please speak to your teacher — they can help you continue.`);
        }
      }
      const attemptNo = (previous.length ? Math.max(...previous.map((p: any) => Number(p.attempt_no) || 0)) : 0) + 1;

      // least-loaded available teacher of the branch → spill-over web → master team → never block
      const { nodes } = await loadReviewerNodes();
      const assignment = chooseInitialAssignee(nodes, student.branchId, new Date());
      const teacherId = assignment.teacherId;
      const assignee = nodes.find(n => n.id === teacherId);
      const reason: 'new' | 'forwarded' = assignee && assignee.branchId !== student.branchId ? 'forwarded' : 'new';

      const submissionId = randomUUID();
      let printCode = '';
      for (let tries = 0; ; tries++) {
        if (tries > 20) return bad(reply, 503, 'We could not save your upload just now. Please try again in a minute.');
        printCode = generatePrintCode();
        const { rows: clash } = await pool.query(`SELECT 1 AS x FROM step_submissions WHERE print_code = $1`, [printCode]);
        if (clash[0]) continue;
        try {
          await withTransaction(async client => {
            const at = clockNow();
            await client.query(
              `INSERT INTO step_submissions (id, student_id, branch_id, course_id, level_id, step_id, attempt_no, status, files,
                 print_code, assigned_teacher_id, assigned_at, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, 'submitted', $8, $9, $10, $11, $11)`,
              [submissionId, student.id, student.branchId, ctx.courseId, ctx.levelId, stepId, attemptNo, JSON.stringify(files), printCode, teacherId, at],
            );
            await insertThreadMessage(client, {
              studentId: student.id, stepId, courseId: ctx.courseId, branchId: student.branchId,
              senderId: student.id, senderRole: 'student', kind: 'files', body: note || null, attachments: files,
              submissionId, meta: { attemptNo }, studentRead: true,
            });
            await insertThreadMessage(client, {
              studentId: student.id, stepId, courseId: ctx.courseId, branchId: student.branchId,
              senderId: null, senderRole: 'system', kind: 'system',
              body: attemptNo > 1
                ? `Thank you — attempt ${attemptNo} has reached your teachers. You will get a reply right here.`
                : 'Thank you — your work has reached your teachers. You will get a reply right here.',
              attachments: [], submissionId, meta: { event: 'submitted', attemptNo }, studentRead: true, staffRead: true,
            });
            await insertAudit(client, {
              actorId: student.id, branchId: student.branchId, action: 'submission.assign', entityType: 'submission', entityId: submissionId,
              summary: `Work uploaded (attempt ${attemptNo}) — ${stepLabel(ctx)}${teacherId ? '' : ' — no teacher available yet'}`,
              after: { teacherId, reason, route: assignment.route, printCode },
            });
          });
          break;
        } catch (error) {
          if (isDuplicateKey(error) && tries < 5) continue;
          throw error;
        }
      }

      await notifyStaffOfNewWork({
        teacherId, branchId: student.branchId, studentName: student.name, stepLabel: stepLabel(ctx), submissionId, printCode, reason,
      });
      const submission = await loadSubmission(submissionId, { forStudent: true });
      return reply.code(201).send(submission as Submission);
    },
  );
}
