// owner: student-dash (v3) — the student's own "My progress": warm, simple, no codes, no merit points.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRight, Award, BarChart3, Clock, Compass, Flame, MessageCircle, Route, Sparkles, Star, Upload } from 'lucide-react';
import { apiFetch } from '@/api';
import { navigate, PenLoader } from '@/components/ui';
import { openV2 } from '../nav';
import type { StudentCourse } from '../contracts';
import type { StudentAnalysis } from './analysisTypes';
import { MarksLine, RemarksList, RubricBars, StrengthsFocus } from './analysisParts';
import { ensureAmiri, SignedImage } from '../student/shared';
import { BadgeMedal, BadgeSheet } from '../student/home/BadgeSheet';
import { GreenBar, openCourse, openTask } from '../student/home/CourseCard';
import { badgeTitle, courseName, friendlyWorkLabel, placeWords, type BadgeWithArt } from '../student/home/studentText';
import { loadMyBadges, loadMyShowcase, useStudentCourses, type MyShowcasePost } from '../student/home/useStudentCourses';
import './analysis.css';
import '../student/student-v2.css';
import '../student/home/v3-student.css';

type Props = Record<string, never>;

function lastPracticeWords(iso: string | null): string | null {
  if (!iso) return null;
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (Number.isNaN(days)) return null;
  if (days <= 0) return 'You practiced today';
  if (days === 1) return 'Last practice yesterday';
  return `Last practice ${days} days ago`;
}

function heroLine(data: StudentAnalysis): string {
  const s = data.summary;
  if (!s.markCount && !s.levelsPassed) return 'Every great calligrapher started with a single stroke. Here is your journey so far.';
  if (s.trend === 'up') return `You have passed ${s.levelsPassed} ${s.levelsPassed === 1 ? 'level' : 'levels'} and your marks are rising. Keep the pen moving!`;
  if (s.levelsPassed > 0) return `You have passed ${s.levelsPassed} ${s.levelsPassed === 1 ? 'level' : 'levels'} so far. Every level makes the next one easier.`;
  return 'Here is your journey so far — one step at a time.';
}

