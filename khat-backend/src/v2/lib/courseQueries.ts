/**
 * Database helpers for v2 courses (backend-courses). SQL is parameterised only;
 * JSON columns are parsed defensively (they may arrive as strings).
 */
import { randomUUID } from 'node:crypto';
import { pool } from '../../db.js';
import { matchKhatType, slugify } from './csv.js';
import type {
  CourseDetail, CourseStatus, CourseSummary, CourseTypeDef, FileCodeDef, FileRole, ItemStatus, Level, Step,
  StepFile, StepTypeDef,
} from '../contracts.js';
import type { Actor } from './access.js';
import { requiredRoleFor, stepMissing, type PlanContext, type PlanCourse } from './courseLogic.js';

export type Db = { query: (sql: string, params?: readonly unknown[]) => Promise<{ rows: any[]; rowCount: number }> };
export type TxClient = Awaited<ReturnType<typeof pool.connect>>;

/** Runs `fn` inside BEGIN/COMMIT on one connection; rolls back on error. */
export async function withTx<T>(fn: (client: TxClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* connection may be gone */ }
    throw error;
  } finally {
    client.release();
  }
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    if (!value.trim()) return fallback;
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  if (Buffer.isBuffer(value)) return parseJson(value.toString('utf8'), fallback);
  return value as T;
}

export function toStringArray(value: unknown): string[] {
  const v = parseJson<unknown>(value, []);
  return Array.isArray(v) ? v.filter(x => typeof x === 'string' || typeof x === 'number').map(String) : [];
}

export function iso(value: unknown): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(value)) ? '' : 'Z'));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** '$3, $4, $5' for an IN (...) list starting at parameter number `start`. */
export function inList(count: number, start = 1): string {
  return Array.from({ length: count }, (_, i) => `$${start + i}`).join(', ');
}

const COURSE_STATUSES: CourseStatus[] = ['draft', 'published', 'held', 'hidden'];
export function asCourseStatus(v: unknown): CourseStatus {
  return COURSE_STATUSES.includes(v as CourseStatus) ? (v as CourseStatus) : 'published';
}
export function asItemStatus(v: unknown): ItemStatus {
  return v === 'hidden' ? 'hidden' : 'published';
}

// ---------------------------------------------------------------- logic sets
export function mapStepType(r: any): StepTypeDef {
  return {
    typeKey: r.type_key,
    label: r.label,
    fileCodes: toStringArray(r.file_codes),
    studentAction: r.student_action,
    feedbackMode: r.feedback_mode,
    hasMarks: Boolean(r.has_marks),
    gatesProgress: Boolean(r.gates_progress),
    awardsBadge: Boolean(r.awards_badge),
    requiresPriorUploads: Boolean(r.requires_prior_uploads),
    defaultInstructions: r.default_instructions ?? '',
    sortOrder: Number(r.sort_order ?? 0),
    isSystem: Boolean(r.is_system),
  };
}
export function mapCourseType(r: any): CourseTypeDef {
  return {
    typeKey: r.type_key,
    label: r.label,
    allowedStepTypes: toStringArray(r.allowed_step_types),
    hasLevels: Boolean(r.has_levels),
    finalSubmission: Boolean(r.final_submission),
    sortOrder: Number(r.sort_order ?? 0),
  };
}
export function mapFileCode(r: any): FileCodeDef {
  return { fileCode: r.file_code, stepType: r.step_type ?? '', fileRole: r.file_role as FileRole, label: r.label };
}

export async function loadStepTypes(db: Db = pool): Promise<StepTypeDef[]> {
  const { rows } = await db.query(`SELECT * FROM step_types ORDER BY sort_order, type_key`);
  return rows.map(mapStepType);
}
export async function loadCourseTypes(db: Db = pool): Promise<CourseTypeDef[]> {
  const { rows } = await db.query(`SELECT * FROM course_types ORDER BY sort_order, type_key`);
  return rows.map(mapCourseType);
}
export async function loadFileCodes(db: Db = pool): Promise<FileCodeDef[]> {
  const { rows } = await db.query(`SELECT * FROM file_codes ORDER BY file_code`);
  return rows.map(mapFileCode);
}
export async function loadLogicSets(db: Db = pool) {
  const [stepTypes, courseTypes, fileCodes] = await Promise.all([loadStepTypes(db), loadCourseTypes(db), loadFileCodes(db)]);
  return { stepTypes, courseTypes, fileCodes };
}

