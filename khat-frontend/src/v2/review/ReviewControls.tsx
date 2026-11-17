import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Loader2, Send, Undo2 } from 'lucide-react';
import { apiFetch } from '@/api';
import type { RefineCommentRequest, RefineCommentResponse, ReviewDecision, Submission } from '../contracts';
import { bandLabel } from '../chat/media';
import { bandFor, type ReviewPolicies } from './policies';
import './review.css';
import './review-v3.css';

export const QUICK_SEND_MS = 2500;

export type ReviewDraft = ReturnType<typeof useReviewDraft>;

/**
 * State of one review (mark, rubric, comment, AI suggestion) and the send flow.
 * One tap on a quick mark starts a short countdown ("Sending 7/10… Undo") and then sends —
 * typing a comment or touching the rubric pauses it so the teacher can finish.
 */
export function useReviewDraft(opts: {
  submissionId: string | null;
  studentName?: string | null;
  hasMarks: boolean;
  policies: ReviewPolicies;
  beforeSend?: () => Promise<void>;
  onSent: (submission: Submission, decision: ReviewDecision) => void;
}) {
  const { submissionId, hasMarks, policies } = opts;
  const [mark, setMark] = useState<number | null>(null);
  const [rubric, setRubric] = useState<Record<string, number>>({});
  const [rubricTouched, setRubricTouched] = useState(false);
  const [comment, setComment] = useState('');
  const [suggestion, setSuggestion] = useState<RefineCommentResponse | null>(null);
  const [refining, setRefining] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<{ mark: number; until: number } | null>(null);
  const timer = useRef<number | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // Reset when the item changes
  useEffect(() => {
    setMark(null); setRubric({}); setRubricTouched(false); setComment(''); setSuggestion(null); setError(null); setSending(false);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    setCountdown(null);
  }, [submissionId]);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const cancelCountdown = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    setCountdown(null);
  }, []);

  const send = useCallback(async (override?: { mark?: number | null }) => {
    const o = optsRef.current;
    if (!o.submissionId) return;
    cancelCountdown();
    const m = override?.mark !== undefined ? override.mark : mark;
    if (o.hasMarks && (m == null || m < 1)) { setError('Choose a mark from 1 to 10 first.'); return; }
    setSending(true);
    setError(null);
    try {
      await o.beforeSend?.();
      const decision: ReviewDecision = o.hasMarks
        ? { mark: m, rubric: rubricTouched && o.policies.rubric.length ? rubric : null, comment: comment.trim() || null }
        : { status: 'reviewed', comment: comment.trim() || null };
      const sub = await apiFetch<Submission>(`/v2/review/submissions/${o.submissionId}/decision`, { method: 'POST', body: decision });
      o.onSent(sub, decision);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The review could not be sent. Please try again.');
    } finally {
      setSending(false);
    }
  }, [mark, rubric, rubricTouched, comment, cancelCountdown]);

  const sendRef = useRef(send);
  sendRef.current = send;

  /** One tap: choose the mark and send after a short undo window. */
  const quickMark = useCallback((m: number) => {
    setMark(m);
    setError(null);
    if (timer.current) window.clearTimeout(timer.current);
    if (comment.trim() || rubricTouched) { setCountdown(null); return; }
    setCountdown({ mark: m, until: Date.now() + QUICK_SEND_MS });
    timer.current = window.setTimeout(() => { timer.current = null; setCountdown(null); void sendRef.current({ mark: m }); }, QUICK_SEND_MS);
  }, [comment, rubricTouched]);

  const chooseMark = useCallback((m: number) => { cancelCountdown(); setMark(m); setError(null); }, [cancelCountdown]);

  const updateComment = useCallback((v: string) => { cancelCountdown(); setComment(v); }, [cancelCountdown]);

  const setCriterion = useCallback((key: string, value: number) => {
    cancelCountdown();
    setRubricTouched(true);
    setRubric(prev => {
      const next = { ...prev, [key]: value };
      const total = policies.rubric.reduce((s, c) => s + (next[c.key] ?? 0), 0);
      const max = policies.rubric.reduce((s, c) => s + c.max, 0);
      if (max > 0) setMark(Math.max(1, Math.min(10, Math.round((total / max) * 10))));
      return next;
    });
  }, [policies.rubric, cancelCountdown]);

  const refine = useCallback(async () => {
    const o = optsRef.current;
    if (!comment.trim()) { setError('Write a few words first — the AI will polish them.'); return; }
    cancelCountdown();
    setRefining(true);
    setError(null);
    try {
      const body: RefineCommentRequest = { text: comment.trim(), studentName: o.studentName ?? null, mark, tone: 'warm' };
      setSuggestion(await apiFetch<RefineCommentResponse>('/v2/ai/refine-comment', { method: 'POST', body }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The comment helper is not available right now.');
    } finally {
      setRefining(false);
    }
  }, [comment, mark, cancelCountdown]);

  const acceptSuggestion = useCallback(() => { if (suggestion) setComment(suggestion.refined); setSuggestion(null); }, [suggestion]);

  return {
    mark, rubric, comment, suggestion, refining, sending, error, countdown, hasMarks, policies,
    band: mark != null ? bandFor(mark, policies.bands) : null,
    quickMark, chooseMark, updateComment, setCriterion, refine, acceptSuggestion,
    dismissSuggestion: () => setSuggestion(null), cancelCountdown, send, setError,
  };
}

/** Big one-tap mark buttons. Sits on top of the photo. */
export function QuickMarksBar({ draft, studentName }: { draft: ReviewDraft; studentName?: string | null }) {
  const [, force] = useState(0);
  useEffect(() => {
    if (!draft.countdown) return;
    const id = window.setInterval(() => force(x => x + 1), 200);
    return () => window.clearInterval(id);
  }, [draft.countdown]);

  if (!draft.hasMarks) return null;
  if (draft.sending) {
    return <div className="v2-qm is-status" role="status"><Loader2 size={18} className="v2-spin" /> Sending {draft.mark}/10{studentName ? ` to ${studentName}` : ''}…</div>;
  }
  if (draft.countdown) {
    const left = Math.max(0, draft.countdown.until - Date.now());
    return (
      <div className="v2-qm is-countdown" role="status" aria-live="assertive">
        <span className="v2-qm-progress" style={{ animationDuration: `${QUICK_SEND_MS}ms` }} />
        <strong className="v2-qm-big">{draft.countdown.mark}<small>/10</small></strong>
        <span className="v2-qm-text">Sending in {Math.ceil(left / 1000)}…</span>
        <button type="button" className="v2-qm-undo" onClick={draft.cancelCountdown}><Undo2 size={16} /> Undo</button>
        <button type="button" className="v2-qm-now" onClick={() => void draft.send()}><Send size={15} /> Send now</button>
      </div>
    );
  }
  // v3 integration: one flow — a mark tapped on the sheet is the same mark as in the panel below
  // (nothing is sent by surprise); "Send" sends it, or the teacher adds a comment first.
  return (
    <div className="v2-qm" role="group" aria-label="Choose a mark">
      <span className="v2-qm-label">Mark</span>
      {draft.policies.quickMarks.map(m => (
        <button key={m} type="button" className={`v2-qm-btn band-${bandFor(m, draft.policies.bands)}${draft.mark === m ? ' is-active' : ''}`} onClick={() => draft.chooseMark(m)} aria-label={`Choose ${m} out of 10`} aria-pressed={draft.mark === m}>{m}</button>
      ))}
      {draft.mark != null && <button type="button" className="v2-qm-now" onClick={() => void draft.send()}><Send size={15} /> Send {draft.mark}/10</button>}
    </div>
  );
}

/** What a mark means, in one line (shown whenever a mark is chosen). */
export function markMeaning(mark: number, bands: ReviewPolicies['bands']): string {
  const band = bandFor(mark, bands);
  if (band === 'revision') return 'Try again — the student practices the points you marked and sends it once more.';
  if (band === 'pass') return 'Pass — good work. The step is complete and the next level opens.';
  return 'Distinction — excellent work. The step is complete and the next level opens.';
}

/** 1–10 mark buttons that always sit next to the Send button (so there is always a place to give marks). */
export function MarkPad({ draft }: { draft: ReviewDraft }) {
  if (!draft.hasMarks) return null;
  return (
    <div className="v3-markpad" role="group" aria-label="Mark out of 10">
      <div className="v3-markpad-row">
        {Array.from({ length: 10 }, (_, i) => i + 1).map(m => (
          <button key={m} type="button" className={`band-${bandFor(m, draft.policies.bands)}${draft.mark === m ? ' is-active' : ''}`} aria-pressed={draft.mark === m} onClick={() => draft.chooseMark(m)} aria-label={`${m} out of 10`}>{m}</button>
        ))}
      </div>
      <p className="v3-markpad-meaning" aria-live="polite">{draft.mark != null ? <><b>{draft.mark}/10 · {bandLabel(bandFor(draft.mark, draft.policies.bands))}.</b> {markMeaning(draft.mark, draft.policies.bands)}</> : 'Tap a mark out of 10, then Send.'}</p>
    </div>
  );
}

/** Rubric (optional), comment with AI refine, and the Send button. */
export function ReviewComposer({ draft, compact = false, sendLabel }: { draft: ReviewDraft; compact?: boolean; sendLabel?: string }) {
  const [rubricOpen, setRubricOpen] = useState(false);
  const rubricTotal = draft.policies.rubric.reduce((s, c) => s + (draft.rubric[c.key] ?? 0), 0);
  const rubricMax = draft.policies.rubric.reduce((s, c) => s + c.max, 0);
  const needsMark = draft.hasMarks && draft.mark == null;
  const label = needsMark ? 'Choose a mark first' : sendLabel ?? (draft.hasMarks ? `Send ${draft.mark}/10${draft.comment.trim() ? ' with comment' : ''}` : 'Send feedback');
  return (
    <div className={`v2-rc${compact ? ' is-compact' : ''}`}>
      {draft.hasMarks && (
        <div className="v2-rc-head">
          <div className="v2-rc-mark" aria-live="polite">
            <strong>{draft.mark ?? '–'}</strong><small>/10</small>
            {draft.band && <span className={`chip chip-${draft.band === 'revision' ? 'amber' : draft.band === 'pass' ? 'blue' : 'green'}`}>{bandLabel(draft.band)}</span>}
          </div>
          {draft.policies.rubric.length > 0 && (
            <button type="button" className="v2-rc-rubric-toggle" aria-expanded={rubricOpen} onClick={() => setRubricOpen(o => !o)}>
              Rubric (optional){rubricOpen ? '' : rubricTotal ? ` · ${rubricTotal}/${rubricMax}` : ''} <ChevronDown size={15} className={rubricOpen ? 'v2-rot' : ''} />
            </button>
          )}
        </div>
      )}
      {draft.hasMarks && <p className="v2-rc-stepline"><b>1</b> Choose a mark</p>}
      <MarkPad draft={draft} />
      {rubricOpen && draft.policies.rubric.length > 0 && (
        <div className="v2-rc-rubric">
          {draft.policies.rubric.map(c => (
            <label key={c.key} className="v2-rc-crit">
              <span>{c.label}</span>
              <input type="range" min={0} max={c.max} step={1} value={draft.rubric[c.key] ?? 0} onChange={e => draft.setCriterion(c.key, Number(e.target.value))} aria-label={`${c.label}, out of ${c.max}`} />
              <b>{draft.rubric[c.key] ?? 0}/{c.max}</b>
            </label>
          ))}
          <small className="muted">The mark follows the rubric total. You can still tap a mark to change it.</small>
        </div>
      )}
      {draft.hasMarks && <p className="v2-rc-stepline"><b>2</b> Comment <span>(optional)</span></p>}
      <div className="v2-rc-comment">
        <textarea
          className="field"
          rows={compact ? 2 : 3}
          value={draft.comment}
          placeholder={draft.hasMarks ? 'Comment (optional) — if empty, a warm comment for this mark is sent' : 'Your feedback for the student'}
          onChange={e => draft.updateComment(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void draft.send(); } }}
          aria-label="Comment to the student"
        />
        <button type="button" className="v2-rc-refine" onClick={() => void draft.refine()} disabled={draft.refining || !draft.comment.trim()}>
          {draft.refining ? <><Loader2 size={15} className="v2-spin" /> Refining…</> : '✨ Refine with AI'}
        </button>
      </div>
      {draft.suggestion && (
        <div className="v2-rc-suggestion" role="region" aria-label="Suggested comment">
          <p className="eyebrow">{draft.suggestion.usedAi ? 'Suggested by AI' : 'Polished'}</p>
          <p>{draft.suggestion.refined}</p>
          <div className="v2-rc-suggestion-actions">
            <button type="button" className="btn btn-primary" onClick={draft.acceptSuggestion}><Check size={15} /> Use this</button>
            <button type="button" className="btn btn-outline" onClick={() => { draft.acceptSuggestion(); window.setTimeout(() => document.querySelector<HTMLTextAreaElement>('.v2-rc-comment textarea')?.focus(), 0); }}>Edit it</button>
            <button type="button" className="v2-link" onClick={draft.dismissSuggestion}>Keep mine</button>
          </div>
        </div>
      )}
      {draft.error && <p className="v2-inline-error" role="alert">{draft.error}</p>}
      {!draft.hasMarks && <p className="muted v2-rc-note">This step gets feedback only — no marks.</p>}
      {draft.hasMarks && <p className="v2-rc-stepline"><b>3</b> Send to the student</p>}
      <button type="button" className={`btn btn-primary v2-rc-send${needsMark ? ' is-waiting' : ''}`} onClick={() => void draft.send()} disabled={draft.sending || needsMark} aria-describedby={needsMark ? 'v2-rc-why' : undefined}>
        {draft.sending ? <Loader2 size={16} className="v2-spin" /> : <Send size={16} />} {draft.sending ? 'Sending…' : label}
      </button>
      {needsMark && <p className="v2-rc-why" id="v2-rc-why">Tap a mark from 1 to 10 above (or on the sheet) — then Send lights up.</p>}
    </div>
  );
}
