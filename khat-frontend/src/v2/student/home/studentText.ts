// owner: student-dash (v3). Plain, child-friendly words for the student pages — no internal codes.
import type { CourseSummary, Level, Step, StepTypeDef, StudentBadge, StudentCourse } from '../../contracts';

// ---------------------------------------------------------------- course kinds
export type CourseKind = 'certification' | 'crash' | 'mashq' | 'other';

export function courseKind(type: string | null | undefined): CourseKind {
  const value = String(type ?? '').toLowerCase();
  if (value === 'certification' || value === 'crash' || value === 'mashq') return value;
  return 'other';
}

export const KIND_LABEL: Record<CourseKind, string> = {
  certification: 'Certification course',
  crash: 'Crash course',
  mashq: 'Mashq worksheets',
  other: 'Course',
};

export const KIND_GROUP: Record<CourseKind, { title: string; text: string }> = {
  certification: { title: 'Certification courses', text: 'Full courses in levels. Pass each level to earn its badge, and finish them all for your certificate.' },
  crash: { title: 'Crash courses', text: 'Short courses for one skill or occasion. Follow the steps in order.' },
  mashq: { title: 'Mashq worksheets', text: 'Practice sheets. Download them, practice on art paper, then send them all together for marks.' },
  other: { title: 'Other courses', text: 'More courses from your teachers.' },
};

export const KIND_ORDER: CourseKind[] = ['certification', 'crash', 'mashq', 'other'];

export type PenKind = 'normal' | 'cut' | 'other';
export function penKind(pen: string | null | undefined): PenKind {
  const value = String(pen ?? '').toLowerCase();
  return value === 'normal' || value === 'cut' ? value : 'other';
}
export const PEN_TEXT: Record<PenKind, { label: string; text: string }> = {
  normal: { label: 'Normal pen', text: 'Practice with an everyday pen — no special nib needed. A good place to start.' },
  cut: { label: 'Cut pen', text: 'Practice with a cut (qalam) nib on your mistar size.' },
  other: { label: 'Other', text: 'More courses from your teachers.' },
};

// ---------------------------------------------------------------- transliteration
/** Simple, readable spellings for words used in course and level names. Keys are normalised Arabic. */
const WORDS: Record<string, string> = {
  'العرس': 'al-Urs', 'عرس': 'Urs', 'المئوي': "al-Mi'awi", 'المىوي': "al-Mi'awi",
  'فن': 'Fann', 'الفن': 'al-Fann', 'فنون': 'Funun', 'الخط': 'al-Khat', 'خط': 'Khat', 'تحسين': 'Tehseen',
  'اسلوب': 'Uslub', 'الاسلوب': 'al-Uslub', 'الكتابة': 'al-Kitabah', 'كتابة': 'Kitabah', 'الكتابه': 'al-Kitabah',
  'الاول': 'al-Awwal', 'الثاني': 'al-Thani', 'الثانى': 'al-Thani', 'الثالث': 'al-Thalith',
  'القصائد': 'al-Qasaid', 'قصائد': 'Qasaid', 'الشريفة': 'al-Sharifa', 'الشريفه': 'al-Sharifa', 'شريفة': 'Sharifa',
  'النسخ': 'al-Naskh', 'نسخ': 'Naskh', 'الثلث': 'al-Thuluth', 'ثلث': 'Thuluth', 'الرقعة': "al-Ruq'ah", 'رقعة': "Ruq'ah",
  'النستعليق': "al-Nasta'liq", 'نستعليق': "Nasta'liq", 'الديواني': 'al-Diwani', 'الكوفي': 'al-Kufi',
  'المشق': 'al-Mashq', 'مشق': 'Mashq', 'الحروف': 'al-Huruf', 'حروف': 'Huruf', 'الوصل': 'al-Wasl', 'وصل': 'Wasl',
  'مفردات': 'Mufradat', 'المفردات': 'al-Mufradat', 'مركبات': 'Murakkabat', 'المركبات': 'al-Murakkabat',
  'كلمات': 'Kalimat', 'الكلمات': 'al-Kalimat', 'كلمة': 'Kalimah', 'سطر': 'Satr', 'السطر': 'al-Satr', 'اسطر': 'Astur',
  'جملة': 'Jumlah', 'جمل': 'Jumal', 'روضة': 'Raudat', 'روضه': 'Raudat', 'الهدايات': 'al-Hidayat', 'هدايات': 'Hidayat',
  'استنساخ': 'Istinsakh', 'القران': 'al-Quran', 'قران': 'Quran', 'و': 'wa', 'في': 'fi', 'من': 'min',
};
const DIGITS: Record<string, string> = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9' };

