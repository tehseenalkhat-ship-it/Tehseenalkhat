/**
 * CSV + Google Sheet helpers for the Master Course List and the *_Tasks manifests (pure).
 */
import type { ImportAction, MasterImportRow } from '../contracts.js';
import { normaliseCourseCode, normaliseLevelCode, normaliseStepCode, parseMistarSizes, sizesToText } from './naming.js';

/** RFC 4180 CSV: quoted fields, "" escapes, commas/newlines inside quotes, CRLF, BOM. Blank lines dropped. */
export function parseCsv(text: string): string[][] {
  const src = String(text ?? '').replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const pushRow = () => {
    row.push(field);
    field = '';
    if (row.some(cell => cell.trim() !== '')) rows.push(row);
    row = [];
  };
  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && field.trim() === '') { field = ''; inQuotes = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { if (src[i + 1] === '\n') i++; pushRow(); i++; continue; }
    if (ch === '\n') { pushRow(); i++; continue; }
    field += ch; i++;
  }
  if (field !== '' || row.length) pushRow();
  return rows;
}

/** Normalised header key: lower case, single spaces, no punctuation. */
export function headerKey(h: string): string {
  return String(h ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * Turns a Google Sheet link into a CSV export link.
 *  - .../spreadsheets/d/<id>/edit#gid=123   → /export?format=csv&gid=123
 *  - no gid + preferredTab                  → /gviz/tq?tqx=out:csv&sheet=<tab>
 *  - already an export/gviz/published CSV link → returned unchanged
 * Returns null when it is not a Google Sheet link.
 */
export function sheetUrlToCsvUrl(url: string, preferredTab?: string): string | null {
  let u: URL;
  try { u = new URL(String(url).trim()); } catch { return null; }
  if (!/(^|\.)docs\.google\.com$/.test(u.hostname)) return null;
  if (/\/export$/.test(u.pathname) && u.searchParams.get('format') === 'csv') return u.toString();
  if (/\/gviz\/tq$/.test(u.pathname)) return u.toString();
  if (/\/pub$/.test(u.pathname) && u.searchParams.get('output') === 'csv') return u.toString();
  const m = u.pathname.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) return null;
  const id = m[1];
  const gid = (u.hash.match(/gid=(\d+)/) ?? u.search.match(/gid=(\d+)/))?.[1];
  if (gid) return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
  if (preferredTab) return `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(preferredTab)}`;
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv`;
}

/** Finds the header row (first row that has all `required` headers) and returns objects keyed by headerKey. */
export function tableFromCsv(rows: string[][], required: string[]): { headers: string[]; records: { raw: Record<string, string>; byKey: Record<string, string>; rowNumber: number }[] } | null {
  const req = required.map(headerKey);
  const headerIndex = rows.findIndex(r => {
    const keys = r.map(headerKey);
    return req.every(k => keys.some(h => h === k || h.startsWith(k)));
  });
  if (headerIndex < 0) return null;
  const headers = rows[headerIndex].map(h => String(h ?? '').trim());
  const keys = headers.map(headerKey);
  const records = rows.slice(headerIndex + 1).map((r, idx) => {
    const raw: Record<string, string> = {};
    const byKey: Record<string, string> = {};
    keys.forEach((k, i) => {
      const v = String(r[i] ?? '').trim();
      if (headers[i]) raw[headers[i]] = v;
      if (k && byKey[k] === undefined) byKey[k] = v;
    });
    return { raw, byKey, rowNumber: headerIndex + idx + 2 };
  });
  return { headers, records };
}

/** Value of the first column whose key equals or starts with one of `names`. */
export function pick(byKey: Record<string, string>, names: string[]): string {
  for (const n of names.map(headerKey)) {
    if (byKey[n] !== undefined && byKey[n] !== '') return byKey[n];
  }
  for (const n of names.map(headerKey)) {
    const k = Object.keys(byKey).find(key => key.startsWith(n) && byKey[key] !== '');
    if (k) return byKey[k];
  }
  return '';
}

const ARABIC_RE = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
const LATIN_RE = /[A-Za-z]/;

/** "Naskh Mufradaat / نسخ مفردات" → { title: 'Naskh Mufradaat', titleAr: 'نسخ مفردات' } */
export function splitTitle(name: string): { title: string; titleAr: string | null } {
  const s = String(name ?? '').trim();
  if (!ARABIC_RE.test(s) || !LATIN_RE.test(s)) return { title: s, titleAr: null };
  const parts = s.split(/\s*(?:\||\/|\n| - | – | — |\(|\))\s*/).map(p => p.trim()).filter(Boolean);
  const ar = parts.filter(p => ARABIC_RE.test(p) && !LATIN_RE.test(p));
  const en = parts.filter(p => LATIN_RE.test(p));
  if (ar.length && en.length) return { title: en.join(' - '), titleAr: ar.join(' ') };
  return { title: s, titleAr: null };
}

export function normalisePenType(text: string): string | undefined {
  const t = String(text ?? '').trim().toLowerCase();
  if (!t) return undefined;
  if (/normal|everyday|ball|marker|np\b/.test(t)) return 'normal';
  if (/cut|qalam|qalam|reed|nib/.test(t)) return 'cut';
  return t.replace(/\s+/g, '_');
}

export function normaliseCourseType(text: string): string | undefined {
  const t = String(text ?? '').trim().toLowerCase();
  if (!t) return undefined;
  // v3 (6.11): "Mashq worksheets (crash)" or "worksheets only" are Mashq — check Mashq before Crash.
  if (/mashq|mashk|worksheets?\b/.test(t)) return 'mashq';
  if (/certif/.test(t)) return 'certification';
  if (/crash/.test(t)) return 'crash';
  return t.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/** Course type from the master file. The Urs course (al-Urs al-Mi'awi) is always Mashq worksheets (owner, 6.11). */
export function masterCourseType(typeText: string, name: string, code: string): string | undefined {
  if (/\burs\b|العرس|عرس/i.test(`${name} ${code.replace(/-.*/, '')}`) || /^URS-/i.test(code.trim())) return 'mashq';
  return normaliseCourseType(typeText);
}

/** "All" / "" → [] (all branches);  "Nairobi, Surat & Karachi" → ['Nairobi','Surat','Karachi'] */
export function parseBranchList(text: string): string[] {
  const t = String(text ?? '').trim();
  if (!t || /^(all|all branches|every branch|everyone|-)$/i.test(t)) return [];
  return t.split(/[,;/|\n&+]|\band\b/i).map(s => s.trim()).filter(Boolean);
}

export type MasterSheetRow = {
  rowNumber: number;
  courseCode: string | null;
  rawCode: string;
  fields: MasterImportRow['fields'];
  masterRow: Record<string, string>;
};

/** Reads the "Courses" tab of the Master Course List. Throws a friendly Error when the header is missing. */
export function readMasterSheet(csvText: string): MasterSheetRow[] {
  const table = tableFromCsv(parseCsv(csvText), ['course code']);
  if (!table) {
    throw new Error('Could not find a "Course Code" column. Please use the "Courses" tab of the Master Course List (columns: Pen Type, Course Type, Course Name, Course Code, …).');
  }
  const keys = table.headers.map(headerKey);
  const hasColumn = (names: string[]) => names.map(headerKey).some(n => keys.some(k => k === n || k.startsWith(n)));
  const hasBranchColumn = hasColumn(['branches', 'branch']);
  const out: MasterSheetRow[] = [];
  for (const rec of table.records) {
    const rawCode = pick(rec.byKey, ['course code', 'code']);
    const name = pick(rec.byKey, ['course name', 'name', 'title']);
    if (!rawCode && !name) continue;
    const arabicCol = pick(rec.byKey, ['course name arabic', 'arabic name', 'arabic', 'name arabic', 'title arabic']);
    const split = splitTitle(name);
    const sizesText = pick(rec.byKey, ['mistar sizes', 'mistar size', 'mistar', 'sizes', 'size']);
    const fields: MasterImportRow['fields'] = {
      title: split.title,
      titleAr: (arabicCol || split.titleAr || undefined) ?? undefined,
      penType: normalisePenType(pick(rec.byKey, ['pen type', 'pen'])),
      courseType: masterCourseType(pick(rec.byKey, ['course type', 'type']), name, rawCode),
      description: pick(rec.byKey, ['description', 'details']) || undefined,
      // No Branch column at all → leave branches alone; an empty / "All" cell → all branches.
      branches: hasBranchColumn ? parseBranchList(pick(rec.byKey, ['branches', 'branch'])) : undefined,
      mistarSizes: sizesText ? parseMistarSizes(sizesText) : undefined,
      // Only a real link counts: a sheet link shown as "Open folder" reaches us as just those words.
      driveFolderUrl: Object.entries(rec.byKey).find(([k, v]) => /^(drive|folder)/.test(k) && /^https?:\/\//.test(v.trim()))?.[1].trim(),
    };
    for (const k of Object.keys(fields) as (keyof typeof fields)[]) if (fields[k] === undefined) delete fields[k];
    out.push({ rowNumber: rec.rowNumber, courseCode: normaliseCourseCode(rawCode), rawCode, fields, masterRow: rec.raw });
  }
  return out;
}

export type ExistingCourseForCompare = {
  id: string;
  code: string;
  title: string;
  titleAr: string | null;
  penType: string | null;
  courseType: string | null;
  description: string | null;
  branchNames: string[];
  mistarSizes: string[];
  driveFolderUrl: string | null;
};

function sameList(a: string[], b: string[]): boolean {
  const x = [...a].map(s => s.toLowerCase()).sort();
  const y = [...b].map(s => s.toLowerCase()).sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** Compares sheet rows with existing courses → preview rows (create/update/same/error) with plain change lines. */
export function compareMasterRows(sheet: MasterSheetRow[], existing: ExistingCourseForCompare[], knownBranchNames: string[]): MasterImportRow[] {
  const byCode = new Map(existing.map(c => [c.code.toUpperCase(), c]));
  const seen = new Set<string>();
  const out: MasterImportRow[] = [];
  for (const row of sheet) {
    if (!row.courseCode) {
      out.push({
        courseCode: row.rawCode || '(no code)',
        action: 'error',
        fields: row.fields,
        changes: [],
        message: row.rawCode
          ? `Row ${row.rowNumber}: "${row.rawCode}" is not a course code like FNK-C101.`
          : `Row ${row.rowNumber}: "${row.fields.title}" has no course code yet — it will be skipped.`,
      });
      continue;
    }
    if (seen.has(row.courseCode)) {
      out.push({ courseCode: row.courseCode, action: 'error', fields: row.fields, changes: [], message: `Row ${row.rowNumber}: ${row.courseCode} appears twice in the sheet — only the first row is used.` });
      continue;
    }
    seen.add(row.courseCode);
    if (!row.fields.title) {
      out.push({ courseCode: row.courseCode, action: 'error', fields: row.fields, changes: [], message: `Row ${row.rowNumber}: ${row.courseCode} has no Course Name.` });
      continue;
    }
    const unknownBranches = (row.fields.branches ?? []).filter(b => !matchBranchName(b, knownBranchNames));
    const branchNote = unknownBranches.length ? `Unknown branch name(s): ${unknownBranches.join(', ')} — they will be ignored.` : undefined;
    const cur = byCode.get(row.courseCode);
    if (!cur) {
      out.push({ courseCode: row.courseCode, action: 'create', fields: row.fields, changes: [`New course "${row.fields.title}" (will start as a draft)`], message: branchNote });
      continue;
    }
    const changes: string[] = [];
    const f = row.fields;
    const diff = (label: string, before: string | null | undefined, after: string | undefined) => {
      if (after === undefined) return;
      if ((before ?? '').trim() !== after.trim()) changes.push(`${label}: "${before ?? ''}" → "${after}"`);
    };
    diff('Course name', cur.title, f.title);
    diff('Arabic name', cur.titleAr, f.titleAr);
    diff('Pen type', cur.penType, f.penType);
    diff('Course type', cur.courseType, f.courseType);
    diff('Description', cur.description, f.description);
    diff('Drive folder', cur.driveFolderUrl, f.driveFolderUrl);
    if (f.mistarSizes && f.mistarSizes.length && !sameList(cur.mistarSizes, f.mistarSizes)) {
      changes.push(`Mistar sizes ${sizesToText(cur.mistarSizes) || '(none)'} → ${sizesToText(f.mistarSizes)}`);
    }
    const wantBranches = (f.branches ?? []).map(b => matchBranchName(b, knownBranchNames)).filter((b): b is string => Boolean(b));
    if (f.branches !== undefined && !sameList(cur.branchNames, wantBranches)) {
      changes.push(`Branches ${cur.branchNames.join(', ') || 'all'} → ${wantBranches.join(', ') || 'all'}`);
    }
    const action: ImportAction = changes.length ? 'update' : 'same';
    out.push({ courseCode: row.courseCode, action, fields: row.fields, changes, message: branchNote });
  }
  return out;
}

/** 'marol' → 'Marol / Mumbai' (case-insensitive exact, then prefix / contains). */
export function matchBranchName(input: string, names: string[]): string | null {
  const t = input.trim().toLowerCase();
  if (!t) return null;
  return names.find(n => n.toLowerCase() === t)
    ?? names.find(n => n.toLowerCase().startsWith(t))
    ?? names.find(n => n.toLowerCase().split(/[\s/,-]+/).includes(t))
    ?? names.find(n => t.startsWith(n.toLowerCase()))
    ?? null;
}

// ---------- khat type matching ----------
const KHAT_ALIASES: [RegExp, string][] = [
  [/thuluth|thulth|sulus|suls/i, 'sulus'],
  [/nasta.?l[ei]+q|nastaleeq|nastaliq|nastaaleeq/i, 'nastaaleeq'],
  [/in?stin?sa+kh/i, 'istinsaakh'],
  [/tehseen|tahseen|tahsin|tehsin/i, 'tehseen_al_khat'],
  [/naskh|naskhi/i, 'naskh'],
];

/** Best existing khat_types id for a course (by name + pen), or null. */
export function matchKhatType(title: string, penType: string | null | undefined, khatTypes: { id: string; code: string; displayName: string }[]): string | null {
  const text = `${title}`;
  let base: string | null = null;
  for (const [re, code] of KHAT_ALIASES) if (re.test(text)) { base = code; break; }
  if (!base) {
    const lower = text.toLowerCase();
    const hit = khatTypes.find(k => lower.includes(k.displayName.toLowerCase().replace(/\s*\(.*\)$/, '')));
    return hit?.id ?? null;
  }
  const normal = penType === 'normal';
  const preferred = normal ? `${base}_normal_pen` : base;
  return khatTypes.find(k => k.code === preferred)?.id ?? khatTypes.find(k => k.code === base)?.id ?? null;
}

export function slugify(text: string, max = 90): string {
  return String(text ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, max) || 'course';
}

// ---------- *_Tasks manifest ----------
export type ManifestSheetRow = {
  rowNumber: number;
  level: string | null;
  step: string | null;
  rawLevel: string;
  rawStep: string;
  description?: string;
  task: string;
  typeText: string;
  template?: string;
  maxMarks?: number | null;
  badgeCode?: string | null;
  message?: string;
  instructions?: string;
};

export function readManifestSheet(csvText: string): ManifestSheetRow[] {
  const table = tableFromCsv(parseCsv(csvText), ['step']);
  if (!table) throw new Error('Could not find a "Step" column. Please use the course\'s _Tasks sheet (columns: Level, Description, Step, Task, Type, …).');
  let lastLevel = '';
  let lastDescription = '';
  const out: ManifestSheetRow[] = [];
  for (const rec of table.records) {
    let rawLevel = pick(rec.byKey, ['level', 'lv']);
    const rawStep = pick(rec.byKey, ['step', 'step code']);
    let description = pick(rec.byKey, ['description', 'level description']);
    // Merged cells come through as blanks: carry the level + description down.
    if (!rawLevel && rawStep) { rawLevel = lastLevel; if (!description) description = lastDescription; }
    if (rawLevel !== lastLevel) lastDescription = '';
    lastLevel = rawLevel;
    if (description) lastDescription = description;
    if (!rawStep) continue;
    const marksText = pick(rec.byKey, ['max marks', 'marks', 'max mark']);
    const marks = marksText === '' ? undefined : Number(marksText);
    out.push({
      rowNumber: rec.rowNumber,
      level: normaliseLevelCode(rawLevel) ?? (rawLevel ? null : 'LV01'),
      step: normaliseStepCode(rawStep),
      rawLevel,
      rawStep,
      description: description || undefined,
      task: pick(rec.byKey, ['task', 'title', 'step name']),
      typeText: pick(rec.byKey, ['type', 'step type']),
      template: pick(rec.byKey, ['template']) || undefined,
      maxMarks: marks === undefined ? undefined : Number.isFinite(marks) ? Math.round(marks) : null,
      badgeCode: pick(rec.byKey, ['badge', 'badge code']) || undefined,
      message: pick(rec.byKey, ['message', 'note', 'message to students']) || undefined,
      instructions: pick(rec.byKey, ['instructions', 'level instructions']) || undefined,
    });
  }
  return out;
}

/** Manifest "Type" text → step type key ('Worksheet', 'MT', 'Level assessment', 'assessment' …). */
export function stepTypeFromText(text: string, stepTypes: { typeKey: string; label: string; fileCodes: string[] }[]): string | null {
  const t = String(text ?? '').trim().toLowerCase();
  if (!t) return null;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const nt = norm(t);
  return stepTypes.find(s => norm(s.typeKey) === nt)?.typeKey
    ?? stepTypes.find(s => norm(s.label) === nt)?.typeKey
    ?? stepTypes.find(s => s.fileCodes.some(c => c.toLowerCase() === t))?.typeKey
    ?? stepTypes.find(s => nt.includes(norm(s.typeKey)) || norm(s.label).includes(nt))?.typeKey
    ?? (/assess|test|exam/.test(t) ? stepTypes.find(s => s.typeKey === 'assessment')?.typeKey ?? null : null);
}
