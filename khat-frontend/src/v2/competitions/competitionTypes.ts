import type { CompetitionKind, CompetitionSelection } from '../contracts';

/*
 * Local shapes for /v2/competitions — contracts.ts has only CompetitionSelection
 * and DashboardHighlight (see "Contract requests" in the report). Everything is
 * read defensively so camelCase or snake_case responses both work.
 */
export type V2Excerpt = { text: string | null; imageStorageKey: string | null; note: string | null };
export type V2Competition = {
  id: string;
  kind: CompetitionKind;
  title: string;
  description: string | null;
  branchIds: string[] | null;
  excerpts: V2Excerpt[];
  coverStorageKey: string | null;
  startDate: string | null;
  endDate: string | null;
  status: 'upcoming' | 'open' | 'closed' | 'judging' | 'completed' | 'cancelled' | string;
  resultsPublished: boolean;
  entryCount: number | null;
  myEntry: { id: string; imageStorageKey: string; createdAt: string | null; selectionLabel: string | null } | null;
  selections: CompetitionSelection[];
};
export type V2CompetitionEntry = {
  id: string;
  studentId: string;
  studentName: string;
  branchName: string | null;
  imageStorageKey: string;
  createdAt: string | null;
  selectionLabel: string | null;
  selectionRank: number | null;
};
export type V2ShowcaseRequest = { id: string; studentName: string; branchName: string | null; storageKey: string; caption: string | null; createdAt: string | null; question: string | null; timeMinutes: number | null };

type Raw = Record<string, unknown>;
const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : typeof value === 'number' ? String(value) : null);
const pick = (raw: Raw, ...keys: string[]): unknown => { for (const key of keys) if (raw[key] !== undefined && raw[key] !== null) return raw[key]; return null; };
const parseJson = (value: unknown): unknown => { if (typeof value !== 'string') return value; try { return JSON.parse(value); } catch { return value; } };

function normalizeExcerpt(value: unknown): V2Excerpt {
  if (typeof value === 'string') return { text: value, imageStorageKey: null, note: null };
  const raw = (value ?? {}) as Raw;
  return { text: str(pick(raw, 'text', 'body')), imageStorageKey: str(pick(raw, 'imageStorageKey', 'image_storage_key', 'storageKey')), note: str(pick(raw, 'note', 'label', 'title')) };
}

function normalizeSelection(value: unknown): CompetitionSelection {
  const raw = (value ?? {}) as Raw;
  return {
    entryId: String(pick(raw, 'entryId', 'entry_id', 'id') ?? ''),
    studentId: String(pick(raw, 'studentId', 'student_id') ?? ''),
    studentName: str(pick(raw, 'studentName', 'student_name')) ?? 'A student',
    branchName: str(pick(raw, 'branchName', 'branch_name')),
    label: str(pick(raw, 'label', 'selectionLabel', 'selection_label')) ?? 'Selected',
    rank: pick(raw, 'rank', 'selectionRank', 'selection_rank') == null ? null : Number(pick(raw, 'rank', 'selectionRank', 'selection_rank')),
    imageStorageKey: String(pick(raw, 'imageStorageKey', 'image_storage_key') ?? ''),
    publishedToGallery: Boolean(pick(raw, 'publishedToGallery', 'published_to_gallery')),
  };
}

function deriveStatus(raw: Raw, start: string | null, end: string | null): string {
  const given = str(pick(raw, 'status'));
  if (given) return given;
  const now = Date.now();
  if (start && new Date(start).getTime() > now) return 'upcoming';
  if (end && new Date(end).getTime() < now) return 'closed';
  return 'open';
}