function normaliseArabic(word: string): string {
  return word
    .replace(/[ً-ٰٟـ]/g, '') // tashkeel, superscript alif, tatweel
    .replace(/[أإآٱ]/g, 'ا');
}

/** Latin spelling of an Arabic name, or null when any word is unknown (we never guess). */
export function transliterate(arabic: string | null | undefined): string | null {
  if (!arabic || !/[؀-ۿ]/.test(arabic)) return null;
  const words = arabic.trim().split(/\s+/);
  const out: string[] = [];
  for (const raw of words) {
    if (/^[٠-٩0-9]+$/.test(raw)) { out.push(raw.replace(/[٠-٩]/g, d => DIGITS[d])); continue; }
    const key = normaliseArabic(raw.replace(/[،,.()«»]/g, ''));
    const hit = WORDS[key];
    if (!hit) return null;
    out.push(hit);
  }
  const text = out.join(' ');
  // "al-Urs al-Mi'awi" keeps its lower-case article, exactly as the admin writes it elsewhere (audit 27)
  if (/^al-/.test(text)) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const ENGLISH_WORDS = /\b(course|crash|worksheets?|mashq worksheets|certification|style|level|writing|practice|book|the|of|and|for)\b/i;
const KIND_WORDS = /\s*\b(crash course|course|mashq worksheets|worksheets|certification)\b\s*$/i;

/** The course name in Latin letters: the admin's own spelling when it already is one, else from the Arabic. */
export function courseName(course: { title: string; titleAr?: string | null }): string {
  const title = (course.title ?? '').trim();
  if (title && !ENGLISH_WORDS.test(title)) return title;
  const fromArabic = transliterate(course.titleAr);
  if (fromArabic) return fromArabic;
  const stripped = title.replace(KIND_WORDS, '').trim();
  return stripped || title || 'Course';
}

// ---------------------------------------------------------------- style (al-Uslub)
export function styleOf(course: { title: string; titleAr?: string | null }): 1 | 2 | null {
  const text = `${course.title} ${course.titleAr ?? ''}`;
  if (/أسلوب[^,،)]*?(٢|2|الثاني|الثانى)|style\s*(two|2)\b/i.test(text)) return 2;
  if (/أسلوب[^,،)]*?(١|1|الأول|الاول)|style\s*(one|1)\b/i.test(text)) return 1;
  return null;
}
export const STYLE_TEXT: Record<1 | 2, { num: string; ar: string; latin: string }> = {
  1: { num: '١', ar: 'الأسلوب الأول', latin: 'al-Uslub al-Awwal' },
  2: { num: '٢', ar: 'الأسلوب الثاني', latin: 'al-Uslub al-Thani' },
};

/** Removes "Prepared in Nairobi…", "written in Karachi, designed in Nairobi" style lines. */
export function cleanDescription(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .split(/(?<=[.!؟?])\s+/)
    .filter(sentence => !/\b(prepared|written|designed|made|compiled)\s+(in|at|by)\b/i.test(sentence))
    .filter(sentence => !/^downloadable worksheets only\.?$/i.test(sentence.trim()))
    .join(' ')
    .trim();
}

