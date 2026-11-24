import { useMemo, useRef, useState } from 'react';
import JSZip from 'jszip';
import {
  AlertTriangle, Check, CheckCircle2, CloudUpload, FileArchive, FolderOpen, FolderInput, HardDrive, Loader2, Plus, RotateCcw, Upload, X,
} from 'lucide-react';
import { apiFetch, uploadFile, API_BASE_URL } from '@/api';
import type { FileCodeDef, IngestCommitItem, IngestCommitResult, IngestPlanItem } from '../contracts';
import { DEFAULT_FILE_CODES, isJunkFile, parseFileName, sizeLabel, type ParseResult } from './naming';
import { CopyButton, Dialog, errorText, plural, toast } from './shared';

type RowState = 'waiting' | 'uploading' | 'uploaded' | 'saved' | 'failed' | 'skipped';
type Row = {
  key: string;
  file: File;
  path: string;
  source: IngestCommitItem['source'];
  local: ParseResult;
  plan: IngestPlanItem | null;
  include: boolean;
  state: RowState;
  storageKey?: string;
  note?: string;
};
type Phase = 'idle' | 'reading' | 'review' | 'uploading' | 'finished';

const ACTION_WORDS: Record<IngestPlanItem['action'], { label: string; tone: 'green' | 'blue' | 'gold' | 'amber' | 'red' }> = {
  new_level: { label: 'New level', tone: 'green' },
  new_step: { label: 'New step', tone: 'green' },
  add_file: { label: 'Adds file', tone: 'blue' },
  new_version: { label: 'Newer version', tone: 'gold' },
  same_file: { label: 'Already there', tone: 'amber' },
  unknown_course: { label: 'Course not found', tone: 'red' },
  error: { label: 'Name not understood', tone: 'red' },
};
const SKIP_ACTIONS: IngestPlanItem['action'][] = ['same_file', 'unknown_course', 'error'];

const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf',
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/mp4', webm: 'video/webm', svg: 'image/svg+xml',
};
const mimeFor = (name: string, fallback = '') => fallback || MIME[name.split('.').pop()?.toLowerCase() ?? ''] || 'application/octet-stream';

/* ---------- reading drops: files, folders and ZIPs ---------- */

type Picked = { file: File; path: string; source: IngestCommitItem['source'] };

