/**
 * v3 admin-comms response shapes (announcements, surveys, email templates, email queue,
 * JHS roster, people & roles, branch policy changes). Copied verbatim to
 * khat-frontend/src/v2/announce/commsTypes.ts — keep both in step.
 */

export type AnnouncementKind = 'announcement' | 'survey';
export type AnnouncementAudience = 'registered' | 'roster';
export type AnnouncementStatus = 'draft' | 'published' | 'closed';

export type SurveyQuestion = {
  id: string;
  text: string;
  type: 'choice' | 'rating' | 'text';
  options?: string[];      // for 'choice'
  required?: boolean;
};

export type Announcement = {
  id: string;
  kind: AnnouncementKind;
  title: string;
  body: string;
  branchId: string | null;       // null = every branch
  branchName: string | null;
  showOnSite: boolean;
  /** v3 audit 17: 'banner' (slim, default) or 'popup' (in the middle of the screen). */
  siteStyle: 'banner' | 'popup';
  sendEmail: boolean;
  audience: AnnouncementAudience;
  includeTeachers: boolean;
  questions: SurveyQuestion[];
  status: AnnouncementStatus;
  endsAt: string | null;
  createdAt: string;
  publishedAt: string | null;
  createdByName: string | null;
  emailsQueued: number;
  seenCount: number;
  responseCount: number;
  canEdit: boolean;
};

export type AnnouncementInput = {
  kind?: AnnouncementKind;
  title?: string;
  body?: string;
  branchId?: string | null;
  showOnSite?: boolean;
  siteStyle?: 'banner' | 'popup';
  sendEmail?: boolean;
  audience?: AnnouncementAudience;
  includeTeachers?: boolean;
  questions?: SurveyQuestion[];
  endsAt?: string | null;
};

/** What a signed-in person sees in the site banner. */
export type ActiveAnnouncement = {
  id: string;
  kind: AnnouncementKind;
  title: string;
  body: string;
  branchName: string | null;
  questions: SurveyQuestion[];
  answered: boolean;
  publishedAt: string | null;
  endsAt: string | null;
  siteStyle: 'banner' | 'popup';
};

export type AudiencePreview = { students: number; notRegistered: number; teachers: number; withEmail: number; withoutEmail: number };

export type SurveyResults = {
  announcementId: string;
  title: string;
  total: number;
  questions: {
    id: string;
    text: string;
    type: SurveyQuestion['type'];
    counts: { option: string; n: number }[];   // choice + rating
    average: number | null;                     // rating
    answers: { name: string; text: string }[];  // text (latest 200)
  }[];
};

export type EmailTemplateRow = {
  key: string;
  label: string;
  group: 'Students' | 'Everyone' | 'Staff';
  description: string;
  vars: string[];
  subject: string;
  body: string;
  isCustom: boolean;
  updatedAt: string | null;
  defaultSubject: string;
  defaultBody: string;
};

export type EmailQueueItem = { id: string; to: string; templateKey: string; subject: string; status: 'queued' | 'sent' | 'failed'; createdAt: string; sentAt: string | null; lastError: string | null };
export type EmailQueueStatus = { dailyCap: number; perRun: number; sentLast24h: number; waiting: number; failed: number; recent: EmailQueueItem[] };

export type RosterRow = { id: string; branchId: string; branchName: string; trNumber: string; name: string; className: string | null; email: string | null; registered: boolean; updatedAt: string | null };
export type RosterSummary = { branches: { branchId: string; branchName: string; total: number; withEmail: number; registered: number; lastImport: string | null }[] };
export type RosterImportResult = { total: number; added: number; updated: number; unchanged: number; skipped: { row: number; reason: string }[] };

export type PersonRole = 'student' | 'teacher' | 'branch_admin' | 'master_admin';
export type Person = {
  id: string;
  name: string;
  email: string;
  trNumber: string | null;
  role: PersonRole;
  isCoordinator: boolean;
  branchId: string;
  branchName: string;
  createdAt: string | null;
};
export type PeopleResponse = { people: Person[]; total: number; canEdit: boolean; counts: Record<PersonRole, number> };
export type PersonChange = { role?: PersonRole; branchId?: string; isCoordinator?: boolean };

export type BranchPolicyChange = {
  id: string;
  branchId: string | null;
  branchName: string | null;
  actorName: string | null;
  summary: string;
  policyKey: string | null;
  createdAt: string;
  isNew: boolean;
};
export type BranchPolicyChanges = { changes: BranchPolicyChange[]; newCount: number; lastSeenAt: string | null };
