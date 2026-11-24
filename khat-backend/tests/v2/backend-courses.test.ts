import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { CourseTypeDef, FileCodeDef, Level, Step, StepFile, StepTypeDef } from '../../src/v2/contracts.js';
import { parseFileName, parseMistarSizes, normaliseCourseCode, sizeFromText, canonicalName } from '../../src/v2/lib/naming.js';
import {
  parseCsv, readMasterSheet, compareMasterRows, sheetUrlToCsvUrl, splitTitle, matchBranchName, matchKhatType,
  readManifestSheet, stepTypeFromText,
} from '../../src/v2/lib/csv.js';
import {
  planIngest, stepMissing, computeHealth, computeUnlockedLevelIds, computeProgressPercent, buildStepStates,
  studentLevels, filterFilesForSize, chooseMySize, studentCanSeeCourse, insertPosition, nextCode, passedStepIdsFrom,
  type PlanContext,
} from '../../src/v2/lib/courseLogic.js';
import { validatePolicyValue } from '../../src/v2/lib/policyValidate.js';
import { splitSql } from '../../scripts/apply-v2-migration.js';
import { driveIdFromUrl } from '../../src/v2/lib/drive.js';

// ---------------------------------------------------------------- fixtures (mirror the migration seed)
const ST = (typeKey: string, studentAction: StepTypeDef['studentAction'], extra: Partial<StepTypeDef> = {}): StepTypeDef => ({
  typeKey, label: typeKey === 'raudat_hidayaat' ? 'Raudat Hidayaat' : typeKey[0].toUpperCase() + typeKey.slice(1), fileCodes: [], studentAction,
  feedbackMode: 'none', hasMarks: false, gatesProgress: false, awardsBadge: false, requiresPriorUploads: false, defaultInstructions: '', sortOrder: 0, isSystem: true, ...extra,
});
const stepTypes: StepTypeDef[] = [
  ST('worksheet', 'watch_download'), ST('kitabat', 'watch_download'), ST('raudat_hidayaat', 'watch_download'),
  ST('resource', 'watch_download'), ST('mashq', 'watch_download'), ST('istinsakh', 'upload', { feedbackMode: 'feedback' }),
  ST('assessment', 'download_upload', { label: 'Level assessment', feedbackMode: 'annotate_mark', hasMarks: true, gatesProgress: true, awardsBadge: true, requiresPriorUploads: true }),
  ST('final_submission', 'upload', { label: 'Final submission', hasMarks: true, awardsBadge: true }),
];
const fileCodes: FileCodeDef[] = [
  ['MT', 'worksheet', 'worksheet'], ['PW', 'worksheet', 'worksheet'], ['WS', 'worksheet', 'worksheet'], ['HF', 'worksheet', 'worksheet'],
  ['KT', 'kitabat', 'worksheet'], ['RH', 'raudat_hidayaat', 'worksheet'], ['RS', 'resource', 'resource'], ['MS', 'mashq', 'worksheet'],
  ['IS', 'istinsakh', 'reference'], ['AW', 'assessment', 'assessment_sheet'], ['AS', 'assessment', 'assessment_sheet'],
  ['FS', 'final_submission', 'reference'], ['VD', '', 'video'], ['RF', '', 'reference'],
].map(([fileCode, stepType, fileRole]) => ({ fileCode, stepType, fileRole: fileRole as FileCodeDef['fileRole'], label: fileCode }));
for (const t of stepTypes) t.fileCodes = fileCodes.filter(c => c.stepType === t.typeKey).map(c => c.fileCode);
const courseTypes: CourseTypeDef[] = [
  { typeKey: 'certification', label: 'Certification', allowedStepTypes: ['worksheet', 'kitabat', 'raudat_hidayaat', 'istinsakh', 'assessment'], hasLevels: true, finalSubmission: false, sortOrder: 10 },
  { typeKey: 'crash', label: 'Crash course', allowedStepTypes: ['worksheet', 'resource', 'final_submission'], hasLevels: false, finalSubmission: true, sortOrder: 20 },
];

