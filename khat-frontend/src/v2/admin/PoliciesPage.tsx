import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Award, Bell, Building2, CheckCircle2, ClipboardCheck, Clock, Globe2, ImagePlus, Lock, Mail, Network, Plus, SlidersHorizontal, Printer, RotateCcw, Trash2, Unlock, Users,
} from 'lucide-react';
import { apiFetch, getViewUrl, uploadFile } from '@/api';
import type { MarkBand, PoliciesResponse, PolicyKey, PolicyRow, RubricCriterion, WatermarkSetting } from '../contracts';
import { ReviewNetworkView } from './ReviewNetwork';
import { BranchChangesPanel } from './BranchChangesPanel';
import '../announce/v3-comms.css';
import {
  ErrorBox, Loading, NumberStepper, PageHead, ReadOnlyBanner, Segmented, Switch, ToastHost, errorText, formatDate, loadBranches, loadStaff, toast,
  type Branch, type StaffRow,
} from './shared';

type Props = Record<string, never>;

type Kind =
  | { kind: 'number'; min: number; max: number; unit?: string; zeroText?: string }
  | { kind: 'toggle'; on: string; off: string }
  | { kind: 'bands' } | { kind: 'rubric' } | { kind: 'templates' } | { kind: 'quickmarks' }
  | { kind: 'text'; rows?: number; placeholder?: string } | { kind: 'stamp' } | { kind: 'watermark' } | { kind: 'officer' }
  | { kind: 'emailMode' } | { kind: 'nudge' } | { kind: 'printNote' };

type Meta = { key: PolicyKey; label: string; help: string } & Kind;
type Section = { id: string; label: string; icon: ReactNode; intro: string; items: Meta[] };