// ---------------------------------------------------------------- course tree
const COURSE_COLUMNS = `c.id, c.code, c.title, c.title_ar, c.pen_type, c.course_type, c.khat_type_id, c.status,
  c.structure_version, c.mistar_sizes, c.description, c.instructions, c.drive_folder_url, c.master_row,
  c.updated_at, c.created_at`;

function mapFile(r: any): StepFile {
  return {
    id: r.id,
    role: r.role as FileRole,
    sizeCode: r.size_code ?? null,
    page: r.page ?? 'P01',
    version: Number(r.version ?? 1),
    isCurrent: Boolean(r.is_current),
    storageKey: r.storage_key,
    originalFilename: r.original_filename ?? '',
    canonicalName: r.canonical_name ?? '',
    contentType: r.content_type ?? null,
    byteSize: r.byte_size === null || r.byte_size === undefined ? null : Number(r.byte_size),
    source: (['upload', 'zip', 'drive', 'webhook'].includes(r.source) ? r.source : 'upload') as StepFile['source'],
    uploadedAt: iso(r.uploaded_at) ?? new Date(0).toISOString(),
    uploadedByName: r.uploaded_by_name ?? null,
  };
}

function mapStep(r: any, files: StepFile[]): Step {
  return {
    id: r.id,
    levelId: r.level_id,
    code: r.code,
    orderIndex: Number(r.order_index ?? 0),
    title: r.title ?? '',
    stepType: r.step_type,
    template: r.template ?? null,
    message: r.message ?? null,
    videoUrl: r.video_url ?? null,
    maxMarks: r.max_marks === null || r.max_marks === undefined ? null : Number(r.max_marks),
    badgeCode: r.badge_code ?? null,
    status: asItemStatus(r.status),
    source: (['file', 'manifest', 'manual'].includes(r.source) ? r.source : 'manual') as Step['source'],
    files,
    missing: [],
  };
}

function mapLevel(r: any, steps: Step[]): Level {
  const order = Number(r.order_index ?? 0);
  return {
    id: r.id,
    courseId: r.course_id,
    code: r.code ?? `LV${order + 1 < 10 ? '0' : ''}${order + 1}`,
    orderIndex: order,
    description: r.description ?? (r.code ? null : r.title ?? null),
    instructions: r.instructions ?? null,
    badgeCode: r.badge_code ?? null,
    status: asItemStatus(r.status),
    steps,
    // v3 builder: chosen badge design (extra field, see khat-backend/src/v2/lib/builderTypes.ts)
    ...({ badgeDesignId: r.badge_design_id ?? null } as Record<string, unknown>),
  };
}

function mapSummary(r: any, branchIds: string[]): CourseSummary {
  return {
    id: r.id,
    code: r.code ?? null,
    title: r.title ?? '',
    titleAr: r.title_ar ?? null,
    penType: r.pen_type ?? null,
    courseType: r.course_type ?? null,
    khatTypeId: r.khat_type_id,
    status: asCourseStatus(r.status),
    structureVersion: Number(r.structure_version) === 2 ? 2 : 1,
    branchIds,
    mistarSizes: toStringArray(r.mistar_sizes),
    counts: { levels: 0, steps: 0, files: 0, missing: 0, students: 0 },
    updatedAt: iso(r.updated_at) ?? iso(r.created_at),
  };
}

async function loadBranchIds(courseIds: string[], db: Db): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!courseIds.length) return out;
  const { rows } = await db.query(`SELECT course_id, branch_id FROM course_branches WHERE course_id IN (${inList(courseIds.length)})`, courseIds);
  for (const r of rows) (out.get(r.course_id) ?? out.set(r.course_id, []).get(r.course_id)!).push(r.branch_id);
  return out;
}

