import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { pool } from '../../db.js';
import type { AuditEntry, CourseDetail, ImportAction, Level, ManifestImportPreview, Step, StepFile } from '../contracts.js';
import { getActor, requireMaster, requireStaff, type Actor } from '../lib/access.js';
import { logAudit } from '../lib/audit.js';
import { computeHealth, nextCode } from '../lib/courseLogic.js';
import {
  courseIdForLevel, courseIdForStep, inList, levelHasActivity, loadCourseDetail, loadCourseSummaries, loadCourseTypes,
  loadLogicSets, loadStepTypes, parseJson, resequenceLevels, resequenceSteps, resolveKhatTypeId, staffCanReadCourse,
  stepsHaveActivity, toStringArray, withTx, iso, type Db,
} from '../lib/courseQueries.js';
import { readManifestSheet, stepTypeFromText } from '../lib/csv.js';
import { normaliseCourseCode, normaliseLevelCode, normaliseStepCode, parseMistarSizes, SIZE_CODES, sizesToText } from '../lib/naming.js';
import { fetchSheetCsv, MAX_CSV_CHARS, SheetFetchError } from '../lib/sheetFetch.js';
import { attachCanonicalName, normaliseVideoUrl, stepTypeRefusal, validateAttach } from '../lib/builderLogic.js';
import { fetchBytes, loadProfile, stampOptionsFor } from '../lib/filesData.js';
import { stampFiles } from '../lib/pdfStamp.js';
import { contentDisposition } from '../lib/filesLogic.js';

// ---------------------------------------------------------------- field definitions (also used by undo)
type Norm = { ok: true; value: unknown } | { ok: false; error: string };
type FieldDef = { col: string; label: string; norm: (v: unknown) => Norm | Promise<Norm>; json?: boolean; read?: (raw: unknown) => unknown };

const ok = (value: unknown): Norm => ({ ok: true, value });
const bad = (error: string): Norm => ({ ok: false, error });
const text = (label: string, max: number, required = false) => (v: unknown): Norm => {
  if (v === null || v === undefined || (typeof v === 'string' && !v.trim())) return required ? bad(`${label} cannot be empty.`) : ok(null);
  if (typeof v !== 'string') return bad(`${label} must be text.`);
  return v.length > max ? bad(`${label} is too long (max ${max} characters).`) : ok(v.trim());
};
const oneOf = (label: string, values: string[]) => (v: unknown): Norm => (values.includes(v as string) ? ok(v) : bad(`${label} must be one of: ${values.join(', ')}.`));

const designId = (v: unknown): Norm | Promise<Norm> => {
  if (v === null || v === undefined || v === '') return ok(null);
  if (typeof v !== 'string') return bad('Choose a badge design.');
  return pool.query(`SELECT id FROM badge_designs WHERE id = $1`, [v]).then(r => (r.rows[0] ? ok(v) : bad('That badge design does not exist any more.')));
};

const COURSE_FIELDS: Record<string, FieldDef> = {
  code: {
    col: 'code', label: 'Course Code',
    norm: v => { const c = normaliseCourseCode(typeof v === 'string' ? v : ''); return c ? ok(c) : bad('Course Code must look like FNK-C101.'); },
  },
  title: { col: 'title', label: 'Course name', norm: text('Course name', 500, true) },
  titleAr: { col: 'title_ar', label: 'Arabic name', norm: text('Arabic name', 500) },
  penType: { col: 'pen_type', label: 'Pen type', norm: text('Pen type', 32) },
  courseType: {
    col: 'course_type', label: 'Course type',
    norm: async v => {
      if (v === null || v === '') return ok(null);
      const types = await loadCourseTypes();
      return types.some(t => t.typeKey === v) ? ok(v) : bad(`Course type must be one of: ${types.map(t => t.typeKey).join(', ')}.`);
    },
  },
  description: { col: 'description', label: 'Description', norm: text('Description', 20000) },
  instructions: { col: 'instructions', label: 'Instructions', norm: text('Instructions', 20000) },
  driveFolderUrl: { col: 'drive_folder_url', label: 'Drive folder', norm: text('Drive folder', 2000) },
  mistarSizes: {
    col: 'mistar_sizes', label: 'Mistar sizes', json: true, read: raw => toStringArray(raw),
    norm: v => {
      if (v === null) return ok([]);
      if (typeof v === 'string') return ok(parseMistarSizes(v));
      if (Array.isArray(v) && v.every(s => (SIZE_CODES as readonly string[]).includes(s))) return ok(SIZE_CODES.filter(s => v.includes(s)));
      return bad('Mistar sizes must be from 07, 10, 20, 30, NP.');
    },
  },
  status: { col: 'status', label: 'Status', norm: oneOf('Status', ['draft', 'published', 'held', 'hidden']) },
  badgeDesignId: { col: 'badge_design_id', label: 'Course badge design', norm: designId },
  certificationReady: {
    col: 'certification_ready', label: 'Course complete (certificate can be given)', read: raw => Boolean(Number(raw ?? 0)),
    norm: v => (typeof v === 'boolean' ? ok(v) : bad('Course complete must be yes or no.')),
  },
  khatTypeId: {
    col: 'khat_type_id', label: 'Khat type',
    norm: async v => {
      if (typeof v !== 'string') return bad('Choose a khat type.');
      const { rows } = await pool.query(`SELECT id FROM khat_types WHERE id = $1`, [v]);
      return rows[0] ? ok(v) : bad('That khat type does not exist.');
    },
  },
};

const LEVEL_FIELDS: Record<string, FieldDef> = {
  code: { col: 'code', label: 'Level code', norm: v => { const c = normaliseLevelCode(typeof v === 'string' ? v : ''); return c ? ok(c) : bad('Level code must look like LV01.'); } },
  description: { col: 'description', label: 'Description', norm: text('Description', 2000) },
  instructions: { col: 'instructions', label: 'Instructions', norm: text('Instructions', 20000) },
  status: { col: 'status', label: 'Status', norm: oneOf('Status', ['published', 'hidden']) },
  badgeCode: { col: 'badge_code', label: 'Badge', norm: text('Badge', 64) },
  badgeDesignId: { col: 'badge_design_id', label: 'Badge design', norm: designId },
};

const STEP_FIELDS: Record<string, FieldDef> = {
  code: { col: 'code', label: 'Step code', norm: v => { const c = normaliseStepCode(typeof v === 'string' ? v : ''); return c ? ok(c) : bad('Step code must look like S01.'); } },
  title: { col: 'title', label: 'Task', norm: text('Task', 1000) },
  stepType: {
    col: 'step_type', label: 'Type',
    norm: async v => {
      const types = await loadStepTypes();
      return types.some(t => t.typeKey === v) ? ok(v) : bad(`Type must be one of: ${types.map(t => t.label).join(', ')}.`);
    },
  },
  message: { col: 'message', label: 'Message', norm: text('Message', 20000) },
  videoUrl: { col: 'video_url', label: 'Video link', norm: normaliseVideoUrl },
  maxMarks: {
    col: 'max_marks', label: 'Max marks', read: raw => (raw === null || raw === undefined ? null : Number(raw)),
    norm: v => (v === null || v === '' ? ok(null) : Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 100 ? ok(Number(v)) : bad('Max marks must be a whole number from 1 to 100.')),
  },
  badgeCode: { col: 'badge_code', label: 'Badge', norm: text('Badge', 64) },
  status: { col: 'status', label: 'Status', norm: oneOf('Status', ['published', 'hidden']) },
  template: { col: 'template', label: 'Template', norm: text('Template', 128) },
};

const ENTITY = {
  course: { table: 'courses', fields: COURSE_FIELDS },
  level: { table: 'levels', fields: LEVEL_FIELDS },
  step: { table: 'level_steps', fields: STEP_FIELDS },
} as const;
type EntityKind = keyof typeof ENTITY;

const show = (v: unknown) => {
  if (v === null || v === undefined || v === '') return '(empty)';
  if (Array.isArray(v)) return v.every(x => (SIZE_CODES as readonly string[]).includes(x)) ? sizesToText(v) || '(none)' : v.join(', ');
  const s = String(v);
  return s.length > 60 ? `"${s.slice(0, 57)}…"` : `"${s}"`;
};

