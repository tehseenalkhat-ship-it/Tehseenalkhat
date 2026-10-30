import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, Check, FileImage, Lock, MessageCircle, Mic, RefreshCw, Send, Square } from 'lucide-react';
import { apiFetch, ApiError, getSessionUser, getViewUrl, uploadFile } from '@/api';
import './CourseJourney.css';

type JourneyKind = 'enrolled' | 'practice_submission' | 'teacher_entry';
type EntryKind = 'practice_marking' | 'checkpoint_assessment' | 'secondary_marking' | null;
type JourneyItem = {
  id: string;
  kind: JourneyKind;
  level_id: string | null;
  level_title: string | null;
  level_order_index: number | null;
  entry_kind: EntryKind;
  storage_key: string | null;
  original_filename: string | null;
  time_spent_minutes: number | null;
  status: string;
  mark_out_of_ten: number | null;
  mark_passed: boolean | null;
  feedback: string | null;
  correction_image_storage_key: string | null;
  correction_voice_storage_key: string | null;
  redo_of_entry_id: string | null;
  created_at: string;
  reviewed_at: string | null;
};
type JourneyData = {
  student_id: string;
  course: { id: string; title: string; category: 'certification' | 'secondary'; khat_type_name: string };
  items: JourneyItem[];
};
type Props = { courseId?: string; anchorEntryId?: string; levelId?: string; compact?: boolean; onBack?: () => void };
type ChatMessage = {
  id: string;
  sender_id: string;
  sender_name: string;
  sender_role: string;
  type: 'text' | 'voice';
  content: string | null;
  storage_key: string | null;
  created_at: string;
};

