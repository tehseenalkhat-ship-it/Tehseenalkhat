/**
 * Review logic for Tehseen al-Khat v2 (owner: backend-review).
 *
 * Part 1 — PURE functions (no database, unit-tested in tests/v2/backend-review.test.ts):
 *   bands + decision outcome, warm comment templates, automatic mark value,
 *   merit accrual with monthly cap + carry-over, next-assignee choice,
 *   SLA decision, printCode generator / parser, Nairobi calendar helpers,
 *   digest + reminder timing, rule-based comment polish (AI fallback).
 *
 * Part 2 — applyDecision(submissionId, decision, actor): the ONE place a mark /
 *   feedback decision is written. Used by the review routes, the SLA auto-mark
 *   sweep and the scan-return flow (backend-files).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { MarkBand, ReviewDecision, Submission, SubmissionStatus } from '../contracts.js';
import { pool } from '../../db.js';
import { DEFAULTS, getEffectivePolicies } from './policies.js';
import * as data from './threadData.js';
import * as notifyMod from './threadNotify.js';

// ============================================================================
// Part 1 — pure logic
// ============================================================================

export type Bands = { revisionMax: number; passMax: number };
export const OPEN_STATUSES: SubmissionStatus[] = ['submitted', 'in_review'];
export const DONE_STATUSES: SubmissionStatus[] = ['revision', 'passed', 'reviewed'];

function toInt(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : null;
}

/** Defensive JSON parse: strings are parsed, objects returned as is, junk → fallback. */
export function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  if (Buffer.isBuffer(value)) return parseJson<T>(value.toString('utf8'), fallback);
  return value as T;
}

/** Policy value → safe bands (≤ revisionMax revision, ≤ passMax pass, above distinction). */
export function normaliseBands(raw: unknown): Bands {
  const value = parseJson<Record<string, unknown>>(raw, {});
  let revisionMax = toInt(value?.revisionMax) ?? 5;
  revisionMax = Math.min(9, Math.max(0, revisionMax));
  let passMax = toInt(value?.passMax) ?? 8;
  passMax = Math.min(10, Math.max(revisionMax, passMax));
  return { revisionMax, passMax };
}

export function bandForMark(mark: number, bands: Bands): MarkBand {
  if (mark <= bands.revisionMax) return 'revision';
  if (mark <= bands.passMax) return 'pass';
  return 'distinction';
}

/** The lowest mark that still passes (never below 1, never above 10). */
export function lowestPassMark(bands: Bands): number {
  return Math.min(10, Math.max(1, bands.revisionMax + 1));
}

export type DecisionOutcome =
  | { ok: true; status: SubmissionStatus; band: MarkBand | null; mark: number | null }
  | { ok: false; error: string };

/**
 * Marked steps (assessment, final submission): mark 1–10 → band → revision | passed.
 * Feedback-only steps (istinsakh): no mark, status 'reviewed'.
 */
export function decideOutcome(opts: { hasMarks: boolean; mark: unknown; bands: Bands }): DecisionOutcome {
  if (!opts.hasMarks) return { ok: true, status: 'reviewed', band: null, mark: null };
  if (opts.mark === null || opts.mark === undefined || opts.mark === '') {
    return { ok: false, error: 'Please choose a mark from 1 to 10 for this work.' };
  }
  const mark = typeof opts.mark === 'number' ? opts.mark : Number(opts.mark);
  if (!Number.isInteger(mark) || mark < 1 || mark > 10) {
    return { ok: false, error: 'The mark must be a whole number from 1 to 10.' };
  }
  const band = bandForMark(mark, opts.bands);
  return { ok: true, status: band === 'revision' ? 'revision' : 'passed', band, mark };
}

/** Small stable hash so the same submission always gets the same template. */
export function stableHash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Warm comment for a band from policy `review.comment_templates` (falls back to built-in ones). */
export function pickTemplate(templatesRaw: unknown, band: MarkBand, seed: string): string {
  const templates = parseJson<Record<string, unknown>>(templatesRaw, {});
  const defaults = DEFAULTS['review.comment_templates'] as Record<MarkBand, string[]>;
  const list = Array.isArray(templates?.[band])
    ? (templates[band] as unknown[]).filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    : [];
  const pool = list.length ? list : defaults[band];
  return pool[stableHash(seed) % pool.length].trim();
}

/**
 * Automatic mark after the SLA: the student's own average (rounded), else the
 * branch average for this step, else the lowest pass mark — never below the
 * lowest pass mark and never above 10. The student is never left waiting.
 */
export function computeAutoMark(opts: { studentAverage: number | null; branchStepAverage: number | null; bands: Bands }): number {
  const floor = lowestPassMark(opts.bands);
  const pick = [opts.studentAverage, opts.branchStepAverage].find(v => typeof v === 'number' && Number.isFinite(v));
  const base = typeof pick === 'number' ? Math.round(pick) : floor;
  return Math.min(10, Math.max(floor, base));
}

/**
 * v3 — the warm message that goes with the automatic (96 h) mark, written as from the teacher.
 * Never mentions "automatic"; thanks the student, encourages, promises a closer look.
 */
