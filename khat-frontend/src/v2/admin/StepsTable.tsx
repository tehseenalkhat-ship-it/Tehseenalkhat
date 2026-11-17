import { useEffect, useState } from 'react';
import {
  ChevronDown, Eye, EyeOff, ExternalLink, FileImage, FileText, GripVertical, MessageSquareText, Paperclip, Trash2, Video,
} from 'lucide-react';
import { apiFetch, getViewUrl } from '@/api';
import type { CourseDetail, Level, Step, StepFile, StepTypeDef } from '../contracts';
import { sizeLabel } from './naming';
import { errorText, formatDate, toast } from './shared';
import { StepContents } from './StepContents';

export type StepPatch = Partial<Pick<Step, 'title' | 'stepType' | 'message' | 'maxMarks' | 'badgeCode' | 'status' | 'videoUrl'>>;

const SIZE_SHORT: Record<string, string> = { '07': '0.7', '10': '1', '20': '2', '30': '3', NP: 'NP' };

export function FileChips({ step, sizes, typeDef }: { step: Step; sizes: string[]; typeDef: StepTypeDef | undefined }) {
  const sheets = step.files.filter(f => f.isCurrent !== false && (f.role === 'worksheet' || f.role === 'assessment_sheet'));
  const videos = step.files.filter(f => f.isCurrent !== false && f.role === 'video').length;
  const refs = step.files.filter(f => f.isCurrent !== false && (f.role === 'reference' || f.role === 'resource' || f.role === 'other')).length;
  const uploadOnly = typeDef?.studentAction === 'upload';
  const present = new Set(sheets.map(f => f.sizeCode ?? ''));
  const shown = Array.from(new Set([...sizes, ...Array.from(present).filter(Boolean)]));
  if (uploadOnly && !step.files.length) return <span className="v2-files-none">Student uploads</span>;
  return (
    <span className="v2-files">
      {shown.map(s => (
        <span key={s} className={`v2-size ${present.has(s) ? 'on' : 'off'}`} title={`${sizeLabel(s)} ${present.has(s) ? 'uploaded' : 'missing'}`}>{SIZE_SHORT[s] ?? s}</span>
      ))}
      {sheets.some(f => !f.sizeCode) && <span className="v2-size on" title="Sheet without size"><FileText size={11} /></span>}
      {(videos > 0 || step.videoUrl) && <span className="v2-size on" title={step.videoUrl ? 'Video link' : `${videos} video`}><Video size={11} />{videos > 1 ? videos : ''}</span>}
      {refs > 0 && <span className="v2-size on" title={`${refs} reference`}><Paperclip size={11} />{refs > 1 ? refs : ''}</span>}
      {!shown.length && !videos && !refs && !step.videoUrl && <span className="v2-files-none">No files yet</span>}
    </span>
  );
}

