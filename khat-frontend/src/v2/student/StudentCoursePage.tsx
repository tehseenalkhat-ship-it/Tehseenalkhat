// owner: student-dash (v3). The course window (route v2-course): what the course is, the levels as
// clear cards, and the steps of the chosen level. Each step opens on its own task page (v2-task).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Award, Check, ChevronRight, Clock, ListChecks, Lock, Medal, MessageCircle, PenLine, Printer, RefreshCw } from 'lucide-react';
import { apiFetch } from '@/api';
import { navigate, PenLoader } from '@/components/ui';
import type { StudentCourse } from '../contracts';
import { readV2Param } from '../nav';
import { SizePicker } from './SizePicker';
import { EmptyState, ensureAmiri, errorMessage, fetchPdf, InlineError, openBlob, saveBlob, Sheet, sizeLabel, sortSizes } from './shared';
import { BadgeSheet } from './home/BadgeSheet';
import { GreenBar, openTask, StyleTag } from './home/CourseCard';
import { loadMyBadges } from './home/useStudentCourses';
import {
  badgeTitle, buildCourseState, cleanDescription, courseFacts, courseName, daysAgoWords, enrolledAtOf, hasArabic, isFinished, KIND_LABEL,
  isProvisionalState, PEN_TEXT, penKind, placeWords, PROVISIONAL_WORDS, STATUS_WORDS, transliterate, type BadgeWithArt, type LevelState, type StepStatus,
} from './home/studentText';
import './student-v2.css';
import './home/v3-student.css';

type Props = Record<string, never>;
const LOCAL_SIZE_KEY = 'khat.v2.mistarSize';