export const AUTO_MARK_MESSAGES: Record<'pass' | 'distinction', string[]> = {
  pass: [
    'Salaam {name}, thank you for your patience and for the care you put into this work. I can see your effort — keep practicing with the same love, and I will look at it again closely soon. — {teacher}',
    'Dear {name}, well done for sending your work on time. Your steady practice is showing; keep your pen moving every day. I will add more detailed remarks shortly. — {teacher}',
    '{name}, thank you for this submission. You are making good progress — keep going with the next sheets, and I will come back to you with my notes. — {teacher}',
  ],
  distinction: [
    'Salaam {name}, beautiful effort! Thank you for your patience — your work shows real care. I will look at it again closely and share my notes soon. — {teacher}',
    'Dear {name}, mashallah, your practice is shining through. Keep this up; I will send you detailed remarks shortly. — {teacher}',
  ],
};

export function autoMarkMessage(opts: { studentName?: string | null; teacherName?: string | null; band: MarkBand; seed: string }): string {
  const list = opts.band === 'distinction' ? AUTO_MARK_MESSAGES.distinction : AUTO_MARK_MESSAGES.pass;
  const first = (v: string | null | undefined) => (v ?? '').trim().split(/\s+/)[0] || '';
  const name = first(opts.studentName) || 'dear student';
  const teacher = (opts.teacherName ?? '').trim() || 'Your teacher';
  const text = list[stableHash(opts.seed) % list.length].replace(/\{name\}/g, name).replace(/\{teacher\}/g, teacher);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ---------- Merit ----------

export type MeritChunk = { month: string; points: number };

/** 'YYYY-MM' + n months. */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const index = y * 12 + (m - 1) + n;
  const year = Math.floor(index / 12);
  const mon = (index % 12) + 1;
  return `${year}-${String(mon).padStart(2, '0')}`;
}

/**
 * Splits `points` over months starting at `startMonth`, filling each month up to
 * `cap` (points already booked in a month count against it). Overflow carries to
 * the next month — never lost. cap ≤ 0 means "no cap".
 */
export function allocateMeritPoints(points: number, startMonth: string, usedByMonth: Record<string, number>, cap: number): MeritChunk[] {
  const total = Math.max(0, Math.floor(points));
  if (total === 0) return [];
  if (!(cap > 0)) return [{ month: startMonth, points: total }];
  const chunks: MeritChunk[] = [];
  let remaining = total;
  let month = startMonth;
  for (let guard = 0; remaining > 0 && guard < 600; guard++) {
    const room = Math.max(0, cap - (usedByMonth[month] ?? 0));
    const take = Math.min(room, remaining);
    if (take > 0) {
      chunks.push({ month, points: take });
      remaining -= take;
    }
    month = addMonths(month, 1);
  }
  return chunks;
}

/** How many "every N levels" blocks a student has completed (1 point each). */
export function levelPointBlocks(levelBadges: number, levelsPerPoint: number): number {
  if (!(levelsPerPoint > 0) || !(levelBadges > 0)) return 0;
  return Math.floor(levelBadges / Math.floor(levelsPerPoint));
}

export function levelBlockLabel(block: number, levelsPerPoint: number, courseLabel: string): string {
  const n = Math.max(1, Math.floor(levelsPerPoint));
  const from = (block - 1) * n + 1;
  const to = block * n;
  return from === to ? `Level ${from} of ${courseLabel}` : `Levels ${from}–${to} of ${courseLabel}`;
}

// ---------- Assignment ----------

export type AssigneeCandidate = { id: string; openLoad: number };

/** Least-loaded candidate that is not excluded (previous reviewers). Ties → stable by id. */
export function chooseNextAssignee(candidates: AssigneeCandidate[], exclude: Iterable<string> = []): string | null {
  const banned = new Set(exclude);
  const pool = candidates
    .filter(c => c && c.id && !banned.has(c.id))
    .map(c => ({ id: c.id, load: Number.isFinite(Number(c.openLoad)) ? Number(c.openLoad) : 0 }))
    .sort((a, b) => a.load - b.load || a.id.localeCompare(b.id));
  return pool[0]?.id ?? null;
}

// ---------- Spill-over network (teacher limits + "send my overflow to") ----------

export const DEFAULT_THRESHOLD = 15;

/** users.entry_load_threshold → limit; null / < 1 / junk → 15 (zero setup works). Explicit values are kept. */
export function effectiveThreshold(raw: unknown): number {
  const n = toInt(raw);
  return n === null || n < 1 ? DEFAULT_THRESHOLD : Math.min(500, n);
}

export type ReviewerNode = {
  id: string;
  branchId: string;
  openLoad: number;
  threshold: number;            // already effective (see effectiveThreshold)
  awayUntil: Date | null;
  spillTo: string[];            // ordered by priority 1..n
  isMasterTeam?: boolean;       // master admins + teachers of the master branch (Nairobi)
  isTeacher?: boolean;          // false for admins: they only receive work through spill lists / the master team
};

/** Teachers of a branch (admins are not part of a branch's shared reviewing pool). */
export function branchReviewers(nodes: ReviewerNode[], branchId: string): ReviewerNode[] {
  return nodes.filter(n => n.branchId === branchId && n.isTeacher !== false);
}

export function isAway(node: ReviewerNode, now: Date): boolean {
  return Boolean(node.awayUntil && node.awayUntil.getTime() > now.getTime());
}

export function isAvailable(node: ReviewerNode, now: Date): boolean {
  return !isAway(node, now) && node.openLoad < node.threshold;
}

function leastLoaded(nodes: ReviewerNode[]): ReviewerNode | null {
  return [...nodes].sort((a, b) => a.openLoad - b.openLoad || a.id.localeCompare(b.id))[0] ?? null;
}

/**
 * Breadth-first walk through the spill-over web starting from `starts` (in order):
 * each node's targets are visited in priority order, any branch, cycles skipped.
 * Returns the first reviewer that `accept`s.
 */