// ---------------------------------------------------------------- naming
describe('parseFileName', () => {
  const ok = (name: string) => {
    const r = parseFileName(name);
    assert.ok(r.ok, `${name} should parse: ${!r.ok ? r.error : ''}`);
    return r;
  };
  const fails = (name: string, re?: RegExp) => {
    const r = parseFileName(name);
    assert.equal(r.ok, false, `${name} should fail`);
    if (re && !r.ok) assert.match(r.error, re);
  };

  test('spec example: standard worksheet', () => {
    const r = ok('FNK-C101_MT_LV01_S01_P01_07_v1.jpg');
    assert.deepEqual(r.parsed, { courseCode: 'FNK-C101', fileCode: 'MT', level: 'LV01', step: 'S01', page: 'P01', sizeCode: '07', version: 1, ext: 'jpg', slug: null });
    assert.equal(r.canonicalName, 'FNK-C101_MT_LV01_S01_P01_07_v1.jpg');
  });
  test('spec example: video', () => {
    const r = ok('FNK-C101_VD_LV01_S01_v1.mp4');
    assert.equal(r.parsed.fileCode, 'VD'); assert.equal(r.parsed.sizeCode, null); assert.equal(r.parsed.page, 'P01');
    assert.equal(r.canonicalName, 'FNK-C101_VD_LV01_S01_v1.mp4');
  });
  test('spec example: harf with page number and slug', () => {
    const r = ok('FNK-C101_HF_LV01_S01_01_alif_07.png');
    assert.equal(r.parsed.page, 'P01'); assert.equal(r.parsed.slug, 'alif'); assert.equal(r.parsed.sizeCode, '07'); assert.equal(r.parsed.version, 1);
    assert.equal(r.canonicalName, 'FNK-C101_HF_LV01_S01_01_alif_07.png');
  });
  test('spec example: steps-only course', () => {
    const r = ok('FNK-C201_RS_S03_P02_20_v2.pdf');
    assert.equal(r.parsed.level, null); assert.equal(r.parsed.step, 'S03'); assert.equal(r.parsed.page, 'P02'); assert.equal(r.parsed.version, 2);
  });
  test('every size code', () => {
    for (const s of ['07', '10', '20', '30', 'NP']) assert.equal(ok(`FNK-C101_MT_LV01_S01_P01_${s}_v1.jpg`).parsed.sizeCode, s);
  });
  test('missing version → v1 with a note', () => {
    const r = ok('FNK-C101_MT_LV01_S01_P01_10.jpg');
    assert.equal(r.parsed.version, 1); assert.ok(r.notes.some(n => /v1/.test(n)));
  });
  test('lower case everything', () => { assert.equal(ok('fnk-c101_mt_lv02_s04_p01_20_v3.JPG').parsed.level, 'LV02'); });
  test('.jpeg becomes jpg, .JPG lower-cased', () => {
    assert.equal(ok('FNK-C101_MT_LV01_S01_P01_07_v1.jpeg').parsed.ext, 'jpg');
    assert.equal(ok('FNK-C101_MT_LV01_S01_P01_07_v1.JPG').parsed.ext, 'jpg');
  });
  test('.png .pdf .mp4 .mov accepted', () => {
    for (const e of ['png', 'pdf', 'mp4', 'mov']) assert.equal(ok(`FNK-C101_KT_LV01_S02_P01_10_v1.${e}`).parsed.ext, e);
  });
  test('hyphens instead of underscores', () => { assert.equal(ok('FNK-C101-MT-LV01-S01-P01-07-v1.jpg').canonicalName, 'FNK-C101_MT_LV01_S01_P01_07_v1.jpg'); });
  test('spaces around separators', () => { assert.equal(ok('FNK-C101 _ MT _ LV01 _ S01 _ P01 _ 07 _ v1.jpg').canonicalName, 'FNK-C101_MT_LV01_S01_P01_07_v1.jpg'); });
  test('course code written with underscore or space', () => {
    assert.equal(ok('FNK_C101_MT_LV01_S01_P01_07_v1.jpg').parsed.courseCode, 'FNK-C101');
    assert.equal(ok('FNK C101 MT LV01 S01 P01 07 v1.jpg').parsed.courseCode, 'FNK-C101');
  });
  test('split tokens: "LV 1", "S 3", "1 mm", "V 2"', () => {
    const r = ok('FNK-C101 MT LV 1 S 3 P 1 1 mm V 2.jpg');
    assert.equal(r.parsed.level, 'LV01'); assert.equal(r.parsed.step, 'S03'); assert.equal(r.parsed.sizeCode, '10'); assert.equal(r.parsed.version, 2);
  });
  test('sizes written as 0.7mm / 2mm', () => {
    assert.equal(ok('FNK-C101_MT_LV01_S01_P01_0.7mm_v1.jpg').parsed.sizeCode, '07');
    assert.equal(ok('FNK-C101_MT_LV01_S01_P01_2mm_v1.jpg').parsed.sizeCode, '20');
  });
  test('no page → P01; single-digit numbers padded', () => {
    const r = ok('FNK-C101_AW_LV3_S5_07_v1.pdf');
    assert.equal(r.parsed.page, 'P01'); assert.equal(r.parsed.level, 'LV03'); assert.equal(r.parsed.step, 'S05');
  });
  test('copy suffixes from downloads are ignored', () => {
    assert.equal(ok('FNK-C101_MT_LV01_S01_P01_07_v1 (1).jpg').canonicalName, 'FNK-C101_MT_LV01_S01_P01_07_v1.jpg');
    assert.equal(ok('Copy of FNK-C101_MT_LV01_S01_P01_07_v1.jpg').parsed.courseCode, 'FNK-C101');
  });
  test('folder path in the name is dropped', () => { assert.equal(ok('LV01/worksheets/FNK-C101_MT_LV01_S01_P01_07_v1.jpg').parsed.step, 'S01'); });
  test('v02 and V10', () => {
    assert.equal(ok('FNK-C101_MT_LV01_S01_P01_07_v02.jpg').parsed.version, 2);
    assert.equal(ok('FNK-C101_MT_LV01_S01_P01_07_V10.jpg').parsed.version, 10);
  });
  test('harf with multi-word slug and version', () => {
    const r = ok('FNK-C101_HF_LV01_S02_12_alif-maqsura_10_v2.png');
    assert.equal(r.parsed.page, 'P12'); assert.equal(r.parsed.slug, 'alif-maqsura'); assert.equal(r.parsed.sizeCode, '10'); assert.equal(r.parsed.version, 2);
    assert.equal(r.canonicalName, 'FNK-C101_HF_LV01_S02_12_alif-maqsura_10_v2.png');
  });
  test('harf first number is the page even when it looks like a size', () => {
    const r = ok('FNK-C101_HF_LV01_S01_10_haa_20.png');
    assert.equal(r.parsed.page, 'P10'); assert.equal(r.parsed.sizeCode, '20');
  });
  test('normal pen written out', () => { assert.equal(ok('FNK-C101_MT_LV01_S01_P01_Normal Pen_v1.jpg').parsed.sizeCode, 'NP'); });
  test('5-letter prefix course code', () => { assert.equal(ok('NASTQ-N101_MT_LV01_S01_P01_10_v1.jpg').parsed.courseCode, 'NASTQ-N101'); });
  test('known codes check', () => {
    const r = parseFileName('FNK-C101_ZZ_LV01_S01_P01_07_v1.jpg', ['MT', 'KT']);
    assert.equal(r.ok, false); if (!r.ok) assert.match(r.error, /not a known file type code/);
  });
  test('errors: no extension, bad extension, no code, no step', () => {
    fails('FNK-C101_MT_LV01_S01_P01_07_v1', /no file type/);
    fails('FNK-C101_MT_LV01_S01_P01_07_v1.docx', /not accepted/);
    fails('worksheet one.jpg', /course code/);
    fails('FNK-C101_MT_LV01_P01_07_v1.jpg', /step number/);
  });
  test('errors: duplicates, unknown words, bad size, empty', () => {
    fails('FNK-C101_MT_LV01_S01_S02_P01_07.jpg', /more than one step/);
    fails('FNK-C101_MT_LV01_S01_P01_07_final.jpg', /could not understand/);
    fails('FNK-C101_MT_LV01_S01_P01_P02_15.jpg', /more than one page/);
    fails('FNK-C101_MT_LV01_S01_P01_15.jpg', /number "15"/);
    fails('', /no name/);
    fails('FNK-C101.jpg', /nothing after/);
    fails('FNK-C101_MT_LV01_S00_P01_07.jpg', /start at S01/);
  });
  test('canonical name of steps-only and reference files', () => {
    const r = ok('FNK-C201_RF_S01_v1.jpg');
    assert.equal(canonicalName(r.parsed), 'FNK-C201_RF_S01_v1.jpg');
  });
  test('Arabic / invisible characters do not break parsing', () => {
    assert.equal(ok('FNK-C101_MT_LV01_S01_P01_07_v1‏.jpg').parsed.version, 1);
  });
});

