import type { FastifyInstance } from 'fastify';
import { pool } from '../../db.js';
import { getActor, requireStaff } from '../lib/access.js';
import { logAudit } from '../lib/audit.js';
import { buildPrintPack, type PrintPackSubmission } from '../lib/pdfStamp.js';
import {
  MAX_FILES_PER_PDF, contentDisposition, guessContentType, isSafeStorageKey, mapLimit, pickPackFiles, tooManyMessage, uniqueIds,
} from '../lib/filesLogic.js';
import { fetchBytes } from '../lib/filesData.js';
import type { Attachment, PrintPackRequest, ScanReturnItem, ScanReturnResult } from '../contracts.js';
import { applyDecision, generatePrintCode, ReviewError } from '../lib/reviewLogic.js';
import {
  canStaffSeeSubmission, insertThreadMessage, loadStepContext, loadStudent, loadSubmissionRow, sanitiseAttachments,
} from '../lib/threadData.js';
import { notifyStudentOfStaffMessage } from '../lib/threadNotify.js';
import { registerSheetId } from '../lib/sheetIds.js';

/**
 * Teacher time savers.
 *   POST /v2/review/print-pack   [PrintPackRequest] → one PDF, every page with name, step, printCode and QR KHAT:<code>:<page>
 *   POST /v2/review/scan-return  {items: ScanReturnItem[]} → [ScanReturnResult[]] corrected pages (+ mark) back to each student's thread
 */

const MARKED_FALLBACK = new Set(['assessment', 'final_submission']);

async function ensurePrintCode(id: string, current: string | null): Promise<string> {
  if (current) return current;
  for (let i = 0; i < 5; i++) {
    const code = generatePrintCode();
    try {
      await pool.query(`UPDATE step_submissions SET print_code = $1 WHERE id = $2 AND print_code IS NULL`, [code, id]);
    } catch {
      continue; // unique clash — try another code
    }
    const { rows } = await pool.query(`SELECT print_code FROM step_submissions WHERE id = $1`, [id]);
    if (rows[0]?.print_code) return rows[0].print_code;
  }
  throw new Error('Could not create a print code');
}

