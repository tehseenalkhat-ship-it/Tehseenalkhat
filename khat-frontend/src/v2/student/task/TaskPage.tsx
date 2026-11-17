import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, Award, Check, ChevronLeft, Clock3, Download, Info, Lock, MessageCircle, PlayCircle, Printer, RefreshCw, RotateCcw, Send, Sparkles } from 'lucide-react';
import { apiFetch } from '@/api';
import { PenLoader } from '@/components/ui';
import type { EffectivePolicies, Step, StepFile, StepTypeDef, StudentCourse, StudentStepState } from '../../contracts';
import { openV2, readV2Param, replaceV2Params } from '../../nav';
import { ThreadPanel } from '../../chat/ThreadPanel';
import { isUploadStep, pageLabel, sheetsForSize, stepStatus, type StepStatus } from '../CourseStepCard';
import { SizeChooser } from '../SizePicker';
import { courseName, isProvisionalState } from '../home/studentText';
import { ensureAmiri, errorMessage, fetchPdf, hasArabic, InlineError, pdfName, saveBlob, SignedVideo, sizeLabel, sortSizes } from '../shared';
import { SheetPreview } from './SheetPreview';
import { ZoomViewer } from './ZoomViewer';
import { buildTodo, courseKind, currentFiles, daysWord, flattenSteps, isDirectVideo, isMashqLike, penClass, replyDays, youtubeEmbed, youtubeId, type FlatStep, type TodoKey } from './taskLogic';
import '../student-v2.css';
import './task.css';

type Props = Record<string, never>;

const LOCAL_SIZE_KEY = 'khat.v2.mistarSize';
const DONE: StepStatus[] = ['done', 'passed', 'replied'];

type Zoom = { url: string; title: string; file: StepFile } | null;

/* ============================== data hook ============================== */

function useTaskCourse(courseId: string | null) {
  const [course, setCourse] = useState<StudentCourse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [policies, setPolicies] = useState<Partial<EffectivePolicies>>({});
  const [localSize, setLocalSize] = useState<string | null>(() => localStorage.getItem(LOCAL_SIZE_KEY));
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [enrolling, setEnrolling] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!courseId) { setLoading(false); return; }
    if (!silent) setLoading(true);
    try {
      setCourse(await apiFetch<StudentCourse>(`/v2/student/courses/${courseId}`, { silent }));
      setError(null);
    } catch (err) {
      if (!silent) setError(errorMessage(err, 'This task could not be opened right now.'));
    } finally { setLoading(false); }
  }, [courseId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { apiFetch<EffectivePolicies>('/v2/policies/effective', { silent: true }).then(setPolicies).catch(() => undefined); }, []);

  const typeMap = useMemo(() => new Map((course?.stepTypes ?? []).map(t => [t.typeKey, t])), [course?.stepTypes]);
  const typeOf = useCallback((step: Step): StepTypeDef | undefined => typeMap.get(step.stepType), [typeMap]);
  const statusOf = useCallback((step: Step): StepStatus => stepStatus(typeOf(step), course?.stepStates[step.id]), [typeOf, course?.stepStates]);

  const sizes = useMemo(() => {
    if (!course) return [] as string[];
    const fromFiles = course.levels.flatMap(l => l.steps.flatMap(s => s.files.map(f => f.sizeCode).filter((c): c is string => Boolean(c))));
    return sortSizes(fromFiles.length ? fromFiles : course.mistarSizes ?? []);
  }, [course]);

  const remember = Boolean(course?.policies?.['student.choose_one_size']);
  const size = (() => {
    const preferred = (remember ? course?.mySize : null) ?? localSize ?? course?.mySize ?? null;
    if (preferred && (sizes.length === 0 || sizes.includes(preferred.toUpperCase()))) return preferred.toUpperCase();
    if (sizes.length === 1) return sizes[0];
    return null;
  })();

  const chooseSize = async (next: string) => {
    localStorage.setItem(LOCAL_SIZE_KEY, next);
    setLocalSize(next);
    setCourse(c => (c ? { ...c, mySize: next } : c));
    if (remember) await apiFetch('/v2/student/preferences', { method: 'PATCH', body: { mistarSize: next }, silent: true });
  };

  const enroll = async (): Promise<boolean> => {
    if (!course) return false;
    if (course.enrolled) return true;
    setEnrolling(true); setNotice(null);
    try {
      await apiFetch(`/v2/student/courses/${course.id}/enroll`, { method: 'POST' });
      await load(true);
      return true;
    } catch (err) {
      setNotice(errorMessage(err, 'We could not start this course. Please try again.'));
      return false;
    } finally { setEnrolling(false); }
  };

  const download = async (file: StepFile, label: string) => {
    if (!(await enroll())) return;
    setDownloadingId(file.id); setNotice(null);
    try {
      const { blob, filename } = await fetchPdf(`/v2/downloads/step-file/${file.id}`, { fallbackName: pdfName(label) });
      saveBlob(blob, filename);
    } catch (err) {
      setNotice(errorMessage(err, 'This sheet could not be downloaded. Please try again.'));
    } finally { setDownloadingId(null); }
  };

  const setDone = async (step: Step, done: boolean) => {
    if (!course || !(await enroll())) return;
    const before = course.stepStates[step.id];
    const optimistic: StudentStepState = before ? { ...before, done } : { stepId: step.id, done, submissionStatus: null, mark: null, band: null, attemptsUsed: 0, unreadMessages: 0 };
    setCourse(c => (c ? { ...c, stepStates: { ...c.stepStates, [step.id]: optimistic } } : c));
    setNotice(null);
    try {
      await apiFetch(`/v2/student/steps/${step.id}/done`, { method: done ? 'POST' : 'DELETE', silent: true });
      void load(true);
    } catch (err) {
      setCourse(c => (c ? { ...c, stepStates: { ...c.stepStates, ...(before ? { [step.id]: before } : {}) } } : c));
      setNotice(errorMessage(err, 'That did not save. Please try again.'));
    }
  };

  return { course, loading, error, notice, setNotice, load, policies, typeOf, statusOf, sizes, size, chooseSize, enroll, enrolling, download, downloadingId, setDone };
}
type TaskData = ReturnType<typeof useTaskCourse>;

