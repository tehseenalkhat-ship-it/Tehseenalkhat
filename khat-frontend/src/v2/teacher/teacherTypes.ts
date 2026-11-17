// owner: teacher (v3) — extra response shapes (contracts.ts is unchanged). Mirrors khat-backend
// src/v2/routes/review.routes.ts (courseType on inbox items, extra-attempt) and insights.routes.ts (accountability).
import type { InboxItem, TeamMember, ThreadResponse } from '../contracts';

export type CourseKind = 'certification' | 'mashq' | 'crash';
export const COURSE_KINDS: CourseKind[] = ['certification', 'mashq', 'crash'];
export const KIND_LABEL: Record<CourseKind, string> = { certification: 'Certification', mashq: 'Mashq', crash: 'Crash' };

export type InboxItemV3 = InboxItem & { courseType?: CourseKind };
export function kindOf(item: InboxItem): CourseKind {
  const t = (item as InboxItemV3).courseType;
  return t === 'mashq' || t === 'crash' ? t : 'certification';
}

export type ExtraAttemptResponse = { ok: boolean; extraAttempts: number; attemptsAllowed: number | null; message: string };

export type AccountabilityStatus = 'ok' | 'slow' | 'not_responding' | 'idle';
export type TeacherAccountability = TeamMember & { oldestWaitingHours: number | null; lastReviewAt: string | null; status: AccountabilityStatus; reason: string };
export type AccountabilityReport = { days: number; divertHours: number; counts: Record<AccountabilityStatus, number>; teachers: TeacherAccountability[]; generatedAt: string };

/** 'LV01' → 'Level 1', 'S05' → 'Step 5', 'FS' → 'Final submission'. Never shows internal codes. */
export function levelWords(code: string | null | undefined): string {
  const m = /(\d+)/.exec(code ?? '');
  return m ? `Level ${Number(m[1])}` : '';
}
export function stepWords(code: string | null | undefined): string {
  if (!code) return '';
  if (/^FS$/i.test(code)) return 'Final submission';
  const m = /(\d+)/.exec(code);
  return m ? `Step ${Number(m[1])}` : code;
}

/** "Fann al-Khat 1 · Level 1 · Step 5 — Upload assessment work" (Mashq/Crash have one hidden level). */
export function stepLine(step: ThreadResponse['step'], kind: CourseKind = 'certification'): string {
  const parts = [step.courseTitle];
  if (kind === 'certification') parts.push(levelWords(step.levelCode));
  const s = stepWords(step.code);
  if (s) parts.push(s);
  const head = parts.filter(Boolean).join(' · ');
  return step.title && !/^final submission$/i.test(step.title) ? `${head} — ${step.title}` : head;
}
