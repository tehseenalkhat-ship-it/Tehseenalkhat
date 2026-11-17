/**
 * Admin "Today" home — types + pure alert building (no database here, unit tested).
 * The database side lives in routes/adminHome.routes.ts.
 * owner: admin-home
 *
 * The response type is copied verbatim to khat-frontend/src/v2/admin/adminHomeTypes.ts.
 */

// ---------------------------------------------------------------- response (copy to frontend)
export type AdminTodaySeverity = 'urgent' | 'soon' | 'info';

export type AdminTodayAlert = {
  severity: AdminTodaySeverity;
  text: string;
  actionLabel: string;
  actionPage: string;                          // hash route, e.g. 'v2-inbox'
  actionParams?: Record<string, string>;       // passed through openV2 (sessionStorage)
};

export type AdminTodayBranch = {
  branchId: string;
  name: string;
  students: number;
  active30d: number;
  waiting: number;
  overdue: number;
  avgWaitHours: number | null;
  answeredWithin72hPct: number | null;
  meritPending: number;                        // students with merit points still to give
  teachersFull: number;                        // teachers at their limit or away
  teachers: number;                            // teachers in the branch
};

export type AdminToday = {
  scope: { branchId: string | null; branchName: string | null; isMaster: boolean };
  counts: {
    waitingReview: number;
    overdue72h: number;
    oldestWaitHours: number | null;
    meritToGiveThisMonth: number;              // students
    studentsNeedPush: number;
    dormant: number;
    coursesWithMissingFiles: number;
    draftCourses: number;
  };
  alerts: AdminTodayAlert[];
  branches: AdminTodayBranch[];
  month: string;                               // YYYY-MM (Africa/Nairobi)
  generatedAt: string;
};

// ---------------------------------------------------------------- pure alert building
export type BranchFacts = {
  branchId: string;
  name: string;
  students: number;
  waiting: number;
  overdue: number;
  teachers: number;
  teachersFull: number;          // at limit (not away)
  teachersAway: number;
  hasMeritOfficer: boolean;
  meritStudents: number;
};

export type CourseGap = { courseId: string; code: string | null; title: string; missing: number };
export type LevelGap = { courseId: string; code: string | null; title: string; levelCode: string };

export type HomeFacts = {
  isMaster: boolean;
  singleBranch: boolean;         // scope is one branch → no branch name needed in the wording
  monthLabel: string;            // 'November'
  monthEndSoon: boolean;         // last 3 days of the month (Nairobi)
  divertHours: number;           // review.divert_after_hours (72)
  dormantDays: number;           // nudge.dormant_days (180)
  branches: BranchFacts[];
  needsPush: number;
  dormantToNudge: number;        // dormant and not nudged in the last 30 days
  coursesMissingFiles: CourseGap[];   // live courses only
  levelsWithoutAssessment: LevelGap[]; // live certification courses only
  draftCourses: number;
};

export const MAX_ALERTS = 8;
const RANK: Record<AdminTodaySeverity, number> = { urgent: 0, soon: 1, info: 2 };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** 72 → '3 days', 36 → '36 hours', 24 → '1 day'. */
export function waitWords(hours: number): string {
  const h = Math.max(1, Math.round(hours));
  if (h % 24 === 0) return plural(h / 24, 'day');
  return plural(h, 'hour');
}

/** 180 → '6 months', 365 → 'a year', 21 → '3 weeks', 10 → '10 days'. */
export function idleWords(days: number): string {
  const d = Math.max(1, Math.round(days));
  if (d >= 360 && d <= 370) return 'a year';
  if (d >= 56 && d % 30 <= 2) return plural(Math.round(d / 30), 'month');
  if (d % 7 === 0) return plural(d / 7, 'week');
  return plural(d, 'day');
}

/** Hours → short label for cards: '5 h', '2 days', '—'. */
export function shortWait(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours)) return '—';
  if (hours < 48) return `${Math.max(0, Math.round(hours))} h`;
  return `${Math.round(hours / 24)} days`;
}

