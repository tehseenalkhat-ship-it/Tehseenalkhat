import { useEffect, useMemo, useState } from 'react';
import { BookOpen, ChevronDown, FileImage, FileText, Newspaper, PlayCircle, RefreshCw, Users } from 'lucide-react';
import { apiFetch } from '@/api';
import { PenLoader } from '@/components/ui';
import type { AuditEntry, CourseDetail, CourseSummary, StepTypeDef } from '../contracts';
import { loadStepTypes } from '../review/policies';
import { KIND_LABEL, levelWords, stepWords, type CourseKind } from './teacherTypes';
import './teacher.css';

type Props = Record<string, never>;

const kindOfCourse = (c: CourseSummary): CourseKind => (c.courseType === 'mashq' || c.courseType === 'crash' ? c.courseType : 'certification');
const penLabel = (p: string | null) => (p === 'cut' ? 'Cut pen' : p === 'normal' ? 'Normal pen' : null);
const UPDATE_ACTIONS = /^(course|level|step|file|ingest|manifest|master)\./;

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : days < 30 ? `${days} days ago` : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** Audit lines in plain words: "New step: Level 4 line assessment", "Published — students can see it now". */
export function friendlyUpdate(e: Pick<AuditEntry, 'action' | 'summary'>): string {
  const quoted = /'([^']+)'/.exec(e.summary)?.[1] ?? /"([^"]+)"/.exec(e.summary)?.[1] ?? null;
  const lv = /LV0?(\d+)/.exec(e.summary)?.[1];
  const paren = /\(([^)]+)\)/.exec(e.summary)?.[1];
  if (/"published"\s*\)?\s*$|→ "published"/.test(e.summary)) return 'Published — students can see it now';
  if (e.action === 'step.create') return `New step${lv ? ` in Level ${Number(lv)}` : ''}${quoted ? `: ${quoted}` : ''}`;
  if (e.action === 'level.create') return `New level added${lv ? `: Level ${Number(lv)}` : ''}${paren ? ` (${paren})` : ''}`;
  if (e.action.startsWith('step.')) return `Step changed${quoted ? `: ${quoted}` : ''}`;
  if (e.action.startsWith('level.')) return `Level changed${lv ? `: Level ${Number(lv)}` : ''}`;
  if (/^(file|ingest)\./.test(e.action)) return 'Worksheets or reference images updated';
  return e.summary.replace(/\b[A-Z]{2,5}-[A-Z]\d{3}\b/g, '').replace(/\bLV0?(\d+)\b/g, 'Level $1').replace(/\bS0?(\d+)\b/g, 'Step $1').replace(/\s{2,}/g, ' ').trim();
}

/**
 * v3 (6.10) — every teacher's overview of all courses: which courses, how many levels and steps,
 * what is in each step, plus the latest updates. Read-only; plain words, no internal codes.
 */
