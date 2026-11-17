/**
 * Naming convention for course files (pure — no database, no I/O).
 *
 *   CODE_TYPE_LVxx_Sxx_Pxx_SIZE_vN.ext     FNK-C101_MT_LV01_S01_P01_07_v1.jpg
 *   CODE_VD_LVxx_Sxx_vN.mp4                FNK-C101_VD_LV01_S01_v1.mp4
 *   CODE_HF_LVxx_Sxx_NN_slug_SIZE.png      FNK-C101_HF_LV01_S01_01_alif_07.png  (NN → page P01, slug kept)
 *   CODE_TYPE_Sxx_Pxx_SIZE_vN.ext          steps-only courses (level = LV01)
 *
 * Tolerant on purpose: any case, spaces, '-' or '_' between parts, '1 mm' / '0.7mm' sizes,
 * 'v02' / 'V2', missing version (→ v1), missing page (→ P01), "(1)" copy suffixes.
 *
 * frontend-admin copies this file to khat-frontend/src/v2/admin/naming.ts for live preview,
 * so keep it dependency-free (only the contract type import).
 */
import type { ParsedFileName } from '../contracts.js';

export const SIZE_CODES = ['07', '10', '20', '30', 'NP'] as const;
export type SizeCode = (typeof SIZE_CODES)[number];

export const SIZE_LABELS: Record<string, string> = {
  '07': '0.7 mm',
  '10': '1 mm',
  '20': '2 mm',
  '30': '3 mm',
  NP: 'Normal pen',
};

export const ALLOWED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'pdf', 'mp4', 'mov', 'm4v', 'webm'] as const;

export const COURSE_CODE_RE = /^[A-Z]{2,5}-[A-Z]\d{3}$/;

export const NAMING_EXAMPLE = 'FNK-C101_MT_LV01_S01_P01_07_v1.jpg';

export type ParseResult =
  | { ok: true; parsed: ParsedFileName; canonicalName: string; notes: string[] }
  | { ok: false; error: string };

export function sizeLabel(code: string | null | undefined): string {
  if (!code) return 'any size';
  return SIZE_LABELS[code] ?? code;
}

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
export function levelCode(n: number): string { return `LV${pad2(n)}`; }
export function stepCode(n: number): string { return `S${pad2(n)}`; }
export function pageCode(n: number): string { return `P${pad2(n)}`; }

/** 'lv1' / 'LV 01' / 'Level 3' → 'LV03'; null when not a level code. */
export function normaliseLevelCode(input: string | null | undefined): string | null {
  if (!input) return null;
  const m = String(input).trim().toUpperCase().replace(/[\s_-]+/g, '').match(/^(?:LEVEL|LV|L)0*(\d{1,3})$/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 ? levelCode(n) : null;
}
/** 's1' / 'S 01' / 'Step 3' → 'S03'; null when not a step code. */
export function normaliseStepCode(input: string | null | undefined): string | null {
  if (!input) return null;
  const m = String(input).trim().toUpperCase().replace(/[\s_-]+/g, '').match(/^(?:STEP|S)0*(\d{1,3})$/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 ? stepCode(n) : null;
}
/** 'fnk c101' / 'FNK_C101' / 'fnkc101' → 'FNK-C101'; null when not a course code. */
export function normaliseCourseCode(input: string | null | undefined): string | null {
  if (!input) return null;
  const m = String(input).trim().toUpperCase().match(/^([A-Z]{2,5})[\s_\-–]*([A-Z]\d{3})$/);
  return m ? `${m[1]}-${m[2]}` : null;
}

/** One size word → size code. Accepts '07', '0.7', '0.7mm', '1', '1 mm', '10', '2mm', 'NP', 'normal pen'. */
export function sizeFromText(input: string): SizeCode | null {
  const t = input.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!t) return null;
  if (/normal|^np$|everyday|ball ?point|^pen$/.test(t)) return 'NP';
  const m = t.match(/^(\d+(?:[.,]\d+)?)\s*(mm|millimet(?:er|re)s?)?$/);
  if (!m) return null;
  const raw = m[1].replace(',', '.');
  const hasUnit = Boolean(m[2]);
  if (raw === '07' || raw === '0.7' || raw === '.7') return '07';
  if (raw === '10' && !hasUnit) return '10';
  if (raw === '20' && !hasUnit) return '20';
  if (raw === '30' && !hasUnit) return '30';
  const value = Number(raw);
  if (value === 1) return '10';
  if (value === 2) return '20';
  if (value === 3) return '30';
  return null;
}

/** "0.7 mm, 1 mm, 2 mm" → ['07','10','20'];  "Normal Pen" → ['NP'];  unknown pieces are ignored. */
export function parseMistarSizes(text: string | null | undefined): string[] {
  if (!text) return [];
  const pieces = String(text)
    .split(/[,;/|\n&+]|\band\b/i)
    .map(p => p.trim())
    .filter(Boolean);
  const found = new Set<string>();
  for (const piece of pieces) {
    const direct = sizeFromText(piece);
    if (direct) { found.add(direct); continue; }
    // "0.7 1 2 mm" style: try each number in the piece
    for (const n of piece.match(/\d+(?:[.,]\d+)?/g) ?? []) {
      const s = sizeFromText(n);
      if (s) found.add(s);
    }
    if (/normal/i.test(piece)) found.add('NP');
  }
  return SIZE_CODES.filter(s => found.has(s));
}

export function sizesToText(codes: string[]): string {
  return codes.map(c => sizeLabel(c)).join(', ');
}

type Tok =
  | { kind: 'level'; n: number; raw: string }
  | { kind: 'step'; n: number; raw: string }
  | { kind: 'page'; n: number; raw: string }
  | { kind: 'size'; code: SizeCode; raw: string }
  | { kind: 'version'; n: number; raw: string }
  | { kind: 'number'; n: number; text: string; raw: string }
  | { kind: 'word'; raw: string };

function classify(raw: string): Tok {
  const t = raw.toUpperCase();
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^(?:LEVEL|LV|L)0*(\d{1,3})$/))) return { kind: 'level', n: Number(m[1]), raw };
  if ((m = t.match(/^(?:STEP|S)0*(\d{1,3})$/))) return { kind: 'step', n: Number(m[1]), raw };
  if ((m = t.match(/^(?:PAGE|PG|P)0*(\d{1,3})$/))) return { kind: 'page', n: Number(m[1]), raw };
  if ((m = t.match(/^(?:VER|V)0*(\d{1,3})$/))) return { kind: 'version', n: Number(m[1]), raw };
  if (t === 'NP') return { kind: 'size', code: 'NP', raw };
  if ((m = t.match(/^(\d+(?:\.\d+)?)MM$/))) {
    const code = sizeFromText(`${m[1]} mm`);
    if (code) return { kind: 'size', code, raw };
  }
  if (/^0\.7$/.test(t)) return { kind: 'size', code: '07', raw };
  if ((m = t.match(/^\d{1,3}$/))) return { kind: 'number', n: Number(t), text: t, raw };
  return { kind: 'word', raw };
}

