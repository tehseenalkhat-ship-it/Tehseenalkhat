import { useCallback, useEffect, useState } from 'react';
import { BookOpenCheck, Clock3, GraduationCap, Heart, ImagePlus, PenTool, Search, Trash2, Users } from 'lucide-react';
import { apiFetch, ApiError, getSessionUser, uploadFile } from '@/api';
import { Button, PenLoader, UploadBox, navigate } from '@/components/ui';
import type { GalleryWork, ShowcaseFeed, ShowcaseItem } from './contentTypes';
import { V3ImageViewer, V3Layer, V3Tabs, cleanLabel, effortLabel, useViewUrls } from './contentShared';

export const SCRIPTS = ['Naskh', 'Thuluth', 'Nastaleeq', 'Istinsakh', 'Riqa', 'Diwani', 'Kufi', 'Other'];
type Tab = 'reference' | 'teacher';
type Branch = { id: string; name: string };

/**
 * Gallery (owner notes 1.9, E, 4.2): reference work by calligraphers, added by admins and
 * teachers only, plus the teachers' demonstration pieces. v3 audit 15: no student showcase here —
 * student work lives in Showcase.
 */
export function V3GalleryPage() {
  const user = getSessionUser();
  const isStaff = user?.role === 'teacher' || user?.role === 'admin';
  const initial = (sessionStorage.getItem('khat.v3.galleryTab') as Tab | null) ?? 'reference';
  const [tab, setTab] = useState<Tab>(initial === 'teacher' ? initial : 'reference');
  useEffect(() => { sessionStorage.removeItem('khat.v3.galleryTab'); }, []);

  return (
    <main className="page portal-page v3c-content-page">
      <header className="v3c-page-head">
        <div>
          <p className="eyebrow">Gallery</p>
          <h1>{tab === 'reference' ? 'Reference work' : 'Teacher showcase'}</h1>
          <p className="v3c-lede">{tab === 'reference'
            ? 'Pieces by master calligraphers, chosen by your teachers to study and learn from.'
            : 'Demonstration pieces from the teachers of your branch.'}</p>
        </div>
        {tab !== 'reference' && isStaff && <button type="button" className="v3c-ghost-btn" onClick={() => navigate('showcase')}><PenTool size={15} /> Share my work</button>}
      </header>
      <V3Tabs<Tab> label="Gallery sections" value={tab} onChange={setTab} options={[
        { value: 'reference', label: 'Reference work', icon: <BookOpenCheck size={15} /> },
        { value: 'teacher', label: 'Teacher showcase', icon: <Users size={15} /> },
      ]} />
      {tab === 'reference' ? <ReferenceGallery canAdd={isStaff} /> : <ShowcaseFeedView role={tab} />}
    </main>
  );
}