export function V2MyProgressPage(_props: Props) {
  const [data, setData] = useState<StudentAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { entries } = useStudentCourses();
  const [badges, setBadges] = useState<BadgeWithArt[]>([]);
  const [showcase, setShowcase] = useState<MyShowcasePost[]>([]);
  const [openBadge, setOpenBadge] = useState<BadgeWithArt | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setData(await apiFetch<StudentAnalysis>('/v2/analysis/me')); }
    catch (err) { setError(err instanceof Error ? err.message : 'Your progress could not be loaded.'); }
  }, []);
  useEffect(() => { ensureAmiri(); void load(); loadMyBadges().then(setBadges).catch(() => undefined); loadMyShowcase().then(setShowcase).catch(() => undefined); }, [load]);

  const courseMap = useMemo(() => new Map((entries ?? []).filter(e => e.state).map(e => [e.summary.id, e.state!.course] as [string, StudentCourse])), [entries]);
  const started = useMemo(() => (entries ?? []).filter(e => e.state?.course.enrolled).map(e => e.state!), [entries]);
  const going = started.filter(state => !state.completed);
  const s = data?.summary;
  const practice = data ? lastPracticeWords(data.summary.lastActiveAt) : null;

  return (
    <main className="page portal-page v3-sd-page v3-sd-progress">
      <header className="v3-sd-progress-head">
        <p className="v3-sd-eyebrow"><Sparkles size={13} aria-hidden="true" /> My progress</p>
        <h1>Look how far you have come</h1>
        <p>{data ? heroLine(data) : 'Gathering your marks and steps…'}{practice ? ` ${practice}.` : ''}</p>
      </header>

      {error && (
        <div className="v2-an-error" role="alert">
          <span>{error}</span>
          <button type="button" className="v3-sd-btn is-outline" onClick={() => void load()}>Try again</button>
        </div>
      )}
      {!data && !error && <PenLoader compact label="Loading your progress" />}

      {data && s && (
        <>
          <div className="v3-sd-stats">
            <Stat icon={<Award size={18} />} value={String(s.levelsPassed)} label={s.levelsPassed === 1 ? 'level passed' : 'levels passed'} />
            <Stat icon={<Star size={18} />} value={s.averageMark != null ? String(s.averageMark) : '–'} unit={s.averageMark != null ? '/10' : undefined} label={s.bestMark != null ? `average mark · best ${s.bestMark}/10` : 'average mark'} />
            <Stat icon={<Flame size={18} />} value={String(s.streakDays)} label={s.streakDays === 1 ? 'day of practice in a row' : 'days of practice in a row'} />
            <Stat icon={<Upload size={18} />} value={String(s.attempts)} label={s.attempts === 1 ? 'upload sent for assessment' : 'uploads sent for assessment'} />
          </div>

          <div className="v3-sd-progress-grid">
            <div className="v3-sd-progress-col">
              <section className="v3-sd-box" aria-labelledby="v3-sd-next-title">
                <h2 id="v3-sd-next-title"><Route size={18} aria-hidden="true" /> Your next steps</h2>
                {going.length === 0 && (
                  <div className="v3-sd-next-card">
                    <span><strong>{started.length ? 'Ready for a new course?' : 'Start your first course'}</strong><small>Choose a course on your dashboard and tap Start.</small></span>
                    <button type="button" className="v3-sd-btn is-solid" onClick={() => navigate('v2-home')}>Choose <ArrowRight size={16} /></button>
                  </div>
                )}
                {going.map(state => {
                  const name = courseName(state.course);
                  if (state.next) {
                    return (
                      <div key={state.course.id} className="v3-sd-next-card">
                        <span><strong>Continue with {placeWords(state, state.next)} — {state.next.title}</strong><small>{name} is {state.percent}% done.</small></span>
                        <button type="button" className="v3-sd-btn is-solid" onClick={() => openTask(state.course.id, state.next!.step.id)}>Continue <ArrowRight size={16} /></button>
                      </div>
                    );
                  }
                  const wait = state.waiting[0];
                  return (
                    <div key={state.course.id} className="v3-sd-next-card is-wait">
                      <span><strong><Clock size={14} aria-hidden="true" /> {wait ? `${placeWords(state, wait)} is with your teacher` : `${name} is waiting for your teacher`}</strong><small>You will usually get a reply within 3 days, in the chat.</small></span>
                      <button type="button" className="v3-sd-btn is-outline" onClick={() => (wait ? openTask(state.course.id, wait.step.id) : openCourse(state.course.id))}><MessageCircle size={15} /> Chat</button>
                    </div>
                  );
                })}
              </section>

              <section className="v3-sd-box" aria-labelledby="v3-sd-marks-title">
                <h2 id="v3-sd-marks-title"><BarChart3 size={18} aria-hidden="true" /> Your marks</h2>
                <MarksLine marks={data.marks} bands={data.bands} />
                {data.marks.length > 1 && <p>{data.summary.trendText}</p>}
                {data.marks.length > 0 && (
                  <div className="v3-sd-last-marks">
                    <ul>
                      {[...data.marks].reverse().slice(0, 5).map((mark, i) => (
                        <li key={`${mark.date}-${i}`}>
                          <span className={`v3-sd-mark is-${mark.band}`}>{mark.mark}<small>/10</small></span>
                          <span>{friendlyWorkLabel(mark.label, mark.courseId, courseMap)}{mark.attemptNo > 1 ? ` · try ${mark.attemptNo}` : ''}{mark.provisional && <small className="v3-sd-provisional">Marked {mark.mark}/10 · your teacher will confirm</small>}</span>
                          <time>{new Date(mark.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</time>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </section>

              <section className="v3-sd-box" aria-labelledby="v3-sd-strength-title">
                <h2 id="v3-sd-strength-title"><Sparkles size={18} aria-hidden="true" /> Your strengths</h2>
                <StrengthsFocus data={data} audience="student" />
                {data.rubric.length > 0 && <><p className="v3-sd-mini-head">Your marks by skill</p><RubricBars rubric={data.rubric} /></>}
              </section>
            </div>

            <div className="v3-sd-progress-col">
              <section className="v3-sd-box" aria-labelledby="v3-sd-courses-p-title">
                <h2 id="v3-sd-courses-p-title"><Compass size={18} aria-hidden="true" /> My courses</h2>
                {started.length === 0 ? <p>Your courses will appear here once you start one.</p> : started.map(state => (
                  <div key={state.course.id} className="v3-sd-course-line">
                    <div className="v3-sd-course-line-top">
                      <strong>{courseName(state.course)}</strong>
                      {state.course.titleAr && <span className="v3-sd-ar" lang="ar" dir="rtl">{state.course.titleAr}</span>}
                    </div>
                    <GreenBar percent={state.percent} label={`${courseName(state.course)} progress`} />
                    <small>
                      {state.percent}% · {state.completed ? 'Completed' : state.flat ? `${state.stepsDone} of ${state.stepsTotal} steps done` : `${state.levelsPassed} of ${state.levels.length} levels passed · now on Level ${state.currentLevel?.number ?? 1}`}
                    </small>
                    <button type="button" className="v3-sd-link" onClick={() => openCourse(state.course.id)}>Open course <ArrowRight size={14} /></button>
                  </div>
                ))}
              </section>

              <section className="v3-sd-box" aria-labelledby="v3-sd-badges-p-title">
                <h2 id="v3-sd-badges-p-title"><Award size={18} aria-hidden="true" /> My badges</h2>
                {badges.length === 0 ? <p>Pass your first level and your first badge will appear here.</p> : (
                  <div className="v3-sd-badge-row">
                    {[...badges].sort((a, b) => b.awardedAt.localeCompare(a.awardedAt)).slice(0, 4).map(badge => {
                      const t = badgeTitle(badge, courseMap);
                      return (
                        <button key={badge.id} type="button" className="v3-sd-badge-tile" onClick={() => setOpenBadge(badge)}>
                          <BadgeMedal badge={badge} />
                          <strong>{t.title}</strong>
                          {t.sub && <small className={t.subIsArabic ? 'v3-sd-ar' : ''} dir="auto">{t.sub}</small>}
                        </button>
                      );
                    })}
                  </div>
                )}
                <button type="button" className="v3-sd-link" onClick={() => openV2('v2-my-merit')}>All my badges <ArrowRight size={14} /></button>
              </section>

              {showcase.length > 0 && (
                <section className="v3-sd-box" aria-labelledby="v3-sd-showcase-p-title">
                  <h2 id="v3-sd-showcase-p-title"><Sparkles size={18} aria-hidden="true" /> My work in the showcase</h2>
                  <p>Your work was chosen to be shown to everyone in your branch — a real achievement.</p>
                  <div className="v3-sd-showcase-row">
                    {showcase.slice(0, 4).map(post => (
                      <figure key={post.id} className="v3-sd-showcase-tile">
                        <SignedImage storageKey={post.image_storage_key} alt="My showcased work" />
                        <figcaption>{new Date(post.created_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</figcaption>
                      </figure>
                    ))}
                  </div>
                </section>
              )}

              <section className="v3-sd-box" aria-labelledby="v3-sd-remarks-title">
                <h2 id="v3-sd-remarks-title"><MessageCircle size={18} aria-hidden="true" /> What your teachers keep telling you</h2>
                <RemarksList data={data} audience="student" />
              </section>
            </div>
          </div>
        </>
      )}
      {openBadge && (() => { const t = badgeTitle(openBadge, courseMap); return <BadgeSheet badge={openBadge} title={t.title} sub={t.sub} subIsArabic={t.subIsArabic} onClose={() => setOpenBadge(null)} />; })()}
    </main>
  );
}

function Stat({ icon, value, unit, label }: { icon: React.ReactNode; value: string; unit?: string; label: string }) {
  return (
    <div className="v3-sd-stat">
      <span className="v3-sd-stat-icon" aria-hidden="true">{icon}</span>
      <strong>{value}{unit && <small>{unit}</small>}</strong>
      <span>{label}</span>
    </div>
  );
}