async function loadStudentCounts(courseIds: string[], db: Db): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!courseIds.length) return out;
  const { rows } = await db.query(
    `SELECT course_id, COUNT(*) AS n FROM enrollments WHERE course_id IN (${inList(courseIds.length)}) GROUP BY course_id`,
    courseIds,
  );
  for (const r of rows) out.set(r.course_id, Number(r.n));
  return out;
}

/** Builds full trees (levels → steps → files) for several courses in 3 queries. */
async function loadTrees(courseIds: string[], opts: { history?: boolean }, db: Db): Promise<Map<string, Level[]>> {
  const out = new Map<string, Level[]>();
  if (!courseIds.length) return out;
  const ph = inList(courseIds.length);
  const [levelsRes, stepsRes, filesRes] = await Promise.all([
    db.query(`SELECT *
              FROM levels WHERE course_id IN (${ph}) ORDER BY course_id, order_index`, courseIds),
    db.query(`SELECT *
              FROM level_steps WHERE course_id IN (${ph}) ORDER BY level_id, order_index, code`, courseIds),
    db.query(`SELECT f.id, f.step_id, f.course_id, f.role, f.size_code, f.page, f.version, f.is_current, f.storage_key,
                     f.original_filename, f.canonical_name, f.content_type, f.byte_size, f.source, f.uploaded_at,
                     u.name AS uploaded_by_name
              FROM step_files f LEFT JOIN users u ON u.id = f.uploaded_by
              WHERE f.course_id IN (${ph}) ${opts.history ? '' : 'AND f.is_current = 1'}
              ORDER BY f.role, f.size_code, f.page, f.version DESC`, courseIds),
  ]);
  const filesByStep = new Map<string, StepFile[]>();
  for (const r of filesRes.rows) (filesByStep.get(r.step_id) ?? filesByStep.set(r.step_id, []).get(r.step_id)!).push(mapFile(r));
  const stepsByLevel = new Map<string, Step[]>();
  for (const r of stepsRes.rows) {
    (stepsByLevel.get(r.level_id) ?? stepsByLevel.set(r.level_id, []).get(r.level_id)!).push(mapStep(r, filesByStep.get(r.id) ?? []));
  }
  for (const r of levelsRes.rows) {
    (out.get(r.course_id) ?? out.set(r.course_id, []).get(r.course_id)!).push(mapLevel(r, stepsByLevel.get(r.id) ?? []));
  }
  return out;
}

function fillMissing(levels: Level[], sizes: string[], stepTypes: StepTypeDef[], fileCodes: FileCodeDef[]): number {
  let total = 0;
  for (const l of levels) for (const s of l.steps) {
    s.missing = stepMissing(s, sizes, stepTypes, fileCodes);
    if (l.status === 'published' && s.status === 'published') total += s.missing.length;
  }
  return total;
}

export type CourseListFilter = { status?: string; courseType?: string; penType?: string; branchId?: string; q?: string; structureVersion?: number; ids?: string[] };

