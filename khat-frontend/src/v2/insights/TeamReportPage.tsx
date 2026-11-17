// owner: insights — team self-assessment: who answered whom, how fast, what is waiting.
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, ClipboardCheck, Clock, GraduationCap, Hourglass, RefreshCw, Users } from 'lucide-react';
import { apiFetch } from '@/api';
import { PenLoader } from '@/components/ui';
import type { BranchMetrics, TeamMember, TeamReport } from '../contracts';
import { AccountabilityPanel } from '../teacher/AccountabilityPanel';
import { Bar, BranchSelect, ErrorBox, hoursLabel, initials, useStaffScope } from './common';
import './insights.css';

type Props = Record<string, never>;
const RANGES = [7, 30, 90] as const;

function pctLabel(value: number | null): string {
  return value == null ? '—' : `${Math.round(value)}%`;
}

function BranchCard({ b, days }: { b: BranchMetrics; days: number }) {
  const activePct = b.students ? Math.round((b.active30d / b.students) * 100) : 0;
  const within = b.answeredWithin72hPct;
  const withinTone = within == null ? 'muted' : within >= 80 ? 'positive' : within >= 50 ? 'warning' : 'danger';
  return (
    <article className="v2-team-branch">
      <header>
        <div>
          <span className="eyebrow">Branch</span>
          <h3>{b.branchName}</h3>
        </div>
        {b.overdueNow > 0
          ? <span className="v2-seg-pill v2-tone-danger"><AlertTriangle size={12} /> {b.overdueNow} overdue</span>
          : <span className="v2-seg-pill v2-tone-positive"><CheckCircle2 size={12} /> Nothing overdue</span>}
      </header>

      <div className="v2-team-headline">
        <div>
          <strong>{pctLabel(within)}</strong>
          <span>answered within 72 hours</span>
          <Bar value={within ?? 0} max={100} tone={withinTone} />
        </div>
        <div>
          <strong>{hoursLabel(b.avgWaitHours)}</strong>
          <span>average wait for a first reply</span>
        </div>
      </div>

      <dl className="v2-team-metrics">
        <div><dt><Users size={14} /> Students</dt><dd>{b.students}</dd></div>
        <div><dt>Teachers</dt><dd>{b.teachers}</dd></div>
        <div className="v2-team-wide"><dt>Active in {days} days</dt><dd>{b.active30d} <small>({activePct}%)</small></dd><Bar value={b.active30d} max={b.students} tone="positive" /></div>
        <div><dt>Students per teacher</dt><dd>{b.studentsPerTeacher ?? '—'}</dd></div>
        <div><dt><ClipboardCheck size={14} /> Work sent</dt><dd>{b.submissions30d}</dd></div>
        <div><dt><Hourglass size={14} /> Waiting now</dt><dd>{b.pendingNow}</dd></div>
        <div><dt>Marked automatically</dt><dd>{b.autoMarked30d}</dd></div>
        <div><dt><GraduationCap size={14} /> Levels passed</dt><dd>{b.levelsPassed30d}</dd></div>
      </dl>
    </article>
  );
}

