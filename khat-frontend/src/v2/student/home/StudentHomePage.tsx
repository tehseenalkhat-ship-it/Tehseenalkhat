// owner: student-dash (v3). The student's main dashboard (route v2-home).
import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Award, BarChart3, Clock, Compass, Flame, MessageCircle, PenLine, Send, Sparkles, Star, Upload } from 'lucide-react';
import { apiFetch, getSessionUser } from '@/api';
import { navigate, PenLoader } from '@/components/ui';
import { FixedReportsCard } from '@/components/ReportProblem';
import { V3OlderCoursesSection } from '@/v2/content/OlderCoursesSection';
import { openV2 } from '../../nav';
import { ensureAmiri, InlineError, SignedImage } from '../shared';
import type { StudentAnalysis } from '../../insights/analysisTypes';
import type { StudentCourse } from '../../contracts';
import { BadgeMedal, BadgeSheet } from './BadgeSheet';
import { CourseCard, GreenBar, openCourse, openTask, StyleTag } from './CourseCard';
import { GuideTour, type GuideStep } from './GuideTour';
import { badgeTitle, courseKind, courseName, daysAgoWords, enrolledAtOf, friendlyWorkLabel, isProvisionalState, KIND_GROUP, KIND_LABEL, KIND_ORDER, penKind, PEN_TEXT, placeWords, type BadgeWithArt, type CourseState, type PenKind } from './studentText';
import { loadMyBadges, loadMyShowcase, useStudentCourses, type MyShowcasePost } from './useStudentCourses';
import '../student-v2.css';
import './v3-student.css';

type Props = Record<string, never>;

const HOW_KEY = 'khat.v3.howItWorksDone';
const PEN_KEY = 'khat.v3.pen';

const GUIDE: GuideStep[] = [
  { target: 'now', title: 'Your next task', text: 'This card always shows the one thing to do next. Tap Continue and you go straight to it.' },
  { target: 'pens', title: 'Choose your pen', text: 'Normal pen courses are marked in green and Cut pen courses in blue. Tap a pen to see its courses.' },
  { target: 'courses', title: 'Your courses', text: 'Each card says what kind of course it is — Certification, Crash course or Mashq worksheets — how many levels or worksheets it has, and the badges you can earn. Tap Start to begin.' },
  { target: 'chat', title: 'Comments come in the chat', text: 'When you send your work, your teacher’s comments and marks arrive in the chat on that task. You can reply there too. For anything else, chat with the Funun al-Quran Department.' },
  { target: 'progress', title: 'See how far you have come', text: 'Your levels, marks and practice days are counted here for you.' },
  { target: 'badges', title: 'Your badges', text: 'Every level you pass gives you a badge. Tap a badge to open it, download it or print it.' },
  { target: 'guide', title: 'Need help again?', text: 'Tap Guide me at any time and we will walk through the page together.' },
];