export function walkSpillWeb(byId: Map<string, ReviewerNode>, starts: string[], accept: (n: ReviewerNode) => boolean, skip: Set<string> = new Set()): ReviewerNode | null {
  const visited = new Set<string>(starts);
  const queue: string[] = [];
  for (const s of starts) for (const t of byId.get(s)?.spillTo ?? []) if (!visited.has(t)) { visited.add(t); queue.push(t); }
  while (queue.length) {
    const id = queue.shift()!;
    const node = byId.get(id);
    if (!node) continue;
    if (!skip.has(id) && accept(node)) return node;
    for (const t of node.spillTo) if (!visited.has(t)) { visited.add(t); queue.push(t); }
  }
  return null;
}

export type Assignment = { teacherId: string | null; route: 'branch' | 'spill' | 'fallback' | 'master' | 'none' };

/**
 * New submission:
 * 1. least-loaded available teacher of the student's branch;
 * 2. else follow the branch teachers' spill-over lists (priority, breadth-first, any branch) to the first available reviewer;
 * 3. else the master team's least-loaded available member when the branch has nobody (or nobody reachable);
 * 4. else the least-loaded teacher of the branch anyway (not away if possible) — never block a student.
 */
export function chooseInitialAssignee(nodes: ReviewerNode[], branchId: string, now: Date): Assignment {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const branchTeachers = branchReviewers(nodes, branchId);
  const avail = leastLoaded(branchTeachers.filter(n => isAvailable(n, now)));
  if (avail) return { teacherId: avail.id, route: 'branch' };
  const starts = [...branchTeachers].sort((a, b) => a.openLoad - b.openLoad || a.id.localeCompare(b.id)).map(n => n.id);
  const spilled = walkSpillWeb(byId, starts, n => isAvailable(n, now));
  if (spilled) return { teacherId: spilled.id, route: 'spill' };
  if (!branchTeachers.length) {
    const master = nodes.filter(n => n.isMasterTeam);
    const m = leastLoaded(master.filter(n => isAvailable(n, now))) ?? leastLoaded(master.filter(n => !isAway(n, now))) ?? leastLoaded(master);
    return m ? { teacherId: m.id, route: 'master' } : { teacherId: null, route: 'none' };
  }
  const fallback = leastLoaded(branchTeachers.filter(n => !isAway(n, now))) ?? leastLoaded(branchTeachers);
  return { teacherId: fallback?.id ?? null, route: 'fallback' };
}

export type DivertChoice = { teacherId: string | null; reason: 'diverted' | 'forwarded' | 'none' };

/**
 * 72-hour divert (or the current teacher is away): next hop =
 * 1. the current teacher's spill-over web (priority, breadth-first);
 *    with no list this is "everyone else in my branch, least busy first";
 * 2. other available teachers of the same branch, least busy first;
 * 3. the master team (Nairobi), least busy first;
 * 4. if everyone is full: any not-away, not-previous reviewer in the branch, then the master team.
 * Never back to a previous reviewer (`exclude` holds every earlier holder incl. the current one).
 */
export function chooseDivertTarget(nodes: ReviewerNode[], opts: { currentId: string | null; branchId: string; exclude: Iterable<string>; now: Date }): DivertChoice {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const banned = new Set(opts.exclude);
  if (opts.currentId) banned.add(opts.currentId);
  const ok = (n: ReviewerNode) => !banned.has(n.id) && isAvailable(n, opts.now);
  const reasonFor = (n: ReviewerNode): DivertChoice => ({ teacherId: n.id, reason: n.branchId === opts.branchId ? 'diverted' : 'forwarded' });

  if (opts.currentId && byId.has(opts.currentId)) {
    const viaWeb = walkSpillWeb(byId, [opts.currentId], ok);
    if (viaWeb) return reasonFor(viaWeb);
  }
  const branch = branchReviewers(nodes, opts.branchId);
  const sameBranch = leastLoaded(branch.filter(ok));
  if (sameBranch) return reasonFor(sameBranch);
  const master = nodes.filter(n => n.isMasterTeam);
  const m = leastLoaded(master.filter(ok));
  if (m) return reasonFor(m);
  const notAway = (n: ReviewerNode) => !banned.has(n.id) && !isAway(n, opts.now);
  const anyBranch = leastLoaded(branch.filter(notAway));
  if (anyBranch) return reasonFor(anyBranch);
  const anyMaster = leastLoaded(master.filter(notAway));
  if (anyMaster) return reasonFor(anyMaster);
  return { teacherId: null, reason: 'none' };
}

/** "Set up my branch automatically": a ring inside the branch, master team as last stop. */
export function buildRing(teacherIds: string[], masterTeamIds: string[] = []): Map<string, string[]> {
  const ids = [...new Set(teacherIds)];
  const extra = [...new Set(masterTeamIds)].filter(id => !ids.includes(id));
  const out = new Map<string, string[]>();
  ids.forEach((id, i) => {
    const list: string[] = [];
    if (ids.length > 1) list.push(ids[(i + 1) % ids.length]);
    for (const m of extra) if (m !== id) list.push(m);
    out.set(id, list);
  });
  return out;
}

// ---------- SLA ----------

export type SlaInput = {
  status: string;
  createdAt: Date;
  assignedAt: Date | null;
  claimedAt: Date | null;
  lastStaffActivityAt: Date | null; // latest staff message / annotation in the thread
  assigneeAway?: boolean;           // the current teacher marked himself away → spill on the next sweep
  now: Date;
  divertAfterHours: number;
  autoMarkEnabled: boolean;
  autoMarkAfterDays: number;
};
export type SlaAction = 'none' | 'divert' | 'auto_mark';

