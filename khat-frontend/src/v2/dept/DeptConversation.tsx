import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowLeft, Building2, Loader2, RefreshCw, Sparkles, Type, X } from 'lucide-react';
import { ApiError, apiFetch, uploadFile } from '@/api';
import { PenLoader } from '@/components/ui';
import type { Attachment } from '../contracts';
import { Annotator, type AnnotatorHandle } from '../annotate/Annotator';
import { Composer } from '../chat/Composer';
import { MediaViewer } from '../chat/MediaViewer';
import { MessageBubble, PendingBubble, type BubbleContext, type ChatMessage, type PendingMessage, type Tick } from '../chat/MessageBubble';
import { AiHelper, AiOrb, FONT_STEPS, useChatFont } from '../chat/TeacherTools';
import { SendIcon } from '../chat/VoicePlayer';
import type { VoiceClip } from '../chat/useVoiceRecorder';
import { dayKey, dayLabel, initials, isImage, isPdf, uid } from '../chat/media';
import { uploadAttachment } from '../chat/upload';
import type { DeptMessage, DeptMessagesResponse } from './types';
import '../chat/chat.css';

const POLL_MS = 12_000;
const EMPTY_MAP = new Map();

/** One student's conversation with the Funun al-Quran Department (WhatsApp look). */
export function DeptConversation({ studentId, mode, onBack, onChanged }: { studentId: string; mode: 'student' | 'staff'; onBack?: () => void; onChanged?: () => void }) {
  const staff = mode === 'staff';
  const path = `/v2/dept-chat/${staff ? studentId : 'me'}/messages`;
  const [data, setData] = useState<DeptMessagesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [text, setText] = useState('');
  const [viewer, setViewer] = useState<{ items: Attachment[]; index: number } | null>(null);
  const [drawing, setDrawing] = useState<Attachment | null>(null);
  const [drawBusy, setDrawBusy] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [fontIndex, nextFont] = useChatFont();
  const feedRef = useRef<HTMLDivElement>(null);
  const annRef = useRef<AnnotatorHandle>(null);
  const lastCount = useRef(0);

  const load = useCallback(async (initial = false) => {
    try {
      const res = await apiFetch<DeptMessagesResponse>(path, { silent: !initial });
      setData(res);
      setError(null);
      if (initial) onChanged?.();
    } catch (err) {
      if (initial) setError(err instanceof ApiError ? err.message : 'This chat could not be opened.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  useEffect(() => { setData(null); setPending([]); lastCount.current = 0; void load(true); }, [load]);
  useEffect(() => {
    const id = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, POLL_MS);
    return () => window.clearInterval(id);
  }, [load]);
  useEffect(() => { if (!toast) return; const t = window.setTimeout(() => setToast(null), 2600); return () => window.clearTimeout(t); }, [toast]);

  const messages = data?.messages ?? [];
  const scrollToBottom = (smooth = false) => { const el = feedRef.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }); };
  useEffect(() => {
    const count = messages.length + pending.length;
    if (!count) return;
    if (lastCount.current === 0 || atBottom || pending.length) requestAnimationFrame(() => scrollToBottom(lastCount.current !== 0));
    lastCount.current = count;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, pending.length]);

  const post = (body: Record<string, unknown>) => apiFetch<DeptMessage>(path, { method: 'POST', body });
  const runPending = (p: PendingMessage, job: () => Promise<void>) => {
    const attempt = async () => {
      setPending(prev => prev.map(x => (x.tempId === p.tempId ? { ...x, status: 'sending', error: undefined } : x)));
      try { await job(); await load(); setPending(prev => prev.filter(x => x.tempId !== p.tempId)); onChanged?.(); } catch (err) {
        setPending(prev => prev.map(x => (x.tempId === p.tempId ? { ...x, status: 'failed', error: err instanceof Error ? err.message : 'Not sent.', retry: () => void attempt() } : x)));
      }
    };
    setPending(prev => [...prev, p]);
    void attempt();
  };
  const sendText = (t: string) => runPending({ tempId: uid(), kind: 'text', body: t, status: 'sending', createdAt: new Date().toISOString() }, async () => { await post({ kind: 'text', body: t }); });
  const sendFiles = (files: File[], caption: string) => {
    let uploaded: Attachment[] | null = null;
    runPending({ tempId: uid(), kind: 'files', body: caption || null, files, status: 'sending', createdAt: new Date().toISOString() }, async () => {
      if (!uploaded) uploaded = await Promise.all(files.map(f => uploadAttachment('threads', f)));
      await post({ kind: 'files', body: caption || undefined, attachments: uploaded });
    });
  };
  const sendVoice = (clip: VoiceClip) => {
    let att: Attachment | null = null;
    runPending({ tempId: uid(), kind: 'voice', body: null, voiceUrl: clip.url, durationSec: clip.durationSec, waveform: clip.waveform, status: 'sending', createdAt: new Date().toISOString() }, async () => {
      if (!att) { const up = await uploadFile('voice', clip.file); att = { storageKey: up.storageKey, originalFilename: clip.file.name, contentType: clip.file.type || 'audio/webm' }; }
      await post({ kind: 'voice', attachments: [att], meta: { durationSec: clip.durationSec, waveform: clip.waveform } });
    });
  };
  const sendMeet = async () => {
    if (!data) return;
    if (!window.confirm(`Send this to ${data.student.name.split(' ')[0]}?\n\n"Please come to the Funun al-Quran office to discuss your kitabat further."`)) return;
    try { await post({ event: 'meet_request' }); setToast('Meeting request sent'); await load(); onChanged?.(); } catch (err) { setToast(err instanceof Error ? err.message : 'Could not send.'); }
  };
  const finishDrawing = async () => {
    setDrawBusy(true);
    try {
      const files = (await annRef.current?.exportFiles()) ?? [];
      setDrawing(null);
      if (files.length) { sendFiles(files, text.trim()); setText(''); }
    } catch (err) { setToast(err instanceof Error ? err.message : 'Could not send the drawing.'); } finally { setDrawBusy(false); }
  };

  const ctx: BubbleContext = useMemo(() => ({
    staffView: staff, annotationsById: EMPTY_MAP, submissionsById: EMPTY_MAP,
    fileLabel: () => null, openFiles: (items, index) => setViewer({ items, index }), openAnnotation: () => undefined,
  }), [staff]);

  if (!data && !error) return <div className="v2-thread v3ch-wa is-loading"><PenLoader compact label="Opening the chat…" /></div>;
  if (!data) {
    return (
      <div className="v2-thread v3ch-wa is-error">
        <p className="v2-inline-error" role="alert">{error}</p>
        <button type="button" className="btn btn-outline" onClick={() => void load(true)}><RefreshCw size={15} /> Try again</button>
      </div>
    );
  }

  const isMine = (m: DeptMessage) => (staff ? m.senderRole !== 'student' : m.senderRole === 'student');
  const tickFor = (m: DeptMessage): Tick => (staff ? (m.readByStudent ? 'read' : 'delivered') : (m.readByStaff ? 'read' : 'delivered'));
  const first = data.student.name.split(' ')[0];
  const aiContext = messages.filter(m => m.body).slice(-8).map(m => `${m.senderRole === 'student' ? 'Student' : 'Teacher'}: ${m.body}`).join('\n');

  let lastDay = '';
  let lastSender = '';
  const rows: JSX.Element[] = [];
  for (const m of messages) {
    const d = dayKey(m.createdAt);
    if (d !== lastDay) { rows.push(<div key={`d-${d}`} className="v2-day" role="separator"><span>{dayLabel(m.createdAt)}</span></div>); lastDay = d; lastSender = ''; }
    const mine = isMine(m);
    const showSender = m.kind !== 'system' && m.senderId !== lastSender;
    lastSender = m.senderId;
    rows.push(
      <div key={m.id} className={`v2-row${mine ? ' is-mine' : ''}${showSender ? ' is-first' : ''}`}>
        <MessageBubble message={m as unknown as ChatMessage} mine={mine} showSender={showSender && (staff || !mine)} tick={mine ? tickFor(m) : 'none'} ctx={ctx} />
      </div>,
    );
  }

  return (
    <section className={`v2-thread v3ch-wa v3ch-dept-conv${staff ? ' is-staff' : ''}`} style={{ '--v3ch-chat-fs': `${FONT_STEPS[staff ? fontIndex : 1].px}px` } as React.CSSProperties} aria-label={staff ? `Chat with ${data.student.name}` : 'Chat with the Funun al-Quran Department'} data-testid="dept-conversation">
      <header className="v2-thread-head v3ch-head">
        {onBack && <button type="button" className="v3ch-head-back" onClick={onBack} aria-label="Back to all chats"><ArrowLeft size={22} /></button>}
        {staff ? (
          <>
            <span className="v2-avatar" aria-hidden="true">{initials(data.student.name)}</span>
            <span className="v2-thread-title"><strong>{data.student.name}</strong><small>{[data.student.trNumber && `TR ${data.student.trNumber}`, data.student.className, data.student.branchName].filter(Boolean).join(' · ')}</small></span>
            <button type="button" className="v3ch-head-icon" onClick={nextFont} aria-label={`Text size: ${FONT_STEPS[fontIndex].label}`} title={`Text size: ${FONT_STEPS[fontIndex].label}`}><Type size={19} /></button>
          </>
        ) : (
          <>
            <span className="v2-avatar v3dc-avatar" aria-hidden="true"><img src="/funun-logo-white.png" alt="" onError={e => { e.currentTarget.style.display = 'none'; e.currentTarget.parentElement!.textContent = 'FQ'; }} /></span>
            <span className="v2-thread-title"><strong>Funun al-Quran Department</strong><small>Teachers of {data.student.branchName ?? 'your branch'} reply here</small></span>
          </>
        )}
      </header>
      <div className="v3ch-feed" ref={feedRef} onScroll={() => { const el = feedRef.current; if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 60); }} aria-live="polite">
        <div className="v3ch-lockline" role="note"><span>{staff ? `Every teacher of ${data.student.branchName ?? 'the branch'} sees this chat and can reply. ${first} is emailed when you reply.` : 'Ask anything about your courses, classes or kitabat. The teachers of Funun al-Quran reply here, and you get an email too.'}</span></div>
        {!messages.length && !pending.length && (
          <div className="v2-empty"><p>{staff ? `No messages yet. Write the first message to ${first}.` : 'Salaam! Write your question below, or send a photo or a voice note.'}</p></div>
        )}
        {rows}
        {pending.map(p => <div key={p.tempId} className="v2-row is-mine is-first"><PendingBubble p={p} /></div>)}
      </div>
      {!atBottom && <button type="button" className="v2-newpill" onClick={() => scrollToBottom(true)} aria-label="Go to the latest message"><ArrowDown size={16} /></button>}
      <div />
      {staff ? (
        <div className="v3ch-tools">
          <div className="v3ch-chips" role="toolbar" aria-label="More">
            <button type="button" className="v3ch-chip" onClick={() => void sendMeet()}><Building2 size={15} /> Ask to meet</button>
            <button type="button" className="v3ch-chip is-ai" onClick={() => setAiOpen(true)}><Sparkles size={15} /> AI helper</button>
            <button type="button" className="v3ch-chip" onClick={nextFont}><Type size={15} /> {FONT_STEPS[fontIndex].label} text</button>
          </div>
        </div>
      ) : <div />}
      <Composer text={text} setText={setText} leading={staff ? <AiOrb onClick={() => setAiOpen(true)} /> : undefined} onSendText={sendText} onSendFiles={sendFiles} onSendVoice={sendVoice} placeholder={staff ? `Message ${first}` : 'Message'} />

      {toast && <div className="v2-toast" role="status">{toast}</div>}
      {viewer && <MediaViewer items={viewer.items} startIndex={viewer.index} onClose={() => setViewer(null)} onAnnotate={a => { if (isImage(a) || isPdf(a)) { setViewer(null); setDrawing(a); } }} annotateLabel={staff ? 'Mark on it' : 'Draw on it'} />}
      {aiOpen && <AiHelper studentName={data.student.name} draft={text} context={aiContext} onUse={setText} onClose={() => setAiOpen(false)} />}
      {drawing && (
        <div className="v2-annotate-overlay v3ch-annotate" role="dialog" aria-modal="true" aria-label="Draw on the photo">
          <header className="v2-viewer-bar v3ch-annotate-bar">
            <button type="button" onClick={() => { if (!annRef.current?.isDirty() || window.confirm('Close without sending your drawing?')) setDrawing(null); }} aria-label="Close"><X size={20} /></button>
            <strong>Draw on the photo</strong>
            <span className="v2-viewer-spacer" />
            <button type="button" className="v3ch-annotate-send" onClick={() => void finishDrawing()} disabled={drawBusy}>{drawBusy ? <Loader2 size={17} className="v2-spin" /> : <SendIcon size={17} />} <span>Send</span></button>
          </header>
          <Annotator ref={annRef} submissionId="" files={[drawing]} exportOnly hideSave startStorageKey={drawing.storageKey} />
        </div>
      )}
    </section>
  );
}