export function V2TeacherCoursesPage(_props: Props) {
  const [courses, setCourses] = useState<CourseSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<CourseKind | 'all'>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, CourseDetail | 'loading' | 'error'>>({});
  const [updates, setUpdates] = useState<(AuditEntry & { courseTitle: string })[] | null>(null);
  const [types, setTypes] = useState<StepTypeDef[]>([]);

  const load = async () => {
    setError(null);
    try {
      const list = await apiFetch<CourseSummary[]>('/v2/courses?structureVersion=2');
      const live = (Array.isArray(list) ? list : []).filter(c => c.structureVersion === 2 && c.code);
      setCourses(live);
      const published = live.filter(c => c.status === 'published' || c.status === 'held');
      const feeds = await Promise.all(published.map(c =>
        apiFetch<AuditEntry[]>(`/v2/audit?courseId=${encodeURIComponent(c.id)}&limit=40`, { silent: true })
          .then(r => (Array.isArray(r) ? r : []).filter(e => UPDATE_ACTIONS.test(e.action)).map(e => ({ ...e, courseTitle: c.title })))
          .catch(() => [])));
      setUpdates(feeds.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 8));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The courses could not be loaded.');
    }
  };
  useEffect(() => { void load(); void loadStepTypes().then(setTypes); }, []);

  const toggle = (id: string) => {
    setOpenId(o => (o === id ? null : id));
    if (!details[id]) {
      setDetails(d => ({ ...d, [id]: 'loading' }));
      apiFetch<CourseDetail>(`/v2/courses/${id}`, { silent: true })
        .then(c => setDetails(d => ({ ...d, [id]: c })))
        .catch(() => setDetails(d => ({ ...d, [id]: 'error' })));
    }
  };

  const live = useMemo(() => (courses ?? []).filter(c => c.status === 'published' || c.status === 'held'), [courses]);
  const coming = useMemo(() => (courses ?? []).filter(c => c.status === 'draft'), [courses]);
  const shown = kind === 'all' ? live : live.filter(c => kindOfCourse(c) === kind);
  const typeLabel = (key: string) => types.find(t => t.typeKey === key)?.label ?? key.replace(/_/g, ' ');

  return (
    <main className="page portal-page v3-tc-page">
      <header className="v3-tc-head">
        <p className="eyebrow"><BookOpen size={13} /> Funun al-Quran</p>
        <h1>All courses</h1>
        <p className="muted">Every course your students can study: how many levels and steps, and what each step asks them to do. Tap a course to see inside.</p>
      </header>

      {error && <div className="v3-tc-error"><p className="v2-inline-error" role="alert">{error}</p><button type="button" className="btn btn-outline" onClick={() => void load()}><RefreshCw size={15} /> Try again</button></div>}
      {!courses && !error && <PenLoader compact label="Loading courses…" />}

      {courses && (
        <>
          <div className="v3tc-kind-tabs" role="tablist" aria-label="Course type">
            {(['all', 'certification', 'mashq', 'crash'] as const).map(k => {
              const n = k === 'all' ? live.length : live.filter(c => kindOfCourse(c) === k).length;
              return <button key={k} type="button" role="tab" aria-selected={kind === k} className={kind === k ? 'is-active' : ''} onClick={() => setKind(k)}>{k === 'all' ? 'All' : KIND_LABEL[k]} <b>{n}</b></button>;
            })}
          </div>

          <div className="v3-tc-layout">
            <section className="v3-tc-list" aria-label="Courses">
              {!shown.length && <p className="muted v3-tc-empty">No courses of this type yet.</p>}
              {shown.map(c => {
                const k = kindOfCourse(c);
                const open = openId === c.id;
                const d = details[c.id];
                const pen = penLabel(c.penType);
                return (
                  <article key={c.id} className={`v3-tc-card${open ? ' is-open' : ''}`}>
                    <button type="button" className="v3-tc-card-head" onClick={() => toggle(c.id)} aria-expanded={open}>
                      <span className="v3-tc-titles">
                        <span className="v3-tc-tags">
                          <span className={`v3tc-kind-tag kind-${k}`}>{k === 'certification' ? 'Certification course' : k === 'mashq' ? 'Mashq worksheets' : 'Crash course'}</span>
                          {pen && <span className={`v3-pen-tag pen-${c.penType}`}>{pen}</span>}
                          {c.status === 'held' && <span className="v3tc-soft-tag">On hold</span>}
                        </span>
                        <strong>{c.title}</strong>
                        {c.titleAr && <span className="v3-tc-ar" lang="ar" dir="rtl">{c.titleAr}</span>}
                      </span>
                      <span className="v3-tc-counts">
                        {k === 'certification' && <span><b>{c.counts.levels}</b> level{c.counts.levels === 1 ? '' : 's'}</span>}
                        <span><b>{c.counts.steps}</b> step{c.counts.steps === 1 ? '' : 's'}</span>
                        <span><Users size={14} /> <b>{c.counts.students}</b> student{c.counts.students === 1 ? '' : 's'}</span>
                      </span>
                      <ChevronDown size={20} className={`v3-tc-chev${open ? ' is-open' : ''}`} />
                    </button>
                    {open && (
                      <div className="v3-tc-body">
                        {d === 'loading' || !d ? <PenLoader compact label="Opening…" /> : d === 'error' ? <p className="v2-inline-error">This course could not be opened.</p> : (
                          <>
                            {d.description && <p className="v3-tc-desc">{d.description}</p>}
                            <ol className="v3-tc-levels">
                              {d.levels.filter(l => l.status === 'published').map(l => (
                                <li key={l.id} className="v3-tc-level">
                                  {k === 'certification' && (
                                    <p className="v3-tc-level-title"><b>{levelWords(l.code)}</b>{l.description && <span lang="ar" dir="auto"> · {l.description}</span>}<small>{l.steps.filter(s => s.status === 'published').length} steps</small></p>
                                  )}
                                  {l.instructions && <p className="v3-tc-instr">{l.instructions}</p>}
                                  <ul className="v3-tc-steps">
                                    {l.steps.filter(s => s.status === 'published').map(s => {
                                      const sheets = s.files.filter(f => f.role === 'worksheet' || f.role === 'assessment_sheet').length;
                                      const refs = s.files.filter(f => f.role === 'reference').length;
                                      const video = !!s.videoUrl || s.files.some(f => f.role === 'video');
                                      return (
                                        <li key={s.id} className="v3-tc-step">
                                          <span className="v3-tc-step-name"><b>{stepWords(s.code)}</b> {s.title}</span>
                                          <span className="v3-tc-step-meta">
                                            <span className="v3tc-soft-tag">{typeLabel(s.stepType)}</span>
                                            {video && <span className="v3-tc-has"><PlayCircle size={14} /> Video</span>}
                                            {refs > 0 && <span className="v3-tc-has"><FileImage size={14} /> {refs} reference</span>}
                                            {sheets > 0 && <span className="v3-tc-has"><FileText size={14} /> {sheets} sheet{sheets === 1 ? '' : 's'}</span>}
                                          </span>
                                          {s.message && <span className="v3-tc-msg">{s.message}</span>}
                                        </li>
                                      );
                                    })}
                                  </ul>
                                </li>
                              ))}
                            </ol>
                          </>
                        )}
                      </div>
                    )}
                  </article>
                );
              })}
              {coming.length > 0 && (
                <p className="v3-tc-coming muted">Being prepared: {coming.map(c => c.title).join(' · ')}</p>
              )}
            </section>

            <aside className="v3-tc-updates" aria-label="Latest updates">
              <h2><Newspaper size={17} /> Latest updates</h2>
              {updates === null ? <p className="muted">Loading…</p> : !updates.length ? <p className="muted">No changes to the courses lately.</p> : (
                <ul>
                  {updates.map(u => (
                    <li key={u.id}>
                      <strong>{u.courseTitle}</strong>
                      <span>{friendlyUpdate(u)}</span>
                      <small>{when(u.createdAt)}{u.actorName ? ` · ${u.actorName}` : ''}</small>
                    </li>
                  ))}
                </ul>
              )}
            </aside>
          </div>
        </>
      )}
    </main>
  );
}
