import { useState } from 'react';
import { ArrowRight, Award, Check, ChevronDown, Circle, Clock, Download, FileText, Image as ImageIcon, MessageCircle, Printer, RefreshCw, RotateCcw, Sparkles, Upload } from 'lucide-react';
import type { Level, MarkBand, Step, StepFile, StepTypeDef, StudentStepState } from '../contracts';
import { ThreadPanel } from '../chat/ThreadPanel';
import { openV2 } from '../nav';
import { isProvisionalState, PROVISIONAL_WORDS } from './home/studentText';
import { ImageLightbox, SignedImage, SignedVideo, sizeLabel, sortSizes, splitInstructions } from './shared';

export const DOWNLOAD_ROLES = ['worksheet', 'assessment_sheet', 'resource', 'other'];

const ROLE_LABELS: Record<string, string> = { worksheet: 'Worksheet', assessment_sheet: 'Assessment sheet', resource: 'Sheet', other: 'File', reference: 'Reference' };

export function pageLabel(page: string | null | undefined): string {
  const n = Number(String(page ?? '').replace(/\D/g, ''));
  return n ? `Page ${n}` : '';
}

function current(files: StepFile[]): StepFile[] {
  return files.filter(file => file.isCurrent !== false);
}

/** The downloadable sheets of a step for the student's size (plus sheets that have no size). */
export function sheetsForSize(step: Step, size: string | null): { files: StepFile[]; otherSizes: string[]; needsSize: boolean } {
  const docs = current(step.files).filter(file => DOWNLOAD_ROLES.includes(file.role));
  const sized = docs.filter(file => file.sizeCode);
  const generic = docs.filter(file => !file.sizeCode);
  const mine = size ? sized.filter(file => file.sizeCode!.toUpperCase() === size.toUpperCase()) : [];
  const files = [...mine, ...generic].sort((a, b) => (a.role === 'assessment_sheet' ? 1 : 0) - (b.role === 'assessment_sheet' ? 1 : 0) || a.page.localeCompare(b.page));
  const otherSizes = sortSizes(sized.map(file => file.sizeCode!)).filter(code => code !== size?.toUpperCase());
  return { files, otherSizes, needsSize: !size && sized.length > 0 };
}

export function fileTitle(file: StepFile, allFiles: StepFile[]): string {
  const sameRole = allFiles.filter(item => item.role === file.role);
  const parts = [ROLE_LABELS[file.role] ?? 'File'];
  if (sameRole.length > 1 && pageLabel(file.page)) parts.push(pageLabel(file.page));
  if (file.sizeCode) parts.push(sizeLabel(file.sizeCode));
  return parts.join(' · ');
}

export function isUploadStep(type: StepTypeDef | undefined): boolean {
  return type ? type.studentAction !== 'watch_download' : false;
}

function bandFor(mark: number | null, bands: { revisionMax: number; passMax: number }): MarkBand | null {
  if (mark == null) return null;
  if (mark <= bands.revisionMax) return 'revision';
  if (mark <= bands.passMax) return 'pass';
  return 'distinction';
}

export type StepStatus = 'todo' | 'done' | 'waiting' | 'passed' | 'revision' | 'replied';

/** One word for where the student is on a step — used by the step list, the nav and "My work". */
export function stepStatus(type: StepTypeDef | undefined, state: StudentStepState | undefined): StepStatus {
  const status = state?.submissionStatus ?? null;
  if (isUploadStep(type)) {
    if (status === 'passed') return 'passed';
    if (status === 'reviewed') return 'replied';
    if (status === 'revision') return 'revision';
    if (status === 'submitted' || status === 'in_review') return 'waiting';
    return state?.done ? 'done' : 'todo';
  }
  return state?.done ? 'done' : 'todo';
}

export const STATUS_TEXT: Record<StepStatus, string> = {
  todo: 'To do', done: 'Done', waiting: 'With your teacher', passed: 'Passed', revision: 'Try again', replied: 'Teacher replied',
};

export function StatusIcon({ status, number }: { status: StepStatus; number: string }) {
  const icon = status === 'done' || status === 'passed' || status === 'replied' ? <Check size={15} strokeWidth={2.6} />
    : status === 'waiting' ? <Clock size={15} />
    : status === 'revision' ? <RotateCcw size={14} />
    : <span>{number}</span>;
  return <span className={`v2s-status-icon is-${status}`} aria-hidden="true">{icon}</span>;
}

export type StepCardProps = {
  step: Step;
  level: Level;
  type: StepTypeDef | undefined;
  state: StudentStepState | undefined;
  size: string | null;
  enrolled: boolean;
  bands: { revisionMax: number; passMax: number };
  maxAttempts: number | null;
  printInstructions: string;
  printMode: boolean;
  open: boolean;
  onToggleOpen: () => void;
  selected: Set<string>;
  onToggleSelect: (fileId: string) => void;
  onDownload: (file: StepFile, label: string) => Promise<void>;
  downloadingId: string | null;
  onToggleDone: (step: Step, done: boolean) => void;
  onAskSize: () => void;
  onChanged: () => void;
  onShowcase: (step: Step) => void;
};