describe('mistar sizes', () => {
  test('spec examples', () => {
    assert.deepEqual(parseMistarSizes('0.7 mm, 1 mm, 2 mm'), ['07', '10', '20']);
    assert.deepEqual(parseMistarSizes('Normal Pen'), ['NP']);
  });
  test('variants', () => {
    assert.deepEqual(parseMistarSizes('2mm / 1mm'), ['10', '20']);
    assert.deepEqual(parseMistarSizes('07, 10, 30'), ['07', '10', '30']);
    assert.deepEqual(parseMistarSizes('1 mm and 3 mm'), ['10', '30']);
    assert.deepEqual(parseMistarSizes('0.7mm; normal pen'), ['07', 'NP']);
    assert.deepEqual(parseMistarSizes(''), []);
    assert.deepEqual(parseMistarSizes('5 mm'), []);
  });
  test('sizeFromText', () => {
    assert.equal(sizeFromText('0,7 mm'), '07');
    assert.equal(sizeFromText('10'), '10');
    assert.equal(sizeFromText('10 mm'), null);
    assert.equal(sizeFromText('np'), 'NP');
  });
  test('normaliseCourseCode', () => {
    assert.equal(normaliseCourseCode(' fnk c101 '), 'FNK-C101');
    assert.equal(normaliseCourseCode('FNKC101'), 'FNK-C101');
    assert.equal(normaliseCourseCode('F-C101'), null);
  });
});

