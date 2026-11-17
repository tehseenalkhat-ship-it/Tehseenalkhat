/**
 * Insights — pure logic (no database, no config) so it can be unit-tested.
 * owner: insights
 *
 * Segments (contracts.ts StudentSegment):
 *   new                 = joined < 14 days and nothing submitted yet
 *   dormant             = no activity for nudge.dormant_days (default 180)
 *   needs_push          = no activity for nudge.inactive_days (default 21)
 *   needs_encouragement = active, but open revisions / low average / many attempts
 *   doing_well          = active, passing, no open revisions
 */
import type { BranchMetrics, StudentSegment, TeamMember } from '../contracts.js';

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
export const NEW_STUDENT_DAYS = 14;
export const NUDGE_MIN_GAP_DAYS = 30;
export const DAILY_EMAIL_CAP = 80;
/** A student who needed this many attempts on one step is struggling. */
export const MANY_ATTEMPTS = 3;

export const SEGMENT_ORDER: StudentSegment[] = ['needs_push', 'needs_encouragement', 'dormant', 'new', 'doing_well'];

export type Bands = { revisionMax: number; passMax: number };
export type SegmentConfig = { inactiveDays: number; dormantDays: number; bands: Bands };

export const DEFAULT_SEGMENT_CONFIG: SegmentConfig = {
  inactiveDays: 21,
  dormantDays: 180,
  bands: { revisionMax: 5, passMax: 8 },
};

/** Everything we know about one student, gathered by a handful of grouped SQL queries. */
export type StudentFacts = {
  joinedAt: Date | null;
  lastActiveAt: Date | null;
  /** v2 submissions + legacy entries */
  submissions: number;
  markSum: number;
  markCount: number;
  openRevisions: number;
  pendingReviews: number;
  maxAttempts: number;
  courseCode: string | null;
  courseTitle: string | null;
  currentLevel: string | null;
};

