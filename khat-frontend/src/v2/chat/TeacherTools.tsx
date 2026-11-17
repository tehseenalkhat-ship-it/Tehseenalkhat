import { useEffect, useState } from 'react';
import { Building2, Check, Loader2, PenLine, Sparkles, Type, X } from 'lucide-react';
import { apiFetch } from '@/api';
import type { RefineCommentResponse, ReviewDecision, Submission } from '../contracts';
import { bandFrom, bandName, markMeaning } from './marks';
import { SendIcon } from './VoicePlayer';

const MARKS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
export const FONT_STEPS = [
  { key: 's', label: 'Small', px: 13.5 },
  { key: 'm', label: 'Normal', px: 15 },
  { key: 'l', label: 'Large', px: 17 },
  { key: 'xl', label: 'Extra large', px: 19.5 },
];
const FONT_KEY = 'v3_chat_font';
export function useChatFont(): [number, () => void] {
  const [i, setI] = useState(() => {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(FONT_KEY) : null;
    const idx = FONT_STEPS.findIndex(f => f.key === v);
    return idx >= 0 ? idx : 1;
  });
  const next = () => setI(x => { const n = (x + 1) % FONT_STEPS.length; try { localStorage.setItem(FONT_KEY, FONT_STEPS[n].key); } catch { /* ignore */ } return n; });
  return [i, next];
}

/**
 * Teacher tools above the composer (fewest taps): marks 1–10 as buttons → meaning + Send,
 * "Mark on the sheet", "Ask to meet", AI helper and text size.
 */