// ---------------------------------------------------------------- CSV
describe('CSV + master sheet', () => {
  test('quoted commas, escaped quotes, CRLF, blank lines, BOM', () => {
    const rows = parseCsv('﻿a,b,c\r\n"x, y","he said ""hi""",3\r\n\r\n,,\n"multi\nline",2,3');
    assert.deepEqual(rows, [['a', 'b', 'c'], ['x, y', 'he said "hi"', '3'], ['multi\nline', '2', '3']]);
  });
  const sheet = [
    'Master Course List,,,,,,,,,',
    '',
    'Pen Type,Course Type,Course Name,Course Code,Description,Branch,Mistar sizes,Levels,Status,Drive folder',
    'Cut Pen,Certification,"Naskh Mufradaat / نسخ مفردات",FNK-C101,"Letters, one by one",All,"0.7 mm, 1 mm, 2 mm",6,Ready,https://drive.google.com/drive/folders/abc123XYZ987',
    'Normal Pen,Crash Course,Thuluth crash,fnk c201,,"Nairobi, Marol",Normal Pen,,Planned,',
    ',,,,,,,,,',
    'Cut Pen,Mashq,Mashq set,,,,,,,',
    'Cut Pen,Mashq,Bad code row,X-1,,,,,,',
  ].join('\n');
  test('reads the Courses tab with title rows above the header', () => {
    const rows = readMasterSheet(sheet);
    assert.equal(rows.length, 4);
    assert.equal(rows[0].courseCode, 'FNK-C101');
    assert.equal(rows[0].fields.title, 'Naskh Mufradaat');
    assert.equal(rows[0].fields.titleAr, 'نسخ مفردات');
    assert.equal(rows[0].fields.description, 'Letters, one by one');
    assert.deepEqual(rows[0].fields.mistarSizes, ['07', '10', '20']);
    assert.deepEqual(rows[0].fields.branches, []);
    assert.equal(rows[0].fields.penType, 'cut');
    assert.equal(rows[0].fields.courseType, 'certification');
    assert.equal(rows[1].courseCode, 'FNK-C201');
    assert.deepEqual(rows[1].fields.mistarSizes, ['NP']);
    assert.deepEqual(rows[1].fields.branches, ['Nairobi', 'Marol']);
    assert.equal(rows[1].fields.courseType, 'crash');
    assert.equal(rows[0].masterRow['Status'], 'Ready');
  });
  test('compare: create / update / same / error, never forces anything', () => {
    const rows = readMasterSheet(sheet);
    const preview = compareMasterRows(rows, [
      { id: '1', code: 'FNK-C101', title: 'Naskh Mufradaat', titleAr: 'نسخ مفردات', penType: 'cut', courseType: 'certification', description: 'Letters, one by one', branchNames: [], mistarSizes: ['10', '20'], driveFolderUrl: 'https://drive.google.com/drive/folders/abc123XYZ987' },
    ], ['Nairobi', 'Karachi', 'Marol / Mumbai']);
    assert.equal(preview[0].action, 'update');
    assert.deepEqual(preview[0].changes, ['Mistar sizes 1 mm, 2 mm → 0.7 mm, 1 mm, 2 mm']);
    assert.equal(preview[1].action, 'create');
    assert.equal(preview[2].action, 'error');
    assert.match(preview[2].message ?? '', /no course code/);
    assert.equal(preview[3].action, 'error');
  });
  test('same row twice → second is an error; unchanged → same', () => {
    const csv = 'Course Code,Course Name\nFNK-C101,A\nFNK-C101,B';
    const p = compareMasterRows(readMasterSheet(csv), [{ id: '1', code: 'FNK-C101', title: 'A', titleAr: null, penType: null, courseType: null, description: null, branchNames: [], mistarSizes: [], driveFolderUrl: null }], []);
    assert.equal(p[0].action, 'same');
    assert.equal(p[1].action, 'error');
  });
  test('Drive folder: "Open folder" text is ignored, a plain link in any Drive column is used', () => {
    const rows = readMasterSheet('Course Code,Drive folder,Drive link\nFNK-C101,Open folder,https://drive.google.com/drive/folders/X1\nFNK-C102,Open folder,');
    assert.equal(rows[0].fields.driveFolderUrl, 'https://drive.google.com/drive/folders/X1');
    assert.equal(rows[1].fields.driveFolderUrl, undefined);
  });
  test('no Course Code column → friendly error', () => { assert.throws(() => readMasterSheet('a,b\n1,2'), /Course Code/); });
  test('sheet URL conversion', () => {
    assert.equal(sheetUrlToCsvUrl('https://docs.google.com/spreadsheets/d/AbC_123-x/edit#gid=42'), 'https://docs.google.com/spreadsheets/d/AbC_123-x/export?format=csv&gid=42');
    assert.equal(sheetUrlToCsvUrl('https://docs.google.com/spreadsheets/d/AbC/edit', 'Courses'), 'https://docs.google.com/spreadsheets/d/AbC/gviz/tq?tqx=out:csv&sheet=Courses');
    assert.equal(sheetUrlToCsvUrl('https://example.com/x.csv'), null);
  });
  test('splitTitle, branch + khat matching', () => {
    assert.deepEqual(splitTitle('Thuluth - ثلث'), { title: 'Thuluth', titleAr: 'ثلث' });
    assert.deepEqual(splitTitle('Plain'), { title: 'Plain', titleAr: null });
    assert.equal(matchBranchName('marol', ['Nairobi', 'Marol / Mumbai']), 'Marol / Mumbai');
    assert.equal(matchBranchName('Lusaka', ['Nairobi']), null);
    const kt = [{ id: 'n', code: 'naskh', displayName: 'Naskh' }, { id: 'nn', code: 'naskh_normal_pen', displayName: 'Naskh (Normal Pen)' }, { id: 's', code: 'sulus', displayName: 'Sulus (Thuluth)' }];
    assert.equal(matchKhatType('Naskh Mufradaat', 'cut', kt), 'n');
    assert.equal(matchKhatType('Naskh Mufradaat', 'normal', kt), 'nn');
    assert.equal(matchKhatType('Thuluth crash', 'normal', kt), 's');
    assert.equal(matchKhatType('Diwani', 'cut', kt), null);
  });
  test('manifest sheet: merged level cells carry down, types resolved', () => {
    const rows = readManifestSheet('Level,Description,Step,Task,Type,Max marks\nLV01,مفردات,S01,Alif and Baa,Worksheet,\n,,S02,Haa and Daal,MT,\n,,S03,Assessment,Level assessment,10\nLV2,مركبات,S01,Joins,KT,');
    assert.equal(rows.length, 4);
    assert.equal(rows[1].level, 'LV01'); assert.equal(rows[1].description, 'مفردات');
    assert.equal(rows[2].maxMarks, 10);
    assert.equal(rows[3].level, 'LV02');
    assert.equal(stepTypeFromText('MT', stepTypes), 'worksheet');
    assert.equal(stepTypeFromText('Level assessment', stepTypes), 'assessment');
    assert.equal(stepTypeFromText('Raudat Hidayaat', stepTypes), 'raudat_hidayaat');
    assert.equal(stepTypeFromText('Test', stepTypes), 'assessment');
    assert.equal(stepTypeFromText('zzz', stepTypes), null);
  });
});

