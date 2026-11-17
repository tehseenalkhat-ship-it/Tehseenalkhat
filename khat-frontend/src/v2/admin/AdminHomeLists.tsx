import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, X } from 'lucide-react';
import { apiFetch } from '@/api';
import { openV2 } from '../nav';
import type { CourseSummary, InboxItem, InsightsSummary, MeritToGive, ReviewNetwork } from '../contracts';
import type { AdminTodayBranch } from './adminHomeTypes';
import { ErrorBox, Loading, plural } from './shared';
import '../announce/v3-comms.css';

// owner: admin-comms (v3 notes 6.19 + 6.1) — tap a number card on the admin home → the names
// appear right below and the page scrolls to them; master sees branches side by side.

export type HomeCardKey = 'inbox' | 'merit' | 'push' | 'courses' | 'teachers';

type Row = { key: string; title: ReactNode; sub?: ReactNode; meta?: ReactNode };
type ListResult = { rows: Row[]; more: number; action: { label: string; go: () => void } };

const TITLES: Record<HomeCardKey, string> = {
  inbox: 'Waiting for review', merit: 'Merit points to give', push: 'Students who need a push',
  courses: 'Courses to finish', teachers: 'Teachers and their load',
};
const MAX = 25;

function wait(hours: number): string {
  if (hours < 1) return 'under 1 hour';
  if (hours < 48) return `${Math.round(hours)} hours`;
  return `${Math.round(hours / 24)} days`;
}

