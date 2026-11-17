/**
 * File ingest (database side). The decision for each file is made by the pure
 * planner in courseLogic.ts; this module only executes it inside a transaction
 * that locks the course row, so two uploads for the same course never race.
 */
import { randomUUID } from 'node:crypto';
import { pool } from '../../db.js';
import { buildStorageKey, putObjectBytes } from '../../storage.js';
import type { IngestCommitResult, IngestPlanItem, StepFile } from '../contracts.js';
import { logAudit } from './audit.js';
import { decisionToPlanItem, insertPosition, planIngest, planIngestFile } from './courseLogic.js';
import { loadPlanContext, resequenceLevels, resequenceSteps, withTx } from './courseQueries.js';
import {
  DriveError, downloadDriveFile, driveIdFromUrl, getDriveAuth, listDriveFolder, MAX_DRIVE_FILE_BYTES, type DriveAuth,
} from './drive.js';
import { contentTypeForExt, normaliseCourseCode, parseFileName } from './naming.js';

export type CommitInput = {
  filename: string;
  storageKey: string;
  contentType: string | null;
  byteSize: number | null;
  source: StepFile['source'];
  driveFileId?: string | null;
  actorId: string | null;
};

function courseCodeOf(filename: string): string | null {
  const r = parseFileName(filename);
  return r.ok ? r.parsed.courseCode : null;
}

export async function planFilenames(filenames: string[]): Promise<IngestPlanItem[]> {
  const codes = filenames.map(courseCodeOf).filter((c): c is string => Boolean(c));
  const ctx = await loadPlanContext(codes);
  return planIngest(filenames, ctx).map(decisionToPlanItem);
}

export async function findByDriveFileId(driveFileId: string): Promise<{ id: string; stepId: string; canonicalName: string | null } | null> {
  const { rows } = await pool.query(`SELECT id, step_id, canonical_name FROM step_files WHERE drive_file_id = $1 LIMIT 1`, [driveFileId]);
  return rows[0] ? { id: rows[0].id, stepId: rows[0].step_id, canonicalName: rows[0].canonical_name ?? null } : null;
}

