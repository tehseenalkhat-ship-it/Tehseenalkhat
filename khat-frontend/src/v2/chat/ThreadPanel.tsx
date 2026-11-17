import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, CheckCircle2, Clock3, Loader2, RefreshCw, RotateCcw, Send, X } from 'lucide-react';
import { ApiError, apiFetch, getSessionUser, uploadFile } from '@/api';
import { PenLoader } from '@/components/ui';
import type { Annotation, Attachment, Submission, SubmissionStatus, ThreadMessage, ThreadResponse } from '../contracts';
import { AnnotationView } from '../annotate/AnnotationView';
import { Annotator, type AnnotatorHandle } from '../annotate/Annotator';
import { useReviewPolicies } from '../review/policies';
import { Composer } from './Composer';
import { MediaViewer } from './MediaViewer';
import { MessageBubble, PendingBubble, type BubbleContext, type PendingMessage, type Tick } from './MessageBubble';
import { SubmitSheet } from './SubmitSheet';
import { AiHelper, AiOrb, FONT_STEPS, TeacherTools, useChatFont } from './TeacherTools';
import { SendIcon } from './VoicePlayer';
import type { VoiceClip } from './useVoiceRecorder';
import { dayKey, dayLabel, initials, isImage, isPdf, uid } from './media';
import { friendlyStep } from './marks';
import { uploadAttachment } from './upload';
import './chat.css';

export type ThreadPanelProps = {
  stepId: string;
  studentId?: string;            // staff view: whose thread
  mode: 'student' | 'staff';
  compact?: boolean;             // embedded under a step on the task page
  submission?: { required: boolean; priorSteps: { id: string; code: string; title: string }[] } | null;
  onChanged?: () => void;        // e.g. student submitted / teacher marked → parent refreshes state
  /** Staff: hide the built-in marks/tools (the inbox split view shows its own controls on the photo). */
  hideReviewBar?: boolean;
  /** Change this number to make the panel reload (e.g. after the parent sent a mark). */
  refreshKey?: number;
};
type Props = ThreadPanelProps;

/** Extra (non-contract) step fields the v3 backend adds for friendly headers. */
type StepExtras = { courseType?: string | null; courseKind?: string | null; friendlyLabel?: string | null; hasMarks?: boolean };

const POLL_MS = 15_000;
const OPEN: SubmissionStatus[] = ['submitted', 'in_review'];

type AnnotateState =
  | { mode: 'submission'; submission: Submission; startKey: string | null }
  | { mode: 'export'; files: Attachment[]; startKey: string | null };

function statusChip(s: Submission | null, staff: boolean): { tone: string; text: string } | null {
  if (!s) return null;
  switch (s.status) {
    case 'submitted': return { tone: 'wait', text: staff ? 'Waiting for your review' : 'Sent · waiting for your teacher' };
    case 'in_review': return { tone: 'wait', text: staff ? `Being checked${s.claimedByName ? ` by ${s.claimedByName}` : ''}` : 'Your teacher is checking it' };
    case 'revision': return { tone: 'again', text: 'Try again' };
    case 'passed': return { tone: 'ok', text: `Passed${s.mark != null ? ` · ${s.mark}/10` : ''}` };
    case 'reviewed': return { tone: 'ok', text: 'Reviewed' };
    default: return null;
  }
}

