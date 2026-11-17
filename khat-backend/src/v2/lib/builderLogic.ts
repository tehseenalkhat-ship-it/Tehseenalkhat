/**
 * v3 builder — pure helpers (no database): YouTube links, attaching single files
 * to a step from the builder, allowed step types, badge design choice and badge
 * wording. Unit-tested in tests/v2/v3-builder.test.ts.
 */
import type { CourseTypeDef, StepTypeDef } from '../contracts.js';
import { SIZE_CODES } from './naming.js';

// ---------------------------------------------------------------- video links
const YT_ID = /^[A-Za-z0-9_-]{11}$/;

/** The 11-character YouTube id of a link, or null when it is not a YouTube link. */
export function youtubeId(url: string | null | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try { u = new URL(url.trim()); } catch { return null; }
  const host = u.hostname.replace(/^www\.|^m\.|^music\./, '').toLowerCase();
  let id: string | null = null;
  if (host === 'youtu.be') id = u.pathname.split('/')[1] ?? null;
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else {
      const m = /^\/(?:embed|shorts|live|v)\/([^/?#]+)/.exec(u.pathname);
      id = m ? m[1] : null;
    }
  }
  return id && YT_ID.test(id) ? id : null;
}

export type Norm = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * Step video link. Empty → null. YouTube links in any shape become
 * https://www.youtube.com/watch?v=<id> (the student page turns that into a
 * privacy-enhanced embed). Other http(s) links are kept as they are.
 */
