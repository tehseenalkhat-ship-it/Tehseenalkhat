/**
 * backend-files pure helpers (no database, no storage) — unit tested in tests/v2/backend-files.test.ts.
 */
import type { Attachment, WatermarkSetting } from '../contracts.js';
import { ALL_STAMP_FIELDS, clampWatermark, type StampField } from './pdfStamp.js';

// ---------- Local response types (not in contracts.ts — see "Contract requests") ----------
export type CompetitionExcerpt = { id: string; text: string | null; imageStorageKey: string | null; note: string | null };
export type V2Competition = {
  id: string;
  kind: 'competition' | 'call';
  title: string;
  description: string | null;
  branchIds: string[] | null;          // null = all branches
  excerpts: CompetitionExcerpt[];
  coverStorageKey: string | null;
  startDate: string | null;
  endDate: string | null;
  status: string;                      // upcoming | open | closed | judging | completed | cancelled
  resultsPublishedAt: string | null;
  entryCount: number;
  myEntries: { id: string; imageStorageKey: string; submittedAt: string; selectionLabel: string | null; selectionRank: number | null }[];
  canManage: boolean;
};
export type V2CompetitionEntry = {
  id: string; studentId: string; studentName: string; trNumber: string | null; branchId: string | null; branchName: string | null;
  imageStorageKey: string; submittedAt: string; selectionLabel: string | null; selectionRank: number | null; publishedToGallery: boolean;
};
export type ShowcaseRequest = {
  id: string; studentId: string; studentName: string; trNumber: string | null; branchId: string | null; branchName: string | null;
  storageKey: string; caption: string | null; submissionId: string | null; source: string | null; status: string; createdAt: string;
};

// ---------- Pure helpers ----------
export const MAX_FILES_PER_PDF = 60;

/** Filename for Content-Disposition: ASCII fallback + RFC 5987 UTF-8 name. */
export function contentDisposition(filename: string, inline = false): string {
  const clean = filename.replace(/[\r\n"\\/]/g, '_').trim() || 'download.pdf';
  const ascii = clean.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}

/** 'FNK-C101_MT_LV01_S01_P01_07_v1.jpg' → 'FNK-C101_MT_LV01_S01_P01_07_v1.pdf' */
export function pdfName(name: string | null | undefined, fallback = 'worksheet'): string {
  const base = (name ?? '').trim().replace(/\.[A-Za-z0-9]{1,5}$/, '') || fallback;
  return `${base.replace(/[^\w.\-() ]+/g, '_').slice(0, 120)}.pdf`;
}

/** Bundle filename `CODE_LVxx_worksheets.pdf` (falls back gracefully when files span levels/courses). */
export function bundleName(items: { courseCode: string | null; levelCode: string | null }[]): string {
  const codes = new Set(items.map(i => i.courseCode ?? ''));
  const levels = new Set(items.map(i => i.levelCode ?? ''));
  const code = codes.size === 1 ? [...codes][0] : '';
  const level = codes.size === 1 && levels.size === 1 ? [...levels][0] : '';
  return [code, level, 'worksheets'].filter(Boolean).join('_') + '.pdf';
}

/** Unique, non-empty string ids in the order given. */
export function uniqueIds(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  for (const v of input) if (typeof v === 'string' && v.trim()) seen.add(v.trim());
  return [...seen];
}

export function tooManyMessage(count: number, what = 'files'): string {
  return `That is ${count} ${what} — please choose at most ${MAX_FILES_PER_PDF} at a time and print the rest as a second batch.`;
}

export function stampFieldsFrom(raw: unknown): StampField[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? safeJson(raw, []) : [];
  const out = (list as unknown[]).filter((f): f is StampField => typeof f === 'string' && (ALL_STAMP_FIELDS as string[]).includes(f));
  return out;
}

export function safeJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return value as T;
}

export function watermarkSettingFrom(raw: unknown): WatermarkSetting {
  const v = safeJson<Partial<WatermarkSetting>>(raw, {});
  const c = clampWatermark(v as never);
  return { storageKey: typeof v.storageKey === 'string' && v.storageKey ? v.storageKey : null, opacity: c.opacity, position: c.position, scale: c.scale };
}

export function guessContentType(key: string): string {
  const ext = key.toLowerCase().split('.').pop() ?? '';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'pdf') return 'application/pdf';
  return 'application/octet-stream';
}

/** Runs fn over items with at most `limit` in flight, keeping order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);
export const dateOnly = (v: unknown): string | null => {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  return new Date(v as Date).toISOString().slice(0, 10);
};


// ---------- Access rules ----------
export type DownloadFileRow = {
  role: string;
  is_current: boolean | number;
  course_status: string | null;
  level_status: string | null;
  step_status: string | null;
};

/**
 * Why a student may NOT download this file (null = allowed).
 * Rules: current version, course published (or held and the student is enrolled),
 * level + step published, course open to the student's branch (no branch rows = all branches),
 * and never videos (those are watched on the site).
 */
export function studentDownloadBlock(row: DownloadFileRow, ctx: { courseBranchIds: string[]; studentBranchId: string; enrolled: boolean }): string | null {
  if (row.role === 'video') return 'Videos are watched on the website and cannot be downloaded.';
  if (!(row.is_current === true || row.is_current === 1)) return 'This is an older version of the worksheet. Please download the current one from the course page.';
  const cs = row.course_status ?? 'published';
  if (cs === 'held') { if (!ctx.enrolled) return 'This course is paused for new students.'; }
  else if (cs !== 'published') return 'This course is not open yet.';
  if ((row.level_status ?? 'published') !== 'published' || (row.step_status ?? 'published') !== 'published') return 'This worksheet is not available right now.';
  if (ctx.courseBranchIds.length && !ctx.courseBranchIds.includes(ctx.studentBranchId)) return 'This course is not offered at your branch.';
  return null;
}