/** Joins split pieces such as 'LV' '01' → 'LV01', '1' 'mm' → '1mm', 'v' '2' → 'v2'. */
function mergeSplitTokens(parts: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const cur = parts[i];
    const next = parts[i + 1];
    const up = cur.toUpperCase();
    if (next !== undefined && /^\d{1,3}$/.test(next) && /^(LV|L|LEVEL|S|STEP|P|PG|PAGE|V|VER)$/.test(up)) {
      out.push(cur + next); i++; continue;
    }
    if (next !== undefined && /^\d+(\.\d+)?$/.test(cur) && /^mm$/i.test(next)) {
      out.push(cur + next); i++; continue;
    }
    if (next !== undefined && /^normal$/i.test(cur) && /^pen$/i.test(next)) {
      out.push('NP'); i++; continue;
    }
    out.push(cur);
  }
  return out;
}

/** Canonical (stored) name for a parsed file name. */
export function canonicalName(p: ParsedFileName): string {
  const parts: string[] = [p.courseCode, p.fileCode];
  if (p.level) parts.push(p.level);
  parts.push(p.step);
  if (p.fileCode === 'HF') {
    parts.push(p.page.replace(/^P/, ''));
    if (p.slug) parts.push(p.slug);
    if (p.sizeCode) parts.push(p.sizeCode);
    if (p.version > 1) parts.push(`v${p.version}`);
  } else {
    const pageless = (p.fileCode === 'VD' || p.fileCode === 'RF') && p.page === 'P01';
    if (!pageless) parts.push(p.page);
    if (p.sizeCode) parts.push(p.sizeCode);
    parts.push(`v${p.version}`);
  }
  return `${parts.join('_')}.${p.ext}`;
}

/**
 * Parses a course file name. Never throws. `knownFileCodes` (optional) makes the
 * error message friendlier when the TYPE part is not a known code.
 */