const SECTIONS: Section[] = [
  {
    id: 'checking', label: 'Checking & marks', icon: <ClipboardCheck size={15} />, intro: 'How work is checked and how marks are read.',
    items: [
      { key: 'review.reviewers_required', label: 'Teachers who check each submission', help: 'Usually one. Two means a second teacher also looks before the result goes out.', kind: 'number', min: 1, max: 3, unit: 'teacher(s)' },
      { key: 'review.turnaround_days', label: 'Answer within', help: 'The promise to students: how soon a teacher replies.', kind: 'number', min: 1, max: 14, unit: 'days' },
      { key: 'assessment.bands', label: 'What a mark means', help: 'Slide to choose where Revision ends and Distinction begins.', kind: 'bands' },
      { key: 'assessment.max_attempts', label: 'Tries for an assessment', help: 'After Revision a student may send again — up to this many times in all.', kind: 'number', min: 0, max: 10, unit: 'tries', zeroText: 'No limit' },
      { key: 'review.quick_marks', label: 'One-tap marks', help: 'The mark buttons a teacher sees on the photo.', kind: 'quickmarks' },
      { key: 'assessment.rubric', label: 'Marking criteria', help: 'What the teacher looks at. Points add up to the mark.', kind: 'rubric' },
      { key: 'review.comment_templates', label: 'Warm comments', help: 'Used when a teacher gives a mark without writing — one is picked for the band.', kind: 'templates' },
    ],
  },
  {
    id: 'busy', label: 'When teachers are busy', icon: <Clock size={15} />, intro: 'So no student waits forever.',
    items: [
      { key: 'review.divert_after_hours', label: 'Pass to another teacher after', help: 'Unanswered work moves to another teacher of the same branch, then to the master team.', kind: 'number', min: 12, max: 240, unit: 'hours' },
      { key: 'review.auto_mark_enabled', label: 'Automatic mark when nobody answers', help: 'Uses the student’s own average and a warm comment. Teachers can still review it later.', kind: 'toggle', on: 'On', off: 'Off' },
      { key: 'review.auto_mark_after_days', label: 'Automatic mark after', help: 'Counted from the day the student sent the work.', kind: 'number', min: 2, max: 30, unit: 'days' },
    ],
  },
  {
    id: 'print', label: 'Printing & downloads', icon: <Printer size={15} />, intro: 'What students see when they download and print.',
    items: [
      { key: 'print.instructions', label: 'Download message', help: 'Always shown at every download and print button — worksheets, reference images and assessment sheets. Branches cannot change it; they may only add one extra note under it.', kind: 'printNote' },
      { key: 'print.allow_multi', label: 'Print many sheets at once', help: 'Students tick several worksheets and get one PDF.', kind: 'toggle', on: 'Allowed', off: 'One at a time' },
      { key: 'downloads.stamp_fields', label: 'Name band on every page', help: 'Printed at the top of each downloaded sheet.', kind: 'stamp' },
      { key: 'downloads.watermark', label: 'Watermark', help: 'A soft image on every downloaded sheet.', kind: 'watermark' },
      { key: 'downloads.copyright_text', label: 'Copyright line', help: 'Printed at the foot of every page.', kind: 'text', rows: 2 },
    ],
  },
  {
    id: 'merit', label: 'Merit points', icon: <Award size={15} />, intro: 'Points are given on the Jamea portal by the branch admin. Students do not see merit points.',
    items: [
      { key: 'merit.levels_per_point', label: 'Levels for one point', help: 'Every this many passed levels earn one merit point.', kind: 'number', min: 1, max: 20, unit: 'levels' },
      { key: 'merit.certification_points', label: 'Points for a full certification', help: 'Given once when a student completes a certification course.', kind: 'number', min: 0, max: 100, unit: 'points' },
      { key: 'merit.monthly_cap', label: 'Most points in one month', help: 'Extra points move to next month’s list — never lost.', kind: 'number', min: 1, max: 100, unit: 'points' },
      { key: 'merit.officer_user_id', label: 'Who else may give merit points', help: 'The branch admin always can. Pick one more person only if someone else enters the points on the Jamea portal.', kind: 'officer' },
      { key: 'merit.reminder_day', label: 'Remind the branch admin on day', help: 'Also reminded on the last day of the month.', kind: 'number', min: 1, max: 28, unit: 'of the month' },
    ],
  },
  {
    id: 'students', label: 'Students', icon: <Users size={15} />, intro: 'Small rules on the student side.',
    items: [
      { key: 'uploads.max_files', label: 'Files in one upload', help: 'Most photos a student can send at once.', kind: 'number', min: 1, max: 60, unit: 'files' },
      { key: 'student.choose_one_size', label: 'Student picks one mistar size', help: 'Asked once; after that only that size is shown.', kind: 'toggle', on: 'Yes', off: 'Show every size' },
      { key: 'showcase.requires_approval', label: 'Check showcase requests first', help: 'Work shared to the gallery waits for an admin.', kind: 'toggle', on: 'Check first', off: 'Publish at once' },
    ],
  },
  {
    id: 'emails', label: 'Emails', icon: <Mail size={15} />, intro: 'Who gets emailed, and the gentle email to quiet students. The wording of every email is in Announcements → Email templates.',
    items: [
      { key: 'email.student_on_reply', label: 'Email students on every reply', help: 'They also see it on the site.', kind: 'toggle', on: 'Yes', off: 'No' },
      { key: 'email.staff_mode', label: 'Teacher emails', help: 'How teachers hear about new work.', kind: 'emailMode' },
      { key: 'nudge.inactive_days', label: '“Needs a push” after', help: 'Quiet for this long — shown in Insights.', kind: 'number', min: 3, max: 120, unit: 'days' },
      { key: 'nudge.dormant_days', label: 'Gentle email after', help: 'An email only — never a pop-up. Sent at most once a month.', kind: 'number', min: 14, max: 720, unit: 'days' },
      { key: 'nudge.message_template', label: 'The gentle message', help: 'Words in {curly brackets} are filled in for each student.', kind: 'nudge' },
    ],
  },
];