export function normaliseVideoUrl(v: unknown): Norm {
  if (v === null || v === undefined || (typeof v === 'string' && !v.trim())) return { ok: true, value: null };
  if (typeof v !== 'string') return { ok: false, error: 'The video link must be text.' };
  let text = v.trim();
  if (!/^https?:\/\//i.test(text) && /^(www\.)?(youtube\.com|youtu\.be)\//i.test(text)) text = `https://${text}`;
  const id = youtubeId(text);
  if (id) return { ok: true, value: `https://www.youtube.com/watch?v=${id}` };
  let u: URL;
  try { u = new URL(text); } catch { return { ok: false, error: 'Paste the full video link, e.g. https://www.youtube.com/watch?v=…' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: 'The video link must start with https://' };
  if (/youtube\.com|youtu\.be/i.test(u.hostname)) return { ok: false, error: 'This YouTube link has no video in it. Open the video on YouTube and copy the link from the Share button.' };
  if (text.length > 500) return { ok: false, error: 'The video link is too long (max 500 characters).' };
  return { ok: true, value: text };
}

// ---------------------------------------------------------------- one file attached from the builder
export const ATTACH_ROLES = ['worksheet', 'reference', 'assessment_sheet', 'resource'] as const;
export type AttachRole = (typeof ATTACH_ROLES)[number];
/** File code used in the stored (canonical) name, so the file looks as if it came through the naming convention. */
export const ATTACH_FILE_CODE: Record<AttachRole, string> = { worksheet: 'WS', reference: 'RF', assessment_sheet: 'AS', resource: 'RS' };
const ATTACH_EXT = ['jpg', 'jpeg', 'png', 'webp', 'pdf'];

export type AttachInput = { role?: unknown; sizeCode?: unknown; page?: unknown; storageKey?: unknown; originalFilename?: unknown; contentType?: unknown; byteSize?: unknown };
export type AttachClean = { role: AttachRole; sizeCode: string | null; page: string; storageKey: string; originalFilename: string; ext: string; contentType: string; byteSize: number | null };

/** Validates the body of POST /v2/steps/:id/files. */
export function validateAttach(body: AttachInput | null | undefined): { ok: true; value: AttachClean } | { ok: false; error: string } {
  const b = body ?? {};
  const role = b.role as AttachRole;
  if (!ATTACH_ROLES.includes(role)) return { ok: false, error: 'Choose what this file is: worksheet, reference image, assessment sheet or resource.' };
  if (typeof b.storageKey !== 'string' || !/^course-files\/[A-Za-z0-9._-]+$/.test(b.storageKey)) return { ok: false, error: 'Upload the file first, then attach it.' };
  const name = typeof b.originalFilename === 'string' && b.originalFilename.trim() ? b.originalFilename.trim().slice(0, 255) : 'file';
  const ext = (name.includes('.') ? name.split('.').pop()! : b.storageKey.split('.').pop() ?? '').toLowerCase();
  if (!ATTACH_EXT.includes(ext)) return { ok: false, error: 'Use a JPG, PNG, WEBP or PDF file.' };
  let sizeCode: string | null = null;
  if (b.sizeCode !== undefined && b.sizeCode !== null && b.sizeCode !== '') {
    if (!(SIZE_CODES as readonly string[]).includes(String(b.sizeCode))) return { ok: false, error: 'Mistar size must be 0.7 mm, 1 mm, 2 mm, 3 mm or Normal pen.' };
    sizeCode = String(b.sizeCode);
  }
  if (role === 'worksheet' && !sizeCode) return { ok: false, error: 'Choose the mistar size of this worksheet.' };
  if (role === 'reference') sizeCode = null;
  const pageNo = b.page === undefined || b.page === null || b.page === '' ? 1 : Number(String(b.page).replace(/^P/i, ''));
  if (!Number.isInteger(pageNo) || pageNo < 1 || pageNo > 99) return { ok: false, error: 'Page must be a number from 1 to 99.' };
  const contentType = typeof b.contentType === 'string' && b.contentType ? b.contentType.slice(0, 100)
    : ext === 'pdf' ? 'application/pdf' : ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  const byteSize = Number.isFinite(Number(b.byteSize)) && Number(b.byteSize) > 0 ? Math.round(Number(b.byteSize)) : null;
  return { ok: true, value: { role, sizeCode, page: `P${String(pageNo).padStart(2, '0')}`, storageKey: b.storageKey, originalFilename: name, ext: ext === 'jpeg' ? 'jpg' : ext, contentType, byteSize } };
}

/** Stored name, e.g. FNK-C101_WS_LV01_S02_P01_07_v2.jpg / URS-N201_RF_S01_v1.png */
export function attachCanonicalName(o: { courseCode: string | null; levelCode: string | null; stepCode: string; hiddenLevel: boolean; role: AttachRole; sizeCode: string | null; page: string; version: number; ext: string }): string {
  const parts = [o.courseCode || 'COURSE', ATTACH_FILE_CODE[o.role]];
  if (!o.hiddenLevel && o.levelCode) parts.push(o.levelCode);
  parts.push(o.stepCode);
  if (!(o.role === 'reference' && o.page === 'P01')) parts.push(o.page);
  if (o.sizeCode) parts.push(o.sizeCode);
  parts.push(`v${o.version}`);
  return `${parts.join('_')}.${o.ext}`;
}

// ---------------------------------------------------------------- add a step: only the allowed types
/** Step types offered in the "Add step" drop-down for a course of this type (in the logic-set order). */
export function allowedStepTypes(courseType: string | null, courseTypes: CourseTypeDef[], stepTypes: StepTypeDef[]): StepTypeDef[] {
  const ct = courseTypes.find(t => t.typeKey === courseType);
  const allowed = ct?.allowedStepTypes?.length ? ct.allowedStepTypes : stepTypes.map(s => s.typeKey);
  return stepTypes.filter(s => allowed.includes(s.typeKey)).sort((a, b) => a.sortOrder - b.sortOrder);
}

/** null when the type may be added by hand to this course; otherwise a plain explanation. */
export function stepTypeRefusal(stepType: string, courseType: string | null, courseTypes: CourseTypeDef[], stepTypes: StepTypeDef[]): string | null {
  const def = stepTypes.find(s => s.typeKey === stepType);
  if (!def) return `Type must be one of: ${stepTypes.map(t => t.label).join(', ')}.`;
  const allowed = allowedStepTypes(courseType, courseTypes, stepTypes);
  if (allowed.some(s => s.typeKey === stepType)) return null;
  const ct = courseTypes.find(t => t.typeKey === courseType);
  return `A ${def.label} step cannot be added to a course of type "${ct?.label ?? courseType ?? 'unknown'}". Choose one of: ${allowed.map(s => s.label).join(', ')}.`;
}

// ---------------------------------------------------------------- badge designs
export type BadgeKind = 'level' | 'course' | 'competition';
export const BADGE_KINDS: BadgeKind[] = ['level', 'course', 'competition'];
export type BadgeDesign = {
  id: string;
  name: string;
  kind: BadgeKind;
  badgeCode: string | null;   // used only for this exact badge
  isDefault: boolean;         // the usual artwork for its kind
  storageKey: string | null;
  contentType: string | null;
  note: string | null;
  updatedAt: string | null;
};

/**
 * Which artwork a student's badge shows:
 *   1. a design made for that exact badge code,
 *   2. the design chosen on the level (level badge) or course (course badge) in the builder,
 *   3. the default design of that kind,
 *   4. none (the PDF draws a simple seal).
 * Designs without artwork are skipped.
 */
export function resolveBadgeDesign(
  badge: { badgeCode: string; kind: string },
  designs: BadgeDesign[],
  chosenDesignId: string | null | undefined,
): BadgeDesign | null {
  const usable = designs.filter(d => d.storageKey);
  const exact = usable.find(d => d.badgeCode && d.badgeCode.toUpperCase() === badge.badgeCode.toUpperCase());
  if (exact) return exact;
  if (chosenDesignId) {
    const chosen = usable.find(d => d.id === chosenDesignId);
    if (chosen) return chosen;
  }
  return usable.find(d => d.isDefault && d.kind === badge.kind) ?? null;
}

/** Plain student-facing wording — no internal codes. */
export function badgeWording(o: { kind: string; courseTitle: string | null; courseType: string | null; levelOrder: number | null; label: string; hasLevels: boolean }): { title: string; subtitle: string } {
  const course = (o.courseTitle ?? '').trim();
  const kindRaw = o.courseType === 'mashq' ? 'Mashq worksheets' : o.courseType === 'crash' ? 'Crash course' : o.courseType === 'certification' ? 'Certification course' : '';
  // never "Mashq worksheets – Mashq worksheets": leave the kind out when the course name already says it
  const kindText = kindRaw && course.toLowerCase().includes(kindRaw.toLowerCase().replace(/ course$/, '')) ? '' : kindRaw;
  if (o.kind === 'level' && o.levelOrder !== null && o.hasLevels) {
    return { title: `Level ${o.levelOrder + 1} completed`, subtitle: [course, kindText].filter(Boolean).join(' · ') };
  }
  if (o.kind === 'level' || o.kind === 'course') {
    return { title: o.courseType === 'certification' ? 'Course completed' : 'Completed', subtitle: [course, kindText].filter(Boolean).join(' · ') };
  }
  // competition: the label already reads well ("Winner — Call for calligraphers …")
  return { title: o.label.split(/\s[—-]\s/)[0] || 'Award', subtitle: o.label.split(/\s[—-]\s/).slice(1).join(' — ') };
}

/** File name for the badge PDF, ASCII only. */
export function badgePdfName(studentName: string, title: string): string {
  const clean = (s: string) => s.normalize('NFKD').replace(/[^\x20-\x7E]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `Badge-${clean(studentName) || 'student'}-${clean(title) || 'award'}.pdf`.slice(0, 120);
}

// ---------------------------------------------------------------- progress: a passed level counts as done
/**
 * Once a level's assessment (a gating step) is passed, every worksheet-type step of that level
 * counts as done, even if the student never pressed "Mark as done". Mutates and returns `states`.
 */
export function creditPassedLevels<S extends { done: boolean; submissionStatus: string | null }>(
  levels: { steps: { id: string; stepType: string }[] }[],
  stepTypes: StepTypeDef[],
  states: Record<string, S>,
): Record<string, S> {
  for (const level of levels) {
    const gating = level.steps.filter(s => stepTypes.find(t => t.typeKey === s.stepType)?.gatesProgress);
    if (!gating.length || !gating.some(s => states[s.id]?.submissionStatus === 'passed')) continue;
    for (const s of level.steps) {
      const def = stepTypes.find(t => t.typeKey === s.stepType);
      if (def?.studentAction === 'watch_download' && states[s.id]) states[s.id] = { ...states[s.id], done: true };
    }
  }
  return states;
}
