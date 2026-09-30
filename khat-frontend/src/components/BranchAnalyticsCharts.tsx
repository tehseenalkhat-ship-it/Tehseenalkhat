import { useState, type ReactNode } from 'react';

export type BranchActivityPoint = { month: string; activeStudents: number; logins: number };
export type BranchEntryPoint = { month: string; submitted: number; reviewed: number };
export type BranchEventPoint = { month: string; events: number };
export type BranchStatus = { status: string; count: number };
export type BranchTeacher = { id: string; name: string; entriesReviewed: number; avgResponseHours: number | null };
export type BranchProgress = { bucket: string; students: number };

type TrendPoint = { month: string };

const PLOT = { left: 48, right: 702, top: 20, bottom: 204 };

function monthLabel(month: string): string {
  const date = new Date(`${month}-01T12:00:00`);
  return Number.isNaN(date.getTime()) ? month : date.toLocaleDateString('en', { month: 'short', year: '2-digit' });
}

function numberLabel(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function visibleMonthLabels<T extends TrendPoint>(points: T[]): { point: T; index: number }[] {
  if (points.length <= 6) return points.map((point, index) => ({ point, index }));
  const step = Math.ceil((points.length - 1) / 5);
  return points.map((point, index) => ({ point, index })).filter(item => item.index % step === 0 || item.index === points.length - 1);
}

function ChartShell({ eyebrow = 'Branch analytics', title, description, children }: { eyebrow?: string; title: string; description: string; children: ReactNode }) {
  return (
    <section className="branch-chart-card">
      <header className="branch-chart-heading">
        <div><span>{eyebrow}</span><h3>{title}</h3><p>{description}</p></div>
      </header>
      {children}
    </section>
  );
}

function LegendButton({ color, label, value, active, onClick }: { color: string; label: string; value?: number; active: boolean; onClick: () => void }) {
  return <button className={`branch-chart-legend${active ? ' is-active' : ''}`} onClick={onClick} aria-pressed={active}><i style={{ background: color }} />{label}{value !== undefined && <strong>{numberLabel(value)}</strong>}</button>;
}

function MonthGrid({ points }: { points: TrendPoint[] }) {
  return (
    <>
      {[0, 1, 2, 3].map(row => {
        const y = PLOT.top + ((PLOT.bottom - PLOT.top) * row) / 3;
        return <line key={row} x1={PLOT.left} x2={PLOT.right} y1={y} y2={y} className="branch-chart-gridline" />;
      })}
      {visibleMonthLabels(points).map(({ point, index }) => {
        const x = PLOT.left + (points.length <= 1 ? 0 : index / (points.length - 1)) * (PLOT.right - PLOT.left);
        return <text key={point.month} x={x} y="226" textAnchor="middle" className="branch-chart-axis-label">{monthLabel(point.month)}</text>;
      })}
    </>
  );
}

function SelectedMonth({ month, rows, children }: { month?: string; rows: ReactNode; children?: ReactNode }) {
  return <div className="branch-chart-selected"><span>{month ? monthLabel(month) : 'Select a month'}</span><div>{rows}</div>{children}</div>;
}

export function ActivityTrendChart({ points }: { points: BranchActivityPoint[] }) {
  const [activeIndex, setActiveIndex] = useState(Math.max(0, points.length - 1));
  const [showStudents, setShowStudents] = useState(true);
  const [showLogins, setShowLogins] = useState(true);
  const safePoints = points.length ? points : [{ month: '', activeStudents: 0, logins: 0 }];
  const maxStudents = Math.max(1, ...safePoints.map(point => point.activeStudents));
  const maxLogins = Math.max(1, ...safePoints.map(point => point.logins));
  const xFor = (index: number) => PLOT.left + (safePoints.length <= 1 ? 0 : index / (safePoints.length - 1)) * (PLOT.right - PLOT.left);
  const yFor = (value: number, max: number) => PLOT.bottom - (value / max) * (PLOT.bottom - PLOT.top);
  const studentPath = safePoints.map((point, index) => `${index ? 'L' : 'M'} ${xFor(index)} ${yFor(point.activeStudents, maxStudents)}`).join(' ');
  const loginPath = safePoints.map((point, index) => `${index ? 'L' : 'M'} ${xFor(index)} ${yFor(point.logins, maxLogins)}`).join(' ');
  const selected = safePoints[Math.min(activeIndex, safePoints.length - 1)];
  const hasData = points.some(point => point.activeStudents > 0 || point.logins > 0);

  return (
    <ChartShell title="Student activity" description="Monthly active students and recorded logins. Hover or focus a point to inspect a month.">
      <div className="branch-chart-legends">
        <LegendButton color="var(--gold)" label="Active students" active={showStudents} onClick={() => setShowStudents(value => !value)} />
        <LegendButton color="var(--green)" label="Logins" active={showLogins} onClick={() => setShowLogins(value => !value)} />
      </div>
      <div className="branch-chart-plot">
        <svg viewBox="0 0 720 242" role="img" aria-label="Monthly student activity line graph">
          <MonthGrid points={safePoints} />
          {showStudents && <path d={studentPath} className="branch-chart-line branch-chart-line-gold" />}
          {showLogins && <path d={loginPath} className="branch-chart-line branch-chart-line-green" />}
          {safePoints.map((point, index) => (
            <g key={point.month || 'empty'} className="branch-chart-point-group" onMouseEnter={() => setActiveIndex(index)} onFocus={() => setActiveIndex(index)} onClick={() => setActiveIndex(index)} tabIndex={0} role="button" aria-label={`${point.month ? monthLabel(point.month) : 'No month'}: ${point.activeStudents} active students, ${point.logins} logins`}>
              {showStudents && <circle cx={xFor(index)} cy={yFor(point.activeStudents, maxStudents)} r={activeIndex === index ? 5 : 3.5} className="branch-chart-point-gold"><title>{point.month ? monthLabel(point.month) : 'No activity'} · {numberLabel(point.activeStudents)} active students</title></circle>}
              {showLogins && <circle cx={xFor(index)} cy={yFor(point.logins, maxLogins)} r={activeIndex === index ? 5 : 3.5} className="branch-chart-point-green"><title>{point.month ? monthLabel(point.month) : 'No activity'} · {numberLabel(point.logins)} logins</title></circle>}
              <circle cx={xFor(index)} cy="112" r="14" fill="transparent" />
            </g>
          ))}
        </svg>
        {!hasData && <span className="branch-chart-empty-hint">Activity will appear here as students use the platform.</span>}
      </div>
      <SelectedMonth month={selected.month} rows={<><span><i className="branch-dot-gold" />{numberLabel(selected.activeStudents)} active students</span><span><i className="branch-dot-green" />{numberLabel(selected.logins)} logins</span></>} />
    </ChartShell>
  );
}

export function EntryTrendChart({ points }: { points: BranchEntryPoint[] }) {
  const [activeIndex, setActiveIndex] = useState(Math.max(0, points.length - 1));
  const [showSubmitted, setShowSubmitted] = useState(true);
  const [showReviewed, setShowReviewed] = useState(true);
  const safePoints = points.length ? points : [{ month: '', submitted: 0, reviewed: 0 }];
  const maxValue = Math.max(1, ...safePoints.flatMap(point => [point.submitted, point.reviewed]));
  const selected = safePoints[Math.min(activeIndex, safePoints.length - 1)];
  const hasData = points.some(point => point.submitted > 0 || point.reviewed > 0);
  const groupWidth = (PLOT.right - PLOT.left) / safePoints.length;
  const barWidth = Math.min(19, groupWidth * 0.24);
  const usableHeight = PLOT.bottom - PLOT.top;

  return (
    <ChartShell title="Entries & reviews" description="Student checkpoint entries submitted and decisions recorded by month.">
      <div className="branch-chart-legends">
        <LegendButton color="var(--gold)" label="Submitted" active={showSubmitted} onClick={() => setShowSubmitted(value => !value)} />
        <LegendButton color="var(--green)" label="Reviewed" active={showReviewed} onClick={() => setShowReviewed(value => !value)} />
      </div>
      <div className="branch-chart-plot">
        <svg viewBox="0 0 720 242" role="img" aria-label="Monthly entries and reviews bar graph">
          <MonthGrid points={safePoints} />
          {safePoints.map((point, index) => {
            const center = PLOT.left + groupWidth * index + groupWidth / 2;
            const submittedHeight = (point.submitted / maxValue) * usableHeight;
            const reviewedHeight = (point.reviewed / maxValue) * usableHeight;
            return <g key={point.month || 'empty'} onMouseEnter={() => setActiveIndex(index)} onFocus={() => setActiveIndex(index)} onClick={() => setActiveIndex(index)} tabIndex={0} role="button" aria-label={`${point.month ? monthLabel(point.month) : 'No month'}: ${point.submitted} submitted, ${point.reviewed} reviewed`}>
              {showSubmitted && <rect x={center - barWidth - 2} y={PLOT.bottom - submittedHeight} width={barWidth} height={Math.max(0, submittedHeight)} rx="4" className="branch-chart-bar branch-chart-bar-gold" style={{ animationDelay: `${index * 35}ms` }}><title>{numberLabel(point.submitted)} submitted</title></rect>}
              {showReviewed && <rect x={center + 2} y={PLOT.bottom - reviewedHeight} width={barWidth} height={Math.max(0, reviewedHeight)} rx="4" className="branch-chart-bar branch-chart-bar-green" style={{ animationDelay: `${index * 35}ms` }}><title>{numberLabel(point.reviewed)} reviewed</title></rect>}
              <rect x={center - groupWidth / 2} y={PLOT.top} width={groupWidth} height={usableHeight} fill="transparent" />
            </g>;
          })}
        </svg>
        {!hasData && <span className="branch-chart-empty-hint">The monthly comparison will fill in as entries arrive.</span>}
      </div>
      <SelectedMonth month={selected.month} rows={<><span><i className="branch-dot-gold" />{numberLabel(selected.submitted)} submitted</span><span><i className="branch-dot-green" />{numberLabel(selected.reviewed)} reviewed</span></>} />
    </ChartShell>
  );
}

const STATUS_COLORS: Record<string, string> = {
  pending: 'var(--line)', assigned: 'var(--gold-soft)', in_review: 'var(--green)', reviewed: 'var(--gold)', redo_needed: 'var(--maroon)',
};
const KNOWN_STATUSES = ['pending', 'assigned', 'in_review', 'reviewed', 'redo_needed'];

function statusLabel(status: string): string {
  return status.split('_').map(word => word[0]?.toUpperCase() + word.slice(1)).join(' ');
}

export function EntryStatusChart({ statuses }: { statuses: BranchStatus[] }) {
  const [activeStatus, setActiveStatus] = useState<string | null>(null);
  const counts = new Map(statuses.map(item => [item.status, item.count]));
  const items = [...new Set([...KNOWN_STATUSES, ...statuses.map(item => item.status)])].map(status => ({ status, count: counts.get(status) ?? 0, color: STATUS_COLORS[status] ?? 'var(--muted)' }));
  const total = items.reduce((sum, item) => sum + item.count, 0);
  const circumference = 2 * Math.PI * 70;
  let consumed = 0;
  const active = activeStatus ? items.find(item => item.status === activeStatus) : null;

  return (
    <ChartShell title="Entry status" description="Current state of student checkpoint entries in this branch.">
      <div className="branch-status-chart">
        <svg viewBox="0 0 240 240" role="img" aria-label={`Entry status distribution, ${numberLabel(total)} total entries`}>
          <circle cx="120" cy="120" r="70" className="branch-donut-track" />
          {total > 0 && items.filter(item => item.count > 0).map(item => {
            const length = (item.count / total) * circumference;
            const offset = -consumed;
            consumed += length;
            return <circle key={item.status} cx="120" cy="120" r="70" fill="none" stroke={item.color} strokeWidth={activeStatus && activeStatus !== item.status ? 12 : 19} strokeDasharray={`${length} ${circumference - length}`} strokeDashoffset={offset} transform="rotate(-90 120 120)" className="branch-donut-slice" onMouseEnter={() => setActiveStatus(item.status)} onFocus={() => setActiveStatus(item.status)} tabIndex={0} role="button" aria-label={`${statusLabel(item.status)}: ${numberLabel(item.count)}`}><title>{statusLabel(item.status)} · {numberLabel(item.count)}</title></circle>;
          })}
          <text x="120" y="116" textAnchor="middle" className="branch-donut-total">{numberLabel(active?.count ?? total)}</text>
          <text x="120" y="137" textAnchor="middle" className="branch-donut-caption">{active ? statusLabel(active.status) : 'entries'}</text>
        </svg>
        <div className="branch-status-legend">
          {items.map(item => <LegendButton key={item.status} color={item.color} label={statusLabel(item.status)} value={item.count} active={activeStatus === null || activeStatus === item.status} onClick={() => setActiveStatus(current => current === item.status ? null : item.status)} />)}
        </div>
      </div>
      {total === 0 && <p className="branch-chart-footnote">No entries have been recorded yet; this chart is ready for new activity.</p>}
    </ChartShell>
  );
}

export function EventTrendChart({ points }: { points: BranchEventPoint[] }) {
  const [activeIndex, setActiveIndex] = useState(Math.max(0, points.length - 1));
  const safePoints = points.length ? points : [{ month: '', events: 0 }];
  const max = Math.max(1, ...safePoints.map(point => point.events));
  const selected = safePoints[Math.min(activeIndex, safePoints.length - 1)];
  const hasData = points.some(point => point.events > 0);
  const width = (PLOT.right - PLOT.left) / safePoints.length;
  const height = PLOT.bottom - PLOT.top;

  return (
    <ChartShell title="Branch events" description="Events scheduled for the branch by month.">
      <div className="branch-chart-plot">
        <svg viewBox="0 0 720 242" role="img" aria-label="Branch events by month">
          <MonthGrid points={safePoints} />
          {safePoints.map((point, index) => {
            const barHeight = point.events / max * height;
            const barWidth = Math.min(34, width * .48);
            const x = PLOT.left + width * index + (width - barWidth) / 2;
            return <g key={point.month || 'empty'} onMouseEnter={() => setActiveIndex(index)} onFocus={() => setActiveIndex(index)} onClick={() => setActiveIndex(index)} tabIndex={0} role="button" aria-label={`${point.month ? monthLabel(point.month) : 'No month'}: ${point.events} events`}>
              <rect x={x} y={PLOT.bottom - barHeight} width={barWidth} height={Math.max(0, barHeight)} rx="5" className="branch-chart-bar branch-chart-bar-gold" style={{ animationDelay: `${index * 35}ms` }}><title>{point.events} events</title></rect>
              <rect x={PLOT.left + width * index} y={PLOT.top} width={width} height={height} fill="transparent" />
            </g>;
          })}
        </svg>
        {!hasData && <span className="branch-chart-empty-hint">Scheduled branch events will be plotted here.</span>}
      </div>
      <SelectedMonth month={selected.month} rows={<span><i className="branch-dot-gold" />{numberLabel(selected.events)} events</span>} />
    </ChartShell>
  );
}

export function TeacherThroughputChart({ teachers }: { teachers: BranchTeacher[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const max = Math.max(1, ...teachers.map(teacher => teacher.entriesReviewed));
  const selected = teachers.find(teacher => teacher.id === selectedId);

  return (
    <ChartShell title="Teacher throughput" description="Reviewed entries and average response time for teachers appointed to this branch.">
      <div className="branch-throughput-list">
        {(teachers.length ? teachers : [{ id: 'empty', name: 'No teacher data yet', entriesReviewed: 0, avgResponseHours: null }]).map(teacher => (
          <button key={teacher.id} className={`branch-throughput-item${selectedId === teacher.id ? ' is-selected' : ''}`} onClick={() => setSelectedId(current => current === teacher.id ? null : teacher.id)} aria-pressed={selectedId === teacher.id}>
            <span className="branch-throughput-name">{teacher.name}</span>
            <span className="branch-throughput-track"><i style={{ width: `${teacher.entriesReviewed / max * 100}%` }} /></span>
            <strong>{numberLabel(teacher.entriesReviewed)}</strong>
          </button>
        ))}
      </div>
      <SelectedMonth rows={selected ? <><span>{numberLabel(selected.entriesReviewed)} reviews</span><span>{selected.avgResponseHours == null ? 'No response-time data' : `${Math.round(selected.avgResponseHours)}h average response`}</span></> : <span>Choose a teacher to view response-time detail</span>} />
    </ChartShell>
  );
}

export function StudentProgressChart({ progress }: { progress: BranchProgress[] }) {
  const [activeBucket, setActiveBucket] = useState<string | null>(null);
  const buckets = ['0–24%', '25–49%', '50–74%', '75–100%'].map(bucket => ({ bucket, students: progress.find(item => item.bucket === bucket)?.students ?? 0 }));
  const max = Math.max(1, ...buckets.map(bucket => bucket.students));
  const active = buckets.find(bucket => bucket.bucket === activeBucket);
  const total = buckets.reduce((sum, bucket) => sum + bucket.students, 0);

  return (
    <ChartShell title="Student course progress" description="Branch enrollment distribution by percentage completed.">
      <div className="branch-progress-bars">
        {buckets.map((bucket, index) => <button key={bucket.bucket} className={`branch-progress-row${activeBucket === bucket.bucket ? ' is-selected' : ''}`} onClick={() => setActiveBucket(current => current === bucket.bucket ? null : bucket.bucket)} aria-pressed={activeBucket === bucket.bucket}>
          <span>{bucket.bucket}</span><i><b style={{ width: `${bucket.students / max * 100}%`, animationDelay: `${index * 70}ms` }} /></i><strong>{numberLabel(bucket.students)}</strong>
        </button>)}
      </div>
      <SelectedMonth rows={active ? <span>{numberLabel(active.students)} enrollments in the {active.bucket} range</span> : <span>{numberLabel(total)} enrollments across all progress bands</span>} />
      {total === 0 && <p className="branch-chart-footnote">Progress bands will populate after students enroll in courses.</p>}
    </ChartShell>
  );
}
