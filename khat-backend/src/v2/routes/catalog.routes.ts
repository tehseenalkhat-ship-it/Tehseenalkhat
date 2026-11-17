import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { pool } from '../../db.js';
import type { CourseTypeDef, FileCodeDef, MasterImportPreview, MasterImportRow, StepTypeDef } from '../contracts.js';
import { getActor, requireMaster, requireStaff } from '../lib/access.js';
import { logAudit } from '../lib/audit.js';
import {
  compareMasterRows, matchBranchName, readMasterSheet, type ExistingCourseForCompare,
} from '../lib/csv.js';
import { inList, loadCourseTypes, loadFileCodes, loadStepTypes, resolveKhatTypeId, toStringArray, withTx } from '../lib/courseQueries.js';
import { MAX_CSV_CHARS, fetchSheetCsv, SheetFetchError } from '../lib/sheetFetch.js';
import { normaliseCourseCode, SIZE_CODES } from '../lib/naming.js';

const STUDENT_ACTIONS = ['watch_download', 'upload', 'download_upload'];
const FEEDBACK_MODES = ['none', 'feedback', 'annotate_mark'];
const FILE_ROLES = ['worksheet', 'video', 'reference', 'assessment_sheet', 'resource', 'other'];
const KEY_RE = /^[a-z][a-z0-9_]{1,31}$/;

function defaultRoleForType(t: Pick<StepTypeDef, 'typeKey' | 'studentAction'>): FileCodeDef['fileRole'] {
  if (t.typeKey === 'assessment' || t.studentAction === 'download_upload') return 'assessment_sheet';
  if (t.studentAction === 'upload') return 'reference';
  return 'worksheet';
}

/** Keeps step_types.file_codes equal to what the file_codes table says (the table drives ingest). */
async function syncStepTypeFileCodes(db: { query: typeof pool.query }): Promise<void> {
  const { rows: codes } = await db.query(`SELECT file_code, step_type FROM file_codes ORDER BY file_code`);
  const { rows: types } = await db.query(`SELECT type_key FROM step_types`);
  for (const t of types) {
    const list = codes.filter(c => c.step_type === t.type_key).map(c => c.file_code);
    await db.query(`UPDATE step_types SET file_codes = $1 WHERE type_key = $2`, [JSON.stringify(list), t.type_key]);
  }
}

async function loadKnownBranches(): Promise<{ id: string; name: string }[]> {
  const { rows } = await pool.query(`SELECT id, name FROM branches ORDER BY name`);
  return rows.map(r => ({ id: r.id, name: r.name }));
}

async function loadExistingForCompare(codes: string[]): Promise<ExistingCourseForCompare[]> {
  if (!codes.length) return [];
  const { rows } = await pool.query(
    `SELECT id, code, title, title_ar, pen_type, course_type, description, mistar_sizes, drive_folder_url
     FROM courses WHERE code IN (${inList(codes.length)})`,
    codes,
  );
  if (!rows.length) return [];
  const ids = rows.map(r => r.id as string);
  const { rows: br } = await pool.query(
    `SELECT cb.course_id, b.name FROM course_branches cb JOIN branches b ON b.id = cb.branch_id WHERE cb.course_id IN (${inList(ids.length)})`,
    ids,
  );
  return rows.map(r => ({
    id: r.id,
    code: String(r.code).toUpperCase(),
    title: r.title ?? '',
    titleAr: r.title_ar ?? null,
    penType: r.pen_type ?? null,
    courseType: r.course_type ?? null,
    description: r.description ?? null,
    branchNames: br.filter(b => b.course_id === r.id).map(b => b.name),
    mistarSizes: toStringArray(r.mistar_sizes),
    driveFolderUrl: r.drive_folder_url ?? null,
  }));
}