export async function printV2Routes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: Partial<PrintPackRequest> }>(
    '/review/print-pack',
    { preHandler: [app.authenticate, requireStaff()] },
    async (request, reply) => {
      const actor = await getActor(request);
      const ids = uniqueIds(request.body?.submissionIds);
      const include = request.body?.include === 'all_files' ? 'all_files' : 'assessment_only';
      if (!ids.length) return reply.code(400).send({ error: 'Please tick the submissions you want to print.' });
      if (ids.length > MAX_FILES_PER_PDF) return reply.code(400).send({ error: tooManyMessage(ids.length, 'submissions') });

      const ph = ids.map((_, i) => `$${i + 1}`).join(', ');
      const { rows } = await pool.query(
        `SELECT s.id, s.student_id, s.branch_id, s.step_id, s.attempt_no, s.files, s.print_code, s.assigned_teacher_id,
                u.name AS student_name, u.tr_number, u.class_name, b.name AS branch_name,
                ls.code AS step_code, ls.title AS step_title,
                l.code AS level_code, l.order_index AS level_order, l.description AS level_description,
                c.code AS course_code, c.title AS course_title
           FROM step_submissions s
           JOIN users u ON u.id = s.student_id
           LEFT JOIN branches b ON b.id = u.branch_id
           JOIN level_steps ls ON ls.id = s.step_id
           JOIN levels l ON l.id = s.level_id
           JOIN courses c ON c.id = s.course_id
          WHERE s.id IN (${ph})`,
        ids,
      );
      const byId = new Map(rows.map(r => [r.id as string, r]));
      const missing = ids.filter(id => !byId.has(id));
      if (missing.length === ids.length) return reply.code(404).send({ error: 'These submissions could not be found.' });
      const denied = rows.filter(r => !canStaffSeeSubmission(actor, r.branch_id, r.assigned_teacher_id ?? null));
      if (denied.length) {
        return reply.code(403).send({ error: `${denied.length} of the chosen submissions belong to another branch. Please print only your branch's work.` });
      }

      // Keep the teacher's order (usually the inbox order).
      const ordered = ids.map(id => byId.get(id)).filter(Boolean) as any[];
      const subs: PrintPackSubmission[] = await mapLimit(ordered, 4, async r => {
        const printCode = await ensurePrintCode(r.id, r.print_code ?? null);
        const sheetId = await registerSheetId({ kind: 'print_pack', studentId: r.student_id, submissionId: r.id, printCode, createdBy: actor.id });
        const files = pickPackFiles(sanitiseAttachments(r.files, 200), r.step_id, include);
        const sources = await mapLimit(files, 4, async (f: Attachment) => ({
          bytes: (await fetchBytes(f.storageKey)) ?? new Uint8Array(),
          label: f.originalFilename || f.storageKey.split('/').pop() || 'file',
        }));
        return {
          printCode,
          studentName: r.student_name ?? 'Student',
          trNumber: r.tr_number ?? null,
          className: r.class_name ?? null,
          branchName: r.branch_name ?? null,
          courseCode: r.course_code ?? null,
          courseTitle: r.course_title ?? null,
          levelCode: r.level_code ?? `LV${String(Number(r.level_order ?? 0) + 1).padStart(2, '0')}`,
          levelDescription: r.level_description ?? null,
          stepCode: r.step_code ?? null,
          stepTitle: r.step_title ?? null,
          attemptNo: Number(r.attempt_no ?? 1),
          sheetId,
          files: sources,
        };
      });

      const pack = await buildPrintPack(subs, { generatedAt: new Date(), timeZone: 'Africa/Nairobi' });
      await logAudit({
        actorId: actor.id, branchId: actor.branchId, action: 'submission.print_pack', entityType: 'submission',
        entityId: ordered[0].id, summary: `Printed ${subs.length} submission${subs.length === 1 ? '' : 's'} (${pack.pageCount} pages)`,
        after: { submissionIds: ordered.map(r => r.id), include },
      });
      const stamp = new Date().toISOString().slice(0, 10);
      return reply
        .type('application/pdf')
        .header('Content-Disposition', contentDisposition(`print-pack_${stamp}_${subs.length}.pdf`))
        .header('Cache-Control', 'private, no-store')
        .header('X-Missing-Submissions', String(missing.length))
        .header('X-Sheet-Ids', subs.map(x => x.sheetId ?? '').join(','))
        .header('Access-Control-Expose-Headers', 'Content-Disposition, X-Sheet-Ids, X-Missing-Submissions')
        .send(Buffer.from(pack.bytes));
    },
  );

  app.post<{ Body: { items?: ScanReturnItem[] } }>(
    '/review/scan-return',
    { preHandler: [app.authenticate, requireStaff()] },
    async (request, reply) => {
      const actor = await getActor(request);
      const items = Array.isArray(request.body?.items) ? request.body!.items! : [];
      if (!items.length) return reply.code(400).send({ error: 'There is nothing to send yet. Scan the pages first.' });
      if (items.length > MAX_FILES_PER_PDF) return reply.code(400).send({ error: tooManyMessage(items.length, 'students') });

      const results: ScanReturnResult[] = [];
      for (const item of items) {
        const submissionId = typeof item?.submissionId === 'string' ? item.submissionId : '';
        let name = '';
        const fail = (studentName: string, message: string) => results.push({ submissionId, ok: false, studentName, message });
        try {
          const row = submissionId ? await loadSubmissionRow(submissionId) : null;
          if (!row) { fail('', 'This submission could not be found.'); continue; }
          const student = await loadStudent(row.student_id);
          name = student?.name ?? 'Student';
          if (!canStaffSeeSubmission(actor, row.branch_id, row.assigned_teacher_id ?? null)) { fail(name, 'This work belongs to another branch.'); continue; }

          const keys = (Array.isArray(item.pageStorageKeys) ? item.pageStorageKeys : []).filter(isSafeStorageKey).slice(0, MAX_FILES_PER_PDF);
          const comment = typeof item.comment === 'string' && item.comment.trim() ? item.comment.trim().slice(0, 4000) : null;
          const markGiven = item.mark !== null && item.mark !== undefined && (item.mark as unknown) !== '';
          const ctx = await loadStepContext(row.step_id);
          if (!ctx) { fail(name, 'The step for this work no longer exists.'); continue; }
          const hasMarks = ctx.hasMarks ?? MARKED_FALLBACK.has(ctx.stepType);
          if (!keys.length && !markGiven && !comment) { fail(name, 'No pages, mark or comment to send.'); continue; }
          if (markGiven && hasMarks) {
            const m = Number(item.mark);
            if (!Number.isInteger(m) || m < 1 || m > 10) { fail(name, 'The mark must be a whole number from 1 to 10.'); continue; }
          }

          // Decide first (so nothing is posted if the decision is refused), then post the pages
          // with a timestamp just before the mark so the thread reads: pages → mark + comment.
          const pagesAt = new Date();
          const decide = (markGiven && hasMarks) || !hasMarks;
          let markText = '';
          if (decide) {
            const decided = await applyDecision(
              submissionId,
              hasMarks ? { mark: Number(item.mark), comment } : { comment, status: 'reviewed' },
              { id: actor.id, name: actor.name, role: actor.role },
            );
            if (decided.mark !== null) markText = ` and mark ${decided.mark}/10`;
          }
          if (keys.length) {
            const attachments: Attachment[] = keys.map((key, i) => {
              const ext = key.split('.').pop()?.toLowerCase() ?? 'jpg';
              return { storageKey: key, originalFilename: `Corrected page ${i + 1}.${ext}`, contentType: guessContentType(key), forStepId: row.step_id };
            });
            const messageId = await insertThreadMessage(pool, {
              studentId: row.student_id, stepId: row.step_id, courseId: row.course_id, branchId: row.branch_id,
              senderId: actor.id, senderRole: actor.role === 'admin' ? 'admin' : 'teacher', kind: 'files',
              body: decide ? null : comment, attachments, submissionId,
              meta: { source: 'scan_return', pages: keys.length }, staffRead: true, createdAt: decide ? new Date(pagesAt.getTime() - 1) : undefined,
            });
            if (!decide) {
              await pool.query(`UPDATE step_submissions SET first_response_at = COALESCE(first_response_at, $1) WHERE id = $2`, [new Date(), submissionId]);
              await notifyStudentOfStaffMessage({
                studentId: row.student_id, branchId: row.branch_id, stepId: row.step_id, courseId: row.course_id, submissionId, messageId,
                kind: 'annotation', comment, stepLabel: `${ctx.courseLabelShort} ${ctx.levelCode} ${ctx.code}${ctx.title ? ` — ${ctx.title}` : ''}`,
                courseTitle: ctx.courseTitle,
              }).catch(err => request.log.error(err));
            }
          } else if (!decide && comment) {
            const messageId = await insertThreadMessage(pool, {
              studentId: row.student_id, stepId: row.step_id, courseId: row.course_id, branchId: row.branch_id,
              senderId: actor.id, senderRole: actor.role === 'admin' ? 'admin' : 'teacher', kind: 'text',
              body: comment, attachments: [], submissionId, staffRead: true,
            });
            await notifyStudentOfStaffMessage({
              studentId: row.student_id, branchId: row.branch_id, stepId: row.step_id, courseId: row.course_id, submissionId, messageId,
              kind: 'reply', comment, stepLabel: `${ctx.courseLabelShort} ${ctx.levelCode} ${ctx.code}`, courseTitle: ctx.courseTitle,
            }).catch(err => request.log.error(err));
          }
          const pages = keys.length ? `${keys.length} corrected page${keys.length === 1 ? '' : 's'}` : 'your comment';
          results.push({ submissionId, ok: true, studentName: name, message: `Sent ${pages}${markText} to ${name}.` });
        } catch (error) {
          if (error instanceof ReviewError) { fail(name, error.message); continue; }
          request.log.error(error);
          fail(name, 'Something went wrong for this student. Please try again.');
        }
      }
      await logAudit({
        actorId: actor.id, branchId: actor.branchId, action: 'submission.scan_return', entityType: 'submission',
        entityId: results[0]?.submissionId || 'batch', summary: `Scan return: ${results.filter(r => r.ok).length} of ${results.length} sent`,
        after: results.map(r => ({ id: r.submissionId, ok: r.ok })),
      });
      return results;
    },
  );
}