const HOUR = 3_600_000;

/**
 * - Not open → none.
 * - Open for ≥ autoMarkAfterDays (and enabled) → auto_mark.
 * - Held by the current teacher (since assignment or claim) for ≥ divertAfterHours
 *   with no staff reply since then → divert.
 */
export function slaDecision(input: SlaInput): SlaAction {
  if (!OPEN_STATUSES.includes(input.status as SubmissionStatus)) return 'none';
  const now = input.now.getTime();
  const autoDays = Number(input.autoMarkAfterDays);
  if (input.autoMarkEnabled && autoDays > 0 && now - input.createdAt.getTime() >= autoDays * 24 * HOUR) return 'auto_mark';
  if (input.assigneeAway) return 'divert';
  const divertHours = Number(input.divertAfterHours);
  if (!(divertHours > 0)) return 'none';
  const holdStart = Math.max(
    (input.assignedAt ?? input.createdAt).getTime(),
    input.claimedAt ? input.claimedAt.getTime() : 0,
  );
  if (now - holdStart < divertHours * HOUR) return 'none';
  if (input.lastStaffActivityAt && input.lastStaffActivityAt.getTime() >= holdStart) return 'none';
  return 'divert';
}

/** Hours between two moments, one decimal, never negative. */
export function hoursBetween(from: Date, to: Date): number {
  return Math.max(0, Math.round(((to.getTime() - from.getTime()) / HOUR) * 10) / 10);
}

// ---------- Print code ----------

/** Crockford base32 (no I, L, O, U) — easy to read and type from paper. */
export const PRINT_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PRINT_CODE_RE = /^TK-[0-9A-HJKMNP-TV-Z]{5}$/;

export function generatePrintCode(random: (n: number) => Uint8Array = n => randomBytes(n)): string {
  const bytes = random(5);
  let out = '';
  for (let i = 0; i < 5; i++) out += PRINT_CODE_ALPHABET[bytes[i] % 32];
  return `TK-${out}`;
}

export function isValidPrintCode(code: string): boolean {
  return PRINT_CODE_RE.test(code);
}

/**
 * Accepts what a teacher may type or a scanner may read:
 * 'TK-7F3K2', 'tk 7f3k2', '7F3K2', 'KHAT:TK-7F3K2:3'. Maps O→0, I/L→1 (Crockford).
 * Returns the canonical code or null.
 */
export function normalizePrintCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let text = input.trim().toUpperCase();
  const qr = text.match(/^KHAT:([^:]+)(?::\d+)?$/);
  if (qr) text = qr[1];
  text = text.replace(/[\s_.\-–—]/g, '');
  if (text.startsWith('TK')) text = text.slice(2);
  text = text.replace(/O/g, '0').replace(/[IL]/g, '1');
  const code = `TK-${text}`;
  return isValidPrintCode(code) ? code : null;
}

/** 'KHAT:<printCode>:<page>' → parts, or null. */
export function parseQrPayload(payload: string): { printCode: string; page: number | null } | null {
  const m = typeof payload === 'string' ? payload.trim().match(/^KHAT:([^:]+)(?::(\d+))?$/i) : null;
  if (!m) return null;
  const printCode = normalizePrintCode(m[1]);
  if (!printCode) return null;
  return { printCode, page: m[2] ? Number(m[2]) : null };
}

// ---------- Calendar (Africa/Nairobi) ----------

export const TZ = 'Africa/Nairobi';

export type ZonedParts = { year: number; month: number; day: number; hour: number; ymd: string; ym: string };

export function zonedParts(date: Date, timeZone = TZ): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value ?? '0');
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = get('hour') % 24;
  const ym = `${year}-${String(month).padStart(2, '0')}`;
  return { year, month, day, hour, ym, ymd: `${ym}-${String(day).padStart(2, '0')}` };
}