function cleanFields(f: MasterImportRow['fields'] | undefined) {
  const str = (v: unknown, max = 20000) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);
  const fields = f && typeof f === 'object' ? f : ({} as MasterImportRow['fields']);
  return {
    title: str(fields.title, 500) ?? '',
    titleAr: str(fields.titleAr, 500),
    penType: str(fields.penType, 32),
    courseType: str(fields.courseType, 32),
    description: str(fields.description),
    branches: Array.isArray(fields.branches) ? fields.branches.filter(b => typeof b === 'string') : undefined,
    mistarSizes: Array.isArray(fields.mistarSizes) ? fields.mistarSizes.filter(s => (SIZE_CODES as readonly string[]).includes(s)) : undefined,
    driveFolderUrl: str(fields.driveFolderUrl, 2000),
  };
}

// Registered under prefix '/v2'
export async function catalogV2Routes(app: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------------- logic sets
  app.get('/step-types', { preHandler: [app.authenticate, requireStaff(app)] }, async () => loadStepTypes());
  app.get('/course-types', { preHandler: [app.authenticate, requireStaff(app)] }, async () => loadCourseTypes());
  app.get('/file-codes', { preHandler: [app.authenticate, requireStaff(app)] }, async () => loadFileCodes());

  app.put<{ Body: StepTypeDef[] | { items?: StepTypeDef[] } }>('/step-types', { preHandler: [app.authenticate, requireMaster(app)] }, async (request, reply) => {
    const actor = await getActor(request);
    const items = Array.isArray(request.body) ? request.body : request.body?.items;
    if (!Array.isArray(items) || !items.length) return reply.code(400).send({ error: 'Send the list of step types.' });
    for (const t of items) {
      if (!t || typeof t !== 'object' || typeof t.typeKey !== 'string' || !KEY_RE.test(t.typeKey)) return reply.code(400).send({ error: `Step type key "${t?.typeKey ?? ''}" must be lower-case letters, numbers or _ (e.g. "worksheet").` });
      if (typeof t.label !== 'string' || !t.label.trim()) return reply.code(400).send({ error: `Step type ${t.typeKey} needs a label.` });
      if (!STUDENT_ACTIONS.includes(t.studentAction)) return reply.code(400).send({ error: `Step type ${t.typeKey}: student action must be ${STUDENT_ACTIONS.join(', ')}.` });
      if (!FEEDBACK_MODES.includes(t.feedbackMode)) return reply.code(400).send({ error: `Step type ${t.typeKey}: feedback must be ${FEEDBACK_MODES.join(', ')}.` });
      if (t.fileCodes !== undefined && (!Array.isArray(t.fileCodes) || !t.fileCodes.every(c => typeof c === 'string' && /^[A-Za-z]{2,3}$/.test(c)))) {
        return reply.code(400).send({ error: `Step type ${t.typeKey}: file codes are 2–3 letters like MT or KT.` });
      }
    }
    const before = await loadStepTypes();
    await withTx(async client => {
      for (const t of items) {
        await client.query(
          `INSERT INTO step_types (type_key, label, file_codes, student_action, feedback_mode, has_marks, gates_progress, awards_badge, requires_prior_uploads, default_instructions, sort_order, is_system)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0)
           ON DUPLICATE KEY UPDATE label = VALUES(label), student_action = VALUES(student_action), feedback_mode = VALUES(feedback_mode),
             has_marks = VALUES(has_marks), gates_progress = VALUES(gates_progress), awards_badge = VALUES(awards_badge),
             requires_prior_uploads = VALUES(requires_prior_uploads), default_instructions = VALUES(default_instructions), sort_order = VALUES(sort_order)`,
          [t.typeKey, t.label.trim().slice(0, 100), JSON.stringify(t.fileCodes ?? []), t.studentAction, t.feedbackMode, Boolean(t.hasMarks), Boolean(t.gatesProgress),
            Boolean(t.awardsBadge), Boolean(t.requiresPriorUploads), typeof t.defaultInstructions === 'string' ? t.defaultInstructions : '', Number.isFinite(Number(t.sortOrder)) ? Math.round(Number(t.sortOrder)) : 0],
        );
        // File codes listed on the step type point to it in the file_codes table (which drives ingest).
        for (const code of (t.fileCodes ?? []).map(c => c.toUpperCase())) {
          await client.query(
            `INSERT INTO file_codes (file_code, step_type, file_role, label) VALUES ($1, $2, $3, $4)
             ON DUPLICATE KEY UPDATE step_type = VALUES(step_type)`,
            [code, t.typeKey, defaultRoleForType(t), `${t.label.trim().slice(0, 90)} file`],
          );
        }
      }
      await syncStepTypeFileCodes(client);
    });
    for (const t of items) {
      const old = before.find(b => b.typeKey === t.typeKey);
      await logAudit({
        actorId: actor.id, action: old ? 'logic.step_type_update' : 'logic.step_type_create', entityType: 'step_type', entityId: t.typeKey,
        summary: old ? `Step type "${t.label}" updated` : `New step type "${t.label}" (${t.typeKey}) added`, before: old ?? null, after: t,
      });
    }
    return loadStepTypes();
  });

  app.put<{ Body: CourseTypeDef[] | { items?: CourseTypeDef[] } }>('/course-types', { preHandler: [app.authenticate, requireMaster(app)] }, async (request, reply) => {
    const actor = await getActor(request);
    const items = Array.isArray(request.body) ? request.body : request.body?.items;
    if (!Array.isArray(items) || !items.length) return reply.code(400).send({ error: 'Send the list of course types.' });
    const stepKeys = (await loadStepTypes()).map(t => t.typeKey);
    for (const t of items) {
      if (!t || typeof t !== 'object' || typeof t.typeKey !== 'string' || !KEY_RE.test(t.typeKey)) return reply.code(400).send({ error: `Course type key "${t?.typeKey ?? ''}" must be lower-case letters, numbers or _ (e.g. "crash").` });
      if (typeof t.label !== 'string' || !t.label.trim()) return reply.code(400).send({ error: `Course type ${t.typeKey} needs a label.` });
      if (!Array.isArray(t.allowedStepTypes)) return reply.code(400).send({ error: `Course type ${t.typeKey}: choose the allowed step types.` });
      const unknown = t.allowedStepTypes.filter(s => !stepKeys.includes(s));
      if (unknown.length) return reply.code(400).send({ error: `Course type ${t.typeKey}: unknown step type(s) ${unknown.join(', ')}.` });
    }
    const before = await loadCourseTypes();
    await withTx(async client => {
      for (const t of items) {
        await client.query(
          `INSERT INTO course_types (type_key, label, allowed_step_types, has_levels, final_submission, sort_order) VALUES ($1, $2, $3, $4, $5, $6)
           ON DUPLICATE KEY UPDATE label = VALUES(label), allowed_step_types = VALUES(allowed_step_types), has_levels = VALUES(has_levels),
             final_submission = VALUES(final_submission), sort_order = VALUES(sort_order)`,
          [t.typeKey, t.label.trim().slice(0, 100), JSON.stringify(t.allowedStepTypes), t.hasLevels !== false, Boolean(t.finalSubmission), Number.isFinite(Number(t.sortOrder)) ? Math.round(Number(t.sortOrder)) : 0],
        );
      }
    });
    for (const t of items) {
      const old = before.find(b => b.typeKey === t.typeKey);
      await logAudit({ actorId: actor.id, action: old ? 'logic.course_type_update' : 'logic.course_type_create', entityType: 'course_type', entityId: t.typeKey, summary: old ? `Course type "${t.label}" updated` : `New course type "${t.label}" added`, before: old ?? null, after: t });
    }
    return loadCourseTypes();
  });

  app.put<{ Body: FileCodeDef[] | { items?: FileCodeDef[] } }>('/file-codes', { preHandler: [app.authenticate, requireMaster(app)] }, async (request, reply) => {
    const actor = await getActor(request);
    const items = Array.isArray(request.body) ? request.body : request.body?.items;
    if (!Array.isArray(items) || !items.length) return reply.code(400).send({ error: 'Send the list of file codes.' });
    const stepKeys = (await loadStepTypes()).map(t => t.typeKey);
    for (const c of items) {
      if (!c || typeof c !== 'object' || typeof c.fileCode !== 'string' || !/^[A-Za-z]{2,3}$/.test(c.fileCode)) return reply.code(400).send({ error: `File code "${c?.fileCode ?? ''}" must be 2–3 letters, like MT.` });
      if (typeof c.stepType !== 'string' || (c.stepType !== '' && !stepKeys.includes(c.stepType))) return reply.code(400).send({ error: `File code ${c.fileCode}: unknown step type "${c.stepType}".` });
      if (!FILE_ROLES.includes(c.fileRole)) return reply.code(400).send({ error: `File code ${c.fileCode}: role must be one of ${FILE_ROLES.join(', ')}.` });
      if (typeof c.label !== 'string' || !c.label.trim()) return reply.code(400).send({ error: `File code ${c.fileCode} needs a label.` });
    }
    const before = await loadFileCodes();
    await withTx(async client => {
      for (const c of items) {
        await client.query(
          `INSERT INTO file_codes (file_code, step_type, file_role, label) VALUES ($1, $2, $3, $4)
           ON DUPLICATE KEY UPDATE step_type = VALUES(step_type), file_role = VALUES(file_role), label = VALUES(label)`,
          [c.fileCode.toUpperCase(), c.stepType, c.fileRole, c.label.trim().slice(0, 100)],
        );
      }
      await syncStepTypeFileCodes(client);
    });
    for (const c of items) {
      const old = before.find(b => b.fileCode === c.fileCode.toUpperCase());
      await logAudit({ actorId: actor.id, action: old ? 'logic.file_code_update' : 'logic.file_code_create', entityType: 'file_code', entityId: c.fileCode.toUpperCase(), summary: old ? `File code ${c.fileCode.toUpperCase()} updated` : `New file code ${c.fileCode.toUpperCase()} → ${c.stepType || 'attach to step'} (${c.fileRole})`, before: old ?? null, after: c });
    }
    return loadFileCodes();
  });

  // ---------------------------------------------------------------- master course list
  app.post<{ Body: { sheetUrl?: string; csvText?: string } }>(
    '/master/preview',
    { preHandler: [app.authenticate, requireMaster(app)], bodyLimit: 8 * 1024 * 1024 },
    async (request, reply) => {
      const { sheetUrl, csvText } = request.body ?? {};
      let csv: string;
      let label: string;
      try {
        if (typeof csvText === 'string' && csvText.trim()) {
          if (csvText.length > MAX_CSV_CHARS) return reply.code(413).send({ error: 'This CSV is too large to import in one go.' });
          csv = csvText; label = 'Uploaded CSV';
        } else if (typeof sheetUrl === 'string' && sheetUrl.trim()) {
          ({ csv, label } = await fetchSheetCsv(sheetUrl, 'Courses'));
        } else {
          return reply.code(400).send({ error: 'Paste the Master Course List link, or upload the "Courses" tab as CSV.' });
        }
        const sheet = readMasterSheet(csv);
        const codes = sheet.map(r => r.courseCode).filter((c): c is string => Boolean(c));
        const [existing, branches] = await Promise.all([loadExistingForCompare([...new Set(codes)]), loadKnownBranches()]);
        const rows = compareMasterRows(sheet, existing, branches.map(b => b.name));
        // carry the raw sheet row so apply can store it as master_row
        const raw = new Map(sheet.filter(r => r.courseCode).map(r => [r.courseCode!, r.masterRow]));
        const body: MasterImportPreview = { rows: rows.map(r => ({ ...r, masterRow: raw.get(r.courseCode) } as MasterImportRow)), sourceLabel: label };
        return body;
      } catch (error) {
        if (error instanceof SheetFetchError) return reply.code(error.status).send({ error: error.message });
        if (error instanceof Error && /Course Code/.test(error.message)) return reply.code(400).send({ error: error.message });
        throw error;
      }
    },
  );

  app.post<{ Body: { rows?: (MasterImportRow & { masterRow?: Record<string, string> })[] } }>(
    '/master/apply',
    { preHandler: [app.authenticate, requireMaster(app)], bodyLimit: 8 * 1024 * 1024 },
    async (request, reply) => {
      const actor = await getActor(request);
      const rows = request.body?.rows;
      if (!Array.isArray(rows)) return reply.code(400).send({ error: 'Nothing to apply — preview the master list first.' });
      const branches = await loadKnownBranches();
      const courseTypes = await loadCourseTypes();
      let created = 0;
      let updated = 0;
      const messages: string[] = [];
      for (const row of rows) {
        if (!row || (row.action !== 'create' && row.action !== 'update')) continue;
        const code = normaliseCourseCode(row.courseCode);
        if (!code) { messages.push(`${row.courseCode}: not a valid course code — skipped.`); continue; }
        const f = cleanFields(row.fields);
        if (!f.title) { messages.push(`${code}: no course name — skipped.`); continue; }
        const branchIds = f.branches === undefined ? undefined : [...new Set(f.branches.map(b => {
          const name = matchBranchName(b, branches.map(x => x.name));
          return branches.find(x => x.name === name)?.id;
        }).filter((x): x is string => Boolean(x)))];
        const masterRow = row.masterRow && typeof row.masterRow === 'object' && !Array.isArray(row.masterRow)
          ? row.masterRow
          : Object.fromEntries(Object.entries(row.fields ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v ?? '')]));
        try {
          const result = await withTx(async client => {
            const { rows: found } = await client.query(
              `SELECT id, title, title_ar, pen_type, course_type, description, mistar_sizes, drive_folder_url FROM courses WHERE code = $1 FOR UPDATE`, [code]);
            const cur = found[0];
            if (!cur) {
              const id = randomUUID();
              const khatTypeId = await resolveKhatTypeId(client, f.title, f.penType);
              await client.query(
                `INSERT INTO courses (id, khat_type_id, category, title, description, is_deletable, created_by, code, structure_version,
                                      pen_type, course_type, title_ar, status, mistar_sizes, drive_folder_url, master_row, updated_at)
                 VALUES ($1, $2, $3, $4, $5, 1, $6, $7, 2, $8, $9, $10, 'draft', $11, $12, $13, CURRENT_TIMESTAMP(6))`,
                [id, khatTypeId, f.courseType === 'certification' ? 'certification' : 'secondary', f.title, f.description ?? null, actor.id, code,
                  f.penType ?? null, f.courseType ?? null, f.titleAr ?? null, JSON.stringify(f.mistarSizes ?? []), f.driveFolderUrl ?? null, JSON.stringify(masterRow)],
              );
              for (const b of branchIds ?? []) await client.query(`INSERT IGNORE INTO course_branches (course_id, branch_id) VALUES ($1, $2)`, [id, b]);
              const ct = courseTypes.find(t => t.typeKey === f.courseType);
              if (ct && !ct.hasLevels) {
                await client.query(
                  `INSERT INTO levels (id, course_id, order_index, level_type, title, code, status, updated_at) VALUES ($1, $2, 0, 'mufradat', 'LV01', 'LV01', 'published', CURRENT_TIMESTAMP(6))`,
                  [randomUUID(), id],
                );
              }
              return { kind: 'created' as const, id, summary: `Course ${code} "${f.title}" created from the master list (draft)` };
            }
            const sets: string[] = [];
            const params: unknown[] = [];
            const before: Record<string, unknown> = {};
            const after: Record<string, unknown> = {};
            const set = (col: string, camel: string, value: unknown, old: unknown) => {
              params.push(value);
              sets.push(`${col} = $${params.length}`);
              before[camel] = old; after[camel] = value;
            };
            if (f.title !== (cur.title ?? '')) set('title', 'title', f.title, cur.title);
            if (f.titleAr !== undefined && f.titleAr !== (cur.title_ar ?? '')) set('title_ar', 'titleAr', f.titleAr || null, cur.title_ar);
            if (f.penType !== undefined && f.penType !== (cur.pen_type ?? '')) set('pen_type', 'penType', f.penType || null, cur.pen_type);
            if (f.courseType !== undefined && f.courseType !== (cur.course_type ?? '')) set('course_type', 'courseType', f.courseType || null, cur.course_type);
            if (f.description !== undefined && f.description !== (cur.description ?? '')) set('description', 'description', f.description || null, cur.description);
            if (f.driveFolderUrl !== undefined && f.driveFolderUrl !== (cur.drive_folder_url ?? '')) set('drive_folder_url', 'driveFolderUrl', f.driveFolderUrl || null, cur.drive_folder_url);
            const oldSizes = toStringArray(cur.mistar_sizes);
            if (f.mistarSizes && f.mistarSizes.length && JSON.stringify(oldSizes) !== JSON.stringify(f.mistarSizes)) set('mistar_sizes', 'mistarSizes', JSON.stringify(f.mistarSizes), oldSizes);
            params.push(JSON.stringify(masterRow));
            sets.push(`master_row = $${params.length}`);
            params.push(cur.id);
            await client.query(`UPDATE courses SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP(6) WHERE id = $${params.length}`, params);
            if (branchIds !== undefined) {
              const { rows: oldB } = await client.query(`SELECT branch_id FROM course_branches WHERE course_id = $1`, [cur.id]);
              const oldIds = oldB.map(r => r.branch_id as string).sort();
              if (JSON.stringify(oldIds) !== JSON.stringify([...branchIds].sort())) {
                await client.query(`DELETE FROM course_branches WHERE course_id = $1`, [cur.id]);
                for (const b of branchIds) await client.query(`INSERT IGNORE INTO course_branches (course_id, branch_id) VALUES ($1, $2)`, [cur.id, b]);
                before.branchIds = oldIds; after.branchIds = branchIds;
              }
            }
            const changed = Object.keys(after);
            if (after.mistarSizes) after.mistarSizes = f.mistarSizes;
            return { kind: 'updated' as const, id: cur.id, changed, before, after, summary: `Course ${code} updated from the master list${changed.length ? `: ${changed.join(', ')}` : ' (no field changes)'}` };
          });
          if (result.kind === 'created') {
            created++;
            await logAudit({ actorId: actor.id, action: 'course.create', entityType: 'course', entityId: result.id, summary: result.summary, after: { code, ...f } });
          } else {
            updated++;
            if (result.changed.length) {
              // branch changes are not undoable field updates; log them under a different action
              const { branchIds: bBefore, ...fieldsBefore } = result.before as Record<string, unknown>;
              const { branchIds: bAfter, ...fieldsAfter } = result.after as Record<string, unknown>;
              if (Object.keys(fieldsAfter).length) await logAudit({ actorId: actor.id, action: 'course.update', entityType: 'course', entityId: result.id, summary: result.summary, before: fieldsBefore, after: fieldsAfter });
              if (bAfter) await logAudit({ actorId: actor.id, action: 'course.branches', entityType: 'course', entityId: result.id, summary: `Course ${code} branches changed from the master list`, before: { branchIds: bBefore }, after: { branchIds: bAfter } });
            }
          }
        } catch (error) {
          request.log.error(error);
          messages.push(`${code}: could not be saved (${(error as { code?: string }).code === 'ER_DUP_ENTRY' ? 'the code is already used' : 'server problem'}).`);
        }
      }
      return { created, updated, messages };
    },
  );
}