export const hasArabic = (text: string | null | undefined): boolean => /[؀-ۿ]/.test(text ?? '');

// ---------------------------------------------------------------- steps and levels
export type StepStatus = 'todo' | 'done' | 'waiting' | 'passed' | 'revision' | 'replied';

export function isUploadType(type: StepTypeDef | undefined, step?: Step): boolean {
  if (type) return type.studentAction === 'upload' || type.studentAction === 'download_upload';
  return step ? ['assessment', 'istinsakh', 'final_submission'].includes(step.stepType) : false;
}

export function statusOfStep(course: StudentCourse, step: Step, types: Map<string, StepTypeDef>): StepStatus {
  const state = course.stepStates[step.id];
  const type = types.get(step.stepType);
  if (isUploadType(type, step)) {
    const status = state?.submissionStatus ?? null;
    if (status === 'passed') return 'passed';
    if (status === 'reviewed') return 'replied';
    if (status === 'revision') return 'revision';
    if (status === 'submitted' || status === 'in_review') return 'waiting';
    return state?.done ? 'done' : 'todo';
  }
  return state?.done ? 'done' : 'todo';
}

/**
 * v3: the automatic 96-hour mark is provisional — a mark on work that is still with the teacher.
 * The backend sends `provisional: true`; the fallback (mark on open work) covers older responses.
 */
export function isProvisionalState(state: { submissionStatus?: string | null; mark?: number | null; provisional?: boolean } | undefined | null): boolean {
  if (!state) return false;
  if (state.provisional === true) return true;
  return state.mark != null && (state.submissionStatus === 'submitted' || state.submissionStatus === 'in_review');
}
export const PROVISIONAL_WORDS = 'your teacher will confirm';

export const STATUS_WORDS: Record<StepStatus, string> = {
  todo: 'To do', done: 'Done', waiting: 'With your teacher', passed: 'Passed', revision: 'Try once more', replied: 'Teacher replied',
};
export const isFinished = (status: StepStatus) => status === 'done' || status === 'passed' || status === 'replied';

/** What a step is, in one or two words a child understands. */
export function stepKindWords(step: Step, type: StepTypeDef | undefined): string {
  switch (step.stepType) {
    case 'assessment': return 'Assessment · marked out of 10';
    case 'final_submission': return 'Final submission';
    case 'istinsakh': return 'Send for comments';
    case 'video': return 'Video';
    case 'reference': return 'Reference';
    default: return type?.studentAction === 'watch_download' || !type ? 'Practice sheet' : type.label;
  }
}

export function stepTitle(step: Step, position: number, type: StepTypeDef | undefined): string {
  const title = (step.title ?? '').trim();
  if (title) return title;
  if (step.stepType === 'final_submission') return 'Send all your sheets';
  if (step.stepType === 'assessment') return 'Assessment';
  return `${type?.studentAction === 'watch_download' || !type ? 'Worksheet' : type.label} ${position}`;
}

export type LevelState = {
  level: Level;
  number: number;           // 1-based
  steps: { step: Step; number: number; status: StepStatus; title: string; kind: string }[];
  unlocked: boolean;
  completed: boolean;
  doneSteps: number;
  totalSteps: number;
  awardsBadge: boolean;
  hasAssessment: boolean;
  lockedReason: string;
};

export type NextStep = { levelState: LevelState; step: Step; number: number; title: string; status: StepStatus };

export type CourseState = {
  course: StudentCourse;
  kind: CourseKind;
  types: Map<string, StepTypeDef>;
  flat: boolean;            // no visible levels (crash / mashq)
  levels: LevelState[];
  currentLevel: LevelState | null;
  next: NextStep | null;
  waiting: NextStep[];      // sent, teacher has not replied yet
  unread: NextStep[];       // teacher replied, not read
  completed: boolean;
  levelsPassed: number;
  stepsDone: number;
  stepsTotal: number;
  percent: number;
  worksheetCount: number;
  hasFinal: boolean;
  badgeLevels: number;
};

