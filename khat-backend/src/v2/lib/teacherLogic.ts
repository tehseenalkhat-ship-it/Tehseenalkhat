// owner: teacher (v3) — pure logic for teacher accountability and extra attempts (unit-tested in tests/v2/v3-teacher.test.ts).

// ---------- "Give one more attempt" ----------

/** Total attempts a student may use on a marked step: policy max + extra grants. null = unlimited. */
export function attemptsAllowed(maxAttempts: unknown, extraGrants: number): number | null {
  const max = Number(maxAttempts);
  if (!Number.isFinite(max) || max <= 0) return null;
  return Math.round(max) + Math.max(0, Math.round(extraGrants || 0));
}

export type ExtraAttemptCheck = { hasMarks: boolean; passed: boolean; open: boolean };
/** A teacher may give one more attempt on a marked step that is not passed and has nothing waiting. */
export function extraAttemptBlock(c: ExtraAttemptCheck): string | null {
  if (!c.hasMarks) return 'This step has no marks — the student can always send it again.';
  if (c.passed) return 'The student has already passed this step.';
  if (c.open) return 'The student\'s last work is still waiting for a reply. Answer it first.';
  return null;
}

export const EXTRA_ATTEMPT_MESSAGE = (studentFirst: string, teacherFirst: string) =>
  `Salaam ${studentFirst || 'dear student'}, I have opened one more attempt for you on this step. Take your time, practice the points we spoke about, and send it again when you are ready — I am looking forward to it. — ${teacherFirst || 'Your teacher'}`;

// ---------- Teacher accountability ----------

export type AccountabilityStatus = 'ok' | 'slow' | 'not_responding' | 'idle';
export type AccountabilityInput = {
  openNow: number;
  overdueNow: number;               // open items older than the divert time (72 h)
  oldestWaitingHours: number | null;
  reviewed30d: number;
  divertedAway30d: number;          // passed on because there was no reply in time
  autoMarked30d: number;            // students who got an automatic mark while this teacher held the work
  lastReviewAt: Date | null;
  now: Date;
  divertHours: number;              // review.divert_after_hours (72)
};

const DAY = 86_400_000;
/** No answer for this many days = "Not answering lately" (never "Answering in time"). */
export const QUIET_AFTER_DAYS = 7;

/**
 * Plain-words status for the admin "Who is responding" list.
 * - not_responding: work is overdue now and nothing was answered in the last 3 days,
 *   or 2+ students had to get an automatic mark in 30 days.
 * - slow: something is overdue now, or work was passed on to others in the last 30 days.
 * - idle: nothing waiting and nothing reviewed in 30 days (not a problem, just quiet).
 * - ok: answering in time.
 */
export function accountabilityStatus(a: AccountabilityInput): { status: AccountabilityStatus; reason: string } {
  const sinceReview = a.lastReviewAt ? Math.floor((a.now.getTime() - a.lastReviewAt.getTime()) / DAY) : null;
  const lastText = sinceReview === null ? 'has not answered any work yet' : sinceReview === 0 ? 'last answered today' : `last answered ${sinceReview} day${sinceReview === 1 ? '' : 's'} ago`;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if ((a.overdueNow > 0 && (sinceReview === null || sinceReview >= 3)) || a.autoMarked30d >= 2) {
    const parts: string[] = [];
    if (a.overdueNow > 0) parts.push(`${plural(a.overdueNow, 'piece')} waiting over ${Math.round(a.divertHours)} hours`);
    if (a.autoMarked30d > 0) parts.push(`${plural(a.autoMarked30d, 'student')} got an automatic mark this month`);
    return { status: 'not_responding', reason: `${parts.join(' · ')} — ${lastText}.` };
  }
  if (a.overdueNow > 0 || a.divertedAway30d > 0 || a.autoMarked30d > 0) {
    const parts: string[] = [];
    if (a.overdueNow > 0) parts.push(`${plural(a.overdueNow, 'piece')} waiting over ${Math.round(a.divertHours)} hours`);
    if (a.divertedAway30d > 0) parts.push(`${plural(a.divertedAway30d, 'piece')} passed on to others this month`);
    if (a.autoMarked30d > 0) parts.push(`${plural(a.autoMarked30d, 'automatic mark')} this month`);
    return { status: 'slow', reason: `${parts.join(' · ')} — ${lastText}.` };
  }
  if (a.openNow === 0 && a.reviewed30d === 0) return { status: 'idle', reason: `Nothing waiting and nothing answered in 30 days — ${lastText}.` };
  // v3 audit 26: "Answering in time" must mean recent answers. Work open but nothing answered for a week → not answering lately.
  if (sinceReview === null || sinceReview >= QUIET_AFTER_DAYS) {
    if (a.openNow > 0) return { status: 'slow', reason: `Not answering lately · ${plural(a.openNow, 'piece')} open — ${lastText}.` };
    return { status: 'idle', reason: `Nothing waiting — ${lastText}.` };
  }
  return { status: 'ok', reason: a.openNow ? `Answering in time · ${plural(a.openNow, 'piece')} open — ${lastText}.` : `All answered — ${lastText}.` };
}

export const STATUS_ORDER: Record<AccountabilityStatus, number> = { not_responding: 0, slow: 1, ok: 2, idle: 3 };