export function V2StudentHomePage(_props: Props) {
  const user = getSessionUser();
  const firstName = (user?.name ?? '').trim().split(/\s+/)[0];
  const { entries, error, reload } = useStudentCourses();
  const [analysis, setAnalysis] = useState<StudentAnalysis | null>(null);
  const [badges, setBadges] = useState<BadgeWithArt[] | null>(null);
  const [showcase, setShowcase] = useState<MyShowcasePost[]>([]);
  const [howDone, setHowDone] = useState(() => localStorage.getItem(HOW_KEY) === '1');
  const [guideOpen, setGuideOpen] = useState(false);
  const [pen, setPen] = useState<PenKind | null>(() => (localStorage.getItem(PEN_KEY) as PenKind | null));
  const [openBadge, setOpenBadge] = useState<BadgeWithArt | null>(null);

  useEffect(() => { ensureAmiri(); }, []);
  useEffect(() => {
    apiFetch<StudentAnalysis>('/v2/analysis/me', { silent: true }).then(setAnalysis).catch(() => undefined);
    loadMyBadges().then(setBadges).catch(() => setBadges([]));
    loadMyShowcase().then(setShowcase).catch(() => undefined);
  }, []);

  const courseMap = useMemo(() => new Map((entries ?? []).filter(e => e.state).map(e => [e.summary.id, e.state!.course] as [string, StudentCourse])), [entries]);
  const going = useMemo(() => (entries ?? []).filter(e => e.state?.course.enrolled && !e.state.completed).map(e => e.state!)
    .sort((a, b) => Number(Boolean(b.unread.length)) - Number(Boolean(a.unread.length)) || b.percent - a.percent), [entries]);

  const pens = useMemo(() => {
    const counts: Record<PenKind, number> = { normal: 0, cut: 0, other: 0 };
    (entries ?? []).forEach(e => { counts[penKind(e.summary.penType)] += 1; });
    return counts;
  }, [entries]);
  const activePen: PenKind = pen && pens[pen] ? pen : going[0] ? penKind(going[0].course.penType) : pens.normal ? 'normal' : pens.cut ? 'cut' : 'other';
  const penGroups = useMemo(() => {
    const list = (entries ?? []).filter(e => penKind(e.summary.penType) === activePen);
    return KIND_ORDER.map(kind => ({ kind, items: list.filter(e => courseKind(e.summary.courseType) === kind) })).filter(group => group.items.length || group.kind !== 'other');
  }, [entries, activePen]);

  const choosePen = (next: PenKind) => { setPen(next); localStorage.setItem(PEN_KEY, next); };
  const finishHow = () => { localStorage.setItem(HOW_KEY, '1'); setHowDone(true); };
  const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const sortedBadges = [...(badges ?? [])].sort((a, b) => b.awardedAt.localeCompare(a.awardedAt));
  const s = analysis?.summary;

  return (
    <main className="page portal-page v3-sd-page v3-sd-home">
      <header className="v3-sd-home-head">
        <div>
          <p className="v3-sd-eyebrow">Your dashboard</p>
          <h1>{firstName ? `Salaam, ${firstName}` : 'Salaam'}</h1>
        </div>
        <div className="v3-sd-head-actions">
          <button type="button" className="v3-sd-btn is-outline" data-guide="guide" onClick={() => setGuideOpen(true)}><Compass size={16} /> Guide me</button>
          <button type="button" className="v3-sd-btn is-outline" onClick={() => openV2('v2-my-merit')}><Award size={16} /> My badges{badges ? ` · ${badges.length}` : ''}</button>
        </div>
      </header>

      {!howDone && (
        <section className="v3-sd-how" aria-labelledby="v3-sd-how-title">
          <h2 id="v3-sd-how-title">How it works — 3 easy steps</h2>
          <ol>
            <li><span className="v3-sd-how-num">1</span><PenLine size={18} aria-hidden="true" /><strong>Choose your pen and course</strong><p>Pick Normal pen or Cut pen, then tap a course card.</p></li>
            <li><span className="v3-sd-how-num">2</span><Upload size={18} aria-hidden="true" /><strong>Watch, practice, upload</strong><p>Each task shows a video and a worksheet. Practice on art paper, then send a photo of your work.</p></li>
            <li><span className="v3-sd-how-num">3</span><MessageCircle size={18} aria-hidden="true" /><strong>Your teacher replies in the chat</strong><p>Comments, marks and voice notes come back in the chat on the same page — and you can reply there too.</p></li>
          </ol>
          <div className="v3-sd-how-actions">
            <button type="button" className="v3-sd-btn is-solid" onClick={finishHow}>Got it — let’s begin <ArrowRight size={16} /></button>
            <button type="button" className="v3-sd-btn is-ghost" onClick={() => { finishHow(); setGuideOpen(true); }}><Compass size={16} /> Show me around</button>
          </div>
        </section>
      )}

      <FixedReportsCard />
      {error && <InlineError message={error} onRetry={() => void reload()} />}
      {!entries && !error && <PenLoader label="Getting your courses ready…" />}

      {entries && (
        <>
          {/* ---------- what to do now ---------- */}
          <section className="v3-sd-now" data-guide="now" aria-labelledby="v3-sd-now-title">
            <p className="v3-sd-eyebrow" id="v3-sd-now-title">What to do now</p>
            {going.length === 0 ? (
              <div className="v3-sd-now-card is-empty">
                <div>
                  <h2>{entries.some(e => e.state?.completed) ? 'Ready for your next course?' : 'Start your first course'}</h2>
                  <p>Choose your pen below, then tap <strong>Start</strong> on a course. We will take you to your first task.</p>
                </div>
                <button type="button" className="v3-sd-btn is-solid" onClick={() => scrollTo('v3-sd-courses')}>Choose a course <ArrowRight size={16} /></button>
              </div>
            ) : going.map((state, i) => <NowCard key={state.course.id} state={state} main={i === 0} />)}
          </section>

          {/* ---------- choose pen and course ---------- */}
          <section className="v3-sd-section" id="v3-sd-courses" aria-labelledby="v3-sd-courses-title">
            <div className="v3-sd-section-head">
              <h2 id="v3-sd-courses-title"><span className="v3-sd-num">1</span> Choose your pen and course</h2>
              <p>Pick the pen you write with, then tap a course.</p>
            </div>
            <div className="v3-sd-pens" role="tablist" aria-label="Pen" data-guide="pens">
              {(['normal', 'cut', 'other'] as PenKind[]).filter(p => p !== 'other' || pens.other).map(p => (
                <button key={p} type="button" role="tab" aria-selected={activePen === p} className={`v3-sd-pen is-${p}${activePen === p ? ' is-active' : ''}`} onClick={() => choosePen(p)}>
                  <PenLine size={18} aria-hidden="true" />
                  <span><strong>{PEN_TEXT[p].label}</strong><small>{pens[p]} {pens[p] === 1 ? 'course' : 'courses'}</small></span>
                </button>
              ))}
            </div>
            <p className="v3-sd-pen-text">{PEN_TEXT[activePen].text}</p>
            <div data-guide="courses" className="v3-sd-kind-groups">
              {penGroups.map(group => (
                <div key={group.kind} className="v3-sd-kind-group">
                  <h3>{KIND_GROUP[group.kind].title} {group.items.length > 0 && <span className="v3-sd-count">{group.items.length}</span>}</h3>
                  <p className="v3-sd-kind-text">{KIND_GROUP[group.kind].text}</p>
                  {group.items.length === 0
                    ? <p className="v3-sd-quiet-box"><Clock size={16} aria-hidden="true" /> {KIND_GROUP[group.kind].title} for the {PEN_TEXT[activePen].label.toLowerCase()} are being prepared. Please check again soon.</p>
                    : <div className="v3-sd-card-grid">{group.items.map(entry => <CourseCard key={entry.summary.id} entry={entry} />)}</div>}
                </div>
              ))}
            </div>
          </section>

          {/* Courses made before the Course builder (all live courses until they are rebuilt there). */}
          <V3OlderCoursesSection />

          {/* ---------- chat ---------- */}
          <section className="v3-sd-chat-strip" data-guide="chat" aria-label="Chat">
            <span className="v3-sd-chat-icon" aria-hidden="true"><MessageCircle size={22} /></span>
            <div>
              <strong>Comments and marks come in the chat</strong>
              <p>When you send your work, your teacher replies in the chat on that task — and you can reply there too. Any other question? Ask the Funun al-Quran Department.</p>
            </div>
            <button type="button" className="v3-sd-btn is-outline" onClick={() => navigate('v2-dept-chat')}><Send size={15} /> Chat with the department</button>
          </section>

          {/* ---------- progress ---------- */}
          <section className="v3-sd-section" data-guide="progress" aria-labelledby="v3-sd-progress-title">
            <div className="v3-sd-section-head has-link">
              <div>
                <h2 id="v3-sd-progress-title"><span className="v3-sd-num">2</span> My progress</h2>
                <p>Look how far you have come.</p>
              </div>
              <button type="button" className="v3-sd-link" onClick={() => navigate('v2-my-progress')}>See my full progress <ArrowRight size={15} /></button>
            </div>
            <div className="v3-sd-stats">
              <Stat icon={<Award size={18} />} value={s ? String(s.levelsPassed) : '–'} label={s?.levelsPassed === 1 ? 'level passed' : 'levels passed'} />
              <Stat icon={<Star size={18} />} value={s?.averageMark != null ? String(s.averageMark) : '–'} unit={s?.averageMark != null ? '/10' : undefined} label="average mark" />
              <Stat icon={<Flame size={18} />} value={s ? String(s.streakDays) : '–'} label={s?.streakDays === 1 ? 'day of practice in a row' : 'days of practice in a row'} />
              <Stat icon={<Upload size={18} />} value={s ? String(s.attempts) : '–'} label={s?.attempts === 1 ? 'upload sent for assessment' : 'uploads sent for assessment'} />
            </div>
            {analysis && analysis.marks.length > 0 && (
              <div className="v3-sd-last-marks">
                <p className="v3-sd-mini-head"><BarChart3 size={15} aria-hidden="true" /> Your last marks</p>
                <ul>
                  {[...analysis.marks].reverse().slice(0, 3).map((mark, i) => (
                    <li key={`${mark.date}-${i}`}>
                      <span className={`v3-sd-mark is-${mark.band}`}>{mark.mark}<small>/10</small></span>
                      <span>{friendlyWorkLabel(mark.label, mark.courseId, courseMap)}{mark.provisional && <small className="v3-sd-provisional">Marked {mark.mark}/10 · your teacher will confirm</small>}</span>
                      <time>{new Date(mark.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</time>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          {/* ---------- badges + showcased work ---------- */}
          <section className="v3-sd-section" data-guide="badges" aria-labelledby="v3-sd-badges-title">
            <div className="v3-sd-section-head has-link">
              <div>
                <h2 id="v3-sd-badges-title"><span className="v3-sd-num">3</span> My badges</h2>
                <p>Tap a badge to open it, download it or print it.</p>
              </div>
              <button type="button" className="v3-sd-link" onClick={() => openV2('v2-my-merit')}>All my badges <ArrowRight size={15} /></button>
            </div>
            {badges === null ? <PenLoader compact label="Loading badges" /> : sortedBadges.length === 0 ? (
              <p className="v3-sd-quiet-box"><Award size={16} aria-hidden="true" /> Pass your first level and your first badge will appear here.</p>
            ) : (
              <div className="v3-sd-badge-row">
                {sortedBadges.slice(0, 6).map(badge => {
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
            {showcase.length > 0 && (
              <div className="v3-sd-showcased">
                <p className="v3-sd-mini-head"><Sparkles size={15} aria-hidden="true" /> My work in the showcase</p>
                <p className="v3-sd-kind-text">Your work was chosen to be shown to everyone in your branch — mubarak!</p>
                <div className="v3-sd-showcase-row">
                  {showcase.slice(0, 4).map(post => (
                    <figure key={post.id} className="v3-sd-showcase-tile">
                      <SignedImage storageKey={post.image_storage_key} alt="My showcased work" />
                      <figcaption>{new Date(post.created_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</figcaption>
                    </figure>
                  ))}
                </div>
              </div>
            )}
          </section>
        </>
      )}

      {openBadge && (() => { const t = badgeTitle(openBadge, courseMap); return <BadgeSheet badge={openBadge} title={t.title} sub={t.sub} subIsArabic={t.subIsArabic} onClose={() => setOpenBadge(null)} />; })()}
      <GuideTour steps={GUIDE} open={guideOpen} onClose={() => setGuideOpen(false)} />
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

function NowCard({ state, main }: { state: CourseState; main: boolean }) {
  const { course } = state;
  const name = courseName(course);
  const pen = penKind(course.penType);
  const started = daysAgoWords(enrolledAtOf(course));
  const reply = state.unread[0];
  const waiting = !state.next && state.waiting[0];
  return (
    <article className={`v3-sd-now-card is-${pen}${main ? ' is-main' : ''}`}>
      <div className="v3-sd-now-body">
        <div className="v3-sd-now-tags">
          <span className="v3-sd-kind">{KIND_LABEL[state.kind]}</span>
          <StyleTag course={course} compact />
        </div>
        <div className="v3-sd-now-names">
          <h2>{name}</h2>
          {course.titleAr && <p className="v3-sd-ar" lang="ar" dir="rtl">{course.titleAr}</p>}
        </div>
        {state.next ? (
          <p className="v3-sd-now-next"><span>{state.next.status === 'revision' ? 'Try once more:' : 'Next:'}</span> <strong>{placeWords(state, state.next)}</strong> — {state.next.title}</p>
        ) : waiting ? (
          isProvisionalState(course.stepStates?.[waiting.step.id])
            ? <p className="v3-sd-now-next"><Clock size={15} aria-hidden="true" /> <strong>{placeWords(state, waiting)}</strong>: Marked {course.stepStates[waiting.step.id]?.mark}/10 · your teacher will confirm.</p>
            : <p className="v3-sd-now-next"><Clock size={15} aria-hidden="true" /> <strong>{placeWords(state, waiting)}</strong> is with your teacher. You will usually get a reply within 3 days.</p>
        ) : null}
        <div className="v3-sd-now-progress">
          <GreenBar percent={state.percent} label={`${name}: ${state.percent}% done`} />
          <span>{state.percent}% of the course{started ? ` · ${started}` : ''}</span>
        </div>
        {reply && (
          <button type="button" className="v3-sd-reply-line" onClick={() => openTask(course.id, reply.step.id)}>
            <MessageCircle size={16} aria-hidden="true" /> Your teacher replied on <strong>{placeWords(state, reply)}</strong> — read it in the chat <ArrowRight size={14} />
          </button>
        )}
      </div>
      <div className="v3-sd-now-actions">
        {state.next
          ? <button type="button" className="v3-sd-btn is-solid is-big" onClick={() => openTask(course.id, state.kind === 'mashq' ? null : state.next!.step.id)}>Continue <ArrowRight size={17} /></button>
          : <button type="button" className="v3-sd-btn is-outline is-big" onClick={() => openCourse(course.id)}>Open the course</button>}
        {state.next && <button type="button" className="v3-sd-btn is-ghost" onClick={() => openCourse(course.id)}>See all steps</button>}
      </div>
    </article>
  );
}
