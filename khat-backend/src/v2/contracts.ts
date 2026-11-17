/**
 * Tehseen al-Khat v2 — shared API contracts.
 *
 * THIS FILE IS COPIED BYTE-FOR-BYTE TO khat-frontend/src/v2/contracts.ts.
 * Backend routes return exactly these shapes; frontend screens consume them.
 * Change it in one place only through the integration step, never per agent.
 *
 * Vocabulary follows the manifests: Course (code e.g. FNK-C101) → Level (LV01 +
 * Description) → Step (S01 + Task) → files per mistar size / page / version.
 */

// ---------- Reference vocab ----------
export type CourseStatus = 'draft' | 'published' | 'held' | 'hidden';
//   draft     = being built, only admins see it
//   published = live for its branches
//   held      = paused: enrolled students keep access, catalog hides it from new students
//   hidden    = disappears for students (their work is kept); admins still see it
export type ItemStatus = 'published' | 'hidden';          // levels and steps
export type PenType = 'normal' | 'cut' | string;
export type FileRole = 'worksheet' | 'video' | 'reference' | 'assessment_sheet' | 'resource' | 'other';
export type StudentAction = 'watch_download' | 'upload' | 'download_upload';
export type FeedbackMode = 'none' | 'feedback' | 'annotate_mark';
export type SubmissionStatus = 'submitted' | 'in_review' | 'revision' | 'passed' | 'reviewed';
//   reviewed = feedback-only step (e.g. Istinsakh) answered by the teacher
export type MarkBand = 'revision' | 'pass' | 'distinction';
export type AdminScope = 'master' | 'branch';

export type StepTypeDef = {
  typeKey: string;               // 'worksheet' | 'reference' | 'video' | 'kitabat' | 'raudat_hidayaat' | 'resource' | 'mashq' | 'istinsakh' | 'assessment' | custom
  label: string;
  fileCodes: string[];           // naming-convention TYPE codes that create this step type, e.g. ['MT','PW']
  studentAction: StudentAction;
  feedbackMode: FeedbackMode;
  hasMarks: boolean;             // marked 1..10
  gatesProgress: boolean;        // must pass before the next level opens
  awardsBadge: boolean;          // passing awards the level badge
  requiresPriorUploads: boolean; // assessment: student also uploads the worksheets of the level's earlier steps
  defaultInstructions: string;   // shown to the student when the step has no own message
  sortOrder: number;
  isSystem: boolean;
};

export type CourseTypeDef = {
  typeKey: string;               // 'certification' | 'crash' | 'mashq' | custom
  label: string;
  allowedStepTypes: string[];    // drop-down shown in the builder for courses of this type
  hasLevels: boolean;            // false = steps only (one hidden level)
  finalSubmission: boolean;      // add one upload step at the end
  sortOrder: number;
};

export type FileCodeDef = { fileCode: string; stepType: string; fileRole: FileRole; label: string };