/**
 * Files of a submission that go into the print pack.
 * assessment_only: the files uploaded for this step itself (forStepId empty or = the step);
 * the worksheets of earlier steps (forStepId = another step) are left out.
 * If nothing matches, the last file is used so the teacher still gets the page.
 */
export function pickPackFiles(files: Attachment[], stepId: string, include: 'assessment_only' | 'all_files'): Attachment[] {
  const list = files.filter(f => f && typeof f.storageKey === 'string' && f.storageKey);
  if (include === 'all_files') return list;
  const own = list.filter(f => !f.forStepId || f.forStepId === stepId);
  if (own.length) return own;
  return list.length ? [list[list.length - 1]] : [];
}

/** Storage keys we accept from clients: plain keys, no traversal or URLs. */
export function isSafeStorageKey(key: unknown): key is string {
  return typeof key === 'string' && key.length > 0 && key.length <= 512 && !key.includes('..') && !/^[a-z]+:\/\//i.test(key) && !key.startsWith('/');
}

export function validateWatermarkInput(body: unknown): { ok: true; value: WatermarkSetting } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  if (b.storageKey !== null && b.storageKey !== undefined && !isSafeStorageKey(b.storageKey)) return { ok: false, error: 'Please upload the logo again (the file reference is not valid).' };
  const opacity = Number(b.opacity ?? 0.08);
  if (!Number.isFinite(opacity) || opacity < 0.02 || opacity > 0.5) return { ok: false, error: 'Opacity must be between 2% and 50%. 8% is a good, quiet default.' };
  const scale = Number(b.scale ?? 0.45);
  if (!Number.isFinite(scale) || scale < 0.05 || scale > 1) return { ok: false, error: 'Size must be between 5% and 100% of the page width.' };
  const position = b.position ?? 'center';
  if (position !== 'center' && position !== 'bottom-right' && position !== 'diagonal-tile') return { ok: false, error: 'Position must be centre, bottom-right or diagonal tile.' };
  return { ok: true, value: { storageKey: (b.storageKey as string | null | undefined) ?? null, opacity, scale, position } };
}

// ---------- Competitions ----------
export function normaliseBranchIds(raw: unknown): string[] | null {
  const parsed = safeJson<unknown>(raw, null);
  if (!Array.isArray(parsed)) return null;
  const ids = uniqueIds(parsed);
  return ids.length ? ids : null;
}

export function normaliseExcerpts(raw: unknown): CompetitionExcerpt[] {
  const parsed = safeJson<unknown>(raw, []);
  if (!Array.isArray(parsed)) return [];
  const out: CompetitionExcerpt[] = [];
  parsed.slice(0, 50).forEach((e, i) => {
    if (typeof e === 'string') {
      if (e.trim()) out.push({ id: `x${i + 1}`, text: e.trim().slice(0, 4000), imageStorageKey: null, note: null });
      return;
    }
    if (!e || typeof e !== 'object') return;
    const o = e as Record<string, unknown>;
    const text = typeof o.text === 'string' && o.text.trim() ? o.text.trim().slice(0, 4000) : null;
    const imageStorageKey = isSafeStorageKey(o.imageStorageKey) ? o.imageStorageKey : null;
    const note = typeof o.note === 'string' && o.note.trim() ? o.note.trim().slice(0, 1000) : null;
    if (!text && !imageStorageKey) return;
    out.push({ id: typeof o.id === 'string' && o.id ? o.id.slice(0, 40) : `x${i + 1}`, text, imageStorageKey, note });
  });
  return out;
}

/** A competition is for a student when it has no branch scope or includes their branch. */
export function competitionOpenToBranch(branchIds: string[] | null, branchId: string | null): boolean {
  return !branchIds || (!!branchId && branchIds.includes(branchId));
}

/** Same rule as the legacy competitions routes (EFFECTIVE_COMPETITION_STATUS), in JS. */
export function effectiveCompetitionStatus(c: { status: string | null; start_date: string | Date | null; end_date: string | Date | null; judge_teacher_id: string | null }, today: string): string {
  const s = c.status ?? 'open';
  const start = c.start_date ? dateOnly(c.start_date)! : null;
  const end = c.end_date ? dateOnly(c.end_date)! : null;
  if (s === 'completed' || s === 'cancelled') return s;
  if (end && end < today && c.judge_teacher_id) return 'judging';
  if (end && end < today) return 'closed';
  if (s === 'closed') return 'closed';
  if (start && start > today) return 'upcoming';
  return 'open';
}

export type SelectionInput = { entryId: string; label: string | null; rank: number | null; publishToGallery: boolean };
export function normaliseSelections(raw: unknown): { ok: true; value: SelectionInput[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || !raw.length) return { ok: false, error: 'Please choose at least one entry.' };
  if (raw.length > 200) return { ok: false, error: 'Please select at most 200 entries at a time.' };
  const out: SelectionInput[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const o = (r ?? {}) as Record<string, unknown>;
    if (typeof o.entryId !== 'string' || !o.entryId) return { ok: false, error: 'Each selection needs an entry.' };
    if (seen.has(o.entryId)) continue;
    seen.add(o.entryId);
    const label = typeof o.label === 'string' && o.label.trim() ? o.label.trim().slice(0, 64) : null;
    const rankNum = o.rank === null || o.rank === undefined || o.rank === '' ? null : Number(o.rank);
    const rank = rankNum !== null && Number.isInteger(rankNum) && rankNum > 0 && rankNum < 1000 ? rankNum : null;
    out.push({ entryId: o.entryId, label, rank, publishToGallery: Boolean(o.publishToGallery) && !!label });
  }
  return { ok: true, value: out };
}

export function todayInNairobi(now = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}