function ChatVoiceMessage({ storageKey }: { storageKey: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getViewUrl(storageKey).then(value => { if (!cancelled) setUrl(value); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [storageKey]);
  return url ? <audio className="course-chat-audio" controls preload="none" src={url} aria-label="Voice note" /> : <span className="course-chat-audio-loading"><Mic size={14} /> Voice note</span>;
}

function CourseActivityMessages({ item, userRole }: { item: JourneyItem; userRole: string }) {
  const mine = userRole === 'student';
  const reviewMine = userRole === 'teacher' || userRole === 'admin';
  const itemDate = new Date(item.created_at);
  const label = item.entry_kind === 'checkpoint_assessment' ? 'Checkpoint submission' : 'Practice submission';
  const status = resultLabel(item);
  if (item.kind === 'enrolled') return <div className="course-chat-system"><Check size={13} /><span>Course journey started · {itemDate.toLocaleDateString()}</span></div>;
  return <>
    <article className={`course-chat-message course-chat-submission${mine ? ' is-mine' : ''}`}>
      {!mine && <small className="course-chat-sender">Student</small>}
      <strong className="course-chat-entry-label">{label}</strong>
      <strong className="course-chat-entry-title">{item.level_title ?? 'Course activity'}{item.level_order_index !== null ? ` · Level ${item.level_order_index + 1}` : ''}</strong>
      {status && <span className={`course-chat-status is-${status.tone}`}>{status.label}</span>}
      {item.storage_key && <JourneyAttachment storageKey={item.storage_key} filename={item.original_filename} kind="image" />}
      <div className="course-chat-entry-meta">
        {item.time_spent_minutes !== null && <span>{item.time_spent_minutes} min practice</span>}
        {item.mark_out_of_ten !== null && <strong>{item.mark_out_of_ten}/10</strong>}
        <time dateTime={item.created_at}>{itemDate.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</time>
      </div>
    </article>
    {item.feedback && <article className={`course-chat-message${reviewMine ? ' is-mine' : ''}`}>
      {!reviewMine && <small className="course-chat-sender">Course review team</small>}
      <p>{item.feedback}</p>
      <time dateTime={item.reviewed_at ?? item.created_at}>{new Date(item.reviewed_at ?? item.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>
    </article>}
    {item.correction_image_storage_key && <article className={`course-chat-message${reviewMine ? ' is-mine' : ''}`}>
      {!reviewMine && <small className="course-chat-sender">Course review team</small>}
      <JourneyAttachment storageKey={item.correction_image_storage_key} filename="Annotated feedback" kind="image" />
      <time dateTime={item.reviewed_at ?? item.created_at}>{new Date(item.reviewed_at ?? item.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>
    </article>}
    {item.correction_voice_storage_key && <article className={`course-chat-message${reviewMine ? ' is-mine' : ''}`}>
      {!reviewMine && <small className="course-chat-sender">Course review team</small>}
      <ChatVoiceMessage storageKey={item.correction_voice_storage_key} />
      <time dateTime={item.reviewed_at ?? item.created_at}>{new Date(item.reviewed_at ?? item.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>
    </article>}
  </>;
}

function EntryChat({ studentId, courseId, items, threadKey = 'course' }: { studentId: string; courseId: string; items: JourneyItem[]; threadKey?: string }) {
  const user = getSessionUser();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const feedRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);

  const loadMessages = async (initial = false) => {
    if (initial) setLoading(true);
    try {
      const query = threadKey === 'course' ? '' : `?threadKey=${encodeURIComponent(threadKey)}`;
      const result = await apiFetch<{ messages: ChatMessage[] }>(`/chat/students/${studentId}/courses/${courseId}/messages${query}`, { silent: true });
      setMessages(result.messages ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load this conversation.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadMessages(true);
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadMessages();
    }, 7000);
    const refresh = () => { if (document.visibilityState === 'visible') void loadMessages(); };
    window.addEventListener('focus', refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refresh);
      streamRef.current?.getTracks().forEach(track => track.stop());
      if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studentId, courseId, threadKey]);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, items]);

  const sendText = async (event?: React.FormEvent) => {
    event?.preventDefault();
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    setError(null);
    try {
      await apiFetch(`/chat/students/${studentId}/courses/${courseId}/messages`, { method: 'POST', body: { type: 'text', content, ...(threadKey === 'course' ? {} : { threadKey }) } });
      setDraft('');
      await loadMessages();
      draftRef.current?.focus();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Message could not be sent.');
    } finally {
      setSending(false);
    }
  };

  const toggleVoiceRecording = async () => {
    if (recording) {
      recorderRef.current?.stop();
      setRecording(false);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('Voice recording is not supported by this browser.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      streamRef.current = stream;
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = event => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach(track => track.stop());
        streamRef.current = null;
        const type = recorder.mimeType || 'audio/webm';
        const extension = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
        const file = new File(chunksRef.current, `voice-note-${Date.now()}.${extension}`, { type });
        if (!file.size) { setError('No audio was captured. Please try again.'); return; }
        setSending(true);
        setError(null);
        try {
          const uploaded = await uploadFile('chat-audio', file);
          await apiFetch(`/chat/students/${studentId}/courses/${courseId}/messages`, { method: 'POST', body: { type: 'voice', storageKey: uploaded.storageKey, ...(threadKey === 'course' ? {} : { threadKey }) } });
          await loadMessages();
        } catch (err) {
          setError(err instanceof ApiError ? err.message : 'Voice note could not be sent.');
        } finally {
          setSending(false);
        }
      };
      recorder.start();
      setRecording(true);
      setError(null);
    } catch (err) {
      setError(err instanceof Error && err.name === 'NotAllowedError' ? 'Allow microphone access to record a voice note.' : 'Could not access your microphone.');
    }
  };

  const transcript = [
    ...items.map(item => ({ id: `activity-${item.kind}-${item.id}`, created_at: item.created_at, activity: item as JourneyItem, message: null as ChatMessage | null })),
    ...messages.map(message => ({ id: `message-${message.id}`, created_at: message.created_at, activity: null as JourneyItem | null, message })),
  ].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  return <section className="course-chat" aria-label="Student and teacher chat">
    <div className="course-chat-feed" ref={feedRef} aria-live="polite">
      {loading && <p className="course-chat-state">Loading messages…</p>}
      {!loading && transcript.length === 0 && <div className="course-chat-empty"><MessageCircle size={20} /><span>Start the conversation. Your submissions, teacher feedback, and voice notes will appear here.</span></div>}
      {transcript.map(item => {
        if (item.activity) return <div key={item.id} className="course-chat-transcript-activity"><CourseActivityMessages item={item.activity} userRole={user?.role ?? 'student'} /></div>;
        const message = item.message;
        if (!message) return null;
        const mine = message.sender_id === user?.id;
        const time = new Date(message.created_at);
        return <article key={item.id} className={`course-chat-message${mine ? ' is-mine' : ''}`}>
          {!mine && <small className="course-chat-sender">{message.sender_name || (message.sender_role === 'teacher' ? 'Teacher' : 'Student')}</small>}
          {message.type === 'text' ? <p>{message.content}</p> : message.storage_key ? <ChatVoiceMessage storageKey={message.storage_key} /> : null}
          <time dateTime={message.created_at}>{time.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>
        </article>;
      })}
      <div className="course-chat-bottom" />
    </div>
    {error && <p className="course-chat-error" role="alert">{error}</p>}
    <form className="course-chat-composer" onSubmit={event => void sendText(event)}>
      <textarea ref={draftRef} value={draft} onChange={event => setDraft(event.currentTarget.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendText(); } }} rows={1} maxLength={4000} placeholder="Type a message" aria-label="Type a chat message" disabled={sending || recording} />
      <button type="button" className={`course-chat-mic${recording ? ' is-recording' : ''}`} onClick={() => void toggleVoiceRecording()} disabled={sending} aria-label={recording ? 'Stop and send voice note' : 'Record voice note'} title={recording ? 'Stop and send voice note' : 'Record voice note'}>{recording ? <Square size={17} fill="currentColor" /> : <Mic size={19} />}</button>
      <button type="submit" className="course-chat-send" disabled={sending || !draft.trim() || recording} aria-label="Send message" title="Send message"><Send size={17} /></button>
    </form>
    {recording && <small className="course-chat-recording-hint">Recording… select stop to send</small>}
  </section>;
}

function JourneyAttachment({ storageKey, filename, kind }: { storageKey: string; filename?: string | null; kind: 'image' | 'audio' }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!storageKey || !hostRef.current) return;
    let cancelled = false;
    const resolveUrl = () => {
      void getViewUrl(storageKey).then(resolved => {
        if (!cancelled) setUrl(resolved);
      }).catch(() => {
        if (!cancelled) setFailed(true);
      });
    };
    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          observer.disconnect();
          resolveUrl();
        }
      }, { root: hostRef.current?.closest('.course-chat-feed') ?? null, rootMargin: '220px' });
      observer.observe(hostRef.current);
      return () => { cancelled = true; observer.disconnect(); };
    }
    resolveUrl();
    return () => { cancelled = true; };
  }, [storageKey]);

  return <div ref={hostRef} className={kind === 'image' ? 'course-journey-attachment' : 'course-journey-audio-host'}>
    {kind === 'image'
      ? url ? <a className="course-journey-submission-image" href={url} target="_blank" rel="noreferrer"><img src={url} alt={filename ?? 'Calligraphy submission'} loading="lazy" /></a> : <span className="course-journey-file-unavailable"><FileImage size={16} />{failed ? 'Preview unavailable' : 'Loading submission preview…'}</span>
      : url ? <audio className="course-journey-audio" controls preload="none" src={url} aria-label="Voice feedback from the course review team" /> : <span className="course-journey-voice-pending"><Mic size={13} />{failed ? 'Voice note unavailable' : 'Voice feedback'}</span>}
  </div>;
}

