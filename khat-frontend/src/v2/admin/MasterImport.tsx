import { useMemo, useState } from 'react';
import { AlertTriangle, FileSpreadsheet, Link2, Loader2, Upload } from 'lucide-react';
import { apiFetch } from '@/api';
import type { ImportAction, ManifestImportPreview, MasterImportPreview, MasterImportRow } from '../contracts';
import { Dialog, errorText, plural, Switch, toast } from './shared';

const ACTION_CHIP: Record<ImportAction, { label: string; cls: string }> = {
  create: { label: 'New', cls: 'chip chip-green' },
  update: { label: 'Changes', cls: 'chip chip-blue' },
  same: { label: 'No change', cls: 'chip' },
  error: { label: 'Problem', cls: 'chip chip-red' },
};

function SourcePicker({ onPreview, busy, kind }: { onPreview: (src: { sheetUrl?: string; csvText?: string }) => void; busy: boolean; kind: 'master' | 'tasks' }) {
  const [mode, setMode] = useState<'link' | 'file'>('link');
  const [url, setUrl] = useState('');
  const [csv, setCsv] = useState<{ name: string; text: string } | null>(null);
  const ready = mode === 'link' ? /^https?:\/\//.test(url.trim()) : Boolean(csv);
  return (
    <div className="v2-source">
      <div className="v2-source-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={mode === 'link'} className={mode === 'link' ? 'active' : ''} onClick={() => setMode('link')}><Link2 size={15} /> Google Sheet link</button>
        <button type="button" role="tab" aria-selected={mode === 'file'} className={mode === 'file' ? 'active' : ''} onClick={() => setMode('file')}><FileSpreadsheet size={15} /> CSV file</button>
      </div>
      {mode === 'link' ? (
        <>
          <label className="field-label">Paste the link to the {kind === 'master' ? '“Courses” tab of the Master Course List' : 'course’s Tasks sheet'}
            <input className="field" inputMode="url" placeholder="https://docs.google.com/spreadsheets/d/…/edit#gid=0" value={url} onChange={e => setUrl(e.target.value)} />
          </label>
          <p className="v2-help">The sheet must be shared as “Anyone with the link can view”. Open the right tab first, then copy the link — it remembers the tab.</p>
        </>
      ) : (
        <label className={`v2-file-pick${csv ? ' has-file' : ''}`}>
          <Upload size={18} />
          <strong>{csv ? csv.name : 'Choose a CSV file'}</strong>
          <small>{csv ? 'Ready — press Preview' : 'In Google Sheets: File → Download → Comma-separated values (.csv)'}</small>
          <input type="file" accept=".csv,text/csv" onChange={async e => { const f = e.target.files?.[0]; if (f) setCsv({ name: f.name, text: await f.text() }); }} />
        </label>
      )}
      <div className="v2-row-end">
        <button type="button" className="btn btn-primary" disabled={!ready || busy} onClick={() => onPreview(mode === 'link' ? { sheetUrl: url.trim() } : { csvText: csv?.text ?? '' })}>
          {busy ? <><Loader2 className="v2-spin" size={15} /> Reading…</> : 'Preview'}
        </button>
      </div>
    </div>
  );
}

