// owner: teacher (v3) — a unique sheet ID on every stamped PDF, so a printed sheet can always be traced
// back to the student (and submission / worksheet) it was made for. Table: sheet_ids
// (migration scripts/migrations/2026-11-14-v3-teacher.sql).
//   student downloads → kind 'student_download' (+ step_file_id)
//   teacher print pack / bulk download → kind 'print_pack' (+ submission_id)
import { randomBytes } from 'node:crypto';
import { pool } from '../../db.js';

export type SheetKind = 'student_download' | 'print_pack';

/** Crockford base32 (no I, L, O, U) — easy to read aloud and to type from paper. */
export const SHEET_ID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const SHEET_ID_RE = /^FQ-[0-9A-HJKMNP-TV-Z]{6}$/;

export function generateSheetId(random: (n: number) => Uint8Array = n => randomBytes(n)): string {
  const bytes = random(6);
  let out = 'FQ-';
  for (let i = 0; i < 6; i++) out += SHEET_ID_ALPHABET[bytes[i] % 32];
  return out;
}

/** 'fq-7k3m2a', 'FQ 7K3M2A', 'FQ7K3M2A' → 'FQ-7K3M2A' (O→0, I/L→1). Null when it is not a sheet ID. */
export function normalizeSheetId(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim().toUpperCase().replace(/[\s_]+/g, '');
  const m = raw.match(/^FQ-?([0-9A-Z]{6})$/);
  if (!m) return null;
  const body = m[1].replace(/O/g, '0').replace(/[IL]/g, '1');
  const id = `FQ-${body}`;
  return SHEET_ID_RE.test(id) ? id : null;
}

export type SheetIdInput = {
  kind: SheetKind;
  studentId: string;
  submissionId?: string | null;
  stepFileId?: string | null;
  printCode?: string | null;
  createdBy?: string | null;
};

/**
 * Registers a new sheet ID and returns it. Best effort: a download must never fail because of
 * the sheet register (returns null when the table is missing or the database refuses).
 */
export async function registerSheetId(input: SheetIdInput): Promise<string | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = generateSheetId();
    try {
      await pool.query(
        `INSERT INTO sheet_ids (sheet_id, kind, student_id, submission_id, step_file_id, print_code, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, input.kind, input.studentId, input.submissionId ?? null, input.stepFileId ?? null, input.printCode ?? null, input.createdBy ?? null],
      );
      return id;
    } catch (error) {
      const code = (error as { code?: string; errno?: number })?.code;
      if (code === 'ER_DUP_ENTRY' || code === '23505') continue; // clash — try another
      console.error('[v3 sheet ids] could not register a sheet id', error);
      return null;
    }
  }
  return null;
}

export type SheetIdRow = { sheetId: string; kind: SheetKind; studentId: string; submissionId: string | null; stepFileId: string | null; printCode: string | null; createdAt: string };

export async function lookupSheetId(sheetId: string): Promise<SheetIdRow | null> {
  const id = normalizeSheetId(sheetId);
  if (!id) return null;
  try {
    const { rows } = await pool.query(
      `SELECT sheet_id, kind, student_id, submission_id, step_file_id, print_code, created_at FROM sheet_ids WHERE sheet_id = $1`,
      [id],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      sheetId: r.sheet_id, kind: r.kind, studentId: r.student_id, submissionId: r.submission_id ?? null,
      stepFileId: r.step_file_id ?? null, printCode: r.print_code ?? null,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    };
  } catch {
    return null;
  }
}