export async function loadCourseSummaries(filter: CourseListFilter, db: Db = pool): Promise<CourseSummary[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, ...values: unknown[]) => {
    let s = sql;
    for (const v of values) { params.push(v); s = s.replace('?', `$${params.length}`); }
    where.push(s);
  };
  if (filter.status) add('c.status = ?', filter.status);
  if (filter.courseType) add('c.course_type = ?', filter.courseType);
  if (filter.penType) add('c.pen_type = ?', filter.penType);
  if (filter.structureVersion) add('c.structure_version = ?', filter.structureVersion);
  if (filter.branchId) {
    add('(NOT EXISTS (SELECT 1 FROM course_branches cb WHERE cb.course_id = c.id) OR EXISTS (SELECT 1 FROM course_branches cb2 WHERE cb2.course_id = c.id AND cb2.branch_id = ?))', filter.branchId);
  }
  if (filter.q) {
    const like = `%${filter.q.trim().replace(/[\\%_]/g, m => `\\${m}`)}%`;
    add('(c.title LIKE ? OR c.code LIKE ? OR c.title_ar LIKE ?)', like, like, like);
  }
  if (filter.ids) {
    if (!filter.ids.length) return [];
    const start = params.length + 1;
    params.push(...filter.ids);
    where.push(`c.id IN (${inList(filter.ids.length, start)})`);
  }
  const { rows } = await db.query(
    `SELECT ${COURSE_COLUMNS} FROM courses c ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY c.structure_version DESC, c.code IS NULL, c.code, c.created_at`,
    params,
  );
  const ids = rows.map(r => r.id as string);
  const [branches, students, trees, sets] = await Promise.all([
    loadBranchIds(ids, db), loadStudentCounts(ids, db), loadTrees(ids, {}, db), loadLogicSets(db),
  ]);
  return rows.map(r => {
    const s = mapSummary(r, branches.get(r.id) ?? []);
    const levels = trees.get(r.id) ?? [];
    const missing = fillMissing(levels, s.mistarSizes, sets.stepTypes, sets.fileCodes);
    s.counts = {
      levels: levels.length,
      steps: levels.reduce((n, l) => n + l.steps.length, 0),
      files: levels.reduce((n, l) => n + l.steps.reduce((m, st) => m + st.files.length, 0), 0),
      missing,
      students: students.get(r.id) ?? 0,
    };
    return s;
  });
}

export async function loadCourseDetail(courseId: string, opts: { history?: boolean } = {}, db: Db = pool): Promise<CourseDetail | null> {
  const { rows } = await db.query(`SELECT c.* FROM courses c WHERE c.id = $1`, [courseId]);
  const r = rows[0];
  if (!r) return null;
  const [branches, students, trees, sets] = await Promise.all([
    loadBranchIds([courseId], db), loadStudentCounts([courseId], db), loadTrees([courseId], opts, db), loadLogicSets(db),
  ]);
  const summary = mapSummary(r, branches.get(courseId) ?? []);
  const levels = trees.get(courseId) ?? [];
  // Missing is about current files only, even when history is included.
  for (const l of levels) for (const s of l.steps) s.missing = stepMissing({ stepType: s.stepType, files: s.files.filter(f => f.isCurrent) }, summary.mistarSizes, sets.stepTypes, sets.fileCodes);
  const missing = levels.filter(l => l.status === 'published').reduce((n, l) => n + l.steps.filter(s => s.status === 'published').reduce((m, s) => m + s.missing.length, 0), 0);
  summary.counts = {
    levels: levels.length,
    steps: levels.reduce((n, l) => n + l.steps.length, 0),
    files: levels.reduce((n, l) => n + l.steps.reduce((m, s) => m + s.files.filter(f => f.isCurrent).length, 0), 0),
    missing,
    students: students.get(courseId) ?? 0,
  };
  const masterRow = parseJson<Record<string, string> | null>(r.master_row, null);
  return {
    ...summary,
    description: r.description ?? null,
    instructions: r.instructions ?? null,
    driveFolderUrl: r.drive_folder_url ?? null,
    masterRow: masterRow && typeof masterRow === 'object' && !Array.isArray(masterRow) ? masterRow : null,
    levels,
    // v3 builder: design used for the course-completion badge (extra field)
    ...({ badgeDesignId: r.badge_design_id ?? null, certificationReady: Boolean(Number(r.certification_ready ?? 0)) } as Record<string, unknown>),
  };
}

/** Finds a single step / level inside a loaded course. */
export function findStep(course: CourseDetail, stepId: string): { level: Level; step: Step } | null {
  for (const level of course.levels) {
    const step = level.steps.find(s => s.id === stepId);
    if (step) return { level, step };
  }
  return null;
}

// ---------------------------------------------------------------- access helpers
export async function courseBranchIds(courseId: string, db: Db = pool): Promise<string[]> {
  return (await loadBranchIds([courseId], db)).get(courseId) ?? [];
}