export function MasterImportDialog({ onClose, onApplied }: { onClose: () => void; onApplied: () => void }) {
  const [preview, setPreview] = useState<MasterImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [showSame, setShowSame] = useState(false);

  const load = async (src: { sheetUrl?: string; csvText?: string }) => {
    setBusy(true); setError(null);
    try {
      const res = await apiFetch<MasterImportPreview>('/v2/master/preview', { method: 'POST', body: src });
      setPreview(res);
      setPicked(new Set(res.rows.filter(r => r.action === 'create' || r.action === 'update').map(r => r.courseCode)));
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  };

  const apply = async () => {
    if (!preview) return;
    const rows = preview.rows.filter(r => picked.has(r.courseCode));
    setBusy(true); setError(null);
    try {
      const res = await apiFetch<{ created: number; updated: number }>('/v2/master/apply', { method: 'POST', body: { rows } });
      toast(`${plural(res.created ?? 0, 'course')} created as Draft · ${res.updated ?? 0} updated.`);
      onApplied();
      onClose();
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  };

  const counts = useMemo(() => {
    const c: Record<ImportAction, number> = { create: 0, update: 0, same: 0, error: 0 };
    preview?.rows.forEach(r => { c[r.action] += 1; });
    return c;
  }, [preview]);
  const rows = (preview?.rows ?? []).filter(r => showSame || r.action !== 'same');
  const toggle = (code: string) => setPicked(s => { const n = new Set(s); if (n.has(code)) n.delete(code); else n.add(code); return n; });

  return (
    <Dialog
      wide
      eyebrow="Master Course List"
      title={preview ? 'Check the changes' : 'Import the master list'}
      onClose={onClose}
      footer={preview ? <>
        <button type="button" className="btn btn-outline" onClick={() => setPreview(null)}>Back</button>
        <button type="button" className="btn btn-primary" disabled={!picked.size || busy} onClick={() => void apply()}>{busy ? 'Applying…' : `Apply ${plural(picked.size, 'course')}`}</button>
      </> : undefined}
    >
      {error && <div className="v2-error"><AlertTriangle size={16} /><span>{error}</span></div>}
      {!preview && <SourcePicker kind="master" busy={busy} onPreview={src => void load(src)} />}
      {preview && (
        <>
          <p className="v2-help">From <b>{preview.sourceLabel}</b>. New courses arrive as <b>Draft</b> — students see nothing until you publish. Published courses keep their status.</p>
          <div className="v2-ingest-summary">
            <span className="chip chip-green">{counts.create} new</span>
            <span className="chip chip-blue">{counts.update} with changes</span>
            <span className="chip">{counts.same} unchanged</span>
            {counts.error > 0 && <span className="chip chip-red">{counts.error} with problems</span>}
            <label className="v2-inline-switch"><Switch checked={showSame} onChange={setShowSame} label="Show unchanged courses" /> Show unchanged</label>
          </div>
          <ul className="v2-import-list">
            {rows.map(r => <MasterRow key={r.courseCode + r.action} row={r} checked={picked.has(r.courseCode)} onToggle={() => toggle(r.courseCode)} />)}
            {!rows.length && <li className="v2-import-empty">Everything already matches the sheet. Nothing to apply.</li>}
          </ul>
        </>
      )}
    </Dialog>
  );
}

function MasterRow({ row, checked, onToggle }: { row: MasterImportRow; checked: boolean; onToggle: () => void }) {
  const chip = ACTION_CHIP[row.action];
  const selectable = row.action === 'create' || row.action === 'update';
  return (
    <li className={`v2-import-row${checked ? '' : ' is-off'}`}>
      <label className="v2-check"><input type="checkbox" checked={checked} disabled={!selectable} onChange={onToggle} aria-label={`Include ${row.courseCode}`} /></label>
      <div>
        <div className="v2-import-title">
          <span className="v2-code-tag">{row.courseCode || '—'}</span>
          <strong>{row.fields.title}</strong>
          {row.fields.titleAr && <span className="v2-ar" dir="rtl">{row.fields.titleAr}</span>}
        </div>
        <div className="v2-import-meta">{[row.fields.penType ? `${row.fields.penType.charAt(0).toUpperCase()}${row.fields.penType.slice(1)} pen` : null, row.fields.courseType ? row.fields.courseType.charAt(0).toUpperCase() + row.fields.courseType.slice(1) : null, row.fields.branches?.length ? row.fields.branches.join(', ') : null].filter(Boolean).join(' · ')}</div>
        {row.changes.length > 0 && <ul className="v2-changes">{row.changes.map((c, i) => <li key={i}>{c}</li>)}</ul>}
        {row.message && <p className={row.action === 'error' ? 'v2-bad' : 'v2-help'}>{row.message}</p>}
      </div>
      <span className={chip.cls}>{chip.label}</span>
    </li>
  );
}

export function ManifestImportDialog({ courseId, courseCode, onClose, onApplied }: { courseId: string; courseCode: string | null; onClose: () => void; onApplied: () => void }) {
  const [preview, setPreview] = useState<ManifestImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createMissing, setCreateMissing] = useState(false);

  const load = async (src: { sheetUrl?: string; csvText?: string }) => {
    setBusy(true); setError(null);
    try { setPreview(await apiFetch<ManifestImportPreview>(`/v2/courses/${courseId}/manifest/preview`, { method: 'POST', body: src })); }
    catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  };
  const apply = async () => {
    if (!preview) return;
    setBusy(true); setError(null);
    try {
      const rows = preview.rows.filter(r => r.action === 'update' || (createMissing && r.action === 'create'));
      await apiFetch(`/v2/courses/${courseId}/manifest/apply`, { method: 'POST', body: { rows, createMissing } });
      toast('Task names and details updated.');
      onApplied();
      onClose();
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  };
  const creates = preview?.rows.filter(r => r.action === 'create').length ?? 0;
  const updates = preview?.rows.filter(r => r.action === 'update').length ?? 0;
  const applyCount = updates + (createMissing ? creates : 0);

  return (
    <Dialog
      wide
      eyebrow={courseCode ? `${courseCode} · Tasks sheet` : 'Tasks sheet'}
      title={preview ? 'Check the task details' : 'Bring task names from the sheet'}
      onClose={onClose}
      footer={preview ? <>
        <button type="button" className="btn btn-outline" onClick={() => setPreview(null)}>Back</button>
        <button type="button" className="btn btn-primary" disabled={!applyCount || busy} onClick={() => void apply()}>{busy ? 'Applying…' : `Apply ${plural(applyCount, 'row')}`}</button>
      </> : undefined}
    >
      {error && <div className="v2-error"><AlertTriangle size={16} /><span>{error}</span></div>}
      {!preview && <>
        <p className="v2-help">Optional. Files already build the levels and steps; the Tasks sheet only fills in task names, descriptions, types, marks and badges.</p>
        <SourcePicker kind="tasks" busy={busy} onPreview={src => void load(src)} />
      </>}
      {preview && <>
        <div className="v2-ingest-summary">
          <span className="chip chip-blue">{updates} to update</span>
          <span className="chip">{creates} not uploaded yet</span>
          <label className="v2-inline-switch"><Switch checked={createMissing} onChange={setCreateMissing} label="Also create steps that have no files yet" /> Also create steps without files</label>
        </div>
        <div className="v2-table-wrap">
          <table className="v2-table">
            <thead><tr><th>Level</th><th>Step</th><th>Task</th><th>Type</th><th>Marks</th><th /></tr></thead>
            <tbody>
              {preview.rows.map((r, i) => (
                <tr key={i} className={r.action === 'create' && !createMissing ? 'is-off' : ''}>
                  <td><b>{r.level}</b>{r.description && <div className="v2-ar" dir="auto">{r.description}</div>}</td>
                  <td>{r.step}</td>
                  <td>{r.task}{r.message && <div className="v2-help">{r.message}</div>}</td>
                  <td>{r.stepType}</td>
                  <td>{r.maxMarks ?? '—'}</td>
                  <td><span className={ACTION_CHIP[r.action].cls}>{r.action === 'create' ? 'No files yet' : ACTION_CHIP[r.action].label}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>}
    </Dialog>
  );
}
