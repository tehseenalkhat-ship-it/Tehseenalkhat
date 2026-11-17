import { codeNumber } from './marks';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, Camera, CheckCircle2, Image as ImageIcon, Loader2, Plus, Send, X } from 'lucide-react';
import { apiFetch } from '@/api';
import type { Attachment, Submission } from '../contracts';
import { LocalFileThumb } from './Thumbs';
import { ACCEPT_FILES, acceptable, uploadAttachment } from './upload';

type Slot = { id: string; code: string | null; title: string; hint: string; files: File[] };

/**
 * "Send for review": one slot per earlier step of the level (assessment) plus the sheet itself.
 * Validates, uploads with progress, then POST /v2/threads/:stepId/submit.
 */
export function SubmitSheet({ stepId, stepTitle, priorSteps, attemptNo, maxFiles, onClose, onSubmitted, sendLabel = 'Send for assessment', initialFiles = [], initialNote = '' }: {
  stepId: string;
  /** Files the student already picked with the paperclip — they go into the main (last) slot. */
  initialFiles?: File[];
  initialNote?: string;
  stepTitle: string;
  sendLabel?: string;
  priorSteps: { id: string; code: string; title: string }[];
  attemptNo: number;
  maxFiles: number;
  onClose: () => void;
  onSubmitted: (s: Submission) => void;
}) {
  const assessment = priorSteps.length > 0;
  const [slots, setSlots] = useState<Slot[]>(() => [
    ...priorSteps.map(s => ({ id: s.id, code: s.code, title: s.title, hint: 'Your worksheet for this step', files: [] as File[] })),
    { id: stepId, code: null, title: assessment ? 'Assessment sheet' : 'Your work', hint: assessment ? 'The sheet you wrote for this assessment — this is the one that gets the mark' : 'Photos or a PDF of your work', files: initialFiles.filter(acceptable) },
  ]);
  const [note, setNote] = useState(initialNote);
  const [showErrors, setShowErrors] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; phase: 'upload' | 'send' } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const firstMissingRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !progress) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, progress]);

  const total = slots.reduce((s, x) => s + x.files.length, 0);
  const missing = slots.filter(s => !s.files.length);
  const tooMany = total > maxFiles;

  const add = (slotId: string, list: FileList | null) => {
    if (!list?.length) return;
    const ok = [...list].filter(acceptable);
    setSlots(prev => prev.map(s => (s.id === slotId ? { ...s, files: [...s.files, ...ok] } : s)));
    setError(ok.length < list.length ? 'Only photos and PDF files can be sent.' : null);
  };
  const remove = (slotId: string, i: number) => setSlots(prev => prev.map(s => (s.id === slotId ? { ...s, files: s.files.filter((_, j) => j !== i) } : s)));

  const submit = async () => {
    if (missing.length || tooMany) {
      setShowErrors(true);
      window.setTimeout(() => firstMissingRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 0);
      return;
    }
    setError(null);
    const queue = slots.flatMap(s => s.files.map(f => ({ file: f, forStepId: s.id })));
    setProgress({ done: 0, total: queue.length, phase: 'upload' });
    try {
      const uploaded: Attachment[] = [];
      for (const [i, item] of queue.entries()) {
        uploaded.push(await uploadAttachment('threads', item.file, item.forStepId));
        setProgress({ done: i + 1, total: queue.length, phase: 'upload' });
      }
      setProgress({ done: queue.length, total: queue.length, phase: 'send' });
      const sub = await apiFetch<Submission>(`/v2/threads/${stepId}/submit`, { method: 'POST', body: { files: uploaded, note: note.trim() || undefined } });
      onSubmitted(sub);
    } catch (err) {
      setProgress(null);
      setError(err instanceof Error ? err.message : 'Your work could not be sent. Check your connection and try again.');
    }
  };

  const pct = progress ? Math.round(((progress.done + (progress.phase === 'send' ? 0.5 : 0)) / Math.max(1, progress.total + 0.5)) * 100) : 0;
  let firstMissingAssigned = false;

  // Rendered on <body> so it is never squeezed inside the chat panel (phones get a full-screen sheet).
  return createPortal(
    <div className="modal-backdrop v2-sheet-backdrop v3ch-submit-backdrop" onClick={() => { if (!progress) onClose(); }}>
      <div className="v2-sheet v3ch-submit-sheet" role="dialog" aria-modal="true" aria-labelledby="v2-submit-title" onClick={e => e.stopPropagation()}>
        <header className="v2-sheet-head">
          <div>
            <p className="eyebrow">{attemptNo > 1 ? `Attempt ${attemptNo}` : sendLabel}</p>
            <h2 id="v2-submit-title">{stepTitle}</h2>
            <p className="muted">{assessment ? 'Add a clear photo of each worksheet from this level, then your assessment sheet.' : 'Add clear photos (or a PDF) of your work.'}</p>
          </div>
          <button type="button" className="v2-icon-btn" onClick={onClose} disabled={!!progress} aria-label="Close"><X size={20} /></button>
        </header>

        <div className="v2-sheet-body">
          {slots.map((s, idx) => {
            const isMissing = showErrors && !s.files.length;
            const refProp = isMissing && !firstMissingAssigned ? (firstMissingAssigned = true, { ref: firstMissingRef }) : {};
            const last = idx === slots.length - 1;
            return (
              <div key={s.id} className={`v2-slot${isMissing ? ' is-missing' : ''}${s.files.length ? ' is-done' : ''}${last && assessment ? ' is-main' : ''}`} {...refProp}>
                <div className="v2-slot-head">
                  <span className="v2-slot-num">{s.files.length ? <CheckCircle2 size={20} /> : s.code ? (codeNumber(s.code) ?? '•') : '★'}</span>
                  <div>
                    <strong>{s.code && codeNumber(s.code) ? `Step ${codeNumber(s.code)} · ${s.title}` : s.title}</strong>
                    <small>{isMissing ? 'Please add a photo here' : s.hint}</small>
                  </div>
                </div>
                <div className="v2-slot-files">
                  {s.files.map((f, i) => <LocalFileThumb key={`${f.name}-${i}`} file={f} onRemove={progress ? undefined : () => remove(s.id, i)} />)}
                  {!progress && (
                    <>
                      <label className="v2-slot-add">
                        <Camera size={20} /><span>{s.files.length ? 'Add page' : 'Camera'}</span>
                        <input type="file" accept="image/*" capture="environment" onChange={e => { add(s.id, e.target.files); e.target.value = ''; }} />
                      </label>
                      <label className="v2-slot-add">
                        {s.files.length ? <Plus size={20} /> : <ImageIcon size={20} />}<span>{s.files.length ? 'More' : 'Photos / PDF'}</span>
                        <input type="file" accept={ACCEPT_FILES} multiple onChange={e => { add(s.id, e.target.files); e.target.value = ''; }} />
                      </label>
                    </>
                  )}
                </div>
              </div>
            );
          })}
          <label className="field-label v2-sheet-note">Note to your teacher (optional)
            <textarea className="field" rows={2} value={note} onChange={e => setNote(e.target.value)} disabled={!!progress} maxLength={1000} />
          </label>
        </div>

        <footer className="v2-sheet-foot">
          {progress ? (
            <div className="v2-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Sending your work">
              <div className="v2-progress-label"><Loader2 size={15} className="v2-spin" /> {progress.phase === 'upload' ? `Uploading ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…` : 'Sending to your teacher…'}</div>
              <div className="v2-progress-track"><i style={{ width: `${pct}%` }} /></div>
            </div>
          ) : (
            <>
              {(showErrors && (missing.length > 0 || tooMany)) && (
                <p className="v2-inline-error" role="alert"><AlertCircle size={15} /> {tooMany ? `Please send at most ${maxFiles} files.` : `${missing.length} ${missing.length === 1 ? 'photo is' : 'photos are'} still missing.`}</p>
              )}
              {error && <p className="v2-inline-error" role="alert">{error}</p>}
              <div className="v2-sheet-actions">
                <span className="muted">{total} file{total === 1 ? '' : 's'} · {slots.length - missing.length}/{slots.length} ready</span>
                <button type="button" className="btn btn-primary" onClick={() => void submit()}><Send size={16} /> {sendLabel}</button>
              </div>
            </>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
