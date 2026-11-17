import type { FastifyInstance, FastifyReply } from 'fastify';
import { pool } from '../../db.js';
import { getActor, requireMaster, requireStaff, type Actor } from '../lib/access.js';
import { getEffectivePolicies, getGlobalRows, isLocked, setPolicy } from '../lib/policies.js';
import { logAudit } from '../lib/audit.js';
import { A4, mergePlain, stampFiles, type SourceFile } from '../lib/pdfStamp.js';
import { registerSheetId } from '../lib/sheetIds.js';
import {
  MAX_FILES_PER_PDF, bundleName, contentDisposition, mapLimit, pdfName, studentDownloadBlock, tooManyMessage, uniqueIds,
  validateWatermarkInput, watermarkSettingFrom,
} from '../lib/filesLogic.js';
import { fetchBytes, loadProfile, stampOptionsFor } from '../lib/filesData.js';
import { PDFDocument, rgb } from 'pdf-lib';

/**
 * Downloads with copyright + privacy stamp.
 *   GET  /v2/downloads/step-file/:fileId      student → stamped PDF; staff → original (?preview=1 → stamped with own details)
 *   POST /v2/downloads/bundle {fileIds}        many worksheets → one stamped PDF (print many)
 *   GET  /v2/settings/watermark                WatermarkSetting (staff)
 *   PUT  /v2/settings/watermark                {storageKey, opacity, position, scale} (master)
 *   GET  /v2/settings/watermark/preview        sample stamped page so the master team can see the look
 */

type FileRow = {
  id: string; step_id: string; course_id: string; role: string; page: string; size_code: string | null; is_current: boolean;
  storage_key: string; original_filename: string | null; canonical_name: string | null; content_type: string | null;
  step_code: string; step_status: string; step_order: number; level_id: string; level_code: string | null; level_status: string;
  level_order: number; course_code: string | null; course_title: string; course_status: string;
};

async function loadFiles(ids: string[]): Promise<FileRow[]> {
  if (!ids.length) return [];
  const ph = ids.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await pool.query(
    `SELECT sf.id, sf.step_id, sf.course_id, sf.role, sf.page, sf.size_code, sf.is_current, sf.storage_key,
            sf.original_filename, sf.canonical_name, sf.content_type,
            ls.code AS step_code, ls.status AS step_status, ls.order_index AS step_order,
            l.id AS level_id, l.code AS level_code, l.status AS level_status, l.order_index AS level_order,
            c.code AS course_code, c.title AS course_title, c.status AS course_status
       FROM step_files sf
       JOIN level_steps ls ON ls.id = sf.step_id
       JOIN levels l ON l.id = ls.level_id
       JOIN courses c ON c.id = sf.course_id
      WHERE sf.id IN (${ph})`,
    ids,
  );
  return rows as FileRow[];
}

/** For a student: which of these files are blocked, and why (first reason wins). */
async function studentBlocks(actor: Actor, files: FileRow[]): Promise<Map<string, string>> {
  const courseIds = [...new Set(files.map(f => f.course_id))];
  const ph = courseIds.map((_, i) => `$${i + 1}`).join(', ');
  const [branches, enrolled] = await Promise.all([
    pool.query(`SELECT course_id, branch_id FROM course_branches WHERE course_id IN (${ph})`, courseIds),
    pool.query(`SELECT course_id FROM enrollments WHERE student_id = $1 AND course_id IN (${courseIds.map((_, i) => `$${i + 2}`).join(', ')})`, [actor.id, ...courseIds]),
  ]);
  const byCourse = new Map<string, string[]>();
  for (const r of branches.rows) (byCourse.get(r.course_id) ?? byCourse.set(r.course_id, []).get(r.course_id)!).push(r.branch_id);
  const enrolledSet = new Set(enrolled.rows.map(r => r.course_id as string));
  const out = new Map<string, string>();
  for (const f of files) {
    const reason = studentDownloadBlock(f, { courseBranchIds: byCourse.get(f.course_id) ?? [], studentBranchId: actor.branchId, enrolled: enrolledSet.has(f.course_id) });
    if (reason) out.set(f.id, reason);
  }
  return out;
}

