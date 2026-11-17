// owner: student-dash (v3). One course card — used on the dashboard and on the Courses page.
import { useState } from 'react';
import { ArrowRight, Check, PauseCircle } from 'lucide-react';
import { apiFetch } from '@/api';
import type { StudentCourse } from '../../contracts';
import { openV2 } from '../../nav';
import { errorMessage } from '../shared';
import type { CourseEntry } from './useStudentCourses';
import { courseFacts, courseKind, courseName, daysAgoWords, enrolledAtOf, KIND_LABEL, penKind, placeWords, STYLE_TEXT, styleOf } from './studentText';

export function openTask(courseId: string, stepId: string | null) {
  openV2('v2-task', { courseId, stepId });
}
export function openCourse(courseId: string) {
  openV2('v2-course', { courseId, stepId: null });
}

/** Enrols (if needed) and opens the first step — one tap from the card to the work. */
export async function startCourse(course: StudentCourse): Promise<void> {
  if (!course.enrolled) await apiFetch(`/v2/student/courses/${course.id}/enroll`, { method: 'POST' });
  const first = course.levels[0]?.steps[0];
  // Mashq courses open their worksheet page (the task page picks it when no step is given).
  if (courseKind(course.courseType) === 'mashq') openTask(course.id, null);
  else if (first) openTask(course.id, first.id); else openCourse(course.id);
}

export function StyleTag({ course, compact = false }: { course: { title: string; titleAr?: string | null }; compact?: boolean }) {
  const style = styleOf(course);
  if (!style) return null;
  const text = STYLE_TEXT[style];
  return (
    <span className={`v3-sd-style-tag${compact ? ' is-compact' : ''}`}>
      <b className="v3-sd-ar" lang="ar" dir="rtl">{text.num}</b>
      <span className="v3-sd-ar" lang="ar" dir="rtl">{text.ar}</span>
      <span className="v3-sd-style-latin">{text.latin}</span>
    </span>
  );
}

export function GreenBar({ percent, label }: { percent: number; label: string }) {
  return (
    <div className="v3-sd-bar" role="progressbar" aria-label={label} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
      <i style={{ width: `${Math.max(percent > 0 ? 3 : 0, percent)}%` }} />
    </div>
  );
}

export function CourseCard({ entry }: { entry: CourseEntry }) {
  const { summary, state } = entry;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kind = courseKind(summary.courseType);
  const pen = penKind(summary.penType);
  const enrolled = Boolean(state?.course.enrolled);
  const completed = Boolean(enrolled && state?.completed);
  const name = courseName(summary);
  const facts = courseFacts(state, summary);
  const started = state ? daysAgoWords(enrolledAtOf(state.course)) : null;

  const start = async () => {
    if (!state) { openCourse(summary.id); return; }
    setBusy(true); setError(null);
    try { await startCourse(state.course); }
    catch (err) { setError(errorMessage(err, 'We could not start this course. Please try again.')); setBusy(false); }
  };

  let statusText = 'Not started';
  if (completed) statusText = 'Completed';
  else if (enrolled) statusText = state?.flat ? 'In progress' : `In progress · Level ${state?.currentLevel?.number ?? 1}`;

  return (
    <article className={`v3-sd-course-card is-${pen}${completed ? ' is-complete' : ''}${enrolled ? ' is-enrolled' : ''}`}>
      <div className="v3-sd-course-card-top">
        <span className="v3-sd-kind">{KIND_LABEL[kind]}</span>
        <span className={`v3-sd-state${completed ? ' is-done' : enrolled ? ' is-going' : ''}`}>{completed && <Check size={13} strokeWidth={3} />}{statusText}</span>
      </div>
      <StyleTag course={summary} compact />
      {summary.titleAr && <p className="v3-sd-course-ar v3-sd-ar" lang="ar" dir="rtl">{summary.titleAr}</p>}
      <h3 className="v3-sd-course-name">
        <button type="button" onClick={() => openCourse(summary.id)}>{name}</button>
      </h3>
      <p className="v3-sd-facts">{facts.join(' · ')}</p>
      {summary.status === 'held' && <p className="v3-sd-note"><PauseCircle size={14} /> Paused for new students — you can carry on.</p>}

      {enrolled && !completed && state && (
        <div className="v3-sd-course-card-progress">
          <GreenBar percent={state.percent} label={`${name}: ${state.percent}% done`} />
          <p><strong>{state.percent}% done</strong>{state.next ? ` · Next: ${placeWords(state, state.next)}` : state.waiting.length ? ' · With your teacher' : ''}</p>
          {started && <p className="v3-sd-started">{started}</p>}
        </div>
      )}
      {completed && <p className="v3-sd-done-line"><Check size={15} strokeWidth={3} /> Well done — you finished this course.</p>}
      {error && <p className="v3-sd-soft-error" role="alert">{error}</p>}

      <div className="v3-sd-course-card-actions">
        {!enrolled && <button type="button" className="v3-sd-btn is-solid" onClick={() => void start()} disabled={busy}>{busy ? 'Starting…' : 'Start'} <ArrowRight size={16} /></button>}
        {enrolled && !completed && state?.next && <button type="button" className="v3-sd-btn is-solid" onClick={() => openTask(summary.id, kind === 'mashq' ? null : state.next!.step.id)}>Continue <ArrowRight size={16} /></button>}
        {enrolled && !completed && !state?.next && <button type="button" className="v3-sd-btn is-outline" onClick={() => openCourse(summary.id)}>Open course</button>}
        {completed && <button type="button" className="v3-sd-btn is-outline" onClick={() => openCourse(summary.id)}>See my work</button>}
        {!completed && <button type="button" className="v3-sd-btn is-ghost" onClick={() => openCourse(summary.id)}>{enrolled ? 'All steps' : 'Look inside'}</button>}
      </div>
    </article>
  );
}
