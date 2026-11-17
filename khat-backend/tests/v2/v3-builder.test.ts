import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import type { CourseDetail, CourseTypeDef, FileCodeDef, StepTypeDef } from '../../src/v2/contracts.js';
import {
  allowedStepTypes, attachCanonicalName, badgePdfName, badgeWording, creditPassedLevels, normaliseVideoUrl, resolveBadgeDesign,
  stepTypeRefusal, validateAttach, youtubeId, type BadgeDesign,
} from '../../src/v2/lib/builderLogic.js';
import { buildBadgePdf } from '../../src/v2/lib/badgePdf.js';
import { computeHealth } from '../../src/v2/lib/courseLogic.js';
import { splitSql } from '../../scripts/apply-v2-migration.js';

const ST = (typeKey: string, studentAction: StepTypeDef['studentAction'], extra: Partial<StepTypeDef> = {}): StepTypeDef => ({
  typeKey, label: typeKey, fileCodes: [], studentAction, feedbackMode: 'none', hasMarks: false, gatesProgress: false, awardsBadge: false,
  requiresPriorUploads: false, defaultInstructions: '', sortOrder: 0, isSystem: true, ...extra,
});
const stepTypes: StepTypeDef[] = [
  ST('worksheet', 'watch_download', { label: 'Worksheet', sortOrder: 1 }),
  ST('raudat_hidayaat', 'watch_download', { label: 'Raudat Hidayaat', sortOrder: 3 }),
  ST('mashq', 'watch_download', { label: 'Mashq sheet', sortOrder: 5 }),
  ST('assessment', 'download_upload', { label: 'Level assessment', gatesProgress: true, hasMarks: true, awardsBadge: true, sortOrder: 8 }),
  ST('final_submission', 'upload', { label: 'Final submission', hasMarks: true, awardsBadge: true, sortOrder: 9 }),
];
const courseTypes: CourseTypeDef[] = [
  { typeKey: 'certification', label: 'Certification', allowedStepTypes: ['worksheet', 'raudat_hidayaat', 'assessment'], hasLevels: true, finalSubmission: false, sortOrder: 1 },
  { typeKey: 'mashq', label: 'Mashq worksheets', allowedStepTypes: ['mashq', 'worksheet', 'final_submission'], hasLevels: false, finalSubmission: true, sortOrder: 3 },
];