// ---------- Policies (master sets, branches override where not locked) ----------
export type PolicyKey =
  | 'review.reviewers_required'      // number, default 1
  | 'review.turnaround_days'         // number, default 2
  | 'assessment.bands'               // { revisionMax: 5, passMax: 8 }  → ≤5 revision, 6–8 pass, 9–10 distinction
  | 'assessment.rubric'              // RubricCriterion[]
  | 'assessment.max_attempts'        // number, default 3 (0 = unlimited)
  | 'print.instructions'             // string shown on every download/print screen
  | 'print.allow_multi'              // boolean
  | 'downloads.stamp_fields'         // ('name'|'email'|'tr'|'class'|'branch'|'date')[]
  | 'downloads.watermark'            // WatermarkSetting
  | 'downloads.copyright_text'       // string
  | 'merit.levels_per_point'         // number, default 3
  | 'merit.certification_points'     // number, default 10
  | 'merit.monthly_cap'              // number, default 10
  | 'merit.officer_user_id'          // string | null — the ONE user who gives points on the Jamea portal
  | 'merit.reminder_day'             // day of month to remind the officer, default 25
  | 'showcase.requires_approval'     // boolean
  | 'uploads.max_files'              // number per submission, default 20
  | 'student.choose_one_size'        // boolean — student picks a mistar size once
  | 'review.divert_after_hours'      // number, default 72 — unanswered → another teacher of the same branch, else forward to master team
  | 'review.auto_mark_enabled'       // boolean, default true
  | 'review.auto_mark_after_days'    // number, default 7 — still unanswered → automatic mark + encouraging comment
  | 'review.quick_marks'             // number[], default [4,5,6,7,8,9,10] — one-tap marks on the photo
  | 'review.comment_templates'       // Record<MarkBand, string[]> — warm comments used for quick/auto marks
  | 'email.student_on_reply'         // boolean, default true
  | 'email.staff_mode'               // 'instant' | 'daily_digest' | 'off', default 'daily_digest'
  | 'nudge.inactive_days'            // number, default 21 — 'needs a push'
  | 'nudge.dormant_days'             // number, default 180 — automatic gentle message + email
  | 'nudge.message_template';        // string with {name} {course} {days}
export type RubricCriterion = { key: string; label: string; max: number };
export type WatermarkSetting = { storageKey: string | null; opacity: number; position: 'center' | 'bottom-right' | 'diagonal-tile'; scale: number };
export type PolicyRow = { policyKey: PolicyKey; value: unknown; locked: boolean; updatedAt: string | null; updatedBy: string | null };
export type PoliciesResponse = {
  global: PolicyRow[];                                  // every key, with defaults filled in
  branches: Record<string, Partial<Record<PolicyKey, unknown>>>; // branchId → overrides
  editableBranchIds: string[];                          // branches the caller may edit
  canEditGlobal: boolean;
};
export type EffectivePolicies = Record<PolicyKey, unknown>;

// ---------- Course tree ----------
export type StepFile = {
  id: string;
  role: FileRole;
  sizeCode: string | null;       // '07' | '10' | '20' | '30' | 'NP' | null (video/reference)
  page: string;                  // 'P01'
  version: number;
  isCurrent: boolean;
  storageKey: string;
  originalFilename: string;
  canonicalName: string;         // the naming-convention name
  contentType: string | null;
  byteSize: number | null;
  source: 'upload' | 'zip' | 'drive' | 'webhook';
  uploadedAt: string;
  uploadedByName: string | null;
};
export type Step = {
  id: string;
  levelId: string;
  code: string;                  // 'S01'
  orderIndex: number;
  title: string;                 // manifest "Task"
  stepType: string;              // StepTypeDef.typeKey
  template: string | null;
  message: string | null;        // optional note to students for this step
  videoUrl?: string | null;      // YouTube (or other) video link for this step
  maxMarks: number | null;
  badgeCode: string | null;
  status: ItemStatus;
  source: 'file' | 'manifest' | 'manual';
  files: StepFile[];             // current versions only unless ?history=1
  missing: string[];             // human readable, e.g. ['worksheet 2 mm']
};
export type Level = {
  id: string;
  courseId: string;
  code: string;                  // 'LV01'
  orderIndex: number;
  description: string | null;    // manifest "Description", e.g. مفردات
  instructions: string | null;   // what the student must do in this level
  badgeCode: string | null;      // default BDG_<CODE>_<LV>
  status: ItemStatus;
  steps: Step[];
};
export type CourseSummary = {
  id: string;
  code: string | null;
  title: string;
  titleAr: string | null;
  penType: PenType | null;
  courseType: string | null;
  khatTypeId: string;
  status: CourseStatus;
  structureVersion: 1 | 2;
  branchIds: string[];           // empty = all branches
  mistarSizes: string[];         // ['07','10','20']
  counts: { levels: number; steps: number; files: number; missing: number; students: number };
  updatedAt: string | null;
};
export type CourseDetail = CourseSummary & {
  description: string | null;
  instructions: string | null;   // course-wide default instructions
  driveFolderUrl: string | null;
  masterRow: Record<string, string> | null;
  levels: Level[];
};

