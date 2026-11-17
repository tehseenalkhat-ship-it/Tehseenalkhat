import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, CalendarDays, Camera, Check, CheckCircle2, Clock, ImagePlus, Megaphone, Plus, RefreshCw, Send, Sparkles, Trash2, Trophy, Users } from 'lucide-react';
import { apiFetch, getSessionUser, uploadFile } from '@/api';
import { PenLoader } from '@/components/ui';
import type { CompetitionKind } from '../contracts';
import { ShowcaseRequestSheet } from '../student/ShowcaseRequestSheet';
import { EmptyState, errorMessage, formatDate, ImageLightbox, InlineError, Sheet, SignedImage } from '../student/shared';
import { isOpen, normalizeCompetition, normalizeEntry, normalizeShowcaseRequest, SELECTION_LABELS, type V2Competition, type V2CompetitionEntry, type V2Excerpt, type V2ShowcaseRequest } from './competitionTypes';
import '../student/student-v2.css';
import './competitions-v2.css';

type Props = { mode: 'student' | 'staff' | 'admin' };

const KIND_LABEL: Record<CompetitionKind, string> = { competition: 'Competition', call: 'Call for calligraphers' };

function dateRange(c: V2Competition): string {
  if (c.endDate && isOpen(c)) return `Closes ${formatDate(c.endDate, { day: 'numeric', month: 'short' })}`;
  if (c.startDate && c.status === 'upcoming') return `Opens ${formatDate(c.startDate, { day: 'numeric', month: 'short' })}`;
  if (c.endDate) return `Closed ${formatDate(c.endDate, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  return '';
}

function useCompetitions(scope: 'mine' | 'all') {
  const [items, setItems] = useState<V2Competition[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await apiFetch<unknown[]>(`/v2/competitions?scope=${scope}`);
      setItems((Array.isArray(data) ? data : []).map(normalizeCompetition));
    } catch (err) { setError(errorMessage(err, 'Competitions could not be loaded right now.')); }
  }, [scope]);
  useEffect(() => { void load(); }, [load]);
  return { items, error, load };
}

export function V2CompetitionsPage({ mode }: Props) {
  return mode === 'student' ? <StudentCompetitions /> : <StaffCompetitions admin={mode === 'admin'} />;
}

// ---------------------------------------------------------------- student

function Excerpts({ excerpts, onOpen }: { excerpts: V2Excerpt[]; onOpen: (url: string) => void }) {
  if (!excerpts.length) return null;
  return (
    <div className="v2s-excerpts">
      <p className="v2s-block-label">What to write</p>
      <ol>
        {excerpts.map((excerpt, index) => (
          <li key={index}>
            {excerpt.note && <small>{excerpt.note}</small>}
            {excerpt.text && <p dir="auto" lang={/[؀-ۿ]/.test(excerpt.text) ? 'ar' : undefined} className={/[؀-ۿ]/.test(excerpt.text) ? 'v2s-arabic-text' : undefined}>{excerpt.text}</p>}
            {excerpt.imageStorageKey && <SignedImage storageKey={excerpt.imageStorageKey} alt={`Excerpt ${index + 1}`} className="v2s-excerpt-image" onClickUrl={onOpen} />}
          </li>
        ))}
      </ol>
    </div>
  );
}

function StudentCompetitions() {
  const { items, error, load } = useCompetitions('mine');
  const [tab, setTab] = useState<'open' | 'results'>('open');
  const [entryFor, setEntryFor] = useState<V2Competition | null>(null);
  const [showcaseOpen, setShowcaseOpen] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const me = getSessionUser();
  const open = (items ?? []).filter(isOpen);
  const upcoming = (items ?? []).filter(c => c.status === 'upcoming' && !isOpen(c));
  const results = (items ?? []).filter(c => c.resultsPublished || c.selections.length > 0);

  return (
    <main className="page portal-page v2s-student-page v2s-comp-page">
      <header className="v2s-page-head">
        <p className="eyebrow">Competitions & calls</p>
        <h1>Write for the community</h1>
        <p className="muted">Enter a competition, or answer a call to write excerpts that decorate our majalis. Every entry is a step forward.</p>
      </header>

      <button type="button" className="v2s-showcase-cta" onClick={() => setShowcaseOpen(true)}>
        <span className="v2s-showcase-cta-icon" aria-hidden="true"><Sparkles size={20} /></span>
        <span><strong>Request to showcase my work</strong><small>Suggest a piece you are proud of for the gallery</small></span>
        <span className="v2s-chip is-blue">One tap</span>
      </button>

      <div className="tabs v2s-tabs" role="tablist" aria-label="Competitions">
        <button type="button" role="tab" aria-selected={tab === 'open'} className={tab === 'open' ? 'active' : ''} onClick={() => setTab('open')}>Open now{items ? ` (${open.length})` : ''}</button>
        <button type="button" role="tab" aria-selected={tab === 'results'} className={tab === 'results' ? 'active' : ''} onClick={() => setTab('results')}>Results</button>
      </div>

      {error && <InlineError message={error} onRetry={() => void load()} />}
      {!items && !error && <PenLoader label="Loading competitions…" compact />}

      {items && tab === 'open' && (
        open.length === 0 && upcoming.length === 0
          ? <EmptyState icon={<Trophy size={22} />} title="Nothing open right now" text="New competitions and calls are announced here and on your dashboard. Keep practicing — your next entry is waiting." />
          : <div className="v2s-comp-grid">
              {[...open, ...upcoming].map(c => (
                <article className="v2s-comp-card" key={c.id}>
                  <div className="v2s-comp-cover">
                    {c.coverStorageKey ? <SignedImage storageKey={c.coverStorageKey} alt={`${c.title} cover`} /> : <span className="v2s-comp-cover-art" aria-hidden="true">{c.kind === 'call' ? <Megaphone size={28} /> : <Trophy size={28} />}</span>}
                    <span className={`v2s-chip ${c.kind === 'call' ? 'is-ink' : 'is-blue'} v2s-comp-kind`}>{KIND_LABEL[c.kind]}</span>
                  </div>
                  <div className="v2s-comp-body">
                    <h2>{c.title}</h2>
                    {dateRange(c) && <p className="v2s-comp-date"><CalendarDays size={14} aria-hidden="true" /> {dateRange(c)}</p>}
                    {c.description && <p className="v2s-comp-desc">{c.description}</p>}
                    <Excerpts excerpts={c.excerpts} onOpen={setLightbox} />
                    {c.myEntry ? (
                      <div className="v2s-entry-sent">
                        <SignedImage storageKey={c.myEntry.imageStorageKey} alt="Your entry" className="v2s-entry-thumb" />
                        <span><strong><CheckCircle2 size={15} aria-hidden="true" /> Your entry is in</strong><small>Thank you! Results will be shared here.</small></span>
                      </div>
                    ) : isOpen(c) ? (
                      <button type="button" className="btn btn-primary v2s-cta" onClick={() => setEntryFor(c)}><Camera size={16} /> Send my entry</button>
                    ) : (
                      <p className="v2s-soft-note">Entries open {formatDate(c.startDate, { day: 'numeric', month: 'long' })}.</p>
                    )}
                  </div>
                </article>
              ))}
            </div>
      )}

      {items && tab === 'results' && (
        results.length === 0
          ? <EmptyState icon={<Trophy size={22} />} title="No results yet" text="When the team selects entries, the names and pieces appear here." />
          : <div className="v2s-results">
              {results.map(c => (
                <section className="v2s-result-block" key={c.id} aria-labelledby={`v2s-result-${c.id}`}>
                  <header><span className={`v2s-chip ${c.kind === 'call' ? 'is-ink' : 'is-blue'}`}>{KIND_LABEL[c.kind]}</span><h2 id={`v2s-result-${c.id}`}>{c.title}</h2></header>
                  {c.selections.length === 0 ? <p className="v2s-soft-note">Results are being prepared.</p> : (
                    <div className="v2s-result-grid">
                      {[...c.selections].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99)).map(s => (
                        <figure className={`v2s-result${s.studentId === me?.id ? ' is-mine' : ''}`} key={s.entryId}>
                          <SignedImage storageKey={s.imageStorageKey} alt={`Entry by ${s.studentName}`} onClickUrl={setLightbox} />
                          <figcaption>
                            <span className="v2s-chip is-green">{s.label}</span>
                            <strong>{s.studentId === me?.id ? 'You!' : s.studentName}</strong>
                            {s.branchName && <small>{s.branchName}</small>}
                          </figcaption>
                        </figure>
                      ))}
                    </div>
                  )}
                </section>
              ))}
            </div>
      )}

      {entryFor && <EntrySheet competition={entryFor} onClose={() => setEntryFor(null)} onSent={() => void load()} />}
      {showcaseOpen && <ShowcaseRequestSheet onClose={() => setShowcaseOpen(false)} />}
      {lightbox && <ImageLightbox url={lightbox} alt="Enlarged image" onClose={() => setLightbox(null)} />}
    </main>
  );
}

function EntrySheet({ competition, onClose, onSent }: { competition: V2Competition; onClose: () => void; onSent: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!file) { setPreview(null); return; }
    const url = URL.createObjectURL(file); setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const send = async () => {
    if (!file || sending) return;
    setSending(true); setError(null);
    try {
      const { storageKey } = await uploadFile('competition-entries', file);
      await apiFetch(`/v2/competitions/${competition.id}/entries`, { method: 'POST', body: { imageStorageKey: storageKey } });
      setDone(true); onSent();
    } catch (err) { setError(errorMessage(err, 'Your entry could not be sent. Please try again.')); }
    finally { setSending(false); }
  };
  return (
    <Sheet title={done ? 'Entry sent' : 'Send my entry'} onClose={onClose}>
      {done ? (
        <div className="v2s-sent-state" role="status">
          <span className="v2s-sent-icon"><Check size={22} /></span>
          <strong>Your entry is in — thank you!</strong>
          <p>We will let you know when the results of “{competition.title}” are ready.</p>
          <button type="button" className="btn btn-primary" onClick={onClose}>Close</button>
        </div>
      ) : (
        <>
          <p className="v2s-sheet-lead">{competition.title}</p>
          <label className={`v2s-photo-drop${file ? ' has-file' : ''}`}>
            {preview ? <img src={preview} alt="Your entry" /> : <Camera size={24} aria-hidden="true" />}
            <strong>{file ? file.name : 'Take or choose a photo'}</strong>
            <small>Daylight, flat page, the whole piece in frame</small>
            <input type="file" accept="image/*" onChange={event => { const next = event.target.files?.[0]; if (next) setFile(next); }} />
          </label>
          {error && <p className="v2s-form-error" role="alert">{error}</p>}
          <div className="v2s-sheet-actions">
            <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={!file || sending} onClick={() => void send()}><Send size={15} /> {sending ? 'Sending…' : 'Send entry'}</button>
          </div>
        </>
      )}
    </Sheet>
  );
}

// ---------------------------------------------------------------- staff / admin

function StaffCompetitions({ admin }: { admin: boolean }) {
  const { items, error, load } = useCompetitions('all');
  const [tab, setTab] = useState<'list' | 'showcase'>('list');
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const opened = items?.find(c => c.id === openId) ?? null;

  if (opened) return <EntriesView competition={opened} onBack={() => { setOpenId(null); void load(); }} />;

  return (
    <main className="page portal-page v2s-student-page v2s-comp-page is-staff">
      <header className="v2s-page-head v2s-page-head-row">
        <div>
          <p className="eyebrow">Competitions & calls</p>
          <h1>Competitions & calls</h1>
          <p className="muted">Open a competition or a call for calligraphers, choose the best entries and celebrate them across the branch.</p>
        </div>
        {admin && <button type="button" className="btn btn-primary v2s-cta" onClick={() => setCreating(true)}><Plus size={16} /> Create</button>}
      </header>

      {admin && (
        <div className="tabs v2s-tabs" role="tablist" aria-label="Sections">
          <button type="button" role="tab" aria-selected={tab === 'list'} className={tab === 'list' ? 'active' : ''} onClick={() => setTab('list')}>Competitions & calls</button>
          <button type="button" role="tab" aria-selected={tab === 'showcase'} className={tab === 'showcase' ? 'active' : ''} onClick={() => setTab('showcase')}>Showcase requests</button>
        </div>
      )}

      {tab === 'showcase' && admin ? <ShowcaseRequests /> : (
        <>
          {error && <InlineError message={error} onRetry={() => void load()} />}
          {!items && !error && <PenLoader label="Loading competitions…" compact />}
          {items && items.length === 0 && <EmptyState icon={<Trophy size={22} />} title="No competitions yet" text={admin ? 'Create the first competition or call — students will see it on their dashboard.' : 'When an admin opens a competition or call, it appears here.'} action={admin ? <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={15} /> Create</button> : undefined} />}
          {items && items.length > 0 && (
            <ul className="v2s-staff-list">
              {items.map(c => (
                <li key={c.id}>
                  <button type="button" className="v2s-staff-row" onClick={() => setOpenId(c.id)}>
                    <span className="v2s-staff-thumb">{c.coverStorageKey ? <SignedImage storageKey={c.coverStorageKey} alt="" /> : c.kind === 'call' ? <Megaphone size={18} /> : <Trophy size={18} />}</span>
                    <span className="v2s-staff-copy">
                      <strong>{c.title}</strong>
                      <small>{KIND_LABEL[c.kind]}{dateRange(c) ? ` · ${dateRange(c)}` : ''}{c.branchIds ? ` · ${c.branchIds.length} branch${c.branchIds.length === 1 ? '' : 'es'}` : ' · All branches'}</small>
                    </span>
                    <span className={`v2s-chip ${c.resultsPublished ? 'is-green' : isOpen(c) ? 'is-blue' : 'is-neutral'}`}>{c.resultsPublished ? 'Results out' : isOpen(c) ? 'Open' : c.status === 'upcoming' ? 'Upcoming' : 'Closed'}</span>
                    <span className="v2s-staff-count"><Users size={14} aria-hidden="true" /> {c.entryCount ?? '—'}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {creating && <CreateSheet onClose={() => setCreating(false)} onCreated={() => { setCreating(false); void load(); }} />}
    </main>
  );
}

type Selection = { label: string; rank: string; publish: boolean };

function EntriesView({ competition, onBack }: { competition: V2Competition; onBack: () => void }) {
  const [entries, setEntries] = useState<V2CompetitionEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<string, Selection>>({});
  const [editing, setEditing] = useState<V2CompetitionEntry | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await apiFetch<unknown[]>(`/v2/competitions/${competition.id}/entries`);
      const list = (Array.isArray(data) ? data : []).map(normalizeEntry);
      setEntries(list);
      const existing: Record<string, Selection> = {};
      list.filter(e => e.selectionLabel).forEach(e => { existing[e.id] = { label: e.selectionLabel!, rank: e.selectionRank != null ? String(e.selectionRank) : '', publish: true }; });
      competition.selections.forEach(s => { existing[s.entryId] = { label: s.label, rank: s.rank != null ? String(s.rank) : '', publish: s.publishedToGallery }; });
      setPicked(existing);
    } catch (err) { setError(errorMessage(err, 'Entries could not be loaded.')); }
  }, [competition]);
  useEffect(() => { void load(); }, [load]);

  const count = Object.keys(picked).length;
  const publish = async () => {
    setPublishing(true); setPublishError(null);
    try {
      await apiFetch(`/v2/competitions/${competition.id}/results`, { method: 'POST', body: { selections: Object.entries(picked).map(([entryId, s]) => ({ entryId, label: s.label.trim() || 'Selected', rank: s.rank ? Number(s.rank) : null, publishToGallery: s.publish })) } });
      setPublished(true); setConfirming(false);
    } catch (err) { setPublishError(errorMessage(err, 'Results could not be published. Please try again.')); }
    finally { setPublishing(false); }
  };

  return (
    <main className={`page portal-page v2s-student-page v2s-comp-page is-staff${count ? ' has-print-bar' : ''}`}>
      <button type="button" className="v2s-back" onClick={onBack}><ArrowLeft size={15} /> All competitions</button>
      <header className="v2s-page-head">
        <p className="eyebrow">{KIND_LABEL[competition.kind]}</p>
        <h1>{competition.title}</h1>
        <p className="muted">Tap an entry to select it, give it a label and choose whether it goes to the gallery. Students are told when you publish.</p>
      </header>
      {published && <div className="v2s-success" role="status"><CheckCircle2 size={18} /> Results published — students have been told and the highlights are on their dashboards.</div>}
      {error && <InlineError message={error} onRetry={() => void load()} />}
      {!entries && !error && <PenLoader label="Loading entries…" compact />}
      {entries && entries.length === 0 && <EmptyState icon={<ImagePlus size={22} />} title="No entries yet" text="Entries appear here as soon as students send them." />}
      {entries && entries.length > 0 && (
        <div className="v2s-entry-grid">
          {entries.map(entry => {
            const sel = picked[entry.id];
            return (
              <button type="button" key={entry.id} className={`v2s-entry${sel ? ' is-selected' : ''}`} onClick={() => setEditing(entry)} aria-pressed={Boolean(sel)} aria-label={`Entry by ${entry.studentName}${sel ? `, selected as ${sel.label}` : ''}`}>
                <SignedImage storageKey={entry.imageStorageKey} alt={`Entry by ${entry.studentName}`} />
                <span className="v2s-entry-meta"><strong>{entry.studentName}</strong><small>{entry.branchName ?? ''}</small></span>
                {sel && <span className="v2s-entry-badge"><Check size={12} /> {sel.label}{sel.rank ? ` · #${sel.rank}` : ''}</span>}
              </button>
            );
          })}
        </div>
      )}

      {count > 0 && (
        <div className="v2s-print-bar" role="region" aria-label="Publish results">
          <span><strong>{count}</strong> selected</span>
          <button type="button" className="btn btn-primary" onClick={() => setConfirming(true)}><Trophy size={15} /> Publish results</button>
        </div>
      )}

      {editing && <SelectionSheet entry={editing} value={picked[editing.id] ?? null} onClose={() => setEditing(null)} onSave={value => { setPicked(current => { const next = { ...current }; if (value) next[editing.id] = value; else delete next[editing.id]; return next; }); setEditing(null); }} />}

      {confirming && (
        <Sheet title="Publish results?" onClose={() => setConfirming(false)}>
          <p className="v2s-sheet-lead">{count} {count === 1 ? 'student' : 'students'} will be told, their branch dashboards will show the highlight{Object.values(picked).some(s => s.publish) ? ', and the ticked pieces go to the gallery' : ''}.</p>
          <ul className="v2s-confirm-list">
            {Object.entries(picked).map(([id, s]) => <li key={id}><strong>{entries?.find(e => e.id === id)?.studentName ?? 'Student'}</strong><span>{s.label}{s.rank ? ` · #${s.rank}` : ''}{s.publish ? ' · Gallery' : ''}</span></li>)}
          </ul>
          {publishError && <p className="v2s-form-error" role="alert">{publishError}</p>}
          <div className="v2s-sheet-actions">
            <button type="button" className="btn btn-outline" onClick={() => setConfirming(false)}>Not yet</button>
            <button type="button" className="btn btn-primary" onClick={() => void publish()} disabled={publishing}>{publishing ? <><RefreshCw size={14} className="v2s-spin" /> Publishing…</> : 'Publish now'}</button>
          </div>
        </Sheet>
      )}
    </main>
  );
}

