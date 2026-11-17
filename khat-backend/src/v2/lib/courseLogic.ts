/**
 * Pure course logic (no database): missing files, course health, ingest planning,
 * and the student view (visibility, unlocking, progress). Unit-tested in
 * tests/v2/backend-courses.test.ts.
 */
import type {
  CourseDetail, CourseTypeDef, FileCodeDef, FileRole, HealthIssue, IngestPlanItem, Level, ParsedFileName,
  Step, StepTypeDef, StudentStepState, SubmissionStatus, MarkBand,
} from '../contracts.js';
import { parseFileName, sizeLabel, sizesToText, NAMING_EXAMPLE, SIZE_CODES } from './naming.js';

// ---------------------------------------------------------------- labels
export function roleLabel(role: string): string {
  switch (role) {
    case 'worksheet': return 'worksheet';
    case 'assessment_sheet': return 'assessment sheet';
    case 'resource': return 'resource sheet';
    case 'video': return 'video';
    case 'reference': return 'reference image';
    default: return 'file';
  }
}

export function stepTypeLabel(typeKey: string, stepTypes: Pick<StepTypeDef, 'typeKey' | 'label'>[]): string {
  return stepTypes.find(t => t.typeKey === typeKey)?.label ?? typeKey;
}

/** The file role a step of this type must have for students to download (null = nothing required). */
export function requiredRoleFor(stepType: string, stepTypes: StepTypeDef[], fileCodes: FileCodeDef[]): FileRole | null {
  const def = stepTypes.find(t => t.typeKey === stepType);
  if (def && def.studentAction === 'upload') return null;
  const roles = fileCodes.filter(c => c.stepType === stepType).map(c => c.fileRole);
  const role = roles.find(r => r === 'assessment_sheet') ?? roles.find(r => r === 'worksheet') ?? roles.find(r => r === 'resource');
  if (role) return role;
  if (roles.length) return null; // only reference/video codes map to this type
  return def ? 'worksheet' : null;
}

type FileForMissing = { role: string; sizeCode: string | null; page: string; isCurrent: boolean };

