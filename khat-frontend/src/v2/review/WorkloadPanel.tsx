import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, Loader2, Minus, Plus, Search, X } from 'lucide-react';
import { apiFetch, getSessionUser } from '@/api';
import type { ReviewNetwork, ReviewerLoad, ReviewerSettingsUpdate } from '../contracts';
import { initials } from '../chat/media';
import './review-v3.css';

const DEFAULT_LIMIT = 15;

/** Small meter used in the inbox header ("8 of 15 open"). */
export function LoadMeter({ open, limit, away }: { open: number; limit: number; away?: boolean }) {
  const pct = Math.min(100, Math.round((open / Math.max(1, limit)) * 100));
  const tone = away ? 'away' : open >= limit ? 'full' : pct >= 75 ? 'busy' : 'ok';
  return (
    <span className={`v2-meter tone-${tone}`} aria-label={`${open} of ${limit} open`}>
      <span className="v2-meter-track"><i style={{ width: `${pct}%` }} /></span>
      <span className="v2-meter-text">{away ? 'Away' : `${open} of ${limit} open`}</span>
    </span>
  );
}

/**
 * "My workload": three plain controls — My limit, I'm away until, Send my overflow to.
 * Saves each change straight away with PUT /v2/review/network/:teacherId.
 */
export function WorkloadPanel({ open, onClose, onLoaded }: { open: boolean; onClose: () => void; onLoaded?: (me: ReviewerLoad | null) => void }) {
  const me = getSessionUser();
  const [network, setNetwork] = useState<ReviewNetwork | null>(null);
  const [mine, setMine] = useState<ReviewerLoad | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(0);
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState('');
  const limitTimer = useRef<number | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const load = async () => {
    try {
      const n = await apiFetch<ReviewNetwork>('/v2/review/network', { silent: true });
      setNetwork(n);
      const m = n.reviewers.find(r => r.teacherId === me?.id) ?? null;
      setMine(m);
      onLoaded?.(m);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Your workload settings could not be loaded.');
      onLoaded?.(null);
    }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  useEffect(() => { if (open) { void load(); window.setTimeout(() => closeRef.current?.focus(), 50); } /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const save = async (patch: ReviewerSettingsUpdate) => {
    if (!mine) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await apiFetch<ReviewerLoad>(`/v2/review/network/${mine.teacherId}`, { method: 'PUT', body: patch });
      setMine(updated);
      onLoaded?.(updated);
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save. Please try again.');
      void load();
    } finally {
      setSaving(false);
    }
  };

  const changeLimit = (delta: number) => {
    if (!mine) return;
    const threshold = Math.max(1, Math.min(200, (mine.threshold || DEFAULT_LIMIT) + delta));
    setMine({ ...mine, threshold, available: !mine.awayUntil && mine.openNow < threshold });
    if (limitTimer.current) window.clearTimeout(limitTimer.current);
    limitTimer.current = window.setTimeout(() => void save({ threshold }), 600);
  };
  const setAway = (value: string | null) => {
    if (!mine) return;
    setMine({ ...mine, awayUntil: value });
    void save({ awayUntil: value });
  };
  const setSpill = (ids: string[]) => {
    if (!mine || !network) return;
    const byId = new Map(network.reviewers.map(r => [r.teacherId, r]));
    setMine({ ...mine, spillTo: ids.map((id, i) => ({ teacherId: id, name: byId.get(id)?.name ?? '…', branchName: byId.get(id)?.branchName ?? null, priority: i + 1 })) });
    void save({ spillTo: ids });
  };
  const spillIds = mine?.spillTo.slice().sort((a, b) => a.priority - b.priority).map(s => s.teacherId) ?? [];

  const candidates = useMemo(() => {
    if (!network || !mine) return [];
    const term = q.trim().toLowerCase();
    return network.reviewers
      .filter(r => r.teacherId !== mine.teacherId && !spillIds.includes(r.teacherId))
      .filter(r => network.canLinkAcrossBranches || r.branchId === mine.branchId)
      .filter(r => !term || r.name.toLowerCase().includes(term) || (r.branchName ?? '').toLowerCase().includes(term))
      .sort((a, b) => Number(b.branchId === mine.branchId) - Number(a.branchId === mine.branchId) || a.openNow / Math.max(1, a.threshold) - b.openNow / Math.max(1, b.threshold));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [network, mine, q, spillIds.join(',')]);

  const today = new Date().toISOString().slice(0, 10);
  const awayValue = mine?.awayUntil ? mine.awayUntil.slice(0, 10) : '';

  return (
    <>
      <div className={`v2-side-backdrop${open ? ' is-open' : ''}`} onClick={onClose} aria-hidden="true" />
      <aside className={`v2-side v3-wl${open ? ' is-open' : ''}`} role="dialog" aria-modal="true" aria-labelledby="v2-workload-title" aria-hidden={!open} {...(!open ? { inert: '' } : {})}>
        <header className="v2-side-head">
          <div>
            <p className="eyebrow">Inbox</p>
            <h2 id="v2-workload-title">My workload</h2>
          </div>
          <span className="v2-side-status" aria-live="polite">{saving ? <><Loader2 size={14} className="v2-spin" /> Saving</> : savedAt ? <><Check size={14} /> Saved</> : null}</span>
          <button ref={closeRef} type="button" className="v2-icon-btn" onClick={onClose} aria-label="Close"><X size={20} /></button>
        </header>

        {!mine ? (
          <div className="v2-side-body">
            {error ? <><p className="v2-inline-error" role="alert">{error}</p><button type="button" className="btn btn-outline" onClick={() => void load()}>Try again</button></>
              : network ? <p className="muted">Workload settings are for teachers. Ask your branch admin to set limits in Policies → Review network.</p>
              : <p className="muted"><Loader2 size={15} className="v2-spin" /> Loading…</p>}
          </div>
        ) : (
          <div className="v2-side-body">
            <section className="v2-wl-block">
              <h3>How many pieces I can hold</h3>
              <p className="muted">When you reach this number, new work goes to the next teacher.</p>
              <div className="v2-wl-limit">
                <button type="button" className="v2-step-btn" onClick={() => changeLimit(-1)} disabled={mine.threshold <= 1} aria-label="Lower my limit"><Minus size={18} /></button>
                <span className="v2-wl-limit-num" aria-live="polite"><strong>{mine.threshold}</strong><small>pieces</small></span>
                <button type="button" className="v2-step-btn" onClick={() => changeLimit(1)} aria-label="Raise my limit"><Plus size={18} /></button>
              </div>
              <LoadMeter open={mine.openNow} limit={mine.threshold} away={!!mine.awayUntil && mine.awayUntil.slice(0, 10) >= today} />
            </section>

            <section className="v2-wl-block">
              <h3>I'm away until</h3>
              <p className="muted">While you are away, your work goes to the teachers below.</p>
              <div className="v2-wl-away">
                <input type="date" className="field" min={today} value={awayValue} onChange={e => setAway(e.target.value || null)} aria-label="Away until date" />
                {awayValue && <button type="button" className="btn btn-outline" onClick={() => setAway(null)}>I'm back</button>}
              </div>
            </section>

            <section className="v2-wl-block">
              <h3>When I am full, send my work to</h3>
              <p className="muted">Number 1 gets it first, then number 2. Use the arrows to change the order.</p>
              {spillIds.length === 0 && <p className="v2-wl-hint">Nobody chosen — your extra work goes to the least busy teacher in your branch, then the Nairobi team.</p>}
              <ol className="v3-wl-order">
                {mine.spillTo.slice().sort((a, b) => a.priority - b.priority).map((t, i, arr) => {
                  const r = network?.reviewers.find(x => x.teacherId === t.teacherId);
                  const move = (to: number) => { const ids = [...spillIds]; [ids[i], ids[to]] = [ids[to], ids[i]]; setSpill(ids); };
                  return (
                    <li key={t.teacherId} className="v3-wl-item">
                      <b className="v3-wl-num">{i + 1}</b>
                      <span className="v3-wl-name"><strong>{t.name}</strong><small>{[t.branchName && r?.branchId !== mine.branchId ? t.branchName : null, r && !r.available ? (r.awayUntil ? 'away now' : 'full now') : null].filter(Boolean).join(' · ')}</small></span>
                      <span className="v3-wl-btns">
                        <button type="button" disabled={i === 0} onClick={() => move(i - 1)} aria-label={`Move ${t.name} up`}><ArrowUp size={18} /></button>
                        <button type="button" disabled={i === arr.length - 1} onClick={() => move(i + 1)} aria-label={`Move ${t.name} down`}><ArrowDown size={18} /></button>
                        <button type="button" onClick={() => setSpill(spillIds.filter(id => id !== t.teacherId))} aria-label={`Remove ${t.name}`}><X size={18} /></button>
                      </span>
                    </li>
                  );
                })}
              </ol>
              <div className="v2-chips">
                {!adding && <button type="button" className="v2-chip-add" onClick={() => setAdding(true)}><Plus size={15} /> Add a teacher</button>}
              </div>
              {adding && (
                <div className="v2-wl-search">
                  <label className="v2-search"><Search size={15} /><input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search a teacher" aria-label="Search a teacher" /></label>
                  <ul className="v2-wl-results">
                    {candidates.slice(0, 12).map(r => (
                      <li key={r.teacherId}>
                        <button type="button" onClick={() => { setSpill([...spillIds, r.teacherId]); setQ(''); setAdding(false); }}>
                          <span className="v2-avatar is-small">{initials(r.name)}</span>
                          <span className="v2-wl-result-name"><strong>{r.name}</strong><small>{r.branchName ?? ''}</small></span>
                          <LoadMeter open={r.openNow} limit={r.threshold} away={!!r.awayUntil} />
                        </button>
                      </li>
                    ))}
                    {!candidates.length && <li className="muted">No other teachers found.</li>}
                  </ul>
                  <button type="button" className="v2-link" onClick={() => { setAdding(false); setQ(''); }}>Done</button>
                </div>
              )}
            </section>
            {error && <p className="v2-inline-error" role="alert">{error}</p>}
          </div>
        )}
      </aside>
    </>
  );
}
