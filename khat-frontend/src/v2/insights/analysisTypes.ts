// owner: analysis — "smart analysis" of one student (student / staff view) and of a class (cohort).
// Identical copy in khat-frontend/src/v2/insights/analysisTypes.ts — keep both in step.
// Self-contained on purpose (no imports) so the two copies can be byte-identical.

export type AnalysisBand = 'revision' | 'pass' | 'distinction';
export type AnalysisSegment = 'doing_well' | 'needs_encouragement' | 'needs_push' | 'dormant' | 'new';
export type TrendDirection = 'up' | 'flat' | 'down';

/** One marked piece of work, oldest first in StudentAnalysis.marks. */
export type AnalysisMark = {
  date: string;                 // ISO
  mark: number;                 // 1..10
  band: AnalysisBand;
  label: string;                // 'FNK-C101 · LV01 · S05' or legacy 'Naskh — Cut Pen · Checkpoint'
  courseId: string | null;
  attemptNo: number;
  source: 'v2' | 'legacy';
  provisional?: boolean;        // automatic 96-hour mark, the teacher has not confirmed it yet
};

/** Average of one rubric criterion over the student's marked work. */
export type CriterionScore = {
  key: string;
  label: string;                // from the branch policy assessment.rubric
  max: number;
  average: number;              // 0..max, one decimal
  percent: number;              // 0..100
  samples: number;
  recent: number[];             // newest first, at most 3
};

/** A friendly chip: strength or focus area, in plain words. */
export type AnalysisChip = { key: string; label: string; text: string; source: 'marks' | 'remarks' };

/** "What your teachers keep telling you" — one recurring topic. */
export type RemarkTopic = {
  key: string;                  // 'alif' | 'baseline' | …
  label: string;                // 'Alif' / 'Baseline'
  count: number;                // remarks that mention it
  advice: number;               // of which: suggestions to improve
  praise: number;               // of which: praise
  example: string | null;       // the latest sentence that mentions it (advice preferred)
};

export type CourseProgressItem = {
  courseId: string;
  code: string | null;
  title: string;
  structureVersion: 1 | 2;
  progressPercent: number;
  levelsPassed: number;
  totalLevels: number;
  currentLevel: string | null;          // 'LV02'
  currentLevelDescription: string | null;
  waitingForReview: boolean;
  openRevision: boolean;
  completed: boolean;
  nextStep: { stepId: string; code: string; title: string; levelCode: string; isUpload: boolean; unlocksLevel: string | null } | null;
};

export type MeritProgress = {
  pointsThisMonth: number;      // earned for this month (pending + given)
  pending: number;              // all pending points (this and later months)
  given: number;                // all points already given on the Jamea portal
  levelsPerPoint: number;       // policy merit.levels_per_point
  levelsTowardNext: number;     // 0..levelsPerPoint-1 (closest course)
  levelsUntilNextPoint: number; // 1..levelsPerPoint
  monthlyCap: number;
};

export type AnalysisNextStep = {
  key: string;
  text: string;                 // 'Send the LV02 assessment — it opens LV03'
  detail: string | null;
  tone: 'go' | 'practice' | 'merit' | 'cheer';
  action: { label: string; courseId: string; stepId: string | null } | null;
};

export type StudentAnalysis = {
  student: { id: string; name: string; trNumber: string | null; className: string | null; branchId: string; branchName: string | null; joinedAt: string | null };
  generatedAt: string;
  summary: {
    levelsPassed: number;
    averageMark: number | null;
    bestMark: number | null;
    markCount: number;
    trend: TrendDirection;
    trendText: string;          // plain words
    streakDays: number;
    activeDays30: number;
    lastActiveAt: string | null;
    attempts: number;           // pieces of work sent
    revisions: number;          // pieces sent back for another try
    distinctions: number;
  };
  marks: AnalysisMark[];        // oldest first, at most 40 (latest)
  bands: { revisionMax: number; passMax: number }; // branch policy assessment.bands
  rubric: CriterionScore[];
  strengths: AnalysisChip[];
  focusAreas: AnalysisChip[];
  remarks: RemarkTopic[];       // top topics, most frequent first
  courses: CourseProgressItem[];
  merit: MeritProgress;
  segment: AnalysisSegment;
  segmentReason: string;
  nextSteps: AnalysisNextStep[]; // 2–4
  suggestedMessage: string | null; // staff only; null for the student
};

// ---------------------------------------------------------------- class view
export type CohortLevelAverage = { courseId: string; courseLabel: string; levelCode: string; levelLabel: string; average: number; marked: number; students: number };
export type CohortHardStep = {
  stepId: string; courseLabel: string; levelCode: string; stepCode: string; title: string;
  revisions: number; attempts: number; students: number; averageMark: number | null;
};
export type CohortFocus = { key: string; label: string; students: number; source: 'marks' | 'remarks' | 'both'; text: string };
export type CohortStuck = {
  studentId: string; name: string; trNumber: string | null; className: string | null;
  courseId: string; courseLabel: string; levelCode: string; days: number;
  lastActiveAt: string | null; lastNudgedAt: string | null;
};
export type CohortAnalysis = {
  generatedAt: string;
  scope: { branchId: string | null; branchName: string | null; courseId: string | null; courseLabel: string | null };
  courses: { id: string; label: string }[];      // for the course filter
  students: number;
  studentsWithMarks: number;
  markedWork: number;
  averageMark: number | null;
  histogram: { mark: number; count: number }[];  // marks 1..10
  bands: { revisionMax: number; passMax: number };
  levelAverages: CohortLevelAverage[];
  hardestSteps: CohortHardStep[];
  commonFocus: CohortFocus[];
  firstAttempt: { total: number; passed: number; rate: number | null };
  stuckDays: number;
  stuck: CohortStuck[];
  stuckTotal: number;
};