export function V2StudentCoursePage(_props: Props) {
  const [courseId] = useState(() => readV2Param('courseId'));
  const [deepStepId] = useState(() => readV2Param('stepId'));
  const [course, setCourse] = useState<StudentCourse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [badges, setBadges] = useState<BadgeWithArt[]>([]);
  const [openBadge, setOpenBadge] = useState<BadgeWithArt | null>(null);
  const [selectedLevelId, setSelectedLevelId] = useState<string | null>(null);
  const [localSize, setLocalSize] = useState<string | null>(() => localStorage.getItem(LOCAL_SIZE_KEY));
  const [sizeOpen, setSizeOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [bundling, setBundling] = useState(false);
  const [ready, setReady] = useState<{ blob: Blob; filename: string; count: number } | null>(null);
  const initialised = useRef(false);

  useEffect(() => { ensureAmiri(); }, []);

  const load = useCallback(async (silent = false) => {
    if (!courseId) return;
    if (!silent) setLoading(true);
    setError(null);
    try {
      setCourse(await apiFetch<StudentCourse>(`/v2/student/courses/${courseId}`, { silent }));
      loadMyBadges().then(setBadges).catch(() => undefined);
    } catch (err) {
      if (!silent) setError(errorMessage(err, 'This course could not be opened right now.'));
    } finally { setLoading(false); }
  }, [courseId]);
  useEffect(() => { void load(); }, [load]);

  const state = useMemo(() => (course ? buildCourseState(course) : null), [course]);

  const courseSizes = useMemo(() => {
    if (!course) return [] as string[];
    const fromFiles = course.levels.flatMap(level => level.steps.flatMap(step => step.files.map(file => file.sizeCode).filter((code): code is string => Boolean(code))));
    return sortSizes([...(course.mistarSizes ?? []), ...fromFiles]);
  }, [course]);
  const rememberOnServer = Boolean(course?.policies?.['student.choose_one_size']);
  const size = (() => {
    const preferred = (rememberOnServer ? course?.mySize : null) ?? localSize ?? course?.mySize ?? null;
    if (preferred && (courseSizes.length === 0 || courseSizes.includes(preferred.toUpperCase()))) return preferred.toUpperCase();
    if (courseSizes.length === 1) return courseSizes[0];
    return null;
  })();

  // First load: show the level the student is on (or the deep-linked step's level).
  useEffect(() => {
    if (!state || initialised.current) return;
    initialised.current = true;
    const deepLevel = deepStepId ? state.levels.find(info => info.steps.some(item => item.step.id === deepStepId)) : null;
    setSelectedLevelId(deepLevel?.level.id ?? state.currentLevel?.level.id ?? state.levels.find(info => info.unlocked)?.level.id ?? state.levels[0]?.level.id ?? null);
    if (deepLevel && deepStepId) window.setTimeout(() => document.getElementById(`v3-sd-step-${deepStepId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 400);
  }, [state, deepStepId]);

  const chooseSize = async (next: string) => {
    localStorage.setItem(LOCAL_SIZE_KEY, next);
    setLocalSize(next);
    if (rememberOnServer) {
      await apiFetch('/v2/student/preferences', { method: 'PATCH', body: { mistarSize: next } });
      setCourse(current => (current ? { ...current, mySize: next } : current));
    }
  };

  const start = async () => {
    if (!course || starting) return;
    setStarting(true); setActionError(null);
    try {
      if (!course.enrolled) await apiFetch(`/v2/student/courses/${course.id}/enroll`, { method: 'POST' });
      const first = course.levels[0]?.steps[0];
      if (state?.kind === 'mashq') openTask(course.id, null);
      else if (first) openTask(course.id, first.id); else await load(true);
    } catch (err) {
      setActionError(errorMessage(err, 'We could not start this course. Please try again.'));
    } finally { setStarting(false); }
  };

  const printLevel = async (info: LevelState) => {
    if (!course) return;
    if (!size && courseSizes.length > 1) { setSizeOpen(true); return; }
    const fileIds = info.level.steps.flatMap(step => {
      const sheets = step.files.filter(file => file.isCurrent !== false && (file.role === 'worksheet' || file.role === 'assessment_sheet' || file.role === 'resource'));
      const forSize = sheets.filter(file => !file.sizeCode || !size || file.sizeCode.toUpperCase() === size);
      return forSize.map(file => file.id);
    });
    if (fileIds.length === 0) return;
    setBundling(true); setActionError(null);
    try {
      const { blob, filename } = await fetchPdf('/v2/downloads/bundle', { method: 'POST', body: { fileIds }, fallbackName: `${courseName(course).replace(/\W+/g, '-')}_Level-${info.number}_worksheets.pdf` });
      setReady({ blob, filename, count: fileIds.length });
    } catch (err) {
      setActionError(errorMessage(err, 'Your sheets could not be put together. Please try again.'));
    } finally { setBundling(false); }
  };

  if (!courseId) {
    return <main className="page portal-page v3-sd-page"><EmptyState icon={<ListChecks size={22} />} title="Choose a course first" text="Open a course from your dashboard to see its levels and steps." action={<button type="button" className="v3-sd-btn is-solid" onClick={() => navigate('v2-home')}>Go to my dashboard</button>} /></main>;
  }
  if (loading && !course) return <main className="page portal-page v3-sd-page"><PenLoader label="Opening your course…" /></main>;
  if (error || !course || !state) {
    return <main className="page portal-page v3-sd-page"><button type="button" className="v3-sd-link" onClick={() => navigate('v2-home')}><ArrowLeft size={16} /> My dashboard</button><InlineError message={error ?? 'This course could not be opened.'} onRetry={() => void load()} /></main>;
  }

  const name = courseName(course);
  const pen = penKind(course.penType);
  const description = cleanDescription(course.description);
  const facts = courseFacts(state, { ...course });
  const started = daysAgoWords(enrolledAtOf(course));
  const allowMulti = course.policies?.['print.allow_multi'] !== false;
  const printInstructions = String(course.policies?.['print.instructions'] ?? '');
  const courseMap = new Map([[course.id, course]]);
  const myBadges = badges.filter(badge => badge.courseId === course.id);
  const badgeFor = (info: LevelState) => myBadges.find(badge => badge.kind === 'level' && (badge.levelId === info.level.id || (info.level.badgeCode && badge.badgeCode.toUpperCase() === info.level.badgeCode.toUpperCase())));
  const courseBadge = myBadges.find(badge => badge.kind === 'course');
  const isCertification = state.kind === 'certification';
  const selected = state.flat ? state.levels[0] : state.levels.find(info => info.level.id === selectedLevelId) ?? null;
  const firstWaiting = state.waiting[0];

  const selectLevel = (info: LevelState) => {
    setSelectedLevelId(info.level.id);
    window.setTimeout(() => document.getElementById('v3-sd-steps')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 40);
  };

  const levelAction = (info: LevelState) => {
    const isCurrent = state.currentLevel?.level.id === info.level.id;
    const next = info.steps.find(item => item.status === 'revision') ?? info.steps.find(item => item.status === 'todo');
    if (!course.enrolled) return null;
    if (info.completed) return null;
    if (!info.unlocked) return null;
    if (!next) return <button type="button" className="v3-sd-btn is-outline" onClick={() => selectLevel(info)}>See steps</button>;
    const label = info.doneSteps === 0 && next.status === 'todo' ? 'Start' : 'Continue';
    return isCurrent
      ? <button type="button" className="v3-sd-btn is-solid" onClick={() => openTask(course.id, next.step.id)}>{label} <ArrowRight size={16} /></button>
      : <button type="button" className="v3-sd-btn is-outline" onClick={() => openTask(course.id, next.step.id)}>{label}</button>;
  };

  return (
    <main className="page portal-page v3-sd-page v3-sd-course">
      <div className="v3-sd-course-back">
        <button type="button" className="v3-sd-link" onClick={() => navigate('v2-home')}><ArrowLeft size={16} /> My dashboard</button>
      </div>

      {actionError && <InlineError message={actionError} />}

      {/* ---------- what this course is ---------- */}
      <section className="v3-sd-course-hero" aria-labelledby="v3-sd-course-title">
        <div className="v3-sd-course-ident">
          <StyleTag course={course} />
          <div className="v3-sd-tags">
            <span className="v3-sd-tag">{KIND_LABEL[state.kind]}</span>
            {pen !== 'other' && <span className={`v3-sd-tag is-${pen}`}><PenLine size={13} aria-hidden="true" /> {PEN_TEXT[pen].label}</span>}
            {course.status === 'held' && <span className="v3-sd-tag">Paused for new students</span>}
          </div>
          {course.titleAr && <p className="v3-sd-title-ar v3-sd-ar" lang="ar" dir="rtl">{course.titleAr}</p>}
          <h1 id="v3-sd-course-title">{name}</h1>
          {description && <p className="v3-sd-desc">{description}</p>}
          <p className="v3-sd-facts">{facts.join(' · ')}</p>
        </div>

        <aside className="v3-sd-panel" aria-label="Your place in this course">
          {!course.enrolled ? (
            <>
              <p>You have not started yet. Tap <strong>Start</strong> and we will open your first task.</p>
              <button type="button" className="v3-sd-btn is-solid is-big" onClick={() => void start()} disabled={starting}>{starting ? 'Starting…' : 'Start this course'} <ArrowRight size={17} /></button>
            </>
          ) : state.completed ? (
            <>
              <p className="v3-sd-done-line"><Check size={16} strokeWidth={3} /> You finished this course. Well done!</p>
              <GreenBar percent={100} label="Course progress" />
              {courseBadge && <button type="button" className="v3-sd-badge-earned" onClick={() => setOpenBadge(courseBadge)}><Medal size={16} /> {isCertification ? 'Certificate earned — open' : 'Badge earned — open'}</button>}
            </>
          ) : (
            <>
              <div className="v3-sd-panel-big"><strong>{state.percent}%</strong><span>done{!state.flat ? ` · ${state.levelsPassed} of ${state.levels.length} levels passed` : ` · ${state.stepsDone} of ${state.stepsTotal} steps`}</span></div>
              <GreenBar percent={state.percent} label="Course progress" />
              {state.next ? (
                <>
                  <button type="button" className="v3-sd-btn is-solid is-big" onClick={() => openTask(course.id, state.kind === 'mashq' ? null : state.next!.step.id)}>Continue <ArrowRight size={17} /></button>
                  <p className="v3-sd-next-line">Next: <strong>{placeWords(state, state.next)}</strong> — {state.next.title}</p>
                </>
              ) : firstWaiting ? (
                <>
                  {isProvisionalState(course.stepStates[firstWaiting.step.id])
                    ? <p className="v3-sd-next-line"><Clock size={14} aria-hidden="true" /> <strong>{placeWords(state, firstWaiting)}</strong>: Marked {course.stepStates[firstWaiting.step.id]?.mark}/10 · {PROVISIONAL_WORDS}. Read the message in the chat.</p>
                    : <p className="v3-sd-next-line"><Clock size={14} aria-hidden="true" /> <strong>{placeWords(state, firstWaiting)}</strong> is with your teacher. You will usually get a reply within 3 days — it will come in the chat.</p>}
                  <button type="button" className="v3-sd-btn is-outline" onClick={() => openTask(course.id, firstWaiting.step.id)}><MessageCircle size={16} /> Open the chat</button>
                </>
              ) : null}
              {started && <div className="v3-sd-panel-meta"><span>{started}</span></div>}
            </>
          )}
          {courseSizes.length > 1 && (
            <p className="v3-sd-size-line">Your mistar size: <strong>{size ? sizeLabel(size) : 'not chosen yet'}</strong>
              <button type="button" className="v3-sd-link" onClick={() => setSizeOpen(true)}>{size ? 'Change' : 'Choose'}</button>
            </p>
          )}
        </aside>
      </section>

      {/* ---------- levels ---------- */}
      {!state.flat && (
        <section className="v3-sd-section" aria-labelledby="v3-sd-levels-title">
          <div className="v3-sd-section-head">
            <h2 id="v3-sd-levels-title">Levels</h2>
            <p>Each level opens when you pass the level before it. Tap a level to see its steps.</p>
          </div>
          <div className="v3-sd-level-grid">
            {state.levels.map(info => {
              const isCurrent = course.enrolled && state.currentLevel?.level.id === info.level.id;
              const badge = badgeFor(info);
              const latin = transliterate(info.level.description);
              const percent = info.totalSteps ? Math.round((info.doneSteps / info.totalSteps) * 100) : 0;
              return (
                <article key={info.level.id} className={`v3-sd-level-card${info.completed ? ' is-done' : ''}${!info.unlocked ? ' is-locked' : ''}${isCurrent ? ' is-current' : ''}${selected?.level.id === info.level.id ? ' is-selected' : ''}`}>
                  <div className="v3-sd-level-top">
                    <span className="v3-sd-level-no">Level {info.number}</span>
                    {info.completed ? <span className="v3-sd-state is-done"><Check size={13} strokeWidth={3} /> Completed</span>
                      : !info.unlocked ? <span className="v3-sd-state"><Lock size={12} /> Locked</span>
                        : isCurrent ? <span className="v3-sd-state is-going">In progress</span>
                          : <span className="v3-sd-state">Open</span>}
                  </div>
                  {info.level.description && (
                    <>
                      <p className={`v3-sd-level-ar${hasArabic(info.level.description) ? ' v3-sd-ar' : ''}`} lang={hasArabic(info.level.description) ? 'ar' : undefined} dir="auto">{info.level.description}</p>
                      {latin && <p className="v3-sd-level-latin">{latin}</p>}
                    </>
                  )}
                  <p className="v3-sd-level-steps-count">{info.totalSteps} {info.totalSteps === 1 ? 'step' : 'steps'} in this level{info.hasAssessment ? ' · ends with an assessment' : ''}</p>
                  {info.unlocked && course.enrolled && (
                    <div className="v3-sd-level-progress"><GreenBar percent={percent} label={`Level ${info.number} progress`} /><span>{info.doneSteps} of {info.totalSteps} done</span></div>
                  )}
                  {!info.unlocked && <p className="v3-sd-level-lock"><Lock size={14} aria-hidden="true" /> {info.lockedReason}</p>}
                  <div className="v3-sd-level-actions">
                    {badge && <button type="button" className="v3-sd-badge-earned" onClick={() => setOpenBadge(badge)}><Award size={16} /> Badge earned</button>}
                    {levelAction(info)}
                    {info.unlocked && selected?.level.id !== info.level.id && <button type="button" className="v3-sd-btn is-ghost" onClick={() => selectLevel(info)}>See steps</button>}
                  </div>
                </article>
              );
            })}
            {(isCertification || state.hasFinal) && (
              <article className="v3-sd-finish-card">
                <span className="v3-sd-kind">At the end</span>
                <h3>{isCertification ? 'Your certificate' : 'Course badge'}</h3>
                <p>{isCertification ? 'Pass every level and you receive your certificate — 1 certificate for the whole course.' : 'Send your final submission and you receive the course badge.'}</p>
                {courseBadge && <button type="button" className="v3-sd-badge-earned" onClick={() => setOpenBadge(courseBadge)}><Medal size={16} /> {isCertification ? 'Certificate earned' : 'Badge earned'}</button>}
              </article>
            )}
          </div>
        </section>
      )}

      {/* ---------- steps of the chosen level ---------- */}
      <section className="v3-sd-section" id="v3-sd-steps" aria-labelledby="v3-sd-steps-title">
        {state.stepsTotal === 0 ? (
          <EmptyState icon={<ListChecks size={22} />} title="Lessons are on their way" text="Your teachers are still adding the steps of this course. Please check again soon." />
        ) : selected && (
          <>
            <div className="v3-sd-steps-head">
              <div>
                <h2 id="v3-sd-steps-title">
                  {state.flat ? (state.kind === 'mashq' ? 'Worksheets' : 'Steps') : `Level ${selected.number} steps`}
                  {!state.flat && selected.level.description && <><span aria-hidden="true">·</span><span className={hasArabic(selected.level.description) ? 'v3-sd-ar' : ''} dir="auto">{selected.level.description}</span></>}
                </h2>
                <p>{selected.unlocked ? insideText(state.kind, selected.steps.map(item => item.step), course.stepTypes) : selected.lockedReason + '.'}</p>
              </div>
              {allowMulti && course.enrolled && selected.unlocked && selected.steps.filter(item => item.step.files.some(file => file.role === 'worksheet')).length > 1 && (
                <div className="v3-sd-steps-tools">
                  <button type="button" className="v3-sd-btn is-outline" onClick={() => void printLevel(selected)} disabled={bundling}>
                    {bundling ? <><RefreshCw size={15} className="v2s-spin" /> Preparing…</> : <><Printer size={15} /> Print all sheets{state.flat ? '' : ' of this level'}</>}
                  </button>
                </div>
              )}
            </div>
            <ol className="v3-sd-step-list">
              {selected.steps.map(item => {
                const isNext = course.enrolled && state.next?.step.id === item.step.id;
                const unread = course.stepStates[item.step.id]?.unreadMessages ?? 0;
                const mark = course.stepStates[item.step.id]?.mark;
                const provisional = isProvisionalState(course.stepStates[item.step.id]);
                return (
                  <li key={item.step.id}>
                    <button type="button" id={`v3-sd-step-${item.step.id}`} className={`v3-sd-step-row${isNext ? ' is-next' : ''}`} disabled={!selected.unlocked} onClick={() => openTask(course.id, item.step.id)}>
                      <StepDot status={item.status} number={item.number} />
                      <span className="v3-sd-step-copy">
                        <strong>{item.title}</strong>
                        <small>Step {item.number} · {item.kind}</small>
                      </span>
                      <span className="v3-sd-step-side">
                        {unread > 0 && <span className="v3-sd-step-unread"><MessageCircle size={12} /> {unread} new</span>}
                        {mark != null && !provisional && <span className="v3-sd-mark">{mark}<small>/10</small></span>}
                        {provisional
                          ? <span className="v3-sd-step-status is-provisional">Marked {mark}/10 · {PROVISIONAL_WORDS}</span>
                          : <span className={`v3-sd-step-status${isFinished(item.status) ? ' is-done' : isNext ? ' is-next' : ''}`}>{isNext ? (item.status === 'revision' ? 'Try once more' : 'Next') : STATUS_WORDS[item.status]}</span>}
                      </span>
                      {selected.unlocked ? <ChevronRight size={18} aria-hidden="true" /> : <Lock size={16} aria-hidden="true" />}
                    </button>
                  </li>
                );
              })}
            </ol>
          </>
        )}
      </section>

      {ready && (
        <Sheet title="Your PDF is ready" onClose={() => setReady(null)}>
          <p className="v2s-sheet-lead">{ready.count} {ready.count === 1 ? 'sheet' : 'sheets'} in one file, ready to print.</p>
          {printInstructions && <p className="v2s-print-note is-boxed"><Printer size={14} aria-hidden="true" /> {printInstructions}</p>}
          <div className="v2s-sheet-actions">
            <button type="button" className="v3-sd-btn is-outline" onClick={() => saveBlob(ready.blob, ready.filename)}>Save</button>
            <button type="button" className="v3-sd-btn is-outline" onClick={() => openBlob(ready.blob)}><Printer size={15} /> Open to print</button>
          </div>
        </Sheet>
      )}
      {sizeOpen && courseSizes.length > 0 && <SizePicker sizes={courseSizes} current={size} remember={rememberOnServer} onChoose={chooseSize} onClose={() => setSizeOpen(false)} />}
      {openBadge && (() => { const t = badgeTitle(openBadge, courseMap); return <BadgeSheet badge={openBadge} title={t.title} sub={t.sub} subIsArabic={t.subIsArabic} onClose={() => setOpenBadge(null)} />; })()}
    </main>
  );
}

function StepDot({ status, number }: { status: StepStatus; number: number }) {
  if (isFinished(status)) return <span className="v3-sd-step-dot is-done" aria-hidden="true"><Check size={17} strokeWidth={3} /></span>;
  if (status === 'waiting') return <span className="v3-sd-step-dot is-waiting" aria-hidden="true"><Clock size={16} /></span>;
  if (status === 'revision') return <span className="v3-sd-step-dot is-revision" aria-hidden="true">{number}</span>;
  return <span className="v3-sd-step-dot" aria-hidden="true">{number}</span>;
}

/** "Tap a step to open it — …": only names what is really inside (Mashq has no video). Audit 30. */
function insideText(kind: string | null | undefined, steps: { videoUrl?: string | null; stepType: string; files: { role: string }[] }[], types: { typeKey: string; studentAction?: string | null }[] | undefined): string {
  if (kind === 'mashq') return 'Tap a worksheet to open it, download it and practice on art paper. When you have practiced them all, send all your sheets together for assessment.';
  const inside: string[] = [];
  if (steps.some(s => s.videoUrl || s.files.some(f => f.role === 'video'))) inside.push('the video');
  if (steps.some(s => s.files.some(f => f.role === 'worksheet'))) inside.push('the worksheet');
  if (steps.some(s => s.files.some(f => f.role === 'reference'))) inside.push('the reference image');
  const uploads = steps.some(s => { const a = types?.find(t => t.typeKey === s.stepType)?.studentAction ?? ''; return /upload|submit/.test(a) || ['assessment', 'final_submission', 'istinsakh'].includes(s.stepType); });
  if (uploads) inside.push('the chat with your teacher');
  if (!inside.length) return 'Do them in order. Tap a step to open it.';
  const list = inside.length > 1 ? `${inside.slice(0, -1).join(', ')} and ${inside[inside.length - 1]}` : inside[0];
  return `Do them in order. Tap a step to open it — ${list} ${inside.length > 1 ? 'are' : 'is'} inside.`;
}