function resultLabel(item: JourneyItem): { label: string; tone: 'amber' | 'green' | 'red' | 'blue' } | null {
  if (item.status === 'legacy_practice') return { label: 'Earlier practice upload', tone: 'blue' };
  if (['pending', 'assigned', 'in_review'].includes(item.status)) {
    return { label: item.status === 'in_review' ? 'Being reviewed' : 'Waiting for review', tone: 'amber' };
  }
  if (item.status === 'redo_needed' || item.mark_passed === false) return { label: 'Redo needed', tone: 'red' };
  if (item.status === 'reviewed' || item.mark_passed === true) return { label: 'Passed', tone: 'green' };
  return null;
}

export function CourseJourney({ courseId, anchorEntryId, levelId, compact = false, onBack }: Props) {
  const [data, setData] = useState<JourneyData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async (refresh = false) => {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const route = anchorEntryId ? `/journeys/entries/${anchorEntryId}` : `/journeys/courses/${courseId}`;
      const journey = await apiFetch<JourneyData>(route);
      setData(journey);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load this course journey.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void load();
    // Reload when the chosen course/entry changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId, anchorEntryId]);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void load(true);
    };
    const interval = window.setInterval(refreshWhenVisible, 7_000);
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId, anchorEntryId]);

  const items = (data?.items ?? []).filter(item => !levelId || item.level_id === levelId);
  const activeLevel = [...items].reverse().find(item => item.level_id === levelId);
  const viewer = getSessionUser();
  const threadKey = levelId ? `level:${levelId}` : 'course';
  const pendingCount = items.filter(item => item.kind === 'teacher_entry' && ['pending', 'assigned', 'in_review'].includes(item.status)).length;

  return (
    <section className={`course-journey${compact ? ' is-compact' : ''}`} aria-label="Course journey">
      <header className="course-journey-header">
        {compact && onBack && <button type="button" className="course-journey-back" onClick={onBack} aria-label="Back to chats"><ArrowLeft size={19} /></button>}
        <span className="course-journey-avatar">{levelId ? (viewer?.name.split(/\s+/).map(part => part[0]).slice(0, 2).join('').toUpperCase() || 'S') : <BookOpen size={18} />}</span>
        <div className="course-journey-heading-copy">
          <strong>{levelId ? viewer?.name ?? 'Your review chat' : data?.course.title ?? 'Course journey'}</strong>
          <small>{levelId && activeLevel ? `Level ${activeLevel.level_order_index !== null ? activeLevel.level_order_index + 1 : ''} · ${activeLevel.level_title ?? 'Practice'} · Upload 1 · Private review chat` : data ? `${data.course.khat_type_name} · private student–teacher chat` : 'Your course conversation'}</small>
        </div>
        {activeLevel?.mark_out_of_ten !== null && activeLevel?.mark_out_of_ten !== undefined && <span className="course-journey-mark">{activeLevel.mark_out_of_ten}/10</span>}
        <span className="course-journey-presence"><i /> Private</span>
        <button type="button" className="course-journey-refresh" onClick={() => void load(true)} disabled={loading || refreshing} aria-label="Refresh journey" title="Refresh journey">
          <RefreshCw size={15} className={refreshing ? 'is-spinning' : ''} />
        </button>
      </header>

      {error
        ? <div className="course-journey-error" role="alert">{error}<button type="button" onClick={() => void load()}>Try again</button></div>
        : loading && !data
          ? <p className="course-journey-state">Loading your course conversation…</p>
          : data && <EntryChat key={`${data.student_id}-${data.course.id}-${threadKey}`} studentId={data.student_id} courseId={data.course.id} items={items} threadKey={threadKey} />}

      {!compact && <footer className="course-journey-footer">
        <span>{pendingCount > 0 ? <><i className="is-waiting" /> {pendingCount} item{pendingCount === 1 ? '' : 's'} with the review team</> : <><Lock size={12} /> Visible only to you and authorized course reviewers</>}</span>
        <span className="course-journey-readonly">Course chat</span>
      </footer>}
    </section>
  );
}