export function nairobiMonth(date: Date = new Date()): string {
  return zonedParts(date).ym;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isValidMonth(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

/**
 * Which merit reminders are due today for the officer:
 * 'day' on the reminder day (clamped to the month's length) and 'last' on the
 * last day of the month. When both fall on the same day only 'last' is sent.
 */
export function meritReminderKindsDue(now: Date, reminderDay: unknown): ('day' | 'last')[] {
  const p = zonedParts(now);
  const last = daysInMonth(p.year, p.month);
  const wanted = toInt(reminderDay);
  const day = wanted === null ? 25 : Math.min(last, Math.max(1, wanted));
  const kinds: ('day' | 'last')[] = [];
  if (p.day === last) kinds.push('last');
  else if (p.day === day) kinds.push('day');
  return kinds;
}

/** The staff digest goes once a day, after `hour`:00 Nairobi time. */
export function digestDue(now: Date, lastSentYmd: string | null, hour = 7): boolean {
  const p = zonedParts(now);
  if (p.hour < hour) return false;
  return lastSentYmd !== p.ymd;
}

// ---------- Comment polish (AI fallback) ----------

export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?؟۔])\s+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function capitalise(sentence: string): string {
  return sentence.replace(/^([("'“‘]*)([a-z])/, (_m, pre: string, ch: string) => pre + ch.toUpperCase());
}

/**
 * Light rule-based polish when no AI is configured: tidy spacing and case,
 * 'i' → 'I', end punctuation, a warm opener and an encouraging close, ≤ 3 sentences.
 * The teacher's own words (and calligraphy terms) are kept as written.
 */
export function polishComment(text: string, opts: { studentName?: string | null; mark?: number | null; bands?: Bands } = {}): string {
  const clean = String(text ?? '')
    .replace(/[\u0000-\u0008\u000B-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/([,;:])(?=\S)/g, '$1 ')
    .replace(/\bi\b/g, 'I')
    .trim();
  const firstName = (opts.studentName ?? '').trim().split(/\s+/)[0] ?? '';
  const band = typeof opts.mark === 'number' && opts.mark >= 1 ? bandForMark(opts.mark, opts.bands ?? { revisionMax: 5, passMax: 8 }) : null;
  const opener = band === 'distinction'
    ? `Excellent work${firstName ? `, ${firstName}` : ''}.`
    : band === 'pass'
      ? `Well done${firstName ? `, ${firstName}` : ''} — your practice is showing.`
      : `Thank you for your careful effort${firstName ? `, ${firstName}` : ''}.`;
  const closing = band === 'distinction'
    ? 'Keep this standard in every level.'
    : band === 'pass'
      ? 'Keep going with the same care.'
      : 'Practice these points once more and send it back — you will see the difference.';
  if (!clean) return `${opener} ${closing}`;
  const body = splitSentences(clean)
    .map(s => capitalise(s))
    .map(s => (/[.!?؟۔]$/.test(s) ? s : `${s}.`));
  const core = body.slice(0, 2).join(' ');
  return `${opener} ${core} ${body.length <= 1 ? closing : ''}`.replace(/\s+/g, ' ').trim();
}

/** Keeps an AI answer to at most `max` sentences, strips quotes/markdown. */
export function tidyAiComment(text: string, max = 3): string {
  const stripped = text
    .replace(/^\s*["“'`]+|["”'`]+\s*$/g, '')
    .replace(/\*\*|__|^#+\s*/gm, '')
    .trim();
  return splitSentences(stripped).slice(0, max).join(' ').slice(0, 900);
}

// ---------- Badge codes ----------

export function courseCodeLabel(courseCode: string | null, courseId: string): string {
  return (courseCode && courseCode.trim()) || `C${courseId.replace(/-/g, '').slice(0, 6).toUpperCase()}`;
}

export function levelBadgeCode(opts: { stepBadge: string | null; levelBadge: string | null; courseCode: string | null; courseId: string; levelCode: string }): string {
  return (opts.stepBadge && opts.stepBadge.trim())
    || (opts.levelBadge && opts.levelBadge.trim())
    || `BDG_${courseCodeLabel(opts.courseCode, opts.courseId)}_${opts.levelCode}`;
}

export function courseBadgeCode(opts: { stepBadge: string | null; courseCode: string | null; courseId: string; isFinalStep: boolean }): string {
  if (opts.isFinalStep && opts.stepBadge && opts.stepBadge.trim()) return opts.stepBadge.trim();
  return `BDG_${courseCodeLabel(opts.courseCode, opts.courseId)}_COURSE`;
}

// ============================================================================
// Part 2 — applyDecision (database)
// ============================================================================

/** Who decides. Pass the route's Actor as is; the SLA sweep passes { id: null, auto: true }. */
export type DecisionActor = {
  id: string | null; name?: string | null; role?: string | null; auto?: boolean;
  /** v3: the automatic (96 h) mark is written in the assigned teacher's name (message sender). */
  asTeacherId?: string | null;
};

export class ReviewError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

type Tx = { query: (sql: string, params?: readonly unknown[]) => Promise<{ rows: any[]; rowCount: number }> };

const STEP_TYPE_FALLBACK: Record<string, { hasMarks: boolean; feedbackMode: string; gates: boolean; awardsBadge: boolean }> = {
  istinsakh: { hasMarks: false, feedbackMode: 'feedback', gates: false, awardsBadge: false },
  assessment: { hasMarks: true, feedbackMode: 'annotate_mark', gates: true, awardsBadge: true },
  final_submission: { hasMarks: true, feedbackMode: 'annotate_mark', gates: false, awardsBadge: true },
};

/**
 * Applies a teacher's (or the automatic) decision to a submission — in ONE transaction:
 * submission row, the 'mark' / feedback message in the thread, level or course badge,
 * merit points (certification + every N levels, monthly cap with carry-over), audit.
 * After the commit: in-app notifications + student email (best effort).
 *
 * - Marked steps need mark 1..10; feedback-only steps (istinsakh) take a comment.
 * - Empty comment → warm template for the band.
 * - Overrides are allowed (e.g. a teacher reviewing an automatic mark later);
 *   badges and merit points already earned are never taken back.
 * - With actor.auto the call is a no-op (returns current state) unless the submission is still open.
 *
 * Permission checks are the caller's job (see canStaffSeeSubmission in threadData.ts).
 * Throws ReviewError(status, friendly message) for 404/409/400 cases.
 */
export async function applyDecision(submissionId: string, decision: ReviewDecision, actor: DecisionActor): Promise<Submission> {
  const client = await pool.connect();
  let afterCommit: (() => Promise<void>) | null = null;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`SELECT * FROM step_submissions WHERE id = $1 FOR UPDATE`, [submissionId]);
    const sub = rows[0];
    if (!sub) throw new ReviewError(404, 'This submission could not be found.');

    const isOpen = OPEN_STATUSES.includes(sub.status);
    if (actor.auto && (!isOpen || sub.auto_marked)) {
      await client.query('ROLLBACK');
      client.release();
      return data.loadSubmission(submissionId, { forStudent: false }) as Promise<Submission>;
    }
    if (!actor.auto && actor.id && sub.status === 'in_review' && sub.claimed_by && sub.claimed_by !== actor.id) {
      const policies0 = await getEffectivePolicies(sub.branch_id);
      const staleHours = Number(policies0['review.divert_after_hours']) || 72;
      const claimedAt = sub.claimed_at ? new Date(sub.claimed_at) : null;
      const stale = !claimedAt || Date.now() - claimedAt.getTime() >= staleHours * HOUR;
      const isAdmin = actor.role === 'admin';
      if (!stale && !isAdmin) {
        const { rows: who } = await client.query(`SELECT name FROM users WHERE id = $1`, [sub.claimed_by]);
        throw new ReviewError(409, `${who[0]?.name ?? 'Another teacher'} is reviewing this work right now.`);
      }
    }

    const ctx = await data.loadStepContext(sub.step_id, client);
    if (!ctx) throw new ReviewError(404, 'The step for this submission no longer exists.');
    const policies = await getEffectivePolicies(sub.branch_id);
    const bands = normaliseBands(policies['assessment.bands']);
    const fallback = STEP_TYPE_FALLBACK[ctx.stepType] ?? null;
    const hasMarks = ctx.hasMarks ?? fallback?.hasMarks ?? false;
    const feedbackMode = ctx.feedbackMode ?? fallback?.feedbackMode ?? 'none';
    if (!hasMarks && feedbackMode === 'none') throw new ReviewError(400, 'This step does not take teacher feedback.');

    let mark: unknown = decision?.mark;
    if (!hasMarks) mark = null;
    const outcome = decideOutcome({ hasMarks, mark, bands });
    if (!outcome.ok) throw new ReviewError(400, outcome.error);

    const rubric = sanitiseRubric(decision?.rubric);
    const typed = typeof decision?.comment === 'string' ? decision.comment.trim().slice(0, 4000) : '';
    const comment = typed || pickTemplate(policies['review.comment_templates'], outcome.band ?? 'pass', `${submissionId}:${outcome.mark ?? ''}`);
    const now = new Date();
    const auto = Boolean(actor.auto);
    const reviewerId = auto ? null : actor.id;
    // v3: an automatic mark is PROVISIONAL — the student sees the mark and the warm message at once,
    // but the work stays open (in_review, auto_marked = 1) until a teacher confirms it with one tap.
    // So it does not unlock the next level, give a badge or count towards certification yet.
    const provisional = auto && hasMarks;
    const newStatus: SubmissionStatus = provisional ? 'in_review' : outcome.status;

    await client.query(
      `UPDATE step_submissions
         SET status = $1, mark = $2, band = $3, rubric = $4, reviewed_by = $5, reviewed_at = $6,
             auto_marked = $7, first_response_at = COALESCE(first_response_at, $6),
             claimed_by = CASE WHEN $8 THEN claimed_by ELSE COALESCE($5, claimed_by) END,
             claimed_at = CASE WHEN $8 THEN claimed_at ELSE COALESCE(claimed_at, $6) END
       WHERE id = $9`,
      [newStatus, outcome.mark, outcome.band, rubric ? JSON.stringify(rubric) : null, reviewerId, now, auto, auto, submissionId],
    );

    const messageId = await data.insertThreadMessage(client, {
      studentId: sub.student_id,
      stepId: sub.step_id,
      courseId: sub.course_id,
      branchId: sub.branch_id,
      senderId: auto ? (actor.asTeacherId ?? null) : reviewerId,
      senderRole: auto ? 'teacher' : actor.role === 'admin' ? 'admin' : 'teacher',
      kind: hasMarks ? 'mark' : 'text',
      body: comment,
      attachments: [],
      submissionId,
      meta: hasMarks ? { mark: outcome.mark, band: outcome.band } : { decision: 'reviewed' },
      staffRead: true,
    });

    // ---- badges + merit (only on a pass) ----
    const awarded: { badgeCode: string; label: string; kind: 'level' | 'course' }[] = [];
    let meritAdded = 0;
    const passed = !provisional && outcome.status === 'passed';
    if (passed) {
      const awardsBadge = ctx.awardsBadge ?? fallback?.awardsBadge ?? false;
      const courseLabel = courseCodeLabel(ctx.courseCode, ctx.courseId);
      // v3 (builder): the course badge / certificate only once the master team switched on
      // "Course complete — certificate can be given" (courses.certification_ready).
      const { rows: readyRows } = await client.query(`SELECT * FROM courses WHERE id = $1`, [ctx.courseId]);
      const courseReady = Boolean(Number(readyRows[0]?.certification_ready ?? 0));
      if (ctx.stepType === 'final_submission' && courseReady) {
        const code = courseBadgeCode({ stepBadge: ctx.badgeCode, courseCode: ctx.courseCode, courseId: ctx.courseId, isFinalStep: true });
        if (await insertBadge(client, sub.student_id, code, 'course', ctx.courseId, null, submissionId, `${ctx.courseTitle} — course completed`, reviewerId)) {
          awarded.push({ badgeCode: code, label: `${ctx.courseTitle} — course completed`, kind: 'course' });
        }
      } else if (awardsBadge) {
        const code = levelBadgeCode({ stepBadge: ctx.badgeCode, levelBadge: ctx.levelBadgeCode, courseCode: ctx.courseCode, courseId: ctx.courseId, levelCode: ctx.levelCode });
        // v3: student-friendly badge name, never internal codes ("Fann al-Khat 1 · Level 1 — مفردات")
        const label = `${ctx.courseTitle || courseLabel} · Level ${Number(ctx.levelOrder ?? 0) + 1}${ctx.levelDescription ? ` — ${ctx.levelDescription}` : ''}`;
        if (await insertBadge(client, sub.student_id, code, 'level', ctx.courseId, ctx.levelId, submissionId, label, reviewerId)) {
          awarded.push({ badgeCode: code, label, kind: 'level' });
        }
      }

      const meritMonth = nairobiMonth(now);
      const cap = toInt(policies['merit.monthly_cap']) ?? 10;

      // every N level badges of this course → 1 point
      const levelsPerPoint = toInt(policies['merit.levels_per_point']) ?? 3;
      if (levelsPerPoint > 0) {
        const { rows: lb } = await client.query(
          `SELECT COUNT(*) AS n FROM student_badges WHERE student_id = $1 AND course_id = $2 AND kind = 'level'`,
          [sub.student_id, ctx.courseId],
        );
        const blocks = levelPointBlocks(Number(lb[0]?.n ?? 0), levelsPerPoint);
        for (let k = 1; k <= blocks; k++) {
          meritAdded += await addMeritTx(client, {
            studentId: sub.student_id, branchId: sub.branch_id, source: 'levels',
            sourceRef: `levels:${ctx.courseId}:${k}`,
            label: levelBlockLabel(k, levelsPerPoint, courseLabel),
            points: 1, startMonth: meritMonth, cap, note: null,
          });
        }
      }

      // certification complete: every gating step of the course passed
      if (ctx.courseType === 'certification' && ctx.gatesProgress) {
        const { rows: open } = await client.query(
          `SELECT COUNT(*) AS n
             FROM level_steps ls
             JOIN levels l ON l.id = ls.level_id
             JOIN step_types st ON st.type_key = ls.step_type
            WHERE ls.course_id = $1 AND ls.status = 'published' AND l.status = 'published' AND st.gates_progress = 1
              AND NOT EXISTS (
                SELECT 1 FROM step_submissions s2
                 WHERE s2.student_id = $2 AND s2.step_id = ls.id AND s2.status = 'passed')`,
          [ctx.courseId, sub.student_id],
        );
        // Courses are built "on the go": a level without its assessment yet means the course
        // is not complete, so the certification can't be awarded until every level has one.
        const { rows: unassessed } = await client.query(
          `SELECT COUNT(*) AS n
             FROM levels l
            WHERE l.course_id = $1 AND l.status = 'published'
              AND NOT EXISTS (
                SELECT 1 FROM level_steps ls JOIN step_types st ON st.type_key = ls.step_type
                 WHERE ls.level_id = l.id AND ls.status = 'published' AND st.gates_progress = 1)`,
          [ctx.courseId],
        );
        if (courseReady && Number(open[0]?.n ?? 1) === 0 && Number(unassessed[0]?.n ?? 1) === 0) {
          const certPoints = toInt(policies['merit.certification_points']) ?? 10;
          meritAdded += await addMeritTx(client, {
            studentId: sub.student_id, branchId: sub.branch_id, source: 'certification',
            sourceRef: `cert:${ctx.courseId}`, label: `Certification ${courseLabel}`,
            points: certPoints, startMonth: meritMonth, cap, note: null,
          });
          const code = courseBadgeCode({ stepBadge: null, courseCode: ctx.courseCode, courseId: ctx.courseId, isFinalStep: false });
          const label = `${ctx.courseTitle} — certification completed`;
          if (await insertBadge(client, sub.student_id, code, 'course', ctx.courseId, null, submissionId, label, reviewerId)) {
            awarded.push({ badgeCode: code, label, kind: 'course' });
            // Certificate: uses the course's certificate template (uploaded in Admin → Certificates & badges)
            // and waits there for approval, exactly like the existing certificate flow.
            const { rows: tpl } = await client.query(
              `SELECT t.id, t.title, t.file_storage_key, c.khat_type_id
                 FROM certificate_templates t JOIN courses c ON c.id = $1
                WHERE t.course_id = $1 OR (t.course_id IS NULL AND t.level_id IS NULL AND t.khat_type_id = c.khat_type_id)
                ORDER BY (t.course_id = $1) DESC LIMIT 1`,
              [ctx.courseId],
            );
            const { rows: existing } = await client.query(
              `SELECT id FROM certificates WHERE student_id = $1 AND course_id = $2 LIMIT 1`, [sub.student_id, ctx.courseId],
            );
            if (tpl[0] && !existing[0]) {
              await client.query(
                `INSERT INTO certificates (student_id, khat_type_id, course_id, title, file_storage_key, status, template_id)
                 VALUES ($1, $2, $3, $4, $5, 'pending', $6)`,
                [sub.student_id, tpl[0].khat_type_id, ctx.courseId, tpl[0].title || `${ctx.courseTitle} — certificate`, tpl[0].file_storage_key, tpl[0].id],
              );
            }
          }
        }
      }
    }

    await data.insertAudit(client, {
      actorId: reviewerId,
      branchId: sub.branch_id,
      action: auto ? 'submission.auto_mark' : sub.auto_marked && OPEN_STATUSES.includes(sub.status) ? 'submission.confirm_auto_mark' : DONE_STATUSES.includes(sub.status) ? 'submission.override' : 'submission.decision',
      entityType: 'submission',
      entityId: submissionId,
      summary: hasMarks
        ? `${auto ? 'Automatic mark' : 'Marked'} ${outcome.mark}/10 (${outcome.band}) — ${ctx.courseLabelShort} ${ctx.levelCode} ${ctx.code}`
        : `Feedback given — ${ctx.courseLabelShort} ${ctx.levelCode} ${ctx.code}`,
      before: { status: sub.status, mark: sub.mark, band: sub.band, autoMarked: Boolean(sub.auto_marked) },
      after: { status: newStatus, mark: outcome.mark, band: outcome.band, autoMarked: auto, provisional, badges: awarded.map(b => b.badgeCode), meritAdded },
    });

    await client.query('COMMIT');

    afterCommit = async () => {
      await notifyMod.notifyStudentOfStaffMessage({
        studentId: sub.student_id,
        branchId: sub.branch_id,
        stepId: sub.step_id,
        courseId: sub.course_id,
        submissionId,
        messageId,
        kind: hasMarks ? 'mark' : 'feedback',
        mark: outcome.mark,
        band: outcome.band,
        comment,
        stepLabel: `${ctx.courseLabelShort} ${ctx.levelCode} ${ctx.code}${ctx.title ? ` — ${ctx.title}` : ''}`,
        courseTitle: ctx.courseTitle,
        forceEmail: true,
        provisional,
      });
      // 3.10: the responsible teacher gets the mark by email too (not when they marked it themselves)
      await notifyMod.emailFacultyOfMark({
        teacherId: sub.assigned_teacher_id ?? null, reviewerId, reviewerName: actor.name ?? null, auto, provisional,
        studentId: sub.student_id, stepId: sub.step_id, submissionId, branchId: sub.branch_id,
        mark: outcome.mark, band: outcome.band, comment, stepLabel: `${ctx.courseLabelShort} ${ctx.levelCode} ${ctx.code}`,
      });
      for (const badge of awarded) {
        await notifyMod.safeNotify(sub.student_id, 'badge_earned', {
          message: `Congratulations! You earned a new badge: ${badge.label}.`,
          badgeCode: badge.badgeCode, kind: badge.kind, courseId: ctx.courseId, levelId: ctx.levelId,
        });
      }
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    client.release();
    throw error;
  }
  client.release();
  if (afterCommit) {
    try { await afterCommit(); } catch (error) { console.error('[v2 review] post-decision notify failed', error); }
  }
  const result = await data.loadSubmission(submissionId, { forStudent: false });
  if (!result) throw new ReviewError(404, 'This submission could not be found.');
  return result;
}

function sanitiseRubric(raw: unknown): Record<string, number> | null {
  const value = parseJson<Record<string, unknown> | null>(raw, null);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, number> = {};
  for (const [key, v] of Object.entries(value).slice(0, 30)) {
    const n = typeof v === 'number' ? v : Number(v);
    if (/^[\w.-]{1,40}$/.test(key) && Number.isFinite(n)) out[key] = Math.max(0, Math.min(100, n));
  }
  return Object.keys(out).length ? out : null;
}

async function insertBadge(client: Tx, studentId: string, code: string, kind: 'level' | 'course', courseId: string | null, levelId: string | null, submissionId: string, label: string, awardedBy: string | null): Promise<boolean> {
  const res = await client.query(
    `INSERT IGNORE INTO student_badges (id, student_id, badge_code, kind, course_id, level_id, submission_id, label, awarded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [randomUUID(), studentId, code.slice(0, 64), kind, courseId, levelId, submissionId, label.slice(0, 255), awardedBy],
  );
  return res.rowCount > 0;
}

export type MeritAddInput = {
  studentId: string; branchId: string; source: 'levels' | 'certification' | 'manual';
  sourceRef: string; label: string; points: number; startMonth: string; cap: number; note: string | null;
};

/**
 * Books merit points inside a transaction, split over months by the cap.
 * Idempotent on (student, source, sourceRef): the first chunk carries the base
 * ref, later chunks '<ref>#2', '<ref>#3'… Returns points booked now (0 if already booked).
 */
export async function addMeritTx(client: Tx, input: MeritAddInput): Promise<number> {
  const { rows: existing } = await client.query(
    `SELECT id FROM merit_ledger WHERE student_id = $1 AND source = $2 AND source_ref = $3`,
    [input.studentId, input.source, input.sourceRef],
  );
  if (existing[0]) return 0;
  const { rows: used } = await client.query(
    `SELECT earned_month, SUM(points) AS pts FROM merit_ledger
      WHERE student_id = $1 AND status <> 'void' AND earned_month >= $2
      GROUP BY earned_month`,
    [input.studentId, input.startMonth],
  );
  const usedByMonth: Record<string, number> = {};
  for (const r of used) usedByMonth[String(r.earned_month)] = Number(r.pts) || 0;
  const chunks = allocateMeritPoints(input.points, input.startMonth, usedByMonth, input.cap);
  let booked = 0;
  for (let i = 0; i < chunks.length; i++) {
    const ref = i === 0 ? input.sourceRef : `${input.sourceRef}#${i + 1}`;
    const res = await client.query(
      `INSERT IGNORE INTO merit_ledger (id, student_id, branch_id, source, source_ref, source_label, points, earned_month, status, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9)`,
      [randomUUID(), input.studentId, input.branchId, input.source, ref.slice(0, 191), input.label.slice(0, 255), chunks[i].points, chunks[i].month, input.note],
    );
    if (res.rowCount === 0 && i === 0) return 0; // raced with another writer — already booked
    booked += res.rowCount > 0 ? chunks[i].points : 0;
  }
  return booked;
}