const STAMP_FIELDS: { key: string; label: string; sample: string }[] = [
  { key: 'name', label: 'Name', sample: 'Fatema Hussain' }, { key: 'email', label: 'Email', sample: 'fatema@example.com' }, { key: 'tr', label: 'TR number', sample: 'TR 40231' },
  { key: 'class', label: 'Class', sample: 'Class 5' }, { key: 'branch', label: 'Branch', sample: 'Nairobi' }, { key: 'date', label: 'Date', sample: '10 Nov 2026' },
];

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function V2PoliciesPage(_props: Props) {
  const [data, setData] = useState<PoliciesResponse | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<string | null>(null); // '' = all branches (global)
  const [section, setSection] = useState(SECTIONS[0].id);
  const [view, setView] = useState<'rules' | 'network'>('rules');

  const load = async () => {
    setError(null);
    try {
      const [p, b] = await Promise.all([apiFetch<PoliciesResponse>('/v2/policies'), loadBranches()]);
      setData(p); setBranches(b);
      setScope(s => (s !== null ? s : p.canEditGlobal ? '' : p.editableBranchIds[0] ?? ''));
    } catch (err) { setError(errorText(err, 'Could not load the policies.')); }
  };
  useEffect(() => { void load(); }, []);

  const branchName = (id: string) => branches.find(b => b.id === id)?.name ?? id;
  const scopeOptions = useMemo(() => {
    if (!data) return [];
    const opts: { value: string; label: string }[] = [];
    if (data.canEditGlobal) opts.push({ value: '', label: 'Standard (all branches)' });
    const ids = data.canEditGlobal ? branches.map(b => b.id) : data.editableBranchIds;
    ids.forEach(id => opts.push({ value: id, label: branchName(id) }));
    return opts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, branches]);

  const onSaved = (key: PolicyKey, value: unknown, locked?: boolean) => setData(d => {
    if (!d) return d;
    if (scope === '') return { ...d, global: d.global.map(r => (r.policyKey === key ? { ...r, value, locked: locked ?? r.locked, updatedAt: new Date().toISOString() } : r)) };
    const b = { ...(d.branches[scope!] ?? {}) };
    if (value === undefined) delete b[key]; else b[key] = value;
    return { ...d, branches: { ...d.branches, [scope!]: b } };
  });

  const current = SECTIONS.find(s => s.id === section) ?? SECTIONS[0];
  const overrides = scope ? data?.branches[scope] ?? {} : {};
  const isBranchView = scope !== '' && scope !== null;
  const canEditHere = data ? (scope === '' ? data.canEditGlobal : data.editableBranchIds.includes(scope ?? '') || data.canEditGlobal) : false;

  return (
    <div className="page portal-page v2-admin">
      <PageHead
        eyebrow="Settings"
        title="Policies"
        text={data?.canEditGlobal
          ? 'Every rule is either Fixed — the same in every branch — or Branches decide — each branch admin may set their own. You are told when a branch changes something.'
          : 'Your branch’s rules. Rules marked Fixed are the same everywhere; everything else is yours to decide.'}
      />
      {error && <ErrorBox message={error} onRetry={() => void load()} />}
      {!error && !data && <Loading label="Loading policies…" />}
      {data && scope !== null && (
        <>
          {scopeOptions.length > 1 ? (
            <div className="v2-scope">
              <span className="v2-mini-label">{scope === '' ? <Globe2 size={13} /> : <Building2 size={13} />} Showing</span>
              <div className="v2-scope-pills" role="tablist" aria-label="Branch">
                {scopeOptions.map(o => {
                  const n = o.value ? Object.keys(data.branches[o.value] ?? {}).length : 0;
                  return (
                    <button key={o.value || 'all'} type="button" role="tab" aria-selected={scope === o.value} className={scope === o.value ? 'active' : ''} onClick={() => setScope(o.value)}>
                      {o.label}{n > 0 && <span title={`${n} changed by the branch`}>{n}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : isBranchView && <p className="v2-scope-single"><Building2 size={15} /> {branchName(scope)}</p>}
          <div className="v2-tabs" role="tablist" aria-label="Policies">
            <button type="button" role="tab" aria-selected={view === 'rules'} className={view === 'rules' ? 'active' : ''} onClick={() => setView('rules')}><SlidersHorizontal size={15} /> Rules</button>
            <button type="button" role="tab" aria-selected={view === 'network'} className={view === 'network' ? 'active' : ''} onClick={() => setView('network')}><Network size={15} /> Review network</button>
          </div>
          {view === 'network' && <ReviewNetworkView branchId={scope} branches={branches} />}
          {view === 'rules' && <>
          {!canEditHere && <ReadOnlyBanner>You can read these settings but not change them.</ReadOnlyBanner>}
          {isBranchView && data.canEditGlobal && <p className="v2-help v2-scope-note">You are looking at {branchName(scope)}. Rules marked “{branchName(scope)}’s own” were changed by that branch.</p>}
          {data.canEditGlobal && scope === '' && <BranchChangesPanel branchName={branchName} />}
          <p className="v3-policy-count">{(() => { const keys = SECTIONS.flatMap(x => x.items.map(i => i.key)); const fixed = data.global.filter(r => keys.includes(r.policyKey) && r.locked).length; return <><Lock size={13} /> {fixed} fixed · <Unlock size={13} /> {keys.length - fixed} {data.canEditGlobal ? 'branches decide' : 'for your branch to decide'}</>; })()}</p>

          <div className="v2-policy-layout">
            <nav className="v2-section-nav" aria-label="Policy sections">
              {SECTIONS.map(s => {
                const changed = isBranchView ? s.items.filter(i => i.key in overrides).length : 0;
                return (
                  <button key={s.id} type="button" className={section === s.id ? 'active' : ''} aria-current={section === s.id} onClick={() => setSection(s.id)}>
                    {s.icon}<span>{s.label}</span>{changed > 0 && <i>{changed}</i>}
                  </button>
                );
              })}
            </nav>
            <div className="v2-policy-list">
              <p className="v2-section-intro">{current.intro}</p>
              {current.items.map(meta => {
                const row = data.global.find(r => r.policyKey === meta.key);
                if (!row) return null;
                const has = isBranchView && meta.key in overrides;
                // The download message is fixed text; in a branch view the editable value is only the branch's extra note.
                const value = meta.kind === 'printNote' && isBranchView ? (has ? overrides[meta.key] : '') : has ? overrides[meta.key] : row.value;
                const lockedForBranch = isBranchView && row.locked;
                const editable = scope === '' ? data.canEditGlobal : !row.locked && (data.editableBranchIds.includes(scope) || data.canEditGlobal);
                const changedBy = scope === '' ? Object.entries(data.branches).filter(([, o]) => meta.key in o).map(([id]) => branchName(id)) : [];
                return (
                  <PolicyCard
                    key={`${scope}:${meta.key}`}
                    meta={meta}
                    row={row}
                    value={value}
                    scope={scope}
                    scopeName={scope ? branchName(scope) : 'all branches'}
                    branches={branches}
                    editable={editable}
                    lockedForBranch={lockedForBranch}
                    hasOverride={has}
                    changedBy={changedBy}
                    canLock={scope === '' && data.canEditGlobal}
                    viewerIsMaster={data.canEditGlobal}
                    onSaved={onSaved}
                  />
                );
              })}
            </div>
          </div>
          </>}
        </>
      )}
      <ToastHost />
    </div>
  );
}

function PolicyCard({ meta, row, value, scope, scopeName, branches, editable, lockedForBranch, hasOverride, changedBy, canLock, viewerIsMaster, onSaved }: {
  meta: Meta; row: PolicyRow; value: unknown; scope: string; scopeName: string; branches: Branch[]; editable: boolean; lockedForBranch: boolean;
  hasOverride: boolean; changedBy: string[]; canLock: boolean; viewerIsMaster: boolean; onSaved: (key: PolicyKey, value: unknown, locked?: boolean) => void;
}) {
  const [draft, setDraft] = useState<unknown>(value);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(value), [value]);
  const dirty = !same(draft, value);
  const isOwnBranch = !viewerIsMaster;
  const isNote = meta.kind === 'printNote';
  const ownLabel = isNote ? (isOwnBranch ? 'Your branch adds a note' : `${scopeName} adds a note`) : isOwnBranch ? 'Your branch’s value' : `${scopeName}’s own`;
  const url = (k: PolicyKey) => encodeURIComponent(k);

  const save = async () => {
    setBusy(true);
    try {
      if (scope === '') await apiFetch(`/v2/policies/global/${url(meta.key)}`, { method: 'PUT', body: { value: draft, locked: row.locked } });
      else await apiFetch(`/v2/policies/branch/${encodeURIComponent(scope)}/${url(meta.key)}`, { method: 'PUT', body: { value: draft } });
      onSaved(meta.key, isNote && scope !== '' && !String(draft ?? '').trim() ? undefined : draft);
      toast(`${meta.label} saved${scope === '' ? '' : ` for ${scopeName}`}.`);
    } catch (err) { toast(errorText(err), { tone: 'error' }); } finally { setBusy(false); }
  };
  const resetToNairobi = async () => {
    setBusy(true);
    try {
      await apiFetch(`/v2/policies/branch/${encodeURIComponent(scope)}/${url(meta.key)}`, { method: 'DELETE' });
      onSaved(meta.key, undefined);
      toast(isNote ? `${scopeName}’s extra note was removed.` : `${scopeName} now uses the standard value.`);
    } catch (err) { toast(errorText(err), { tone: 'error' }); } finally { setBusy(false); }
  };
  const toggleLock = async (mayChange: boolean) => {
    try {
      await apiFetch(`/v2/policies/global/${url(meta.key)}`, { method: 'PUT', body: { value: row.value, locked: !mayChange } });
      onSaved(meta.key, row.value, !mayChange);
      toast(mayChange ? `Branches now decide “${meta.label}”.` : `“${meta.label}” is now Fixed — the same in every branch.`);
    } catch (err) { toast(errorText(err), { tone: 'error' }); }
  };

  return (
    <section className={`v2-policy${lockedForBranch ? ' is-locked' : ''}${dirty ? ' is-dirty' : ''}`} aria-label={meta.label}>
      <div className="v2-policy-head">
        <div>
          <h3>{meta.label}</h3>
          <p>{meta.help}</p>
        </div>
        <div className="v2-policy-tags">
          {canLock && (
            <div className="v3-fixed-toggle" role="radiogroup" aria-label={`Who decides “${meta.label}”`}>
              <button type="button" role="radio" aria-checked={row.locked} className={row.locked ? 'on' : ''} onClick={() => { if (!row.locked) void toggleLock(false); }}><Lock size={12} /> Fixed</button>
              <button type="button" role="radio" aria-checked={!row.locked} className={!row.locked ? 'on' : ''} onClick={() => { if (row.locked) void toggleLock(true); }}><Unlock size={12} /> Branches decide</button>
            </div>
          )}
          {lockedForBranch && <span className="chip v2-chip-muted v3-chip-fixed"><Lock size={11} /> Fixed</span>}
          {hasOverride && <span className="chip chip-gold">{ownLabel}</span>}
          {changedBy.length > 0 && !row.locked && <span className="chip chip-blue" title={changedBy.join(', ')}>{changedBy.length === 1 ? `${changedBy[0]} has its own` : `${changedBy.length} branches have their own`}</span>}
        </div>
      </div>
      <fieldset className="v2-policy-body" disabled={!editable || busy}>
        {isNote && scope !== '' ? (
          <div className="v3-print-note-edit">
            <p className="v3-print-note-fixed"><Lock size={13} aria-hidden="true" /> <span><b>Always printed (set by the master team)</b>{String(row.value ?? '')}</span></p>
            <label className="v3-print-note-label" htmlFor={`note-${scope}`}>Your branch’s extra note <small>(optional — shown on the next line)</small></label>
            <textarea id={`note-${scope}`} className="field v2-textarea" dir="auto" rows={2} maxLength={300} placeholder="For example: Art paper is available at the branch office." value={String(draft ?? '')} disabled={!editable} onChange={e => setDraft(e.target.value)} />
          </div>
        ) : (
          <PolicyEditor meta={meta} value={draft} onChange={setDraft} disabled={!editable} scope={scope} branches={branches} />
        )}
      </fieldset>
      {(dirty || (hasOverride && editable) || (canLock && row.updatedAt)) && (
        <div className="v2-policy-foot">
          {canLock && row.updatedAt && !dirty && <span className="v2-updated">Last changed {formatDate(row.updatedAt)}</span>}
          <span className="v2-grow" />
          {hasOverride && editable && !dirty && <button type="button" className="v2-link" onClick={() => void resetToNairobi()}><RotateCcw size={13} /> {isNote ? 'Remove the extra note' : 'Use the standard value'}</button>}
          {dirty && <>
            <button type="button" className="btn btn-outline v2-btn-sm" onClick={() => setDraft(value)}>Undo</button>
            <button type="button" className="btn btn-primary v2-btn-sm" onClick={() => void save()} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          </>}
        </div>
      )}
    </section>
  );
}

/* ---------------- Editors ---------------- */

function PolicyEditor({ meta, value, onChange, disabled, scope, branches }: { meta: Meta; value: unknown; onChange: (v: unknown) => void; disabled: boolean; scope: string; branches: Branch[] }) {
  switch (meta.kind) {
    case 'number': {
      const n = Number(value ?? 0);
      return (
        <div className="v2-num-row">
          <NumberStepper value={n} min={meta.min} max={meta.max} unit={meta.unit} disabled={disabled} label={meta.label} onChange={onChange} />
          {meta.zeroText && n === 0 && <span className="chip chip-blue">{meta.zeroText}</span>}
        </div>
      );
    }
    case 'toggle': {
      const on = Boolean(value);
      return <label className="v2-inline-switch"><Switch checked={on} disabled={disabled} label={meta.label} onChange={onChange} /> <b>{on ? meta.on : meta.off}</b></label>;
    }
    case 'bands': return <BandsEditor value={value as { revisionMax: number; passMax: number }} onChange={onChange} disabled={disabled} />;
    case 'rubric': return <RubricEditor value={(value as RubricCriterion[]) ?? []} onChange={onChange} disabled={disabled} />;
    case 'templates': return <TemplatesEditor value={(value as Record<MarkBand, string[]>) ?? { revision: [], pass: [], distinction: [] }} onChange={onChange} disabled={disabled} />;
    case 'quickmarks': {
      const list = Array.isArray(value) ? (value as number[]) : [];
      return (
        <div className="v2-marks-pick">
          {Array.from({ length: 10 }, (_, i) => i + 1).map(m => (
            <button key={m} type="button" disabled={disabled} aria-pressed={list.includes(m)} className={list.includes(m) ? 'on' : ''} onClick={() => onChange(list.includes(m) ? list.filter(x => x !== m) : [...list, m].sort((a, b) => a - b))}>{m}</button>
          ))}
        </div>
      );
    }
    case 'printNote':
    case 'text': return <textarea className="field v2-textarea" dir="auto" rows={meta.kind === 'text' ? meta.rows ?? 3 : 3} value={String(value ?? '')} disabled={disabled} onChange={e => onChange(e.target.value)} />;
    case 'stamp': return <StampEditor value={Array.isArray(value) ? (value as string[]) : []} onChange={onChange} disabled={disabled} />;
    case 'watermark': return <WatermarkEditor value={(value as WatermarkSetting) ?? { storageKey: null, opacity: 0.08, position: 'center', scale: 0.45 }} onChange={onChange} disabled={disabled} />;
    case 'officer': return <OfficerEditor value={(value as string | null) ?? null} onChange={onChange} disabled={disabled} scope={scope} branches={branches} />;
    case 'emailMode': return (
      <div className="v2-stack-sm">
        <Segmented label="Teacher emails" value={String(value ?? 'daily_digest')} disabled={disabled} onChange={onChange}
          options={[{ value: 'instant', label: 'Every new work' }, { value: 'daily_digest', label: 'One a day' }, { value: 'off', label: 'Off' }]} />
        <p className="v2-help">{value === 'instant' ? 'An email for each new submission — busy inboxes.' : value === 'off' ? 'No emails; teachers check the inbox on the site.' : 'One short email each morning (after 7:00) with how many are waiting.'}</p>
      </div>
    );
    case 'nudge': return <NudgeEditor value={String(value ?? '')} onChange={onChange} disabled={disabled} />;
  }
}

function BandsEditor({ value, onChange, disabled }: { value: { revisionMax: number; passMax: number }; onChange: (v: unknown) => void; disabled: boolean }) {
  const r = Math.min(8, Math.max(1, value?.revisionMax ?? 5));
  const p = Math.min(10, Math.max(r + 1, value?.passMax ?? 8));
  const set = (nr: number, np: number) => { const rr = Math.min(8, Math.max(1, nr)); onChange({ revisionMax: rr, passMax: Math.min(10, Math.max(rr + 1, np)) }); };
  return (
    <div className="v2-bands">
      <div className="v2-bands-bar" aria-hidden="true">
        {Array.from({ length: 10 }, (_, i) => i + 1).map(m => (
          <span key={m} className={m <= r ? 'b-rev' : m <= p ? 'b-pass' : 'b-dist'}>{m}</span>
        ))}
      </div>
      <div className="v2-bands-legend">
        <span className="b-rev"><i /> Revision 1–{r}</span>
        <span className="b-pass"><i /> Pass {r + 1}–{p}</span>
        <span className="b-dist"><i /> {p < 10 ? `Distinction ${p + 1}–10` : 'No distinction'}</span>
      </div>
      <div className="v2-grid-2">
        <label className="field-label">Revision up to <b>{r}</b>
          <input type="range" min={1} max={8} value={r} disabled={disabled} onChange={e => set(Number(e.target.value), p)} />
        </label>
        <label className="field-label">Pass up to <b>{p}</b>
          <input type="range" min={2} max={10} value={p} disabled={disabled} onChange={e => set(r, Number(e.target.value))} />
        </label>
      </div>
    </div>
  );
}

function RubricEditor({ value, onChange, disabled }: { value: RubricCriterion[]; onChange: (v: unknown) => void; disabled: boolean }) {
  const total = value.reduce((n, c) => n + (Number(c.max) || 0), 0);
  const update = (i: number, patch: Partial<RubricCriterion>) => onChange(value.map((c, n) => (n === i ? { ...c, ...patch } : c)));
  return (
    <div className="v2-rubric">
      {value.map((c, i) => (
        <div key={i} className="v2-rubric-row">
          <input className="field" value={c.label} placeholder="e.g. Nuqta proportion" aria-label="Criterion" onChange={e => update(i, { label: e.target.value, key: c.key || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '_') })} />
          <NumberStepper value={Number(c.max) || 0} min={1} max={10} label={`Points for ${c.label}`} disabled={disabled} onChange={v => update(i, { max: v })} />
          {!disabled && <button type="button" className="v2-icon-btn" aria-label={`Remove ${c.label}`} onClick={() => onChange(value.filter((_, n) => n !== i))}><Trash2 size={15} /></button>}
        </div>
      ))}
      <div className="v2-rubric-foot">
        {!disabled && <button type="button" className="v2-link" onClick={() => onChange([...value, { key: `c${value.length + 1}`, label: '', max: 2 }])}><Plus size={14} /> Add a criterion</button>}
        <span className={total === 10 ? 'v2-ok' : 'v2-warn'}>{total === 10 ? <><CheckCircle2 size={13} /> Adds up to 10</> : `Adds up to ${total} — marks are out of 10`}</span>
      </div>
    </div>
  );
}

function TemplatesEditor({ value, onChange, disabled }: { value: Record<MarkBand, string[]>; onChange: (v: unknown) => void; disabled: boolean }) {
  const [band, setBand] = useState<MarkBand>('pass');
  const list = value[band] ?? [];
  const set = (next: string[]) => onChange({ ...value, [band]: next });
  return (
    <div className="v2-stack-sm">
      <Segmented<MarkBand> label="Band" size="sm" value={band} onChange={setBand}
        options={[{ value: 'revision', label: `Revision · ${value.revision?.length ?? 0}` }, { value: 'pass', label: `Pass · ${value.pass?.length ?? 0}` }, { value: 'distinction', label: `Distinction · ${value.distinction?.length ?? 0}` }]} />
      {list.map((t, i) => (
        <div key={i} className="v2-template-row">
          <textarea className="field v2-textarea-sm" dir="auto" value={t} disabled={disabled} aria-label={`Comment ${i + 1}`} onChange={e => set(list.map((x, n) => (n === i ? e.target.value : x)))} />
          {!disabled && <button type="button" className="v2-icon-btn" aria-label="Remove comment" onClick={() => set(list.filter((_, n) => n !== i))}><Trash2 size={15} /></button>}
        </div>
      ))}
      {!list.length && <p className="v2-help">No comments for this band yet — add at least one.</p>}
      {!disabled && <button type="button" className="v2-link" onClick={() => set([...list, ''])}><Plus size={14} /> Add a comment</button>}
    </div>
  );
}

function StampEditor({ value, onChange, disabled }: { value: string[]; onChange: (v: unknown) => void; disabled: boolean }) {
  return (
    <div className="v2-stack-sm">
      <div className="v2-chip-toggles">
        {STAMP_FIELDS.map(f => {
          const on = value.includes(f.key);
          return <button key={f.key} type="button" disabled={disabled} aria-pressed={on} className={on ? 'on' : ''} onClick={() => onChange(on ? value.filter(x => x !== f.key) : STAMP_FIELDS.map(s => s.key).filter(k => k === f.key || value.includes(k)))}>{f.label}</button>;
        })}
      </div>
      <div className="v2-stamp-preview" aria-label="Preview of the name band">
        {STAMP_FIELDS.filter(f => value.includes(f.key)).map(f => <span key={f.key}>{f.sample}</span>)}
        {!value.length && <em>Nothing printed at the top</em>}
      </div>
    </div>
  );
}

function WatermarkEditor({ value, onChange, disabled }: { value: WatermarkSetting; onChange: (v: unknown) => void; disabled: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    if (!value.storageKey) { setSrc(null); return; }
    getViewUrl(value.storageKey).then(u => { if (alive) setSrc(u); }).catch(() => { if (alive) setSrc(null); });
    return () => { alive = false; };
  }, [value.storageKey]);
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const { storageKey } = await uploadFile('settings', file);
      setSrc(URL.createObjectURL(file));
      onChange({ ...value, storageKey });
    } catch (err) { toast(errorText(err), { tone: 'error' }); } finally { setBusy(false); }
  };
  const pct = Math.round(value.opacity * 100);
  return (
    <div className="v2-watermark">
      <div className="v2-watermark-controls">
        <label className={`v2-file-pick v2-file-pick-sm${disabled ? ' is-disabled' : ''}`}>
          <ImagePlus size={17} />
          <strong>{busy ? 'Uploading…' : value.storageKey ? 'Change image' : 'Choose an image'}</strong>
          <small>PNG with a clear background works best</small>
          <input type="file" accept="image/png,image/jpeg,image/webp" disabled={disabled} onChange={e => void pick(e.target.files?.[0])} />
        </label>
        {value.storageKey && !disabled && <button type="button" className="v2-link v2-danger-link" onClick={() => onChange({ ...value, storageKey: null })}><Trash2 size={13} /> No watermark</button>}
        <label className="field-label">How strong <b>{pct}%</b>
          <input type="range" min={2} max={40} value={pct} disabled={disabled} onChange={e => onChange({ ...value, opacity: Number(e.target.value) / 100 })} />
        </label>
        <label className="field-label">Size <b>{Math.round(value.scale * 100)}%</b>
          <input type="range" min={10} max={100} value={Math.round(value.scale * 100)} disabled={disabled} onChange={e => onChange({ ...value, scale: Number(e.target.value) / 100 })} />
        </label>
        <div className="field-label">Where
          <Segmented<WatermarkSetting['position']> label="Watermark position" size="sm" value={value.position} disabled={disabled} onChange={v => onChange({ ...value, position: v })}
            options={[{ value: 'center', label: 'Centre' }, { value: 'bottom-right', label: 'Corner' }, { value: 'diagonal-tile', label: 'Repeated' }]} />
        </div>
      </div>
      <SampleSheet src={src} setting={value} />
    </div>
  );
}

function SampleSheet({ src, setting }: { src: string | null; setting: WatermarkSetting }) {
  const size = `${Math.round(setting.scale * 100)}%`;
  return (
    <figure className="v2-sheet" aria-label="Preview of a downloaded worksheet">
      <div className="v2-sheet-band"><span>Fatema Hussain</span><span>TR 40231</span><span>Nairobi</span><span>10 Nov 2026</span></div>
      <div className="v2-sheet-body">
        {Array.from({ length: 7 }, (_, i) => <div key={i} className="v2-sheet-line"><span dir="rtl">{i % 2 ? 'بسم الله' : 'ا ب ت ث'}</span></div>)}
        {src && setting.position !== 'diagonal-tile' && (
          <img src={src} alt="" className={`v2-wm v2-wm-${setting.position}`} style={{ opacity: setting.opacity, width: size }} />
        )}
        {src && setting.position === 'diagonal-tile' && (
          <div className="v2-wm-tile" style={{ opacity: setting.opacity, backgroundImage: `url("${src}")`, backgroundSize: `${Math.max(12, Math.round(setting.scale * 50))}%` }} />
        )}
        {!src && <span className="v2-wm-empty">No watermark image yet</span>}
      </div>
      <figcaption className="v2-sheet-foot">© Funun al-Quran · All rights reserved</figcaption>
    </figure>
  );
}

function OfficerEditor({ value, onChange, disabled, scope, branches }: { value: string | null; onChange: (v: unknown) => void; disabled: boolean; scope: string; branches: Branch[] }) {
  const [staff, setStaff] = useState<StaffRow[] | null>(null);
  useEffect(() => { setStaff(null); void loadStaff(scope || null).then(setStaff); }, [scope]);
  const name = (id: string) => branches.find(b => b.id === id)?.name ?? '';
  const chosen = staff?.find(s => s.id === value);
  const groups = useMemo(() => {
    const g = new Map<string, StaffRow[]>();
    (staff ?? []).forEach(s => { const k = name(s.branch_id) || 'Other'; g.set(k, [...(g.get(k) ?? []), s]); });
    return Array.from(g.entries());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staff, branches]);
  return (
    <div className="v2-stack-sm">
      <select className="field" value={value ?? ''} disabled={disabled || !staff} onChange={e => onChange(e.target.value || null)} aria-label="Merit officer">
        <option value="">{staff ? 'No one chosen yet' : 'Loading staff…'}</option>
        {scope
          ? (staff ?? []).map(s => <option key={s.id} value={s.id}>{s.name} · {s.role === 'admin' ? 'Admin' : s.is_coordinator ? 'Coordinator' : 'Teacher'}</option>)
          : groups.map(([g, list]) => <optgroup key={g} label={g}>{list.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</optgroup>)}
        {value && staff && !chosen && <option value={value}>Someone from another branch</option>}
      </select>
      {chosen ? <p className="v2-help"><Bell size={12} /> {chosen.name} ({chosen.email}) gets the monthly reminder too and can mark points as given.</p>
        : <p className="v2-help">{scope ? 'Optional — the branch admin can always give points.' : 'Each branch may pick one person — choose a branch above.'}</p>}
    </div>
  );
}

function NudgeEditor({ value, onChange, disabled }: { value: string; onChange: (v: unknown) => void; disabled: boolean }) {
  const [el, setEl] = useState<HTMLTextAreaElement | null>(null);
  const insert = (token: string) => {
    if (!el) { onChange(`${value}${token}`); return; }
    const s = el.selectionStart; const e = el.selectionEnd;
    onChange(value.slice(0, s) + token + value.slice(e));
    window.requestAnimationFrame(() => { el.focus(); el.selectionStart = el.selectionEnd = s + token.length; });
  };
  const preview = value.replace(/\{name\}/g, 'Fatema').replace(/\{course\}/g, 'Naskh — Al-Usloob al-Awwal').replace(/\{days\}/g, '186');
  return (
    <div className="v2-stack-sm">
      <textarea ref={setEl} className="field v2-textarea" dir="auto" rows={4} value={value} disabled={disabled} onChange={e => onChange(e.target.value)} />
      {!disabled && (
        <div className="v2-token-row">
          <span className="muted">Insert:</span>
          {['{name}', '{course}', '{days}'].map(t => <button key={t} type="button" className="v2-token" onClick={() => insert(t)}>{t}</button>)}
        </div>
      )}
      <div className="v2-preview-bubble"><span className="v2-mini-label">Fatema will read (by email)</span><p dir="auto">{preview || '—'}</p></div>
    </div>
  );
}