async function loadList(card: HomeCardKey, branchId: string): Promise<ListResult> {
  const b = branchId ? `branchId=${encodeURIComponent(branchId)}` : '';
  if (card === 'inbox') {
    const items = await apiFetch<InboxItem[]>(`/v2/review/inbox?status=open${b ? `&${b}` : ''}`);
    return {
      rows: items.slice(0, MAX).map(i => ({
        key: i.submission.id,
        title: i.student.name,
        sub: `${i.step.courseTitle} · Level ${Number(i.step.levelCode.replace(/\D/g, '')) || 1} · ${i.step.title ?? 'Step'}`,
        meta: <span className={`v3-chip${i.waitingHours >= 72 ? ' is-draft' : ''}`}>{wait(i.waitingHours)}</span>,
      })),
      more: Math.max(0, items.length - MAX),
      action: { label: 'Open the review inbox', go: () => openV2('v2-inbox') },
    };
  }
  if (card === 'merit') {
    const res = await apiFetch<MeritToGive>(`/v2/merit/to-give${b ? `?${b}` : ''}`);
    return {
      rows: res.students.slice(0, MAX).map(s => ({
        key: s.studentId, title: s.studentName,
        sub: [s.trNumber ? `TR ${s.trNumber}` : null, s.branchName, s.entries.map(e => e.sourceLabel).join(' · ')].filter(Boolean).join(' · '),
        meta: <b>{plural(s.total, 'point')}</b>,
      })),
      more: Math.max(0, res.students.length - MAX),
      action: { label: 'Open merit points', go: () => openV2('v2-merit') },
    };
  }
  if (card === 'push') {
    const res = await apiFetch<InsightsSummary>(`/v2/insights/students?segment=needs_push&limit=${MAX}${b ? `&${b}` : ''}`);
    return {
      rows: res.students.map(s => ({ key: s.studentId, title: s.name, sub: s.reason, meta: s.branchName ? <span className="v3-chip">{s.branchName}</span> : null })),
      more: Math.max(0, (res.counts?.needs_push ?? res.total) - res.students.length),
      action: { label: 'Open student insights', go: () => openV2('v2-insights', { segment: 'needs_push' }) },
    };
  }
  if (card === 'courses') {
    const list = await apiFetch<CourseSummary[]>(`/v2/courses${b ? `?${b}` : ''}`);
    const todo = list.filter(c => c.structureVersion === 2 && (c.status === 'draft' || c.counts.missing > 0));
    return {
      rows: todo.slice(0, MAX).map(c => ({
        key: c.id, title: c.title, sub: c.status === 'draft' ? 'Draft — students cannot see it yet' : `${plural(c.counts.missing, 'file')} missing`,
        meta: <span className={`v3-chip${c.status === 'draft' ? ' is-draft' : ''}`}>{c.status === 'draft' ? 'Draft' : 'Live'}</span>,
      })),
      more: Math.max(0, todo.length - MAX),
      action: { label: 'Open the course builder', go: () => openV2('v2-builder', { builderCourseId: null, courseId: null }) },
    };
  }
  const net = await apiFetch<ReviewNetwork>(`/v2/review/network${b ? `?${b}` : ''}`);
  const sorted = [...net.reviewers].sort((x, y) => Number(x.available) - Number(y.available) || y.openNow / Math.max(1, y.threshold) - x.openNow / Math.max(1, x.threshold));
  return {
    rows: sorted.slice(0, MAX).map(r => ({
      key: r.teacherId, title: r.name,
      sub: `${r.branchName ?? ''}${r.awayUntil ? ` · away until ${new Date(r.awayUntil).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''}`,
      meta: <span className={`v3-chip${r.available ? ' is-live' : ' is-draft'}`}>{r.openNow} of {r.threshold}{r.available ? '' : r.awayUntil ? ' · away' : ' · full'}</span>,
    })),
    more: Math.max(0, sorted.length - MAX),
    action: { label: 'Open the review network', go: () => openV2('v2-policies', { policiesView: 'network' }) },
  };
}

export function HomeNames({ card, branchId, onClose }: { card: HomeCardKey; branchId: string; onClose: () => void }) {
  const ref = useRef<HTMLElement>(null);
  const [data, setData] = useState<ListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    setData(null); setError(null);
    loadList(card, branchId).then(setData).catch(err => setError(err instanceof Error ? err.message : 'Could not load the names.'));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [card, branchId]);
  useEffect(() => { ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, [card]);
  return (
    <section ref={ref} className="v3-names" aria-label={TITLES[card]} aria-live="polite">
      <div className="v3-names-head">
        <h2>{TITLES[card]}</h2>
        <span className="v2-grow" />
        {data && <button type="button" className="btn btn-outline v2-btn-sm" onClick={data.action.go}>{data.action.label} <ArrowRight size={14} /></button>}
        <button type="button" className="v2-icon-btn" aria-label="Close the list" onClick={onClose}><X size={16} /></button>
      </div>
      {error && <div style={{ padding: 12 }}><ErrorBox message={error} onRetry={load} /></div>}
      {!data && !error && <Loading label="Finding the names…" />}
      {data && data.rows.length === 0 && <p className="v3-names-empty">Nobody here right now.</p>}
      {data && data.rows.length > 0 && (
        <ul>
          {data.rows.map(r => (
            <li key={r.key}>
              <b>{r.title}</b>
              <small>{r.sub}</small>
              <span>{r.meta}</span>
            </li>
          ))}
        </ul>
      )}
      {data && data.more > 0 && <p className="v3-names-empty">and {data.more} more — open the full list.</p>}
    </section>
  );
}

/** Master only: the branches side by side, one bar per branch for each measure. */
export function BranchCompare({ rows, onPick }: { rows: AdminTodayBranch[]; onPick: (id: string) => void }) {
  const metrics: { key: string; label: string; value: (b: AdminTodayBranch) => number | null; fmt: (v: number) => string; max?: number }[] = [
    { key: 'students', label: 'Students', value: b => b.students, fmt: v => String(v) },
    { key: 'active', label: 'Active in the last 30 days', value: b => (b.students ? Math.round((b.active30d / b.students) * 100) : null), fmt: v => `${v}%`, max: 100 },
    { key: 'answered', label: 'Work answered within 3 days', value: b => b.answeredWithin72hPct, fmt: v => `${Math.round(v)}%`, max: 100 },
    { key: 'waiting', label: 'Waiting for review now', value: b => b.waiting, fmt: v => String(v) },
  ];
  return (
    <section className="v2-home-section" aria-labelledby="v3-compare">
      <div className="v2-home-section-head">
        <h2 id="v3-compare">Branches side by side</h2>
        <p className="muted">Tap a branch name to see only its day.</p>
      </div>
      <div className="v3-card v3-compare-grid">
        {metrics.map(m => {
          const values = rows.map(b => m.value(b));
          const max = m.max ?? Math.max(1, ...values.map(v => v ?? 0));
          return (
            <div key={m.key} className="v3-compare-metric">
              <h3>{m.label}</h3>
              {rows.map((b, i) => (
                <div key={b.branchId} className="v3-compare-row">
                  <button type="button" className="v2-link" style={{ justifyContent: 'flex-start' }} onClick={() => onPick(b.branchId)}>{b.name.split(' /')[0]}</button>
                  <span className="v3cm-bar"><i style={{ width: `${values[i] === null ? 0 : Math.max(2, ((values[i] ?? 0) / max) * 100)}%` }} /></span>
                  <b>{values[i] === null ? '—' : m.fmt(values[i]!)}</b>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}
