import { useRef, useState } from 'react';
import { Award, FileDown, ImagePlus, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { apiFetch, uploadFile } from '@/api';
import { BADGE_KIND_LABEL, openApiFile, type BadgeDesign, type BadgeDesignsResponse, type BadgeKind } from '../builderTypes';
import {
  ConfirmDialog, Dialog, EmptyState, ErrorBox, Loading, PageHead, Segmented, Switch, ToastHost, errorText, loadScope, plural, toast, useLoad,
} from '../shared';
import '../v2-admin.css';
import '../v3-builder.css';

const KINDS: BadgeKind[] = ['level', 'course', 'competition'];
const KIND_HELP: Record<BadgeKind, string> = {
  level: 'Given when a student passes a level assessment.',
  course: 'Given when a whole course is completed.',
  competition: 'Given to selected entries of a competition or call.',
};

export function loadBadgeDesigns() {
  return apiFetch<BadgeDesignsResponse>('/v2/badge-designs');
}

/** Badge designs: the master team uploads the artwork; students download a printable badge. */
export function BadgeDesignsPanel({ canEdit, onChanged }: { canEdit: boolean; onChanged?: () => void }) {
  const data = useLoad(loadBadgeDesigns);
  const [editing, setEditing] = useState<BadgeDesign | 'new' | null>(null);
  const [newKind, setNewKind] = useState<BadgeKind>('level');
  const [removing, setRemoving] = useState<BadgeDesign | null>(null);

  if (data.loading && !data.data) return <Loading label="Loading badge designs…" />;
  if (data.error && !data.data) return <ErrorBox message={data.error} onRetry={() => void data.reload()} />;
  const designs = data.data?.designs ?? [];
  const changed = () => { void data.reload(true); onChanged?.(); };

  const makeDefault = async (d: BadgeDesign) => {
    try {
      await apiFetch('/v2/badge-designs', { method: 'PUT', body: { id: d.id, name: d.name, kind: d.kind, badgeCode: null, isDefault: true, note: d.note } });
      toast(`"${d.name}" is now the usual ${BADGE_KIND_LABEL[d.kind].toLowerCase()}.`);
      changed();
    } catch (err) { toast(errorText(err), { tone: 'error' }); }
  };
  const sample = async (d: BadgeDesign) => {
    try { await openApiFile(`/v2/badge-designs/${d.id}/sample`); } catch (err) { toast(errorText(err), { tone: 'error' }); }
  };

  return (
    <div className="v3-badges">
      <p className="v2-help v3-lead">
        Upload the artwork once. Every student who earns that badge can open it, download it as a printable page with their name, and upload it to JHS.
        The design marked “Usual design” is used unless a level or course chooses another one in the builder.
      </p>
      {KINDS.map(kind => {
        const list = designs.filter(d => d.kind === kind);
        return (
          <section key={kind} className="v3-badge-group" aria-labelledby={`bk-${kind}`}>
            <header className="v3-badge-group-head">
              <div>
                <h3 id={`bk-${kind}`}>{BADGE_KIND_LABEL[kind]}s</h3>
                <p className="v2-help">{KIND_HELP[kind]}</p>
              </div>
              {canEdit && <button type="button" className="btn btn-outline v2-btn-sm" onClick={() => { setNewKind(kind); setEditing('new'); }}><Plus size={14} /> Add design</button>}
            </header>
            {list.length === 0 ? (
              <p className="v3-badge-empty">No design yet — students see a simple Funun al-Quran seal{canEdit ? '. Add the artwork to use your own design.' : '.'}</p>
            ) : (
              <div className="v3-badge-grid">
                {list.map(d => (
                  <article key={d.id} className={`v3-badge-card${d.isDefault ? ' is-default' : ''}`}>
                    <div className="v3-badge-art">
                      {d.imageUrl ? <img src={d.imageUrl} alt={`Artwork of ${d.name}`} loading="lazy" /> : <Award size={34} aria-hidden="true" />}
                    </div>
                    <div className="v3-badge-body">
                      <strong>{d.name}</strong>
                      <span className="v3-badge-tags">
                        {d.isDefault && <span className="v3-tag v3-tag-green"><Star size={11} /> Usual design</span>}
                        {d.badgeCode && <span className="v3-tag">Only for {d.badgeCode}</span>}
                        {d.usedBy > 0 && <span className="v3-tag">Chosen by {plural(d.usedBy, 'level/course', 'levels/courses')}</span>}
                        {!d.imageUrl && <span className="v3-tag v3-tag-amber">No artwork yet</span>}
                      </span>
                      {d.note && <small className="v2-help">{d.note}</small>}
                    </div>
                    <div className="v3-badge-actions">
                      <button type="button" className="btn btn-outline v2-btn-sm" onClick={() => void sample(d)}><FileDown size={14} /> Sample PDF</button>
                      {canEdit && <button type="button" className="btn btn-outline v2-btn-sm" onClick={() => setEditing(d)}><Pencil size={14} /> Edit</button>}
                      {canEdit && !d.isDefault && !d.badgeCode && <button type="button" className="v2-link" onClick={() => void makeDefault(d)}><Star size={13} /> Make usual</button>}
                      {canEdit && <button type="button" className="v2-link v2-danger-link" onClick={() => setRemoving(d)}><Trash2 size={13} /> Remove</button>}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        );
      })}
      {editing && (
        <DesignDialog
          design={editing === 'new' ? null : editing}
          kind={editing === 'new' ? newKind : editing.kind}
          codes={data.data?.codes ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); changed(); }}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={`Remove "${removing.name}"?`}
          text="Badges already earned are kept. Levels or courses that chose this design go back to the usual design."
          confirmLabel="Remove design"
          danger
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            try { await apiFetch(`/v2/badge-designs/${removing.id}`, { method: 'DELETE' }); toast('Design removed.'); changed(); }
            catch (err) { toast(errorText(err), { tone: 'error' }); }
          }}
        />
      )}
    </div>
  );
}

function DesignDialog({ design, kind: initialKind, codes, onClose, onSaved }: {
  design: BadgeDesign | null; kind: BadgeKind; codes: BadgeDesignsResponse['codes']; onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(design?.name ?? '');
  const [kind, setKind] = useState<BadgeKind>(design?.kind ?? initialKind);
  const [isDefault, setIsDefault] = useState(design ? design.isDefault : true);
  const [onlyFor, setOnlyFor] = useState(design?.badgeCode ?? '');
  const [note, setNote] = useState(design?.note ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(design?.imageUrl ?? null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const kindCodes = codes.filter(c => c.kind === kind);

  const pick = (f: File | undefined) => {
    if (!f) return;
    if (!/\.(png|jpe?g)$/i.test(f.name)) { toast('Please choose a PNG or JPG image.', { tone: 'error' }); return; }
    setFile(f);
    setPreview(URL.createObjectURL(f));
    if (!name.trim()) setName(f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '));
  };
  const save = async () => {
    setBusy(true);
    try {
      let storageKey: string | undefined;
      let contentType: string | undefined;
      if (file) {
        storageKey = (await uploadFile('badge-assets', file)).storageKey;
        contentType = file.type || (file.name.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg');
      }
      await apiFetch('/v2/badge-designs', {
        method: 'PUT',
        body: { id: design?.id, name: name.trim(), kind, isDefault: onlyFor ? false : isDefault, badgeCode: onlyFor || null, note: note.trim() || null, storageKey, contentType },
      });
      toast(design ? 'Badge design saved.' : 'Badge design added.');
      onSaved();
    } catch (err) { toast(errorText(err), { tone: 'error' }); } finally { setBusy(false); }
  };

  return (
    <Dialog
      title={design ? 'Edit badge design' : 'Add a badge design'}
      eyebrow={BADGE_KIND_LABEL[kind]}
      onClose={onClose}
      footer={<><button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy || !name.trim() || (!design && !file)} onClick={() => void save()}>{busy ? 'Saving…' : 'Save design'}</button></>}
    >
      <div className="v3-art-drop">
        <button type="button" className="v3-art-box" onClick={() => input.current?.click()} aria-label="Choose the artwork image">
          {preview ? <img src={preview} alt="Artwork preview" /> : <><ImagePlus size={28} /><span>Choose artwork</span></>}
        </button>
        <div>
          <p className="v2-help">PNG or JPG, square works best (for example 1000 × 1000). A transparent PNG looks cleanest on the printed page.</p>
          <button type="button" className="btn btn-outline v2-btn-sm" onClick={() => input.current?.click()}><ImagePlus size={14} /> {preview ? 'Replace image' : 'Choose image'}</button>
          <input ref={input} type="file" accept="image/png,image/jpeg" hidden onChange={e => pick(e.target.files?.[0])} />
        </div>
      </div>
      <label className="field-label">Name<input className="field" value={name} placeholder="e.g. Level badge — gold" onChange={e => setName(e.target.value)} /></label>
      <div className="field-label">For
        <Segmented<BadgeKind> label="Badge kind" value={kind} onChange={k => { setKind(k); setOnlyFor(''); }} options={KINDS.map(k => ({ value: k, label: BADGE_KIND_LABEL[k] }))} />
      </div>
      <div className="v3-switch-line">
        <Switch id="v3-design-default" checked={isDefault && !onlyFor} disabled={Boolean(onlyFor)} onChange={setIsDefault} label={`Use as the usual ${BADGE_KIND_LABEL[kind].toLowerCase()}`} />
        <label htmlFor="v3-design-default">Use as the usual {BADGE_KIND_LABEL[kind].toLowerCase()}</label>
      </div>
      <label className="field-label">Only for one badge <span className="v2-optional">optional</span>
        <select className="field" value={onlyFor} onChange={e => setOnlyFor(e.target.value)}>
          <option value="">— Any badge of this kind —</option>
          {kindCodes.map(c => <option key={c.badgeCode} value={c.badgeCode}>{c.label}</option>)}
          {onlyFor && !kindCodes.some(c => c.badgeCode === onlyFor) && <option value={onlyFor}>{onlyFor}</option>}
        </select>
      </label>
      <label className="field-label">Note for the team <span className="v2-optional">optional</span><input className="field" value={note} onChange={e => setNote(e.target.value)} /></label>
    </Dialog>
  );
}

/** Standalone page (route suggestion for the lead: `v2-badges`, admin only). */
export function V2BadgeDesignsPage() {
  const scope = useLoad(() => loadScope());
  return (
    <div className="page portal-page v2-admin">
      <PageHead eyebrow="Curriculum control" title="Badge designs" text="The artwork students receive for each level, course and competition — printable and ready to upload to JHS." />
      {scope.loading && !scope.data ? <Loading label="Loading…" /> : scope.error && !scope.data ? <ErrorBox message={scope.error} /> : (
        scope.data ? <BadgeDesignsPanel canEdit={scope.data.scope.isMaster} /> : <EmptyState icon={<Award size={26} />} title="Nothing to show" />
      )}
      <ToastHost />
    </div>
  );
}