export function normalizeCompetition(value: unknown): V2Competition {
  const raw = (value ?? {}) as Raw;
  const startDate = str(pick(raw, 'startDate', 'start_date', 'startsAt', 'starts_at'));
  const endDate = str(pick(raw, 'endDate', 'end_date', 'endsAt', 'ends_at'));
  const excerpts = parseJson(pick(raw, 'excerpts'));
  const branchIds = parseJson(pick(raw, 'branchIds', 'branch_ids'));
  const selections = parseJson(pick(raw, 'selections', 'results', 'winners'));
  const mine = pick(raw, 'myEntry', 'my_entry') as Raw | null;
  return {
    id: String(pick(raw, 'id') ?? ''),
    kind: String(pick(raw, 'kind') ?? 'competition') === 'call' ? 'call' : 'competition',
    title: str(pick(raw, 'title')) ?? 'Untitled',
    description: str(pick(raw, 'description')),
    branchIds: Array.isArray(branchIds) && branchIds.length ? branchIds.map(String) : null,
    excerpts: Array.isArray(excerpts) ? excerpts.map(normalizeExcerpt) : [],
    coverStorageKey: str(pick(raw, 'coverStorageKey', 'cover_storage_key')),
    startDate,
    endDate,
    status: deriveStatus(raw, startDate, endDate),
    resultsPublished: Boolean(pick(raw, 'resultsPublished', 'results_published', 'resultsPublishedAt', 'results_published_at')),
    entryCount: pick(raw, 'entryCount', 'entry_count', 'entries_count') == null ? null : Number(pick(raw, 'entryCount', 'entry_count', 'entries_count')),
    myEntry: mine ? { id: String(pick(mine, 'id') ?? ''), imageStorageKey: String(pick(mine, 'imageStorageKey', 'image_storage_key') ?? ''), createdAt: str(pick(mine, 'createdAt', 'created_at', 'submitted_at')), selectionLabel: str(pick(mine, 'selectionLabel', 'selection_label', 'label')) } : null,
    selections: Array.isArray(selections) ? selections.map(normalizeSelection) : [],
  };
}

export function normalizeEntry(value: unknown): V2CompetitionEntry {
  const raw = (value ?? {}) as Raw;
  return {
    id: String(pick(raw, 'id', 'entryId') ?? ''),
    studentId: String(pick(raw, 'studentId', 'student_id') ?? ''),
    studentName: str(pick(raw, 'studentName', 'student_name')) ?? 'Student',
    branchName: str(pick(raw, 'branchName', 'branch_name')),
    imageStorageKey: String(pick(raw, 'imageStorageKey', 'image_storage_key') ?? ''),
    createdAt: str(pick(raw, 'createdAt', 'created_at', 'submitted_at')),
    selectionLabel: str(pick(raw, 'selectionLabel', 'selection_label')),
    selectionRank: pick(raw, 'selectionRank', 'selection_rank') == null ? null : Number(pick(raw, 'selectionRank', 'selection_rank')),
  };
}

export function normalizeShowcaseRequest(value: unknown): V2ShowcaseRequest {
  const raw = (value ?? {}) as Raw;
  return {
    id: String(pick(raw, 'id') ?? ''),
    studentName: str(pick(raw, 'studentName', 'student_name', 'authorName', 'author_name')) ?? 'Student',
    branchName: str(pick(raw, 'branchName', 'branch_name')),
    storageKey: String(pick(raw, 'storageKey', 'storage_key', 'imageStorageKey', 'image_storage_key') ?? ''),
    caption: str(pick(raw, 'caption')),
    createdAt: str(pick(raw, 'createdAt', 'created_at')),
    question: str(pick(raw, 'question', 'reflection_question')),
    timeMinutes: (() => { const v = Number(pick(raw, 'timeMinutes', 'time_minutes')); return Number.isFinite(v) && v > 0 ? v : null; })(),
  };
}

export function isOpen(competition: V2Competition): boolean {
  return competition.status === 'open' || (competition.status === 'upcoming' && !!competition.startDate && new Date(competition.startDate).getTime() <= Date.now());
}

export const SELECTION_LABELS = ['Winner', 'Runner-up', 'Honourable mention', 'Selected'];