export function TeacherTools({ submission, hasMarks, bands, studentName, comment, onCommentUsed, onSent, onAnnotate, onMeet, onAi, fontIndex, onFont, beforeSend, compactMarks = false }: {
  submission: Submission | null;              // open submission waiting for marks / feedback
  hasMarks: boolean;
  bands: { revisionMax: number; passMax: number };
  studentName: string;
  comment: string;                            // text in the composer: sent with the mark
  onCommentUsed: () => void;
  onSent: (s: Submission) => void;
  onAnnotate?: (() => void) | null;
  onMeet?: (() => void) | null;
  onAi?: (() => void) | null;
  fontIndex?: number;
  onFont?: (() => void) | null;
  beforeSend?: () => Promise<void>;
  compactMarks?: boolean;
}) {
  const [mark, setMark] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setMark(null); setError(null); }, [submission?.id]);
  const first = studentName.split(/\s+/)[0] || 'the student';

  const send = async (decision: ReviewDecision) => {
    if (!submission) return;
    setSending(true);
    setError(null);
    try {
      await beforeSend?.();
      const sub = await apiFetch<Submission>(`/v2/review/submissions/${submission.id}/decision`, { method: 'POST', body: decision });
      setMark(null);
      onCommentUsed();
      onSent(sub);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send. Please try again.');
    } finally {
      setSending(false);
    }
  };

  const band = mark != null ? bandFrom(mark, bands) : null;
  return (
    <div className="v3ch-tools" aria-label="Teacher tools">
      {submission && hasMarks && (
        <div className="v3ch-marks">
          <div className="v3ch-marks-head">
            <strong>Give marks out of 10</strong>
            <small>{mark == null ? 'Tap a number' : `${first} will see it in this chat`}</small>
          </div>
          <div className={`v3ch-marks-row${compactMarks ? ' is-compact' : ''}`} role="group" aria-label="Marks out of 10">
            {MARKS.map(m => (
              <button key={m} type="button" className={`v3ch-mark band-${bandFrom(m, bands)}${mark === m ? ' is-active' : ''}`} aria-pressed={mark === m} onClick={() => { setMark(m); setError(null); }} disabled={sending}>{m}</button>
            ))}
          </div>
          {mark != null && band && (
            <div className={`v3ch-mark-meaning band-${band}`} role="status" aria-live="polite">
              <div className="v3ch-mark-meaning-text">
                <strong>{mark}/10 · {bandName(band)}</strong>
                <span>{markMeaning(mark, band)}</span>
                <small>{comment.trim() ? 'Your message below will be sent with the mark.' : 'Type a comment below, or send now — a warm comment is added for you.'}</small>
              </div>
              <div className="v3ch-mark-meaning-actions">
                <button type="button" className="v3ch-ghost" onClick={() => setMark(null)} disabled={sending}><X size={15} /> Cancel</button>
                <button type="button" className="v3ch-solid" onClick={() => void send({ mark, comment: comment.trim() || null, rubric: null })} disabled={sending}>
                  {sending ? <Loader2 size={16} className="v2-spin" /> : <SendIcon size={16} />} Send {mark}/10
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {submission && !hasMarks && (
        <div className="v3ch-marks is-feedback">
          <div className="v3ch-marks-head">
            <strong>Feedback only — no marks for this step</strong>
            <small>{comment.trim() ? 'Your message below will be sent as the feedback.' : 'Type your feedback below (or send a voice note), then press the button.'}</small>
          </div>
          <button type="button" className="v3ch-solid" onClick={() => void send({ status: 'reviewed', comment: comment.trim() || null })} disabled={sending}>
            {sending ? <Loader2 size={16} className="v2-spin" /> : <Check size={16} />} Send feedback · mark as reviewed
          </button>
        </div>
      )}
      {error && <p className="v2-inline-error" role="alert">{error}</p>}
      <div className="v3ch-chips" role="toolbar" aria-label="More">
        {onAnnotate && <button type="button" className="v3ch-chip" onClick={onAnnotate}><PenLine size={15} /> Mark on the sheet</button>}
        {onMeet && <button type="button" className="v3ch-chip" onClick={onMeet}><Building2 size={15} /> Ask to meet</button>}
        {onAi && <button type="button" className="v3ch-chip is-ai" onClick={onAi}><Sparkles size={15} /> AI helper</button>}
        {onFont && <button type="button" className="v3ch-chip" onClick={onFont} aria-label={`Text size: ${FONT_STEPS[fontIndex ?? 1].label}. Tap to change.`}><Type size={15} /> {FONT_STEPS[fontIndex ?? 1].label} text</button>}
      </div>
    </div>
  );
}

/** Round "Meta AI"-style button that sits next to the message box (teachers only). */
export function AiOrb({ onClick }: { onClick: () => void }) {
  return <button type="button" className="v3ch-ai-orb" onClick={onClick} aria-label="AI helper" title="AI helper"><span /></button>;
}

type Mode = 'polish' | 'reply' | 'ask';
/** AI helper sheet: polish my message · suggest a reply · ask anything. */
export function AiHelper({ studentName, draft, context, mark, onUse, onClose }: {
  studentName: string; draft: string; context: string; mark?: number | null;
  onUse: (text: string) => void; onClose: () => void;
}) {
  const [mode, setMode] = useState<Mode>(draft.trim() ? 'polish' : 'reply');
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<{ text: string; usedAi: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true); setError(null); setAnswer(null);
    try {
      if (mode === 'polish') {
        if (!draft.trim()) { setError('Type your message in the box first — I will polish it.'); return; }
        const r = await apiFetch<RefineCommentResponse>('/v2/ai/refine-comment', { method: 'POST', body: { text: draft.trim(), studentName, mark: mark ?? null, tone: 'warm' } });
        setAnswer({ text: r.refined, usedAi: r.usedAi });
      } else {
        const text = mode === 'ask' ? question.trim() : draft.trim();
        if (mode === 'ask' && !text) { setError('Type your question first.'); return; }
        const r = await apiFetch<{ answer: string; usedAi: boolean }>('/v2/ai/chat-assist', { method: 'POST', body: { mode, text, studentName, context } });
        setAnswer({ text: r.answer, usedAi: r.usedAi });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The helper is not available right now.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop v2-sheet-backdrop" role="presentation" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="v2-sheet v3ch-ai" role="dialog" aria-modal="true" aria-label="AI helper">
        <header className="v2-sheet-head">
          <span className="v3ch-ai-orb is-static" aria-hidden="true"><span /></span>
          <div><h2>AI helper</h2><p className="muted">Help with your message to {studentName.split(/\s+/)[0]}. Nothing is sent until you press Send.</p></div>
          <button type="button" className="v2-icon-btn" onClick={onClose} aria-label="Close"><X size={20} /></button>
        </header>
        <div className="v2-sheet-body">
          <div className="v3ch-seg" role="tablist">
            {([['polish', 'Polish my message'], ['reply', 'Suggest a reply'], ['ask', 'Ask a question']] as [Mode, string][]).map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={mode === k} className={mode === k ? 'is-active' : ''} onClick={() => { setMode(k); setAnswer(null); setError(null); }}>{label}</button>
            ))}
          </div>
          {mode === 'polish' && <p className="v3ch-ai-quote">{draft.trim() || <span className="muted">Your message box is empty — type a few words first.</span>}</p>}
          {mode === 'reply' && <p className="muted v3ch-ai-note">I will read the conversation and suggest a short, warm reply{draft.trim() ? ' using your idea' : ''}.</p>}
          {mode === 'ask' && (
            <textarea className="field" rows={3} value={question} onChange={e => setQuestion(e.target.value)} placeholder="e.g. How do I explain a slanting alif to a young student?" aria-label="Your question" />
          )}
          <button type="button" className="v3ch-solid v3ch-ai-run" onClick={() => void run()} disabled={busy}>
            {busy ? <Loader2 size={16} className="v2-spin" /> : <Sparkles size={16} />} {mode === 'polish' ? 'Polish it' : mode === 'reply' ? 'Suggest a reply' : 'Ask'}
          </button>
          {error && <p className="v2-inline-error" role="alert">{error}</p>}
          {answer && (
            <div className="v3ch-ai-answer" role="region" aria-label="Suggestion">
              <p>{answer.text}</p>
              {!answer.usedAi && <small className="muted">The AI is not connected — this is a ready-made suggestion.</small>}
              {mode !== 'ask' ? (
                <button type="button" className="v3ch-solid" onClick={() => { onUse(answer.text); onClose(); }}><Check size={16} /> Use in my message</button>
              ) : (
                <button type="button" className="v3ch-ghost" onClick={() => { onUse(answer.text); onClose(); }}>Copy into my message</button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
