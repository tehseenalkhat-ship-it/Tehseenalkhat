import type { Level, Step, StepFile, StepTypeDef, StudentCourse } from '../../contracts';

/* Pure helpers for the task page (no React). */

export type FlatStep = { step: Step; level: Level; levelIndex: number; stepIndex: number; flatIndex: number };

export const COURSE_KIND: Record<string, string> = { certification: 'Certification course', crash: 'Crash course', mashq: 'Mashq worksheets' };
export function courseKind(type: string | null | undefined): string {
  const key = String(type ?? '').toLowerCase();
  return COURSE_KIND[key] ?? (key ? key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' ') : 'Course');
}

export function penClass(pen: string | null | undefined): string {
  const key = String(pen ?? '').toLowerCase();
  return key === 'cut' ? 'v3t-pen-cut' : key === 'normal' ? 'v3t-pen-normal' : 'v3t-pen-none';
}

export function currentFiles(step: Step): StepFile[] {
  return step.files.filter(file => file.isCurrent !== false);
}

export function flattenSteps(course: StudentCourse): FlatStep[] {
  const out: FlatStep[] = [];
  course.levels.forEach((level, levelIndex) => {
    [...level.steps].sort((a, b) => a.orderIndex - b.orderIndex).forEach((step, stepIndex) => {
      out.push({ step, level, levelIndex, stepIndex, flatIndex: out.length });
    });
  });
  return out;
}

const DOWNLOAD_ONLY = (type: StepTypeDef | undefined) => !type || type.studentAction === 'watch_download';

/**
 * "Mashq page": a set of worksheets to download and practice, then one final upload.
 * Mashq courses, and any one-level course whose steps are only sheets (no videos or references).
 */
export function isMashqLike(course: StudentCourse, typeOf: (step: Step) => StepTypeDef | undefined): boolean {
  if (String(course.courseType ?? '').toLowerCase() === 'mashq') return true;
  if (course.levels.length !== 1) return false;
  const steps = course.levels[0].steps;
  const sheetSteps = steps.filter(step => DOWNLOAD_ONLY(typeOf(step)));
  if (sheetSteps.length < 2) return false;
  const uploads = steps.filter(step => !DOWNLOAD_ONLY(typeOf(step)));
  if (uploads.length > 1) return false;
  return sheetSteps.every(step => !step.videoUrl && !currentFiles(step).some(file => file.role === 'video' || file.role === 'reference'));
}

/** YouTube link → id (watch?v=, youtu.be/, /embed/, /shorts/, /live/). */
export function youtubeId(url: string | null | undefined): string | null {
  if (!url) return null;
  const text = url.trim();
  const patterns = [
    /youtu\.be\/([A-Za-z0-9_-]{6,})/,
    /youtube(?:-nocookie)?\.com\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{6,})/,
    /youtube\.com\/.*[?&]v=([A-Za-z0-9_-]{6,})/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return match[1];
  }
  return null;
}

export function youtubeEmbed(id: string): string {
  return `https://www.youtube-nocookie.com/embed/${id}?rel=0&modestbranding=1&playsinline=1`;
}

export function isDirectVideo(url: string | null | undefined): boolean {
  return Boolean(url && /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(url));
}

export type TodoKey = 'video' | 'reference' | 'sheet' | 'upload' | 'done';
export type Todo = { key: TodoKey; text: string };

/** What the student does in THIS step, in order — only the parts that exist (owner note 2.7). */
export function buildTodo(step: Step, type: StepTypeDef | undefined, opts: { hasSheets: boolean; hasVideo: boolean; hasReference: boolean; practiceSteps: number }): Todo[] {
  const key = type?.typeKey ?? step.stepType;
  const items: Todo[] = [];
  if (opts.hasVideo) items.push({ key: 'video', text: 'Watch the reference video.' });
  if (opts.hasReference) items.push({ key: 'reference', text: 'Look closely at the reference image — tap it to zoom in.' });
  if (opts.hasSheets) {
    items.push(key === 'assessment'
      ? { key: 'sheet', text: 'Download the assessment sheet, print it and fill it carefully.' }
      : { key: 'sheet', text: 'Download your practice sheet, print it and practice it several times.' });
  }
  if (DOWNLOAD_ONLY(type)) {
    items.push({ key: 'done', text: 'When you have practiced, press “Mark as done”.' });
  } else if (key === 'istinsakh') {
    items.push({ key: 'upload', text: 'Upload one page of your istinsakh. Your teacher will send you comments.' });
  } else if (key === 'assessment') {
    items.push({ key: 'upload', text: opts.practiceSteps > 0
      ? 'Upload all your practice sheets of this level as one PDF, together with your filled assessment sheet. Your teacher gives marks out of 10.'
      : 'Upload your filled assessment sheet. Your teacher gives marks out of 10.' });
  } else if (key === 'final_submission') {
    items.push({ key: 'upload', text: 'Upload all your sheets as one PDF. Your teacher gives marks and remarks.' });
  } else {
    items.push({ key: 'upload', text: 'Upload your work for your teacher’s comments.' });
  }
  return items;
}

/** Days the teacher has to reply, from policy review.turnaround_days (default 3). */
export function replyDays(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 3;
}

export function daysWord(n: number): string {
  return n === 1 ? '1 day' : `${n} days`;
}