const codeOf = (c: { code: string | null; title: string }) => c.code || c.title;

type Scored = AdminTodayAlert & { weight: number };

/**
 * Turn the facts into a short, plain-words to-do list. Most urgent first, then the
 * biggest numbers; at most MAX_ALERTS lines. Course alerts only for the master team
 * (branch admins cannot change courses).
 */
export function buildAlerts(f: HomeFacts): AdminTodayAlert[] {
  const out: Scored[] = [];
  const where = (b: BranchFacts) => (f.singleBranch ? '' : ` in ${b.name}`);
  const waitLimit = waitWords(f.divertHours);

  // 1. Work waiting too long — per branch.
  for (const b of f.branches) {
    if (b.overdue > 0) {
      out.push({
        severity: 'urgent', weight: 1000 + b.overdue,
        text: `${b.overdue} ${b.overdue === 1 ? 'entry' : 'entries'}${where(b)} ${b.overdue === 1 ? 'has' : 'have'} waited more than ${waitLimit}`,
        actionLabel: 'Review inbox', actionPage: 'v2-inbox', actionParams: { branchId: b.branchId },
      });
    }
  }

  // 2. Teachers: none at all, or everyone full / away.
  for (const b of f.branches) {
    const who = f.singleBranch ? 'your branch' : b.name;
    if (b.teachers === 0) {
      if (b.students > 0 || b.waiting > 0) {
        out.push({
          severity: b.waiting > 0 ? 'urgent' : 'soon', weight: 500 + b.waiting,
          text: `${f.singleBranch ? 'Your branch' : b.name} has no teachers yet — new work goes to the Nairobi team`,
          ...(f.isMaster
            ? { actionLabel: 'Teacher & load', actionPage: 'admin-users' }
            : { actionLabel: 'Review network', actionPage: 'v2-policies', actionParams: { policiesView: 'network', branchId: b.branchId } }),
        });
      }
      continue;
    }
    const busy = b.teachersFull + b.teachersAway;
    if (busy >= b.teachers) {
      const allAway = b.teachersAway >= b.teachers;
      const state = allAway ? 'away' : b.teachersAway > 0 ? 'full or away' : 'full';
      out.push({
        severity: 'urgent', weight: 400 + b.waiting,
        text: b.teachers === 1
          ? `The only teacher of ${who} is ${state} — add a helper or raise the limit`
          : `All ${b.teachers} teachers of ${who} are ${state} — share the work or raise their limits`,
        actionLabel: 'Review network', actionPage: 'v2-policies', actionParams: { policiesView: 'network', branchId: b.branchId },
      });
    }
  }

  // 3. Merit points to give this month.
  const meritStudents = f.branches.reduce((n, b) => n + b.meritStudents, 0);
  if (meritStudents > 0) {
    out.push({
      severity: f.monthEndSoon ? 'urgent' : 'soon', weight: 300 + meritStudents,
      text: `Merit points for ${f.monthLabel} are waiting to be given (${plural(meritStudents, 'student')})${f.monthEndSoon ? ' — the month ends soon' : ''}`,
      actionLabel: 'Merit points', actionPage: 'v2-merit',
    });
  }

  // 4. Branches without a merit officer.
  const noOfficer = f.branches.filter(b => !b.hasMeritOfficer && b.students > 0);
  if (noOfficer.length) {
    const pending = noOfficer.some(b => b.meritStudents > 0);
    const text = f.singleBranch
      ? 'Your branch has no merit officer yet — choose who gives the points'
      : noOfficer.length === 1
        ? `${noOfficer[0].name} has no merit officer yet`
        : noOfficer.length <= 3
          ? `${noOfficer.slice(0, -1).map(b => b.name).join(', ')} and ${noOfficer[noOfficer.length - 1].name} have no merit officer yet`
          : `${noOfficer.length} branches have no merit officer yet`;
    out.push({
      severity: pending ? 'soon' : 'info', weight: 200 + noOfficer.length,
      text, actionLabel: 'Branch policies', actionPage: 'v2-policies',
      actionParams: { policiesView: 'rules', ...(noOfficer.length === 1 ? { branchId: noOfficer[0].branchId } : {}) },
    });
  }

  // 5. Courses (master team only).
  if (f.isMaster) {
    const gaps = [...f.coursesMissingFiles].filter(c => c.missing > 0).sort((a, b) => b.missing - a.missing);
    if (gaps.length === 1 || gaps.length === 2) {
      for (const c of gaps) {
        out.push({
          severity: 'urgent', weight: 600 + c.missing,
          text: `${codeOf(c)} is missing ${plural(c.missing, 'file')} that students need`,
          actionLabel: 'Course builder', actionPage: 'v2-builder', actionParams: { courseId: c.courseId },
        });
      }
    } else if (gaps.length > 2) {
      out.push({
        severity: 'urgent', weight: 600 + gaps.length,
        text: `${gaps.length} live courses are missing files students need — ${codeOf(gaps[0])} has the most (${gaps[0].missing})`,
        actionLabel: 'Course builder', actionPage: 'v2-builder',
      });
    }

    const byCourse = new Map<string, LevelGap[]>();
    for (const l of f.levelsWithoutAssessment) byCourse.set(l.courseId, [...(byCourse.get(l.courseId) ?? []), l]);
    const courses = [...byCourse.values()];
    if (courses.length <= 2) {
      for (const levels of courses) {
        const c = levels[0];
        const names = levels.length <= 3 ? levels.map(l => l.levelCode).join(', ') : `${levels.length} levels`;
        out.push({
          severity: 'soon', weight: 250 + levels.length,
          text: `${codeOf(c)} ${names} ${levels.length === 1 ? 'has' : 'have'} no assessment yet — students move on without being checked`,
          actionLabel: 'Course builder', actionPage: 'v2-builder', actionParams: { courseId: c.courseId },
        });
      }
    } else {
      out.push({
        severity: 'soon', weight: 250 + courses.length,
        text: `${f.levelsWithoutAssessment.length} levels in ${courses.length} courses have no assessment yet — students move on without being checked`,
        actionLabel: 'Course builder', actionPage: 'v2-builder',
      });
    }

    if (f.draftCourses > 0) {
      out.push({
        severity: 'info', weight: 50 + f.draftCourses,
        text: `${plural(f.draftCourses, 'course is', 'courses are')} still in draft — publish when ready`,
        actionLabel: 'Course builder', actionPage: 'v2-builder',
      });
    }
  }

  // 6. Students.
  if (f.needsPush > 0) {
    out.push({
      severity: 'soon', weight: 150 + f.needsPush,
      text: `${plural(f.needsPush, 'student')} ${f.needsPush === 1 ? 'is' : 'are'} stuck and need${f.needsPush === 1 ? 's' : ''} a push — see who and why`,
      actionLabel: 'Student insights', actionPage: 'v2-insights', actionParams: { segment: 'needs_push' },
    });
  }
  if (f.dormantToNudge > 0) {
    out.push({
      severity: 'info', weight: 100 + f.dormantToNudge,
      text: `${plural(f.dormantToNudge, 'student')} ${f.dormantToNudge === 1 ? "hasn't" : "haven't"} practiced for ${idleWords(f.dormantDays)} — send a gentle message`,
      actionLabel: 'Student insights', actionPage: 'v2-insights', actionParams: { segment: 'dormant' },
    });
  }

  return out
    .sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.weight - a.weight)
    .slice(0, MAX_ALERTS)
    .map(({ weight: _w, ...alert }) => alert);
}

/** Month label in Africa/Nairobi, e.g. '2026-11' → 'November'. */
export function monthName(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, 1)).toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' });
}

/** True in the last `days` days of the month (inclusive). */
export function isMonthEndSoon(year: number, month: number, day: number, days = 3): boolean {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day > last - days;
}