export function buildCourseState(course: StudentCourse): CourseState {
  const types = new Map(course.stepTypes.map(type => [type.typeKey, type]));
  const kind = courseKind(course.courseType);
  const flat = course.levels.length <= 1 && (kind === 'crash' || kind === 'mashq' || !course.levels[0]?.description);
  const levels: LevelState[] = course.levels.map((level, index) => {
    const steps = level.steps.map((step, i) => {
      const type = types.get(step.stepType);
      return { step, number: i + 1, status: statusOfStep(course, step, types), title: stepTitle(step, i + 1, type), kind: stepKindWords(step, type) };
    });
    const gates = level.steps.filter(step => types.get(step.stepType)?.gatesProgress);
    const doneSteps = steps.filter(item => isFinished(item.status)).length;
    const completed = gates.length > 0
      ? gates.every(step => course.stepStates[step.id]?.submissionStatus === 'passed')
      : steps.length > 0 && doneSteps === steps.length;
    return {
      level, number: index + 1, steps,
      unlocked: course.unlockedLevelIds.includes(level.id),
      completed, doneSteps, totalSteps: steps.length,
      awardsBadge: level.steps.some(step => types.get(step.stepType)?.awardsBadge),
      hasAssessment: gates.length > 0,
      lockedReason: index === 0 ? 'Opens soon' : `Opens when you pass Level ${index}`,
    };
  });
  const currentLevel = levels.find(info => info.unlocked && !info.completed) ?? null;
  let next: NextStep | null = null;
  const waiting: NextStep[] = [];
  const unread: NextStep[] = [];
  for (const info of levels) {
    for (const item of info.steps) {
      const entry = { levelState: info, step: item.step, number: item.number, title: item.title, status: item.status };
      if (item.status === 'waiting') waiting.push(entry);
      if ((course.stepStates[item.step.id]?.unreadMessages ?? 0) > 0) unread.push(entry);
    }
    if (!next && info.unlocked && !info.completed) {
      const found = info.steps.find(item => item.status === 'revision') ?? info.steps.find(item => item.status === 'todo');
      if (found) next = { levelState: info, step: found.step, number: found.number, title: found.title, status: found.status };
    }
  }
  const allSteps = levels.flatMap(info => info.steps);
  const stepsDone = allSteps.filter(item => isFinished(item.status)).length;
  const levelsPassed = levels.filter(info => info.completed).length;
  const completed = levels.length > 0 && levels.every(info => info.completed);
  const percent = Math.max(0, Math.min(100, Math.round(course.progressPercent ?? (allSteps.length ? (stepsDone / allSteps.length) * 100 : 0))));
  return {
    course, kind, types, flat, levels, currentLevel, next, waiting, unread, completed, levelsPassed, stepsDone,
    stepsTotal: allSteps.length, percent,
    worksheetCount: allSteps.filter(item => !isUploadType(types.get(item.step.stepType), item.step)).length,
    hasFinal: allSteps.some(item => item.step.stepType === 'final_submission'),
    badgeLevels: levels.filter(info => info.awardsBadge && info.hasAssessment).length,
  };
}

/** "Level 2 · Step 1" (or just "Step 1" for courses without levels). */
export function placeWords(state: CourseState, next: { levelState: LevelState; number: number }): string {
  return state.flat ? `Step ${next.number}` : `Level ${next.levelState.number} · Step ${next.number}`;
}

