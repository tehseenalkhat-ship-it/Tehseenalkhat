import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, ChevronDown, ChevronUp, Keyboard, Loader2, RotateCcw } from 'lucide-react';
import { kindOf, stepLine, type ExtraAttemptResponse } from '../teacher/teacherTypes';
import { apiFetch } from '@/api';
import type { Annotation, InboxItem, Submission } from '../contracts';
import { Annotator, type AnnotatorHandle } from '../annotate/Annotator';
import { ThreadPanel } from '../chat/ThreadPanel';
import { initials, waitTone, waitingLabel } from '../chat/media';
import { QuickMarksBar, ReviewComposer, useReviewDraft } from './ReviewControls';
import { useHasMarks, type ReviewPolicies } from './policies';

/**
 * Split view for one inbox item: the sheet with the Annotator + one-tap marks on the left,
 * the student's thread on the right (stacked on a phone).
 * Keys: 1–9 / 0 choose a mark · Enter sends · J / K next / previous · Esc back to the inbox.
 */
export function ReviewWorkspace({ item, index, total, policies, onBack, onPrev, onNext, onSent }: {
  item: InboxItem;
  index: number;
  total: number;
  policies: ReviewPolicies;
  onBack: () => void;
  onPrev: () => void;
  onNext: () => void;
  onSent: (item: InboxItem, sub: Submission) => void;
}) {
  const sub = item.submission;
  const isOpen = sub.status === 'submitted' || sub.status === 'in_review';
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showKeys, setShowKeys] = useState(false);
  const annotatorRef = useRef<AnnotatorHandle>(null);
  const hasMarks = useHasMarks(item.step.stepType);

  useEffect(() => {
    let alive = true;
    setAnnotations([]);
    if (sub.status === 'submitted') void apiFetch(`/v2/review/submissions/${sub.id}/claim`, { method: 'POST', silent: true }).catch(() => undefined);
    apiFetch<Annotation[]>(`/v2/annotations?submissionId=${encodeURIComponent(sub.id)}`, { silent: true })
      .then(a => { if (alive) setAnnotations(Array.isArray(a) ? a : []); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [sub.id, sub.status]);

  const draft = useReviewDraft({
    submissionId: isOpen ? sub.id : null,
    studentName: item.student.name,
    hasMarks,
    policies,
    beforeSend: async () => { if (annotatorRef.current?.isDirty()) await annotatorRef.current.save(); },
    onSent: s => onSent(item, s),
  });

  const draftRef = useRef(draft);
  draftRef.current = draft;
  const keyHandler = useCallback((e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    const d = draftRef.current;
    if (/^[0-9]$/.test(e.key) && d.hasMarks && isOpen) { e.preventDefault(); d.chooseMark(e.key === '0' ? 10 : Number(e.key)); return; }
    if (e.key === 'Enter' && isOpen && t?.tagName !== 'BUTTON') { e.preventDefault(); void d.send(); return; }
    if (e.key.toLowerCase() === 'j') { e.preventDefault(); onNext(); return; }
    if (e.key.toLowerCase() === 'k') { e.preventDefault(); onPrev(); return; }
    if (e.key === 'Escape' && !document.querySelector('.v2-viewer, .v2-sheet')) { e.preventDefault(); onBack(); }
  }, [isOpen, onBack, onNext, onPrev]);
  useEffect(() => {
    window.addEventListener('keydown', keyHandler);
    return () => window.removeEventListener('keydown', keyHandler);
  }, [keyHandler]);

  const provisional = isOpen && sub.autoMarked && sub.mark != null;
  const [attemptBusy, setAttemptBusy] = useState(false);
  const [attemptMsg, setAttemptMsg] = useState<string | null>(null);
  useEffect(() => { setAttemptMsg(null); }, [sub.id]);
  const canGiveAttempt = !isOpen && sub.status === 'revision' && hasMarks && policies.maxAttempts > 0 && sub.attemptNo >= policies.maxAttempts;
  const giveAttempt = async () => {
    setAttemptBusy(true);
    try {
      const r = await apiFetch<ExtraAttemptResponse>(`/v2/review/submissions/${sub.id}/extra-attempt`, { method: 'POST', body: {} });
      setAttemptMsg(`${r.message} A kind message was sent in your name.`);
      setRefreshKey(k => k + 1);
    } catch (err) {
      setAttemptMsg(err instanceof Error ? err.message : 'Could not open another attempt. Please try again.');
    } finally { setAttemptBusy(false); }
  };
  const tone = waitTone(item.waitingHours);
  const fileLabel = (a: { forStepId?: string | null }, i: number) => (a.forStepId && a.forStepId === item.step.id ? `Sheet ${i + 1} · Assessment` : `Sheet ${i + 1}`);

  return (
    <div className="v2-ws" data-testid="review-workspace">
      <header className="v2-ws-bar">
        <button type="button" className="v2-ws-back" onClick={onBack} aria-label="Back to the inbox"><ArrowLeft size={19} /><span>Inbox</span></button>
        <span className="v2-avatar" aria-hidden="true">{initials(item.student.name)}</span>
        <span className="v2-ws-title">
          <strong>{item.student.name}</strong>
          <small>{stepLine(item.step, kindOf(item))}</small>
        </span>
        <span className={`v2-wait tone-${tone}`} title="Waiting time">{waitingLabel(item.waitingHours)}</span>
        <span className="v2-ws-count">{index + 1} of {total}</span>
        <div className="v2-ws-nav">
          <button type="button" onClick={onPrev} disabled={index <= 0} aria-label="Previous (K)"><ChevronUp size={18} /></button>
          <button type="button" onClick={onNext} disabled={index >= total - 1} aria-label="Next (J)"><ChevronDown size={18} /></button>
          <button type="button" className="v2-ws-keys" onClick={() => setShowKeys(s => !s)} aria-expanded={showKeys} aria-label="Keyboard shortcuts"><Keyboard size={17} /></button>
        </div>
      </header>
      {showKeys && <p className="v2-ws-keyhelp"><kbd>1</kbd>–<kbd>9</kbd>, <kbd>0</kbd> = 10 choose a mark · <kbd>Enter</kbd> send · <kbd>J</kbd>/<kbd>K</kbd> next / previous · <kbd>Esc</kbd> inbox · <kbd>P</kbd> pen, <kbd>H</kbd> highlighter, <kbd>E</kbd> eraser, <kbd>⌘Z</kbd> undo</p>}

      <div className="v2-ws-grid">
        <div className="v2-ws-sheet">
          <Annotator
            key={sub.id}
            ref={annotatorRef}
            submissionId={sub.id}
            files={sub.files}
            annotations={annotations}
            fileLabel={fileLabel}
            hideSave={isOpen}
            overlay={isOpen ? <QuickMarksBar draft={draft} studentName={item.student.name.split(' ')[0]} /> : undefined}
            onSaved={() => setRefreshKey(k => k + 1)}
            className="v2-ws-annotator"
          />
          {provisional && (
            <div className="v3-confirm-banner" role="region" aria-label="Automatic mark">
              <p>No reply came in 4 days, so <b>{sub.mark}/10</b> was sent to {item.student.name.split(' ')[0]} in your name with a kind message. The next level opens only after you confirm. Confirm it, or tap another mark below.</p>
              <button type="button" className="btn btn-primary" disabled={draft.sending} onClick={() => void draft.send({ mark: sub.mark ?? undefined })}>{draft.sending ? <Loader2 size={15} className="v2-spin" /> : <Check size={15} />} Confirm {sub.mark}/10</button>
            </div>
          )}
          {isOpen ? <ReviewComposer draft={draft} /> : (
            <div className="v2-ws-done">
              <span className={`chip chip-${sub.status === 'revision' ? 'amber' : 'green'}`}>{sub.status === 'revision' ? 'Asked to try again' : sub.status === 'passed' ? 'Passed' : 'Reviewed'}{sub.mark != null ? ` · ${sub.mark}/10` : ''}</span>
              <span className="muted">{sub.reviewedByName ? `by ${sub.reviewedByName}` : ''}{sub.autoMarked ? ' · auto-marked (staff only)' : ''}. You can still add marks on the sheet and save them.</span>
            </div>
          )}
          {canGiveAttempt && (
            <div className="v3-attempt-box">
              <p>{attemptMsg ?? `${item.student.name.split(' ')[0]} has used all ${policies.maxAttempts} attempts for this step and cannot send it again.`}</p>
              {!attemptMsg && <button type="button" className="btn btn-outline" disabled={attemptBusy} onClick={() => void giveAttempt()}>{attemptBusy ? <Loader2 size={15} className="v2-spin" /> : <RotateCcw size={15} />} Give one more attempt</button>}
            </div>
          )}
        </div>
        <div className="v2-ws-thread">
          <ThreadPanel key={`${item.step.id}-${item.student.id}`} stepId={item.step.id} studentId={item.student.id} mode="staff" hideReviewBar refreshKey={refreshKey} />
        </div>
      </div>
    </div>
  );
}