// ---------------------------------------------------------------- ingest planning
function ctxWith(): PlanContext {
  return {
    fileCodes, stepTypes, courseTypes,
    courses: new Map([
      ['FNK-C101', {
        id: 'c1', code: 'FNK-C101', title: 'Naskh', structureVersion: 2, courseType: 'certification', mistarSizes: ['07', '10'],
        levels: [{
          id: 'l1', code: 'LV01', description: 'مفردات', steps: [
            { id: 's1', code: 'S01', title: 'Alif and Baa', stepType: 'worksheet', files: [{ id: 'f1', role: 'worksheet', sizeCode: '07', page: 'P01', version: 1, isCurrent: true, canonicalName: 'FNK-C101_MT_LV01_S01_P01_07_v1.jpg' }] },
            { id: 's2', code: 'S02', title: null, stepType: 'worksheet', files: [{ id: 'f2', role: 'video', sizeCode: null, page: 'P01', version: 1, isCurrent: true, canonicalName: 'FNK-C101_VD_LV01_S02_v1.mp4' }] },
          ],
        }],
      }],
      ['OLD-A100', { id: 'c0', code: 'OLD-A100', title: 'Old', structureVersion: 1, courseType: null, mistarSizes: [], levels: [] }],
    ]),
  };
}

describe('ingest planning', () => {
  test('new step in an existing level, with Task name in later messages', () => {
    const [d] = planIngest(['FNK-C101_MT_LV01_S03_P01_07_v1.jpg'], ctxWith());
    assert.equal(d.action, 'new_step');
    assert.match(d.message, /New step S03 will be created in LV01 \(مفردات\) \(Worksheet\)/);
  });
  test('new level; the next file of the batch sees it', () => {
    const ds = planIngest(['FNK-C101_MT_LV02_S01_P01_07_v1.jpg', 'FNK-C101_MT_LV02_S01_P01_10_v1.jpg', 'FNK-C101_MT_LV02_S02_P01_10_v1.jpg'], ctxWith());
    assert.deepEqual(ds.map(d => d.action), ['new_level', 'add_file', 'new_step']);
    assert.ok(ds[0].createLevel && !ds[1].createLevel);
  });
  test('same file → same_file; newer → new_version; older → history only', () => {
    const ctx = ctxWith();
    const [same, newer] = planIngest(['FNK-C101_MT_LV01_S01_P01_07_v1.jpg', 'FNK-C101_MT_LV01_S01_P01_07_v2.jpg'], ctx);
    assert.equal(same.action, 'same_file');
    assert.equal(newer.action, 'new_version');
    assert.equal(newer.demoteOthers, true);
    assert.match(newer.message, /Newer version v2 replaces v1/);
    const [older] = planIngest(['FNK-C101_MT_LV01_S01_P01_07_v1.png'], ctx); // different ext, v1 < v2
    assert.equal(older.action, 'add_file');
    assert.equal(older.makeCurrent, false);
    assert.match(older.message, /history/);
    // the simulated v1 slot is now history, v2 current
    const slot = ctx.courses.get('FNK-C101')!.levels[0].steps[0].files;
    assert.equal(slot.find(f => f.version === 2)?.isCurrent, true);
    assert.equal(slot.find(f => f.id === 'f1')?.isCurrent, false);
  });
  test('add another size to an existing step', () => {
    const [d] = planIngest(['FNK-C101_MT_LV01_S01_P01_10_v1.jpg'], ctxWith());
    assert.equal(d.action, 'add_file');
    assert.match(d.message, /Adds the worksheet 1 mm, page P01, v1 to LV01 \(مفردات\) S01 'Alif and Baa'/);
  });
  test('video-only step becomes an assessment when its AW arrives', () => {
    const [d] = planIngest(['FNK-C101_AW_LV01_S02_P01_07_v1.pdf'], ctxWith());
    assert.equal(d.retypeStep, true); assert.equal(d.stepType, 'assessment');
    assert.match(d.message, /becomes a Level assessment step/);
  });
  test('typed step keeps its type and says so', () => {
    const [d] = planIngest(['FNK-C101_KT_LV01_S01_P01_07_v1.jpg'], ctxWith());
    assert.equal(d.retypeStep, false); assert.equal(d.stepType, 'worksheet');
    assert.ok(d.notes.some(n => /without changing its type/.test(n)));
  });
  test('unknown course, old course, bad name', () => {
    const ds = planIngest(['ABC-D123_MT_LV01_S01_P01_07_v1.jpg', 'OLD-A100_MT_LV01_S01_P01_07_v1.jpg', 'scan001.jpg'], ctxWith());
    assert.equal(ds[0].action, 'unknown_course');
    assert.equal(ds[0].message, 'Course ABC-D123 is not in the master list yet — import the master list first.');
    assert.equal(ds[1].action, 'error');
    assert.equal(ds[2].action, 'error');
  });
  test('size outside course sizes gives a note; VD creates a default worksheet step', () => {
    const [a, b] = planIngest(['FNK-C101_MT_LV01_S01_P01_30_v1.jpg', 'FNK-C101_VD_LV01_S09_v1.mp4'], ctxWith());
    assert.ok(a.notes.some(n => /3 mm is not one of/.test(n)));
    assert.equal(b.action, 'new_step'); assert.equal(b.stepType, 'worksheet'); assert.equal(b.fileRole, 'video');
  });
  test('ordering helpers', () => {
    assert.equal(insertPosition(['LV01', 'LV05'], 'LV03'), 1);
    assert.equal(insertPosition(['LV01', 'LV02'], 'LV03'), 2);
    assert.equal(nextCode('LV', ['LV01', 'LV04', null]), 'LV05');
    assert.equal(nextCode('S', []), 'S01');
  });
});