/** Staff may read a course when master, or when the course is for all branches / includes their branch. */
export async function staffCanReadCourse(actor: Actor, courseId: string, db: Db = pool): Promise<boolean> {
  if (!actor.isStaff) return false;
  if (actor.isMaster) return true;
  const ids = await courseBranchIds(courseId, db);
  return ids.length === 0 || ids.includes(actor.branchId);
}

export async function courseIdForLevel(levelId: string, db: Db = pool): Promise<string | null> {
  const { rows } = await db.query(`SELECT course_id FROM levels WHERE id = $1`, [levelId]);
  return rows[0]?.course_id ?? null;
}
export async function courseIdForStep(stepId: string, db: Db = pool): Promise<string | null> {
  const { rows } = await db.query(`SELECT course_id FROM level_steps WHERE id = $1`, [stepId]);
  return rows[0]?.course_id ?? null;
}

/** Any student work on these steps (submissions, done marks, thread messages)? */
export async function stepsHaveActivity(stepIds: string[], db: Db = pool): Promise<boolean> {
  if (!stepIds.length) return false;
  const ph = inList(stepIds.length);
  const { rows } = await db.query(
    `SELECT
       (SELECT COUNT(*) FROM step_submissions WHERE step_id IN (${ph})) AS subs,
       (SELECT COUNT(*) FROM step_progress WHERE step_id IN (${ph})) AS done,
       (SELECT COUNT(*) FROM thread_messages WHERE step_id IN (${ph})) AS msgs`,
    stepIds,
  );
  const r = rows[0] ?? {};
  return Number(r.subs) + Number(r.done) + Number(r.msgs) > 0;
}