/** Small facts line for a course card (owner's wording, E 1.1). */
export function courseFacts(state: CourseState | null, summary: CourseSummary): string[] {
  const kind = courseKind(summary.courseType);
  if (!state) {
    if (kind === 'certification') return [`${summary.counts.levels} ${summary.counts.levels === 1 ? 'level' : 'levels'}`, 'a badge after each level', '1 certificate at the end'];
    return [`${summary.counts.steps} ${summary.counts.steps === 1 ? 'step' : 'steps'}`];
  }
  if (kind === 'certification' || !state.flat) {
    const facts = [`${state.levels.length} ${state.levels.length === 1 ? 'level' : 'levels'}`];
    if (state.badgeLevels > 0) facts.push(state.badgeLevels === state.levels.length ? 'a badge after each level' : `${state.badgeLevels} level ${state.badgeLevels === 1 ? 'badge' : 'badges'}`);
    if (kind === 'certification') facts.push('1 certificate at the end');
    return facts;
  }
  const facts: string[] = [];
  if (state.worksheetCount) facts.push(`${state.worksheetCount} ${state.worksheetCount === 1 ? 'worksheet' : 'worksheets'}`);
  if (state.hasFinal) facts.push('one final submission at the end');
  if (state.hasFinal) facts.push('a badge when you finish');
  if (!facts.length) facts.push(`${state.stepsTotal} ${state.stepsTotal === 1 ? 'step' : 'steps'}`);
  return facts;
}

// ---------------------------------------------------------------- dates
export function daysAgoWords(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return 'Started today';
  if (days === 1) return 'Started yesterday';
  return `Started ${days} days ago`;
}

/** Read the enrolment date if the server sends one (enrolledAt / startedAt). */
export function enrolledAtOf(course: StudentCourse): string | null {
  const extra = course as StudentCourse & { enrolledAt?: string | null; startedAt?: string | null };
  return extra.enrolledAt ?? extra.startedAt ?? null;
}

// ---------------------------------------------------------------- badges
export type BadgeWithArt = StudentBadge & { artworkUrl?: string | null; downloadUrl?: string | null };

export function badgeTitle(badge: StudentBadge, courses: Map<string, StudentCourse>): { title: string; sub: string | null; subIsArabic: boolean } {
  const course = badge.courseId ? courses.get(badge.courseId) : undefined;
  const name = course ? courseName(course) : null;
  if (badge.kind === 'competition') {
    const parts = badge.label.split(/\s+—\s+/);
    return { title: parts.length > 1 ? parts.slice(1).join(' — ') : badge.label, sub: 'Competition award', subIsArabic: false };
  }
  if (badge.kind === 'course') {
    const cert = course ? courseKind(course.courseType) === 'certification' : /certification/i.test(badge.label);
    return { title: name ?? badge.label.replace(/\s+—.*$/, ''), sub: cert ? 'Certificate · course complete' : 'Course complete', subIsArabic: false };
  }
  if (course && badge.levelId) {
    const index = course.levels.findIndex(level => level.id === badge.levelId);
    const level = course.levels[index];
    if (level) return { title: `${name} · Level ${index + 1}`, sub: level.description ?? null, subIsArabic: hasArabic(level.description) };
  }
  const match = /LV0*(\d+)/i.exec(badge.label);
  const arabic = badge.label.split(/\s+—\s+/)[1] ?? null;
  return { title: `${name ?? 'Level badge'}${match ? ` · Level ${match[1]}` : ''}`, sub: arabic, subIsArabic: hasArabic(arabic) };
}

/** "FNK-C101 · LV01 · S05" → "Fann al-Khat 1 · Level 1 · Step 5" for marks lists. */
export function friendlyWorkLabel(label: string, courseId: string | null, courses: Map<string, StudentCourse>): string {
  const course = courseId ? courses.get(courseId) : undefined;
  const lv = /LV0*(\d+)/i.exec(label);
  const st = /\bS0*(\d+)\b/i.exec(label);
  const name = course ? courseName(course) : label.split('·')[0].replace(/[A-Z]{2,5}-[A-Z]\d{3}/, '').trim() || 'Course';
  if (!lv && !st) return name;
  const flat = course ? course.levels.length <= 1 : false;
  return [name, lv && !flat ? `Level ${lv[1]}` : null, st ? `Step ${st[1]}` : null].filter(Boolean).join(' · ');
}
