import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Download, Undo2, Pencil, Inbox, Loader2, Printer, RefreshCw, ScanLine, Search, SlidersHorizontal, X } from 'lucide-react';
import { ApiError, apiFetch } from '@/api';
import { PenLoader, navigate } from '@/components/ui';
import type { InboxItem, ReviewerLoad, Submission } from '../contracts';
import { openV2, readV2Param } from '../nav';
import { initials, waitTone, waitingLabel } from '../chat/media';
import { downloadStamped, downloadStampedZip, openPrintPack } from './bulk';
import { COURSE_KINDS, KIND_LABEL, kindOf, stepLine, type CourseKind } from '../teacher/teacherTypes';
import './review-v3.css';
import { useReviewPolicies } from './policies';
import { ReviewWorkspace } from './ReviewWorkspace';
import { LoadMeter, WorkloadPanel } from './WorkloadPanel';
import './review.css';

type Props = Record<string, never>;
type Status = 'open' | 'done';

export function V2ReviewInboxPage(_props: Props) {
  const policies = useReviewPolicies();
  const [status, setStatus] = useState<Status>('open');
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(() => readV2Param('submissionId'));
  const [bulk, setBulk] = useState<string | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  // Work on courses made before the Course builder lives in the old queue, not here.
  const [older, setOlder] = useState(0);
  useEffect(() => { apiFetch<unknown[]>('/entries/queue', { silent: true }).then(r => setOlder(Array.isArray(r) ? r.length : 0)).catch(() => undefined); }, []);
  const [workloadOpen, setWorkloadOpen] = useState(false);
  const [me, setMe] = useState<ReviewerLoad | null>(null);
  const [sentToday, setSentToday] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [kind, setKind] = useState<CourseKind | 'all'>(() => { const k = readV2Param('inboxKind') as CourseKind | null; sessionStorage.removeItem('khat.v2.param.inboxKind'); return k ?? 'all'; });
  const [downloading, setDownloading] = useState<string | null>(null);
  const listScroll = useRef(0);
  // v3 audit 23: one-tap Confirm of an automatic mark, sent after a short undo window.
  const [pending, setPending] = useState<{ item: InboxItem; until: number } | null>(null);
  const pendingTimer = useRef<number | null>(null);
  const pendingRef = useRef<{ item: InboxItem; until: number } | null>(null);
  pendingRef.current = pending;

  useEffect(() => { const t = window.setTimeout(() => setDebouncedQ(q.trim()), 300); return () => window.clearTimeout(t); }, [q]);

  const load = useCallback(async (initial = false) => {
    if (initial) setLoading(true);
    try {
      const params = new URLSearchParams({ status });
      if (debouncedQ) params.set('q', debouncedQ);
      const res = await apiFetch<InboxItem[]>(`/v2/review/inbox?${params.toString()}`, { silent: !initial });
      const list = (Array.isArray(res) ? res : []).slice().sort((a, b) => (status === 'open' ? b.waitingHours - a.waitingHours : b.submission.createdAt.localeCompare(a.submission.createdAt)));
      setItems(list);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The inbox could not be loaded.');
    } finally {
      if (initial) setLoading(false);
    }
  }, [status, debouncedQ]);

  useEffect(() => { setSelected(new Set()); void load(true); }, [load]);
  useEffect(() => {
    const id = window.setInterval(() => { if (document.visibilityState === 'visible' && !activeId) void load(); }, 30_000);
    return () => window.clearInterval(id);
  }, [load, activeId]);

  const activeIndex = activeId ? items.findIndex(i => i.submission.id === activeId) : -1;
  const active = activeIndex >= 0 ? items[activeIndex] : null;
  useEffect(() => {
    if (!activeId) sessionStorage.removeItem('khat.v2.param.submissionId');
    if (activeId && !loading && activeIndex < 0 && items.length) setActiveId(null);
  }, [activeId, activeIndex, loading, items.length]);

  const open = (id: string) => {
    listScroll.current = window.scrollY;
    setActiveId(id);
    window.scrollTo({ top: 0 });
  };
  const back = () => {
    setActiveId(null);
    void load();
    requestAnimationFrame(() => window.scrollTo({ top: listScroll.current }));
  };
  const go = (delta: number) => {
    if (activeIndex < 0) return;
    const next = items[activeIndex + delta];
    if (next) { setActiveId(next.submission.id); window.scrollTo({ top: 0 }); }
  };
  const onSent = (item: InboxItem, sub: Submission) => {
    setSentToday(n => n + 1);
    setToast(`${sub.mark != null ? `${sub.mark}/10 sent` : 'Feedback sent'} to ${item.student.name.split(' ')[0]}`);
    window.setTimeout(() => setToast(null), 2600);
    const idx = items.findIndex(i => i.submission.id === item.submission.id);
    const rest = status === 'open' ? items.filter(i => i.submission.id !== item.submission.id) : items.map(i => (i.submission.id === sub.id ? { ...i, submission: sub } : i));
    setItems(rest);
    if (me) setMe({ ...me, openNow: Math.max(0, me.openNow - 1) });
    if (status === 'open') {
      const next = rest[Math.min(idx, rest.length - 1)];
      setActiveId(next ? next.submission.id : null);
      window.scrollTo({ top: 0 });
    }
  };

  const CONFIRM_UNDO_MS = 5000;
  const sendConfirm = async (item: InboxItem) => {
    try {
      const sub = await apiFetch<Submission>(`/v2/review/submissions/${item.submission.id}/decision`, { method: 'POST', body: { mark: item.submission.mark, rubric: null, comment: null } });
      setSentToday(n => n + 1);
      setItems(prev => prev.filter(i => i.submission.id !== sub.id));
      if (me) setMe({ ...me, openNow: Math.max(0, me.openNow - 1) });
      setToast(`${sub.mark ?? item.submission.mark}/10 confirmed for ${item.student.name.split(' ')[0]}`);
      window.setTimeout(() => setToast(null), 2600);
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : 'The mark could not be confirmed. Please try again.');
    }
  };
  const flushPending = () => {
    if (pendingTimer.current) window.clearTimeout(pendingTimer.current);
    pendingTimer.current = null;
    const p = pendingRef.current;
    setPending(null);
    if (p) void sendConfirm(p.item);
  };
  const confirmOne = (item: InboxItem) => {
    if (pendingRef.current) flushPending();
    setBulkError(null);
    setPending({ item, until: Date.now() + CONFIRM_UNDO_MS });
    pendingTimer.current = window.setTimeout(() => { pendingTimer.current = null; const p = pendingRef.current; setPending(null); if (p) void sendConfirm(p.item); }, CONFIRM_UNDO_MS);
  };
  const undoPending = (thenOpen = false) => {
    if (pendingTimer.current) window.clearTimeout(pendingTimer.current);
    pendingTimer.current = null;
    const p = pendingRef.current;
    setPending(null);
    if (thenOpen && p) open(p.item.submission.id);
  };
  // Leaving the page still sends a confirm that was not undone.
  useEffect(() => () => { if (pendingTimer.current) { window.clearTimeout(pendingTimer.current); const p = pendingRef.current; if (p) void apiFetch(`/v2/review/submissions/${p.item.submission.id}/decision`, { method: 'POST', body: { mark: p.item.submission.mark, rubric: null, comment: null }, silent: true }).catch(() => {}); } }, []);

  const toggle = (id: string) => setSelected(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const selectedItems = useMemo(() => items.filter(i => selected.has(i.submission.id)), [items, selected]);

  const downloadOne = async (item: InboxItem) => {
    setBulkError(null);
    setDownloading(item.submission.id);
    try { await downloadStamped(item); }
    catch (err) { setBulkError(err instanceof Error ? err.message : 'The download could not be prepared.'); }
    finally { setDownloading(null); }
  };

  const doZip = async () => {
    setBulkError(null);
    try {
      const { failed } = await downloadStampedZip(selectedItems, (d, t) => setBulk(`Preparing ${d} of ${t} students…`));
      if (failed) setBulkError(`${failed} file${failed === 1 ? '' : 's'} could not be added. The rest were downloaded.`);
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : 'The download could not be prepared.');
    } finally { setBulk(null); }
  };
  const doPrint = async () => {
    setBulkError(null);
    setBulk('Preparing the print pack…');
    try { await openPrintPack(selectedItems.map(i => i.submission.id), 'all_files'); }
    catch (err) { setBulkError(err instanceof Error ? err.message : 'The print pack could not be made.'); }
    finally { setBulk(null); }
  };

  if (active) {
    return (
      <main className="page portal-page v2-review-page is-working">
        <ReviewWorkspace
          item={active}
          index={activeIndex}
          total={items.length}
          policies={policies}
          onBack={back}
          onPrev={() => go(-1)}
          onNext={() => go(1)}
          onSent={onSent}
        />
        {toast && <div className="v2-toast" role="status"><CheckCircle2 size={16} /> {toast}</div>}
      </main>
    );
  }

  const overdue = items.filter(i => i.waitingHours >= 72).length;
  const kindCounts = COURSE_KINDS.reduce((acc, k) => ({ ...acc, [k]: items.filter(i => kindOf(i) === k).length }), {} as Record<CourseKind, number>);
  const visible = pending ? items.filter(i => i.submission.id !== pending.item.submission.id) : items;
  const shown = kind === 'all' ? visible : visible.filter(i => kindOf(i) === kind);
  const allShownSelected = shown.length > 0 && shown.every(i => selected.has(i.submission.id));
  const toConfirm = items.filter(i => i.submission.autoMarked && (i.submission.status === 'submitted' || i.submission.status === 'in_review')).length;
  return (
    <main className="page portal-page v2-review-page v3-inbox">
      <div className="v2-inbox-head">
        <div>
          <p className="eyebrow">Review inbox · whole branch</p>
          <h1>{status === 'open' ? (loading ? 'Review inbox' : items.length ? `${items.length} piece${items.length === 1 ? '' : 's'} waiting` : 'All caught up') : 'Reviewed work'}</h1>
          <p className="muted">{status === 'open' ? 'Oldest first. Tap Review, look at the sheet, give a mark, send — the next one opens by itself.' : 'Work that has been answered. Open one to change a mark or add a note.'}</p>
          {older > 0 && <p><button type="button" className="btn btn-outline" onClick={() => navigate('queue')}>Older courses work: {older} waiting</button></p>}
        </div>
        <div className="v2-inbox-head-actions">
          <button type="button" className="v2-workload-btn" onClick={() => setWorkloadOpen(true)} aria-label="My workload">
            <SlidersHorizontal size={16} />
            <span><strong>My workload</strong>{me ? <LoadMeter open={me.openNow} limit={me.threshold} away={!!me.awayUntil && me.awayUntil.slice(0, 10) >= new Date().toISOString().slice(0, 10)} /> : <small>Limit and who gets my overflow</small>}</span>
          </button>
          <button type="button" className="btn btn-outline" onClick={() => openV2('v2-scan-return')}><ScanLine size={16} /> Upload marked items</button>
        </div>
      </div>

      <div className="v3rv-kind-tabs" role="tablist" aria-label="Course type">
        <button type="button" role="tab" aria-selected={kind === 'all'} className={kind === 'all' ? 'is-active' : ''} onClick={() => setKind('all')}>All <b>{items.length}</b></button>
        {COURSE_KINDS.map(k => (
          <button key={k} type="button" role="tab" aria-selected={kind === k} className={`${kind === k ? 'is-active' : ''} kind-${k}`} onClick={() => setKind(k)}>{KIND_LABEL[k]} <b>{kindCounts[k]}</b></button>
        ))}
      </div>

      <div className="v2-inbox-tools">
        <div className="tabs v2-tabs" role="tablist" aria-label="Show">
          {(['open', 'done'] as Status[]).map(s => (
            <button key={s} type="button" role="tab" aria-selected={status === s} className={status === s ? 'active' : ''} onClick={() => setStatus(s)}>
              {s === 'open' ? 'Waiting' : 'Done'}
            </button>
          ))}
        </div>
        <label className="v2-search v2-inbox-search"><Search size={16} /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Search student, TR, print code or Sheet ID" aria-label="Search" />{q && <button type="button" onClick={() => setQ('')} aria-label="Clear search"><X size={14} /></button>}</label>
        <button type="button" className="v2-icon-btn" onClick={() => void load(true)} aria-label="Refresh"><RefreshCw size={17} /></button>
      </div>

      {status === 'open' && !loading && items.length > 0 && (overdue > 0 || toConfirm > 0 || sentToday > 0) && (
        <div className="v2-inbox-stats" aria-label="Summary">
          {overdue > 0 && <span className="is-late"><b>{overdue}</b> waiting over 3 days</span>}
          {toConfirm > 0 && <span className="is-confirm"><b>{toConfirm}</b> automatic mark{toConfirm === 1 ? '' : 's'} to confirm</span>}
          {sentToday > 0 && <span className="is-good"><b>{sentToday}</b> sent just now</span>}
        </div>
      )}

      {(selected.size > 0 || bulk) && (
        <div className="v2-bulkbar" role="region" aria-label="Selected items">
          <strong>{selected.size} selected</strong>
          <span className="v2-bulkbar-spacer" />
          {bulk ? <span className="v2-bulk-status"><Loader2 size={15} className="v2-spin" /> {bulk}</span> : (
            <>
              <button type="button" className="btn btn-primary" onClick={() => void doZip()}><Download size={16} /> Bulk download</button>
              <button type="button" className="btn btn-outline" onClick={() => void doPrint()}><Printer size={16} /> Print all</button>
              <button type="button" className="v2-icon-btn" onClick={() => setSelected(new Set())} aria-label="Clear selection"><X size={17} /></button>
            </>
          )}
        </div>
      )}
      {selected.size > 0 && !bulk && <p className="v3-bulk-help muted">Bulk download gives one PDF per student with name, TR, class, branch, date and a Sheet ID with QR code on every page. Mark on paper, scan, then use <b>Upload marked items</b> — each page goes back to the right student.</p>}
      {bulkError && <p className="v2-inline-error" role="alert">{bulkError}</p>}
      {pending && (
        <div className="v3-confirm-undo" role="status">
          <CheckCircle2 size={18} aria-hidden="true" />
          <span><b>{pending.item.submission.mark}/10 confirmed</b> for {pending.item.student.name.split(' ')[0]} — sending in a moment.</span>
          <button type="button" className="btn btn-outline v2-btn-sm" onClick={() => undoPending(false)}><Undo2 size={14} /> Undo</button>
          <button type="button" className="btn btn-outline v2-btn-sm" onClick={() => undoPending(true)}><Pencil size={14} /> Change mark</button>
        </div>
      )}

      {loading ? <PenLoader compact label="Loading the inbox…" /> : error ? (
        <div className="v2-inbox-empty"><p className="v2-inline-error" role="alert">{error}</p><button type="button" className="btn btn-outline" onClick={() => void load(true)}><RefreshCw size={15} /> Try again</button></div>
      ) : !shown.length ? (
        <div className="v2-inbox-empty">
          <span className="v2-inbox-empty-icon"><Inbox size={26} /></span>
          <h3>{status === 'open' ? (debouncedQ || kind !== 'all' ? 'Nothing here' : 'All caught up') : 'Nothing reviewed yet'}</h3>
          <p className="muted">{status === 'open' ? 'New work from students of your branch appears here, oldest first.' : 'Reviewed work shows here.'}</p>
        </div>
      ) : (
        <div className="v3-queue" role="list">
          <label className="v3-queue-selectall">
            <input type="checkbox" checked={allShownSelected} onChange={() => setSelected(allShownSelected ? new Set() : new Set(shown.map(i => i.submission.id)))} />
            <span>Select all for bulk download</span>
          </label>
          {shown.map(item => {
            const tone = waitTone(item.waitingHours);
            const sub = item.submission;
            const isSel = selected.has(sub.id);
            const k = kindOf(item);
            const provisional = sub.autoMarked && (sub.status === 'submitted' || sub.status === 'in_review');
            return (
              <div key={sub.id} role="listitem" className={`v3-qrow${isSel ? ' is-selected' : ''} tone-${tone}`}>
                <label className="v3-qrow-check" aria-label={`Select ${item.student.name}`}><input type="checkbox" checked={isSel} onChange={() => toggle(sub.id)} /></label>
                <span className="v2-avatar" aria-hidden="true">{initials(item.student.name)}</span>
                <span className="v3-qrow-main">
                  <span className="v3-qrow-name"><strong>{item.student.name}</strong>{item.student.trNumber && <small>TR {item.student.trNumber}</small>}</span>
                  <span className="v3-qrow-step"><span className={`v3rv-kind-tag kind-${k}`}>{KIND_LABEL[k]}</span>{stepLine(item.step, k)}</span>
                  <span className="v3-qrow-meta">
                    {status === 'open'
                      ? <span className={`v2-wait tone-${tone}`}>{waitingLabel(item.waitingHours) === 'just now' ? 'Sent just now' : `Waiting ${waitingLabel(item.waitingHours)}`}</span>
                      : <span className={`chip chip-${sub.status === 'revision' ? 'amber' : 'green'}`}>{sub.mark != null ? `${sub.mark}/10` : 'Reviewed'}</span>}
                    {provisional && <span className="v3-confirm-tag">Automatic mark {sub.mark}/10 · confirm</span>}
                    {sub.attemptNo > 1 && <span className="v3rv-soft-tag">Attempt {sub.attemptNo}</span>}
                    {item.unreadForStaff > 0 && <span className="v3rv-soft-tag is-new">{item.unreadForStaff} new message{item.unreadForStaff === 1 ? '' : 's'}</span>}
                  </span>
                </span>
                <span className="v3-qrow-actions">
                  {provisional ? (
                    <>
                      <button type="button" className="btn btn-primary v3-review-btn" onClick={() => confirmOne(item)} aria-label={`Confirm ${sub.mark}/10 for ${item.student.name}`}><CheckCircle2 size={15} /> Confirm {sub.mark}/10</button>
                      <button type="button" className="btn btn-outline v3-open-btn" onClick={() => open(sub.id)} aria-label={`Open ${item.student.name}'s work first`}>Open</button>
                    </>
                  ) : (
                    <button type="button" className="btn btn-primary v3-review-btn" onClick={() => open(sub.id)}>{status === 'open' ? 'Review' : 'Open'}</button>
                  )}
                  <button type="button" className="btn btn-outline v3-dl-btn" onClick={() => void downloadOne(item)} disabled={downloading === sub.id} aria-label={`Download ${item.student.name}'s work`}>
                    {downloading === sub.id ? <Loader2 size={15} className="v2-spin" /> : <Download size={15} />}<span>Download</span>
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}
      <WorkloadPanel open={workloadOpen} onClose={() => setWorkloadOpen(false)} onLoaded={setMe} />
    </main>
  );
}