describe('video links (6.7)', () => {
  test('every YouTube shape gives the same id', () => {
    for (const u of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s', 'https://youtu.be/dQw4w9WgXcQ?si=abc', 'https://m.youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', 'https://youtube.com/live/dQw4w9WgXcQ']) assert.equal(youtubeId(u), 'dQw4w9WgXcQ', u);
    assert.equal(youtubeId('https://vimeo.com/123'), null);
    assert.equal(youtubeId('not a url'), null);
  });
  test('normalise: empty → null, YouTube → watch link, bare youtu.be gets https, others kept, junk refused', () => {
    assert.deepEqual(normaliseVideoUrl(''), { ok: true, value: null });
    assert.deepEqual(normaliseVideoUrl(null), { ok: true, value: null });
    assert.deepEqual(normaliseVideoUrl(' youtu.be/dQw4w9WgXcQ '), { ok: true, value: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
    assert.deepEqual(normaliseVideoUrl('https://vimeo.com/76979871'), { ok: true, value: 'https://vimeo.com/76979871' });
    assert.equal(normaliseVideoUrl('hello').ok, false);
    assert.equal(normaliseVideoUrl('https://www.youtube.com/feed/library').ok, false);
    assert.equal(normaliseVideoUrl('ftp://x.org/a.mp4').ok, false);
    assert.equal(normaliseVideoUrl(42).ok, false);
  });
});

describe('attach one file from the builder', () => {
  test('validates role, storage key, type and size', () => {
    const base = { role: 'worksheet', sizeCode: '07', storageKey: 'course-files/abc.jpg', originalFilename: 'alif.jpg' };
    const ok = validateAttach(base);
    assert.ok(ok.ok);
    if (ok.ok) assert.deepEqual([ok.value.page, ok.value.ext, ok.value.contentType], ['P01', 'jpg', 'image/jpeg']);
    assert.equal(validateAttach({ ...base, role: 'video' }).ok, false);
    assert.equal(validateAttach({ ...base, storageKey: 'threads/abc.jpg' }).ok, false);
    assert.equal(validateAttach({ ...base, storageKey: 'course-files/../x.jpg' }).ok, false);
    assert.equal(validateAttach({ ...base, originalFilename: 'a.mp4', storageKey: 'course-files/a.mp4' }).ok, false);
    assert.equal(validateAttach({ ...base, sizeCode: '' }).ok, false, 'worksheet needs a size');
    assert.equal(validateAttach({ ...base, sizeCode: '99' }).ok, false);
    const ref = validateAttach({ ...base, role: 'reference', sizeCode: '07', page: 2 });
    assert.ok(ref.ok && ref.value.sizeCode === null && ref.value.page === 'P02');
  });
  test('canonical names look like the naming convention', () => {
    assert.equal(attachCanonicalName({ courseCode: 'FNK-C101', levelCode: 'LV01', stepCode: 'S02', hiddenLevel: false, role: 'worksheet', sizeCode: '07', page: 'P01', version: 2, ext: 'jpg' }), 'FNK-C101_WS_LV01_S02_P01_07_v2.jpg');
    assert.equal(attachCanonicalName({ courseCode: 'URS-N201', levelCode: 'LV01', stepCode: 'S01', hiddenLevel: true, role: 'reference', sizeCode: null, page: 'P01', version: 1, ext: 'png' }), 'URS-N201_RF_S01_v1.png');
    assert.equal(attachCanonicalName({ courseCode: 'FNK-C101', levelCode: 'LV02', stepCode: 'S03', hiddenLevel: false, role: 'assessment_sheet', sizeCode: '10', page: 'P01', version: 1, ext: 'pdf' }), 'FNK-C101_AS_LV02_S03_P01_10_v1.pdf');
  });
});

describe('add step drop-down (6.12)', () => {
  test('only the allowed types, in logic-set order', () => {
    assert.deepEqual(allowedStepTypes('certification', courseTypes, stepTypes).map(t => t.typeKey), ['worksheet', 'raudat_hidayaat', 'assessment']);
    assert.deepEqual(allowedStepTypes('mashq', courseTypes, stepTypes).map(t => t.typeKey), ['worksheet', 'mashq', 'final_submission']);
    assert.equal(allowedStepTypes(null, courseTypes, stepTypes).length, stepTypes.length, 'unknown course type: everything');
  });
  test('refusal explains in plain words', () => {
    assert.equal(stepTypeRefusal('assessment', 'certification', courseTypes, stepTypes), null);
    assert.match(stepTypeRefusal('assessment', 'mashq', courseTypes, stepTypes) ?? '', /cannot be added to a course of type "Mashq worksheets".*Mashq sheet/);
    assert.match(stepTypeRefusal('nope', 'mashq', courseTypes, stepTypes) ?? '', /Type must be one of/);
  });
});

describe('badge designs (1.18)', () => {
  const D = (id: string, extra: Partial<BadgeDesign>): BadgeDesign => ({ id, name: id, kind: 'level', badgeCode: null, isDefault: false, storageKey: `badge-assets/${id}.png`, contentType: 'image/png', note: null, updatedAt: null, ...extra });
  const designs = [
    D('lvl-default', { isDefault: true }), D('gold', {}), D('exact', { badgeCode: 'BDG_FNK-C101_LV02' }),
    D('course-default', { kind: 'course', isDefault: true }), D('no-art', { storageKey: null, badgeCode: 'BDG_X_LV01' }),
  ];
  test('exact code → chosen on level → default of kind → none', () => {
    assert.equal(resolveBadgeDesign({ badgeCode: 'bdg_fnk-c101_lv02', kind: 'level' }, designs, 'gold')?.id, 'exact');
    assert.equal(resolveBadgeDesign({ badgeCode: 'BDG_FNK-C101_LV01', kind: 'level' }, designs, 'gold')?.id, 'gold');
    assert.equal(resolveBadgeDesign({ badgeCode: 'BDG_FNK-C101_LV01', kind: 'level' }, designs, null)?.id, 'lvl-default');
    assert.equal(resolveBadgeDesign({ badgeCode: 'BDG_FNK-C101_COURSE', kind: 'course' }, designs, 'missing')?.id, 'course-default');
    assert.equal(resolveBadgeDesign({ badgeCode: 'COMP_1', kind: 'competition' }, designs, null), null);
    assert.equal(resolveBadgeDesign({ badgeCode: 'BDG_X_LV01', kind: 'level' }, designs, null)?.id, 'lvl-default', 'designs without artwork are skipped');
  });
  test('wording has no internal codes', () => {
    const lvl = badgeWording({ kind: 'level', courseTitle: 'Fann al-Khat 1', courseType: 'certification', levelOrder: 2, label: 'FNK-C101 LV03 — x', hasLevels: true });
    assert.deepEqual(lvl, { title: 'Level 3 completed', subtitle: 'Fann al-Khat 1 · Certification course' });
    assert.equal(badgeWording({ kind: 'level', courseTitle: 'Urs', courseType: 'mashq', levelOrder: 0, label: '', hasLevels: false }).subtitle, 'Urs · Mashq worksheets');
    assert.equal(badgeWording({ kind: 'course', courseTitle: 'Fann', courseType: 'certification', levelOrder: null, label: '', hasLevels: true }).title, 'Course completed');
    assert.deepEqual(badgeWording({ kind: 'competition', courseTitle: null, courseType: null, levelOrder: null, label: 'Winner — Ashara call', hasLevels: true }), { title: 'Winner', subtitle: 'Ashara call' });
    assert.doesNotMatch(JSON.stringify(lvl), /FNK|LV0/);
  });
  test('file name is ASCII', () => {
    assert.equal(badgePdfName('Mustafa Saifee', 'Level 1 completed'), 'Badge-Mustafa-Saifee-Level-1-completed.pdf');
    assert.match(badgePdfName('مصطفى', 'Level 1'), /^Badge-student-Level-1\.pdf$/);
  });
  test('printable PDF: one A4 landscape page, works with and without artwork, Arabic names do not break it', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    for (const artwork of [null, new Uint8Array(png), new Uint8Array([1, 2, 3])]) {
      const bytes = await buildBadgePdf({ studentName: 'مصطفى Saifee', trNumber: '30101', branchName: 'Nairobi', title: 'Level 1 completed', subtitle: 'Fann al-Khat 1 · Certification course', awardedAt: new Date('2026-11-10T10:00:00Z'), badgeId: 'd98d8311-95af', artwork });
      const doc = await PDFDocument.load(bytes);
      assert.equal(doc.getPageCount(), 1);
      const { width, height } = doc.getPage(0).getSize();
      assert.ok(width > height, 'landscape');
    }
  });
});

describe('progress: a passed level counts as done (audit 4)', () => {
  test('worksheets of a level with a passed assessment become done; other levels untouched', () => {
    const levels = [
      { steps: [{ id: 'a1', stepType: 'worksheet' }, { id: 'a2', stepType: 'raudat_hidayaat' }, { id: 'a3', stepType: 'assessment' }] },
      { steps: [{ id: 'b1', stepType: 'worksheet' }, { id: 'b2', stepType: 'assessment' }] },
    ];
    const s = (done: boolean, submissionStatus: string | null) => ({ done, submissionStatus });
    const states = creditPassedLevels(levels, stepTypes, { a1: s(false, null), a2: s(true, null), a3: s(true, 'passed'), b1: s(false, null), b2: s(false, 'revision') });
    assert.deepEqual(Object.fromEntries(Object.entries(states).map(([k, v]) => [k, v.done])), { a1: true, a2: true, a3: true, b1: false, b2: false });
  });
});

describe('health: worksheet-only courses need a final upload (audit 2)', () => {
  const course = (steps: { id: string; stepType: string }[], courseType: string | null): CourseDetail => ({
    id: 'c', code: 'URS-N201', title: 'Urs', titleAr: null, penType: 'normal', courseType, khatTypeId: 'k', status: 'draft', structureVersion: 2, branchIds: ['b'],
    mistarSizes: [], counts: { levels: 1, steps: steps.length, files: 0, missing: 0, students: 0 }, updatedAt: null, description: null, instructions: null,
    driveFolderUrl: null, masterRow: null,
    levels: [{ id: 'l', courseId: 'c', code: 'LV01', orderIndex: 0, description: null, instructions: null, badgeCode: null, status: 'published',
      steps: steps.map((s, i) => ({ ...s, levelId: 'l', code: `S0${i + 1}`, orderIndex: i, title: 'x', template: null, message: null, maxMarks: null, badgeCode: null, status: 'published' as const, source: 'manual' as const, files: [], missing: [] })) }],
  });
  const fileCodes: FileCodeDef[] = [];
  test('mashq without final submission → error; with one → no such error', () => {
    const bad = computeHealth(course([{ id: '1', stepType: 'mashq' }], 'mashq'), stepTypes, courseTypes, fileCodes);
    assert.ok(bad.some(i => i.severity === 'error' && /no final upload/.test(i.message)));
    const good = computeHealth(course([{ id: '1', stepType: 'mashq' }, { id: '2', stepType: 'final_submission' }], 'mashq'), stepTypes, courseTypes, fileCodes);
    assert.ok(!good.some(i => /no final upload/.test(i.message)));
  });
  test('worksheet-only course of no known type is flagged too', () => {
    const issues = computeHealth(course([{ id: '1', stepType: 'worksheet' }], null), stepTypes, courseTypes, fileCodes);
    assert.ok(issues.some(i => i.severity === 'error' && /no final upload/.test(i.message)));
  });
});

describe('migration file', () => {
  test('splits into re-runnable statements', () => {
    const sql = readFileSync(new URL('../../scripts/migrations/2026-11-14-v3-builder.sql', import.meta.url), 'utf8');
    const parts = splitSql(sql);
    assert.ok(parts.length >= 10);
    assert.ok(parts.some(p => /CREATE TABLE IF NOT EXISTS badge_designs/.test(p)));
    assert.ok(parts.some(p => /certification_ready/.test(p)));
  });
});

describe('master file course types (6.11)', async () => {
  const { masterCourseType, normaliseCourseType } = await import('../../src/v2/lib/csv.js');
  test('Urs is Mashq, Mashq before Crash, worksheets → Mashq', () => {
    assert.equal(masterCourseType('Crash Course', 'Urs Crash Course', 'URS-N201'), 'mashq');
    assert.equal(masterCourseType('Crash course', 'العرس المئوي', ''), 'mashq');
    assert.equal(normaliseCourseType('Mashq worksheets (crash)'), 'mashq');
    assert.equal(normaliseCourseType('Worksheets only'), 'mashq');
    assert.equal(normaliseCourseType('Crash course'), 'crash');
    assert.equal(masterCourseType('Certification', 'Fann al-Khat 1', 'FNK-C101'), 'certification');
    assert.equal(masterCourseType('Crash course', 'Thuluth Crash Course', 'THL-C201'), 'crash');
  });
});