// ---------- Master sheet + manifest import ----------
export type ImportAction = 'create' | 'update' | 'same' | 'error';
export type MasterImportRow = {
  courseCode: string;
  action: ImportAction;
  fields: { title: string; titleAr?: string; penType?: string; courseType?: string; description?: string; branches?: string[]; mistarSizes?: string[]; driveFolderUrl?: string };
  changes: string[];             // e.g. ['mistar sizes 1 mm, 2 mm → 0.7 mm, 1 mm, 2 mm']
  message?: string;
};
export type MasterImportPreview = { rows: MasterImportRow[]; sourceLabel: string };
export type ManifestImportPreview = {
  courseId: string;
  rows: { level: string; description?: string; step: string; task: string; stepType: string; template?: string; maxMarks?: number | null; badgeCode?: string | null; action: ImportAction; message?: string }[];
};

// ---------- File ingest (naming convention) ----------
export type ParsedFileName = {
  courseCode: string;
  fileCode: string;              // MT, KT, RH, PW, AW, RS, WS, VD, HF …
  level: string | null;          // 'LV01' or null for steps-only courses
  step: string;                  // 'S01'
  page: string;                  // 'P01'
  sizeCode: string | null;       // '07' | '10' | '20' | '30' | 'NP'
  version: number;
  ext: string;
  slug: string | null;           // harf files: CODE_HF_LV01_S01_01_alif_07.png
};
export type IngestPlanItem = {
  filename: string;
  ok: boolean;
  parsed: ParsedFileName | null;
  stepType: string | null;
  fileRole: FileRole | null;
  action: 'new_level' | 'new_step' | 'add_file' | 'new_version' | 'same_file' | 'unknown_course' | 'error';
  courseId: string | null;
  message: string;               // plain words for the admin
};
export type IngestCommitItem = { filename: string; storageKey: string; contentType: string; byteSize: number; source: StepFile['source'] };
export type IngestCommitResult = { filename: string; ok: boolean; action: IngestPlanItem['action']; stepId?: string; fileId?: string; message: string };

// ---------- Health + audit ----------
export type HealthIssue = { severity: 'error' | 'warning' | 'info'; message: string; levelId?: string; stepId?: string };
export type AuditEntry = { id: string; actorName: string | null; action: string; entityType: string; entityId: string; summary: string; createdAt: string; canUndo: boolean };

// ---------- Student side ----------
export type StudentStepState = {
  stepId: string;
  done: boolean;                 // marked done (download steps) or passed/reviewed (upload steps)
  submissionStatus: SubmissionStatus | null;
  mark: number | null;
  band: MarkBand | null;
  attemptsUsed: number;
  unreadMessages: number;
};
export type StudentCourse = CourseDetail & {
  enrolled: boolean;
  unlockedLevelIds: string[];
  progressPercent: number;
  stepStates: Record<string, StudentStepState>;
  stepTypes: StepTypeDef[];
  policies: Pick<EffectivePolicies, 'print.instructions' | 'print.allow_multi' | 'assessment.bands' | 'uploads.max_files' | 'student.choose_one_size'>;
  mySize: string | null;
};

