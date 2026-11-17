import { useState } from 'react';
import { AlertCircle, Bot, Building2, Check, CheckCheck, Clock3, Inbox } from 'lucide-react';
import type { Annotation, Attachment, MarkBand, Submission, ThreadMessage } from '../contracts';
import { AnnotationThumb } from '../annotate/AnnotationView';
import { initials, isAudio, timeLabel } from './media';
import { bandFrom, bandName, markMeaning } from './marks';
import { AttachmentThumb, LocalFileThumb } from './Thumbs';
import { VoicePlayer } from './VoicePlayer';

export type Tick = 'none' | 'pending' | 'failed' | 'sent' | 'delivered' | 'read';

/** A message as both the step threads and the department chat use it (stepId optional). */
export type ChatMessage = Omit<ThreadMessage, 'stepId' | 'kind' | 'submissionId' | 'annotationId'> & {
  stepId?: string;
  kind: ThreadMessage['kind'];
  submissionId?: string | null;
  annotationId?: string | null;
};

export type BubbleContext = {
  staffView: boolean;
  annotationsById: Map<string, Annotation>;
  submissionsById: Map<string, Submission>;
  fileLabel: (a: Attachment) => string | null;
  openFiles: (items: Attachment[], index: number) => void;
  openAnnotation: (annotationId: string) => void;
  bands?: { revisionMax: number; passMax: number };
};

export type PendingMessage = {
  tempId: string;
  kind: 'text' | 'files' | 'voice';
  body: string | null;
  files?: File[];
  voiceUrl?: string;
  durationSec?: number;
  waveform?: number[];
  status: 'sending' | 'failed';
  createdAt: string;
  error?: string;
  retry?: () => void;
};

function TickIcon({ tick }: { tick: Tick }) {
  if (tick === 'none') return null;
  if (tick === 'pending') return <Clock3 size={13} className="v2-tick" aria-label="Sending" />;
  if (tick === 'failed') return <AlertCircle size={13} className="v2-tick is-failed" aria-label="Not sent" />;
  if (tick === 'sent') return <Check size={15} className="v2-tick" aria-label="Sent" />;
  return <CheckCheck size={16} className={`v2-tick${tick === 'read' ? ' is-read' : ''}`} aria-label={tick === 'read' ? 'Read' : 'Delivered'} />;
}

export function SystemLine({ text }: { text: string }) {
  return <div className="v2-sysline" role="note"><span>{text}</span></div>;
}

const DEFAULT_BANDS = { revisionMax: 5, passMax: 8 };

/** Reviewer's name as students see it: "Ustad Ali · Teacher". */
function SenderLine({ message, staffView }: { message: ChatMessage; staffView: boolean }) {
  const role = message.senderRole === 'admin' ? 'Funun al-Quran' : message.senderRole === 'teacher' ? 'Teacher' : staffView ? 'Student' : '';
  return <span className={`v2-sender role-${message.senderRole}`}>{message.senderName}{role ? <em> · {role}</em> : null}</span>;
}

/** Highlighted mark bubble; pressing it shows what the mark means. */
function MarkBubble({ message, mine, sender, time, ctx, tail }: { message: ChatMessage; mine: boolean; sender: JSX.Element | null; time: JSX.Element; ctx: BubbleContext; tail: string }) {
  const [open, setOpen] = useState(true);
  const sub = message.submissionId ? ctx.submissionsById.get(message.submissionId) : undefined;
  const meta = message.meta as { mark?: unknown; band?: MarkBand; autoMarked?: boolean };
  const markValue = Number(meta.mark);
  const has = Number.isFinite(markValue) && markValue > 0;
  const band: MarkBand | null = meta.band ?? sub?.band ?? (has ? bandFrom(markValue, ctx.bands ?? DEFAULT_BANDS) : null);
  const autoMarked = ctx.staffView && !!(sub?.autoMarked || meta.autoMarked);
  return (
    <article className={`v2-bubble v2-markcard v3ch-markcard${mine ? ' is-mine' : ''} band-${band ?? 'none'}${tail}`} aria-label={`Marks: ${has ? markValue : ''} out of 10`}>
      {sender}
      <button type="button" className="v3ch-markcard-top" onClick={() => setOpen(o => !o)} aria-expanded={open} title="What does this mark mean?">
        <span className="v3ch-markcard-kicker">Marks</span>
        <strong className="v2-markcard-mark">{has ? markValue : '–'}<small>/10</small></strong>
        {band && <span className={`v3ch-band band-${band}`}>{bandName(band)}</span>}
      </button>
      {open && has && band && <p className="v3ch-markcard-meaning">{markMeaning(markValue, band)}</p>}
      {message.body && <p className="v2-text">{message.body}</p>}
      <span className="v3ch-markcard-foot">
        {!mine && message.senderRole !== 'student' ? <>Marked by {message.senderName}</> : sub ? <>Attempt {sub.attemptNo}</> : null}
        {autoMarked && <span className="chip chip-amber" title="Only staff see this"><Bot size={12} /> Automatic</span>}
      </span>
      {time}
    </article>
  );
}