// ---------------------------------------------------------------- missing + health
const F = (role: StepFile['role'], sizeCode: string | null, page = 'P01', isCurrent = true): StepFile => ({
  id: `${role}${sizeCode}${page}${Math.random()}`, role, sizeCode, page, version: 1, isCurrent, storageKey: 'k', originalFilename: 'x', canonicalName: 'x',
  contentType: null, byteSize: null, source: 'upload', uploadedAt: '2026-11-10T00:00:00.000Z', uploadedByName: null,
});
const S = (id: string, code: string, stepType: string, files: StepFile[], extra: Partial<Step> = {}): Step => ({
  id, levelId: 'l', code, orderIndex: 0, title: 'Task', stepType, template: null, message: null, maxMarks: null, badgeCode: null, status: 'published', source: 'file', files, missing: [], ...extra,
});
const L = (id: string, code: string, steps: Step[], extra: Partial<Level> = {}): Level => ({
  id, courseId: 'c', code, orderIndex: 0, description: 'd', instructions: null, badgeCode: null, status: 'published', steps, ...extra,
});

describe('missing files + health', () => {
  test('missing worksheet per size and per page', () => {
    assert.deepEqual(stepMissing({ stepType: 'worksheet', files: [F('worksheet', '07')] }, ['07', '10', '20'], stepTypes, fileCodes), ['worksheet 1 mm', 'worksheet 2 mm']);
    assert.deepEqual(stepMissing({ stepType: 'worksheet', files: [F('worksheet', '07'), F('worksheet', '07', 'P02'), F('worksheet', '10')] }, ['07', '10'], stepTypes, fileCodes), ['worksheet 1 mm page P02']);
    assert.deepEqual(stepMissing({ stepType: 'worksheet', files: [F('worksheet', null)] }, ['07', '10'], stepTypes, fileCodes), []);
    assert.deepEqual(stepMissing({ stepType: 'istinsakh', files: [] }, ['07'], stepTypes, fileCodes), []);
    assert.deepEqual(stepMissing({ stepType: 'assessment', files: [F('worksheet', '07')] }, ['07'], stepTypes, fileCodes), ['assessment sheet 0.7 mm']);
    assert.deepEqual(stepMissing({ stepType: 'worksheet', files: [F('worksheet', '07', 'P01', false)] }, [], stepTypes, fileCodes), ['worksheet']);
  });
  test('health finds the owner\'s list of problems', () => {
    const issues = computeHealth({
      code: 'FNK-C101', status: 'published', courseType: 'certification', branchIds: [], mistarSizes: ['07', '10'], structureVersion: 2,
      levels: [
        L('l1', 'LV01', [S('a', 'S01', 'worksheet', [F('worksheet', '07')]), S('b', 'S02', 'assessment', [])]),
        L('l2', 'LV02', [S('c', 'S01', 'mystery', [])]),
        L('l3', 'LV03', [S('d', 'S01', 'worksheet', [F('worksheet', '07'), F('worksheet', '10')])]),
      ],
    }, stepTypes, courseTypes, fileCodes);
    const text = issues.map(i => `${i.severity}: ${i.message}`).join('\n');
    assert.match(text, /No branch chosen/);
    assert.match(text, /error: LV01 S01 'Task' is missing: worksheet 1 mm/);
    assert.match(text, /S02 'Task' is a level assessment but has no assessment sheet/);
    assert.match(text, /type "mystery" which has no logic set/);
    assert.match(text, /LV03 \(d\) has no assessment step/);
  });
  test('published course with zero published steps; crash course without final submission', () => {
    const a = computeHealth({ code: 'X-A100', status: 'published', courseType: 'crash', branchIds: ['b'], mistarSizes: ['10'], structureVersion: 2,
      levels: [L('l1', 'LV01', [S('a', 'S01', 'worksheet', [F('worksheet', '10')], { status: 'hidden' })])] }, stepTypes, courseTypes, fileCodes);
    assert.ok(a.some(i => i.severity === 'error' && /no published steps/.test(i.message)));
    assert.ok(a.some(i => /Final submission/.test(i.message)));
  });
});