// ---------- Threads (WhatsApp-style, one per student per step) ----------
export type Attachment = { storageKey: string; originalFilename: string; contentType: string; forStepId?: string | null };
export type ThreadMessage = {
  id: string;
  studentId: string;
  stepId: string;
  senderId: string;
  senderName: string;
  senderRole: 'student' | 'teacher' | 'admin' | 'system';
  kind: 'text' | 'files' | 'voice' | 'annotation' | 'system' | 'mark';
  body: string | null;
  attachments: Attachment[];
  submissionId: string | null;
  annotationId: string | null;
  meta: Record<string, unknown>;  // mark: { mark, band }, voice: { durationSec }
  createdAt: string;
  readByStudent: boolean;
};
export type Submission = {
  id: string;
  studentId: string;
  stepId: string;
  levelId: string;
  courseId: string;
  attemptNo: number;
  status: SubmissionStatus;
  mark: number | null;
  band: MarkBand | null;
  rubric: Record<string, number> | null;
  files: Attachment[];
  claimedById: string | null;
  claimedByName: string | null;
  reviewedById: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  createdAt: string;
  printCode: string;             // short code printed + QR-encoded on every printed page, e.g. 'TK-7F3K2'
  autoMarked: boolean;           // staff-only flag; students never see it
  divertedCount: number;
};
export type AnnotationStroke = { tool: 'pen' | 'highlighter' | 'circle' | 'arrow' | 'eraser'; color: string; width: number; points: [number, number][] }; // points normalised 0..1
export type AnnotationPin = { n: number; x: number; y: number; text: string | null; voiceStorageKey: string | null; durationSec: number | null };
export type Annotation = {
  id: string;
  submissionId: string;
  fileStorageKey: string;
  pageIndex: number;
  strokes: AnnotationStroke[];
  pins: AnnotationPin[];
  flattenedStorageKey: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
};
export type ThreadResponse = {
  student: { id: string; name: string; email: string; trNumber: string | null; className: string | null; branchName: string | null };
  step: Pick<Step, 'id' | 'code' | 'title' | 'stepType'> & { levelCode: string; levelDescription: string | null; courseCode: string | null; courseTitle: string };
  messages: ThreadMessage[];
  submissions: Submission[];
  annotations: Annotation[];
  canReview: boolean;
};
export type InboxItem = {
  submission: Submission;
  student: ThreadResponse['student'];
  step: ThreadResponse['step'];
  lastMessage: Pick<ThreadMessage, 'body' | 'kind' | 'createdAt' | 'senderName'> | null;
  unreadForStaff: number;
  waitingHours: number;
};
export type ReviewDecision = { mark?: number | null; rubric?: Record<string, number> | null; comment?: string | null; status?: 'reviewed' }; // band + status derived on server; empty comment → warm template for the band

// ---------- Bulk print + scan return ----------
export type PrintPackRequest = { submissionIds: string[]; include: 'assessment_only' | 'all_files' };
// Response: application/pdf. Every page carries the student's name, the printCode and a QR code of `KHAT:<printCode>:<pageNo>`.
export type ScanReturnItem = { submissionId: string; pageStorageKeys: string[]; mark?: number | null; comment?: string | null };
export type ScanReturnResult = { submissionId: string; ok: boolean; studentName: string; message: string };

// ---------- AI comment helper ----------
export type RefineCommentRequest = { text: string; studentName?: string | null; mark?: number | null; tone?: 'warm' | 'concise' | 'detailed'; language?: 'en' | 'ur' | 'ar' };
export type RefineCommentResponse = { refined: string; usedAi: boolean };

// ---------- Badges + merit ----------
export type StudentBadge = { id: string; badgeCode: string; kind: 'level' | 'course' | 'competition'; courseId: string | null; levelId: string | null; label: string; awardedAt: string };
export type MeritEntry = {
  id: string;
  studentId: string;
  studentName: string;
  trNumber: string | null;
  branchName: string | null;
  source: 'levels' | 'certification' | 'manual';
  sourceLabel: string;           // 'Levels 1–3 of FNK-C101' / 'Certification FNK-C101'
  points: number;
  earnedMonth: string;           // 'YYYY-MM' month it may be given in (after the monthly cap)
  status: 'pending' | 'given' | 'void';
  givenByName: string | null;
  givenAt: string | null;
};
export type MeritToGive = { month: string; officerUserId: string | null; canMarkGiven: boolean; students: { studentId: string; studentName: string; trNumber: string | null; branchName: string | null; total: number; entries: MeritEntry[] }[] };

