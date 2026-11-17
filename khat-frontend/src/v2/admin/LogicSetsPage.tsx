import { useEffect, useMemo, useState } from 'react';
import {
  Award, BookOpenCheck, Download, FileCode2, GitBranch, Lock, MessageSquare, PenLine, Plus, Shapes, Trash2, Upload, X,
} from 'lucide-react';
import { apiFetch } from '@/api';
import type { CourseTypeDef, FeedbackMode, FileCodeDef, FileRole, StepTypeDef, StudentAction } from '../contracts';
import {
  ConfirmDialog, EmptyState, ErrorBox, Loading, PageHead, ReadOnlyBanner, Segmented, Switch, ToastHost, errorText, loadScope, slugKey, toast,
} from './shared';
import { DEFAULT_FILE_CODES } from './naming';

type Props = Record<string, never>;
type Tab = 'steps' | 'courses' | 'codes';

const ACTIONS: { value: StudentAction; label: string; icon: JSX.Element; text: string }[] = [
  { value: 'watch_download', label: 'Watch & download', icon: <Download size={16} />, text: 'Watches the video, downloads the sheet, practices, ticks “done”.' },
  { value: 'upload', label: 'Upload', icon: <Upload size={16} />, text: 'Writes on their own paper and uploads a photo.' },
  { value: 'download_upload', label: 'Download, then upload', icon: <PenLine size={16} />, text: 'Downloads a sheet, writes on it, uploads it back.' },
];
const FEEDBACK: { value: FeedbackMode; label: string; text: string }[] = [
  { value: 'none', label: 'No check', text: 'No teacher needed.' },
  { value: 'feedback', label: 'Comments', text: 'Teacher draws, pins voice notes and comments — no mark.' },
  { value: 'annotate_mark', label: 'Comments + mark', text: 'Teacher draws, comments and gives a mark 1–10.' },
];
const ROLES: { value: FileRole; label: string }[] = [
  { value: 'worksheet', label: 'Worksheet' }, { value: 'assessment_sheet', label: 'Assessment sheet' }, { value: 'video', label: 'Video' },
  { value: 'reference', label: 'Reference' }, { value: 'resource', label: 'Resource' }, { value: 'other', label: 'Other' },
];

function stepStory(t: StepTypeDef): string[] {
  const lines: string[] = [];
  const a = ACTIONS.find(x => x.value === t.studentAction);
  lines.push(a?.text ?? '');
  if (t.requiresPriorUploads) lines.push('Also uploads the worksheets of the earlier steps of the level, together.');
  if (t.feedbackMode === 'none') lines.push('No teacher check — the step counts as done when the student ticks it.');
  if (t.feedbackMode === 'feedback') lines.push('A teacher replies in the step’s chat: drawings on the photo, voice notes, comments. No mark.');
  if (t.feedbackMode === 'annotate_mark') lines.push(`A teacher marks it${t.hasMarks ? ' from 1 to 10' : ''}. Low marks ask for another try.`);
  if (t.gatesProgress) lines.push('The next level stays locked until this step is passed.');
  if (t.awardsBadge) lines.push('Passing it gives the level badge.');
  return lines.filter(Boolean);
}

