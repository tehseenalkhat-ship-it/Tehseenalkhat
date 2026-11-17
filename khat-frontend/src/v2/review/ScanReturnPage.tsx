import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowLeft, Check, CheckCircle2, FileUp, Loader2, ScanLine, Send, Sparkles, X, XCircle } from 'lucide-react';
import { apiFetch, uploadFile } from '@/api';
import type { InboxItem, RefineCommentResponse, ScanReturnItem, ScanReturnResult } from '../contracts';
import { navigate } from '@/components/ui';
import { bandLabel, initials } from '../chat/media';
import { bandFor, useReviewPolicies } from './policies';
import { scanFiles, type ScannedPage } from './scan';
import { ScanAssistant } from './ScanAssistant';
import { kindOf, stepLine } from '../teacher/teacherTypes';
import './review-v3.css';
import './review.css';

type Props = Record<string, never>;
type Lookup = Record<string, InboxItem | 'loading' | 'notfound'>;
type GroupOpts = { mark: number | null; comment: string; include: boolean; suggestion?: string | null; refining?: boolean };

export function V2ScanReturnPage(_props: Props) {
  const policies = useReviewPolicies();
  const [pages, setPages] = useState<ScannedPage[]>([]);
  const [reading, setReading] = useState<string | null>(null);
  const [lookup, setLookup] = useState<Lookup>({});
  const [opts, setOpts] = useState<Record<string, GroupOpts>>({});
  const [openItems, setOpenItems] = useState<InboxItem[] | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const [results, setResults] = useState<ScanReturnResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [typed, setTyped] = useState<Record<string, string>>({});
  // v3: the assistant asks what to do once the pages are read
  const [assistant, setAssistant] = useState<'idle' | 'ask' | 'message' | 'sending' | 'done' | 'closed'>('idle');
  const [note, setNote] = useState('');
  const [botSnap, setBotSnap] = useState<{ students: { name: string; pages: number }[]; unreadable: number }>({ students: [], unreadable: 0 });

  // Look up every new code once
  useEffect(() => {
    const codes = [...new Set(pages.map(p => p.code).filter((c): c is string => !!c))].filter(c => !lookup[c]);
    if (!codes.length) return;
    setLookup(prev => ({ ...prev, ...Object.fromEntries(codes.map(c => [c, 'loading' as const])) }));
    for (const code of codes) {
      apiFetch<InboxItem>(`/v2/review/by-code/${encodeURIComponent(code)}`, { silent: true })
        .then(item => setLookup(prev => ({ ...prev, [code]: item })))
        .catch(() => setLookup(prev => ({ ...prev, [code]: 'notfound' })));
    }
  }, [pages, lookup]);

  const loadOpenItems = () => {
    if (openItems) return;
    apiFetch<InboxItem[]>('/v2/review/inbox?status=open', { silent: true }).then(r => setOpenItems(Array.isArray(r) ? r : [])).catch(() => setOpenItems([]));
  };

  const addFiles = async (list: FileList | File[] | null) => {
    const files = [...(list ?? [])];
    if (!files.length) return;
    setError(null);
    setResults(null);
    setAssistant('idle');
    try {
      await scanFiles(files, p => setPages(prev => [...prev, p]), setReading);
    } catch (err) {
      setError(err instanceof Error ? `Could not read a file: ${err.message}` : 'Could not read the scanned file.');
    } finally {
      setReading(null);
    }
  };

  const groups = useMemo(() => {
    const map = new Map<string, ScannedPage[]>();
    for (const p of pages) {
      if (!p.code) continue;
      const l = lookup[p.code];
      if (l === 'notfound') continue;
      map.set(p.code, [...(map.get(p.code) ?? []), p]);
    }
    return [...map.entries()].map(([code, ps]) => ({ code, item: lookup[code], pages: ps.sort((a, b) => (a.pageNo ?? 0) - (b.pageNo ?? 0)) }));
  }, [pages, lookup]);
  const unmatched = pages.filter(p => !p.code || lookup[p.code] === 'notfound');
  const optFor = (code: string): GroupOpts => opts[code] ?? { mark: null, comment: '', include: true };
  const setOpt = (code: string, patch: Partial<GroupOpts>) => setOpts(prev => ({ ...prev, [code]: { ...optFor(code), ...patch } }));

  const assign = (pageId: string, code: string) => setPages(prev => prev.map(p => (p.id === pageId ? { ...p, code: code.trim().toUpperCase(), pageNo: p.pageNo ?? 1 } : p)));
  const assignItem = (pageId: string, item: InboxItem) => {
    setLookup(prev => ({ ...prev, [item.submission.printCode]: item }));
    assign(pageId, item.submission.printCode);
  };
  const removePage = (pageId: string) => setPages(prev => prev.filter(p => p.id !== pageId));

  const refine = async (code: string, studentName: string) => {
    const o = optFor(code);
    if (!o.comment.trim()) return;
    setOpt(code, { refining: true });
    try {
      const r = await apiFetch<RefineCommentResponse>('/v2/ai/refine-comment', { method: 'POST', body: { text: o.comment, studentName, mark: o.mark, tone: 'warm' } });
      setOpt(code, { suggestion: r.refined, refining: false });
    } catch { setOpt(code, { refining: false }); setError('The comment helper is not available right now.'); }
  };

  const ready = groups.filter(g => typeof g.item === 'object' && optFor(g.code).include);
  const sendAll = async (message?: string): Promise<boolean> => {
    setError(null);
    const total = ready.reduce((s, g) => s + g.pages.length, 0);
    let done = 0;
    try {
      const items: ScanReturnItem[] = [];
      for (const g of ready) {
        const item = g.item as InboxItem;
        const keys: string[] = [];
        for (const p of g.pages) {
          setSending(`Uploading page ${done + 1} of ${total}…`);
          const up = await uploadFile('scan-returns', new File([p.blob], `${item.submission.printCode}_p${p.pageNo ?? keys.length + 1}.jpg`, { type: 'image/jpeg' }));
          keys.push(up.storageKey);
          done += 1;
        }
        const o = optFor(g.code);
        items.push({ submissionId: item.submission.id, pageStorageKeys: keys, mark: o.mark, comment: o.comment.trim() || message?.trim() || null });
      }
      setSending('Sending to each student…');
      const res = await apiFetch<ScanReturnResult[]>('/v2/review/scan-return', { method: 'POST', body: { items } });
      setResults(Array.isArray(res) ? res : []);
      const okIds = new Set((res ?? []).filter(r => r.ok).map(r => r.submissionId));
      setPages(prev => prev.filter(p => { const l = p.code ? lookup[p.code] : null; return !(l && typeof l === 'object' && okIds.has(l.submission.id)); }));
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sending failed. Nothing was lost — try again.');
      return false;
    } finally {
      setSending(null);
    }
  };

  const lookupsDone = groups.every(g => g.item !== 'loading');
  useEffect(() => {
    if (assistant === 'idle' && pages.length > 0 && !reading && lookupsDone) {
      setBotSnap({ students: ready.map(g => ({ name: (g.item as InboxItem).student.name, pages: g.pages.length })), unreadable: unmatched.length });
      setAssistant('ask');
    }
  }, [assistant, pages.length, reading, lookupsDone, ready, unmatched.length]);
  const runAssistant = async (message: string) => {
    setAssistant('sending');
    const ok = await sendAll(message);
    setAssistant(ok ? 'done' : 'closed');
  };

  const onDrop = (e: React.DragEvent) => { e.preventDefault(); setDragging(false); void addFiles(e.dataTransfer.files); };

  return (
    <main className="page portal-page v2-review-page v2-scan-page">
      <button type="button" className="back-link" onClick={() => navigate('v2-inbox')}><ArrowLeft size={14} /> Back to the inbox</button>
      <div className="v2-inbox-head">
        <div>
          <p className="eyebrow">Paper marking</p>
          <h1>Upload marked items</h1>
          <p className="muted">Marked the sheets on paper? Scan them and drop them here. The assistant reads the code on each page and sends every page to the right student’s chat.</p>
        </div>
      </div>

      {results && (
        <section className="v2-scan-results" aria-label="Results">
          <h3>{results.filter(r => r.ok).length} of {results.length} sent</h3>
          <ul>
            {results.map(r => (
              <li key={r.submissionId} className={r.ok ? 'is-ok' : 'is-bad'}>
                {r.ok ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
                <strong>{r.studentName}</strong><span className="muted">{r.message}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <label
        className={`upload-box v2-scan-drop${dragging ? ' is-dragging' : ''}${pages.length ? ' is-small' : ''}`}
        onDragEnter={e => { e.preventDefault(); setDragging(true); }}
        onDragOver={e => e.preventDefault()}
        onDragLeave={e => { if (e.currentTarget === e.target) setDragging(false); }}
        onDrop={onDrop}
      >
        {reading ? <Loader2 size={24} className="v2-spin" /> : <FileUp size={24} />}
        <strong>{reading ?? (pages.length ? 'Add more scans' : 'Drop your checked PDFs here')}</strong>
        <small>{reading ? 'Finding the QR code on each page…' : 'Scan the sheets you marked on paper — one PDF with all pages, or photos. Tap to choose.'}</small>
        <input type="file" accept="application/pdf,.pdf,image/*" multiple onChange={e => { void addFiles(e.target.files); e.target.value = ''; }} disabled={!!reading || !!sending} data-testid="scan-input" />
      </label>
      {error && <p className="v2-inline-error" role="alert">{error}</p>}

      {groups.length > 0 && (
        <section className="v2-scan-groups" aria-label="Matched students">
          <h2 className="v2-scan-h">{groups.length} student{groups.length === 1 ? '' : 's'} found</h2>
          {groups.map(g => {
            const o = optFor(g.code);
            const item = typeof g.item === 'object' ? g.item : null;
            return (
              <article key={g.code} className={`v2-scan-group${o.include ? '' : ' is-skipped'}`} data-testid="scan-group">
                <header className="v2-scan-group-head">
                  {item ? <span className="v2-avatar">{initials(item.student.name)}</span> : <span className="v2-avatar"><Loader2 size={15} className="v2-spin" /></span>}
                  <span className="v2-scan-who">
                    <strong>{item ? item.student.name : 'Looking up…'}</strong>
                    <small>{item ? stepLine(item.step, kindOf(item)) : g.code}</small>
                  </span>
                  <span className="v2-scan-code">{g.code}</span>
                  <label className="v2-scan-include"><input type="checkbox" checked={o.include} onChange={e => setOpt(g.code, { include: e.target.checked })} /> Send</label>
                </header>
                <div className="v2-scan-thumbs">
                  {g.pages.map(p => (
                    <figure key={p.id} className="v2-scan-thumb">
                      <img src={p.thumb} alt={`Page ${p.pageNo ?? '?'}`} />
                      <figcaption>p{p.pageNo ?? '?'}</figcaption>
                      <button type="button" onClick={() => removePage(p.id)} aria-label="Remove this page"><X size={13} /></button>
                    </figure>
                  ))}
                </div>
                <div className="v2-scan-marks" role="group" aria-label="Mark (optional)">
                  {policies.quickMarks.map(m => (
                    <button key={m} type="button" className={`v2-qm-btn is-small band-${bandFor(m, policies.bands)}${o.mark === m ? ' is-active' : ''}`} aria-pressed={o.mark === m} onClick={() => setOpt(g.code, { mark: o.mark === m ? null : m })}>{m}</button>
                  ))}
                  <span className="muted v2-scan-markhint">{o.mark != null ? `${o.mark}/10 · ${bandLabel(bandFor(o.mark, policies.bands))}` : 'No mark — pages only'}</span>
                </div>
                <div className="v2-scan-comment">
                  <input className="field" value={o.comment} onChange={e => setOpt(g.code, { comment: e.target.value, suggestion: null })} placeholder="Comment (optional)" aria-label={`Comment for ${item?.student.name ?? g.code}`} />
                  <button type="button" className="v2-rc-refine" disabled={!o.comment.trim() || o.refining} onClick={() => void refine(g.code, item?.student.name ?? '')}>{o.refining ? <Loader2 size={14} className="v2-spin" /> : <Sparkles size={14} />} Refine</button>
                </div>
                {o.suggestion && (
                  <div className="v2-rc-suggestion is-inline">
                    <p>{o.suggestion}</p>
                    <div className="v2-rc-suggestion-actions">
                      <button type="button" className="btn btn-primary" onClick={() => setOpt(g.code, { comment: o.suggestion ?? '', suggestion: null })}><Check size={14} /> Use this</button>
                      <button type="button" className="v2-link" onClick={() => setOpt(g.code, { suggestion: null })}>Keep mine</button>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </section>
      )}

      {unmatched.length > 0 && (
        <section className="v2-scan-unmatched" aria-label="Pages without a readable code">
          <h2 className="v2-scan-h"><AlertTriangle size={18} /> {unmatched.length} page{unmatched.length === 1 ? '' : 's'} need you</h2>
          <p className="muted">The QR code could not be read. Type the code printed under it, or pick the student.</p>
          {unmatched.map(p => (
            <div key={p.id} className="v2-scan-um" data-testid="scan-unmatched">
              <img src={p.thumb} alt={`${p.source} page ${p.sourcePage}`} />
              <div className="v2-scan-um-body">
                <small className="muted">{p.source} · page {p.sourcePage}{p.code ? ` · “${p.code}” not found` : ''}</small>
                <div className="v2-scan-um-row">
                  <input className="field" placeholder="Code, e.g. TK-7F3K2" value={typed[p.id] ?? ''} onChange={e => setTyped(t => ({ ...t, [p.id]: e.target.value }))} aria-label="Print code" />
                  <button type="button" className="btn btn-outline" disabled={!(typed[p.id] ?? '').trim()} onClick={() => assign(p.id, typed[p.id] ?? '')}>Use code</button>
                </div>
                <select className="field" defaultValue="" onFocus={loadOpenItems} onChange={e => { const it = openItems?.find(i => i.submission.id === e.target.value); if (it) assignItem(p.id, it); }} aria-label="Pick the student">
                  <option value="" disabled>{openItems ? 'Pick the student…' : 'Pick the student (loading list)…'}</option>
                  {(openItems ?? []).map(i => <option key={i.submission.id} value={i.submission.id}>{i.student.name} — {stepLine(i.step, kindOf(i))} ({i.submission.printCode})</option>)}
                </select>
              </div>
              <button type="button" className="v2-icon-btn" onClick={() => removePage(p.id)} aria-label="Remove this page"><X size={16} /></button>
            </div>
          ))}
        </section>
      )}

      {groups.length > 0 && (
        <div className="v2-scan-send">
          {sending ? <span className="v2-bulk-status"><Loader2 size={16} className="v2-spin" /> {sending}</span> : (
            <>
              <span className="muted">{ready.length} student{ready.length === 1 ? '' : 's'} · {ready.reduce((s, g) => s + g.pages.length, 0)} pages{unmatched.length ? ` · ${unmatched.length} page${unmatched.length === 1 ? '' : 's'} left aside` : ''}</span>
              <button type="button" className="btn btn-primary" onClick={() => void sendAll(note)} disabled={!ready.length || !!reading}><Send size={16} /> Send all</button>
            </>
          )}
        </div>
      )}
      {(assistant === 'ask' || assistant === 'message' || assistant === 'sending' || assistant === 'done') && (
        <ScanAssistant
          stage={assistant}
          pages={pages.length}
          students={botSnap.students}
          unreadable={botSnap.unreadable}
          sending={sending}
          results={results}
          error={error}
          note={note}
          setNote={setNote}
          onYes={() => setAssistant('message')}
          onCheck={() => setAssistant('closed')}
          onSend={m => void runAssistant(m)}
          onClose={() => setAssistant('closed')}
        />
      )}
      {!pages.length && !results && !reading && (
        <p className="v2-scan-tip"><ScanLine size={16} /> Tip: scan at 200–300 dpi in black &amp; white or greyscale. Pages fed upside down are fine.</p>
      )}
    </main>
  );
}