/* ============================== page ============================== */

export function V2TaskPage(_props: Props) {
  const [courseId] = useState(() => readV2Param('courseId'));
  const [stepId, setStepId] = useState<string | null>(() => readV2Param('stepId'));
  const data = useTaskCourse(courseId);
  const { course, loading, error, typeOf, statusOf } = data;

  useEffect(() => { ensureAmiri(); }, []);

  const flat = useMemo(() => (course ? flattenSteps(course) : []), [course]);
  const mashq = useMemo(() => (course ? isMashqLike(course, typeOf) : false), [course, typeOf]);

  // No step chosen (or it disappeared) → the student's next open step.
  const current: FlatStep | null = useMemo(() => {
    if (!course || flat.length === 0) return null;
    const chosen = stepId ? flat.find(f => f.step.id === stepId) : null;
    if (chosen) return chosen;
    const open = flat.filter(f => course.unlockedLevelIds.includes(f.level.id));
    return open.find(f => ['todo', 'revision'].includes(statusOf(f.step))) ?? open.find(f => statusOf(f.step) === 'waiting') ?? open[open.length - 1] ?? flat[0];
  }, [course, flat, stepId, statusOf]);

  const goTo = (id: string) => {
    replaceV2Params({ courseId, stepId: id });
    setStepId(id);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const backToCourse = () => openV2('v2-course', { courseId, stepId: current?.step.id ?? null });

  if (!courseId) {
    return (
      <div className="page portal-page v3t-task">
        <div className="v3t-card v3t-empty">
          <strong>Choose a course first</strong>
          <p>Open one of your courses from your dashboard, then tap a step to see what to do.</p>
          <button type="button" className="btn btn-primary" onClick={() => openV2('v2-home')}>Go to my dashboard</button>
        </div>
      </div>
    );
  }
  if (loading && !course) return <div className="page portal-page v3t-task"><PenLoader label="Opening your task…" /></div>;
  if (error || !course) {
    return (
      <div className="page portal-page v3t-task">
        <button type="button" className="v3t-back" onClick={() => openV2('v2-home')}><ArrowLeft size={17} /> Back to my dashboard</button>
        <InlineError message={error ?? 'This task could not be opened right now.'} onRetry={() => void data.load()} />
      </div>
    );
  }

  return (
    <div className={`page portal-page v3t-task ${penClass(course.penType)}`}>
      <TaskHeader course={course} onBack={backToCourse} />
      {data.notice && <div className="v3t-notice" role="alert"><Info size={17} /> <span>{data.notice}</span><button type="button" onClick={() => data.setNotice(null)} aria-label="Dismiss">×</button></div>}
      {mashq
        ? <MashqView data={data} flat={flat} />
        : current
          ? <StepView key={current.step.id} data={data} flat={flat} item={current} onGo={goTo} onBackToCourse={backToCourse} />
          : <div className="v3t-card v3t-empty"><strong>Nothing to do here yet</strong><p>Your teachers are still preparing this course. Please check again soon.</p></div>}
    </div>
  );
}

/* ============================== header ============================== */

function TaskHeader({ course, onBack }: { course: StudentCourse; onBack: () => void }) {
  const pen = String(course.penType ?? '').toLowerCase();
  return (
    <header className="v3t-head">
      <button type="button" className="v3t-back" onClick={onBack}><ArrowLeft size={17} /> Back to course</button>
      <div className="v3t-head-row">
        <div className="v3t-head-titles">
          <h1 className="v3t-course-name">{courseName(course)}</h1>
          <div className="v3t-tags">
            <span className="v3t-tag is-kind">{courseKind(course.courseType)}</span>
            {(pen === 'normal' || pen === 'cut') && <span className="v3t-tag is-pen">{pen === 'cut' ? 'Cut pen' : 'Normal pen'}</span>}
          </div>
        </div>
        {course.titleAr && <span className="v3t-course-ar" lang="ar" dir="rtl">{course.titleAr}</span>}
      </div>
      {course.enrolled && (
        <div className="v3t-progress" aria-label={`${course.progressPercent}% of the course done`}>
          <span className="v3t-progress-track"><span style={{ width: `${Math.max(2, Math.min(100, course.progressPercent))}%` }} /></span>
          <small>{course.progressPercent}% of the course done</small>
        </div>
      )}
    </header>
  );
}

/* ============================== one step ============================== */

function VideoBlock({ step }: { step: Step }) {
  const files = currentFiles(step).filter(f => f.role === 'video');
  const id = youtubeId(step.videoUrl);
  const [play, setPlay] = useState(false);
  if (id) {
    return play
      ? <div className="v3t-video"><iframe src={`${youtubeEmbed(id)}&autoplay=1`} title="Reference video" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen loading="lazy" /></div>
      : (
        <button type="button" className="v3t-video v3t-video-poster" onClick={() => setPlay(true)} aria-label="Play the reference video">
          <img src={`https://i.ytimg.com/vi/${id}/hqdefault.jpg`} alt="" loading="lazy" onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
          <span className="v3t-video-play"><PlayCircle size={58} strokeWidth={1.4} /></span>
          <small>Tap to watch</small>
        </button>
      );
  }
  if (step.videoUrl && isDirectVideo(step.videoUrl)) return <div className="v3t-video"><video src={step.videoUrl} controls playsInline preload="metadata" /></div>;
  if (step.videoUrl) return <a className="btn btn-outline" href={step.videoUrl} target="_blank" rel="noopener noreferrer"><PlayCircle size={18} /> Open the video</a>;
  return <>{files.map(f => <SignedVideo key={f.id} storageKey={f.storageKey} title="Reference video" />)}</>;
}

function SectionTitle({ n, children }: { n: number; children: React.ReactNode }) {
  return <h2 className="v3t-section-title"><span className="v3t-num" aria-hidden="true">{n}</span><span>{children}</span></h2>;
}

function StepView({ data, flat, item, onGo, onBackToCourse }: { data: TaskData; flat: FlatStep[]; item: FlatStep; onGo: (id: string) => void; onBackToCourse: () => void }) {
  const { course, typeOf, statusOf, size, sizes, chooseSize, download, downloadingId, setDone, enroll, enrolling, policies } = data as TaskData & { course: StudentCourse };
  const { step, level, levelIndex, stepIndex } = item;
  const [zoom, setZoom] = useState<Zoom>(null);
  const type = typeOf(step);
  const status = statusOf(step);
  const state = course.stepStates[step.id];
  const upload = isUploadStep(type);
  const unlocked = course.unlockedLevelIds.includes(level.id);
  const showLevels = course.levels.length > 1;
  const files = currentFiles(step);
  const references = files.filter(f => f.role === 'reference');
  const hasVideo = Boolean(step.videoUrl) || files.some(f => f.role === 'video');
  const sheets = sheetsForSize(step, size);
  const hasSheets = sheets.files.length > 0 || sheets.needsSize || sheets.otherSizes.length > 0;
  const priorSteps = level.steps.filter(s => s.orderIndex < step.orderIndex && s.id !== step.id && !isUploadStep(typeOf(s)));
  const todo = buildTodo(step, type, { hasSheets, hasVideo, hasReference: references.length > 0, practiceSteps: priorSteps.length });
  const numberOf = (key: TodoKey) => todo.findIndex(t => t.key === key) + 1;
  const days = replyDays(policies['review.turnaround_days']);
  const printNote = String(course.policies?.['print.instructions'] ?? '');
  const levelSteps = flat.filter(f => f.level.id === level.id);
  const index = flat.findIndex(f => f.step.id === step.id);
  const prev = index > 0 ? flat[index - 1] : null;
  const next = index < flat.length - 1 ? flat[index + 1] : null;
  const typeKey = type?.typeKey ?? step.stepType;
  const sendLabel = typeKey === 'istinsakh' ? 'Send for comments' : 'Send for assessment';
  const title = step.title?.trim() || type?.label || 'Practice';
  const where = `${showLevels ? `Level ${levelIndex + 1} · ` : ''}Step ${stepIndex + 1} of ${levelSteps.length}`;
  const prevLevelGates = levelIndex > 0 ? course.levels[levelIndex - 1].steps.filter(s => typeOf(s)?.gatesProgress) : [];
  const firstOpen = flat.filter(f => course.unlockedLevelIds.includes(f.level.id)).find(f => !DONE.includes(statusOf(f.step))) ?? null;
  const markText = state?.mark != null ? `${state.mark}/10` : null;
  // Assessment: all practice sheets as ONE PDF + the filled assessment sheet (owner note 2.7).
  const practiceSlot = priorSteps.length ? [{ id: priorSteps[0].id, code: '1', title: 'All your practice sheets of this level — as one PDF' }] : [];

  const scrollToChat = () => document.getElementById('v3t-chat')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const openZoom = (file: StepFile, url: string, label: string) => setZoom({ url, title: label, file });
  const nextIsSolid = DONE.includes(status) || status === 'waiting';

  return (
    <article className="v3t-step">
      {/* where am I + what is this step */}
      <section className="v3t-card v3t-intro">
        <p className="v3t-where">
          <span>{where}</span>
          {showLevels && level.description && hasArabic(level.description) && <span className="v3t-level-ar" lang="ar" dir="rtl">{level.description}</span>}
        </p>
        <h2 className="v3t-step-title">{title}</h2>
        <p className="v3t-step-kind">{type?.label ?? 'Practice'}{type?.hasMarks ? ' · marked out of 10' : upload ? ' · your teacher replies with comments' : ' · practice at home'}</p>
        <StatusRibbon status={status} markText={markText} provisional={isProvisionalState(state)} type={type} days={days} levelNumber={levelIndex + 1} onChat={scrollToChat} />
        {unlocked && upload && course.enrolled && ['todo', 'revision'].includes(status) && (
          <button type="button" className="btn btn-primary v3t-big v3t-intro-send" onClick={scrollToChat}><Send size={18} /> {status === 'revision' ? 'Send again' : sendLabel} <ArrowDown size={17} /></button>
        )}
      </section>

      {!unlocked ? (
        <section className="v3t-card v3t-locked" role="status">
          <span className="v3t-locked-icon"><Lock size={22} /></span>
          <div>
            <strong>This step is not open yet</strong>
            <p>{prevLevelGates.length ? `It opens when your Level ${levelIndex} assessment is passed.` : `It opens when you finish Level ${levelIndex}.`} Levels open one by one{firstOpen && showLevels ? ` — you are now on Level ${firstOpen.levelIndex + 1}, Step ${firstOpen.stepIndex + 1}` : ''}.</p>
            {firstOpen && <button type="button" className="btn btn-primary" onClick={() => onGo(firstOpen.step.id)}>Continue where I am <ArrowRight size={17} /></button>}
          </div>
        </section>
      ) : (
        <>
          {!course.enrolled && (
            <section className="v3t-card v3t-start">
              <div><strong>Start this course to begin</strong><p>Then you can download your sheets and send your work to your teacher.</p></div>
              <button type="button" className="btn btn-primary" onClick={() => void enroll()} disabled={enrolling}>{enrolling ? <RefreshCw size={17} className="v2s-spin" /> : <ArrowRight size={17} />} Start</button>
            </section>
          )}

          {/* what to do — smart, only the parts this step has (a single item is already the section title below) */}
          {(todo.length > 1 || step.message?.trim()) && <section className="v3t-card v3t-todo" aria-labelledby="v3t-todo-title">
            <h2 id="v3t-todo-title" className="v3t-eyebrow">What to do in this step</h2>
            <ol className="v3t-todo-list">
              {todo.map((t, i) => (
                <li key={t.key}><span className="v3t-num" aria-hidden="true">{i + 1}</span><span>{t.text}</span></li>
              ))}
            </ol>
            {step.message?.trim() && (
              <div className="v3t-teacher-note"><MessageCircle size={16} aria-hidden="true" /><p><strong>Note from your teacher:</strong> {step.message.trim()}</p></div>
            )}
          </section>}

          {hasVideo && (
            <section className="v3t-card" id="v3t-video">
              <SectionTitle n={numberOf('video')}>Watch the reference video</SectionTitle>
              <VideoBlock step={step} />
            </section>
          )}

          {references.length > 0 && (
            <section className="v3t-card" id="v3t-reference">
              <SectionTitle n={numberOf('reference')}>Look at the reference image</SectionTitle>
              <div className={`v3t-ref-grid${references.length > 1 ? ' is-many' : ''}`}>
                {references.map((ref, i) => {
                  const label = references.length > 1 ? `Reference ${i + 1}` : 'Reference image';
                  return (
                    <figure key={ref.id} className="v3t-ref">
                      <SheetPreview file={ref} alt={label} tall onOpen={url => openZoom(ref, url, label)} />
                      <figcaption>
                        <button type="button" className="btn btn-outline" onClick={() => void download(ref, `${title} reference`)} disabled={downloadingId === ref.id}>
                          {downloadingId === ref.id ? <RefreshCw size={16} className="v2s-spin" /> : <Download size={16} />} Download reference
                        </button>
                      </figcaption>
                    </figure>
                  );
                })}
              </div>
              {sizes.length > 1 && <SizeChooser sizes={sizes} current={size} onChoose={chooseSize} label="Your mistar size" compact />}
            </section>
          )}

          {hasSheets && (
            <section className="v3t-card" id="v3t-sheet">
              <SectionTitle n={numberOf('sheet')}>{typeKey === 'assessment' ? 'Download the assessment sheet' : 'Download your practice sheet'}</SectionTitle>
              <SizeChooser sizes={sizes} current={size} onChoose={chooseSize} label="Mistar size" />
              {sheets.needsSize ? (
                <p className="v3t-soft">Choose your mistar size above — then your sheet appears here.</p>
              ) : sheets.files.length === 0 ? (
                <p className="v3t-soft">This sheet is not ready in {sizeLabel(size)} yet. It is ready in {sheets.otherSizes.map(sizeLabel).join(', ')} — choose one of those sizes above.</p>
              ) : (
                <ul className={`v3t-sheet-list${sheets.files.length > 1 ? ' is-many' : ''}`}>
                  {sheets.files.map(file => {
                    const label = `${file.role === 'assessment_sheet' ? 'Assessment sheet' : 'Practice sheet'}${sheets.files.length > 1 && pageLabel(file.page) ? ` · ${pageLabel(file.page)}` : ''}${file.sizeCode ? ` · ${sizeLabel(file.sizeCode)}` : ''}`;
                    return (
                      <li key={file.id} className="v3t-sheet">
                        <SheetPreview file={file} alt={label} onOpen={url => openZoom(file, url, label)} />
                        <div className="v3t-sheet-foot">
                          <span className="v3t-sheet-name">{label}</span>
                          <button type="button" className="btn btn-outline v3t-download" onClick={() => void download(file, `${title} ${label}`)} disabled={downloadingId === file.id}>
                            {downloadingId === file.id ? <><RefreshCw size={17} className="v2s-spin" /> Preparing…</> : <><Download size={17} /> Download</>}
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              {printNote && <p className="v3t-print-note"><Printer size={16} aria-hidden="true" /> {printNote}</p>}
            </section>
          )}

          {!upload && (
            <section className={`v3t-card v3t-done-card${state?.done ? ' is-done' : ''}`} id="v3t-done">
              <SectionTitle n={numberOf('done')}>{state?.done ? 'Done — well practiced!' : 'Finished practicing on paper?'}</SectionTitle>
              {state?.done ? (
                <div className="v3t-done-row">
                  <span className="v3t-done-tick"><Check size={18} strokeWidth={3} /> Marked as done</span>
                  <button type="button" className="v3t-text-btn" onClick={() => void setDone(step, false)}><RotateCcw size={14} /> Undo</button>
                </div>
              ) : (
                <>
                  <p className="v3t-soft">Keep your practiced sheets safe — you will send them with your level assessment.</p>
                  <button type="button" className="btn btn-primary v3t-big" onClick={() => void setDone(step, true)}><Check size={19} /> Mark as done</button>
                </>
              )}
            </section>
          )}

          {upload && (
            <section className="v3t-card v3t-chat-card" id="v3t-chat-intro">
              <SectionTitle n={numberOf('upload')}>{typeKey === 'istinsakh' ? 'Send your istinsakh to your teacher' : 'Send your work for assessment'}</SectionTitle>
              <div className="v3t-next-info">
                <Clock3 size={18} aria-hidden="true" />
                <p><strong>What happens next:</strong> your teacher will reply within {daysWord(days)}. {type?.hasMarks ? 'Your marks, ' : 'Your '}comments and voice notes appear right here in this chat, and you also get an email.</p>
              </div>
              <div id="v3t-chat" className="v3t-chat">
                {course.enrolled
                  ? <ThreadPanel stepId={step.id} mode="student" compact submission={{ required: true, priorSteps: practiceSlot }} onChanged={() => void data.load(true)} />
                  : <p className="v3t-soft">Start the course above to send your work.</p>}
              </div>
            </section>
          )}
        </>
      )}

      {/* previous / next across steps and levels */}
      <nav className="v3t-stepnav" aria-label="Steps">
        <button type="button" className="btn btn-outline" onClick={() => prev && onGo(prev.step.id)} disabled={!prev}><ChevronLeft size={18} /> <span className="v3t-hide-sm">Previous</span></button>
        <span className="v3t-stepnav-count">{index + 1} of {flat.length}</span>
        {next ? (
          <button type="button" className={`btn ${nextIsSolid ? 'btn-primary' : 'btn-outline'}`} onClick={() => onGo(next.step.id)}>
            {nextIsSolid ? 'Continue' : 'Next step'} {!course.unlockedLevelIds.includes(next.level.id) && <Lock size={15} aria-label="(not open yet)" />}<ArrowRight size={18} />
          </button>
        ) : (
          <button type="button" className={`btn ${nextIsSolid ? 'btn-primary' : 'btn-outline'}`} onClick={onBackToCourse}>Finish <Check size={18} /></button>
        )}
      </nav>

      {zoom && (
        <ZoomViewer url={zoom.url} title={zoom.title} onClose={() => setZoom(null)} downloading={downloadingId === zoom.file.id}
          onDownload={() => void download(zoom.file, `${title} ${zoom.title}`)}
          footer={zoom.file.role !== 'reference' || sizes.length < 2 ? null : <SizeChooser sizes={sizes} current={size} onChoose={chooseSize} label="Mistar" compact />} />
      )}
    </article>
  );
}

function StatusRibbon({ status, markText, provisional = false, type, days, levelNumber, onChat }: { status: StepStatus; markText: string | null; provisional?: boolean; type: StepTypeDef | undefined; days: number; levelNumber: number; onChat: () => void }) {
  if (status === 'todo') return null;
  if (status === 'passed') {
    return (
      <div className="v3t-ribbon is-passed" role="status">
        <Award size={20} aria-hidden="true" />
        <span><strong>Passed{markText ? ` · ${markText}` : ''} — well done!</strong>{type?.awardsBadge && <small>Level {levelNumber} badge earned.</small>}</span>
        {type?.awardsBadge && <button type="button" className="v3t-text-btn" onClick={() => openV2('v2-my-merit')}>See my badge</button>}
      </div>
    );
  }
  if (status === 'waiting' && provisional && markText) {
    return (
      <div className="v3t-ribbon is-waiting is-provisional" role="status">
        <Clock3 size={20} aria-hidden="true" />
        <span><strong>Marked {markText} · your teacher will confirm</strong><small>Your teacher was busy, so this mark was given to keep you going. Your teacher will look at your work soon and confirm it — then the next part opens.</small></span>
        <button type="button" className="v3t-text-btn" onClick={onChat}>Read the message</button>
      </div>
    );
  }
  if (status === 'waiting') {
    return (
      <div className="v3t-ribbon is-waiting" role="status">
        <Clock3 size={20} aria-hidden="true" />
        <span><strong>Sent — with your teacher now</strong><small>Your teacher will reply within {daysWord(days)}. You can still send a message.</small></span>
        <button type="button" className="v3t-text-btn" onClick={onChat}>Open chat</button>
      </div>
    );
  }
  if (status === 'revision') {
    return (
      <div className="v3t-ribbon is-revision" role="status">
        <RotateCcw size={20} aria-hidden="true" />
        <span><strong>Almost there{markText ? ` · ${markText}` : ''} — let’s try once more</strong><small>Read your teacher’s notes in the chat, practice again and send a fresh attempt.</small></span>
        <button type="button" className="v3t-text-btn" onClick={onChat}>Read notes</button>
      </div>
    );
  }
  if (status === 'replied') {
    return (
      <div className="v3t-ribbon is-passed" role="status">
        <Sparkles size={20} aria-hidden="true" />
        <span><strong>Your teacher replied</strong><small>Read the comments in the chat below.</small></span>
        <button type="button" className="v3t-text-btn" onClick={onChat}>Open chat</button>
      </div>
    );
  }
  return <div className="v3t-ribbon is-passed" role="status"><Check size={20} aria-hidden="true" /><span><strong>Done</strong></span></div>;
}

/* ============================== Mashq worksheets ============================== */

function MashqView({ data, flat }: { data: TaskData; flat: FlatStep[] }) {
  const { course, typeOf, statusOf, size, sizes, chooseSize, download, downloadingId, setDone, enroll, enrolling, policies } = data as TaskData & { course: StudentCourse };
  const [zoom, setZoom] = useState<Zoom>(null);
  const sheetSteps = flat.filter(f => !isUploadStep(typeOf(f.step)));
  const finalStep = flat.find(f => isUploadStep(typeOf(f.step))) ?? null;
  const finalState = finalStep ? course.stepStates[finalStep.step.id] : undefined;
  const finalStatus = finalStep ? statusOf(finalStep.step) : 'todo';
  const practiced = sheetSteps.filter(f => course.stepStates[f.step.id]?.done).length;
  const days = replyDays(policies['review.turnaround_days']);
  const printNote = String(course.policies?.['print.instructions'] ?? '');
  const anyNeedsSize = sheetSteps.some(f => sheetsForSize(f.step, size).needsSize);
  const scrollToChat = () => document.getElementById('v3t-chat')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const completed = finalStatus === 'passed' || finalStatus === 'replied';

  return (
    <article className="v3t-step v3t-mashq">
      {!course.enrolled && (
        <section className="v3t-card v3t-start">
          <div><strong>Start these worksheets</strong><p>Tap Start, choose your mistar size and download the sheets one by one.</p></div>
          <button type="button" className="btn btn-primary" onClick={() => void enroll()} disabled={enrolling}>{enrolling ? <RefreshCw size={17} className="v2s-spin" /> : <ArrowRight size={17} />} Start</button>
        </section>
      )}

      <section className="v3t-card v3t-todo">
        <h2 className="v3t-eyebrow">How it works</h2>
        <ol className="v3t-todo-list">
          <li><span className="v3t-num">1</span><span>Choose your mistar size.</span></li>
          <li><span className="v3t-num">2</span><span>Download each worksheet, print it and practice it several times.</span></li>
          <li><span className="v3t-num">3</span><span>When you have practiced them all, send all your sheets as one PDF for assessment and remarks.</span></li>
        </ol>
        {course.enrolled && sheetSteps.length > 0 && (
          <div className="v3t-mini-progress">
            <span className="v3t-progress-track"><span style={{ width: `${Math.round((practiced / sheetSteps.length) * 100)}%` }} /></span>
            <small>{practiced} of {sheetSteps.length} worksheets practiced</small>
          </div>
        )}
      </section>

      <div className="v3t-size-bar">
        <SizeChooser sizes={sizes} current={size} onChoose={chooseSize} label="Mistar size" />
      </div>
      {anyNeedsSize && <p className="v3t-soft v3t-center">Choose your mistar size above — then your worksheets appear.</p>}

      <ol className="v3t-ws-grid" aria-label="Worksheets">
        {sheetSteps.map((f, i) => {
          const sheets = sheetsForSize(f.step, size);
          const done = Boolean(course.stepStates[f.step.id]?.done);
          const name = f.step.title?.trim() || `Worksheet ${i + 1}`;
          if (sheets.needsSize) return null;
          return (
            <li key={f.step.id} className={`v3t-ws${done ? ' is-done' : ''}`}>
              <div className="v3t-ws-head">
                <span className="v3t-num">{i + 1}</span>
                <strong>{name}</strong>
                {done && <span className="v3t-tag is-done"><Check size={13} strokeWidth={3} /> Practiced</span>}
              </div>
              {sheets.files.length === 0 ? (
                <p className="v3t-soft">Not ready in {sizeLabel(size)} yet{sheets.otherSizes.length ? ` — ready in ${sheets.otherSizes.map(sizeLabel).join(', ')}` : ''}.</p>
              ) : sheets.files.map(file => {
                const label = `${name}${sheets.files.length > 1 && pageLabel(file.page) ? ` · ${pageLabel(file.page)}` : ''}`;
                return (
                  <div key={file.id} className="v3t-ws-file">
                    <SheetPreview file={file} alt={label} onOpen={url => setZoom({ url, title: label, file })} />
                    <button type="button" className="btn btn-outline v3t-download" onClick={() => void download(file, `${course.title} ${label}`)} disabled={downloadingId === file.id}>
                      {downloadingId === file.id ? <><RefreshCw size={17} className="v2s-spin" /> Preparing…</> : <><Download size={17} /> Download{file.sizeCode ? ` · ${sizeLabel(file.sizeCode)}` : ''}</>}
                    </button>
                  </div>
                );
              })}
              {course.enrolled && (
                <button type="button" className={`v3t-check${done ? ' is-on' : ''}`} onClick={() => void setDone(f.step, !done)} aria-pressed={done}>
                  <span className="v3t-check-box">{done && <Check size={14} strokeWidth={3} />}</span> I have practiced this sheet
                </button>
              )}
            </li>
          );
        })}
      </ol>
      {printNote && <p className="v3t-print-note"><Printer size={16} aria-hidden="true" /> {printNote}</p>}

      <section className={`v3t-final${completed ? ' is-complete' : ''}`} id="v3t-final">
        <span className="v3t-final-icon" aria-hidden="true">{completed ? <Award size={28} /> : <Send size={26} />}</span>
        <div className="v3t-final-text">
          {completed ? (
            <>
              <h2>Completed — well done!</h2>
              <p>Your teacher has assessed your sheets{finalState?.mark != null ? ` · ${finalState.mark}/10` : ''}. Read the remarks in the chat below.</p>
            </>
          ) : finalStatus === 'waiting' ? (
            <>
              <h2>{isProvisionalState(finalState) ? `Marked ${finalState?.mark}/10 · your teacher will confirm` : 'Your sheets are with your teacher'}</h2>
              <p>{isProvisionalState(finalState) ? 'Your teacher was busy, so this mark was given to keep you going. Your teacher will confirm it soon — then these worksheets are marked as completed.' : `Your teacher will reply within ${daysWord(days)} with marks and remarks. Then these worksheets are marked as completed.`}</p>
            </>
          ) : (
            <>
              <h2>After practicing all the worksheets</h2>
              <p>Scan or photograph all your sheets and upload them as <strong>one PDF</strong> for assessment and remarks. Once your teacher has assessed them, these worksheets are marked as completed.</p>
            </>
          )}
        </div>
        {finalStep && course.enrolled && ['todo', 'revision'].includes(finalStatus) && (
          <button type="button" className="btn btn-primary v3t-big" onClick={scrollToChat}><Send size={18} /> {finalStatus === 'revision' ? 'Send again' : 'Send for assessment'} <ArrowDown size={17} /></button>
        )}
      </section>

      {finalStep ? (
        <section className="v3t-card v3t-chat-card">
          <div className="v3t-next-info">
            <Clock3 size={18} aria-hidden="true" />
            <p><strong>What happens next:</strong> after you send, your teacher replies within {daysWord(days)}. Marks, remarks and voice notes appear right here, and you also get an email.</p>
          </div>
          <div id="v3t-chat" className="v3t-chat">
            {course.enrolled
              ? <ThreadPanel stepId={finalStep.step.id} mode="student" compact submission={{ required: true, priorSteps: [] }} onChanged={() => void data.load(true)} />
              : <p className="v3t-soft">Start above to send your sheets.</p>}
          </div>
        </section>
      ) : (
        <p className="v3t-soft v3t-center">The upload for these worksheets is not open yet — please ask at the Funun al-Quran office.</p>
      )}

      {zoom && <ZoomViewer url={zoom.url} title={zoom.title} onClose={() => setZoom(null)} downloading={downloadingId === zoom.file.id} onDownload={() => void download(zoom.file, `${course.title} ${zoom.title}`)} />}
    </article>
  );
}

