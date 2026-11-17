// owner: analysis — building blocks shared by "My progress" (student) and the staff drawer.
// No chart library: plain SVG + CSS, colours only through the site's CSS variables.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowRight, Award, BookOpen, CalendarCheck, CheckCircle2, Flame, Gem, Minus, PenLine, Quote, Sparkles, Star, Target, TrendingDown, TrendingUp,
} from 'lucide-react';
import type { AnalysisMark, AnalysisNextStep, CriterionScore, StudentAnalysis, TrendDirection } from './analysisTypes';

export type Audience = 'student' | 'staff';

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

const SHORT_DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
export function shortDate(iso: string | null): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  return Number.isNaN(t) ? '—' : SHORT_DATE.format(new Date(t));
}

export function lastActiveWords(iso: string | null): string {
  if (!iso) return 'Not yet';
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 60) return `${days} days ago`;
  return `${Math.floor(days / 30)} months ago`;
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(entries => setWidth(Math.round(entries[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

// ---------------------------------------------------------------- summary cards
export function SummaryCards({ data, audience }: { data: StudentAnalysis; audience: Audience }) {
  const s = data.summary;
  const you = audience === 'student';
  const cards: { icon: ReactNode; value: string; label: string; sub: string; tone: string }[] = [
    { icon: <Award size={18} />, value: String(s.levelsPassed), label: 'Levels passed', sub: s.distinctions ? `${s.distinctions} with distinction` : `${s.attempts} piece${s.attempts === 1 ? '' : 's'} of work sent`, tone: 'gold' },
    { icon: <Star size={18} />, value: s.averageMark == null ? '—' : String(s.averageMark), label: 'Average mark', sub: s.bestMark == null ? (you ? 'Your first mark is coming' : 'No marks yet') : `Best so far: ${s.bestMark}/10`, tone: 'positive' },
    { icon: <Flame size={18} />, value: String(s.streakDays), label: s.streakDays === 1 ? 'Day in a row' : 'Days in a row', sub: s.streakDays ? 'Practice streak' : (you ? 'Start a new streak today' : 'No streak right now'), tone: 'warning' },
    { icon: <CalendarCheck size={18} />, value: String(s.activeDays30), label: 'Active days', sub: `In the last 30 days · last ${lastActiveWords(s.lastActiveAt).toLowerCase()}`, tone: 'ink' },
  ];
  return (
    <div className="v2-an-cards">
      {cards.map(card => (
        <div key={card.label} className={`v2-an-card v2-an-tone-${card.tone}`}>
          <span className="v2-an-card-icon" aria-hidden="true">{card.icon}</span>
          <strong>{card.value}</strong>
          <span className="v2-an-card-label">{card.label}</span>
          <small>{card.sub}</small>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- trend chip
export function TrendChip({ trend }: { trend: TrendDirection }) {
  if (trend === 'up') return <span className="v2-an-trend is-up"><TrendingUp size={13} /> Rising</span>;
  if (trend === 'down') return <span className="v2-an-trend is-down"><TrendingDown size={13} /> A small dip</span>;
  return <span className="v2-an-trend"><Minus size={13} /> Steady</span>;
}

// ---------------------------------------------------------------- marks line (SVG)
export function MarksLine({ marks, bands, compact = false }: { marks: AnalysisMark[]; bands: StudentAnalysis['bands']; compact?: boolean }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const height = compact ? 150 : 180;
  const pad = { l: 26, r: 14, t: 14, b: 26 };
  const w = Math.max(220, width);
  const innerW = w - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;
  const y = (m: number) => pad.t + innerH - ((Math.min(10, Math.max(0, m))) / 10) * innerH;
  const x = (i: number) => (marks.length <= 1 ? pad.l + innerW / 2 : pad.l + (i / (marks.length - 1)) * innerW);
  const passY = y(bands.revisionMax + 0.5);
  const points = marks.map((m, i) => `${x(i).toFixed(1)},${y(m.mark).toFixed(1)}`).join(' ');

  if (!marks.length) {
    return <div className="v2-an-empty-chart"><PenLine size={20} /><span>Your marks will draw a line here after your first marked assessment.</span></div>;
  }
  return (
    <div className="v2-an-line" ref={ref}>
      {width > 0 && (
        <svg width={w} height={height} viewBox={`0 0 ${w} ${height}`} role="img" aria-label={`Marks: ${marks.map(m => m.mark).join(', ')}`}>
          <rect x={pad.l} y={pad.t} width={innerW} height={Math.max(0, passY - pad.t)} className="v2-an-line-pass" rx="6" />
          {[0, 5, 10].map(t => (
            <g key={t}>
              <line x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} className="v2-an-line-grid" />
              <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" className="v2-an-line-axis">{t}</text>
            </g>
          ))}
          <line x1={pad.l} x2={w - pad.r} y1={passY} y2={passY} className="v2-an-line-passline" />
          <text x={w - pad.r} y={passY - 5} textAnchor="end" className="v2-an-line-note">pass {bands.revisionMax + 1}+</text>
          {marks.length > 1 && <polyline points={points} className="v2-an-line-stroke" />}
          {marks.map((m, i) => (
            <g key={`${m.date}-${i}`}>
              <circle cx={x(i)} cy={y(m.mark)} r={i === marks.length - 1 ? 6 : 4.5} className={`v2-an-dot is-${m.band}`}>
                <title>{`${shortDate(m.date)} · ${m.label} · ${m.mark}/10`}</title>
              </circle>
              {(i === marks.length - 1 || marks.length <= 6) && (
                <text x={x(i)} y={y(m.mark) - 10} textAnchor="middle" className="v2-an-line-value">{m.mark}</text>
              )}
            </g>
          ))}
          <text x={x(0)} y={height - 6} textAnchor={marks.length > 1 ? 'start' : 'middle'} className="v2-an-line-axis">{shortDate(marks[0].date)}</text>
          {marks.length > 1 && <text x={x(marks.length - 1)} y={height - 6} textAnchor="end" className="v2-an-line-axis">{shortDate(marks[marks.length - 1].date)}</text>}
        </svg>
      )}
    </div>
  );
}

/** The latest few marked pieces as a small list under the line. */
export function RecentMarks({ marks }: { marks: AnalysisMark[] }) {
  const latest = [...marks].reverse().slice(0, 4);
  if (!latest.length) return null;
  return (
    <ul className="v2-an-recent">
      {latest.map((m, i) => (
        <li key={`${m.date}-${i}`}>
          <span className={`v2-an-mark is-${m.band}`}>{m.mark}</span>
          <span className="v2-an-recent-label">{m.label}{m.attemptNo > 1 ? ` · try ${m.attemptNo}` : ''}</span>
          <small>{shortDate(m.date)}</small>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- strengths & focus
export function StrengthsFocus({ data, audience }: { data: StudentAnalysis; audience: Audience }) {
  const you = audience === 'student';
  return (
    <div className="v2-an-sf">
      <div className="v2-an-sf-col is-strength">
        <h3><CheckCircle2 size={15} /> {you ? 'What you do well' : 'Strengths'}</h3>
        {data.strengths.length ? (
          <div className="v2-an-chips">{data.strengths.map(s => <span key={s.key} className="v2-an-chip is-strength" title={s.label}>{s.text}</span>)}</div>
        ) : <p className="v2-an-soft">{you ? 'Your strengths will appear here as your teachers mark your work.' : 'Not enough marked work yet.'}</p>}
      </div>
      <div className="v2-an-sf-col is-focus">
        <h3><Target size={15} /> {you ? 'Next to polish' : 'Focus areas'}</h3>
        {data.focusAreas.length ? (
          <div className="v2-an-chips">{data.focusAreas.map(s => <span key={s.key} className="v2-an-chip is-focus" title={s.source === 'remarks' ? 'From teacher remarks' : `From rubric: ${s.label}`}>{s.text}</span>)}</div>
        ) : <p className="v2-an-soft">{you ? 'Nothing stands out — keep doing what you are doing!' : 'Nothing stands out.'}</p>}
      </div>
    </div>
  );
}

export function RubricBars({ rubric }: { rubric: CriterionScore[] }) {
  if (!rubric.length) return null;
  return (
    <ul className="v2-an-rubric" aria-label="Marks by skill">
      {rubric.map(c => (
        <li key={c.key}>
          <span className="v2-an-rubric-label">{c.label}</span>
          <span className={`v2-an-rubric-bar${c.percent >= 75 ? ' is-high' : c.percent < 60 ? ' is-low' : ''}`}><i style={{ width: `${Math.max(4, c.percent)}%` }} /></span>
          <span className="v2-an-rubric-val">{c.average}/{c.max}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- remarks
export function RemarksList({ data, audience }: { data: StudentAnalysis; audience: Audience }) {
  const top = data.remarks.slice(0, audience === 'student' ? 4 : 5);
  if (!top.length) {
    return <p className="v2-an-soft">{audience === 'student' ? 'When your teachers write notes on your work, the points they repeat most will gather here.' : 'No teacher remarks yet.'}</p>;
  }
  return (
    <ul className="v2-an-remarks">
      {top.map(r => (
        <li key={r.key}>
          <div className="v2-an-remark-head">
            <strong>{r.label}</strong>
            <span>{r.count === 1 ? 'mentioned once' : `mentioned ${r.count} times`}{r.praise ? ` · ${r.praise} praise` : ''}</span>
          </div>
          {r.example && <p><Quote size={13} aria-hidden="true" /> {r.example}</p>}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- next steps
const STEP_ICONS: Record<AnalysisNextStep['tone'], ReactNode> = {
  go: <ArrowRight size={16} />, practice: <PenLine size={16} />, merit: <Gem size={16} />, cheer: <Sparkles size={16} />,
};
export function NextSteps({ steps, onOpen }: { steps: AnalysisNextStep[]; onOpen?: (step: AnalysisNextStep) => void }) {
  return (
    <ol className="v2-an-steps">
      {steps.map(step => (
        <li key={step.key} className={`v2-an-step is-${step.tone}`}>
          <span className="v2-an-step-icon" aria-hidden="true">{STEP_ICONS[step.tone]}</span>
          <div className="v2-an-step-copy">
            <strong>{step.text}</strong>
            {step.detail && <small>{step.detail}</small>}
          </div>
          {step.action && onOpen && (
            <button type="button" className="btn btn-primary v2-an-step-btn" onClick={() => onOpen(step)}>{step.action.label}</button>
          )}
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------- merit ring
export function MeritRing({ merit, audience }: { merit: StudentAnalysis['merit']; audience: Audience }) {
  const per = Math.max(1, merit.levelsPerPoint);
  const done = Math.min(per, merit.levelsTowardNext);
  const r = 40, c = 2 * Math.PI * r;
  const gap = per > 1 ? 6 : 0;
  const seg = c / per - gap;
  const until = merit.levelsUntilNextPoint;
  const you = audience === 'student';
  return (
    <div className="v2-an-merit">
      <svg viewBox="0 0 100 100" className="v2-an-ring" role="img" aria-label={`${done} of ${per} levels toward the next merit point`}>
        <g transform="rotate(-90 50 50)">
          {Array.from({ length: per }, (_, i) => (
            <circle key={i} cx="50" cy="50" r={r} className={i < done ? 'is-done' : ''}
              strokeDasharray={`${seg} ${c - seg}`} strokeDashoffset={-(i * (c / per)) - gap / 2} />
          ))}
        </g>
        <text x="50" y="50" textAnchor="middle" className="v2-an-ring-num">{until}</text>
        <text x="50" y="66" textAnchor="middle" className="v2-an-ring-sub">{until === 1 ? 'level' : 'levels'}</text>
      </svg>
      <div className="v2-an-merit-copy">
        <strong>{until === 1 ? '1 more level' : `${until} more levels`} to {you ? 'your' : 'the'} next merit point</strong>
        <span>Every {per} level{per === 1 ? '' : 's'} passed = 1 merit point on the Jamea portal.</span>
        <div className="v2-an-merit-facts">
          <span><b>{merit.pointsThisMonth}</b> this month</span>
          <span><b>{merit.pending}</b> on the way</span>
          <span><b>{merit.given}</b> given</span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- courses
export function CourseList({ data, onOpen }: { data: StudentAnalysis; onOpen?: (courseId: string, stepId: string | null) => void }) {
  if (!data.courses.length) return <p className="v2-an-soft">No course joined yet.</p>;
  return (
    <ul className="v2-an-courses">
      {data.courses.map(c => (
        <li key={c.courseId}>
          <span className="v2-an-course-icon" aria-hidden="true"><BookOpen size={17} /></span>
          <div className="v2-an-course-main">
            <div className="v2-an-course-head">
              <strong>{c.title || c.code}</strong>
            </div>
            <div className="v2-an-progress" aria-label={`${c.progressPercent}% done`}><i style={{ width: `${Math.max(2, c.progressPercent)}%` }} /></div>
            <small>
              {c.completed ? 'Completed — mashaAllah!' : [
                `${c.progressPercent}% done`,
                c.currentLevel ? `now in ${c.currentLevel}${c.currentLevelDescription ? ` · ${c.currentLevelDescription}` : ''}` : null,
                c.waitingForReview ? 'work with the teacher' : null,
              ].filter(Boolean).join(' · ')}
            </small>
          </div>
          {onOpen && c.structureVersion === 2 && (
            <button type="button" className="btn btn-outline v2-an-course-btn" onClick={() => onOpen(c.courseId, c.nextStep?.stepId ?? null)}>Open</button>
          )}
        </li>
      ))}
    </ul>
  );
}

export function Section({ title, icon, children, extra, className = '' }: { title: string; icon?: ReactNode; children: ReactNode; extra?: ReactNode; className?: string }) {
  return (
    <section className={`v2-an-section ${className}`}>
      <header><h2>{icon}{title}</h2>{extra}</header>
      {children}
    </section>
  );
}
