import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, CalendarOff, Gauge, Globe2, Network, Plus, Search, Trash2, UserX, Wand2 } from 'lucide-react';
import { apiFetch } from '@/api';
import type { ReviewerLoad, ReviewerSettingsUpdate, ReviewNetwork } from '../contracts';
import { Dialog, EmptyState, ErrorBox, Loading, NumberStepper, errorText, formatDate, toast, type Branch } from './shared';

function isAway(r: ReviewerLoad): boolean {
  return Boolean(r.awayUntil && new Date(r.awayUntil).getTime() > Date.now());
}

export function ReviewNetworkView({ branchId, branches }: { branchId: string; branches: Branch[] }) {
  const [net, setNet] = useState<ReviewNetwork | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ReviewerLoad | null>(null);
  const [filter, setFilter] = useState<'all' | 'attention'>('all');
  const [limitFor, setLimitFor] = useState<{ branchId: string; name: string } | null>(null);
  const [busyBranch, setBusyBranch] = useState<string | null>(null);

  const autoSetup = async (bid: string, name: string, threshold?: number) => {
    setBusyBranch(bid);
    try {
      const res = await apiFetch<ReviewNetwork>('/v2/review/network/auto', { method: 'POST', body: { branchId: bid, includeNairobi: true, ...(threshold ? { threshold } : {}) } });
      if (res?.reviewers) setNet(res); else await load();
      toast(threshold ? `Every teacher in ${name} now has a limit of ${threshold}.` : `${name} is set up: each teacher sends overflow to the next, then to the Nairobi team.`);
    } catch (err) { toast(errorText(err), { tone: 'error' }); } finally { setBusyBranch(null); }
  };

  const load = async () => {
    setError(null);
    try { setNet(await apiFetch<ReviewNetwork>(`/v2/review/network${branchId ? `?branchId=${encodeURIComponent(branchId)}` : ''}`)); }
    catch (err) { setError(errorText(err, 'Could not load the review network.')); }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setNet(null); void load(); }, [branchId]);

  const groups = useMemo(() => {
    if (!net) return [];
    const shown = net.reviewers.filter(r => !branchId || r.branchId === branchId);
    const list = filter === 'attention' ? shown.filter(r => !r.available || !r.spillTo.length || isAway(r)) : shown;
    const m = new Map<string, { branchId: string; list: ReviewerLoad[] }>();
    list.forEach(r => { const k = r.branchName ?? branches.find(b => b.id === r.branchId)?.name ?? 'Other'; const g = m.get(k) ?? { branchId: r.branchId, list: [] }; g.list.push(r); m.set(k, g); });
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [net, branchId, filter, branches]);

  if (error) return <ErrorBox message={error} onRetry={() => void load()} />;
  if (!net) return <Loading label="Loading the review network…" />;

  const shown = net.reviewers.filter(r => !branchId || r.branchId === branchId);
  const full = shown.filter(r => !isAway(r) && r.openNow >= r.threshold).length;
  const away = shown.filter(isAway).length;
  const noSpill = shown.filter(r => !r.spillTo.length).length;
  const branchOf = (id: string) => net.reviewers.find(r => r.teacherId === id)?.branchId;

  return (
    <div className="v2-network">
      <p className="v2-section-intro">
        Each teacher has a limit. When a teacher is full or away, new work goes to whoever they send overflow to — even in another branch. With nothing set, it goes to the least busy teacher of the branch, then to the Nairobi team. No student is ever left waiting.
      </p>
      <div className="v2-net-summary">
        <span className="chip chip-blue">{shown.length} teachers</span>
        <span className={full ? 'chip chip-red' : 'chip chip-green'}>{full} full</span>
        <span className={away ? 'chip chip-amber' : 'chip'}>{away} away</span>
        <span className={noSpill ? 'chip chip-amber' : 'chip chip-green'}>{noSpill} without their own overflow list</span>
        <span className="v2-grow" />
        <div className="v2-seg v2-seg-sm" role="radiogroup" aria-label="Show">
          <button type="button" role="radio" aria-checked={filter === 'all'} className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>Everyone</button>
          <button type="button" role="radio" aria-checked={filter === 'attention'} className={filter === 'attention' ? 'active' : ''} onClick={() => setFilter('attention')}>Needs attention</button>
        </div>
      </div>

      {!groups.length && <EmptyState icon={<Network size={26} />} title={filter === 'attention' ? 'Everyone is fine' : 'No teachers here yet'} text={filter === 'attention' ? 'No teacher is full, away or without a spill-over.' : 'Teachers of this branch will appear here.'} />}

      {groups.map(([name, { branchId: bid, list }]) => {
        const canSetup = list.some(r => net.canEditTeacherIds.includes(r.teacherId));
        return (
        <section key={name} className="v2-net-branch">
          <div className="v2-net-branch-head">
            <h3>{name}</h3>
            {canSetup && (
              <div className="v2-net-presets">
                <button type="button" className="btn btn-primary v2-btn-sm" disabled={busyBranch === bid} onClick={() => void autoSetup(bid, name)}><Wand2 size={14} /> {busyBranch === bid ? 'Setting up…' : 'Set up this branch automatically'}</button>
                <button type="button" className="btn btn-outline v2-btn-sm" disabled={busyBranch === bid} onClick={() => setLimitFor({ branchId: bid, name })}><Gauge size={14} /> Same limit for everyone</button>
              </div>
            )}
          </div>
          <div className="v2-net-grid">
            {list.map(r => {
              const canEdit = net.canEditTeacherIds.includes(r.teacherId);
              const awayNow = isAway(r);
              const isFull = !awayNow && r.openNow >= r.threshold;
              const pct = Math.min(100, Math.round((r.openNow / Math.max(1, r.threshold)) * 100));
              return (
                <button
                  key={r.teacherId}
                  type="button"
                  className={`v2-net-card${isFull ? ' is-full' : ''}${awayNow ? ' is-away' : ''}${!r.spillTo.length ? ' no-spill' : ''}`}
                  onClick={() => setEditing(r)}
                  aria-label={`${r.name}: ${r.openNow} waiting, limit ${r.threshold}${canEdit ? ', tap to change' : ''}`}
                >
                  <span className="v2-net-top">
                    <strong>{r.name}</strong>
                    {awayNow ? <span className="chip chip-amber"><CalendarOff size={11} /> Away till {formatDate(r.awayUntil)}</span>
                      : isFull ? <span className="chip chip-red">Full</span>
                        : <span className="chip chip-green">Taking work</span>}
                  </span>
                  <span className="v2-meter" aria-hidden="true"><i style={{ width: `${pct}%` }} className={isFull ? 'full' : pct >= 75 ? 'high' : ''} /></span>
                  <span className="v2-net-load"><b>{r.openNow}</b> waiting · limit {r.threshold}{r.overdueNow > 0 && <em className="v2-warn"> · {r.overdueNow} overdue</em>}</span>
                  <span className="v2-net-links"><span className="v2-net-label">Sends overflow to</span>
                    {r.spillTo.length ? [...r.spillTo].sort((a, b) => a.priority - b.priority).map((t, i) => {
                      const cross = branchOf(t.teacherId) ? branchOf(t.teacherId) !== r.branchId : (t.branchName ?? name) !== name;
                      return (
                        <span key={t.teacherId} className={`v2-spill${cross ? ' cross' : ''}`}>
                          {i === 0 && <ArrowRight size={12} />}{t.name}<sup>{t.priority}</sup>{cross && <small><Globe2 size={10} /> {t.branchName}</small>}
                        </span>
                      );
                    }) : <span className="v2-spill none"><UserX size={12} /> No overflow list — uses the usual order</span>}
                  </span>
                  {r.receivesFrom.length > 0 && <span className="v2-net-from">Gets overflow from {r.receivesFrom.map(f => f.name).join(', ')}</span>}
                </button>
              );
            })}
          </div>
        </section>
        );
      })}

      {limitFor && <SameLimitDialog name={limitFor.name} onClose={() => setLimitFor(null)} onApply={n => { const b = limitFor; setLimitFor(null); void autoSetup(b.branchId, b.name, n); }} />}

      {editing && (
        <EditReviewer
          reviewer={editing}
          network={net}
          canEdit={net.canEditTeacherIds.includes(editing.teacherId)}
          onClose={() => setEditing(null)}
          onSaved={updated => { setNet(n => n && ({ ...n, reviewers: n.reviewers.map(r => (r.teacherId === updated.teacherId ? updated : r)) })); setEditing(null); void load(); }}
        />
      )}
    </div>
  );
}

