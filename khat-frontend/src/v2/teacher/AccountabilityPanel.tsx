import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, Moon } from 'lucide-react';
import { apiFetch } from '@/api';
import type { AccountabilityReport, AccountabilityStatus } from './teacherTypes';
import './teacher.css';

const META: Record<AccountabilityStatus, { label: string; icon: typeof Clock }> = {
  not_responding: { label: 'Not responding', icon: AlertTriangle },
  slow: { label: 'Slow to answer', icon: Clock },
  ok: { label: 'Answering in time', icon: CheckCircle2 },
  idle: { label: 'Quiet', icon: Moon },
};

/** v3 (5.3) — "Who is responding": every teacher with a plain status and reason, problems first. */
export function AccountabilityPanel({ branchId, days }: { branchId: string; days: number }) {
  const [report, setReport] = useState<AccountabilityReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const qs = new URLSearchParams({ days: String(days) });
    if (branchId) qs.set('branchId', branchId);
    apiFetch<AccountabilityReport>(`/v2/insights/accountability?${qs.toString()}`, { silent: true })
      .then(r => { if (alive) { setReport(r); setError(null); } })
      .catch(err => { if (alive) setError(err instanceof Error ? err.message : 'Could not load.'); });
    return () => { alive = false; };
  }, [branchId, days]);

  return (
    <section className="v3-acc" aria-label="Who is responding">
      <header className="v3-acc-head">
        <div>
          <h2>Who is responding</h2>
          <p className="muted">Work waits {report?.divertHours ?? 72} hours before it moves to the next teacher; after 4 days the student gets an automatic mark. Teachers who let that happen show here first.</p>
        </div>
        {report && (
          <div className="v3-acc-counts">
            {(['not_responding', 'slow', 'ok', 'idle'] as AccountabilityStatus[]).map(s => (
              <span key={s} className={`v3-acc-count st-${s}`}><b>{report.counts[s]}</b> {META[s].label.toLowerCase()}</span>
            ))}
          </div>
        )}
      </header>
      {error && <p className="v2-inline-error">{error}</p>}
      {!report && !error && <p className="muted">Loading…</p>}
      {report && !report.teachers.length && <p className="muted">No teachers found.</p>}
      {report && report.teachers.length > 0 && (
        <ul className="v3-acc-list">
          {report.teachers.map(t => {
            const M = META[t.status];
            // v3 audit 26: work open but no answer for a week reads "Not answering lately", not "Slow"/"in time".
            const lately = /^Not answering lately · /.test(t.reason);
            return (
              <li key={t.teacherId} className={`v3-acc-row st-${t.status}`}>
                <span className="v3-acc-status"><M.icon size={16} /> {lately ? 'Not answering lately' : M.label}</span>
                <span className="v3-acc-who"><strong>{t.name}</strong>{t.branchName && <small>{t.branchName}</small>}</span>
                <span className="v3-acc-reason">{lately ? t.reason.replace(/^Not answering lately · /, '').replace(/^./, c => c.toUpperCase()) : t.reason}</span>
                <span className="v3-acc-nums">
                  <span><b>{t.pendingNow}</b> waiting</span>
                  <span><b>{t.reviewed30d}</b> answered</span>
                  <span><b>{t.avgResponseHours != null ? `${Math.round(t.avgResponseHours)} h` : '—'}</b> avg reply</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