function sendPdf(reply: FastifyReply, bytes: Uint8Array, filename: string) {
  return reply
    .type('application/pdf')
    .header('Content-Disposition', contentDisposition(filename))
    .header('Cache-Control', 'private, no-store')
    .send(Buffer.from(bytes));
}

const sortFiles = (a: FileRow, b: FileRow) =>
  (a.course_code ?? '').localeCompare(b.course_code ?? '') || a.level_order - b.level_order || a.step_order - b.step_order
  || (a.page ?? '').localeCompare(b.page ?? '') || (a.size_code ?? '').localeCompare(b.size_code ?? '');

async function sourcesFor(files: FileRow[]): Promise<SourceFile[]> {
  return mapLimit(files, 6, async f => ({
    bytes: (await fetchBytes(f.storage_key)) ?? new Uint8Array(),
    label: f.canonical_name || f.original_filename || 'worksheet',
  }));
}

export async function downloadsV2Routes(app: FastifyInstance): Promise<void> {
  // ---------- one file ----------
  app.get<{ Params: { fileId: string }; Querystring: { preview?: string } }>(
    '/downloads/step-file/:fileId',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const actor = await getActor(request);
      const [file] = await loadFiles([request.params.fileId]);
      if (!file) return reply.code(404).send({ error: 'This worksheet could not be found.' });
      const wantsPreview = request.query.preview === '1' || request.query.preview === 'true';

      if (actor.isStaff && !wantsPreview) {
        const bytes = await fetchBytes(file.storage_key);
        if (!bytes) return reply.code(502).send({ error: 'The file could not be loaded from storage. Please try again.' });
        const name = file.original_filename || file.canonical_name || 'file';
        return reply
          .type(file.content_type || 'application/octet-stream')
          .header('Content-Disposition', contentDisposition(name))
          .header('Cache-Control', 'private, no-store')
          .send(Buffer.from(bytes));
      }
      if (!actor.isStaff) {
        const block = (await studentBlocks(actor, [file])).get(file.id);
        if (block) return reply.code(403).send({ error: block });
      }

      const bytes = await fetchBytes(file.storage_key);
      if (!bytes) return reply.code(502).send({ error: 'The worksheet could not be loaded. Please try again in a minute.' });
      const profile = await loadProfile(actor.id);
      if (!profile) return reply.code(401).send({ error: 'Please sign in again.' });
      const title = (file.canonical_name || file.original_filename || 'worksheet').replace(/\.[A-Za-z0-9]{1,5}$/, '');
      const sheetId = await registerSheetId({ kind: 'student_download', studentId: actor.id, stepFileId: file.id, createdBy: actor.id });
      const result = await stampFiles([{ bytes, label: file.canonical_name || file.original_filename }], { ...(await stampOptionsFor(profile, title)), sheetId });
      if (result.skipped.length) {
        return reply.code(415).send({ error: 'This file type cannot be turned into a printable PDF. Please ask your teacher for a JPG, PNG or PDF version.' });
      }
      return sendPdf(reply, result.bytes, pdfName(file.canonical_name || file.original_filename));
    },
  );

  // ---------- many files → one PDF ----------
  app.post<{ Body: { fileIds?: unknown } }>(
    '/downloads/bundle',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const actor = await getActor(request);
      const ids = uniqueIds(request.body?.fileIds);
      if (!ids.length) return reply.code(400).send({ error: 'Please choose the worksheets you want to print.' });
      if (ids.length > MAX_FILES_PER_PDF) return reply.code(400).send({ error: tooManyMessage(ids.length, 'worksheets') });

      if (!actor.isStaff) {
        const policies = await getEffectivePolicies(actor.branchId);
        if (policies['print.allow_multi'] === false) {
          return reply.code(403).send({ error: 'Printing many worksheets at once is switched off for your branch. Please download them one by one.' });
        }
      }
      const files = (await loadFiles(ids)).filter(f => f.role !== 'video').sort(sortFiles);
      if (!files.length) return reply.code(404).send({ error: 'These worksheets could not be found.' });
      if (!actor.isStaff) {
        const blocks = await studentBlocks(actor, files);
        if (blocks.size) {
          const first = [...blocks.values()][0];
          return reply.code(403).send({ error: blocks.size === files.length ? first : `${blocks.size} of the chosen worksheets are not available to you: ${first}` });
        }
      }

      const sources = await sourcesFor(files);
      const filename = bundleName(files.map(f => ({ courseCode: f.course_code, levelCode: f.level_code })));
      if (actor.isStaff) {
        const plain = await mergePlain(sources, filename.replace(/\.pdf$/, ''));
        return sendPdf(reply, plain.bytes, filename);
      }
      const profile = await loadProfile(actor.id);
      if (!profile) return reply.code(401).send({ error: 'Please sign in again.' });
      const sheetId = await registerSheetId({ kind: 'student_download', studentId: actor.id, stepFileId: files[0]?.id ?? null, createdBy: actor.id });
      const result = await stampFiles(sources, { ...(await stampOptionsFor(profile, filename.replace(/\.pdf$/, ''))), sheetId });
      if (result.skipped.length) reply.header('X-Skipped-Files', String(result.skipped.length));
      return sendPdf(reply, result.bytes, filename);
    },
  );

  // ---------- watermark setting (thin wrapper over policy downloads.watermark) ----------
  app.get('/settings/watermark', { preHandler: [app.authenticate, requireStaff()] }, async () => {
    const row = (await getGlobalRows()).find(r => r.policyKey === 'downloads.watermark');
    return watermarkSettingFrom(row?.value);
  });

  app.put<{ Body: unknown }>('/settings/watermark', { preHandler: [app.authenticate, requireMaster()] }, async (request, reply) => {
    const actor = await getActor(request);
    const parsed = validateWatermarkInput(request.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const before = (await getGlobalRows()).find(r => r.policyKey === 'downloads.watermark')?.value ?? null;
    await setPolicy('', 'downloads.watermark', parsed.value, actor.id, await isLocked('downloads.watermark'));
    await logAudit({ actorId: actor.id, action: 'policy.set', entityType: 'policy', entityId: 'downloads.watermark', summary: 'Download watermark changed', before, after: parsed.value });
    return parsed.value;
  });

  /** A sample mistar page stamped with the caller's own details — "see how downloads look". */
  app.get('/settings/watermark/preview', { preHandler: [app.authenticate, requireStaff()] }, async (request, reply) => {
    const actor = await getActor(request);
    const profile = await loadProfile(actor.id);
    if (!profile) return reply.code(401).send({ error: 'Please sign in again.' });
    const sample = await PDFDocument.create();
    const page = sample.addPage([A4.w, A4.h]);
    page.drawRectangle({ x: 24, y: 24, width: A4.w - 48, height: A4.h - 48, borderColor: rgb(0.2, 0.2, 0.2), borderWidth: 1 });
    for (let y = A4.h - 80; y > 50; y -= 44) {
      page.drawLine({ start: { x: 36, y }, end: { x: A4.w - 36, y }, thickness: 0.8, color: rgb(0.35, 0.35, 0.35) });
      page.drawLine({ start: { x: 36, y: y + 22 }, end: { x: A4.w - 36, y: y + 22 }, thickness: 0.4, color: rgb(0.75, 0.75, 0.75), dashArray: [3, 3] });
    }
    const result = await stampFiles([{ bytes: await sample.save(), label: 'sample' }], await stampOptionsFor(profile, 'Watermark preview'));
    return reply
      .type('application/pdf')
      .header('Content-Disposition', contentDisposition('watermark-preview.pdf', true))
      .header('Cache-Control', 'private, no-store')
      .send(Buffer.from(result.bytes));
  });
}
