// owner: analysis — class-level view: marks spread, levels, hardest steps, shared focus areas, stuck students.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, CheckCircle2, Hourglass, Layers, Mountain, Send, Target, Users } from 'lucide-react';
import { apiFetch } from '@/api';
import { PenLoader } from '@/components/ui';
import type { NudgeRequest } from '../contracts';
import type { CohortAnalysis, CohortStuck } from './analysisTypes';
import { ErrorBox, initials } from './common';
import { lastActiveWords } from './analysisParts';
import './analysis.css';

const STUCK_OPTIONS = [7, 14, 30, 60];

function stuckMessage(s: CohortStuck): string {
  return `Salaam {name}, you have been working on ${s.courseLabel}, ${s.levelCode}, for a while — you are closer than you think! Spend ten minutes today on the next worksheet and send your work when you are ready. We are here to help.`;
}

export function ClassView({ branchId, onOpenStudent }: { branchId: string; onOpenStudent: (id: string, name: string) => void }) {
  const [courseId, setCourseId] = useState('');
  const [stuckDays, setStuckDays] = useState(14);
  const [data, setData] = useState<CohortAnalysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<Record<string, 'sending' | 'sent' | 'error'>>({});
  const request = useRef(0);

  const load = useCallback(async () => {
    const id = ++request.current;
    setLoading(true);
    setError(null);
    const p = new URLSearchParams({ stuckDays: String(stuckDays) });
    if (branchId) p.set('branchId', branchId);
    if (courseId) p.set('courseId', courseId);
    try {
      const result = await apiFetch<CohortAnalysis>(`/v2/analysis/cohort?${p}`);
      if (id === request.current) setData(result);
    } catch (err) {
      if (id === request.current) setError(err instanceof Error ? err.message : 'Could not load the class view.');
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [branchId, courseId, stuckDays]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setCourseId(''); }, [branchId]);

  const nudge = async (s: CohortStuck) => {
    setSent(cur => ({ ...cur, [s.studentId]: 'sending' }));
    try {
      const body: NudgeRequest = { studentIds: [s.studentId], message: stuckMessage(s), sendEmail: true };
      await apiFetch('/v2/insights/nudge', { method: 'POST', body });
      setSent(cur => ({ ...cur, [s.studentId]: 'sent' }));
    } catch {
      setSent(cur => ({ ...cur, [s.studentId]: 'error' }));
    }
  };

  const maxBar = useMemo(() => Math.max(1, ...(data?.histogram.map(h => h.count) ?? [1])), [data]);
  const stuckGroups = useMemo(() => {
    const groups = new Map<string, CohortStuck[]>();
    for (const s of data?.stuck ?? []) {
      const key = `${s.courseLabel} · ${s.levelCode}`;
      groups.set(key, [...(groups.get(key) ?? []), s]);
    }
    return [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [data]);

  return (
    <div className={`v2-an-class${loading && data ? ' is-refreshing' : ''}`}>
      <div className="v2-an-class-filters">
        <label className="v2-ins-branch">
          <span>Course</span>
          <select className="field" value={courseId} onChange={event => setCourseId(event.target.value)} aria-label="Choose course">
            <option value="">All courses</option>
            {data?.courses.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </label>
        <label className="v2-ins-branch">
          <span>Stuck after</span>
          <select className="field" value={stuckDays} onChange={event => setStuckDays(Number(event.target.value))} aria-label="Stuck after how many days">
            {STUCK_OPTIONS.map(d => <option key={d} value={d}>{d} days on one level</option>)}
          </select>
        </label>
      </div>

      {error && <ErrorBox message={error} onRetry={() => void load()} />}
      {!data && loading && <div className="v2-ins-loader"><PenLoader compact label="Looking at the whole class" /></div>}

      {data && (
        <>
          <div className="v2-an-kpis">
            <div><Users size={16} /><strong>{data.students}</strong><span>students{data.scope.courseLabel ? ' in this course' : ''}</span></div>
            <div><BarChart3 size={16} /><strong>{data.markedWork}</strong><span>marked pieces · {data.studentsWithMarks} students</span></div>
            <div><CheckCircle2 size={16} /><strong>{data.averageMark ?? '—'}</strong><span>average mark</span></div>
            <div><Target size={16} /><strong>{data.firstAttempt.rate == null ? '—' : `${data.firstAttempt.rate}%`}</strong><span>pass on the first try{data.firstAttempt.total ? ` (${data.firstAttempt.passed} of ${data.firstAttempt.total})` : ''}</span></div>
          </div>

          <div className="v2-an-class-grid">
            <section className="v2-an-section">
              <header><h2><BarChart3 size={16} />How the marks spread</h2></header>
              {data.markedWork ? (
                <div className="v2-an-hist" role="img" aria-label={`Marks 1 to 10: ${data.histogram.map(h => `${h.mark}: ${h.count}`).join(', ')}`}>
                  {data.histogram.map(h => {
                    const band = h.mark <= data.bands.revisionMax ? 'revision' : h.mark <= data.bands.passMax ? 'pass' : 'distinction';
                    return (
                      <div key={h.mark} className="v2-an-hist-col">
                        <span className="v2-an-hist-count">{h.count || ''}</span>
                        <span className={`v2-an-hist-bar is-${band}`} style={{ height: `${(h.count / maxBar) * 100}%` }} />
                        <span className="v2-an-hist-mark">{h.mark}</span>
                      </div>
                    );
                  })}
                </div>
              ) : <p className="v2-an-soft">No marked work yet.</p>}
              <div className="v2-an-legend">
                <span><i className="is-revision" /> Another try (≤{data.bands.revisionMax})</span>
                <span><i className="is-pass" /> Pass</span>
                <span><i className="is-distinction" /> Distinction ({data.bands.passMax + 1}+)</span>
              </div>
            </section>

            <section className="v2-an-section">
              <header><h2><Layers size={16} />Average mark per level</h2></header>
              {data.levelAverages.length ? (
                <ul className="v2-an-levels">
                  {data.levelAverages.map(l => (
                    <li key={`${l.courseId}-${l.levelCode}`}>
                      <span className="v2-an-level-name"><b>{l.courseLabel}</b> {l.levelLabel}</span>
                      <span className="v2-an-rubric-bar"><i style={{ width: `${l.average * 10}%` }} /></span>
                      <span className="v2-an-level-val">{l.average}<small> · {l.students} st.</small></span>
                    </li>
                  ))}
                </ul>
              ) : <p className="v2-an-soft">No marked levels yet.</p>}
            </section>

            <section className="v2-an-section">
              <header><h2><Mountain size={16} />Hardest steps</h2></header>
              {data.hardestSteps.length ? (
                <ul className="v2-an-hard">
                  {data.hardestSteps.map(s => (
                    <li key={s.stepId}>
                      <span className="v2-an-hard-num">{s.revisions}</span>
                      <div>
                        <strong>{[s.courseLabel, s.levelCode, s.stepCode].filter(Boolean).join(' · ')}{s.title ? ` — ${s.title}` : ''}</strong>
                        <small>Sent back {s.revisions === 1 ? 'once' : `${s.revisions} times`} · {s.attempts} tries by {s.students} student{s.students === 1 ? '' : 's'}{s.averageMark != null ? ` · average ${s.averageMark}` : ''}</small>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : <p className="v2-an-soft">No step stands out — students pass on the first try.</p>}
            </section>

            <section className="v2-an-section">
              <header><h2><Target size={16} />Common focus areas</h2></header>
              {data.commonFocus.length ? (
                <ul className="v2-an-focus">
                  {data.commonFocus.map(f => (
                    <li key={f.key}>
                      <span className="v2-an-focus-label">{f.label}</span>
                      <span className="v2-an-rubric-bar is-low"><i style={{ width: `${Math.max(6, (f.students / Math.max(1, data.studentsWithMarks || data.students)) * 100)}%` }} /></span>
                      <span className="v2-an-focus-n" title={f.text}>{f.students}</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="v2-an-soft">Nothing shared yet — focus areas appear once work is marked with the rubric or annotated.</p>}
              {data.commonFocus.length > 0 && <p className="v2-an-soft v2-an-focus-note">Students whose rubric marks are low on this point, or whose teachers often mention it.</p>}
            </section>
          </div>

          <section className="v2-an-section v2-an-stuck">
            <header>
              <h2><Hourglass size={16} />Stuck on the same level for {data.stuckDays}+ days</h2>
              <span className="v2-an-count">{data.stuckTotal}</span>
            </header>
            {!data.stuck.length ? (
              <p className="v2-an-soft">Nobody is stuck — every student moved up a level in the last {data.stuckDays} days or is waiting for our reply.</p>
            ) : stuckGroups.map(([group, list]) => (
              <div key={group} className="v2-an-stuck-group">
                <p className="v2-an-sub-head">{group} · {list.length} student{list.length === 1 ? '' : 's'}</p>
                <ul>
                  {list.map(s => {
                    const state = sent[s.studentId];
                    return (
                      <li key={`${s.studentId}-${s.courseId}`}>
                        <button type="button" className="v2-an-stuck-who" onClick={() => onOpenStudent(s.studentId, s.name)}>
                          <span className="v2-an-avatar is-small" aria-hidden="true">{initials(s.name)}</span>
                          <span>
                            <strong>{s.name}</strong>
                            <small>{s.days} days on {s.levelCode} · active {lastActiveWords(s.lastActiveAt).toLowerCase()}{s.lastNudgedAt ? ` · messaged ${lastActiveWords(s.lastNudgedAt).toLowerCase()}` : ''}</small>
                          </span>
                        </button>
                        <button type="button" className={`btn ${state === 'sent' ? 'btn-outline' : 'btn-primary'} v2-an-nudge`} onClick={() => void nudge(s)} disabled={state === 'sending' || state === 'sent'}>
                          {state === 'sent' ? <><CheckCircle2 size={14} /> Sent</> : state === 'sending' ? 'Sending…' : state === 'error' ? 'Try again' : <><Send size={14} /> Nudge</>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
            {data.stuckTotal > data.stuck.length && <p className="v2-an-soft">Showing the {data.stuck.length} longest waits of {data.stuckTotal}.</p>}
          </section>
        </>
      )}
    </div>
  );
}
