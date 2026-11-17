// owner: teacher (v3, notes 5.10/5.11) — simple bars for the Students view: how many students in each
// group (tap a bar → those students are listed below), plus three headline numbers from the class
// analysis: average mark, passed first time, and the step where most students get stuck.
import { useEffect, useState } from 'react';
import { BarChart3, Mountain, Star, Target } from 'lucide-react';
import { apiFetch } from '@/api';
import type { StudentSegment } from '../contracts';
import type { CohortAnalysis } from './analysisTypes';
import { SEGMENT_META } from './InsightsPage';
import './insights-v3.css';

export function InsightCharts({ counts, branchId, active, onPick, onOpenClass }: {
  counts: Record<StudentSegment, number>;
  branchId: string;
  active: StudentSegment | '';
  onPick: (s: StudentSegment | '') => void;
  onOpenClass: () => void;
}) {
  const [cohort, setCohort] = useState<CohortAnalysis | null>(null);
  useEffect(() => {
    let alive = true;
    const p = new URLSearchParams();
    if (branchId) p.set('branchId', branchId);
    apiFetch<CohortAnalysis>(`/v2/analysis/cohort?${p.toString()}`, { silent: true })
      .then(c => { if (alive) setCohort(c); })
      .catch(() => { if (alive) setCohort(null); });
    return () => { alive = false; };
  }, [branchId]);

  const total = SEGMENT_META.reduce((s, m) => s + (counts[m.key] ?? 0), 0);
  const max = Math.max(1, ...SEGMENT_META.map(m => counts[m.key] ?? 0));
  const hardest = cohort?.hardestSteps?.[0] ?? null;
  const firstRate = cohort?.firstAttempt?.rate;

  return (
    <section className="v3-ichart" aria-label="Charts">
      <div className="v3-ichart-card v3-ichart-bars">
        <header><h2><BarChart3 size={16} /> Students by group</h2><small>Tap a bar to see who is in it</small></header>
        <ul className="v3in-bars" role="list">
          {SEGMENT_META.map(m => {
            const n = counts[m.key] ?? 0;
            const pct = total ? Math.round((n / total) * 100) : 0;
            return (
              <li key={m.key}>
                <button
                  type="button"
                  className={`v3in-bar-row v2-tone-${m.tone}${active === m.key ? ' is-active' : ''}`}
                  onClick={() => onPick(active === m.key ? '' : m.key)}
                  title={`${m.label}: ${n} student${n === 1 ? '' : 's'} (${pct}%)`}
                  aria-pressed={active === m.key}
                >
                  <span className="v3in-bar-label">{m.label}</span>
                  <span className="v3in-bar-track"><i style={{ width: `${Math.max(n ? 3 : 0, (n / max) * 100)}%` }} /></span>
                  <span className="v3in-bar-value"><b>{n}</b> <small>{pct}%</small></span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="v3-ichart-tiles">
        <div className="v3-tile">
          <span className="v3-tile-icon"><Star size={18} /></span>
          <small>Average mark</small>
          <strong>{cohort?.averageMark != null ? `${cohort.averageMark.toFixed(1)}/10` : '—'}</strong>
          <span className="muted">{cohort ? `${cohort.markedWork} marked piece${cohort.markedWork === 1 ? '' : 's'}` : 'Loading…'}</span>
        </div>
        <div className="v3-tile">
          <span className="v3-tile-icon"><Target size={18} /></span>
          <small>Passed on the first try</small>
          <strong>{firstRate != null ? `${firstRate}%` : "—"}</strong>
          <span className="muted">{cohort ? `${cohort.firstAttempt.passed} of ${cohort.firstAttempt.total} first attempts` : ''}</span>
        </div>
        <button type="button" className="v3-tile is-link" onClick={onOpenClass}>
          <span className="v3-tile-icon"><Mountain size={18} /></span>
          <small>Where students get stuck</small>
          <strong className="v3-tile-text">{hardest ? `${hardest.courseLabel} · ${hardest.levelCode.replace(/^LV0?/, 'Level ')} · ${hardest.title}` : 'No hard step yet'}</strong>
          <span className="muted">{hardest ? `${hardest.revisions} sent back of ${hardest.attempts} tries · see the class view` : 'See the class view for the marks charts'}</span>
        </button>
      </div>
    </section>
  );
}