export async function levelHasActivity(levelId: string, db: Db = pool): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT
       (SELECT COUNT(*) FROM step_submissions WHERE level_id = $1) AS subs,
       (SELECT COUNT(*) FROM entries WHERE level_id = $1) AS entries,
       (SELECT COUNT(*) FROM level_submissions WHERE level_id = $1) AS legacy,
       (SELECT COUNT(*) FROM certificate_templates WHERE level_id = $1) AS templates,
       (SELECT COUNT(*) FROM certificates WHERE level_id = $1) AS certs`,
    [levelId],
  );
  const r = rows[0] ?? {};
  if (Number(r.subs) + Number(r.entries) + Number(r.legacy) + Number(r.templates) + Number(r.certs) > 0) return true;
  const { rows: steps } = await db.query(`SELECT id FROM level_steps WHERE level_id = $1`, [levelId]);
  return stepsHaveActivity(steps.map(s => s.id), db);
}

// ---------------------------------------------------------------- ordering
/** Rewrites levels.order_index to 0..n-1 in the given order (two passes: the (course_id, order_index) key is unique). */
export async function resequenceLevels(client: Db, courseId: string, orderedIds: string[]): Promise<void> {
  if (!orderedIds.length) return;
  const { rows } = await client.query(`SELECT COALESCE(MAX(order_index), 0) AS m FROM levels WHERE course_id = $1`, [courseId]);
  const offset = Number(rows[0]?.m ?? 0) + orderedIds.length + 1;
  await client.query(`UPDATE levels SET order_index = order_index + $2 WHERE course_id = $1`, [courseId, offset]);
  for (let i = 0; i < orderedIds.length; i++) {
    await client.query(`UPDATE levels SET order_index = $1 WHERE id = $2 AND course_id = $3`, [i, orderedIds[i], courseId]);
  }
}

export async function resequenceSteps(client: Db, levelId: string, orderedIds: string[]): Promise<void> {
  for (let i = 0; i < orderedIds.length; i++) {
    await client.query(`UPDATE level_steps SET order_index = $1 WHERE id = $2 AND level_id = $3`, [i, orderedIds[i], levelId]);
  }
}

// ---------------------------------------------------------------- ingest context
/** Loads the plan context (courses by code with every file version) for the given course codes. */
export async function loadPlanContext(codes: string[], db: Db = pool, lockCourseCode?: string): Promise<PlanContext> {
  const sets = await loadLogicSets(db);
  const ctx: PlanContext = { courses: new Map(), fileCodes: sets.fileCodes, stepTypes: sets.stepTypes, courseTypes: sets.courseTypes };
  const unique = [...new Set(codes.filter(Boolean))];
  if (!unique.length) return ctx;
  const { rows } = await db.query(
    `SELECT id, code, title, structure_version, course_type, mistar_sizes FROM courses WHERE code IN (${inList(unique.length)})${lockCourseCode ? ' FOR UPDATE' : ''}`,
    unique,
  );
  if (!rows.length) return ctx;
  const ids = rows.map(r => r.id as string);
  const ph = inList(ids.length);
  const [levels, steps, files] = await Promise.all([
    db.query(`SELECT id, course_id, code, order_index, description, title FROM levels WHERE course_id IN (${ph}) ORDER BY order_index`, ids),
    db.query(`SELECT id, level_id, code, title, step_type FROM level_steps WHERE course_id IN (${ph}) ORDER BY order_index, code`, ids),
    db.query(`SELECT id, step_id, role, size_code, page, version, is_current, canonical_name, drive_file_id FROM step_files WHERE course_id IN (${ph})`, ids),
  ]);
  const byCourse = new Map<string, PlanCourse>();
  for (const r of rows) {
    const c: PlanCourse = {
      id: r.id, code: String(r.code).toUpperCase(), title: r.title, structureVersion: Number(r.structure_version),
      courseType: r.course_type ?? null, mistarSizes: toStringArray(r.mistar_sizes), levels: [],
    };
    byCourse.set(r.id, c);
    ctx.courses.set(c.code, c);
  }
  const levelById = new Map<string, PlanCourse['levels'][number]>();
  for (const l of levels.rows) {
    const order = Number(l.order_index ?? 0);
    const lv = { id: l.id, code: l.code ?? `LV${order + 1 < 10 ? '0' : ''}${order + 1}`, description: l.description ?? null, steps: [] as PlanCourse['levels'][number]['steps'] };
    levelById.set(l.id, lv);
    byCourse.get(l.course_id)?.levels.push(lv);
  }
  const stepById = new Map<string, PlanCourse['levels'][number]['steps'][number]>();
  for (const s of steps.rows) {
    const st = { id: s.id, code: s.code, title: s.title ?? null, stepType: s.step_type, files: [] as PlanCourse['levels'][number]['steps'][number]['files'] };
    stepById.set(s.id, st);
    levelById.get(s.level_id)?.steps.push(st);
  }
  for (const f of files.rows) {
    stepById.get(f.step_id)?.files.push({
      id: f.id, role: f.role, sizeCode: f.size_code ?? null, page: f.page ?? 'P01', version: Number(f.version ?? 1),
      isCurrent: Boolean(f.is_current), canonicalName: f.canonical_name ?? null, driveFileId: f.drive_file_id ?? null,
    });
  }
  return ctx;
}

export { requiredRoleFor };

/** Existing khat_types row that best fits the course name + pen; creates one when nothing fits. */
export async function resolveKhatTypeId(client: Db, title: string, penType: string | null | undefined): Promise<string> {
  const { rows } = await client.query(`SELECT id, code, display_name FROM khat_types`);
  const khatTypes = rows.map(r => ({ id: r.id as string, code: r.code as string, displayName: r.display_name as string }));
  const hit = matchKhatType(title, penType, khatTypes);
  if (hit) return hit;
  const code = slugify(`${title}${penType === 'normal' ? ' normal pen' : ''}`);
  await client.query(`INSERT IGNORE INTO khat_types (id, code, display_name) VALUES ($1, $2, $3)`, [randomUUID(), code, title]);
  const { rows: again } = await client.query(`SELECT id FROM khat_types WHERE code = $1`, [code]);
  return again[0].id;
}