export function MessageBubble({ message, mine, showSender, tick, ctx }: { message: ChatMessage; mine: boolean; showSender: boolean; tick: Tick; ctx: BubbleContext }) {
  if (message.kind === 'system') return <SystemLine text={message.body ?? ''} />;
  const tail = showSender ? ' has-tail' : '';
  const time = <span className="v2-meta"><time dateTime={message.createdAt}>{timeLabel(message.createdAt)}</time>{mine && <TickIcon tick={tick} />}</span>;
  const sender = showSender && !mine ? <SenderLine message={message} staffView={ctx.staffView} /> : null;
  const sub = message.submissionId ? ctx.submissionsById.get(message.submissionId) : undefined;
  const meta = message.meta as { event?: string; durationSec?: number; waveform?: number[] };

  if (message.kind === 'mark') return <MarkBubble message={message} mine={mine} sender={sender} time={time} ctx={ctx} tail={tail} />;

  if (meta.event === 'meet_request') {
    const extra = (message.body ?? '').split('\n').slice(1).join('\n').trim();
    return (
      <article className={`v2-bubble v3ch-meet${mine ? ' is-mine' : ''}${tail}`}>
        {sender}
        <span className="v3ch-meet-head"><Building2 size={18} /> <strong>Request to meet</strong></span>
        <p className="v2-text">Please come to the <b>Funun al-Quran office</b> to discuss your kitabat further.</p>
        {extra && <p className="v2-text">{extra}</p>}
        {time}
      </article>
    );
  }

  if (message.kind === 'annotation') {
    const ann = message.annotationId ? ctx.annotationsById.get(message.annotationId) : undefined;
    return (
      <article className={`v2-bubble is-media${mine ? ' is-mine' : ''}${tail}`}>
        {sender}
        {ann ? <AnnotationThumb annotation={ann} onOpen={() => ctx.openAnnotation(ann.id)} /> : <span className="muted">Corrected sheet</span>}
        <p className="v2-text">{message.body || (ann?.pins.length ? `Corrected sheet — tap the numbers to hear ${mine ? 'your' : 'the'} notes.` : 'Corrected sheet — tap to open.')}</p>
        {time}
      </article>
    );
  }

  if (message.kind === 'voice') {
    const audio = message.attachments.find(isAudio) ?? message.attachments[0];
    return (
      <article className={`v2-bubble is-voice${mine ? ' is-mine' : ''}${tail}`}>
        {sender}
        {audio
          ? <VoicePlayer storageKey={audio.storageKey} durationSec={Number(meta.durationSec) || null} waveform={Array.isArray(meta.waveform) ? meta.waveform : null} initials={initials(message.senderName)} mine={mine} />
          : <span className="muted">Voice note</span>}
        {message.body && <p className="v2-text">{message.body}</p>}
        {time}
      </article>
    );
  }

  if (message.kind === 'files') {
    const items = message.attachments;
    const isSubmission = !!message.submissionId && message.senderRole === 'student' && (message.meta as { attemptNo?: number }).attemptNo !== undefined;
    return (
      <article className={`v2-bubble is-media${mine ? ' is-mine' : ''}${isSubmission ? ' is-submission' : ''}${tail}`}>
        {sender}
        {isSubmission && <span className="v2-subtag"><Inbox size={13} /> Sent to your teachers{sub ? ` · attempt ${sub.attemptNo}` : ''}</span>}
        <div className={`v2-grid n-${Math.min(items.length, 4)}`}>
          {items.slice(0, items.length > 4 ? 3 : 4).map((a, i) => (
            <AttachmentThumb key={a.storageKey + i} att={a} label={ctx.fileLabel(a)} onOpen={() => ctx.openFiles(items, i)} />
          ))}
          {items.length > 4 && (
            <button type="button" className="v2-thumb v2-thumb-more" onClick={() => ctx.openFiles(items, 3)} aria-label={`Open all ${items.length} files`}>+{items.length - 3}</button>
          )}
        </div>
        {message.body && <p className="v2-text">{message.body}</p>}
        {time}
      </article>
    );
  }

  return (
    <article className={`v2-bubble${mine ? ' is-mine' : ''}${tail}`}>
      {sender}
      <p className="v2-text">{message.body}{/* spacer keeps the time from overlapping the last line */}<span className="v3ch-time-spacer" aria-hidden="true" /></p>
      {time}
    </article>
  );
}

export function PendingBubble({ p }: { p: PendingMessage }) {
  const tick: Tick = p.status === 'failed' ? 'failed' : 'pending';
  return (
    <article className={`v2-bubble is-mine is-pending${p.kind === 'files' ? ' is-media' : p.kind === 'voice' ? ' is-voice' : ''}`}>
      {p.kind === 'files' && p.files && (
        <div className={`v2-grid n-${Math.min(p.files.length, 4)}`}>
          {p.files.slice(0, 4).map((f, i) => <LocalFileThumb key={i} file={f} />)}
        </div>
      )}
      {p.kind === 'voice' && <VoicePlayer src={p.voiceUrl} durationSec={p.durationSec} waveform={p.waveform} mine />}
      {p.body && <p className="v2-text">{p.body}</p>}
      <span className="v2-meta"><time>{timeLabel(p.createdAt)}</time><TickIcon tick={tick} /></span>
      {p.status === 'failed' && (
        <span className="v2-failed">{p.error ?? 'Not sent.'} {p.retry && <button type="button" className="v2-link" onClick={p.retry}>Try again</button>}</span>
      )}
    </article>
  );
}