export function ThreadPanel({ stepId, studentId, mode, compact = false, submission, onChanged, hideReviewBar = false, refreshKey = 0 }: Props) {
  const me = getSessionUser();
  const staffView = mode === 'staff';
  const [data, setData] = useState<ThreadResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [viewer, setViewer] = useState<{ items: Attachment[]; index: number } | null>(null);
  const [annView, setAnnView] = useState<{ list: Annotation[]; index: number } | null>(null);
  const [submitOpen, setSubmitOpen] = useState(false);
  /** Files picked with the paperclip on an upload step with no open submission — we ask before sending. */
  const [askFiles, setAskFiles] = useState<{ files: File[]; caption: string } | null>(null);
  const [submitInit, setSubmitInit] = useState<{ files: File[]; caption: string } | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [newBelow, setNewBelow] = useState(0);
  const [text, setText] = useState('');
  const [aiOpen, setAiOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [annotate, setAnnotate] = useState<AnnotateState | null>(null);
  const [annBusy, setAnnBusy] = useState(false);
  const [annError, setAnnError] = useState<string | null>(null);
  const [fontIndex, nextFont] = useChatFont();
  const feedRef = useRef<HTMLDivElement>(null);
  const annotatorRef = useRef<AnnotatorHandle>(null);
  const firstUnreadRef = useRef<string | null | undefined>(undefined);
  const lastCount = useRef(0);
  const policies = useReviewPolicies();

  const query = staffView && studentId ? `?studentId=${encodeURIComponent(studentId)}` : '';
  const load = useCallback(async (initial = false) => {
    if (initial) setLoading(true);
    try {
      const res = await apiFetch<ThreadResponse>(`/v2/threads/${stepId}${query}`, { silent: !initial });
      if (firstUnreadRef.current === undefined) {
        const firstUnread = !staffView ? res.messages.find(m => m.senderRole !== 'student' && !m.readByStudent) : undefined;
        firstUnreadRef.current = firstUnread?.id ?? null;
      }
      setData(res);
      setError(null);
    } catch (err) {
      if (initial) setError(err instanceof ApiError ? err.message : 'This conversation could not be loaded.');
    } finally {
      if (initial) setLoading(false);
    }
  }, [stepId, query, staffView]);

  useEffect(() => {
    firstUnreadRef.current = undefined;
    lastCount.current = 0;
    setData(null);
    setPending([]);
    void load(true);
  }, [load]);
  useEffect(() => { if (refreshKey) void load(); }, [refreshKey, load]);
  useEffect(() => {
    const id = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, POLL_MS);
    const onVis = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { window.clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, [load]);
  useEffect(() => { if (!toast) return; const t = window.setTimeout(() => setToast(null), 2600); return () => window.clearTimeout(t); }, [toast]);

  const messages = useMemo(() => [...(data?.messages ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt)), [data]);
  const submissions = useMemo(() => [...(data?.submissions ?? [])].sort((a, b) => a.attemptNo - b.attemptNo || a.createdAt.localeCompare(b.createdAt)), [data]);
  const latest = submissions[submissions.length - 1] ?? null;
  const openSub = latest && OPEN.includes(latest.status) ? latest : null;

  const scrollToBottom = (smooth = false) => {
    const el = feedRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  };
  useEffect(() => {
    const count = messages.length + pending.length;
    if (!count) return;
    if (lastCount.current === 0) {
      const unread = firstUnreadRef.current ? document.getElementById(`v2m-${firstUnreadRef.current}`) : null;
      requestAnimationFrame(() => {
        const feed = feedRef.current;
        if (unread && feed) feed.scrollTop = unread.offsetTop - feed.clientHeight / 3;
        else scrollToBottom();
      });
    } else if (count > lastCount.current) {
      if (atBottom || pending.length) requestAnimationFrame(() => scrollToBottom(true));
      else setNewBelow(n => n + (count - lastCount.current));
    }
    lastCount.current = count;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, pending.length]);
  const onScroll = () => {
    const el = feedRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    setAtBottom(bottom);
    if (bottom) setNewBelow(0);
  };

  /* ---------- sending ---------- */
  const bodyBase = staffView && studentId ? { studentId } : {};
  const runPending = (p: PendingMessage, job: () => Promise<void>) => {
    const attempt = async () => {
      setPending(prev => prev.map(x => (x.tempId === p.tempId ? { ...x, status: 'sending', error: undefined } : x)));
      try {
        await job();
        await load();
        setPending(prev => prev.filter(x => x.tempId !== p.tempId));
        onChanged?.();
      } catch (err) {
        setPending(prev => prev.map(x => (x.tempId === p.tempId ? { ...x, status: 'failed', error: err instanceof Error ? err.message : 'Not sent.', retry: () => void attempt() } : x)));
      }
    };
    setPending(prev => [...prev, p]);
    void attempt();
  };
  const sendText = (t: string) => {
    const p: PendingMessage = { tempId: uid(), kind: 'text', body: t, status: 'sending', createdAt: new Date().toISOString() };
    runPending(p, async () => { await apiFetch<ThreadMessage>(`/v2/threads/${stepId}/messages`, { method: 'POST', body: { ...bodyBase, kind: 'text', body: t } }); });
  };
  const sendFiles = (files: File[], caption: string) => {
    const p: PendingMessage = { tempId: uid(), kind: 'files', body: caption || null, files, status: 'sending', createdAt: new Date().toISOString() };
    let uploaded: Attachment[] | null = null;
    runPending(p, async () => {
      if (!uploaded) uploaded = await Promise.all(files.map(f => uploadAttachment('threads', f)));
      await apiFetch<ThreadMessage>(`/v2/threads/${stepId}/messages`, { method: 'POST', body: { ...bodyBase, kind: 'files', body: caption || undefined, attachments: uploaded } });
    });
  };
  const sendVoice = (clip: VoiceClip) => {
    const p: PendingMessage = { tempId: uid(), kind: 'voice', body: null, voiceUrl: clip.url, durationSec: clip.durationSec, waveform: clip.waveform, status: 'sending', createdAt: new Date().toISOString() };
    let att: Attachment | null = null;
    runPending(p, async () => {
      if (!att) { const up = await uploadFile('voice', clip.file); att = { storageKey: up.storageKey, originalFilename: clip.file.name, contentType: clip.file.type || 'audio/webm' }; }
      await apiFetch<ThreadMessage>(`/v2/threads/${stepId}/messages`, { method: 'POST', body: { ...bodyBase, kind: 'voice', attachments: [att], meta: { durationSec: clip.durationSec, waveform: clip.waveform } } });
    });
  };
  const sendMeet = async () => {
    if (!data || !studentId) return;
    if (!window.confirm(`Send this to ${data.student.name.split(' ')[0]}?\n\n"Please come to the Funun al-Quran office to discuss your kitabat further."`)) return;
    try {
      await apiFetch(`/v2/threads/${stepId}/meet-request`, { method: 'POST', body: { studentId } });
      setToast('Meeting request sent');
      await load();
      requestAnimationFrame(() => scrollToBottom(true));
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Could not send.');
    }
  };

  /* ---------- bubble context ---------- */
  const annotationsById = useMemo(() => new Map((data?.annotations ?? []).map(a => [a.id, a])), [data]);
  const submissionsById = useMemo(() => new Map(submissions.map(s => [s.id, s])), [submissions]);
  const priorById = useMemo(() => new Map((submission?.priorSteps ?? []).map(s => [s.id, s])), [submission]);
  const fileLabel = (a: Attachment): string | null => {
    if (!a.forStepId) return null;
    if (a.forStepId === stepId) return (submission?.priorSteps.length ?? 0) > 0 || data?.step.stepType === 'assessment' ? 'Assessment' : null;
    const s = priorById.get(a.forStepId);
    return s ? friendlyStep({ code: s.code, title: null }) : 'Worksheet';
  };
  const ctx: BubbleContext = {
    staffView,
    annotationsById,
    submissionsById,
    bands: policies.bands,
    fileLabel,
    openFiles: (items, index) => setViewer({ items, index }),
    openAnnotation: id => {
      const ann = annotationsById.get(id);
      if (!ann) return;
      const list = (data?.annotations ?? []).filter(a => a.submissionId === ann.submissionId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      setAnnView({ list, index: Math.max(0, list.findIndex(a => a.id === id)) });
    },
  };

  const isMine = (m: ThreadMessage) => (m.senderId && me?.id ? m.senderId === me.id : false)
    || (staffView ? (m.senderRole === 'teacher' || m.senderRole === 'admin') : m.senderRole === 'student');
  const tickFor = (m: ThreadMessage, index: number): Tick => {
    if (m.senderRole === 'student') {
      const later = messages.slice(index + 1).some(x => x.senderRole === 'teacher' || x.senderRole === 'admin');
      const sub = m.submissionId ? submissionsById.get(m.submissionId) : null;
      return later || (sub && sub.status !== 'submitted') ? 'read' : 'delivered';
    }
    return m.readByStudent ? 'read' : 'delivered';
  };

  /* ---------- tap a photo → draw on it ---------- */
  const startAnnotate = (att: Attachment) => {
    setViewer(null);
    setAnnError(null);
    const owner = staffView ? submissions.slice().reverse().find(s => s.files.some(f => f.storageKey === att.storageKey)) : undefined;
    if (owner) setAnnotate({ mode: 'submission', submission: owner, startKey: att.storageKey });
    else setAnnotate({ mode: 'export', files: [att], startKey: att.storageKey });
  };
  const finishAnnotate = async () => {
    if (!annotate) return;
    setAnnBusy(true);
    setAnnError(null);
    try {
      if (annotate.mode === 'submission') {
        if (annotatorRef.current?.isDirty()) await annotatorRef.current.save();
        setAnnotate(null);
        await load();
        onChanged?.();
        requestAnimationFrame(() => scrollToBottom(true));
      } else {
        const files = (await annotatorRef.current?.exportFiles()) ?? [];
        setAnnotate(null);
        if (files.length) sendFiles(files, text.trim());
        if (text.trim()) setText('');
      }
    } catch (err) {
      setAnnError(err instanceof Error ? err.message : 'Could not send the drawing.');
    } finally {
      setAnnBusy(false);
    }
  };
  const closeAnnotate = () => {
    if (annotatorRef.current?.isDirty() && !window.confirm('Close without sending your drawing?')) return;
    setAnnotate(null);
  };

  const extras = (data?.step ?? {}) as StepExtras;
  const hasMarks = typeof extras.hasMarks === 'boolean' ? extras.hasMarks : ['assessment', 'final_submission'].includes(data?.step.stepType ?? '');

  /* ---------- render ---------- */
  if (loading && !data) return <div className={`v2-thread v3ch-wa${compact ? ' is-compact' : ''} is-loading`}><PenLoader compact label="Opening the chat…" /></div>;
  if (error && !data) {
    return (
      <div className={`v2-thread v3ch-wa${compact ? ' is-compact' : ''} is-error`}>
        <p className="v2-inline-error" role="alert">{error}</p>
        <button type="button" className="btn btn-outline" onClick={() => void load(true)}><RefreshCw size={15} /> Try again</button>
      </div>
    );
  }
  if (!data) return null;

  const chip = statusChip(latest, staffView);
  const attemptsUsed = submissions.length;
  const maxAttempts = policies.maxAttempts;
  const attemptsLeft = maxAttempts > 0 ? maxAttempts - attemptsUsed : Infinity;
  const sendWord = hasMarks ? 'Send for assessment' : 'Send for comments';
  const canSubmit = !staffView && !!submission?.required && !openSub && (!latest || latest.status === 'revision') && attemptsLeft > 0;
  const stepLabel = friendlyStep({ ...data.step, friendlyLabel: extras.friendlyLabel });
  const courseLine = [data.step.courseTitle, extras.courseKind].filter(Boolean).join(' · ');
  const staffTools = staffView && !hideReviewBar;
  const reviewable = staffTools && !!openSub && (data.canReview ?? false);
  const aiContext = messages.filter(m => m.body && m.kind !== 'system').slice(-8).map(m => `${m.senderRole === 'student' ? 'Student' : 'Teacher'}: ${m.body}`).join('\n');
  const canDraw = (a: Attachment) => isImage(a) || isPdf(a);

  let lastDay = '';
  let lastSender = '';
  const rows: JSX.Element[] = [];
  messages.forEach((m, i) => {
    const d = dayKey(m.createdAt);
    if (d !== lastDay) {
      rows.push(<div key={`d-${d}`} className="v2-day" role="separator"><span>{dayLabel(m.createdAt)}</span></div>);
      lastDay = d; lastSender = '';
    }
    if (firstUnreadRef.current && m.id === firstUnreadRef.current) {
      rows.push(<div key="unread" className="v2-unread-line" role="separator"><span>New messages</span></div>);
    }
    const mine = isMine(m);
    const showSender = m.kind !== 'system' && m.senderId !== lastSender;
    lastSender = m.kind === 'system' ? '' : m.senderId;
    rows.push(
      <div key={m.id} id={`v2m-${m.id}`} className={`v2-row${mine ? ' is-mine' : ''}${m.kind === 'system' ? ' is-system' : ''}${showSender ? ' is-first' : ''}`}>
        <MessageBubble message={m} mine={mine} showSender={showSender} tick={mine ? tickFor(m, i) : 'none'} ctx={ctx} />
      </div>,
    );
  });

  return (
    <section
      className={`v2-thread v3ch-wa${compact ? ' is-compact' : ''}${staffView ? ' is-staff' : ''}`}
      style={{ '--v3ch-chat-fs': `${FONT_STEPS[staffView ? fontIndex : 1].px}px` } as React.CSSProperties}
      aria-label={staffView ? `Chat with ${data.student.name}` : 'Chat with your teacher'}
      data-testid="thread-panel"
      data-thread-step={stepId}
    >
      <header className="v2-thread-head v3ch-head">
        {staffView ? (
          <>
            <span className="v2-avatar" aria-hidden="true">{initials(data.student.name)}</span>
            <span className="v2-thread-title">
              <strong>{data.student.name}</strong>
              <small>{[data.student.trNumber && `TR ${data.student.trNumber}`, data.student.className, data.student.branchName].filter(Boolean).join(' · ') || data.student.email}</small>
            </span>
          </>
        ) : (
          <>
            <span className="v2-avatar v3ch-dept-avatar" aria-hidden="true">FQ</span>
            <span className="v2-thread-title">
              <strong>{compact ? 'Your teacher' : data.step.courseTitle}</strong>
              <small>{compact ? 'Funun al-Quran · uploads, marks and comments come here' : stepLabel}</small>
            </span>
          </>
        )}
        {chip && <span className={`v3ch-status tone-${chip.tone}`}>{chip.text}</span>}
        {staffView && latest?.autoMarked && <span className="v3ch-status tone-wait" title="Only staff see this">Automatic mark</span>}
      </header>
      <div className="v2-thread-sub v3ch-sub">{staffView ? `${courseLine} — ${stepLabel}` : compact ? `${courseLine} — ${stepLabel}` : courseLine}</div>

      <div className="v2-feed v3ch-feed" ref={feedRef} onScroll={onScroll} aria-live="polite" data-testid="thread-feed">
        <div className="v3ch-lockline" role="note"><span>Only you, your teachers and Funun al-Quran see this chat.</span></div>
        {!messages.length && !pending.length && (
          <div className="v2-empty">
            <p>{staffView ? 'No messages yet.' : submission?.required ? `When your work is ready, press “${sendWord}”. You can also ask your teacher a question here, or send a voice note.` : 'Ask your teacher a question, or share a photo of your practice.'}</p>
          </div>
        )}
        {rows}
        {pending.map(p => <div key={p.tempId} className="v2-row is-mine is-first"><PendingBubble p={p} /></div>)}
      </div>
      {newBelow > 0 && !atBottom && (
        <button type="button" className="v2-newpill" onClick={() => { scrollToBottom(true); setNewBelow(0); }}><ArrowDown size={14} /> {newBelow} new</button>
      )}

      {askFiles && canSubmit ? (
        <div className="v3ch-askbar" role="alertdialog" aria-labelledby="v3ch-ask-title" data-testid="ask-assessment">
          <span><strong id="v3ch-ask-title">{hasMarks ? 'Send this for assessment?' : 'Send this for comments?'}</strong>
            <small>{askFiles.files.length} file{askFiles.files.length === 1 ? '' : 's'} · your teacher will {hasMarks ? 'mark it' : 'comment on it'} and reply here.</small></span>
          <span className="v3ch-askbar-actions">
            <button type="button" className="is-solid" data-testid="ask-assessment-yes" onClick={() => { setSubmitInit(askFiles); setAskFiles(null); setSubmitOpen(true); }}>{hasMarks ? 'Yes, send for assessment' : 'Yes, send for comments'}</button>
            <button type="button" className="is-ghost" onClick={() => setAskFiles(null)}>Cancel</button>
          </span>
        </div>
      ) : !staffView && submission?.required && (
        <div className={`v2-submitbar v3ch-submitbar${canSubmit ? '' : ' is-quiet'}`}>
          {canSubmit ? (
            <>
              <span className="v2-submitbar-text">
                {latest?.status === 'revision' ? <RotateCcw size={18} /> : <Send size={18} />}
                <span><strong>{latest?.status === 'revision' ? 'Ready to try again?' : (hasMarks ? 'Ready? Send your work for assessment' : 'Ready? Send your work for comments')}</strong>
                  <small>{(submission.priorSteps.length ? `${submission.priorSteps.length} worksheet${submission.priorSteps.length === 1 ? '' : 's'} + assessment sheet` : 'Photos or one PDF')}{maxAttempts > 0 ? ` · ${attemptsLeft} attempt${attemptsLeft === 1 ? '' : 's'} left` : ''}</small></span>
              </span>
              <button type="button" className="v3ch-solid" onClick={() => { setSubmitInit(null); setSubmitOpen(true); }} data-testid="send-for-assessment">{latest?.status === 'revision' ? 'Send again' : sendWord}</button>
            </>
          ) : openSub ? (
            <span className="v2-submitbar-text"><Clock3 size={17} /><span><strong>Sent — your teacher will reply here</strong><small>You can still send a message or a voice note.</small></span></span>
          ) : latest && (latest.status === 'passed' || latest.status === 'reviewed') ? (
            <span className="v2-submitbar-text is-done"><CheckCircle2 size={17} /><span><strong>{latest.status === 'passed' ? 'Passed — well done' : 'Reviewed'}</strong><small>See your teacher’s notes above.</small></span></span>
          ) : latest?.status === 'revision' && attemptsLeft <= 0 ? (
            <span className="v2-submitbar-text"><span><strong>No attempts left</strong><small>Please speak to your teacher.</small></span></span>
          ) : null}
        </div>
      )}

      {staffTools && (
        <TeacherTools
          submission={reviewable ? openSub : null}
          hasMarks={hasMarks}
          bands={policies.bands}
          studentName={data.student.name}
          comment={text}
          onCommentUsed={() => setText('')}
          onSent={() => { setToast('Sent to the student'); void load().then(() => { requestAnimationFrame(() => scrollToBottom(true)); window.setTimeout(() => scrollToBottom(true), 700); }); onChanged?.(); }}
          onAnnotate={openSub && openSub.files.some(canDraw) ? () => setAnnotate({ mode: 'submission', submission: openSub, startKey: null }) : null}
          onMeet={studentId ? () => void sendMeet() : null}
          onAi={() => setAiOpen(true)}
          fontIndex={fontIndex}
          onFont={nextFont}
        />
      )}

      <Composer
        text={text}
        setText={setText}
        leading={staffView ? <AiOrb onClick={() => setAiOpen(true)} /> : undefined}
        onSendText={sendText}
        onSendFiles={(files, caption) => {
          // On an upload step a sheet must become a real submission, or the teacher never sees it.
          if (canSubmit) { setAskFiles({ files, caption }); return; }
          sendFiles(files, caption);
        }}
        onSendVoice={sendVoice}
        placeholder={staffView ? `Message ${data.student.name.split(' ')[0]}` : 'Message'}
        maxFiles={policies.maxFiles}
      />

      {toast && <div className="v2-toast" role="status">{toast}</div>}
      {viewer && (
        <MediaViewer
          items={viewer.items}
          startIndex={viewer.index}
          onClose={() => setViewer(null)}
          caption={a => ctx.fileLabel(a) ?? a.originalFilename}
          onAnnotate={a => (canDraw(a) ? startAnnotate(a) : undefined)}
          annotateLabel={staffView ? 'Mark on it' : 'Draw on it'}
        />
      )}
      {annView && <AnnotationView annotations={annView.list} startIndex={annView.index} files={submissions.flatMap(s => s.files)} onClose={() => setAnnView(null)} />}
      {aiOpen && <AiHelper studentName={data.student.name} draft={text} context={aiContext} onUse={t => setText(t)} onClose={() => setAiOpen(false)} />}
      {submitOpen && submission && (
        <SubmitSheet
          stepId={stepId}
          stepTitle={stepLabel}
          sendLabel={sendWord}
          priorSteps={submission.priorSteps}
          attemptNo={attemptsUsed + 1}
          maxFiles={policies.maxFiles}
          initialFiles={submitInit?.files}
          initialNote={submitInit?.caption}
          onClose={() => { setSubmitOpen(false); setSubmitInit(null); }}
          onSubmitted={() => { setSubmitOpen(false); setSubmitInit(null); void load().then(() => requestAnimationFrame(() => scrollToBottom(true))); onChanged?.(); }}
        />
      )}
      {annotate && (
        <div className="v2-annotate-overlay v3ch-annotate" role="dialog" aria-modal="true" aria-label="Draw on the sheet">
          <header className="v2-viewer-bar v3ch-annotate-bar">
            <button type="button" onClick={closeAnnotate} aria-label="Close"><X size={20} /></button>
            <strong>{annotate.mode === 'submission' ? `Mark ${data.student.name.split(' ')[0]}'s sheet` : 'Draw on the photo'}</strong>
            <span className="v2-viewer-spacer" />
            <button type="button" className="v3ch-annotate-send" onClick={() => void finishAnnotate()} disabled={annBusy} data-testid="annotate-send">
              {annBusy ? <Loader2 size={17} className="v2-spin" /> : <SendIcon size={17} />} <span>Send</span>
            </button>
          </header>
          {annError && <p className="v2-inline-error" role="alert">{annError}</p>}
          <Annotator
            ref={annotatorRef}
            submissionId={annotate.mode === 'submission' ? annotate.submission.id : ''}
            files={annotate.mode === 'submission' ? annotate.submission.files : annotate.files}
            annotations={annotate.mode === 'submission' ? data.annotations.filter(a => a.submissionId === annotate.submission.id) : []}
            fileLabel={(a, i) => ctx.fileLabel(a) ?? `Page ${i + 1}`}
            hideSave
            exportOnly={annotate.mode === 'export'}
            startStorageKey={annotate.startKey}
          />
          {annotate.mode === 'submission' && staffTools && OPEN.includes(annotate.submission.status) && (data.canReview ?? false) && (
            <div className="v2-annotate-overlay-foot v3ch-annotate-foot">
              <TeacherTools
                submission={annotate.submission}
                hasMarks={hasMarks}
                bands={policies.bands}
                studentName={data.student.name}
                comment={text}
                onCommentUsed={() => setText('')}
                beforeSend={async () => { if (annotatorRef.current?.isDirty()) await annotatorRef.current.save(); }}
                onSent={() => { setAnnotate(null); setToast('Marks and drawing sent'); void load().then(() => { requestAnimationFrame(() => scrollToBottom(true)); window.setTimeout(() => scrollToBottom(true), 700); }); onChanged?.(); }}
                compactMarks
              />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