export function StepRow({
  course, level, step, typeOptions, stepTypes, selected, onSelect, onPatch, onDelete, canEdit, onReload,
  dragProps, onMove, isDragging, forceOpen, onStepReplaced,
}: {
  course: CourseDetail; level: Level; step: Step; typeOptions: StepTypeDef[]; stepTypes: StepTypeDef[];
  selected: boolean; onSelect: (v: boolean) => void; onPatch: (patch: StepPatch) => void; onDelete: () => void;
  canEdit: boolean; onReload: () => void;
  dragProps: React.HTMLAttributes<HTMLDivElement> & { draggable?: boolean }; onMove: (delta: number) => void; isDragging: boolean;
  forceOpen?: boolean; onStepReplaced?: (step: Step) => void;
}) {
  const [open, setOpen] = useState(Boolean(forceOpen));
  useEffect(() => { if (forceOpen) setOpen(true); }, [forceOpen]);
  const [title, setTitle] = useState(step.title);
  const [marks, setMarks] = useState(step.maxMarks == null ? '' : String(step.maxMarks));
  const [badge, setBadge] = useState(step.badgeCode ?? '');
  const [message, setMessage] = useState(step.message ?? '');
  const typeDef = stepTypes.find(t => t.typeKey === step.stepType);
  const hidden = step.status === 'hidden';
  const defaultBadge = `BDG_${course.code ?? 'COURSE'}_${level.code}`;

  // keep inputs in sync when the server copy changes
  const [seen, setSeen] = useState(step);
  if (seen !== step) {
    setSeen(step);
    setTitle(step.title); setMarks(step.maxMarks == null ? '' : String(step.maxMarks)); setBadge(step.badgeCode ?? ''); setMessage(step.message ?? '');
  }

  const options = typeOptions.some(t => t.typeKey === step.stepType) || !typeDef ? typeOptions : [...typeOptions, typeDef];

  return (
    <div className={`v2-step${hidden ? ' is-hidden' : ''}${selected ? ' is-selected' : ''}${isDragging ? ' is-dragging' : ''}${open ? ' is-open' : ''}`} {...dragProps}>
      <div className="v2-step-line">
        <label className="v2-check v2-step-check">
          <input type="checkbox" checked={selected} disabled={!canEdit} onChange={e => onSelect(e.target.checked)} aria-label={`Select ${step.code}`} />
        </label>
        {canEdit ? (
          <button
            type="button"
            className="v2-handle"
            aria-label={`Move ${step.code}. Use arrow up or down.`}
            title="Drag to reorder (or use arrow keys)"
            onKeyDown={e => { if (e.key === 'ArrowUp') { e.preventDefault(); onMove(-1); } if (e.key === 'ArrowDown') { e.preventDefault(); onMove(1); } }}
          ><GripVertical size={15} /></button>
        ) : <span />}
        <span className="v2-step-code">{step.code}</span>
        <div className="v2-step-task">
          <input
            className="v2-inline-input"
            value={title}
            placeholder="Task name"
            aria-label={`Task for ${step.code}`}
            disabled={!canEdit}
            onChange={e => setTitle(e.target.value)}
            onBlur={() => { if (title.trim() !== step.title) onPatch({ title: title.trim() }); }}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          />
          {step.message && !open && <button type="button" className="v2-step-msg" onClick={() => setOpen(true)}><MessageSquareText size={12} /><span>{step.message}</span></button>}
          {step.missing.length > 0 && <span className="v2-step-missing">Missing: {step.missing.join(', ')}</span>}
        </div>
        <select
          className="v2-inline-select v2-step-type"
          value={step.stepType}
          disabled={!canEdit}
          aria-label={`Type for ${step.code}`}
          onChange={e => onPatch({ stepType: e.target.value })}
        >
          {options.map(t => <option key={t.typeKey} value={t.typeKey}>{t.label}</option>)}
        </select>
        <div className="v2-step-marks">
          {typeDef?.hasMarks ? (
            <input
              className="v2-inline-input v2-num"
              inputMode="numeric"
              value={marks}
              placeholder="10"
              aria-label={`Marks for ${step.code}`}
              disabled={!canEdit}
              onChange={e => setMarks(e.target.value.replace(/[^0-9]/g, '').slice(0, 3))}
              onBlur={() => { const n = marks === '' ? null : Number(marks); if (n !== step.maxMarks) onPatch({ maxMarks: n }); }}
            />
          ) : <span className="v2-dash" title="This type has no marks">—</span>}
        </div>
        <div className="v2-step-badge">
          {typeDef?.awardsBadge ? (
            <input
              className="v2-inline-input"
              value={badge}
              placeholder={defaultBadge}
              aria-label={`Badge for ${step.code}`}
              disabled={!canEdit}
              onChange={e => setBadge(e.target.value)}
              onBlur={() => { if ((badge.trim() || null) !== step.badgeCode) onPatch({ badgeCode: badge.trim() || null }); }}
            />
          ) : <span className="v2-dash" title="This type gives no badge">—</span>}
        </div>
        <button type="button" className="v2-step-files" onClick={() => setOpen(o => !o)} aria-label={`Files of ${step.code}`}>
          <FileChips step={step} sizes={course.mistarSizes} typeDef={typeDef} />
        </button>
        <button
          type="button"
          className={`v2-icon-btn v2-eye${hidden ? ' off' : ''}`}
          disabled={!canEdit}
          aria-label={hidden ? `Show ${step.code} to students` : `Hide ${step.code} from students`}
          title={hidden ? 'Hidden from students — tap to show' : 'Visible to students — tap to hide'}
          onClick={() => onPatch({ status: hidden ? 'published' : 'hidden' })}
        >{hidden ? <EyeOff size={16} /> : <Eye size={16} />}</button>
        <button type="button" className={`v2-icon-btn v2-chev${open ? ' open' : ''}`} aria-expanded={open} aria-label={`More for ${step.code}`} onClick={() => setOpen(o => !o)}><ChevronDown size={17} /></button>
      </div>

      {open && (
        <div className="v2-step-more">
          <label className="field-label">Message to students <span className="v2-optional">optional</span>
            <textarea
              className="field v2-textarea-sm"
              dir="auto"
              value={message}
              disabled={!canEdit}
              placeholder={typeDef?.defaultInstructions || 'For example: Write this worksheet twice before you upload.'}
              onChange={e => setMessage(e.target.value)}
              onBlur={() => { if ((message.trim() || null) !== (step.message ?? null)) onPatch({ message: message.trim() || null }); }}
            />
          </label>
          <p className="v2-help">{message.trim() ? 'Students see this message on this step.' : typeDef?.defaultInstructions ? 'Empty — students see the usual instruction for this type (shown above in grey).' : 'Empty — no extra message is shown.'}</p>
          <StepContents
            course={course}
            step={step}
            typeDef={typeDef}
            canEdit={canEdit}
            onVideo={url => onPatch({ videoUrl: url })}
            onStep={fresh => (onStepReplaced ? onStepReplaced(fresh) : onReload())}
          />
          <details className="v3-all-files">
            <summary>All files of this step ({step.files.length})</summary>
            <StepFilesList step={step} canEdit={canEdit} onReload={onReload} />
          </details>
          {canEdit && (
            <div className="v2-step-more-actions">
              <button type="button" className="btn btn-outline v2-btn-sm" onClick={() => onMove(-1)}>Move up</button>
              <button type="button" className="btn btn-outline v2-btn-sm" onClick={() => onMove(1)}>Move down</button>
              <button type="button" className="v2-link v2-danger-link" onClick={onDelete}><Trash2 size={14} /> Remove step</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StepFilesList({ step, canEdit, onReload }: { step: Step; canEdit: boolean; onReload: () => void }) {
  if (!step.files.length) return <p className="v2-help">No files on this step yet. Drop files named …_{step.code}_… on the level above.</p>;
  const sorted = [...step.files].sort((a, b) => (a.role + (a.sizeCode ?? '') + a.page).localeCompare(b.role + (b.sizeCode ?? '') + b.page));
  const remove = async (f: StepFile) => {
    try {
      await apiFetch(`/v2/step-files/${f.id}`, { method: 'DELETE' });
      onReload();
      toast(`${f.canonicalName} removed.`, { action: { label: 'Undo', run: async () => { try { await apiFetch(`/v2/step-files/${f.id}/restore`, { method: 'POST' }); onReload(); } catch (err) { toast(errorText(err), { tone: 'error' }); } } } });
    } catch (err) { toast(errorText(err), { tone: 'error' }); }
  };
  const view = async (f: StepFile) => {
    try { window.open(await getViewUrl(f.storageKey), '_blank', 'noopener'); } catch (err) { toast(errorText(err), { tone: 'error' }); }
  };
  return (
    <ul className="v2-file-list">
      {sorted.map(f => (
        <li key={f.id}>
          {f.role === 'video' ? <Video size={15} /> : f.contentType?.includes('pdf') ? <FileText size={15} /> : <FileImage size={15} />}
          <div>
            <span className="v2-filename">{f.canonicalName || f.originalFilename}</span>
            <small>{[f.role.charAt(0).toUpperCase() + f.role.slice(1).replace('_', ' '), f.sizeCode ? sizeLabel(f.sizeCode) : null, f.page !== 'P01' ? `page ${f.page.slice(1)}` : null, `v${f.version}`, formatDate(f.uploadedAt), f.uploadedByName].filter(Boolean).join(' · ')}</small>
          </div>
          <button type="button" className="v2-icon-btn" aria-label={`Open ${f.canonicalName}`} onClick={() => void view(f)}><ExternalLink size={15} /></button>
          {canEdit && <button type="button" className="v2-icon-btn" aria-label={`Remove ${f.canonicalName}`} title="Remove (kept in history, can be undone)" onClick={() => void remove(f)}><Trash2 size={15} /></button>}
        </li>
      ))}
    </ul>
  );
}