function SelectionSheet({ entry, value, onClose, onSave }: { entry: V2CompetitionEntry; value: Selection | null; onClose: () => void; onSave: (value: Selection | null) => void }) {
  const [label, setLabel] = useState(value?.label ?? SELECTION_LABELS[0]);
  const [rank, setRank] = useState(value?.rank ?? '');
  const [publish, setPublish] = useState(value?.publish ?? true);
  return (
    <Sheet title={entry.studentName} onClose={onClose}>
      <SignedImage storageKey={entry.imageStorageKey} alt={`Entry by ${entry.studentName}`} className="v2s-entry-large" />
      <p className="v2s-block-label">Label</p>
      <div className="v2s-label-chips" role="radiogroup" aria-label="Label">
        {SELECTION_LABELS.map(option => <button type="button" role="radio" aria-checked={label === option} key={option} className={`v2s-choice${label === option ? ' is-on' : ''}`} onClick={() => setLabel(option)}>{option}</button>)}
      </div>
      <label className="field-label v2s-field">Or write your own label<input className="field" value={label} maxLength={60} onChange={event => setLabel(event.target.value)} /></label>
      <div className="v2s-form-row">
        <label className="field-label v2s-field">Rank (optional)<input className="field" inputMode="numeric" value={rank} onChange={event => setRank(event.target.value.replace(/\D/g, '').slice(0, 3))} placeholder="1" /></label>
        <label className="v2s-tick"><input type="checkbox" checked={publish} onChange={event => setPublish(event.target.checked)} /> <span>Publish to gallery</span></label>
      </div>
      <div className="v2s-sheet-actions">
        {value ? <button type="button" className="btn btn-outline" onClick={() => onSave(null)}><Trash2 size={14} /> Remove</button> : <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>}
        <button type="button" className="btn btn-primary" onClick={() => onSave({ label: label.trim() || 'Selected', rank, publish })}><Check size={15} /> Select</button>
      </div>
    </Sheet>
  );
}