class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

/** Validates and applies a partial update. Returns only the fields that really changed. */
async function applyPatch(db: Db, kind: EntityKind, id: string, patch: Record<string, unknown>): Promise<{ before: Record<string, unknown>; after: Record<string, unknown>; row: any }> {
  const { table, fields } = ENTITY[kind];
  const keys = Object.keys(patch ?? {}).filter(k => k in fields);
  const { rows } = await db.query(`SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
  const row = rows[0];
  if (!row) throw new HttpError(404, `${kind === 'course' ? 'Course' : kind === 'level' ? 'Level' : 'Step'} not found.`);
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const key of keys) {
    const def = fields[key];
    const res = await def.norm(patch[key]);
    if (!res.ok) throw new HttpError(400, res.error);
    const current = def.read ? def.read(row[def.col]) : (row[def.col] ?? null);
    if (JSON.stringify(current) === JSON.stringify(res.value)) continue;
    before[key] = current;
    after[key] = res.value;
    params.push(def.json ? JSON.stringify(res.value) : res.value);
    sets.push(`${def.col} = $${params.length}`);
  }
  if (kind === 'level' && ('description' in after || 'code' in after)) {
    params.push(String((after.description ?? row.description) || (after.code ?? row.code) || row.title || 'Level'));
    sets.push(`title = $${params.length}`);
  }
  if (!Object.keys(after).length) return { before, after, row };
  params.push(id);
  await db.query(`UPDATE ${table} SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP(6) WHERE id = $${params.length}`, params);
  return { before, after, row };
}

function changeSummary(fields: Record<string, FieldDef>, before: Record<string, unknown>, after: Record<string, unknown>): string {
  return Object.keys(after).map(k => `${fields[k]?.label ?? k} ${show(before[k])} → ${show(after[k])}`).join('; ');
}

async function sendError(reply: FastifyReply, request: FastifyRequest, error: unknown) {
  if (error instanceof HttpError) return reply.code(error.status).send({ error: error.message });
  if (error instanceof SheetFetchError) return reply.code(error.status).send({ error: error.message });
  const code = (error as { code?: string }).code;
  if (code === 'ER_DUP_ENTRY') return reply.code(409).send({ error: 'That code is already used. Choose another one.' });
  request.log.error(error);
  return reply.code(500).send({ error: 'Something went wrong on the server. Please try again.' });
}

/**
 * v3: publishing is refused while the health check has errors. Health is computed as if the course
 * (and the level, when given) were already published, so missing sheets count as errors.
 * Returns a plain message listing what to fix, or null.
 */
export async function publishBlock(courseId: string, levelId?: string): Promise<string | null> {
  const detail = await loadCourseDetail(courseId);
  if (!detail) return null;
  const sets = await loadLogicSets();
  const asLive = { ...detail, status: 'published' as const, levels: detail.levels.map(l => (l.id === levelId ? { ...l, status: 'published' as const } : l)) };
  let errors = computeHealth(asLive, sets.stepTypes, sets.courseTypes, sets.fileCodes).filter(i => i.severity === 'error');
  if (levelId) {
    const level = asLive.levels.find(l => l.id === levelId);
    const stepIds = new Set(level?.steps.map(s => s.id) ?? []);
    errors = errors.filter(i => i.levelId === levelId || (i.stepId && stepIds.has(i.stepId)));
  }
  if (!errors.length) return null;
  const list = errors.slice(0, 4).map((e, i) => `${i + 1}) ${e.message}`).join(' ');
  const more = errors.length > 4 ? ` …and ${errors.length - 4} more (see the Health tab).` : '';
  return `${levelId ? 'This level' : 'This course'} cannot be shown to students yet. Please fix ${errors.length === 1 ? 'this' : `these ${errors.length} things`} first: ${list}${more}`;
}

async function courseLabel(courseId: string, db: Db = pool): Promise<string> {
  const { rows } = await db.query(`SELECT code, title FROM courses WHERE id = $1`, [courseId]);
  return rows[0] ? (rows[0].code || rows[0].title) : 'course';
}

function stepOf(detail: CourseDetail | null, stepId: string): Step | null {
  for (const l of detail?.levels ?? []) { const s = l.steps.find(x => x.id === stepId); if (s) return s; }
  return null;
}

async function freshLevel(levelId: string): Promise<Level | null> {
  const courseId = await courseIdForLevel(levelId);
  if (!courseId) return null;
  return (await loadCourseDetail(courseId))?.levels.find(l => l.id === levelId) ?? null;
}
async function freshStep(stepId: string): Promise<Step | null> {
  const courseId = await courseIdForStep(stepId);
  return courseId ? stepOf(await loadCourseDetail(courseId), stepId) : null;
}

function mapStepFileRow(r: any): StepFile {
  return {
    id: r.id, role: r.role, sizeCode: r.size_code ?? null, page: r.page ?? 'P01', version: Number(r.version ?? 1), isCurrent: Boolean(r.is_current),
    storageKey: r.storage_key, originalFilename: r.original_filename ?? '', canonicalName: r.canonical_name ?? '', contentType: r.content_type ?? null,
    byteSize: r.byte_size === null || r.byte_size === undefined ? null : Number(r.byte_size), source: r.source ?? 'upload',
    uploadedAt: iso(r.uploaded_at) ?? new Date(0).toISOString(), uploadedByName: null,
  };
}

const UNDOABLE = new Set(['course.update', 'level.update', 'step.update']);

// Registered under prefix '/v2'
export async function coursesV2Routes(app: FastifyInstance): Promise<void> {
  const staff = { preHandler: [app.authenticate, requireStaff(app)] };
  const master = { preHandler: [app.authenticate, requireMaster(app)] };

  async function canRead(actor: Actor, courseId: string, reply: FastifyReply): Promise<boolean> {
    const { rows } = await pool.query(`SELECT id FROM courses WHERE id = $1`, [courseId]);
    if (!rows[0]) { reply.code(404).send({ error: 'Course not found.' }); return false; }
    if (!(await staffCanReadCourse(actor, courseId))) { reply.code(403).send({ error: 'This course is not offered in your branch.' }); return false; }
    return true;
  }

  // ---------------------------------------------------------------- courses
  app.get<{ Querystring: { status?: string; courseType?: string; penType?: string; branchId?: string; q?: string; structureVersion?: string } }>('/courses', staff, async request => {
    const actor = await getActor(request);
    const q = request.query;
    // Non-master staff only ever see the courses of their own branch.
    const branchId = actor.isMaster ? (q.branchId || undefined) : actor.branchId;
    const sv = Number(q.structureVersion);
    return loadCourseSummaries({
      status: q.status || undefined, courseType: q.courseType || undefined, penType: q.penType || undefined,
      branchId, q: q.q?.slice(0, 100) || undefined, structureVersion: sv === 1 || sv === 2 ? sv : undefined,
    });
  });

  app.post<{ Body: Record<string, unknown> }>('/courses', master, async (request, reply) => {
    const actor = await getActor(request);
    const body = request.body ?? {};
    try {
      const code = await COURSE_FIELDS.code.norm(body.code);
      if (!code.ok) throw new HttpError(400, code.error);
      const title = await COURSE_FIELDS.title.norm(body.title);
      if (!title.ok) throw new HttpError(400, title.error);
      const id = randomUUID();
      const courseTypes = await loadCourseTypes();
      await withTx(async client => {
        const { rows: dupe } = await client.query(`SELECT id FROM courses WHERE code = $1`, [code.value]);
        if (dupe[0]) throw new HttpError(409, `Course ${code.value} already exists.`);
        const khatTypeId = typeof body.khatTypeId === 'string' && body.khatTypeId
          ? body.khatTypeId : await resolveKhatTypeId(client, String(title.value), typeof body.penType === 'string' ? body.penType : null);
        await client.query(
          `INSERT INTO courses (id, khat_type_id, category, title, is_deletable, created_by, code, structure_version, status, mistar_sizes, updated_at)
           VALUES ($1, $2, $3, $4, 1, $5, $6, 2, 'draft', $7, CURRENT_TIMESTAMP(6))`,
          [id, khatTypeId, body.courseType === 'certification' ? 'certification' : 'secondary', title.value, actor.id, code.value, '[]'],
        );
        const rest: Record<string, unknown> = { ...body };
        delete rest.code; delete rest.title; delete rest.status; delete rest.khatTypeId;
        await applyPatch(client, 'course', id, rest);
        if (Array.isArray(body.branchIds)) {
          const ids = body.branchIds.filter((b): b is string => typeof b === 'string');
          if (ids.length) {
            const { rows } = await client.query(`SELECT id FROM branches WHERE id IN (${inList(ids.length)})`, ids);
            for (const r of rows) await client.query(`INSERT IGNORE INTO course_branches (course_id, branch_id) VALUES ($1, $2)`, [id, r.id]);
          }
        }
        const ct = courseTypes.find(t => t.typeKey === body.courseType);
        if (ct && !ct.hasLevels) {
          await client.query(`INSERT INTO levels (id, course_id, order_index, level_type, title, code, status, updated_at) VALUES ($1, $2, 0, 'mufradat', 'LV01', 'LV01', 'published', CURRENT_TIMESTAMP(6))`, [randomUUID(), id]);
        }
      });
      await logAudit({ actorId: actor.id, action: 'course.create', entityType: 'course', entityId: id, summary: `Course ${code.value} "${title.value}" created (draft)`, after: body });
      return reply.code(201).send(await loadCourseDetail(id));
    } catch (error) { return sendError(reply, request, error); }
  });

  app.get<{ Params: { id: string }; Querystring: { history?: string } }>('/courses/:id', staff, async (request, reply) => {
    const actor = await getActor(request);
    if (!(await canRead(actor, request.params.id, reply))) return;
    const history = request.query.history === '1' || request.query.history === 'true';
    return loadCourseDetail(request.params.id, { history });
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>('/courses/:id', master, async (request, reply) => {
    const actor = await getActor(request);
    try {
      const body = request.body ?? {};
      if (body.status === 'published') {
        const block = await publishBlock(request.params.id);
        if (block) throw new HttpError(409, block);
      }
      const result = await withTx(client => applyPatch(client, 'course', request.params.id, body));
      if (Array.isArray(body.branchIds)) await setBranches(actor, request.params.id, body.branchIds);
      if (Object.keys(result.after).length) {
        const label = result.row.code || result.row.title;
        const statusNote = result.after.status ? ({ draft: ' (only admins see it now)', published: ' (students of its branches can see it now)', held: ' (paused: enrolled students keep access, new students cannot join)', hidden: ' (students no longer see it; their work is kept)' } as Record<string, string>)[String(result.after.status)] ?? '' : '';
        await logAudit({ actorId: actor.id, action: 'course.update', entityType: 'course', entityId: request.params.id, summary: `Course ${label}: ${changeSummary(COURSE_FIELDS, result.before, result.after)}${statusNote}`, before: result.before, after: result.after });
      }
      return loadCourseDetail(request.params.id);
    } catch (error) { return sendError(reply, request, error); }
  });

  async function setBranches(actor: Actor, courseId: string, input: unknown[]): Promise<{ before: string[]; after: string[] }> {
    const ids = [...new Set(input.filter((b): b is string => typeof b === 'string'))];
    const result = await withTx(async client => {
      const { rows: course } = await client.query(`SELECT id, code, title FROM courses WHERE id = $1 FOR UPDATE`, [courseId]);
      if (!course[0]) throw new HttpError(404, 'Course not found.');
      const valid = ids.length ? (await client.query(`SELECT id FROM branches WHERE id IN (${inList(ids.length)})`, ids)).rows.map(r => r.id as string) : [];
      if (valid.length !== ids.length) throw new HttpError(400, 'One of the branches does not exist.');
      const { rows: old } = await client.query(`SELECT branch_id FROM course_branches WHERE course_id = $1`, [courseId]);
      const before = old.map(r => r.branch_id as string).sort();
      const after = [...valid].sort();
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        await client.query(`DELETE FROM course_branches WHERE course_id = $1`, [courseId]);
        for (const b of after) await client.query(`INSERT INTO course_branches (course_id, branch_id) VALUES ($1, $2)`, [courseId, b]);
        await client.query(`UPDATE courses SET updated_at = CURRENT_TIMESTAMP(6) WHERE id = $1`, [courseId]);
      }
      return { before, after, label: course[0].code || course[0].title };
    });
    if (JSON.stringify(result.before) !== JSON.stringify(result.after)) {
      const names = async (list: string[]) => list.length ? (await pool.query(`SELECT name FROM branches WHERE id IN (${inList(list.length)}) ORDER BY name`, list)).rows.map(r => r.name).join(', ') : 'all branches';
      await logAudit({ actorId: actor.id, action: 'course.branches', entityType: 'course', entityId: courseId, summary: `Course ${result.label}: branches ${await names(result.before)} → ${await names(result.after)}`, before: { branchIds: result.before }, after: { branchIds: result.after } });
    }
    return result;
  }

  app.put<{ Params: { id: string }; Body: { branchIds?: unknown } }>('/courses/:id/branches', master, async (request, reply) => {
    const actor = await getActor(request);
    if (!Array.isArray(request.body?.branchIds)) return reply.code(400).send({ error: 'Send branchIds (an empty list means all branches).' });
    try {
      await setBranches(actor, request.params.id, request.body.branchIds);
      return loadCourseDetail(request.params.id);
    } catch (error) { return sendError(reply, request, error); }
  });

  app.post<{ Params: { id: string }; Body: { code?: string; title?: string } }>('/courses/:id/copy', master, async (request, reply) => {
    const actor = await getActor(request);
    const code = normaliseCourseCode(request.body?.code ?? '');
    const title = typeof request.body?.title === 'string' ? request.body.title.trim() : '';
    if (!code) return reply.code(400).send({ error: 'The new Course Code must look like FNK-C101.' });
    if (!title) return reply.code(400).send({ error: 'Give the copy a course name.' });
    try {
      const newId = randomUUID();
      const sourceLabel = await withTx(async client => {
        const { rows } = await client.query(`SELECT * FROM courses WHERE id = $1`, [request.params.id]);
        const src = rows[0];
        if (!src) throw new HttpError(404, 'Course not found.');
        const { rows: dupe } = await client.query(`SELECT id FROM courses WHERE code = $1`, [code]);
        if (dupe[0]) throw new HttpError(409, `Course ${code} already exists.`);
        await client.query(
          `INSERT INTO courses (id, khat_type_id, category, title, course_style, description, is_deletable, created_by, guidance_question, code, structure_version,
                                pen_type, course_type, title_ar, status, mistar_sizes, drive_folder_url, master_row, instructions, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9, 2, $10, $11, $12, 'draft', $13, NULL, NULL, $14, CURRENT_TIMESTAMP(6))`,
          [newId, src.khat_type_id, src.category, title, src.course_style ?? '', src.description ?? null, actor.id, src.guidance_question ?? null, code,
            src.pen_type ?? null, src.course_type ?? null, src.title_ar ?? null, JSON.stringify(toStringArray(src.mistar_sizes)), src.instructions ?? null],
        );
        await client.query(`INSERT INTO course_branches (course_id, branch_id) SELECT $1, branch_id FROM course_branches WHERE course_id = $2`, [newId, src.id]);
        const { rows: levels } = await client.query(`SELECT * FROM levels WHERE course_id = $1 ORDER BY order_index`, [src.id]);
        const levelMap = new Map<string, string>();
        for (const [i, l] of levels.entries()) {
          const id = randomUUID();
          levelMap.set(l.id, id);
          const lc = l.code ?? `LV${i + 1 < 10 ? '0' : ''}${i + 1}`;
          await client.query(
            `INSERT INTO levels (id, course_id, order_index, level_type, title, code, description, instructions, status, badge_code, badge_design_id, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10, CURRENT_TIMESTAMP(6))`,
            [id, newId, i, l.level_type ?? 'mufradat', l.title ?? lc, lc, l.description ?? (l.code ? null : l.title), l.instructions ?? null, l.status ?? 'published', l.badge_design_id ?? null],
          );
        }
        const { rows: steps } = await client.query(`SELECT * FROM level_steps WHERE course_id = $1`, [src.id]);
        const stepMap = new Map<string, string>();
        for (const s of steps) {
          const levelId = levelMap.get(s.level_id);
          if (!levelId) continue;
          const id = randomUUID();
          stepMap.set(s.id, id);
          await client.query(
            `INSERT INTO level_steps (id, level_id, course_id, code, order_index, title, step_type, template, message, video_url, max_marks, badge_code, status, source, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL, $12, $13, CURRENT_TIMESTAMP(6))`,
            [id, levelId, newId, s.code, s.order_index, s.title ?? null, s.step_type, s.template ?? null, s.message ?? null, s.video_url ?? null, s.max_marks ?? null, s.status ?? 'published', s.source ?? 'manual'],
          );
        }
        const { rows: files } = await client.query(`SELECT * FROM step_files WHERE course_id = $1 AND is_current = 1`, [src.id]);
        for (const f of files) {
          const stepId = stepMap.get(f.step_id);
          if (!stepId) continue;
          const canonical = typeof f.canonical_name === 'string' && src.code ? f.canonical_name.replace(String(src.code), code) : f.canonical_name;
          await client.query(
            `INSERT INTO step_files (id, step_id, course_id, role, size_code, page, version, is_current, storage_key, original_filename, canonical_name, content_type, byte_size, source, uploaded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9, $10, $11, $12, $13, $14)`,
            [randomUUID(), stepId, newId, f.role, f.size_code ?? null, f.page ?? 'P01', f.version ?? 1, f.storage_key, f.original_filename ?? null, canonical ?? null, f.content_type ?? null, f.byte_size ?? null, f.source ?? 'upload', actor.id],
          );
        }
        return src.code || src.title;
      });
      await logAudit({ actorId: actor.id, action: 'course.copy', entityType: 'course', entityId: newId, summary: `Course ${code} "${title}" copied from ${sourceLabel} (draft)`, after: { code, title, from: request.params.id } });
      return reply.code(201).send(await loadCourseDetail(newId));
    } catch (error) { return sendError(reply, request, error); }
  });

  // ---------------------------------------------------------------- manifest (*_Tasks sheet)
  app.post<{ Params: { id: string }; Body: { sheetUrl?: string; csvText?: string } }>(
    '/courses/:id/manifest/preview', { preHandler: [app.authenticate, requireMaster(app)], bodyLimit: 8 * 1024 * 1024 },
    async (request, reply) => {
      try {
        const detail = await loadCourseDetail(request.params.id);
        if (!detail) throw new HttpError(404, 'Course not found.');
        const { csvText, sheetUrl } = request.body ?? {};
        let csv: string;
        if (typeof csvText === 'string' && csvText.trim()) {
          if (csvText.length > MAX_CSV_CHARS) throw new HttpError(413, 'This CSV is too large.');
          csv = csvText;
        } else if (typeof sheetUrl === 'string' && sheetUrl.trim()) {
          csv = (await fetchSheetCsv(sheetUrl, detail.code ? `${detail.code}_Tasks` : undefined)).csv;
        } else throw new HttpError(400, 'Paste the link to the course\'s _Tasks sheet, or upload it as CSV.');
        let sheet;
        try { sheet = readManifestSheet(csv); } catch (e) { throw new HttpError(400, (e as Error).message); }
        const stepTypes = await loadStepTypes();
        const rows: ManifestImportPreview['rows'] = sheet.map(r => {
          const resolvedType = stepTypeFromText(r.typeText, stepTypes);
          const base = { level: r.level ?? r.rawLevel, description: r.description, step: r.step ?? r.rawStep, task: r.task, stepType: resolvedType ?? '', template: r.template, maxMarks: r.maxMarks ?? null, badgeCode: r.badgeCode ?? null };
          if (!r.level || !r.step) return { ...base, action: 'error' as ImportAction, message: `Row ${r.rowNumber}: could not read level "${r.rawLevel}" / step "${r.rawStep}" (use LV01 and S01).` };
          const typeNote = r.typeText && !resolvedType ? ` Type "${r.typeText}" is not known — the step type will not change.` : '';
          const level = detail.levels.find(l => l.code === r.level);
          const step = level?.steps.find(s => s.code === r.step);
          if (!level || !step) {
            return { ...base, action: 'create' as ImportAction, message: `${r.level} ${r.step} does not exist yet. It is created only if you choose "also create missing steps" — otherwise uploading its file creates it.${typeNote}` };
          }
          const changes: string[] = [];
          if (r.description && r.description !== (level.description ?? '')) changes.push(`level description → ${r.description}`);
          if (r.task && r.task !== step.title) changes.push(`task → ${r.task}`);
          if (resolvedType && resolvedType !== step.stepType) changes.push(`type ${step.stepType} → ${resolvedType}`);
          if (r.template && r.template !== (step.template ?? '')) changes.push(`template → ${r.template}`);
          if (r.maxMarks !== undefined && r.maxMarks !== null && r.maxMarks !== step.maxMarks) changes.push(`max marks → ${r.maxMarks}`);
          if (r.badgeCode && r.badgeCode !== (step.badgeCode ?? '')) changes.push(`badge → ${r.badgeCode}`);
          return { ...base, action: (changes.length ? 'update' : 'same') as ImportAction, message: changes.length ? `Will update: ${changes.join('; ')}.${typeNote}` : `No change.${typeNote}` };
        });
        const body: ManifestImportPreview = { courseId: detail.id, rows };
        return body;
      } catch (error) { return sendError(reply, request, error); }
    },
  );

  app.post<{ Params: { id: string }; Body: { rows?: ManifestImportPreview['rows']; createMissing?: boolean } }>(
    '/courses/:id/manifest/apply', { preHandler: [app.authenticate, requireMaster(app)], bodyLimit: 8 * 1024 * 1024 },
    async (request, reply) => {
      const actor = await getActor(request);
      const rows = request.body?.rows;
      const createMissing = request.body?.createMissing === true;
      if (!Array.isArray(rows)) return reply.code(400).send({ error: 'Nothing to apply — preview the sheet first.' });
      try {
        const stepTypes = await loadStepTypes();
        const audits: Parameters<typeof logAudit>[0][] = [];
        const counts = await withTx(async client => {
          const { rows: course } = await client.query(`SELECT id, code, title FROM courses WHERE id = $1 FOR UPDATE`, [request.params.id]);
          if (!course[0]) throw new HttpError(404, 'Course not found.');
          const label = course[0].code || course[0].title;
          let created = 0; let updated = 0; let skipped = 0;
          for (const r of rows) {
            const lc = normaliseLevelCode(r?.level);
            const sc = normaliseStepCode(r?.step);
            if (!r || !lc || !sc || r.action === 'error') { skipped++; continue; }
            const typeKey = r.stepType && stepTypes.some(t => t.typeKey === r.stepType) ? r.stepType : null;
            let { rows: lv } = await client.query(`SELECT id, description FROM levels WHERE course_id = $1 AND code = $2`, [course[0].id, lc]);
            let levelId: string | null = lv[0]?.id ?? null;
            if (!levelId) {
              if (!createMissing) { skipped++; continue; }
              levelId = randomUUID();
              const { rows: mx } = await client.query(`SELECT COALESCE(MAX(order_index), -1) + 1 AS n FROM levels WHERE course_id = $1`, [course[0].id]);
              await client.query(`INSERT INTO levels (id, course_id, order_index, level_type, title, code, description, status, updated_at) VALUES ($1, $2, $3, 'mufradat', $4, $5, $6, 'published', CURRENT_TIMESTAMP(6))`,
                [levelId, course[0].id, Number(mx[0]?.n ?? 0), r.description || lc, lc, r.description || null]);
              audits.push({ actorId: actor.id, action: 'level.create', entityType: 'level', entityId: levelId, summary: `Level ${lc} created in ${label} from the _Tasks sheet` });
              lv = [{ id: levelId, description: r.description || null }];
            } else if (r.description && r.description !== (lv[0].description ?? '')) {
              const res = await applyPatch(client, 'level', levelId, { description: r.description });
              if (Object.keys(res.after).length) audits.push({ actorId: actor.id, action: 'level.update', entityType: 'level', entityId: levelId, summary: `${label} ${lc}: ${changeSummary(LEVEL_FIELDS, res.before, res.after)} (from the _Tasks sheet)`, before: res.before, after: res.after });
            }
            const { rows: st } = await client.query(`SELECT id FROM level_steps WHERE level_id = $1 AND code = $2`, [levelId, sc]);
            const patch: Record<string, unknown> = {};
            if (r.task) patch.title = r.task;
            if (typeKey) patch.stepType = typeKey;
            if (r.template) patch.template = r.template;
            if (r.maxMarks !== undefined && r.maxMarks !== null) patch.maxMarks = r.maxMarks;
            if (r.badgeCode) patch.badgeCode = r.badgeCode;
            if (!st[0]) {
              if (!createMissing) { skipped++; continue; }
              const stepId = randomUUID();
              const { rows: mx } = await client.query(`SELECT COUNT(*) AS n FROM level_steps WHERE level_id = $1`, [levelId]);
              await client.query(`INSERT INTO level_steps (id, level_id, course_id, code, order_index, title, step_type, status, source, updated_at) VALUES ($1, $2, $3, $4, $5, NULL, $6, 'published', 'manifest', CURRENT_TIMESTAMP(6))`,
                [stepId, levelId, course[0].id, sc, Number(mx[0]?.n ?? 0), typeKey ?? 'worksheet']);
              await applyPatch(client, 'step', stepId, patch);
              audits.push({ actorId: actor.id, action: 'step.create', entityType: 'step', entityId: stepId, summary: `Step ${lc} ${sc}${r.task ? ` '${r.task}'` : ''} created in ${label} from the _Tasks sheet` });
              created++;
              continue;
            }
            const res = await applyPatch(client, 'step', st[0].id, patch);
            if (Object.keys(res.after).length) {
              updated++;
              audits.push({ actorId: actor.id, action: 'step.update', entityType: 'step', entityId: st[0].id, summary: `${label} ${lc} ${sc}: ${changeSummary(STEP_FIELDS, res.before, res.after)} (from the _Tasks sheet)`, before: res.before, after: res.after });
            }
          }
          await client.query(`UPDATE courses SET updated_at = CURRENT_TIMESTAMP(6) WHERE id = $1`, [course[0].id]);
          return { created, updated, skipped };
        });
        for (const a of audits) await logAudit(a);
        return { ...counts, course: await loadCourseDetail(request.params.id) };
      } catch (error) { return sendError(reply, request, error); }
    },
  );

  // ---------------------------------------------------------------- levels
  app.post<{ Params: { id: string }; Body: { code?: string; description?: string; instructions?: string } }>('/courses/:id/levels', master, async (request, reply) => {
    const actor = await getActor(request);
    try {
      const body = request.body ?? {};
      const levelId = randomUUID();
      const { code, label } = await withTx(async client => {
        const { rows: course } = await client.query(`SELECT id, code, title FROM courses WHERE id = $1 FOR UPDATE`, [request.params.id]);
        if (!course[0]) throw new HttpError(404, 'Course not found.');
        const { rows: levels } = await client.query(`SELECT id, code, order_index FROM levels WHERE course_id = $1 ORDER BY order_index`, [request.params.id]);
        const code = body.code ? normaliseLevelCode(body.code) : nextCode('LV', levels.map(l => l.code));
        if (!code) throw new HttpError(400, 'Level code must look like LV01.');
        if (levels.some(l => l.code === code)) throw new HttpError(409, `${code} already exists in this course.`);
        const max = levels.reduce((m, l) => Math.max(m, Number(l.order_index)), -1);
        await client.query(
          `INSERT INTO levels (id, course_id, order_index, level_type, title, code, description, instructions, status, updated_at)
           VALUES ($1, $2, $3, 'mufradat', $4, $5, $6, $7, 'published', CURRENT_TIMESTAMP(6))`,
          [levelId, request.params.id, max + 1, body.description?.trim() || code, code, body.description?.trim() || null, body.instructions?.trim() || null],
        );
        // keep code order when the new code sits between existing ones
        const pos = levels.findIndex(l => l.code && l.code.localeCompare(code) > 0);
        if (pos >= 0) {
          const ordered = levels.map(l => l.id as string);
          ordered.splice(pos, 0, levelId);
          await resequenceLevels(client, request.params.id, ordered);
        }
        await client.query(`UPDATE courses SET updated_at = CURRENT_TIMESTAMP(6) WHERE id = $1`, [request.params.id]);
        return { code, label: course[0].code || course[0].title };
      });
      await logAudit({ actorId: actor.id, action: 'level.create', entityType: 'level', entityId: levelId, summary: `Level ${code}${body.description ? ` (${body.description})` : ''} added to ${label}`, after: { code, description: body.description ?? null } });
      return reply.code(201).send(await freshLevel(levelId));
    } catch (error) { return sendError(reply, request, error); }
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>('/levels/:id', master, async (request, reply) => {
    const actor = await getActor(request);
    try {
      if ((request.body ?? {}).status === 'published') {
        const courseId = await courseIdForLevel(request.params.id);
        const block = courseId ? await publishBlock(courseId, request.params.id) : null;
        if (block) throw new HttpError(409, block);
      }
      const result = await withTx(async client => {
        const res = await applyPatch(client, 'level', request.params.id, request.body ?? {});
        if ('code' in res.after) {
          const { rows } = await client.query(`SELECT id FROM levels WHERE course_id = $1 AND code = $2 AND id <> $3`, [res.row.course_id, res.after.code, request.params.id]);
          if (rows[0]) throw new HttpError(409, `${res.after.code} already exists in this course.`);
        }
        return res;
      });
      if (Object.keys(result.after).length) {
        const label = await courseLabel(result.row.course_id);
        await logAudit({ actorId: actor.id, action: 'level.update', entityType: 'level', entityId: request.params.id, summary: `${label} ${result.row.code ?? ''}: ${changeSummary(LEVEL_FIELDS, result.before, result.after)}`, before: result.before, after: result.after });
      }
      return freshLevel(request.params.id);
    } catch (error) { return sendError(reply, request, error); }
  });

  app.post<{ Params: { id: string }; Body: { orderedIds?: unknown } }>('/courses/:id/levels/reorder', master, async (request, reply) => {
    const actor = await getActor(request);
    const ids = request.body?.orderedIds;
    if (!Array.isArray(ids) || !ids.every(i => typeof i === 'string')) return reply.code(400).send({ error: 'Send orderedIds (every level of the course, in the new order).' });
    try {
      const before = await withTx(async client => {
        const { rows } = await client.query(`SELECT id, code FROM levels WHERE course_id = $1 ORDER BY order_index FOR UPDATE`, [request.params.id]);
        if (!rows.length) throw new HttpError(404, 'This course has no levels.');
        const existing = new Set(rows.map(r => r.id));
        if (new Set(ids).size !== ids.length || ids.length !== existing.size || ids.some(i => !existing.has(i))) {
          throw new HttpError(400, 'The new order must list every level of this course exactly once.');
        }
        await resequenceLevels(client, request.params.id, ids as string[]);
        return rows;
      });
      const codeOf = new Map(before.map(r => [r.id, r.code]));
      await logAudit({ actorId: actor.id, action: 'level.reorder', entityType: 'course', entityId: request.params.id, summary: `${await courseLabel(request.params.id)}: levels reordered to ${(ids as string[]).map(i => codeOf.get(i)).join(', ')}`, before: { orderedIds: before.map(r => r.id) }, after: { orderedIds: ids } });
      return (await loadCourseDetail(request.params.id))?.levels ?? [];
    } catch (error) { return sendError(reply, request, error); }
  });

  app.delete<{ Params: { id: string } }>('/levels/:id', master, async (request, reply) => {
    const actor = await getActor(request);
    try {
      const { rows } = await pool.query(`SELECT id, course_id, code, title, status FROM levels WHERE id = $1`, [request.params.id]);
      const level = rows[0];
      if (!level) return reply.code(404).send({ error: 'Level not found.' });
      const label = `${await courseLabel(level.course_id)} ${level.code ?? level.title}`;
      if (await levelHasActivity(level.id)) {
        await pool.query(`UPDATE levels SET status = 'hidden', updated_at = CURRENT_TIMESTAMP(6) WHERE id = $1`, [level.id]);
        await logAudit({ actorId: actor.id, action: 'level.update', entityType: 'level', entityId: level.id, summary: `${label} hidden instead of deleted (students have work in it)`, before: { status: level.status }, after: { status: 'hidden' } });
        return { deleted: false, hidden: true, message: `${level.code ?? 'This level'} has student work, so it was hidden instead of deleted. Their work is kept, and you can show it again any time.` };
      }
      await withTx(async client => {
        await client.query(`DELETE FROM step_files WHERE step_id IN (SELECT id FROM level_steps WHERE level_id = $1)`, [level.id]);
        await client.query(`DELETE FROM level_steps WHERE level_id = $1`, [level.id]);
        await client.query(`DELETE FROM levels WHERE id = $1`, [level.id]);
        const { rows: rest } = await client.query(`SELECT id FROM levels WHERE course_id = $1 ORDER BY order_index`, [level.course_id]);
        await resequenceLevels(client, level.course_id, rest.map(r => r.id));
      });
      await logAudit({ actorId: actor.id, action: 'level.delete', entityType: 'level', entityId: level.id, summary: `${label} deleted (it had no student work)`, before: { code: level.code, courseId: level.course_id } });
      return { deleted: true, hidden: false, message: `${level.code ?? 'The level'} was deleted.` };
    } catch (error) { return sendError(reply, request, error); }
  });

  // ---------------------------------------------------------------- steps
  app.post<{ Params: { id: string }; Body: { code?: string; title?: string; stepType?: string; videoUrl?: string | null; message?: string | null } }>('/levels/:id/steps', master, async (request, reply) => {
    const actor = await getActor(request);
    try {
      const body = request.body ?? {};
      const stepTypes = await loadStepTypes();
      const stepType = body.stepType ?? 'worksheet';
      if (!stepTypes.some(t => t.typeKey === stepType)) throw new HttpError(400, `Type must be one of: ${stepTypes.map(t => t.label).join(', ')}.`);
      // v3 (6.12): only the step types allowed for this kind of course can be added by hand.
      const { rows: ctRows } = await pool.query(`SELECT c.course_type FROM levels l JOIN courses c ON c.id = l.course_id WHERE l.id = $1`, [request.params.id]);
      if (!ctRows[0]) throw new HttpError(404, 'Level not found.');
      const refusal = stepTypeRefusal(stepType, ctRows[0].course_type ?? null, await loadCourseTypes(), stepTypes);
      if (refusal) throw new HttpError(400, refusal);
      const video = normaliseVideoUrl(body.videoUrl);
      if (!video.ok) throw new HttpError(400, video.error);
      const stepId = randomUUID();
      const info = await withTx(async client => {
        const { rows: lv } = await client.query(`SELECT id, course_id, code FROM levels WHERE id = $1 FOR UPDATE`, [request.params.id]);
        if (!lv[0]) throw new HttpError(404, 'Level not found.');
        const { rows: steps } = await client.query(`SELECT id, code FROM level_steps WHERE level_id = $1 ORDER BY order_index, code`, [request.params.id]);
        const code = body.code ? normaliseStepCode(body.code) : nextCode('S', steps.map(s => s.code));
        if (!code) throw new HttpError(400, 'Step code must look like S01.');
        if (steps.some(s => s.code === code)) throw new HttpError(409, `${code} already exists in this level.`);
        await client.query(
          `INSERT INTO level_steps (id, level_id, course_id, code, order_index, title, step_type, message, video_url, status, source, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'published', 'manual', CURRENT_TIMESTAMP(6))`,
          [stepId, lv[0].id, lv[0].course_id, code, steps.length, body.title?.trim() || null, stepType, typeof body.message === 'string' && body.message.trim() ? body.message.trim().slice(0, 20000) : null, video.value],
        );
        const pos = steps.findIndex(s => s.code.localeCompare(code) > 0);
        if (pos >= 0) {
          const ordered = steps.map(s => s.id as string);
          ordered.splice(pos, 0, stepId);
          await resequenceSteps(client, lv[0].id, ordered);
        }
        await client.query(`UPDATE courses SET updated_at = CURRENT_TIMESTAMP(6) WHERE id = $1`, [lv[0].course_id]);
        return { code, levelCode: lv[0].code, courseId: lv[0].course_id };
      });
      await logAudit({ actorId: actor.id, action: 'step.create', entityType: 'step', entityId: stepId, summary: `Step ${info.levelCode ?? ''} ${info.code}${body.title ? ` '${body.title}'` : ''} (${stepType}) added to ${await courseLabel(info.courseId)}`, after: { code: info.code, title: body.title ?? null, stepType } });
      return reply.code(201).send(await freshStep(stepId));
    } catch (error) { return sendError(reply, request, error); }
  });

  async function stepContextLabel(stepId: string): Promise<string> {
    const { rows } = await pool.query(
      `SELECT s.code AS step_code, l.code AS level_code, c.code AS course_code, c.title AS course_title
       FROM level_steps s JOIN levels l ON l.id = s.level_id JOIN courses c ON c.id = s.course_id WHERE s.id = $1`, [stepId]);
    const r = rows[0];
    return r ? `${r.course_code || r.course_title} ${r.level_code ?? ''} ${r.step_code}`.replace(/\s+/g, ' ') : 'Step';
  }

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>('/steps/:id', master, async (request, reply) => {
    const actor = await getActor(request);
    try {
      const result = await withTx(async client => {
        const res = await applyPatch(client, 'step', request.params.id, request.body ?? {});
        if ('code' in res.after) {
          const { rows } = await client.query(`SELECT id FROM level_steps WHERE level_id = $1 AND code = $2 AND id <> $3`, [res.row.level_id, res.after.code, request.params.id]);
          if (rows[0]) throw new HttpError(409, `${res.after.code} already exists in this level.`);
        }
        return res;
      });
      if (Object.keys(result.after).length) {
        await logAudit({ actorId: actor.id, action: 'step.update', entityType: 'step', entityId: request.params.id, summary: `${await stepContextLabel(request.params.id)}: ${changeSummary(STEP_FIELDS, result.before, result.after)}`, before: result.before, after: result.after });
      }
      return freshStep(request.params.id);
    } catch (error) { return sendError(reply, request, error); }
  });

  app.post<{ Params: { id: string }; Body: { orderedIds?: unknown } }>('/levels/:id/steps/reorder', master, async (request, reply) => {
    const actor = await getActor(request);
    const ids = request.body?.orderedIds;
    if (!Array.isArray(ids) || !ids.every(i => typeof i === 'string')) return reply.code(400).send({ error: 'Send orderedIds (every step of the level, in the new order).' });
    try {
      const before = await withTx(async client => {
        const { rows } = await client.query(`SELECT id, code FROM level_steps WHERE level_id = $1 ORDER BY order_index, code FOR UPDATE`, [request.params.id]);
        if (!rows.length) throw new HttpError(404, 'This level has no steps.');
        const existing = new Set(rows.map(r => r.id));
        if (new Set(ids).size !== ids.length || ids.length !== existing.size || ids.some(i => !existing.has(i))) throw new HttpError(400, 'The new order must list every step of this level exactly once.');
        await resequenceSteps(client, request.params.id, ids as string[]);
        return rows;
      });
      const codeOf = new Map(before.map(r => [r.id, r.code]));
      await logAudit({ actorId: actor.id, action: 'step.reorder', entityType: 'level', entityId: request.params.id, summary: `Steps reordered to ${(ids as string[]).map(i => codeOf.get(i)).join(', ')}`, before: { orderedIds: before.map(r => r.id) }, after: { orderedIds: ids } });
      return (await freshLevel(request.params.id))?.steps ?? [];
    } catch (error) { return sendError(reply, request, error); }
  });

  app.delete<{ Params: { id: string } }>('/steps/:id', master, async (request, reply) => {
    const actor = await getActor(request);
    try {
      const { rows } = await pool.query(`SELECT id, level_id, code, status FROM level_steps WHERE id = $1`, [request.params.id]);
      const step = rows[0];
      if (!step) return reply.code(404).send({ error: 'Step not found.' });
      const label = await stepContextLabel(step.id);
      if (await stepsHaveActivity([step.id])) {
        await pool.query(`UPDATE level_steps SET status = 'hidden', updated_at = CURRENT_TIMESTAMP(6) WHERE id = $1`, [step.id]);
        await logAudit({ actorId: actor.id, action: 'step.update', entityType: 'step', entityId: step.id, summary: `${label} hidden instead of deleted (students have work in it)`, before: { status: step.status }, after: { status: 'hidden' } });
        return { deleted: false, hidden: true, message: `${step.code} has student work, so it was hidden instead of deleted. Their work is kept.` };
      }
      await withTx(async client => {
        await client.query(`DELETE FROM step_files WHERE step_id = $1`, [step.id]);
        await client.query(`DELETE FROM level_steps WHERE id = $1`, [step.id]);
        const { rows: rest } = await client.query(`SELECT id FROM level_steps WHERE level_id = $1 ORDER BY order_index, code`, [step.level_id]);
        await resequenceSteps(client, step.level_id, rest.map(r => r.id));
      });
      await logAudit({ actorId: actor.id, action: 'step.delete', entityType: 'step', entityId: step.id, summary: `${label} deleted (it had no student work)`, before: { code: step.code, levelId: step.level_id } });
      return { deleted: true, hidden: false, message: `${step.code} was deleted.` };
    } catch (error) { return sendError(reply, request, error); }
  });

  app.post<{ Body: { stepIds?: unknown; patch?: Record<string, unknown> } }>('/steps/bulk', master, async (request, reply) => {
    const actor = await getActor(request);
    const ids = request.body?.stepIds;
    const patch = request.body?.patch;
    if (!Array.isArray(ids) || !ids.length || !ids.every(i => typeof i === 'string')) return reply.code(400).send({ error: 'Select at least one step.' });
    if (!patch || typeof patch !== 'object' || !Object.keys(patch).some(k => k in STEP_FIELDS && k !== 'code')) return reply.code(400).send({ error: 'Choose what to change (type, status, message, marks, badge, template or task).' });
    const cleanPatch = Object.fromEntries(Object.entries(patch).filter(([k]) => k in STEP_FIELDS && k !== 'code'));
    try {
      const changes = await withTx(async client => {
        const out: { id: string; before: Record<string, unknown>; after: Record<string, unknown> }[] = [];
        for (const id of new Set(ids as string[])) {
          const res = await applyPatch(client, 'step', id, cleanPatch);
          if (Object.keys(res.after).length) out.push({ id, before: res.before, after: res.after });
        }
        return out;
      });
      for (const c of changes) {
        await logAudit({ actorId: actor.id, action: 'step.update', entityType: 'step', entityId: c.id, summary: `${await stepContextLabel(c.id)}: ${changeSummary(STEP_FIELDS, c.before, c.after)} (changed together with ${changes.length - 1} other step${changes.length === 2 ? '' : 's'})`, before: c.before, after: c.after });
      }
      const courseIds = [...new Set(await Promise.all((ids as string[]).map(id => courseIdForStep(id))))].filter((x): x is string => Boolean(x));
      const steps: Step[] = [];
      for (const cid of courseIds) {
        const d = await loadCourseDetail(cid);
        for (const l of d?.levels ?? []) for (const s of l.steps) if ((ids as string[]).includes(s.id)) steps.push(s);
      }
      return { changed: changes.length, steps };
    } catch (error) { return sendError(reply, request, error); }
  });

  // ---------------------------------------------------------------- step files
  async function fileLabel(fileId: string): Promise<{ row: any; label: string } | null> {
    const { rows } = await pool.query(`SELECT * FROM step_files WHERE id = $1`, [fileId]);
    if (!rows[0]) return null;
    return { row: rows[0], label: `${await stepContextLabel(rows[0].step_id)} ${rows[0].canonical_name ?? rows[0].original_filename ?? ''}`.trim() };
  }

  app.delete<{ Params: { id: string } }>('/step-files/:id', master, async (request, reply) => {
    const actor = await getActor(request);
    const f = await fileLabel(request.params.id);
    if (!f) return reply.code(404).send({ error: 'File not found.' });
    if (f.row.is_current) {
      await pool.query(`UPDATE step_files SET is_current = 0 WHERE id = $1`, [request.params.id]);
      await pool.query(`UPDATE courses SET updated_at = CURRENT_TIMESTAMP(6) WHERE id = $1`, [f.row.course_id]);
      await logAudit({ actorId: actor.id, action: 'file.remove', entityType: 'step_file', entityId: request.params.id, summary: `Removed ${f.label} (kept in history — it can be restored)`, before: { isCurrent: true }, after: { isCurrent: false } });
    }
    return { ...mapStepFileRow({ ...f.row, is_current: 0 }), message: 'The file was removed from the course and kept in history. You can restore it any time.' };
  });

  app.post<{ Params: { id: string } }>('/step-files/:id/restore', master, async (request, reply) => {
    const actor = await getActor(request);
    const f = await fileLabel(request.params.id);
    if (!f) return reply.code(404).send({ error: 'File not found.' });
    const r = f.row;
    try {
      const demoted = await withTx(async client => {
        const { rows } = await client.query(
          `SELECT id, version FROM step_files WHERE step_id = $1 AND role = $2 AND size_code <=> $3 AND page = $4 AND is_current = 1 AND id <> $5 FOR UPDATE`,
          [r.step_id, r.role, r.size_code ?? null, r.page, r.id]);
        if (rows.length) await client.query(`UPDATE step_files SET is_current = 0 WHERE id IN (${inList(rows.length)})`, rows.map(x => x.id));
        await client.query(`UPDATE step_files SET is_current = 1 WHERE id = $1`, [r.id]);
        await client.query(`UPDATE courses SET updated_at = CURRENT_TIMESTAMP(6) WHERE id = $1`, [r.course_id]);
        return rows.map(x => `v${x.version}`);
      });
      await logAudit({ actorId: actor.id, action: 'file.restore', entityType: 'step_file', entityId: r.id, summary: `Restored ${f.label}${demoted.length ? ` (${demoted.join(', ')} moved to history)` : ''}`, before: { isCurrent: false }, after: { isCurrent: true } });
      return { ...mapStepFileRow({ ...r, is_current: 1 }), message: `v${r.version} is in use again.${demoted.length ? ` ${demoted.join(', ')} moved to history.` : ''}` };
    } catch (error) { return sendError(reply, request, error); }
  });

  // ---------------------------------------------------------------- health + audit
  // ---------------------------------------------------------------- v3: attach one file to a step from the builder
  // Body: {role: worksheet|reference|assessment_sheet|resource, sizeCode?, page?, storageKey, originalFilename, contentType?, byteSize?}
  // The same slot (role + size + page) keeps its history: the new file becomes vN+1 and the old one moves to history.
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/steps/:id/files', master, async (request, reply) => {
    const actor = await getActor(request);
    const v = validateAttach(request.body);
    if (!v.ok) return reply.code(400).send({ error: v.error });
    const f = v.value;
    try {
      const out = await withTx(async client => {
        const { rows } = await client.query(
          `SELECT s.id, s.code, s.course_id, l.code AS level_code, c.code AS course_code, c.course_type
             FROM level_steps s JOIN levels l ON l.id = s.level_id JOIN courses c ON c.id = s.course_id WHERE s.id = $1 FOR UPDATE`, [request.params.id]);
        const st = rows[0];
        if (!st) throw new HttpError(404, 'Step not found.');
        const types = await loadCourseTypes(client);
        const hiddenLevel = types.find(t => t.typeKey === st.course_type)?.hasLevels === false;
        const { rows: same } = await client.query(
          `SELECT id, version, is_current FROM step_files WHERE step_id = $1 AND role = $2 AND page = $3 AND ${f.sizeCode ? 'size_code = $4' : 'size_code IS NULL'}`,
          f.sizeCode ? [st.id, f.role, f.page, f.sizeCode] : [st.id, f.role, f.page]);
        const version = same.reduce((m, r) => Math.max(m, Number(r.version ?? 1)), 0) + 1;
        const replaced = same.filter(r => Boolean(r.is_current)).map(r => r.id as string);
        if (replaced.length) await client.query(`UPDATE step_files SET is_current = 0 WHERE id IN (${inList(replaced.length)})`, replaced);
        const canonical = attachCanonicalName({ courseCode: st.course_code, levelCode: st.level_code, stepCode: st.code, hiddenLevel, role: f.role, sizeCode: f.sizeCode, page: f.page, version, ext: f.ext });
        const fileId = randomUUID();
        await client.query(
          `INSERT INTO step_files (id, step_id, course_id, role, size_code, page, version, is_current, storage_key, original_filename, canonical_name, content_type, byte_size, source, uploaded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9, $10, $11, $12, 'upload', $13)`,
          [fileId, st.id, st.course_id, f.role, f.sizeCode, f.page, version, f.storageKey, f.originalFilename, canonical, f.contentType, f.byteSize, actor.id]);
        await client.query(`UPDATE courses SET updated_at = CURRENT_TIMESTAMP(6) WHERE id = $1`, [st.course_id]);
        return { fileId, canonical, replaced: replaced.length, courseId: st.course_id as string };
      });
      await logAudit({ actorId: actor.id, action: 'file.add', entityType: 'step_file', entityId: out.fileId, summary: `${await stepContextLabel(request.params.id)}: ${out.canonical} added from the builder${out.replaced ? ' (older version kept in history)' : ''}` });
      return reply.code(201).send(await freshStep(request.params.id));
    } catch (error) { return sendError(reply, request, error); }
  });

  // ---------------------------------------------------------------- v3: how a student's download will look
  // Stamped exactly like a real student download (branch policies: fields, watermark, copyright), with sample details.
  app.get<{ Params: { id: string }; Querystring: { me?: string } }>('/step-files/:id/stamp-preview', staff, async (request, reply) => {
    const actor = await getActor(request);
    try {
      const { rows } = await pool.query(`SELECT id, storage_key, canonical_name, original_filename, role FROM step_files WHERE id = $1`, [request.params.id]);
      const file = rows[0];
      if (!file) return reply.code(404).send({ error: 'File not found.' });
      if (file.role === 'video') return reply.code(400).send({ error: 'Videos are watched on the website, they are not printed.' });
      const bytes = await fetchBytes(file.storage_key);
      if (!bytes) return reply.code(502).send({ error: 'The file could not be loaded from storage. Please try again.' });
      const me = await loadProfile(actor.id);
      const profile = request.query.me === '1' && me ? me : {
        id: 'sample', name: 'Sample Student', email: 'student@example.com', trNumber: '12345', className: 'Darajah 5', branchName: me?.branchName ?? 'Nairobi', branchId: actor.branchId,
      };
      const title = String(file.canonical_name || file.original_filename || 'worksheet').replace(/\.[A-Za-z0-9]{1,5}$/, '');
      const opts = await stampOptionsFor(profile, title);
      // When the stamp library prints a sheet ID (teacher owner), show a sample one too.
      const result = await stampFiles([{ bytes, label: title }], { ...opts, sheetId: 'FQ-SAMPLE' } as typeof opts);
      if (result.skipped.length) return reply.code(415).send({ error: 'This file type cannot be turned into a printable PDF. Use JPG, PNG or PDF.' });
      return reply.type('application/pdf').header('Content-Disposition', contentDisposition(`preview-${title}.pdf`, true)).header('Cache-Control', 'private, no-store').send(Buffer.from(result.bytes));
    } catch (error) { return sendError(reply, request, error); }
  });

  app.get<{ Params: { id: string } }>('/courses/:id/health', staff, async (request, reply) => {
    const actor = await getActor(request);
    if (!(await canRead(actor, request.params.id, reply))) return;
    const detail = await loadCourseDetail(request.params.id);
    if (!detail) return reply.code(404).send({ error: 'Course not found.' });
    const sets = await loadLogicSets();
    return computeHealth(detail, sets.stepTypes, sets.courseTypes, sets.fileCodes);
  });

  app.get<{ Querystring: { entityType?: string; entityId?: string; courseId?: string; limit?: string } }>('/audit', staff, async request => {
    const actor = await getActor(request);
    const q = request.query;
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.courseId) {
      params.push(q.courseId);
      const n = params.length;
      where.push(`((a.entity_type = 'course' AND a.entity_id = $${n})
        OR (a.entity_type = 'level' AND a.entity_id IN (SELECT id FROM levels WHERE course_id = $${n}))
        OR (a.entity_type = 'step' AND a.entity_id IN (SELECT id FROM level_steps WHERE course_id = $${n}))
        OR (a.entity_type = 'step_file' AND a.entity_id IN (SELECT id FROM step_files WHERE course_id = $${n})))`);
    }
    if (q.entityType) { params.push(q.entityType); where.push(`a.entity_type = $${params.length}`); }
    if (q.entityId) { params.push(q.entityId); where.push(`a.entity_id = $${params.length}`); }
    if (!actor.isMaster) { params.push(actor.branchId); where.push(`(a.branch_id IS NULL OR a.branch_id = $${params.length})`); }
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 100));
    const { rows } = await pool.query(
      `SELECT a.id, a.actor_id, a.action, a.entity_type, a.entity_id, a.summary, a.before_json, a.created_at, a.undone_at, u.name AS actor_name
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY a.created_at DESC LIMIT ${limit}`,
      params,
    );
    const entries: AuditEntry[] = rows.map(r => {
      const before = parseJson<Record<string, unknown> | null>(r.before_json, null);
      return {
        id: r.id,
        actorName: r.actor_name ?? (r.actor_id ? null : 'Automatic'),
        action: r.action,
        entityType: r.entity_type,
        entityId: r.entity_id,
        summary: `${r.summary ?? ''}${r.undone_at ? ' (undone)' : ''}`,
        createdAt: iso(r.created_at) ?? new Date().toISOString(),
        canUndo: actor.isMaster && UNDOABLE.has(r.action) && !r.undone_at && Boolean(before && typeof before === 'object' && Object.keys(before).length),
      };
    });
    return entries;
  });

  app.post<{ Params: { id: string } }>('/audit/:id/undo', master, async (request, reply) => {
    const actor = await getActor(request);
    const { rows } = await pool.query(`SELECT * FROM audit_log WHERE id = $1`, [request.params.id]);
    const entry = rows[0];
    if (!entry) return reply.code(404).send({ error: 'History entry not found.' });
    if (!UNDOABLE.has(entry.action)) return reply.code(400).send({ error: 'Only changes to course, level or step details can be undone.' });
    if (entry.undone_at) return reply.code(409).send({ error: 'This change was already undone.' });
    const before = parseJson<Record<string, unknown> | null>(entry.before_json, null);
    if (!before || typeof before !== 'object' || !Object.keys(before).length) return reply.code(400).send({ error: 'This change has nothing to undo.' });
    const kind = entry.entity_type as EntityKind;
    if (!(kind in ENTITY)) return reply.code(400).send({ error: 'This change cannot be undone.' });
    try {
      const result = await withTx(async client => {
        const { rows: lock } = await client.query(`SELECT undone_at FROM audit_log WHERE id = $1 FOR UPDATE`, [entry.id]);
        if (lock[0]?.undone_at) throw new HttpError(409, 'This change was already undone.');
        const res = await applyPatch(client, kind, entry.entity_id, before);
        await client.query(`UPDATE audit_log SET undone_at = CURRENT_TIMESTAMP(6) WHERE id = $1`, [entry.id]);
        return res;
      });
      await logAudit({ actorId: actor.id, action: `${kind}.update`, entityType: kind, entityId: entry.entity_id, summary: `Undid: ${entry.summary}`, before: result.before, after: result.after });
      if (kind === 'course') return { undone: true, course: await loadCourseDetail(entry.entity_id) };
      if (kind === 'level') return { undone: true, level: await freshLevel(entry.entity_id) };
      return { undone: true, step: await freshStep(entry.entity_id) };
    } catch (error) { return sendError(reply, request, error); }
  });
}