async function readEntry(entry: FileSystemEntry, out: Picked[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    out.push({ file, path: entry.fullPath.replace(/^\//, ''), source: 'upload' });
    return;
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries returns batches; keep reading until empty
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) break;
      for (const child of batch) await readEntry(child, out);
    }
  }
}

async function expandZips(picked: Picked[]): Promise<Picked[]> {
  const out: Picked[] = [];
  for (const p of picked) {
    if (!/\.zip$/i.test(p.file.name)) { out.push(p); continue; }
    const zip = await JSZip.loadAsync(p.file);
    const entries = Object.values(zip.files).filter(f => !f.dir);
    for (const entry of entries) {
      if (isJunkFile(entry.name)) continue;
      const base = entry.name.split('/').pop() ?? entry.name;
      const blob = await entry.async('blob');
      out.push({ file: new File([blob], base, { type: mimeFor(base) }), path: `${p.file.name}/${entry.name}`, source: 'zip' });
    }
  }
  return out.filter(p => !isJunkFile(p.path));
}

/* ---------- component ---------- */

export type IngestScope = { courseCode?: string | null; levelCode?: string | null };

export function IngestPanel({
  scope = {}, fileCodes, onDone, variant = 'course', disabled, emptyHint,
}: {
  scope?: IngestScope;
  fileCodes: FileCodeDef[] | null;
  onDone: () => void;
  variant?: 'course' | 'level' | 'global';
  disabled?: boolean;
  emptyHint?: string;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [rows, setRows] = useState<Row[]>([]);
  const [dragging, setDragging] = useState(false);
  const [planWarning, setPlanWarning] = useState<string | null>(null);
  const [results, setResults] = useState<IngestCommitResult[]>([]);
  const [showDrive, setShowDrive] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const codeMap = useMemo(() => {
    const map: Record<string, { stepType: string | null; label: string }> = {};
    for (const [k, v] of Object.entries(DEFAULT_FILE_CODES)) map[k] = { stepType: v.stepType, label: v.label };
    for (const fc of fileCodes ?? []) map[fc.fileCode.toUpperCase()] = { stepType: fc.stepType || null, label: fc.label };
    return map;
  }, [fileCodes]);

  const reset = () => { setRows([]); setPhase('idle'); setResults([]); setPlanWarning(null); setShowAll(false); };

  const accept = async (picked: Picked[]) => {
    if (disabled) return;
    setPhase('reading');
    setPlanWarning(null);
    try {
      const files = await expandZips(picked.filter(p => !isJunkFile(p.path)));
      if (!files.length) { toast('No files found in what you dropped.', { tone: 'error' }); setPhase('idle'); return; }
      const fresh: Row[] = files.map((p, i) => {
        const local = parseFileName(p.file.name);
        return { key: `${Date.now()}-${i}-${p.file.name}`, file: p.file, path: p.path, source: p.source, local, plan: null, include: local.ok, state: 'waiting' };
      });
      setRows(fresh);
      setPhase('review');
      try {
        const plan = await apiFetch<IngestPlanItem[]>('/v2/ingest/plan', { method: 'POST', body: { filenames: fresh.map(r => r.file.name) } });
        setRows(current => current.map((r, i) => {
          const item = plan[i] && plan[i].filename === r.file.name ? plan[i] : plan.find(p => p.filename === r.file.name) ?? null;
          if (!item) return r;
          return { ...r, plan: item, include: item.ok && !SKIP_ACTIONS.includes(item.action) };
        }));
      } catch (err) {
        setPlanWarning(`Could not check these names with the server (${errorText(err)}). The preview below comes from the names only.`);
      }
    } catch (err) {
      toast(`Could not read the files: ${errorText(err)}`, { tone: 'error' });
      setPhase('idle');
    }
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    if (disabled) return;
    const items = Array.from(e.dataTransfer.items ?? []);
    const entries = items.map(i => (typeof i.webkitGetAsEntry === 'function' ? i.webkitGetAsEntry() : null)).filter(Boolean) as FileSystemEntry[];
    if (entries.length) {
      const out: Picked[] = [];
      setPhase('reading');
      for (const entry of entries) await readEntry(entry, out);
      await accept(out);
    } else {
      await accept(Array.from(e.dataTransfer.files ?? []).map(file => ({ file, path: file.name, source: 'upload' as const })));
    }
  };

  const onPick = (list: FileList | null) => {
    if (!list?.length) return;
    void accept(Array.from(list).map(file => ({ file, path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name, source: 'upload' as const })));
  };

  const toUpload = rows.filter(r => r.include);
  const counts = useMemo(() => {
    const c: Partial<Record<IngestPlanItem['action'] | 'local_ok' | 'local_bad', number>> = {};
    for (const r of rows) {
      const k = r.plan ? r.plan.action : r.local.ok ? 'local_ok' : 'local_bad';
      c[k] = (c[k] ?? 0) + 1;
    }
    return c;
  }, [rows]);

  const newLevels = useMemo(() => new Set(rows.filter(r => r.plan?.action === 'new_level' && r.include).map(r => `${r.plan?.parsed?.courseCode}:${r.plan?.parsed?.level}`)).size, [rows]);
  const newSteps = useMemo(() => new Set(rows.filter(r => (r.plan?.action === 'new_step' || r.plan?.action === 'new_level') && r.include).map(r => `${r.plan?.parsed?.courseCode}:${r.plan?.parsed?.level}:${r.plan?.parsed?.step}`)).size, [rows]);

  const runUpload = async () => {
    const queue = rows.filter(r => r.include);
    if (!queue.length) return;
    setPhase('uploading');
    const uploaded: { key: string; item: IngestCommitItem }[] = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < queue.length) {
        const row = queue[cursor++];
        setRows(list => list.map(r => (r.key === row.key ? { ...r, state: 'uploading' } : r)));
        try {
          const { storageKey } = await uploadFile('course-files', row.file);
          uploaded.push({ key: row.key, item: { filename: row.file.name, storageKey, contentType: mimeFor(row.file.name, row.file.type), byteSize: row.file.size, source: row.source } });
          setRows(list => list.map(r => (r.key === row.key ? { ...r, state: 'uploaded', storageKey } : r)));
        } catch (err) {
          setRows(list => list.map(r => (r.key === row.key ? { ...r, state: 'failed', note: errorText(err, 'Upload failed') } : r)));
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    setRows(list => list.map(r => (r.include ? r : { ...r, state: 'skipped' })));
    if (!uploaded.length) { setPhase('finished'); setResults([]); return; }
    try {
      const res = await apiFetch<IngestCommitResult[]>('/v2/ingest/commit', { method: 'POST', body: { items: uploaded.map(u => u.item) } });
      setResults(res);
      setRows(list => list.map(r => {
        const u = uploaded.find(x => x.key === r.key);
        if (!u) return r;
        const result = res.find(x => x.filename === r.file.name);
        if (!result) return { ...r, state: 'saved' };
        return { ...r, state: result.ok ? 'saved' : 'failed', note: result.message };
      }));
      const ok = res.filter(r => r.ok).length;
      toast(`${plural(ok, 'file')} added to the course.`);
      onDone();
    } catch (err) {
      setRows(list => list.map(r => (uploaded.some(u => u.key === r.key) ? { ...r, state: 'failed', note: `Uploaded, but not saved: ${errorText(err)}` } : r)));
    }
    setPhase('finished');
  };

  const retryFailed = () => {
    setRows(list => list.map(r => (r.state === 'failed' ? { ...r, state: 'waiting', include: true } : { ...r, include: false })));
    setPhase('review');
  };

  const title = variant === 'level' ? `Drop files for ${scope.levelCode ?? 'this level'}` : 'Drop files, folders or a ZIP';
  const hint = emptyHint ?? (variant === 'level'
    ? 'Names decide where each file goes. New steps are created by themselves.'
    : 'Names like FNK-C101_MT_LV01_S01_P01_07_v1.jpg create levels and steps by themselves. No limit on how many.');

  const inputs = (
    <>
      <input ref={filesInput} type="file" multiple hidden onChange={e => { onPick(e.target.files); e.target.value = ''; }} />
      <input
        ref={folderInput}
        type="file"
        multiple
        hidden
        {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
        onChange={e => { onPick(e.target.files); e.target.value = ''; }}
      />
    </>
  );

  if (phase === 'idle' || phase === 'reading') {
    return (
      <div
        className={`v2-drop v2-drop-${variant}${dragging ? ' is-over' : ''}${disabled ? ' is-disabled' : ''}`}
        onDragEnter={e => { e.preventDefault(); if (!disabled) setDragging(true); }}
        onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
        onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
        onDrop={onDrop}
      >
        {inputs}
        <div className="v2-drop-icon" aria-hidden="true">{phase === 'reading' ? <Loader2 className="v2-spin" size={22} /> : <CloudUpload size={variant === 'level' ? 20 : 26} />}</div>
        <div className="v2-drop-copy">
          <strong>{phase === 'reading' ? 'Reading your files…' : dragging ? 'Let go to add these files' : title}</strong>
          <span>{hint}</span>
        </div>
        <div className="v2-drop-actions">
          <button type="button" className="btn btn-primary v2-btn-sm" disabled={disabled || phase === 'reading'} onClick={() => filesInput.current?.click()}><Upload size={14} /> Choose files</button>
          <button type="button" className="btn btn-outline v2-btn-sm" disabled={disabled || phase === 'reading'} onClick={() => folderInput.current?.click()}><FolderOpen size={14} /> Folder</button>
          {variant !== 'level' && <button type="button" className="btn btn-outline v2-btn-sm" disabled={disabled} onClick={() => setShowDrive(true)}><HardDrive size={14} /> From Drive</button>}
        </div>
        {showDrive && <DriveDialog courseCode={scope.courseCode ?? null} onClose={() => setShowDrive(false)} onDone={onDone} />}
      </div>
    );
  }

  const isProblem = (r: Row) => (!r.local.ok && !r.plan) || (r.plan ? !r.plan.ok : false);
  const ordered = phase === 'review' ? [...rows].sort((a, b) => Number(isProblem(b)) - Number(isProblem(a))) : rows;
  const visible = showAll ? ordered : ordered.slice(0, 60);
  const failed = rows.filter(r => r.state === 'failed').length;
  const doneCount = rows.filter(r => r.state === 'saved').length;
  const progress = phase === 'uploading' ? Math.round((rows.filter(r => r.include && ['uploaded', 'saved', 'failed'].includes(r.state)).length / Math.max(1, toUpload.length)) * 100) : 0;

  return (
    <section className={`v2-ingest v2-ingest-${variant}`} aria-label="Files to add">
      {inputs}
      <div className="v2-ingest-head">
        <div>
          <p className="eyebrow">{phase === 'finished' ? 'Finished' : phase === 'uploading' ? 'Uploading' : 'Check before adding'}</p>
          <h3>
            {phase === 'finished'
              ? `${plural(doneCount, 'file')} added${failed ? ` · ${failed} need attention` : ''}`
              : `${plural(rows.length, 'file')} ready`}
          </h3>
        </div>
        {phase !== 'uploading' && <button type="button" className="v2-icon-btn" aria-label="Close" onClick={reset}><X size={18} /></button>}
      </div>

      {phase === 'review' && (
        <div className="v2-ingest-summary">
          {newLevels > 0 && <span className="chip chip-green"><Plus size={12} /> {plural(newLevels, 'new level')}</span>}
          {newSteps > 0 && <span className="chip chip-green"><Plus size={12} /> {plural(newSteps, 'new step')}</span>}
          {(counts.add_file ?? 0) > 0 && <span className="chip chip-blue">{plural(counts.add_file ?? 0, 'file')} into existing steps</span>}
          {(counts.new_version ?? 0) > 0 && <span className="chip chip-gold">{plural(counts.new_version ?? 0, 'newer version')}</span>}
          {(counts.same_file ?? 0) > 0 && <span className="chip chip-amber">{counts.same_file} already there — skipped</span>}
          {((counts.error ?? 0) + (counts.local_bad ?? 0)) > 0 && <span className="chip chip-red">{plural((counts.error ?? 0) + (counts.local_bad ?? 0), 'name')} to fix</span>}
          {(counts.unknown_course ?? 0) > 0 && <span className="chip chip-red">{counts.unknown_course} for a course that doesn’t exist</span>}
        </div>
      )}
      {phase === 'review' && ((counts.error ?? 0) + (counts.local_bad ?? 0)) > 0 && (
        <div className="v2-note-amber"><AlertTriangle size={15} /><span>
          <strong>Files marked “Name not understood” will not be added.</strong> This box only takes files named like {scope.courseCode ?? 'FNK-C101'}_MT_LV01_S01_P01_07_v1.jpg.
          To add a file with any name, close this box, open the level (or “Add level by hand”), add a step, and use that step’s <strong>Upload</strong> or <strong>Add reference image</strong> button.
        </span></div>
      )}
      {planWarning && <div className="v2-note-amber"><AlertTriangle size={15} /><span>{planWarning}</span></div>}
      {phase === 'uploading' && (
        <div className="v2-progress" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label="Upload progress">
          <i style={{ width: `${progress}%` }} />
        </div>
      )}

      <ul className="v2-ingest-list">
        {visible.map(r => (
          <IngestRowView
            key={r.key}
            row={r}
            scope={scope}
            codeMap={codeMap}
            phase={phase}
            onToggle={() => setRows(list => list.map(x => (x.key === r.key ? { ...x, include: !x.include } : x)))}
          />
        ))}
      </ul>
      {rows.length > visible.length && <button type="button" className="v2-link v2-more" onClick={() => setShowAll(true)}>Show all {rows.length} files</button>}

      {results.length > 0 && phase === 'finished' && results.some(r => !r.ok) && (
        <p className="muted">Files that could not be saved stay listed above with the reason.</p>
      )}

      <div className="v2-ingest-foot">
        {phase === 'review' && <>
          <button type="button" className="btn btn-outline v2-btn-sm" onClick={reset}>Cancel</button>
          <button type="button" className="btn btn-outline v2-btn-sm" onClick={() => filesInput.current?.click()}><Plus size={14} /> Add more</button>
          <button type="button" className="btn btn-primary" disabled={!toUpload.length} onClick={() => void runUpload()}>
            <Upload size={15} /> {toUpload.length ? `Add ${plural(toUpload.length, 'file')}` : 'Nothing to add'}
          </button>
        </>}
        {phase === 'uploading' && <span className="muted"><Loader2 className="v2-spin" size={14} /> Uploading {toUpload.length} files — you can keep this page open and wait.</span>}
        {phase === 'finished' && <>
          {failed > 0 && <button type="button" className="btn btn-outline v2-btn-sm" onClick={retryFailed}><RotateCcw size={14} /> Try the {failed} again</button>}
          <button type="button" className="btn btn-primary" onClick={reset}><Check size={15} /> Done</button>
        </>}
      </div>
    </section>
  );
}

function IngestRowView({ row, scope, codeMap, phase, onToggle }: {
  row: Row; scope: IngestScope; codeMap: Record<string, { stepType: string | null; label: string }>; phase: Phase; onToggle: () => void;
}) {
  const parsed = row.plan?.parsed ?? (row.local.ok ? row.local.parsed : null);
  const action = row.plan?.action ?? (row.local.ok ? null : 'error');
  const words = action ? ACTION_WORDS[action] : null;
  const problem = !row.local.ok && !row.plan ? row.local.error : row.plan && !row.plan.ok ? row.plan.message : null;
  const typeLabel = parsed ? codeMap[parsed.fileCode]?.label ?? parsed.fileCode : null;
  const where = parsed ? [parsed.level ?? 'Steps', parsed.step, parsed.sizeCode ? sizeLabel(parsed.sizeCode) : null, parsed.page !== 'P01' ? `page ${parsed.page.slice(1)}` : null, parsed.version > 1 ? `v${parsed.version}` : null].filter(Boolean).join(' · ') : null;
  const otherCourse = parsed && scope.courseCode && parsed.courseCode !== scope.courseCode.toUpperCase();
  const otherLevel = parsed && scope.levelCode && parsed.level && parsed.level !== scope.levelCode;
  const editable = phase === 'review';
  const stateIcon = row.state === 'uploading' ? <Loader2 className="v2-spin" size={15} />
    : row.state === 'saved' ? <CheckCircle2 size={15} className="v2-ok" />
      : row.state === 'uploaded' ? <Check size={15} className="v2-ok" />
        : row.state === 'failed' ? <AlertTriangle size={15} className="v2-bad" /> : null;

  return (
    <li className={`v2-ingest-row${row.include ? '' : ' is-off'}${problem ? ' has-problem' : ''}`}>
      <label className="v2-check">
        <input type="checkbox" checked={row.include} disabled={!editable || Boolean(problem)} onChange={onToggle} aria-label={`Include ${row.file.name}`} />
      </label>
      <div className="v2-ingest-main">
        <span className="v2-filename" title={row.path}>
          {row.source === 'zip' && <FileArchive size={13} aria-label="From ZIP" />}
          {row.path.includes('/') && row.source !== 'zip' && <FolderInput size={13} aria-label="From folder" />}
          {row.file.name}
        </span>
        <span className="v2-ingest-where">
          {problem ? <span className="v2-bad">{problem}</span> : <>
            {parsed && <b>{parsed.courseCode}</b>}{where && <> · {where}</>}{typeLabel && <> · {typeLabel}</>}
            {otherCourse && <em className="v2-warn"> — goes to {parsed?.courseCode}, not this course</em>}
            {!otherCourse && otherLevel && <em className="v2-warn"> — goes to {parsed?.level}</em>}
            {row.plan?.message && row.plan.ok && <span className="v2-ingest-msg"> — {row.plan.message}</span>}
          </>}
          {row.note && <span className={row.state === 'failed' ? 'v2-bad' : 'v2-ingest-msg'}> {row.note}</span>}
        </span>
      </div>
      <div className="v2-ingest-state">
        {stateIcon}
        {phase === 'review' && words && <span className={`chip chip-${words.tone}`}>{words.label}</span>}
        {phase === 'review' && !words && row.local.ok && <span className="chip chip-blue">Checking…</span>}
        {phase !== 'review' && <span className="v2-state-word">{row.state === 'waiting' ? 'Waiting' : row.state === 'uploading' ? 'Uploading' : row.state === 'uploaded' ? 'Uploaded' : row.state === 'saved' ? 'Added' : row.state === 'failed' ? 'Not added' : 'Skipped'}</span>}
      </div>
    </li>
  );
}

/* ---------- Google Drive import + upload-portal note ---------- */

function DriveDialog({ courseCode, onClose, onDone }: { courseCode: string | null; onClose: () => void; onDone: () => void }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<IngestCommitResult[] | null>(null);
  const webhookUrl = `${API_BASE_URL}/v2/ingest/webhook`;
  const note = `Upload portal → Tehseen al-Khat (automatic)
Web address: ${webhookUrl}
Method: POST, JSON body {"driveFileId": "...", "fileName": "...", "mimeType": "..."}
Header: X-Ingest-Secret: <the INGEST_WEBHOOK_SECRET from the server settings>
The full Apps Script is in khat-backend/V2_DRIVE_WEBHOOK.md.`;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<IngestCommitResult[]>('/v2/ingest/drive', { method: 'POST', body: { folderUrl: url.trim(), ...(courseCode ? { courseCode } : {}) } });
      setResults(res);
      if (res.some(r => r.ok)) onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const ok = results?.filter(r => r.ok).length ?? 0;
  return (
    <Dialog
      title="Bring files from Google Drive"
      eyebrow={courseCode ? `Course ${courseCode}` : 'Any course'}
      onClose={onClose}
      footer={results ? <button type="button" className="btn btn-primary" onClick={onClose}>Done</button> : <>
        <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={!(/^https?:\/\//.test(url.trim()) || (courseCode && !url.trim())) || busy} onClick={() => void run()}>{busy ? <><Loader2 className="v2-spin" size={15} /> Reading the folder…</> : 'Bring the files'}</button>
      </>}
    >
      {!results && <>
        <label className="field-label">Drive folder link
          <input className="field" inputMode="url" placeholder="https://drive.google.com/drive/folders/…" value={url} onChange={e => setUrl(e.target.value)} />
        </label>
        {courseCode && <p className="v2-help">Leave this empty to use the course’s saved Drive folder (the “Drive folder” column of the master sheet). Press it again any time to bring new files.</p>}
        <p className="v2-help">Share the folder as “Anyone with the link can view”. Sub-folders are read too. Only new or newer files are added — files already here are skipped.</p>
        {error && <div className="v2-error"><AlertTriangle size={16} /><span>{error}</span></div>}
      </>}
      {results && (
        <>
          <p className="v2-dialog-text"><strong>{plural(ok, 'file')} added.</strong> {results.length - ok > 0 && `${results.length - ok} skipped or need attention.`}</p>
          <ul className="v2-mini-list">
            {results.slice(0, 80).map(r => (
              <li key={r.filename}><span className="v2-filename">{r.filename}</span><span className={r.ok ? 'chip chip-green' : 'chip chip-amber'}>{r.ok ? ACTION_WORDS[r.action]?.label ?? 'Added' : 'Skipped'}</span><small>{r.message}</small></li>
            ))}
          </ul>
        </>
      )}
      <details className="v2-details">
        <summary>Make the upload portal add files automatically</summary>
        <p className="v2-help">Your Google Drive upload portal can send every new file here by itself, so nothing has to be dropped by hand. Give this note to whoever looks after the portal script:</p>
        <pre className="v2-code">{note}</pre>
        <CopyButton text={note} label="Copy note" />
      </details>
    </Dialog>
  );
}