export function parseFileName(filename: string, knownFileCodes?: string[]): ParseResult {
  const notes: string[] = [];
  if (typeof filename !== 'string' || !filename.trim()) return { ok: false, error: 'The file has no name.' };
  // Drop any folder path the browser or Drive may include.
  let name = filename.trim().split(/[\\/]/).pop() ?? '';
  name = name.normalize('NFKC').replace(/[​-‏‪-‮⁦-⁩﻿]/g, '');
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) {
    return { ok: false, error: `"${name}" has no file type at the end (for example .jpg, .png, .pdf or .mp4).` };
  }
  let ext = name.slice(dot + 1).trim().toLowerCase();
  let base = name.slice(0, dot);
  if (!(ALLOWED_EXTENSIONS as readonly string[]).includes(ext)) {
    return { ok: false, error: `.${ext} files are not accepted. Use .jpg, .png, .pdf, .mp4 or .mov.` };
  }
  if (ext === 'jpeg') ext = 'jpg';
  // "name (1)" / "name copy" / "Copy of name" from downloads and Drive copies
  base = base.replace(/\s*\(\d+\)\s*$/, '').replace(/[\s_-]+copy(\s*\d+)?\s*$/i, '').replace(/^copy of\s+/i, '').trim();
  // Course code at the start, tolerant of separators inside it.
  const codeMatch = base.toUpperCase().match(/^\s*([A-Z]{2,5})[\s_\-–]*([A-Z]\d{3})(?=$|[\s_\-–])/);
  if (!codeMatch) {
    return { ok: false, error: `"${name}" does not start with a course code like FNK-C101. Expected a name like ${NAMING_EXAMPLE}.` };
  }
  const courseCode = `${codeMatch[1]}-${codeMatch[2]}`;
  const rest = base.slice(codeMatch[0].length);
  // '.' inside the base also separates parts, except inside a size like '0.7' / '0.7mm'.
  const rejoined: string[] = [];
  for (const part of rest.split(/[\s_\-–]+/).filter(Boolean)) {
    if (/^\d+\.\d+(mm)?$/i.test(part)) rejoined.push(part);
    else rejoined.push(...part.split('.').filter(Boolean));
  }
  const parts = mergeSplitTokens(rejoined);
  if (parts.length === 0) {
    return { ok: false, error: `"${name}" has the course code but nothing after it. Expected a name like ${NAMING_EXAMPLE}.` };
  }
  const fileCode = parts[0].toUpperCase();
  if (!/^[A-Z]{2,3}$/.test(fileCode)) {
    return { ok: false, error: `After the course code, "${name}" should have a file type code like MT, KT, RH, AW or VD (found "${parts[0]}").` };
  }
  if (knownFileCodes && knownFileCodes.length && !knownFileCodes.map(c => c.toUpperCase()).includes(fileCode)) {
    return { ok: false, error: `"${fileCode}" is not a known file type code. Known codes: ${knownFileCodes.join(', ')}.` };
  }

  const toks = parts.slice(1).map(classify);
  let level: number | null = null;
  let step: number | null = null;
  let page: number | null = null;
  let size: SizeCode | null = null;
  let version: number | null = null;
  const numbers: Extract<Tok, { kind: 'number' }>[] = [];
  const words: string[] = [];
  const dup = (what: string) => ({ ok: false as const, error: `"${name}" has more than one ${what}. Check the name.` });

  for (const tok of toks) {
    switch (tok.kind) {
      case 'level': if (level !== null) return dup('level (LV..)'); level = tok.n; break;
      case 'step': if (step !== null) return dup('step (S..)'); step = tok.n; break;
      case 'page': if (page !== null) return dup('page (P..)'); page = tok.n; break;
      case 'version': if (version !== null) return dup('version (v..)'); version = tok.n; break;
      case 'size': if (size !== null) return dup('mistar size'); size = tok.code; break;
      case 'number': numbers.push(tok); break;
      case 'word': words.push(tok.raw); break;
    }
  }
  if (step === null) {
    return { ok: false, error: `"${name}" has no step number (like S01). Expected a name like ${NAMING_EXAMPLE}.` };
  }
  if (step < 1) return { ok: false, error: `"${name}": step numbers start at S01.` };
  if (level !== null && level < 1) return { ok: false, error: `"${name}": level numbers start at LV01.` };

  // Bare numbers: harf page number first (HF), then size, then page.
  const isHarf = fileCode === 'HF';
  for (let i = 0; i < numbers.length; i++) {
    const tok = numbers[i];
    if (isHarf && page === null && i === 0) { page = tok.n; continue; }
    const asSize = tok.text.length === 2 ? sizeFromText(tok.text) : null;
    if (asSize && size === null) { size = asSize; continue; }
    if (page === null) { page = tok.n; continue; }
    return { ok: false, error: `"${name}": could not understand the number "${tok.raw}". Sizes are 07, 10, 20, 30 or NP.` };
  }

  let slug: string | null = null;
  if (words.length) {
    if (isHarf) {
      slug = words.join('-').toLowerCase();
    } else {
      return {
        ok: false,
        error: `"${name}": could not understand "${words.join('_')}". Expected a name like ${NAMING_EXAMPLE}.`,
      };
    }
  }
  if (page !== null && page < 1) return { ok: false, error: `"${name}": page numbers start at P01.` };
  if (version !== null && version < 1) return { ok: false, error: `"${name}": versions start at v1.` };

  if (version === null) notes.push('No version in the name — treated as v1.');
  if (fileCode === 'VD' && size) notes.push('Videos do not need a mistar size — the size was ignored.');
  if (level === null) notes.push('No level in the name — the file goes to LV01.');

  const parsed: ParsedFileName = {
    courseCode,
    fileCode,
    level: level === null ? null : levelCode(level),
    step: stepCode(step),
    page: pageCode(page ?? 1),
    sizeCode: fileCode === 'VD' ? null : size,
    version: version ?? 1,
    ext,
    slug,
  };
  return { ok: true, parsed, canonicalName: canonicalName(parsed), notes };
}

/** Content type guess from extension (for Drive files without a mime type). */
export function contentTypeForExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'png': return 'image/png';
    case 'webp': return 'image/webp';
    case 'pdf': return 'application/pdf';
    case 'mp4': case 'm4v': return 'video/mp4';
    case 'mov': return 'video/quicktime';
    case 'webm': return 'video/webm';
    default: return 'application/octet-stream';
  }
}