// ---------------------------------------------------------------- student view
describe('student view: visibility, size, unlocking, progress', () => {
  const lv1 = L('l1', 'LV01', [
    S('w1', 'S01', 'worksheet', [F('worksheet', '07'), F('worksheet', '10'), F('video', null)]),
    S('w2', 'S02', 'worksheet', [F('video', null)]),            // no worksheet yet → hidden
    S('a1', 'S03', 'assessment', [F('assessment_sheet', '07')]),
  ]);
  const lv2 = L('l2', 'LV02', [S('k1', 'S01', 'kitabat', [F('worksheet', '07')]), S('h', 'S02', 'worksheet', [F('worksheet', '07')], { status: 'hidden' })]);
  const lv3 = L('l3', 'LV03', [S('i1', 'S01', 'istinsakh', [])]);
  const hidden = L('l4', 'LV04', [S('x', 'S01', 'worksheet', [F('worksheet', '07')])], { status: 'hidden' });

  test('hidden levels/steps and file-less download steps are removed; upload steps stay', () => {
    const v = studentLevels([lv1, lv2, lv3, hidden], stepTypes, '10', true);
    assert.deepEqual(v.map(l => l.id), ['l1', 'l2', 'l3']);
    assert.deepEqual(v[0].steps.map(s => s.id), ['w1', 'a1']);
    assert.deepEqual(v[1].steps.map(s => s.id), ['k1']);
    assert.deepEqual(v[2].steps.map(s => s.id), ['i1']);
    assert.deepEqual(v[0].steps[0].files.map(f => f.sizeCode).sort(), ['10', null].sort());
    // assessment sheet only in 0.7 mm → student with 1 mm still gets it (never stuck)
    assert.deepEqual(v[0].steps[1].files.map(f => f.sizeCode), ['07']);
  });
  test('size filter off when choose_one_size is false', () => {
    assert.equal(filterFilesForSize([F('worksheet', '07'), F('worksheet', '10')], '10', false).length, 2);
  });
  test('unlocking: next level opens after the gating step passes; levels without gating open immediately', () => {
    const levels = studentLevels([lv1, lv2, lv3], stepTypes, null, true);
    assert.deepEqual(computeUnlockedLevelIds(levels, stepTypes, new Set()), ['l1']);
    assert.deepEqual(computeUnlockedLevelIds(levels, stepTypes, new Set(['a1'])), ['l1', 'l2', 'l3']);
  });
  test('revision does not unlock; passed does', () => {
    const subs = [
      { stepId: 'a1', attemptNo: 1, status: 'revision' as const, mark: 4, band: 'revision' as const, createdAt: '2026-11-01' },
    ];
    assert.equal(passedStepIdsFrom(subs).has('a1'), false);
    subs.push({ stepId: 'a1', attemptNo: 2, status: 'passed' as never, mark: 7, band: 'pass' as never, createdAt: '2026-11-03' });
    assert.equal(passedStepIdsFrom(subs).has('a1'), true);
  });
  test('step states + progress (done or passed steps / visible steps)', () => {
    const levels = studentLevels([lv1, lv2, lv3], stepTypes, null, true);
    const steps = levels.flatMap(l => l.steps);
    const states = buildStepStates(steps, stepTypes, new Set(['w1', 'k1', 'a1']), [
      { stepId: 'a1', attemptNo: 1, status: 'revision', mark: 5, band: 'revision', createdAt: '2026-11-01' },
      { stepId: 'a1', attemptNo: 2, status: 'in_review', mark: null, band: null, createdAt: '2026-11-02' },
      { stepId: 'i1', attemptNo: 1, status: 'reviewed', mark: null, band: null, createdAt: '2026-11-02' },
    ], new Map([['i1', 2]]));
    assert.equal(states.w1.done, true);
    assert.equal(states.a1.done, false, 'step_progress does not complete an upload step');
    assert.equal(states.a1.submissionStatus, 'in_review');
    assert.equal(states.a1.attemptsUsed, 2);
    assert.equal(states.i1.done, true);
    assert.equal(states.i1.unreadMessages, 2);
    assert.equal(computeProgressPercent(steps.map(s => s.id), states), 75); // w1, k1, i1 of 4
    assert.equal(computeProgressPercent([], states), 0);
  });
  test('my size + course visibility by branch and status', () => {
    assert.equal(chooseMySize('10', ['07', '10']), '10');
    assert.equal(chooseMySize('30', ['07', '10']), null);
    assert.equal(chooseMySize(null, ['NP']), 'NP');
    assert.equal(studentCanSeeCourse({ status: 'published', branchIds: [], structureVersion: 2 }, 'b1', false), true);
    assert.equal(studentCanSeeCourse({ status: 'published', branchIds: ['b2'], structureVersion: 2 }, 'b1', false), false);
    assert.equal(studentCanSeeCourse({ status: 'held', branchIds: [], structureVersion: 2 }, 'b1', false), false);
    assert.equal(studentCanSeeCourse({ status: 'held', branchIds: [], structureVersion: 2 }, 'b1', true), true);
    assert.equal(studentCanSeeCourse({ status: 'draft', branchIds: [], structureVersion: 2 }, 'b1', true), false);
    assert.equal(studentCanSeeCourse({ status: 'hidden', branchIds: [], structureVersion: 2 }, 'b1', true), false);
  });
});