export async function commitIngestFile(input: CommitInput): Promise<IngestCommitResult> {
  const { filename } = input;
  const code = courseCodeOf(filename);
  if (!code) {
    const parsed = parseFileName(filename);
    return { filename, ok: false, action: 'error', message: parsed.ok ? 'Could not read the file name.' : parsed.error };
  }
  if (!input.storageKey || typeof input.storageKey !== 'string') {
    return { filename, ok: false, action: 'error', message: 'The file was not uploaded (no storage key). Please upload it again.' };
  }
  try {
    return await withTx(async client => {
      if (input.driveFileId) {
        const { rows } = await client.query(`SELECT id, step_id FROM step_files WHERE drive_file_id = $1 LIMIT 1`, [input.driveFileId]);
        if (rows[0]) return { filename, ok: true, action: 'same_file' as const, stepId: rows[0].step_id, fileId: rows[0].id, message: `Already imported from Drive — ${filename}. Nothing to do.` };
      }
      const ctx = await loadPlanContext([code], client, code);
      const d = planIngestFile(filename, ctx, false);
      if (!d.ok || !d.parsed || !d.courseId) return { filename, ok: false, action: d.action, message: d.message };
      if (d.action === 'same_file') {
        const course = ctx.courses.get(code)!;
        const step = course.levels.find(l => l.code === d.levelCode)?.steps.find(s => s.code === d.stepCode);
        return { filename, ok: true, action: 'same_file', stepId: step?.id ?? undefined, message: d.message };
      }
      const course = ctx.courses.get(code)!;
      const p = d.parsed;

      // ----- level
      let levelId = d.levelId;
      if (d.createLevel) {
        levelId = randomUUID();
        const { rows: maxRows } = await client.query(`SELECT COALESCE(MAX(order_index), -1) + 1 AS n FROM levels WHERE course_id = $1`, [course.id]);
        await client.query(
          `INSERT INTO levels (id, course_id, order_index, level_type, title, code, status, updated_at)
           VALUES ($1, $2, $3, 'mufradat', $4, $5, 'published', CURRENT_TIMESTAMP(6))`,
          [levelId, course.id, Number(maxRows[0]?.n ?? 0), d.levelCode, d.levelCode],
        );
        const pos = insertPosition(course.levels.map(l => l.code), d.levelCode!);
        if (pos < course.levels.length) {
          const ordered = course.levels.map(l => l.id!).filter(Boolean);
          ordered.splice(pos, 0, levelId);
          await resequenceLevels(client, course.id, ordered);
        }
        await logAudit({ actorId: input.actorId, action: 'level.create', entityType: 'level', entityId: levelId, summary: `Level ${d.levelCode} created in ${course.code} by uploading ${filename}`, after: { code: d.levelCode } });
      }
      const levelSteps = course.levels.find(l => l.code === d.levelCode)?.steps ?? [];

      // ----- step
      let stepId = d.stepId;
      if (d.createStep) {
        stepId = randomUUID();
        await client.query(
          `INSERT INTO level_steps (id, level_id, course_id, code, order_index, title, step_type, status, source, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'published', 'file', CURRENT_TIMESTAMP(6))`,
          [stepId, levelId, course.id, d.stepCode, levelSteps.length, null, d.stepType],
        );
        const pos = insertPosition(levelSteps.map(s => s.code), d.stepCode!);
        if (pos < levelSteps.length) {
          const ordered = levelSteps.map(s => s.id!).filter(Boolean);
          ordered.splice(pos, 0, stepId);
          await resequenceSteps(client, levelId!, ordered);
        }
        await logAudit({ actorId: input.actorId, action: 'step.create', entityType: 'step', entityId: stepId, summary: `Step ${d.levelCode} ${d.stepCode} (${d.stepType}) created in ${course.code} by uploading ${filename}`, after: { code: d.stepCode, stepType: d.stepType } });
      } else if (d.retypeStep) {
        const before = levelSteps.find(s => s.id === stepId)?.stepType ?? null;
        await client.query(`UPDATE level_steps SET step_type = $1, updated_at = CURRENT_TIMESTAMP(6) WHERE id = $2`, [d.stepType, stepId]);
        await logAudit({ actorId: input.actorId, action: 'step.update', entityType: 'step', entityId: stepId!, summary: `Step ${d.levelCode} ${d.stepCode} type ${before} → ${d.stepType} (from ${filename})`, before: { stepType: before }, after: { stepType: d.stepType } });
      }

      // ----- file
      if (d.demoteOthers) {
        await client.query(
          `UPDATE step_files SET is_current = 0 WHERE step_id = $1 AND role = $2 AND size_code <=> $3 AND page = $4 AND is_current = 1`,
          [stepId, d.fileRole, p.sizeCode, p.page],
        );
      }
      const fileId = randomUUID();
      const contentType = input.contentType || contentTypeForExt(p.ext);
      await client.query(
        `INSERT INTO step_files (id, step_id, course_id, role, size_code, page, version, is_current, storage_key, original_filename,
                                 canonical_name, content_type, byte_size, source, drive_file_id, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [fileId, stepId, course.id, d.fileRole, p.sizeCode, p.page, p.version, d.makeCurrent, input.storageKey, filename,
          d.canonicalName, contentType, input.byteSize ?? null, input.source, input.driveFileId ?? null, input.actorId],
      );
      await client.query(`UPDATE courses SET updated_at = CURRENT_TIMESTAMP(6) WHERE id = $1`, [course.id]);
      await logAudit({
        actorId: input.actorId,
        action: d.action === 'new_version' ? 'file.new_version' : 'file.add',
        entityType: 'step_file',
        entityId: fileId,
        summary: `${course.code}: ${d.doneMessage}`,
        after: { canonicalName: d.canonicalName, version: p.version, source: input.source },
      });
      const message = d.notes.length ? `${d.doneMessage} ${d.notes.join(' ')}` : d.doneMessage;
      return { filename, ok: true, action: d.action, stepId: stepId!, fileId, message };
    });
  } catch (error) {
    console.error('ingest commit failed', filename, error);
    return { filename, ok: false, action: 'error', message: 'Could not save this file because of a server problem. Please try again.' };
  }
}

/** Downloads one Drive file, stores it and commits it. Skips work that is already done. */
export async function ingestDriveFile(
  file: { id: string; name: string; mimeType?: string | null; size?: number | null },
  auth: DriveAuth | null,
  source: 'drive' | 'webhook',
  actorId: string | null,
  bytes?: Buffer,
): Promise<IngestCommitResult> {
  const existing = await findByDriveFileId(file.id);
  if (existing) return { filename: file.name, ok: true, action: 'same_file', stepId: existing.stepId, fileId: existing.id, message: `Already imported — ${file.name}. Nothing to do.` };
  // Plan first: no download for names that cannot be filed or are already there.
  const [plan] = await planFilenames([file.name]);
  if (!plan.ok) return { filename: file.name, ok: false, action: plan.action, message: plan.message };
  if (plan.action === 'same_file') return { filename: file.name, ok: true, action: 'same_file', message: plan.message };
  if (file.size && file.size > MAX_DRIVE_FILE_BYTES) return { filename: file.name, ok: false, action: 'error', message: 'This file is larger than 300 MB and was skipped.' };
  let body = bytes;
  try {
    if (!body) {
      if (!auth) auth = await getDriveAuth();
      body = await downloadDriveFile(file.id, auth);
    }
  } catch (error) {
    const message = error instanceof DriveError ? error.message : 'Could not download this file from Google Drive.';
    return { filename: file.name, ok: false, action: 'error', message };
  }
  const parsed = parseFileName(file.name);
  const ext = parsed.ok ? parsed.parsed.ext : (file.name.split('.').pop() ?? 'bin').toLowerCase();
  const contentType = (file.mimeType && file.mimeType !== 'application/octet-stream') ? file.mimeType : contentTypeForExt(ext);
  const storageKey = buildStorageKey('course-files', `${file.name.replace(/\.[^.]+$/, '')}.${ext}`);
  try {
    await putObjectBytes(storageKey, body, contentType);
  } catch (error) {
    console.error('course file store failed', file.name, error);
    return { filename: file.name, ok: false, action: 'error', message: 'Could not store this file. Please try again.' };
  }
  return commitIngestFile({ filename: file.name, storageKey, contentType, byteSize: body.length, source, driveFileId: file.id, actorId });
}

/** Imports a whole Drive folder (recursively). Optional courseCode keeps only that course's files. */
export async function importDriveFolder(folderUrl: string, courseCode: string | null, actorId: string | null): Promise<IngestCommitResult[]> {
  const folderId = driveIdFromUrl(folderUrl);
  if (!folderId) throw new DriveError('That does not look like a Google Drive folder link. Copy the link from Drive (Share → Copy link) and paste it here.', 400);
  const auth = await getDriveAuth();
  const files = await listDriveFolder(folderId, auth);
  const wanted = courseCode ? normaliseCourseCode(courseCode) : null;
  const results: IngestCommitResult[] = [];
  for (const f of files) {
    const parsed = parseFileName(f.name);
    if (wanted && parsed.ok && parsed.parsed.courseCode !== wanted) continue;
    if (!parsed.ok && /^(desktop\.ini|thumbs\.db|\.ds_store)$/i.test(f.name)) continue;
    results.push(await ingestDriveFile({ id: f.id, name: f.name, mimeType: f.mimeType, size: f.size }, auth, 'drive', actorId));
  }
  if (!files.length) results.push({ filename: '(folder)', ok: false, action: 'error', message: 'The Drive folder is empty, or its files cannot be seen with the current sharing.' });
  return results;
}