function TeamTable({ team, days }: { team: TeamMember[]; days: number }) {
  const maxReviewed = Math.max(1, ...team.map(t => t.reviewed30d));
  if (!team.length) return <p className="muted v2-team-empty">No teachers found for this branch yet.</p>;
  return (
    <div className="v2-team-table" role="table" aria-label="Teacher self-assessment">
      <div className="v2-team-row v2-team-head" role="row">
        <span role="columnheader">Teacher</span>
        <span role="columnheader">Answered ({days} days)</span>
        <span role="columnheader">Share of branch</span>
        <span role="columnheader">Avg reply time</span>
        <span role="columnheader">Waiting</span>
        <span role="columnheader">Overdue</span>
        <span role="columnheader">Moved away</span>
        <span role="columnheader">Auto-marked</span>
      </div>
      {team.map(t => (
        <div className="v2-team-row" role="row" key={t.teacherId}>
          <span role="cell" className="v2-team-who">
            <i aria-hidden="true">{initials(t.name)}</i>
            <span><strong>{t.name}</strong><small>{t.branchName ?? '—'}</small></span>
          </span>
          <span role="cell" data-label="Answered" className="v2-team-bar-cell"><Bar value={t.reviewed30d} max={maxReviewed} label={t.reviewed30d} /></span>
          <span role="cell" data-label="Share of branch" className="v2-team-bar-cell"><Bar value={t.shareOfBranchPct} max={100} tone="positive" label={`${Math.round(t.shareOfBranchPct)}%`} /></span>
          <span role="cell" data-label="Avg reply time">{hoursLabel(t.avgResponseHours)}</span>
          <span role="cell" data-label="Waiting">{t.pendingNow}</span>
          <span role="cell" data-label="Overdue" className={t.overdueNow ? 'v2-team-alert' : ''}>{t.overdueNow}</span>
          <span role="cell" data-label="Moved away">{t.divertedAway30d}</span>
          <span role="cell" data-label="Auto-marked">{t.autoMarked30d}</span>
        </div>
      ))}
    </div>
  );
}

export function V2TeamReportPage(_props: Props) {
  const scope = useStaffScope();
  const [days, setDays] = useState<number>(30);
  const [branchId, setBranchId] = useState('');
  const [report, setReport] = useState<TeamReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ days: String(days) });
      if (branchId) qs.set('branchId', branchId);
      setReport(await apiFetch<TeamReport>(`/v2/insights/team?${qs.toString()}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the team report.');
    } finally {
      setLoading(false);
    }
  }, [days, branchId]);

  useEffect(() => { if (scope.ready) void load(); }, [load, scope.ready]);

  const single = report?.branches.length === 1 ? report.branches[0] : null;

  return (
    <main className="page portal-page v2-ins-page">
      <header className="branch-analytics-hero v2-ins-hero">
        <div>
          <p className="eyebrow"><Users size={13} /> Team self-assessment{single ? ` · ${single.branchName}` : ''}</p>
          <h1>How our team is doing</h1>
          <p>Who answered whom, how quickly, and what is still waiting — so we can look after our students together.</p>
        </div>
        <div className="v2-ins-hero-actions">
          {scope.isMaster && <BranchSelect branches={scope.branches} value={branchId} onChange={setBranchId} />}
          <div className="branch-range-control v2-range" role="group" aria-label="Choose time range">
            {RANGES.map(value => <button type="button" key={value} className={days === value ? 'active' : ''} onClick={() => setDays(value)} aria-pressed={days === value}>{value} days</button>)}
          </div>
          <button type="button" className="btn btn-outline v2-ins-btn v2-ins-icon-btn" onClick={() => void load()} disabled={loading} aria-label="Refresh">
            <RefreshCw size={15} className={loading ? 'v2-spin' : ''} />
          </button>
        </div>
      </header>

      {error && <ErrorBox message={error} onRetry={() => void load()} />}
      {loading && !report && <div className="v2-ins-loader"><PenLoader compact label="Loading the team report" /></div>}

      {report && (
        <>
          <AccountabilityPanel branchId={branchId} days={days} />
          <section className={`v2-team-branches${report.branches.length === 1 ? ' is-single' : ''}`} aria-label="Branches">
            {report.branches.map(b => <BranchCard key={b.branchId} b={b} days={days} />)}
          </section>

          <section className="v2-ins-list-card v2-team-card">
            <div className="v2-team-card-head">
              <div>
                <h2>Teachers</h2>
                <p className="muted">Answers given in the last {days} days. “Share of branch” is each teacher’s part of all answers to their branch’s students.</p>
              </div>
              <Clock size={18} aria-hidden="true" />
            </div>
            <TeamTable team={report.team} days={days} />
          </section>

          <p className="v2-team-foot muted">
            Waiting time counts from the moment a student sends work to the first reply; work still waiting is counted up to now.
            Overdue = waiting longer than the branch’s “move to another teacher” time (normally 72 hours). Updated {new Date(report.generatedAt).toLocaleString()}.
          </p>
        </>
      )}
    </main>
  );
}