export function V2LogicSetsPage(_props: Props) {
  const [tab, setTab] = useState<Tab>('steps');
  const [isMaster, setIsMaster] = useState(false);
  const [stepTypes, setStepTypes] = useState<StepTypeDef[] | null>(null);
  const [courseTypes, setCourseTypes] = useState<CourseTypeDef[] | null>(null);
  const [fileCodes, setFileCodes] = useState<FileCodeDef[] | null>(null);
  const [saved, setSaved] = useState<{ s: StepTypeDef[]; c: CourseTypeDef[]; f: FileCodeDef[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setError(null);
    try {
      const [scope, s, c, f] = await Promise.all([
        loadScope(),
        apiFetch<StepTypeDef[]>('/v2/step-types'),
        apiFetch<CourseTypeDef[]>('/v2/course-types'),
        apiFetch<FileCodeDef[]>('/v2/file-codes'),
      ]);
      const sortedS = [...s].sort((a, b) => a.sortOrder - b.sortOrder);
      const sortedC = [...c].sort((a, b) => a.sortOrder - b.sortOrder);
      setIsMaster(scope.scope.isMaster);
      setStepTypes(sortedS); setCourseTypes(sortedC); setFileCodes(f);
      setSaved({ s: sortedS, c: sortedC, f });
    } catch (err) { setError(errorText(err, 'Could not load the logic sets.')); }
  };
  useEffect(() => { void load(); }, []);

  const dirty = {
    steps: saved && stepTypes ? JSON.stringify(saved.s) !== JSON.stringify(stepTypes) : false,
    courses: saved && courseTypes ? JSON.stringify(saved.c) !== JSON.stringify(courseTypes) : false,
    codes: saved && fileCodes ? JSON.stringify(saved.f) !== JSON.stringify(fileCodes) : false,
  };
  const anyDirty = dirty.steps || dirty.courses || dirty.codes;

  const save = async () => {
    if (!stepTypes || !courseTypes || !fileCodes) return;
    setBusy(true);
    try {
      if (dirty.steps) await apiFetch('/v2/step-types', { method: 'PUT', body: stepTypes });
      if (dirty.courses) await apiFetch('/v2/course-types', { method: 'PUT', body: courseTypes });
      if (dirty.codes) await apiFetch('/v2/file-codes', { method: 'PUT', body: fileCodes });
      setSaved({ s: stepTypes, c: courseTypes, f: fileCodes });
      toast('Logic sets saved. Students see the change straight away.');
    } catch (err) { toast(errorText(err), { tone: 'error' }); } finally { setBusy(false); }
  };
  const discard = () => { if (saved) { setStepTypes(saved.s); setCourseTypes(saved.c); setFileCodes(saved.f); } };

  return (
    <div className="page portal-page v2-admin">
      <PageHead
        eyebrow="Curriculum control"
        title="Logic sets"
        text="How each kind of step behaves for students and teachers. A course type decides which step types appear in the builder’s drop-down."
      />
      {!isMaster && stepTypes && <ReadOnlyBanner>Set by the Nairobi team. You can read how each step works.</ReadOnlyBanner>}
      {error && <ErrorBox message={error} onRetry={() => void load()} />}
      {!error && !stepTypes && <Loading label="Loading logic sets…" />}
      {stepTypes && courseTypes && fileCodes && (
        <>
          <div className="v2-tabs" role="tablist" aria-label="Logic sets">
            <button type="button" role="tab" aria-selected={tab === 'steps'} className={tab === 'steps' ? 'active' : ''} onClick={() => setTab('steps')}><Shapes size={15} /> Step types{dirty.steps && <i className="v2-dot" aria-label="unsaved" />}</button>
            <button type="button" role="tab" aria-selected={tab === 'courses'} className={tab === 'courses' ? 'active' : ''} onClick={() => setTab('courses')}><BookOpenCheck size={15} /> Course types{dirty.courses && <i className="v2-dot" aria-label="unsaved" />}</button>
            <button type="button" role="tab" aria-selected={tab === 'codes'} className={tab === 'codes' ? 'active' : ''} onClick={() => setTab('codes')}><FileCode2 size={15} /> File codes{dirty.codes && <i className="v2-dot" aria-label="unsaved" />}</button>
          </div>
          {tab === 'steps' && <StepTypesEditor list={stepTypes} setList={setStepTypes} canEdit={isMaster} fileCodes={fileCodes} />}
          {tab === 'courses' && <CourseTypesEditor list={courseTypes} setList={setCourseTypes} stepTypes={stepTypes} canEdit={isMaster} />}
          {tab === 'codes' && <FileCodesEditor list={fileCodes} setList={setFileCodes} stepTypes={stepTypes} canEdit={isMaster} />}
        </>
      )}
      {anyDirty && isMaster && (
        <div className="v2-savebar" role="region" aria-label="Unsaved changes">
          <span>You have unsaved changes</span>
          <button type="button" className="btn btn-outline v2-btn-sm" onClick={discard}>Discard</button>
          <button type="button" className="btn btn-primary v2-btn-sm" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save changes'}</button>
        </div>
      )}
      <ToastHost />
    </div>
  );
}

/* ---------------- Step types ---------------- */

function StepTypesEditor({ list, setList, canEdit, fileCodes }: { list: StepTypeDef[]; setList: (l: StepTypeDef[]) => void; canEdit: boolean; fileCodes: FileCodeDef[] }) {
  const [activeKey, setActiveKey] = useState(list[0]?.typeKey ?? '');
  const [mobileEditing, setMobileEditing] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const active = list.find(t => t.typeKey === activeKey) ?? list[0];
  const update = (patch: Partial<StepTypeDef>) => setList(list.map(t => (t.typeKey === active.typeKey ? { ...t, ...patch } : t)));
  const add = () => {
    let key = 'custom_step'; let n = 1;
    while (list.some(t => t.typeKey === key)) key = `custom_step_${++n}`;
    const t: StepTypeDef = { typeKey: key, label: 'New step type', fileCodes: [], studentAction: 'upload', feedbackMode: 'feedback', hasMarks: false, gatesProgress: false, awardsBadge: false, requiresPriorUploads: false, defaultInstructions: '', sortOrder: (list[list.length - 1]?.sortOrder ?? 0) + 10, isSystem: false };
    setList([...list, t]); setActiveKey(key); setMobileEditing(true);
  };
  const codesFromTable = fileCodes.filter(f => f.stepType === active?.typeKey).map(f => f.fileCode);

  return (
    <div className={`v2-master-detail${mobileEditing ? ' show-detail' : ''}`}>
      <nav className="v2-md-list" aria-label="Step types">
        {list.map(t => (
          <button key={t.typeKey} type="button" className={t.typeKey === active?.typeKey ? 'active' : ''} onClick={() => { setActiveKey(t.typeKey); setMobileEditing(true); }}>
            <span className="v2-md-icon">{t.studentAction === 'watch_download' ? <Download size={15} /> : t.studentAction === 'upload' ? <Upload size={15} /> : <PenLine size={15} />}</span>
            <span><strong>{t.label}</strong><small>{t.feedbackMode === 'none' ? 'Self-paced' : t.hasMarks ? 'Marked 1–10' : 'Teacher feedback'}{t.gatesProgress ? ' · gates level' : ''}</small></span>
            {t.isSystem && <Lock size={12} className="v2-md-lock" aria-label="Built-in" />}
          </button>
        ))}
        {canEdit && <button type="button" className="v2-md-add" onClick={add}><Plus size={15} /> Add step type</button>}
      </nav>
      {active && (
        <section className="v2-card v2-md-detail">
          <button type="button" className="v2-back v2-md-back" onClick={() => setMobileEditing(false)}>← All step types</button>
          <div className="v2-md-title">
            <div>
              <p className="eyebrow">{active.isSystem ? 'Built-in step type' : 'Your step type'} · <code>{active.typeKey}</code></p>
              <input className="v2-title-input" value={active.label} disabled={!canEdit} aria-label="Name" onChange={e => update({ label: e.target.value })} />
            </div>
            {canEdit && !active.isSystem && <button type="button" className="v2-icon-btn" aria-label="Remove this step type" onClick={() => setConfirmDel(true)}><Trash2 size={16} /></button>}
          </div>

          <div className="v2-field-block">
            <span className="v2-mini-label">What the student does</span>
            <div className="v2-choice-row">
              {ACTIONS.map(a => (
                <button key={a.value} type="button" disabled={!canEdit} aria-pressed={active.studentAction === a.value} className={`v2-choice-card${active.studentAction === a.value ? ' active' : ''}`} onClick={() => update({ studentAction: a.value })}>
                  {a.icon}<strong>{a.label}</strong><small>{a.text}</small>
                </button>
              ))}
            </div>
          </div>
          <div className="v2-field-block">
            <span className="v2-mini-label">What the teacher does</span>
            <Segmented<FeedbackMode> label="Teacher feedback" value={active.feedbackMode} disabled={!canEdit} options={FEEDBACK.map(f => ({ value: f.value, label: f.label, hint: f.text }))}
              onChange={v => update({ feedbackMode: v, hasMarks: v === 'annotate_mark' ? true : v === 'none' ? false : active.hasMarks })} />
            <p className="v2-help">{FEEDBACK.find(f => f.value === active.feedbackMode)?.text}</p>
          </div>
          <div className="v2-toggles">
            <ToggleLine icon={<Award size={15} />} label="Marked from 1 to 10" text="The mark decides Revision, Pass or Distinction (bands are in Policies)." checked={active.hasMarks} disabled={!canEdit || active.feedbackMode === 'none'} onChange={v => update({ hasMarks: v })} />
            <ToggleLine icon={<GitBranch size={15} />} label="Must pass to open the next level" text="Students cannot start the next level until this is passed." checked={active.gatesProgress} disabled={!canEdit} onChange={v => update({ gatesProgress: v })} />
            <ToggleLine icon={<Award size={15} />} label="Passing gives the level badge" text="The badge of the level (or the step’s own badge) is given on pass." checked={active.awardsBadge} disabled={!canEdit} onChange={v => update({ awardsBadge: v })} />
            <ToggleLine icon={<Upload size={15} />} label="Also upload the earlier worksheets" text="With this step, students upload the worksheets of the level’s earlier steps too." checked={active.requiresPriorUploads} disabled={!canEdit || active.studentAction === 'watch_download'} onChange={v => update({ requiresPriorUploads: v })} />
          </div>
          <div className="v2-field-block">
            <span className="v2-mini-label">File codes that create this type</span>
            <ChipInput values={active.fileCodes} disabled={!canEdit} placeholder="e.g. MT" onChange={v => update({ fileCodes: v })} />
            {codesFromTable.length > 0 && <p className="v2-help">In the file-code table: {codesFromTable.join(', ')}.</p>}
          </div>
          <label className="field-label">Usual instruction to students <span className="v2-optional">shown when a step has no own message</span>
            <textarea className="field v2-textarea" dir="auto" value={active.defaultInstructions} disabled={!canEdit} onChange={e => update({ defaultInstructions: e.target.value })} />
          </label>
          <div className="v2-story">
            <span className="v2-mini-label"><MessageSquare size={13} /> What students will experience</span>
            <ol>{stepStory(active).map((l, i) => <li key={i}>{l}</li>)}</ol>
          </div>
        </section>
      )}
      {confirmDel && active && (
        <ConfirmDialog title={`Remove “${active.label}”?`} danger confirmLabel="Remove" onClose={() => setConfirmDel(false)}
          text="Steps already using this type keep working until you change them. Press Save changes afterwards."
          onConfirm={() => { setList(list.filter(t => t.typeKey !== active.typeKey)); setActiveKey(list[0]?.typeKey ?? ''); setMobileEditing(false); }} />
      )}
    </div>
  );
}

function ToggleLine({ icon, label, text, checked, disabled, onChange }: { icon: JSX.Element; label: string; text: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className={`v2-toggle-line${disabled ? ' is-disabled' : ''}`}>
      <span className="v2-toggle-icon">{icon}</span>
      <span className="v2-toggle-copy"><strong>{label}</strong><small>{text}</small></span>
      <Switch checked={checked} disabled={disabled} label={label} onChange={onChange} />
    </div>
  );
}

function ChipInput({ values, onChange, disabled, placeholder }: { values: string[]; onChange: (v: string[]) => void; disabled?: boolean; placeholder?: string }) {
  const [draft, setDraft] = useState('');
  const commit = () => {
    const v = draft.trim().toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft('');
  };
  return (
    <div className="v2-chip-input">
      {values.map(v => (
        <span key={v} className="v2-code-chip">{v}{!disabled && <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter(x => x !== v))}><X size={12} /></button>}</span>
      ))}
      {!disabled && <input value={draft} placeholder={placeholder} aria-label="Add a file code" onChange={e => setDraft(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter' || e.key === ',' || e.key === ' ') { e.preventDefault(); commit(); } if (e.key === 'Backspace' && !draft && values.length) onChange(values.slice(0, -1)); }} />}
      {disabled && !values.length && <span className="muted">None</span>}
    </div>
  );
}

/* ---------------- Course types ---------------- */

function CourseTypesEditor({ list, setList, stepTypes, canEdit }: { list: CourseTypeDef[]; setList: (l: CourseTypeDef[]) => void; stepTypes: StepTypeDef[]; canEdit: boolean }) {
  const update = (key: string, patch: Partial<CourseTypeDef>) => setList(list.map(t => (t.typeKey === key ? { ...t, ...patch } : t)));
  const add = () => {
    const label = 'New course type';
    let key = slugKey(label); let n = 1;
    while (list.some(t => t.typeKey === key)) key = `${slugKey(label)}_${++n}`;
    setList([...list, { typeKey: key, label, allowedStepTypes: stepTypes.filter(s => s.studentAction === 'watch_download').map(s => s.typeKey), hasLevels: true, finalSubmission: false, sortOrder: (list[list.length - 1]?.sortOrder ?? 0) + 10 }]);
  };
  return (
    <div className="v2-stack">
      {list.map(t => (
        <section key={t.typeKey} className="v2-card v2-ctype">
          <div className="v2-md-title">
            <div>
              <p className="eyebrow">Course type · <code>{t.typeKey}</code></p>
              <input className="v2-title-input" value={t.label} disabled={!canEdit} aria-label="Name" onChange={e => update(t.typeKey, { label: e.target.value })} />
            </div>
          </div>
          <div className="v2-toggles">
            <ToggleLine icon={<Shapes size={15} />} label="Has levels" text={t.hasLevels ? 'Steps are grouped in levels LV01, LV02 … each with its own instructions.' : 'Just a list of steps (one hidden level). Good for crash courses and mashq.'} checked={t.hasLevels} disabled={!canEdit} onChange={v => update(t.typeKey, { hasLevels: v })} />
            <ToggleLine icon={<Award size={15} />} label="Final submission at the end" text="Adds one last upload step that is marked and gives the course badge." checked={t.finalSubmission} disabled={!canEdit} onChange={v => update(t.typeKey, { finalSubmission: v })} />
          </div>
          <div className="v2-field-block">
            <span className="v2-mini-label">Step types in the builder’s drop-down</span>
            <div className="v2-chip-toggles">
              {stepTypes.map(s => {
                const on = t.allowedStepTypes.includes(s.typeKey);
                return <button key={s.typeKey} type="button" disabled={!canEdit} aria-pressed={on} className={on ? 'on' : ''} onClick={() => update(t.typeKey, { allowedStepTypes: on ? t.allowedStepTypes.filter(x => x !== s.typeKey) : [...t.allowedStepTypes, s.typeKey] })}>{s.label}</button>;
              })}
            </div>
          </div>
          <p className="v2-story-inline">
            <b>Students will:</b> {t.hasLevels ? 'move level by level' : 'follow one list of steps'}
            {t.allowedStepTypes.some(k => stepTypes.find(s => s.typeKey === k)?.gatesProgress) ? ', passing a marked step before the next level opens' : ', at their own pace'}
            {t.finalSubmission ? ', and finish with a final submission for the course badge.' : '.'}
          </p>
        </section>
      ))}
      {canEdit && <button type="button" className="v2-add-row" onClick={add}><Plus size={16} /> Add course type</button>}
    </div>
  );
}

/* ---------------- File codes ---------------- */

function FileCodesEditor({ list, setList, stepTypes, canEdit }: { list: FileCodeDef[]; setList: (l: FileCodeDef[]) => void; stepTypes: StepTypeDef[]; canEdit: boolean }) {
  const update = (i: number, patch: Partial<FileCodeDef>) => setList(list.map((f, n) => (n === i ? { ...f, ...patch } : f)));
  const dupes = useMemo(() => { const seen = new Set<string>(); const d = new Set<string>(); list.forEach(f => { const k = f.fileCode.toUpperCase(); if (seen.has(k)) d.add(k); seen.add(k); }); return d; }, [list]);
  if (!list.length && !canEdit) return <EmptyState icon={<FileCode2 size={26} />} title="No file codes" text="The built-in codes are used." />;
  return (
    <section className="v2-card">
      <p className="v2-help">The two letters after the course code in a file name. Example: in <code>FNK-C101_<b>AW</b>_LV02_S05_P01_10_v1.pdf</code>, <b>AW</b> makes an assessment step and the file becomes its assessment sheet.</p>
      <div className="v2-codes">
        <div className="v2-codes-head"><span>Code</span><span>Name</span><span>Makes this step type</span><span>File is a</span><span /></div>
        {list.map((f, i) => (
          <div key={i} className={`v2-codes-row${dupes.has(f.fileCode.toUpperCase()) ? ' is-dupe' : ''}`}>
            <input className="field v2-code-field" value={f.fileCode} maxLength={3} disabled={!canEdit} aria-label="Code" onChange={e => update(i, { fileCode: e.target.value.toUpperCase().replace(/[^A-Z]/g, '') })} />
            <input className="field" value={f.label} disabled={!canEdit} aria-label="Name" onChange={e => update(i, { label: e.target.value })} />
            <select className="field" value={f.stepType} disabled={!canEdit} aria-label="Step type" onChange={e => update(i, { stepType: e.target.value })}>
              <option value="">Keep the step’s type</option>
              {stepTypes.map(s => <option key={s.typeKey} value={s.typeKey}>{s.label}</option>)}
            </select>
            <select className="field" value={f.fileRole} disabled={!canEdit} aria-label="File role" onChange={e => update(i, { fileRole: e.target.value as FileRole })}>
              {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
            {canEdit ? <button type="button" className="v2-icon-btn" aria-label={`Remove ${f.fileCode}`} onClick={() => setList(list.filter((_, n) => n !== i))}><Trash2 size={15} /></button> : <span />}
          </div>
        ))}
      </div>
      {dupes.size > 0 && <p className="v2-bad v2-help">The code {Array.from(dupes).join(', ')} is listed twice — keep one.</p>}
      {canEdit && (
        <div className="v2-form-foot">
          <button type="button" className="v2-link" onClick={() => setList([...list, { fileCode: '', label: '', stepType: 'worksheet', fileRole: 'worksheet' }])}><Plus size={14} /> Add a code</button>
          {!list.length && <button type="button" className="v2-link" onClick={() => setList(Object.entries(DEFAULT_FILE_CODES).map(([k, v]) => ({ fileCode: k, label: v.label, stepType: v.stepType ?? '', fileRole: v.fileRole })))}>Fill in the usual codes</button>}
        </div>
      )}
    </section>
  );
}