function EditReviewer({ reviewer, network, canEdit, onClose, onSaved }: { reviewer: ReviewerLoad; network: ReviewNetwork; canEdit: boolean; onClose: () => void; onSaved: (r: ReviewerLoad) => void }) {
  const [threshold, setThreshold] = useState(reviewer.threshold);
  const [away, setAway] = useState(reviewer.awayUntil ? reviewer.awayUntil.slice(0, 10) : '');
  const [targets, setTargets] = useState<string[]>([...reviewer.spillTo].sort((a, b) => a.priority - b.priority).map(t => t.teacherId));
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);

  // every teacher we know of (also spill targets from other branches that are not in the list)
  const people = useMemo(() => {
    const m = new Map<string, { id: string; name: string; branchId: string | null; branchName: string | null }>();
    network.reviewers.forEach(r => m.set(r.teacherId, { id: r.teacherId, name: r.name, branchId: r.branchId, branchName: r.branchName }));
    network.reviewers.forEach(r => [...r.spillTo, ...r.receivesFrom].forEach(t => { if (!m.has(t.teacherId)) m.set(t.teacherId, { id: t.teacherId, name: t.name, branchId: null, branchName: t.branchName }); }));
    return m;
  }, [network]);
  const isCross = (id: string) => { const p = people.get(id); return p ? (p.branchId ? p.branchId !== reviewer.branchId : p.branchName !== reviewer.branchName) : false; };
  const candidates = Array.from(people.values())
    .filter(p => p.id !== reviewer.teacherId && !targets.includes(p.id))
    .filter(p => network.canLinkAcrossBranches || !isCross(p.id))
    .filter(p => !q.trim() || `${p.name} ${p.branchName ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => Number(isCross(a.id)) - Number(isCross(b.id)) || a.name.localeCompare(b.name))
    .slice(0, 8);
  const move = (i: number, d: number) => setTargets(t => { const n = [...t]; const j = i + d; if (j < 0 || j >= n.length) return t; [n[i], n[j]] = [n[j], n[i]]; return n; });

  const save = async () => {
    setBusy(true);
    try {
      const body: ReviewerSettingsUpdate = { threshold, spillTo: targets, awayUntil: away ? new Date(`${away}T23:59:00`).toISOString() : null };
      const updated = await apiFetch<ReviewerLoad>(`/v2/review/network/${encodeURIComponent(reviewer.teacherId)}`, { method: 'PUT', body });
      toast(`${reviewer.name}’s limit and overflow saved.`);
      onSaved(updated ?? { ...reviewer, threshold, awayUntil: body.awayUntil ?? null });
    } catch (err) { toast(errorText(err), { tone: 'error' }); } finally { setBusy(false); }
  };

  return (
    <Dialog
      title={reviewer.name}
      eyebrow={`${reviewer.branchName ?? ''} · ${reviewer.openNow} waiting now`}
      onClose={onClose}
      footer={canEdit ? <><button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button></> : <button type="button" className="btn btn-primary" onClick={onClose}>Close</button>}
    >
      {!canEdit && <p className="v2-help">You can see this teacher’s settings but not change them.</p>}
      <fieldset className="v2-plain-fieldset" disabled={!canEdit}>
        <div className="field-label">Limit
          <NumberStepper value={threshold} min={1} max={200} unit="waiting at once" label="Limit" disabled={!canEdit} onChange={setThreshold} />
        </div>
        <p className="v2-help">When {reviewer.name} has this many waiting, new work goes to the teachers below.</p>
        <label className="field-label">Away until <span className="v2-optional">optional</span>
          <span className="v2-date-row">
            <input type="date" className="field" value={away} onChange={e => setAway(e.target.value)} />
            {away && <button type="button" className="v2-link" onClick={() => setAway('')}>Not away</button>}
          </span>
        </label>
        <div className="field-label">Send overflow to, in this order
          <ol className="v2-spill-list">
            {targets.map((id, i) => {
              const p = people.get(id);
              return (
                <li key={id}>
                  <span className="v2-spill-n">{i + 1}</span>
                  <span className="v2-spill-name">{p?.name ?? 'Teacher'}{isCross(id) && <small><Globe2 size={11} /> {p?.branchName ?? 'other branch'}</small>}</span>
                  <button type="button" className="v2-icon-btn" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={15} /></button>
                  <button type="button" className="v2-icon-btn" aria-label="Move down" disabled={i === targets.length - 1} onClick={() => move(i, 1)}><ArrowDown size={15} /></button>
                  <button type="button" className="v2-icon-btn" aria-label={`Remove ${p?.name ?? ''}`} onClick={() => setTargets(t => t.filter(x => x !== id))}><Trash2 size={15} /></button>
                </li>
              );
            })}
            {!targets.length && <li className="v2-spill-empty">Nobody chosen — overflow goes to the least busy teacher of the branch, then the Nairobi team.</li>}
          </ol>
        </div>
        {canEdit && (
          <div className="v2-spill-add">
            <label className="v2-search"><Search size={15} /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Find a teacher to add" aria-label="Find a teacher" /></label>
            <div className="v2-spill-candidates">
              {candidates.map(p => (
                <button key={p.id} type="button" className={`v2-spill${isCross(p.id) ? ' cross' : ''}`} onClick={() => setTargets(t => [...t, p.id])}>
                  <Plus size={12} />{p.name}{isCross(p.id) && <small><Globe2 size={10} /> {p.branchName}</small>}
                </button>
              ))}
              {!candidates.length && <span className="muted">No more teachers to add{network.canLinkAcrossBranches ? '' : ' from this branch'}.</span>}
            </div>
            {!network.canLinkAcrossBranches && <p className="v2-help">Only the Nairobi team can link teachers across branches.</p>}
          </div>
        )}
      </fieldset>
    </Dialog>
  );
}

function SameLimitDialog({ name, onClose, onApply }: { name: string; onClose: () => void; onApply: (n: number) => void }) {
  const [n, setN] = useState(15);
  return (
    <Dialog title="Same limit for everyone" eyebrow={name} onClose={onClose}
      footer={<><button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" onClick={() => onApply(n)}>Apply to all teachers</button></>}>
      <p className="v2-help">Every teacher of {name} will check at most this many at once. You can still change one teacher later.</p>
      <div className="field-label">Limit
        <NumberStepper value={n} min={1} max={200} unit="waiting at once" label="Limit" onChange={setN} />
      </div>
    </Dialog>
  );
}
