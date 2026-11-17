/**
 * Response of GET /v2/admin/today — copied verbatim from
 * khat-backend/src/v2/lib/adminHome.ts (keep both in step).
 * owner: admin-home
 */

// ---------------------------------------------------------------- response
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