function CreateSheet({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [kind, setKind] = useState<CompetitionKind>('competition');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [branches, setBranches] = useState<{ id: string; name: string }[]>([]);
  const [branchIds, setBranchIds] = useState<string[]>([]);
  const [excerpts, setExcerpts] = useState<{ text: string; imageStorageKey: string | null; uploading?: boolean }[]>([{ text: '', imageStorageKey: null }]);
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [endDate, setEndDate] = useState('');
  const [cover, setCover] = useState<{ storageKey: string; name: string } | null>(null);
  const [coverUploading, setCoverUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { apiFetch<{ id: string; name: string }[]>('/branches', { silent: true }).then(setBranches).catch(() => setBranches([])); }, []);

  const uploadExcerptImage = async (index: number, file: File) => {
    setExcerpts(list => list.map((item, i) => i === index ? { ...item, uploading: true } : item));
    try {
      const { storageKey } = await uploadFile('competitions', file);
      setExcerpts(list => list.map((item, i) => i === index ? { ...item, imageStorageKey: storageKey, uploading: false } : item));
    } catch (err) {
      setError(errorMessage(err, 'The image could not be uploaded.'));
      setExcerpts(list => list.map((item, i) => i === index ? { ...item, uploading: false } : item));
    }
  };
  const uploadCover = async (file: File) => {
    setCoverUploading(true);
    try { const { storageKey } = await uploadFile('competitions', file); setCover({ storageKey, name: file.name }); }
    catch (err) { setError(errorMessage(err, 'The cover could not be uploaded.')); }
    finally { setCoverUploading(false); }
  };

  const valid = title.trim().length > 2 && (!endDate || endDate >= startDate);
  const save = async () => {
    if (!valid || saving) return;
    setSaving(true); setError(null);
    try {
      await apiFetch('/v2/competitions', { method: 'POST', body: {
        kind, title: title.trim(), description: description.trim() || null,
        branchIds: branchIds.length ? branchIds : null,
        excerpts: excerpts.filter(e => e.text.trim() || e.imageStorageKey).map(e => ({ text: e.text.trim() || null, imageStorageKey: e.imageStorageKey })),
        startDate: startDate || null, endDate: endDate || null, coverStorageKey: cover?.storageKey ?? null,
      } });
      onCreated();
    } catch (err) { setError(errorMessage(err, 'This could not be saved. Please check and try again.')); }
    finally { setSaving(false); }
  };

  return (
    <Sheet title="Create a competition or call" onClose={onClose} wide>
      <div className="v2s-form">
        <div className="v2s-label-chips" role="radiogroup" aria-label="Kind">
          <button type="button" role="radio" aria-checked={kind === 'competition'} className={`v2s-choice is-big${kind === 'competition' ? ' is-on' : ''}`} onClick={() => setKind('competition')}><Trophy size={16} /> Competition</button>
          <button type="button" role="radio" aria-checked={kind === 'call'} className={`v2s-choice is-big${kind === 'call' ? ' is-on' : ''}`} onClick={() => setKind('call')}><Megaphone size={16} /> Call for calligraphers</button>
        </div>
        <label className="field-label v2s-field">Title<input className="field" value={title} onChange={event => setTitle(event.target.value)} placeholder={kind === 'call' ? 'e.g. Ashara 1448 decoration' : 'e.g. Naskh mufradat competition'} /></label>
        <label className="field-label v2s-field">Description<textarea className="field" rows={3} value={description} onChange={event => setDescription(event.target.value)} placeholder="What should students know? Paper size, pen, how it will be judged…" /></label>

        <div className="v2s-field">
          <p className="field-label">Branches</p>
          <div className="v2s-label-chips">
            <button type="button" className={`v2s-choice${branchIds.length === 0 ? ' is-on' : ''}`} onClick={() => setBranchIds([])}>All branches</button>
            {branches.map(branch => <button type="button" key={branch.id} aria-pressed={branchIds.includes(branch.id)} className={`v2s-choice${branchIds.includes(branch.id) ? ' is-on' : ''}`} onClick={() => setBranchIds(ids => ids.includes(branch.id) ? ids.filter(id => id !== branch.id) : [...ids, branch.id])}>{branch.name}</button>)}
          </div>
        </div>

        <div className="v2s-field">
          <p className="field-label">{kind === 'call' ? 'Excerpts to write' : 'Texts to write (optional)'}</p>
          <ol className="v2s-excerpt-editor">
            {excerpts.map((excerpt, index) => (
              <li key={index}>
                <textarea className="field" dir="auto" rows={2} value={excerpt.text} onChange={event => setExcerpts(list => list.map((item, i) => i === index ? { ...item, text: event.target.value } : item))} placeholder="Paste the text (Arabic is fine)" aria-label={`Excerpt ${index + 1}`} />
                <div className="v2s-excerpt-tools">
                  <label className="btn btn-outline v2s-file-btn"><ImagePlus size={14} /> {excerpt.uploading ? 'Uploading…' : excerpt.imageStorageKey ? 'Image added ✓' : 'Add image'}<input type="file" accept="image/*" onChange={event => { const f = event.target.files?.[0]; if (f) void uploadExcerptImage(index, f); }} /></label>
                  {excerpts.length > 1 && <button type="button" className="v2s-icon-button" aria-label={`Remove excerpt ${index + 1}`} onClick={() => setExcerpts(list => list.filter((_, i) => i !== index))}><Trash2 size={15} /></button>}
                </div>
              </li>
            ))}
          </ol>
          <button type="button" className="v2s-link-button" onClick={() => setExcerpts(list => [...list, { text: '', imageStorageKey: null }])}><Plus size={14} /> Add another excerpt</button>
        </div>

        <div className="v2s-form-row">
          <label className="field-label v2s-field">Opens<input className="field" type="date" value={startDate} onChange={event => setStartDate(event.target.value)} /></label>
          <label className="field-label v2s-field">Closes<input className="field" type="date" value={endDate} min={startDate} onChange={event => setEndDate(event.target.value)} /></label>
        </div>

        <label className={`v2s-photo-drop is-compact${cover ? ' has-file' : ''}`}>
          <ImagePlus size={20} aria-hidden="true" />
          <strong>{coverUploading ? 'Uploading…' : cover ? `Cover: ${cover.name}` : 'Add a cover image (optional)'}</strong>
          <input type="file" accept="image/*" onChange={event => { const f = event.target.files?.[0]; if (f) void uploadCover(f); }} />
        </label>

        {error && <p className="v2s-form-error" role="alert">{error}</p>}
        <div className="v2s-sheet-actions">
          <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={!valid || saving || coverUploading}>{saving ? 'Saving…' : kind === 'call' ? 'Open the call' : 'Open the competition'}</button>
        </div>
      </div>
    </Sheet>
  );
}

function minutesWords(total: number): string {
  const h = Math.floor(total / 60), m = total % 60;
  return [h ? `${h} hour${h === 1 ? '' : 's'}` : '', m ? `${m} minute${m === 1 ? '' : 's'}` : ''].filter(Boolean).join(' ') || `${total} minutes`;
}

function ShowcaseRequests() {
  const [items, setItems] = useState<V2ShowcaseRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await apiFetch<unknown[]>('/v2/showcase/requests?status=pending');
      setItems((Array.isArray(data) ? data : []).map(normalizeShowcaseRequest));
    } catch (err) { setError(errorMessage(err, 'Requests could not be loaded.')); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const decide = async (id: string, approve: boolean) => {
    setBusy(id);
    try {
      await apiFetch(`/v2/showcase/requests/${id}/decision`, { method: 'POST', body: { approve } });
      setItems(list => (list ?? []).filter(item => item.id !== id));
    } catch (err) { setError(errorMessage(err, 'That did not save. Please try again.')); }
    finally { setBusy(null); }
  };
  const sorted = useMemo(() => [...(items ?? [])].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))), [items]);
  return (
    <>
      {error && <InlineError message={error} onRetry={() => void load()} />}
      {!items && !error && <PenLoader label="Loading requests…" compact />}
      {items && items.length === 0 && <EmptyState icon={<Sparkles size={22} />} title="All caught up" text="No students are waiting for a showcase answer." />}
      <div className="v2s-request-grid">
        {sorted.map(item => (
          <article className="v2s-request" key={item.id}>
            <SignedImage storageKey={item.storageKey} alt={`Work by ${item.studentName}`} onClickUrl={setLightbox} />
            <div className="v2s-request-body">
              <strong>{item.studentName}</strong>
              <small>{[item.branchName, formatDate(item.createdAt, { day: 'numeric', month: 'short' })].filter(Boolean).join(' · ')}</small>
              {item.question && <p className="v3-req-q">{item.question}</p>}
              {item.caption ? <p className="v3-req-answer">{item.caption}</p> : <p className="v3-req-answer is-empty">No answer written.</p>}
              <p className="v3-req-time"><Clock size={14} aria-hidden="true" /> {item.timeMinutes ? `Time taken: ${minutesWords(item.timeMinutes)}` : 'Time taken: not given'}</p>
              <div className="v2s-request-actions">
                <button type="button" className="btn btn-outline" disabled={busy === item.id} onClick={() => void decide(item.id, false)}>Not now</button>
                <button type="button" className="btn btn-primary" disabled={busy === item.id} onClick={() => void decide(item.id, true)}><Check size={15} /> Approve</button>
              </div>
            </div>
          </article>
        ))}
      </div>
      {lightbox && <ImageLightbox url={lightbox} alt="Showcase request" onClose={() => setLightbox(null)} />}
    </>
  );
}