// ---------------------------------------------------------------- misc
describe('policies, migration splitter, drive links', () => {
  test('policy validation', () => {
    assert.equal(validatePolicyValue('assessment.bands', { revisionMax: 5, passMax: 8 }), null);
    assert.match(validatePolicyValue('assessment.bands', { revisionMax: 8, passMax: 5 }) ?? '', /lower/);
    assert.equal(validatePolicyValue('review.quick_marks', [4, 5, 10]), null);
    assert.ok(validatePolicyValue('review.quick_marks', [0, 11]));
    assert.ok(validatePolicyValue('email.staff_mode', 'weekly'));
    assert.ok(validatePolicyValue('nope.key', 1));
    assert.equal(validatePolicyValue('merit.officer_user_id', null), null);
    assert.ok(validatePolicyValue('print.allow_multi', 'yes'));
  });
  test('SQL splitter keeps ; inside quotes and drops comments', () => {
    const parts = splitSql("-- c; c\nCREATE TABLE a (x int);\nINSERT INTO a VALUES ('1;2', 'it''s');\n-- end");
    assert.equal(parts.length, 2);
    assert.match(parts[1], /'1;2', 'it''s'/);
  });
  test('Drive ids from links', () => {
    assert.equal(driveIdFromUrl('https://drive.google.com/drive/folders/1AbCdEfGhIjK_lm-n?usp=sharing'), '1AbCdEfGhIjK_lm-n');
    assert.equal(driveIdFromUrl('https://drive.google.com/open?id=1AbCdEfGhIjKlmn'), '1AbCdEfGhIjKlmn');
    assert.equal(driveIdFromUrl('https://example.com/folders/1AbCdEfGhIjKlmn'), null);
  });
});