/** A step as one row of the level's ordered list; tapping it opens the step (one at a time). */
export function CourseStepCard(props: StepCardProps) {
  const { step, level, type, state, size, enrolled, bands, maxAttempts, printInstructions, printMode, open, onToggleOpen, selected, onToggleSelect, onDownload, downloadingId, onToggleDone, onAskSize, onChanged, onShowcase } = props;
  const [lightbox, setLightbox] = useState<{ url: string; alt: string } | null>(null);
  const upload = isUploadStep(type);
  const status = stepStatus(type, state);
  const videos = current(step.files).filter(file => file.role === 'video');
  const references = current(step.files).filter(file => file.role === 'reference');
  const sheets = sheetsForSize(step, size);
  const instructionItems = splitInstructions(step.message?.trim() || type?.defaultInstructions || '');
  const band = state?.band ?? bandFor(state?.mark ?? null, bands);
  const attemptsLeft = maxAttempts && maxAttempts > 0 ? Math.max(0, maxAttempts - (state?.attemptsUsed ?? 0)) : null;
  const priorSteps = type?.requiresPriorUploads
    ? level.steps.filter(item => item.orderIndex < step.orderIndex && item.id !== step.id).map(item => ({ id: item.id, code: item.code, title: item.title }))
    : [];
  const provisional = isProvisionalState(state);
  const markText = state?.mark != null && (status === 'passed' || status === 'revision') ? `${state.mark}/10` : provisional ? `Marked ${state?.mark}/10 · ${PROVISIONAL_WORDS}` : null;
  const unread = state?.unreadMessages ?? 0;
  const bodyId = `v2s-step-body-${step.id}`;
  const stepLabel = `Step ${level.steps.filter(item => item.orderIndex <= step.orderIndex).length || 1}`;

  // Print-several mode: the row becomes a plain checklist of this step's sheets.
  if (printMode) {
    if (sheets.files.length === 0) return null;
    return (
      <li className="v2s-step-row is-print" id={`v2s-step-${step.id}`}>
        <ul className="v2s-file-list">
          {sheets.files.map(file => (
            <li key={file.id} className={`v2s-file${selected.has(file.id) ? ' is-checked' : ''}`}>
              <label className="v2s-file-check">
                <input type="checkbox" checked={selected.has(file.id)} onChange={() => onToggleSelect(file.id)} />
                <span><strong>{stepLabel} · {step.title || type?.label}</strong><small>{fileTitle(file, sheets.files)}</small></span>
              </label>
            </li>
          ))}
        </ul>
      </li>
    );
  }

  return (
    <li className={`v2s-step-row is-${status}${open ? ' is-open' : ''}`} id={`v2s-step-${step.id}`}>
      <button type="button" className="v2s-step-summary" onClick={onToggleOpen} aria-expanded={open} aria-controls={bodyId}>
        <StatusIcon status={status} number={String(Number(step.code.replace(/\D/g, '')) || step.orderIndex + 1)} />
        <span className="v2s-step-name">
          <strong>{step.title || type?.label || stepLabel}</strong>
          <small>{stepLabel} · {type?.label ?? 'Step'}<span className="v2s-step-state"> · {STATUS_TEXT[status]}{markText ? ` · ${markText}` : ''}</span></small>
        </span>
        {unread > 0 && <span className="v2s-unread" aria-label={`${unread} new messages`}><MessageCircle size={12} /> {unread}</span>}
        <ChevronDown size={18} className="v2s-step-chevron" aria-hidden="true" />
      </button>

      {open && (
        <div className="v2s-step-body" id={bodyId}>
          {(status === 'passed') && band !== 'revision' && (
            <div className={`v2s-celebrate${band === 'distinction' ? ' is-distinction' : ''}`} role="status">
              <span className="v2s-celebrate-icon" aria-hidden="true">{band === 'distinction' ? <Sparkles size={20} /> : <Award size={20} />}</span>
              <div>
                <strong>{band === 'distinction' ? 'Distinction — beautiful work!' : 'You passed — well done!'}</strong>
                <p>{type?.awardsBadge ? `Level badge earned.${type.gatesProgress ? ' The next level is open.' : ''}` : 'Keep this lovely rhythm going.'}</p>
              </div>
              <button type="button" className="v2s-link-button v2s-celebrate-share" onClick={() => onShowcase(step)}><Sparkles size={14} /> Request to showcase</button>
            </div>
          )}

          {status === 'revision' && (
            <div className="v2s-try-again" role="status">
              <RotateCcw size={17} aria-hidden="true" />
              <div>
                <strong>Almost there — let's try once more</strong>
                <p>Read your teacher's notes in the chat below, practice the marked letters again and send a fresh attempt.
                  {attemptsLeft != null && (attemptsLeft > 0 ? ` You have ${attemptsLeft} ${attemptsLeft === 1 ? 'attempt' : 'attempts'} left.` : ' You have used all your attempts — your teacher will guide you in the chat.')}</p>
              </div>
            </div>
          )}

          {instructionItems.length > 0 && (
            <div className={`v2s-step-message${step.message ? ' is-own' : ''}`}>
              {step.message && <p className="v2s-step-message-label">Note from your teacher</p>}
              {instructionItems.length > 1
                ? <ol>{instructionItems.map((item, index) => <li key={index}>{item}</li>)}</ol>
                : <p>{instructionItems[0]}</p>}
            </div>
          )}

          {videos.map(video => <SignedVideo key={video.id} storageKey={video.storageKey} title={`${stepLabel} video`} />)}

          {references.length > 0 && (
            <div className="v2s-step-block">
              <p className="v2s-block-label"><ImageIcon size={13} aria-hidden="true" /> Reference</p>
              <div className="v2s-reference-row">
                {references.map(ref => (
                  <div className="v2s-reference" key={ref.id}>
                    {(ref.contentType ?? '').includes('pdf')
                      ? <span className="v2s-media-placeholder"><FileText size={20} /><small>PDF reference</small></span>
                      : <SignedImage storageKey={ref.storageKey} alt={`${stepLabel} reference`} onClickUrl={url => setLightbox({ url, alt: `${stepLabel} reference` })} />}
                    {enrolled && <button type="button" className="v2s-link-button" onClick={() => void onDownload(ref, `${stepLabel} reference`)} disabled={downloadingId === ref.id}>
                      {downloadingId === ref.id ? <RefreshCw size={13} className="v2s-spin" /> : <Download size={13} />} Download reference
                    </button>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {(sheets.files.length > 0 || sheets.needsSize || sheets.otherSizes.length > 0) && (
            <div className="v2s-step-block">
              <p className="v2s-block-label"><FileText size={13} aria-hidden="true" /> {type?.typeKey === 'assessment' ? 'Assessment sheet' : 'Worksheet'}{size ? ` · ${sizeLabel(size)}` : ''}</p>
              {sheets.needsSize ? (
                <button type="button" className="v2s-size-nudge" onClick={onAskSize}>Choose your mistar size to see your worksheet</button>
              ) : sheets.files.length === 0 ? (
                <p className="v2s-soft-note">Not ready in {sizeLabel(size)} yet — available in {sheets.otherSizes.map(sizeLabel).join(', ')}. <button type="button" className="v2s-link-button" onClick={onAskSize}>Change size</button></p>
              ) : (
                <ul className="v2s-file-list">
                  {sheets.files.map(file => {
                    const label = fileTitle(file, sheets.files);
                    return (
                      <li key={file.id} className="v2s-file">
                        <span className="v2s-file-copy"><strong>{label}</strong><small>PDF, ready to print</small></span>
                        {enrolled
                          ? <button type="button" className="btn btn-primary v2s-download-btn" onClick={() => void onDownload(file, `${stepLabel} ${label}`)} disabled={downloadingId === file.id} aria-label={`Download ${label}`}>
                              {downloadingId === file.id ? <><RefreshCw size={14} className="v2s-spin" /> Preparing…</> : <><Download size={14} /> Download</>}
                            </button>
                          : <span className="v2s-soft-note">Start the course to download</span>}
                      </li>
                    );
                  })}
                </ul>
              )}
              {enrolled && sheets.files.length > 0 && printInstructions && <p className="v2s-print-note"><Printer size={13} aria-hidden="true" /> {printInstructions}</p>}
            </div>
          )}

          {enrolled && !upload && (
            <div className="v2s-step-actions">
              {state?.done ? (
                <>
                  <span className="v2s-done-note"><Check size={16} /> Marked as done</span>
                  <button type="button" className="v2s-link-button" onClick={() => onToggleDone(step, false)}>Undo</button>
                </>
              ) : (
                <button type="button" className="btn btn-primary v2s-done-btn" onClick={() => onToggleDone(step, true)}><Check size={16} /> Mark as done</button>
              )}
            </div>
          )}

          {enrolled && upload && (
            <div className="v2s-step-thread">
              <p className="v2s-block-label"><Upload size={13} aria-hidden="true" /> {priorSteps.length ? 'Upload your worksheets and the assessment sheet' : 'Upload your work'} — your teacher replies here</p>
              <ThreadPanel stepId={step.id} mode="student" compact submission={{ required: true, priorSteps }} onChanged={onChanged} />
            </div>
          )}

          <button type="button" className="btn btn-outline v2s-open-task" onClick={() => openV2('v2-task', { courseId: level.courseId, stepId: step.id })}>Open this step on its own page <ArrowRight size={15} /></button>

          {!enrolled && <p className="v2s-soft-note"><Circle size={10} aria-hidden="true" /> Start the course to work on this step.</p>}
        </div>
      )}

      {lightbox && <ImageLightbox url={lightbox.url} alt={lightbox.alt} onClose={() => setLightbox(null)} />}
    </li>
  );
}