// ---------- Competitions / calls / showcase ----------
export type CompetitionKind = 'competition' | 'call';
export type CompetitionSelection = { entryId: string; studentId: string; studentName: string; branchName: string | null; label: string; rank: number | null; imageStorageKey: string; publishedToGallery: boolean };
export type DashboardHighlight = { id: string; kind: CompetitionKind; competitionTitle: string; studentName: string; branchName: string | null; label: string; imageStorageKey: string; createdAt: string };

// ---------- Insights (smart progress) + team self-assessment ----------
export type StudentSegment = 'doing_well' | 'needs_encouragement' | 'needs_push' | 'dormant' | 'new';
//   doing_well          = active, passing (avg ≥ pass band), no open revisions
//   needs_encouragement = active but revisions / low marks / many attempts
//   needs_push          = no activity for nudge.inactive_days
//   dormant             = no activity for nudge.dormant_days (automatic nudge sent)
//   new                 = joined < 14 days, nothing submitted yet
export type StudentInsight = {
  studentId: string; name: string; trNumber: string | null; className: string | null; branchId: string; branchName: string | null;
  segment: StudentSegment; reason: string;            // plain words, e.g. 'No activity for 38 days in FNK-C101 LV02'
  courseCode: string | null; courseTitle: string | null; currentLevel: string | null;
  levelsPassed: number; avgMark: number | null; revisions: number; pendingReviews: number;
  lastActiveAt: string | null; lastNudgedAt: string | null;
};
export type InsightsSummary = { counts: Record<StudentSegment, number>; students: StudentInsight[]; total: number };
export type TeamMember = {
  teacherId: string; name: string; branchName: string | null;
  reviewed30d: number; avgResponseHours: number | null; pendingNow: number; overdueNow: number;
  divertedAway30d: number; autoMarked30d: number; shareOfBranchPct: number;
};
export type BranchMetrics = {
  branchId: string; branchName: string;
  students: number; active30d: number; teachers: number; studentsPerTeacher: number | null;
  submissions30d: number; answeredWithin72hPct: number | null; avgWaitHours: number | null;
  pendingNow: number; overdueNow: number; autoMarked30d: number; levelsPassed30d: number;
};
export type TeamReport = { branches: BranchMetrics[]; team: TeamMember[]; generatedAt: string };
export type NudgeRequest = { studentIds: string[]; message: string; sendEmail: boolean };

// ---------- Communities (student groups for delegation / special cohorts) ----------
export type StudentGroup = { id: string; name: string; purpose: string | null; branchId: string | null; memberCount: number; createdByName: string | null; createdAt: string; lastMessageAt: string | null };
export type GroupMessage = { id: string; groupId: string; senderId: string; senderName: string; senderRole: 'student' | 'teacher' | 'admin'; body: string | null; attachments: Attachment[]; createdAt: string };

// ---------- Review network: checking threshold + spill-over web ----------
// threshold = max open items a teacher holds at once (users.entry_load_threshold).
// spillTo   = ordered list of teachers (any branch) who receive this teacher's overflow.
// awayUntil = teacher is away (travel/exams) → new items and his open items spill over.
export type SpillTarget = { teacherId: string; name: string; branchName: string | null; priority: number };
export type ReviewerLoad = {
  teacherId: string; name: string; branchId: string; branchName: string | null;
  threshold: number; openNow: number; overdueNow: number; awayUntil: string | null;
  available: boolean;            // not away and openNow < threshold
  spillTo: SpillTarget[];
  receivesFrom: SpillTarget[];   // who spills into this teacher
};
export type ReviewNetwork = { reviewers: ReviewerLoad[]; canEditTeacherIds: string[]; canLinkAcrossBranches: boolean };
export type ReviewerSettingsUpdate = { threshold?: number; spillTo?: string[]; awayUntil?: string | null };
