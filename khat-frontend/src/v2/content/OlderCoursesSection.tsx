import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, BookOpen, RotateCcw } from 'lucide-react';
import { apiFetch, ApiError } from '@/api';
import { Button, PenLoader, navigate } from '@/components/ui';
import { openCourseLevel } from '@/courseSession';
import { displayCourseTitle } from '@/data/mock';
import type { OlderCourse } from './contentTypes';
import './content-v3.css';

/**
 * Note 4.9 ("Older courses" failed to load) + curriculum audit: lists only old-system courses
 * that are published, open to the student's branch and have levels. Never shows a raw error.
 */
export function V3OlderCoursesSection() {
  const [courses, setCourses] = useState<OlderCourse[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setFailed(false); setCourses(null);
    apiFetch<OlderCourse[]>('/v2/older-courses', { silent: true }).then(setCourses).catch(() => { setFailed(true); setCourses([]); });
  }, []);
  useEffect(() => { load(); }, [load]);

  const open = async (c: OlderCourse) => {
    if (!c.firstLevelId) return;
    setBusy(c.id); setError(null);
    try {
      if (!c.enrolled) await apiFetch('/levels/enroll', { method: 'POST', body: { courseId: c.id } });
      let levelId = c.firstLevelId;
      try {
        const progress = await apiFetch<{ enrollment: { current_level_index: number }; levels: { id: string }[] }>(`/levels/courses/${c.id}/progress`, { silent: true });
        levelId = progress.levels[progress.enrollment.current_level_index]?.id ?? progress.levels[0]?.id ?? levelId;
      } catch { /* fall back to the first level */ }
      openCourseLevel(c.id, levelId);
      navigate('course');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not open this course. Please try again.');
    } finally { setBusy(null); }
  };

  return (
    <section className="v3c-older" aria-label="Older courses">
      <div className="v3c-older-head">
        <p className="eyebrow">Older courses</p>
        <h2>Courses from the earlier website</h2>
      </div>
      {courses === null ? <PenLoader label="Loading older courses…" compact /> : failed ? (
        <div className="v3c-empty"><BookOpen size={20} /><div><strong>We could not load your older courses just now</strong><p>Please check your connection and try again.</p></div><button type="button" className="v3c-ghost-btn" onClick={load}><RotateCcw size={14} /> Try again</button></div>
      ) : courses.length === 0 ? (
        <div className="v3c-empty"><BookOpen size={20} /><div><strong>No older courses for your branch</strong><p>All your courses are in the new course section on your dashboard.</p></div></div>
      ) : (
        <div className="v3c-older-grid">
          {courses.map(c => (
            <article className="v3c-older-card" key={c.id}>
              <span className="v3c-tag">{c.kind}</span>
              <strong>{displayCourseTitle(c.title)}</strong>
              <small>{[c.scriptName, `${c.levelCount} ${c.levelCount === 1 ? 'level' : 'levels'}`].filter(Boolean).join(' · ')}</small>
              {c.enrolled && <div className="v3c-progress" aria-label={`${c.percentComplete}% done`}><i style={{ width: `${c.percentComplete}%` }} /></div>}
              {c.enrolled
                ? <Button onClick={() => void open(c)} disabled={busy === c.id}>{busy === c.id ? 'Opening…' : 'Continue'} <ArrowRight size={14} /></Button>
                : <Button onClick={() => void open(c)} disabled={busy === c.id}>{busy === c.id ? 'Opening…' : 'Start'} <ArrowRight size={14} /></Button>}
            </article>
          ))}
        </div>
      )}
      {error && <p className="error-text" role="alert">{error}</p>}
    </section>
  );
}