/** Human-readable missing items for one step, e.g. ['worksheet 2 mm', 'worksheet 1 mm page P02']. */
export function stepMissing(
  step: { stepType: string; files: FileForMissing[] },
  mistarSizes: string[],
  stepTypes: StepTypeDef[],
  fileCodes: FileCodeDef[],
): string[] {
  const role = requiredRoleFor(step.stepType, stepTypes, fileCodes);
  if (!role) return [];
  const files = step.files.filter(f => f.isCurrent && f.role === role);
  const label = roleLabel(role);
  const sizes = mistarSizes.filter(s => (SIZE_CODES as readonly string[]).includes(s));
  if (!files.length) return sizes.length ? sizes.map(s => `${label} ${sizeLabel(s)}`) : [label];
  if (!sizes.length) return [];
  const pages = [...new Set(files.map(f => f.page))].sort();
  const out: string[] = [];
  for (const size of sizes) {
    for (const page of pages) {
      const ok = files.some(f => f.page === page && (f.sizeCode === size || f.sizeCode === null));
      if (!ok) out.push(`${label} ${sizeLabel(size)}${pages.length > 1 ? ` page ${page}` : ''}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- health
export function computeHealth(
  course: Pick<CourseDetail, 'code' | 'status' | 'courseType' | 'branchIds' | 'mistarSizes' | 'levels' | 'structureVersion'>,
  stepTypes: StepTypeDef[],
  courseTypes: CourseTypeDef[],
  fileCodes: FileCodeDef[],
): HealthIssue[] {
  const issues: HealthIssue[] = [];
  const published = course.status === 'published';
  const ct = courseTypes.find(t => t.typeKey === course.courseType);
  if (!course.code) issues.push({ severity: 'warning', message: 'This course has no Course Code, so uploaded files cannot find it. Add the code (e.g. FNK-C101).' });
  if (!course.courseType) issues.push({ severity: 'warning', message: 'No course type chosen (Certification, Crash course, Mashq…).' });
  else if (!ct) issues.push({ severity: 'error', message: `Course type "${course.courseType}" has no logic set. Choose a known course type.` });
  if (!course.branchIds.length) issues.push({ severity: 'warning', message: 'No branch chosen — this course will show in every branch.' });
  if (!course.mistarSizes.length) issues.push({ severity: 'warning', message: 'No mistar sizes chosen, so missing worksheets per size cannot be checked.' });

  const levels = course.levels;
  const allSteps = levels.flatMap(l => l.steps);
  if (!levels.length || !allSteps.length) {
    issues.push({ severity: published ? 'error' : 'info', message: 'This course has no steps yet — upload files named like ' + NAMING_EXAMPLE + ' to build it.' });
  }
  const liveSteps = levels.filter(l => l.status === 'published').flatMap(l => l.steps.filter(s => s.status === 'published'));
  if (published && allSteps.length && liveSteps.length === 0) {
    issues.push({ severity: 'error', message: 'The course is published but has no published steps — students will see an empty course.' });
  }
  const isCertification = course.courseType === 'certification';
  for (const level of levels) {
    const lv = `${level.code}${level.description ? ` (${level.description})` : ''}`;
    if (!level.steps.length) issues.push({ severity: 'warning', message: `${lv} has no steps.`, levelId: level.id });
    if (ct?.hasLevels !== false && !level.description) issues.push({ severity: 'info', message: `${level.code} has no Description.`, levelId: level.id });
    const visibleSteps = level.steps.filter(s => s.status === 'published');
    const gating = visibleSteps.filter(s => stepTypes.find(t => t.typeKey === s.stepType)?.gatesProgress);
    if (isCertification && level.status === 'published' && visibleSteps.length && !gating.length) {
      issues.push({ severity: 'warning', message: `${lv} has no assessment step — students will move to the next level without being checked.`, levelId: level.id });
    }
    for (const step of level.steps) {
      const st = `${level.code} ${step.code}${step.title ? ` '${step.title}'` : ''}`;
      const def = stepTypes.find(t => t.typeKey === step.stepType);
      if (!def) {
        issues.push({ severity: 'error', message: `${st} has type "${step.stepType}" which has no logic set — choose a step type.`, levelId: level.id, stepId: step.id });
        continue;
      }
      if (ct && ct.allowedStepTypes.length && !ct.allowedStepTypes.includes(step.stepType)) {
        issues.push({ severity: 'warning', message: `${st} is a ${def.label} step, which is not usual for a ${ct.label} course.`, levelId: level.id, stepId: step.id });
      }
      if (!step.title) issues.push({ severity: 'info', message: `${st} has no Task name.`, levelId: level.id, stepId: step.id });
      const current = step.files.filter(f => f.isCurrent);
      if (step.stepType === 'assessment' && !current.some(f => f.role === 'assessment_sheet')) {
        issues.push({ severity: published ? 'error' : 'warning', message: `${st} is a level assessment but has no assessment sheet (AW/AS file).`, levelId: level.id, stepId: step.id });
      } else {
        const missing = stepMissing(step, course.mistarSizes, stepTypes, fileCodes);
        if (missing.length) {
          const live = published && step.status === 'published' && level.status === 'published';
          issues.push({ severity: live ? 'error' : 'warning', message: `${st} is missing: ${missing.join(', ')}.`, levelId: level.id, stepId: step.id });
        }
      }
      if (def.hasMarks && step.maxMarks !== null && step.maxMarks !== 10) {
        issues.push({ severity: 'info', message: `${st} has Max marks ${step.maxMarks}; marking is out of 10.`, levelId: level.id, stepId: step.id });
      }
      const slots = new Map<string, number>();
      for (const f of current) {
        if (f.role === 'video' || f.role === 'reference') continue;
        const k = `${f.role}|${f.sizeCode ?? ''}|${f.page}`;
        slots.set(k, (slots.get(k) ?? 0) + 1);
      }
      for (const [k, n] of slots) {
        if (n > 1) {
          const [role, size, page] = k.split('|');
          issues.push({ severity: 'warning', message: `${st} has ${n} current files for ${roleLabel(role)} ${size ? sizeLabel(size) : ''} ${page} — keep one and remove the others.`.replace(/\s+/g, ' '), levelId: level.id, stepId: step.id });
        }
      }
    }
  }
  // v3: Mashq / worksheet-only courses must end with ONE upload of all sheets, or students can never finish.
  const worksheetOnly = allSteps.length > 0 && allSteps.every(s => stepTypes.find(t => t.typeKey === s.stepType)?.studentAction === 'watch_download');
  if ((ct?.finalSubmission || worksheetOnly) && allSteps.length && !allSteps.some(s => s.stepType === 'final_submission')) {
    issues.push({ severity: 'error', message: `${ct?.label ?? 'This'} course has only worksheets and no final upload. Add a step of type "Final submission" (e.g. "Send all your sheets for assessment") so students can finish.` });
  }
  return issues;
}

// ---------------------------------------------------------------- ingest planning
export type PlanFile = { id: string | null; role: string; sizeCode: string | null; page: string; version: number; isCurrent: boolean; canonicalName: string | null; driveFileId?: string | null };
export type PlanStep = { id: string | null; code: string; title: string | null; stepType: string; files: PlanFile[] };
export type PlanLevel = { id: string | null; code: string; description: string | null; steps: PlanStep[] };
export type PlanCourse = { id: string; code: string; title: string; structureVersion: number; courseType: string | null; mistarSizes: string[]; levels: PlanLevel[] };
export type PlanContext = { courses: Map<string, PlanCourse>; fileCodes: FileCodeDef[]; stepTypes: StepTypeDef[]; courseTypes?: CourseTypeDef[] };

export type IngestDecision = {
  filename: string;
  ok: boolean;
  action: IngestPlanItem['action'];
  parsed: ParsedFileName | null;
  canonicalName: string | null;
  courseId: string | null;
  levelCode: string | null;
  levelId: string | null;
  createLevel: boolean;
  stepCode: string | null;
  stepId: string | null;
  createStep: boolean;
  stepType: string | null;     // type of the (new or existing) step after this file
  retypeStep: boolean;         // existing step changes type (was a default worksheet holding only videos/references)
  fileRole: FileRole | null;
  makeCurrent: boolean;
  demoteOthers: boolean;       // newer version: older files of the slot become history
  replacesVersion: number | null;
  message: string;             // plan tense
  doneMessage: string;         // past tense, for commit results
  notes: string[];
};

function levelLabel(level: { code: string; description: string | null }): string {
  return level.description ? `${level.code} (${level.description})` : level.code;
}
function stepLabel(step: { code: string; title: string | null }): string {
  return step.title ? `${step.code} '${step.title}'` : step.code;
}
function fileLabel(role: string, sizeCode: string | null, page: string, version: number): string {
  const size = sizeCode ? ` ${sizeLabel(sizeCode)}` : '';
  const pg = role === 'video' || role === 'reference' ? (page !== 'P01' ? `, page ${page}` : '') : `, page ${page}`;
  return `${roleLabel(role)}${size}${pg}, v${version}`;
}

function errorDecision(filename: string, action: 'error' | 'unknown_course', message: string, parsed: ParsedFileName | null = null, courseId: string | null = null): IngestDecision {
  return {
    filename, ok: false, action, parsed, canonicalName: null, courseId,
    levelCode: null, levelId: null, createLevel: false, stepCode: null, stepId: null, createStep: false,
    stepType: null, retypeStep: false, fileRole: null, makeCurrent: false, demoteOthers: false, replacesVersion: null,
    message, doneMessage: message, notes: [],
  };
}

/**
 * Decides what one uploaded file does to the course structure. When `simulate` is true
 * (default) the context is updated in memory so the next file of the same batch sees the
 * level/step/file this one creates.
 */
export function planIngestFile(filename: string, ctx: PlanContext, simulate = true): IngestDecision {
  const knownCodes = ctx.fileCodes.map(c => c.fileCode);
  const res = parseFileName(filename, knownCodes.length ? knownCodes : undefined);
  if (!res.ok) return errorDecision(filename, 'error', res.error);
  const p = res.parsed;
  const course = ctx.courses.get(p.courseCode);
  if (!course) {
    return errorDecision(filename, 'unknown_course', `Course ${p.courseCode} is not in the master list yet — import the master list first.`, p);
  }
  if (Number(course.structureVersion) !== 2) {
    return errorDecision(filename, 'error', `Course ${p.courseCode} is an old-style course. Files by name can only be added to courses imported from the master list.`, p, course.id);
  }
  const fc = ctx.fileCodes.find(c => c.fileCode.toUpperCase() === p.fileCode);
  if (!fc) return errorDecision(filename, 'error', `"${p.fileCode}" is not a known file type code.`, p, course.id);
  const role = fc.fileRole;
  const notes = [...res.notes];
  const typeFromCode = fc.stepType || '';
  if (typeFromCode && !ctx.stepTypes.some(t => t.typeKey === typeFromCode)) {
    notes.push(`File code ${fc.fileCode} points to step type "${typeFromCode}" which has no logic set.`);
  }
  const ct = ctx.courseTypes?.find(t => t.typeKey === course.courseType);
  const levelCodeWanted = p.level ?? 'LV01';
  if (ct && ct.hasLevels === false && p.level && p.level !== 'LV01') {
    notes.push(`${course.code} is a ${ct.label} without levels, but the name says ${p.level}. It was filed under ${p.level} anyway — rename the file if that is wrong.`);
  }
  if (p.sizeCode && course.mistarSizes.length && !course.mistarSizes.includes(p.sizeCode)) {
    notes.push(`Size ${sizeLabel(p.sizeCode)} is not one of this course's mistar sizes (${sizesToText(course.mistarSizes)}).`);
  }
  if (!p.sizeCode && (role === 'worksheet' || role === 'assessment_sheet' || role === 'resource') && course.mistarSizes.length > 1) {
    notes.push('No mistar size in the name — this file will be offered for every size.');
  }

  let level = course.levels.find(l => l.code === levelCodeWanted) ?? null;
  const createLevel = !level;
  let step = level?.steps.find(s => s.code === p.step) ?? null;
  const createStep = !step;
  let stepType = step?.stepType ?? (typeFromCode || 'worksheet');
  let retypeStep = false;
  if (step && typeFromCode && step.stepType !== typeFromCode) {
    const onlyMedia = step.files.every(f => f.role === 'video' || f.role === 'reference');
    if (onlyMedia && step.stepType === 'worksheet') {
      retypeStep = true;
      stepType = typeFromCode;
    } else {
      notes.push(`${p.step} is a ${stepTypeLabel(step.stepType, ctx.stepTypes)} step; this ${fc.label} file was added to it without changing its type.`);
    }
  }
  if (createStep && !typeFromCode) {
    notes.push(`The step type is set to ${stepTypeLabel('worksheet', ctx.stepTypes)} for now — a worksheet or assessment file (or the builder) can change it.`);
  }

  const canonical = res.canonicalName;
  const slot = (step?.files ?? []).filter(f => f.role === role && (f.sizeCode ?? null) === (p.sizeCode ?? null) && f.page === p.page);
  const sameVersion = slot.filter(f => f.version === p.version);
  const maxVersion = slot.reduce((m, f) => Math.max(m, f.version), 0);
  const currentVersion = slot.filter(f => f.isCurrent).reduce((m, f) => Math.max(m, f.version), 0);
  const fLabel = fileLabel(role, p.sizeCode, p.page, p.version);
  const where = `${level ? levelLabel(level) : levelCodeWanted} ${step ? stepLabel(step) : p.step}`;

  const base: IngestDecision = {
    filename, ok: true, action: 'add_file', parsed: p, canonicalName: canonical, courseId: course.id,
    levelCode: levelCodeWanted, levelId: level?.id ?? null, createLevel,
    stepCode: p.step, stepId: step?.id ?? null, createStep, stepType, retypeStep,
    fileRole: role, makeCurrent: true, demoteOthers: false, replacesVersion: null,
    message: '', doneMessage: '', notes,
  };

  if (sameVersion.some(f => (f.canonicalName ?? '').toLowerCase() === canonical.toLowerCase() || !f.canonicalName)) {
    const existing = sameVersion[0];
    const msg = `Already uploaded — ${canonical} is in ${where}${existing.isCurrent ? '' : ' (in history)'}. Nothing to do.`;
    return { ...base, action: 'same_file', makeCurrent: false, message: msg, doneMessage: msg };
  }

  let plan: string;
  let done: string;
  if (createLevel) {
    base.action = 'new_level';
    plan = `New level ${levelCodeWanted} will be created in ${course.code}, with step ${p.step} (${stepTypeLabel(stepType, ctx.stepTypes)}); this file is its ${fLabel}.`;
    done = `Created level ${levelCodeWanted} in ${course.code} with step ${p.step} (${stepTypeLabel(stepType, ctx.stepTypes)}) and added the ${fLabel}.`;
  } else if (createStep) {
    base.action = 'new_step';
    plan = `New step ${p.step} will be created in ${levelLabel(level!)} (${stepTypeLabel(stepType, ctx.stepTypes)}); this file is its ${fLabel}.`;
    done = `Created step ${p.step} in ${levelLabel(level!)} (${stepTypeLabel(stepType, ctx.stepTypes)}) and added the ${fLabel}.`;
  } else if (p.version > maxVersion && maxVersion > 0) {
    base.action = 'new_version';
    base.demoteOthers = true;
    base.replacesVersion = currentVersion || maxVersion;
    plan = `Newer version v${p.version} replaces v${currentVersion || maxVersion} of the ${roleLabel(role)}${p.sizeCode ? ` ${sizeLabel(p.sizeCode)}` : ''} (${p.page}) in ${where}. The old file is kept in history.`;
    done = `Version v${p.version} is now in use for the ${roleLabel(role)}${p.sizeCode ? ` ${sizeLabel(p.sizeCode)}` : ''} (${p.page}) in ${where}; v${currentVersion || maxVersion} was kept in history.`;
  } else if (maxVersion > 0 && p.version < maxVersion) {
    base.makeCurrent = false;
    plan = `Older version v${p.version} will be saved in history only — v${maxVersion} stays in use in ${where}.`;
    done = `Saved older version v${p.version} in history — v${maxVersion} stays in use in ${where}.`;
  } else {
    plan = `Adds the ${fLabel} to ${where}.`;
    done = `Added the ${fLabel} to ${where}.`;
  }
  if (retypeStep) {
    const t = stepTypeLabel(stepType, ctx.stepTypes);
    plan += ` Step ${p.step} becomes a ${t} step.`;
    done += ` Step ${p.step} is now a ${t} step.`;
  }
  const decision: IngestDecision = { ...base, message: plan, doneMessage: done };

  if (simulate) {
    if (!level) {
      level = { id: null, code: levelCodeWanted, description: null, steps: [] };
      course.levels.push(level);
      course.levels.sort((a, b) => a.code.localeCompare(b.code));
    }
    if (!step) {
      step = { id: null, code: p.step, title: null, stepType, files: [] };
      level.steps.push(step);
      level.steps.sort((a, b) => a.code.localeCompare(b.code));
    } else if (retypeStep) {
      step.stepType = stepType;
    }
    if (decision.demoteOthers) for (const f of slot) f.isCurrent = false;
    step.files.push({ id: null, role, sizeCode: p.sizeCode, page: p.page, version: p.version, isCurrent: decision.makeCurrent, canonicalName: canonical });
  }
  return decision;
}

export function planIngest(filenames: string[], ctx: PlanContext): IngestDecision[] {
  return filenames.map(f => planIngestFile(f, ctx, true));
}

export function decisionToPlanItem(d: IngestDecision): IngestPlanItem {
  const message = d.notes.length ? `${d.message} ${d.notes.join(' ')}` : d.message;
  return {
    filename: d.filename,
    ok: d.ok,
    parsed: d.parsed,
    stepType: d.stepType,
    fileRole: d.fileRole,
    action: d.action,
    courseId: d.courseId,
    message,
  };
}

/** Where to insert a new code into an ordered list of codes, keeping manual order: before the first bigger code. */
export function insertPosition(existingCodesInOrder: (string | null)[], newCode: string): number {
  const idx = existingCodesInOrder.findIndex(c => c !== null && c.localeCompare(newCode) > 0);
  return idx < 0 ? existingCodesInOrder.length : idx;
}

/** Next free code: ['LV01','LV02'] → 'LV03'. */
export function nextCode(prefix: 'LV' | 'S', existing: (string | null)[]): string {
  let max = 0;
  for (const c of existing) {
    const m = c?.match(new RegExp(`^${prefix}(\\d+)$`));
    if (m) max = Math.max(max, Number(m[1]));
  }
  const n = max + 1;
  return `${prefix}${n < 10 ? '0' : ''}${n}`;
}

// ---------------------------------------------------------------- student view
export type SubmissionLite = { stepId: string; attemptNo: number; status: SubmissionStatus; mark: number | null; band: MarkBand | null; createdAt: string | Date };

/** A step a student can use: published, and (for download steps) has a current downloadable file. */
export function isStepVisibleToStudent(step: Pick<Step, 'status' | 'stepType' | 'files'>, stepTypes: StepTypeDef[]): boolean {
  if (step.status !== 'published') return false;
  const def = stepTypes.find(t => t.typeKey === step.stepType);
  if (!def) return false;
  if (def.studentAction === 'upload' || def.studentAction === 'download_upload') return true;
  return step.files.some(f => f.isCurrent && f.role !== 'video' && f.role !== 'reference');
}

/**
 * Size preference: when the student has a size, keep files of that size (plus size-less files).
 * If a role has nothing in their size, keep every size for that role so the student is never stuck.
 */
export function filterFilesForSize<T extends { role: string; sizeCode: string | null; isCurrent: boolean }>(files: T[], mySize: string | null, chooseOneSize: boolean): T[] {
  const current = files.filter(f => f.isCurrent);
  if (!mySize || !chooseOneSize) return current;
  const roles = [...new Set(current.map(f => f.role))];
  const out: T[] = [];
  for (const role of roles) {
    const ofRole = current.filter(f => f.role === role);
    const mine = ofRole.filter(f => f.sizeCode === mySize || f.sizeCode === null);
    const hasSized = ofRole.some(f => f.sizeCode !== null);
    out.push(...(hasSized && mine.some(f => f.sizeCode === mySize) ? mine : ofRole));
  }
  return out;
}

export function studentLevels(levels: Level[], stepTypes: StepTypeDef[], mySize: string | null, chooseOneSize: boolean): Level[] {
  return levels
    .filter(l => l.status === 'published')
    .map(l => ({
      ...l,
      steps: l.steps
        .filter(s => isStepVisibleToStudent(s, stepTypes))
        .map(s => ({ ...s, files: filterFilesForSize(s.files, mySize, chooseOneSize), missing: [] })),
    }))
    .filter(l => l.steps.length > 0);
}

/** A mark on work that is still open (submitted / in review) can only be the provisional automatic mark. */
export function isProvisionalMark(s: { status: SubmissionStatus | string; mark: number | null } | null | undefined): boolean {
  return Boolean(s && s.mark !== null && s.mark !== undefined && (s.status === 'submitted' || s.status === 'in_review'));
}

export function buildStepStates(
  steps: Pick<Step, 'id' | 'stepType'>[],
  stepTypes: StepTypeDef[],
  doneStepIds: Set<string>,
  submissions: SubmissionLite[],
  unreadByStep: Map<string, number>,
): Record<string, StudentStepState> {
  const out: Record<string, StudentStepState> = {};
  for (const step of steps) {
    const def = stepTypes.find(t => t.typeKey === step.stepType);
    const subs = submissions.filter(s => s.stepId === step.id)
      .sort((a, b) => a.attemptNo - b.attemptNo || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const latest = subs[subs.length - 1] ?? null;
    const isUpload = def ? def.studentAction !== 'watch_download' : false;
    const passedOrReviewed = subs.some(s => s.status === 'passed' || s.status === 'reviewed');
    out[step.id] = {
      stepId: step.id,
      done: isUpload ? passedOrReviewed : doneStepIds.has(step.id),
      submissionStatus: latest?.status ?? null,
      mark: latest?.mark ?? null,
      band: latest?.band ?? null,
      attemptsUsed: subs.length,
      unreadMessages: unreadByStep.get(step.id) ?? 0,
      // v3: the automatic 96-hour mark is provisional — a mark on work that is still open.
      // Students see "Marked 7/10 · your teacher will confirm" and the step keeps waiting.
      provisional: isProvisionalMark(latest),
    } as StudentStepState & { provisional: boolean };
  }
  return out;
}

/** Level 1 is open; level n+1 opens when every gating step of level n is passed (or level n has none). */
export function computeUnlockedLevelIds(
  levels: { id: string; steps: { id: string; stepType: string }[] }[],
  stepTypes: StepTypeDef[],
  passedStepIds: Set<string>,
): string[] {
  const out: string[] = [];
  for (let i = 0; i < levels.length; i++) {
    if (i === 0) { out.push(levels[i].id); continue; }
    const prev = levels[i - 1];
    if (!out.includes(prev.id)) break;
    const gating = prev.steps.filter(s => stepTypes.find(t => t.typeKey === s.stepType)?.gatesProgress);
    if (gating.every(s => passedStepIds.has(s.id))) out.push(levels[i].id);
    else break;
  }
  return out;
}

export function computeProgressPercent(stepIds: string[], states: Record<string, StudentStepState>): number {
  if (!stepIds.length) return 0;
  const done = stepIds.filter(id => states[id]?.done).length;
  return Math.round((done / stepIds.length) * 100);
}

export function passedStepIdsFrom(submissions: SubmissionLite[]): Set<string> {
  return new Set(submissions.filter(s => s.status === 'passed').map(s => s.stepId));
}

/** Student's size: their saved size if the course offers it, else the only size of the course, else null. */
export function chooseMySize(saved: string | null, courseSizes: string[]): string | null {
  if (saved && (courseSizes.length === 0 || courseSizes.includes(saved))) return saved;
  if (courseSizes.length === 1) return courseSizes[0];
  return null;
}

/** May a student see this course at all? (course_branches empty = all branches) */
export function studentCanSeeCourse(
  course: { status: string; branchIds: string[]; structureVersion: number },
  studentBranchId: string,
  enrolled: boolean,
): boolean {
  if (course.branchIds.length && !course.branchIds.includes(studentBranchId)) return false;
  if (course.status === 'published') return true;
  if (course.status === 'held') return enrolled;
  return false;
}