function num(value: unknown, fallback: number): number {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

/** Build a SegmentConfig from effective policies; tolerant of strings / missing values. */
export function segmentConfigFrom(policies: Partial<Record<string, unknown>>): SegmentConfig {
  let bands = policies['assessment.bands'] as unknown;
  if (typeof bands === 'string') { try { bands = JSON.parse(bands); } catch { bands = null; } }
  const b = (bands && typeof bands === 'object' ? bands : {}) as Partial<Bands>;
  const inactiveDays = Math.max(1, Math.round(num(policies['nudge.inactive_days'], DEFAULT_SEGMENT_CONFIG.inactiveDays)));
  const dormantDays = Math.max(inactiveDays + 1, Math.round(num(policies['nudge.dormant_days'], DEFAULT_SEGMENT_CONFIG.dormantDays)));
  return {
    inactiveDays,
    dormantDays,
    bands: {
      revisionMax: num(b.revisionMax, DEFAULT_SEGMENT_CONFIG.bands.revisionMax),
      passMax: num(b.passMax, DEFAULT_SEGMENT_CONFIG.bands.passMax),
    },
  };
}

/** Parse anything the DB driver may hand us (Date, ISO string, 'YYYY-MM-DD', null). */
export function toDate(value: unknown): Date | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string') {
    const text = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z`
      : /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(value) ? `${value.replace(' ', 'T')}Z`
      : value;
    const d = new Date(text);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === 'number') return new Date(value);
  return null;
}

export function latestDate(...values: unknown[]): Date | null {
  let best: Date | null = null;
  for (const value of values) {
    const d = toDate(value);
    if (d && (!best || d > best)) best = d;
  }
  return best;
}

/** Whole days between two instants (never negative). */
export function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY_MS));
}

export function averageMark(facts: Pick<StudentFacts, 'markSum' | 'markCount'>): number | null {
  if (!facts.markCount) return null;
  return Math.round((facts.markSum / facts.markCount) * 10) / 10;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "in FNK-C101 LV02" / "in Naskh — Cut Pen Certification" / "" */
/** v3 audit 22: staff read "Level 2" / "Step 1", never internal codes like LV02 / S01. */
export function friendlyLevel(code: unknown, orderIndex?: unknown): string | null {
  const m = typeof code === 'string' ? code.trim().match(/^LV\s*0*(\d{1,3})$/i) : null;
  if (m) return `Level ${Number(m[1])}`;
  if (typeof code === 'string' && /^level\s+\d+/i.test(code.trim())) return code.trim();
  if (orderIndex !== null && orderIndex !== undefined && orderIndex !== '' && Number.isFinite(Number(orderIndex))) return `Level ${Number(orderIndex) + 1}`;
  return typeof code === 'string' && code.trim() ? code.trim() : null;
}
export function friendlyStep(code: unknown): string {
  if (typeof code !== 'string' || !code.trim()) return '';
  const c = code.trim();
  const m = c.match(/^S\s*0*(\d{1,3})$/i);
  if (m) return `Step ${Number(m[1])}`;
  if (/^FS$/i.test(c)) return 'Final submission';
  return c;
}

export function placeLabel(facts: Pick<StudentFacts, 'courseCode' | 'courseTitle' | 'currentLevel'>): string {
  const course = facts.courseTitle || facts.courseCode;
  if (!course) return '';
  return ` in ${course}${facts.currentLevel ? `, ${facts.currentLevel}` : ''}`;
}

function daysPhrase(days: number): string {
  if (days >= 60) {
    const months = Math.floor(days / 30);
    return `${days} days (about ${plural(months, 'month')})`;
  }
  return plural(days, 'day');
}

/** The heart of "who needs a push": one segment and one plain-words reason. */
export function segmentStudent(facts: StudentFacts, cfg: SegmentConfig, now: Date): { segment: StudentSegment; reason: string } {
  const where = placeLabel(facts);
  const joinedDays = facts.joinedAt ? daysBetween(facts.joinedAt, now) : null;
  const inactiveFrom = facts.lastActiveAt ?? facts.joinedAt;
  const idleDays = inactiveFrom ? daysBetween(inactiveFrom, now) : Number.POSITIVE_INFINITY;

  if (joinedDays !== null && joinedDays < NEW_STUDENT_DAYS && facts.submissions === 0) {
    const when = joinedDays === 0 ? 'today' : joinedDays === 1 ? 'yesterday' : `${joinedDays} days ago`;
    return { segment: 'new', reason: `Joined ${when} — has not sent any work yet. A warm welcome helps.` };
  }

  if (idleDays >= cfg.dormantDays) {
    if (!facts.lastActiveAt) {
      return { segment: 'dormant', reason: Number.isFinite(idleDays) ? `Has not practiced at all since joining ${daysPhrase(idleDays)} ago` : 'No activity recorded yet' };
    }
    return { segment: 'dormant', reason: `No activity for ${daysPhrase(idleDays)}${where}` };
  }

  if (idleDays >= cfg.inactiveDays) {
    const pending = facts.pendingReviews > 0 ? ` (still waiting on ${plural(facts.pendingReviews, 'reply', 'replies')} from us)` : '';
    if (!facts.lastActiveAt) return { segment: 'needs_push', reason: `Has not started practicing since joining ${daysPhrase(idleDays)} ago` };
    return { segment: 'needs_push', reason: `No activity for ${daysPhrase(idleDays)}${where}${pending}` };
  }

  const avg = averageMark(facts);
  const struggles: string[] = [];
  if (facts.openRevisions > 0) struggles.push(`${plural(facts.openRevisions, 'piece')} sent back for another try`);
  if (avg !== null && avg <= cfg.bands.revisionMax) struggles.push(`average mark ${avg} is below the pass mark (${cfg.bands.revisionMax + 1})`);
  if (facts.maxAttempts >= MANY_ATTEMPTS) struggles.push(`needed ${facts.maxAttempts} attempts on one step`);
  if (struggles.length) {
    const text = struggles.join('; ');
    return { segment: 'needs_encouragement', reason: `${text[0].toUpperCase()}${text.slice(1)}${where}` };
  }

  const activeWhen = idleDays === 0 ? 'Active today' : idleDays === 1 ? 'Active yesterday' : `Active ${idleDays} days ago`;
  if (avg !== null && avg > cfg.bands.passMax) return { segment: 'doing_well', reason: `${activeWhen}${where} — average ${avg}, distinction level` };
  if (avg !== null) return { segment: 'doing_well', reason: `${activeWhen}${where} — passing with an average of ${avg}` };
  if (facts.pendingReviews > 0) return { segment: 'doing_well', reason: `${activeWhen}${where} — work sent, waiting for our reply` };
  return { segment: 'doing_well', reason: `${activeWhen}${where} — practicing steadily` };
}

export function emptyCounts(): Record<StudentSegment, number> {
  return { doing_well: 0, needs_encouragement: 0, needs_push: 0, dormant: 0, new: 0 };
}

/** Sort: most urgent segment first, then the longest-idle student first. */
export function compareInsights(
  a: { segment: StudentSegment; lastActiveAt: string | null; name: string },
  b: { segment: StudentSegment; lastActiveAt: string | null; name: string },
): number {
  const s = SEGMENT_ORDER.indexOf(a.segment) - SEGMENT_ORDER.indexOf(b.segment);
  if (s !== 0) return s;
  const ta = a.lastActiveAt ? Date.parse(a.lastActiveAt) : 0;
  const tb = b.lastActiveAt ? Date.parse(b.lastActiveAt) : 0;
  if (ta !== tb) return a.segment === 'doing_well' ? tb - ta : ta - tb;
  return a.name.localeCompare(b.name);
}

// ---------- Nudges ----------

/** At most one nudge per student every NUDGE_MIN_GAP_DAYS days. */
export function canNudge(lastNudgedAt: Date | null, now: Date, minGapDays = NUDGE_MIN_GAP_DAYS): boolean {
  if (!lastNudgedAt) return true;
  return now.getTime() - lastNudgedAt.getTime() >= minGapDays * DAY_MS;
}

/** Fill {name} {course} {days}. Unknown values read naturally ("your course"). */
export function renderNudgeTemplate(template: string, values: { name: string; course: string | null; days: number | null }): string {
  const firstName = values.name.trim().split(/\s+/)[0] || values.name;
  return template
    .replace(/\{name\}/g, firstName)
    .replace(/\{course\}/g, values.course || 'your course')
    .replace(/\{days\}(\s+)days\b/g, (_m, space: string) => (values.days === 1 ? `1${space}day` : `${values.days ?? 'many'}${space}days`))
    .replace(/\{days\}/g, values.days == null ? 'many' : String(values.days))
    .trim();
}

/** How many more emails may go out today given what was already sent (rolling 24 h). */
export function emailBudget(sentLast24h: number, cap = DAILY_EMAIL_CAP): number {
  return Math.max(0, cap - Math.max(0, sentLast24h));
}

export type SweepCandidate = { studentId: string; segment: StudentSegment; lastNudgedAt: Date | null; idleDays: number };

/** Dormant students who may be nudged now; never-nudged first, then the oldest nudge, then the longest idle. */
export function pickSweepTargets<T extends SweepCandidate>(candidates: T[], now: Date, limit: number): T[] {
  if (limit <= 0) return [];
  return candidates
    .filter(c => c.segment === 'dormant' && canNudge(c.lastNudgedAt, now))
    .sort((a, b) => {
      if (!a.lastNudgedAt !== !b.lastNudgedAt) return a.lastNudgedAt ? 1 : -1;
      if (a.lastNudgedAt && b.lastNudgedAt && a.lastNudgedAt.getTime() !== b.lastNudgedAt.getTime()) return a.lastNudgedAt.getTime() - b.lastNudgedAt.getTime();
      return b.idleDays - a.idleDays;
    })
    .slice(0, limit);
}

// ---------- Team self-assessment maths ----------

export function pct(part: number, whole: number): number | null {
  if (!whole) return null;
  return Math.round((part / whole) * 1000) / 10;
}

export function hoursFromSeconds(totalSeconds: number, count: number): number | null {
  if (!count) return null;
  return Math.round((totalSeconds / count / 3600) * 10) / 10;
}

/** Raw per-branch aggregates (v2 + legacy already summed by the caller). */
export type BranchRaw = {
  branchId: string; branchName: string;
  students: number; active: number; teachers: number;
  submissions: number;
  /** judged = answered, or still open but older than 72 h (so it can no longer be "within 72 h") */
  judged: number; answeredWithin72h: number;
  waitSeconds: number; waitCount: number;
  pendingNow: number; overdueNow: number; autoMarked: number; levelsPassed: number;
};

export function buildBranchMetrics(raw: BranchRaw): BranchMetrics {
  return {
    branchId: raw.branchId,
    branchName: raw.branchName,
    students: raw.students,
    active30d: raw.active,
    teachers: raw.teachers,
    studentsPerTeacher: raw.teachers ? Math.round(raw.students / raw.teachers) : null,
    submissions30d: raw.submissions,
    answeredWithin72hPct: pct(raw.answeredWithin72h, raw.judged),
    avgWaitHours: hoursFromSeconds(raw.waitSeconds, raw.waitCount),
    pendingNow: raw.pendingNow,
    overdueNow: raw.overdueNow,
    autoMarked30d: raw.autoMarked,
    levelsPassed30d: raw.levelsPassed,
  };
}

export type TeacherRaw = {
  teacherId: string; name: string; branchId: string | null; branchName: string | null;
  reviewed: number;
  /** reviews of work from the teacher's own branch — numerator of the branch share */
  reviewedHomeBranch: number;
  responseSeconds: number; responseCount: number;
  pendingNow: number; overdueNow: number; divertedAway: number; autoMarked: number;
};

/** Per-teacher rows; share = own-branch reviews ÷ all reviews of that branch's work. */
export function buildTeamMembers(rows: TeacherRaw[], branchReviewTotals: Record<string, number>): TeamMember[] {
  return rows
    .map(r => {
      const total = r.branchId ? branchReviewTotals[r.branchId] ?? 0 : 0;
      return {
        teacherId: r.teacherId,
        name: r.name,
        branchName: r.branchName,
        reviewed30d: r.reviewed,
        avgResponseHours: hoursFromSeconds(r.responseSeconds, r.responseCount),
        pendingNow: r.pendingNow,
        overdueNow: r.overdueNow,
        divertedAway30d: r.divertedAway,
        autoMarked30d: r.autoMarked,
        shareOfBranchPct: pct(r.reviewedHomeBranch, total) ?? 0,
      };
    })
    .sort((a, b) => (a.branchName ?? '').localeCompare(b.branchName ?? '') || b.reviewed30d - a.reviewed30d || a.name.localeCompare(b.name));
}

export function clampDays(value: unknown, fallback = 30): number {
  const n = Math.round(num(value, fallback));
  return Math.min(365, Math.max(1, n));
}