function ReferenceGallery({ canAdd }: { canAdd: boolean }) {
  const [works, setWorks] = useState<GalleryWork[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [script, setScript] = useState('');
  const [open, setOpen] = useState<GalleryWork | null>(null);
  const [adding, setAdding] = useState(false);
  const urls = useViewUrls(works.map(w => w.imageStorageKey));

  const load = useCallback(() => {
    setLoading(true); setError(null);
    const p = new URLSearchParams();
    if (q.trim()) p.set('q', q.trim());
    if (script) p.set('script', script);
    apiFetch<GalleryWork[]>(`/v2/gallery?${p}`)
      .then(setWorks)
      .catch(err => setError(err instanceof ApiError ? err.message : 'Could not load the gallery.'))
      .finally(() => setLoading(false));
  }, [q, script]);
  useEffect(() => { const t = window.setTimeout(load, 250); return () => window.clearTimeout(t); }, [load]);

  const remove = async (w: GalleryWork) => {
    if (!window.confirm(`Remove “${w.title}” from the gallery?`)) return;
    try { await apiFetch(`/v2/gallery/${w.id}`, { method: 'DELETE' }); setOpen(null); load(); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Could not remove it.'); }
  };

  const scriptsInUse = Array.from(new Set(works.map(w => w.script).filter(Boolean))) as string[];

  return (
    <section aria-label="Reference work">
      <div className="v3c-toolbar">
        <label className="v3c-search"><Search size={16} /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Search title or calligrapher" aria-label="Search reference work" /></label>
        <select className="v3c-select" value={script} onChange={e => setScript(e.target.value)} aria-label="Filter by script">
          <option value="">All scripts</option>
          {Array.from(new Set([...SCRIPTS, ...scriptsInUse])).map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        {canAdd && <Button onClick={() => setAdding(true)}><ImagePlus size={15} /> Add a reference piece</Button>}
      </div>
      {error && <p className="error-text" role="alert">{error}</p>}
      {loading ? <PenLoader label="Loading reference work…" compact /> : works.length === 0 ? (
        <div className="v3c-empty"><BookOpenCheck size={20} /><div><strong>{q || script ? 'Nothing matches' : 'No reference work yet'}</strong><p>{q || script ? 'Try another search or script.' : canAdd ? 'Add the first piece for your students to study.' : 'Your teachers will add pieces by master calligraphers here.'}</p></div></div>
      ) : (
        <div className="v3c-ref-grid">
          {works.map(w => (
            <button type="button" className="v3c-ref-card" key={w.id} onClick={() => setOpen(w)}>
              <span className="v3c-ref-frame">{urls[w.imageStorageKey] ? <img src={urls[w.imageStorageKey]} alt={w.title} loading="lazy" /> : <span className="v3c-img-wait" />}</span>
              <span className="v3c-ref-copy">
                {w.script && <span className="v3c-tag">{w.script}</span>}
                <strong>{w.title}</strong>
                {w.calligrapher && <small>{w.calligrapher}</small>}
              </span>
            </button>
          ))}
        </div>
      )}
      {open && urls[open.imageStorageKey] && (
        <V3ImageViewer src={urls[open.imageStorageKey]} title={open.title} storageKey={open.imageStorageKey} onClose={() => setOpen(null)}
          caption={<>{[open.calligrapher, open.script].filter(Boolean).join(' · ')}{open.note && <span className="v3c-viewer-note">{open.note}</span>}{open.canEdit && <button type="button" className="v3c-link-danger" onClick={() => void remove(open)}><Trash2 size={13} /> Remove from gallery</button>}</>} />
      )}
      {adding && <AddReferenceDialog onClose={() => setAdding(false)} onAdded={() => { setAdding(false); load(); }} />}
    </section>
  );
}

function AddReferenceDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [title, setTitle] = useState('');
  const [calligrapher, setCalligrapher] = useState('');
  const [script, setScript] = useState('Naskh');
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [branchId, setBranchId] = useState('all');
  const [branches, setBranches] = useState<Branch[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // Only the master team sees the branch choice (the policies endpoint tells us).
    apiFetch<{ canEditGlobal?: boolean }>('/v2/policies', { silent: true })
      .then(p => { if (p?.canEditGlobal) apiFetch<Branch[]>('/branches').then(setBranches).catch(() => {}); })
      .catch(() => {});
  }, []);
  const save = async () => {
    if (!title.trim() || !file) { setError('Please add a title and a photo.'); return; }
    setSaving(true); setError(null);
    try {
      const { storageKey } = await uploadFile('assets', file);
      await apiFetch('/v2/gallery', { method: 'POST', body: { title, calligrapher, script, note, storageKey, ...(branches ? { branchId } : {}) } });
      onAdded();
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Could not add the piece.'); }
    finally { setSaving(false); }
  };
  return (
    <V3Layer onClose={onClose} label="Add a reference piece">
      <div className="v3c-form">
        <h2>Add a reference piece</h2>
        <p className="v3c-lede">Work by a master calligrapher for students to study. Students cannot add here.</p>
        <label className="field-label">Title<input className="field" value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Basmala in Thuluth" /></label>
        <label className="field-label">Calligrapher<input className="field" value={calligrapher} onChange={e => setCalligrapher(e.target.value)} placeholder="e.g. Hashim Muhammad al-Baghdadi" /></label>
        <label className="field-label">Script<select className="field" value={script} onChange={e => setScript(e.target.value)}>{SCRIPTS.map(s => <option key={s}>{s}</option>)}</select></label>
        <label className="field-label">What should students notice? (optional)<textarea className="field textarea" value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. the even height of the alifs" /></label>
        {branches && <label className="field-label">Show to<select className="field" value={branchId} onChange={e => setBranchId(e.target.value)}><option value="all">Every branch</option>{branches.map(b => <option key={b.id} value={b.id}>{b.name} only</option>)}</select></label>}
        <UploadBox label={file?.name ?? 'Add a photo of the piece'} sublabel={file ? 'Photo ready — tap to replace' : 'JPG or PNG'} onChange={setFile} />
        {error && <p className="error-text" role="alert">{error}</p>}
        <div className="v3c-form-actions"><button type="button" className="v3c-ghost-btn" onClick={onClose}>Cancel</button><Button onClick={() => void save()} disabled={saving}>{saving ? 'Adding…' : 'Add to gallery'}</Button></div>
      </div>
    </V3Layer>
  );
}

/** Branch-specific showcase feed. Students and teachers each have their own card design. */
export function ShowcaseFeedView({ role, compact = false }: { role: 'student' | 'teacher'; compact?: boolean }) {
  const [items, setItems] = useState<ShowcaseItem[]>([]);
  const [branchName, setBranchName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<ShowcaseItem | null>(null);
  const urls = useViewUrls(items.map(i => i.imageStorageKey));
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    apiFetch<ShowcaseFeed>(`/v2/showcase/feed?role=${role}&pageSize=${compact ? 6 : 36}`)
      .then(feed => { if (!cancelled) { setItems(feed.items); setBranchName(feed.branchName); } })
      .catch(err => { if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load the showcase.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [role, compact]);

  const like = async (item: ShowcaseItem) => {
    try {
      const r = await apiFetch<{ likeCount: number; likedByMe: boolean }>(`/showcase/${item.id}/like`, { method: item.likedByMe ? 'DELETE' : 'POST' });
      setItems(list => list.map(i => i.id === item.id ? { ...i, likes: r.likeCount, likedByMe: r.likedByMe } : i));
    } catch { /* keep last state */ }
  };

  if (loading) return <PenLoader label="Loading the showcase…" compact />;
  return (
    <section aria-label={role === 'student' ? 'Student showcase' : 'Teacher showcase'}>
      {branchName && <p className="v3c-branch-note">Showing work from <b>{branchName}</b></p>}
      {error && <p className="error-text" role="alert">{error}</p>}
      {items.length === 0 ? (
        <div className="v3c-empty">{role === 'student' ? <GraduationCap size={20} /> : <Users size={20} />}<div><strong>Nothing here yet</strong><p>{role === 'student' ? 'Approved pieces by students of your branch will appear here.' : 'Pieces shared by your branch’s teachers will appear here.'}</p></div></div>
      ) : role === 'student' ? (
        <div className="v3c-stu-grid">
          {items.map(i => {
            const effort = effortLabel(i.timeMinutes);
            const award = cleanLabel(i.awardLabel);
            return (
              <article className="v3c-stu-card" key={i.id}>
                <button type="button" className="v3c-stu-img" onClick={() => setOpen(i)} aria-label={`Open ${i.authorName}'s piece`}>
                  {urls[i.imageStorageKey] ? <img src={urls[i.imageStorageKey]} alt={i.caption ?? 'Student piece'} loading="lazy" /> : <span className="v3c-img-wait" />}
                  {award && <span className="v3c-award">{award}</span>}
                </button>
                <div className="v3c-stu-body">
                  {i.question && <small className="v3c-q">{i.question}</small>}
                  {i.caption && <p className="v3c-answer">“{i.caption}”</p>}
                  <div className="v3c-stu-foot">
                    <span className="v3c-author">{i.authorName}</span>
                    {effort && <span className="v3c-effort" title="Time this piece took"><Clock3 size={13} /> {effort} of effort</span>}
                    <button type="button" className={`v3c-like${i.likedByMe ? ' is-liked' : ''}`} onClick={() => void like(i)} aria-pressed={i.likedByMe} aria-label="Like"><Heart size={14} fill={i.likedByMe ? 'currentColor' : 'none'} /> {i.likes}</button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="v3c-tch-list">
          {items.map(i => {
            const effort = effortLabel(i.timeMinutes);
            return (
              <article className="v3c-tch-card" key={i.id}>
                <button type="button" className="v3c-tch-img" onClick={() => setOpen(i)} aria-label={`Open ${i.authorName}'s piece`}>
                  {urls[i.imageStorageKey] ? <img src={urls[i.imageStorageKey]} alt={i.caption ?? 'Teacher piece'} loading="lazy" /> : <span className="v3c-img-wait" />}
                </button>
                <div className="v3c-tch-body">
                  <span className="v3c-tch-kicker">From the teacher’s desk</span>
                  <strong className="v3c-tch-name">{i.authorName}</strong>
                  {i.caption && <p className="v3c-tch-note">{i.caption}</p>}
                  <div className="v3c-tch-foot">
                    {effort && <span className="v3c-effort is-deep"><Clock3 size={13} /> {effort}</span>}
                    <button type="button" className={`v3c-like is-deep${i.likedByMe ? ' is-liked' : ''}`} onClick={() => void like(i)} aria-pressed={i.likedByMe} aria-label="Like"><Heart size={14} fill={i.likedByMe ? 'currentColor' : 'none'} /> {i.likes}</button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
      {open && urls[open.imageStorageKey] && <V3ImageViewer src={urls[open.imageStorageKey]} title={`${open.authorName}${open.role === 'teacher' ? ' · teacher' : ''}`} onClose={() => setOpen(null)}
        caption={<>{open.caption}{effortLabel(open.timeMinutes) && <span className="v3c-viewer-note">Time taken: {effortLabel(open.timeMinutes)}</span>}</>} />}
    </section>
  );
}
