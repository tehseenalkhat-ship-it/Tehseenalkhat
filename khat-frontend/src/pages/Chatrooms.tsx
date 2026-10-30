import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, BookOpen, Check, MessageCircle, Mic, Search, Send, Square, Users } from 'lucide-react';
import { ApiError, apiFetch, getSessionUser, getViewUrl, uploadFile } from '@/api';
import { displayCourseTitle } from '@/data/mock';
import { CourseJourney } from '@/components/CourseJourney';
import { SectionHeading } from '@/components/ui';
import './Chatrooms.css';

type CourseThread = { course_id: string; course_title: string; category: 'certification' | 'secondary'; khat_type_name: string; current_level_index: number; percent_complete: number | string; enrolled_at: string; unread_count: number; last_message_at: string | null };
type Contact = { id: string; name: string; branch_id: string | null; branch_name: string | null; photo_storage_key: string | null; unread_count?: number; last_message_at?: string | null };
type ChatMessage = { id: string; sender_id: string; sender_name: string; sender_role: string; type: 'text' | 'voice'; content: string | null; storage_key: string | null; created_at: string };
type Filter = 'all' | 'waiting' | 'marked';
type Selection = { type: 'course'; id: string } | { type: 'teacher'; id: string } | null;
const CHAT_COURSE_REQUEST_KEY = 'khat_chat_course_request';

function Voice({ storageKey }: { storageKey: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => { let alive = true; void getViewUrl(storageKey).then(url => { if (alive) setSrc(url); }).catch(() => undefined); return () => { alive = false; }; }, [storageKey]);
  return src ? <audio controls preload="none" src={src} aria-label="Voice note" /> : <span className="chatroom-voice-loading"><Mic size={14} /> Voice note</span>;
}

function DirectTeacherChat({ contact, teacherId, studentView, onRead, onBack }: { contact: Contact; teacherId: string; studentView: boolean; onRead: () => void; onBack: () => void }) {
  const user = getSessionUser();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (initial = false) => {
    if (initial) setLoading(true);
    try {
      const url = studentView ? `/chat/direct/teachers/${teacherId}/messages` : `/chat/direct/students/${contact.id}/teachers/${teacherId}/messages`;
      const result = await apiFetch<{ messages: ChatMessage[] }>(url, { silent: true });
      setMessages(result.messages ?? []);
      setError(null);
      onRead();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load this conversation.');
    } finally { setLoading(false); }
  };
  useEffect(() => {
    void load(true);
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 8000);
    return () => window.clearInterval(timer);
  }, [contact.id, teacherId, studentView]);

  const send = async () => {
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true); setError(null);
    try {
      const url = studentView ? `/chat/direct/teachers/${teacherId}/messages` : `/chat/direct/students/${contact.id}/teachers/${teacherId}/messages`;
      await apiFetch(url, { method: 'POST', body: { type: 'text', content } });
      setDraft(''); await load();
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Message could not be sent.'); }
    finally { setSending(false); }
  };
  const voice = async () => {
    if (recording) { setRecording(false); return; }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { setError('Voice recording is not supported by this browser.'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream); const chunks: Blob[] = [];
      setRecording(true);
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach(track => track.stop()); setRecording(false);
        const mimeType = recorder.mimeType || 'audio/webm';
        const extension = mimeType.includes('mp4') ? 'm4a' : mimeType.includes('ogg') ? 'ogg' : 'webm';
        const file = new File(chunks, `teacher-guidance-${Date.now()}.${extension}`, { type: mimeType });
        if (!file.size) return;
        setSending(true);
        try { const uploaded = await uploadFile('chat-audio', file); const url = studentView ? `/chat/direct/teachers/${teacherId}/messages` : `/chat/direct/students/${contact.id}/teachers/${teacherId}/messages`; await apiFetch(url, { method: 'POST', body: { type: 'voice', storageKey: uploaded.storageKey } }); await load(); }
        catch (err) { setError(err instanceof ApiError ? err.message : 'Voice note could not be sent.'); }
        finally { setSending(false); }
      };
      recorder.start();
      const stop = () => { if (recorder.state !== 'inactive') recorder.stop(); };
      window.setTimeout(stop, 60_000);
      (window as Window & { __teacherChatStop?: () => void }).__teacherChatStop = stop;
    } catch (err) { setRecording(false); setError(err instanceof Error && err.name === 'NotAllowedError' ? 'Allow microphone access to record a voice note.' : 'Could not access your microphone.'); }
  };
  const stopVoice = () => { (window as Window & { __teacherChatStop?: () => void }).__teacherChatStop?.(); };

  return <section className="chatroom-conversation" aria-label={`Chat with ${contact.name}`}>
    <header className="chatroom-conversation-header"><button type="button" className="chatroom-back" onClick={onBack} aria-label="Back to chats"><ArrowLeft size={19} /></button><span className="chatroom-avatar">{contact.name.split(/\s+/).map(part => part[0]).slice(0, 2).join('').toUpperCase()}</span><span><strong>{contact.name}</strong><small>{contact.branch_name ?? (studentView ? 'Registered teacher' : 'Student')} · Direct guidance</small></span><span className="chatroom-secure"><i /> Private</span></header>
    <div className="chatroom-feed" aria-live="polite">
      {loading && <p className="chatroom-empty">Loading conversation…</p>}
      {!loading && !messages.length && <p className="chatroom-empty">Send a message to ask this teacher for guidance.</p>}
      {messages.map(message => {
        const mine = message.sender_id === user?.id;
        const time = new Date(message.created_at);
        return <article key={message.id} className={`chatroom-bubble${mine ? ' is-mine' : ''}`}>
          {!mine && <small>{message.sender_name}</small>}
          {message.type === 'text' ? <p>{message.content}</p> : message.storage_key ? <Voice storageKey={message.storage_key} /> : null}
          <time dateTime={message.created_at}>{time.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>
        </article>;
      })}
    </div>
    {error && <p className="chatroom-error" role="alert">{error}</p>}
    <form className="chatroom-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
      <textarea value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }} rows={1} maxLength={4000} placeholder="Type a message" aria-label="Type a teacher message" disabled={sending || recording} />
      <button type="button" className={recording ? 'is-recording' : ''} onClick={() => recording ? stopVoice() : void voice()} aria-label={recording ? 'Stop and send voice note' : 'Record voice note'} disabled={sending}>{recording ? <Square size={16} fill="currentColor" /> : <Mic size={17} />}</button>
      <button type="submit" disabled={sending || !draft.trim() || recording} aria-label="Send message"><Send size={16} /></button>
    </form>
  </section>;
}

export function Chatrooms({ audience = 'student' }: { audience?: 'student' | 'teacher' }) {
  const currentUser = getSessionUser();
  const [courses, setCourses] = useState<CourseThread[]>([]);
  const [teachers, setTeachers] = useState<Contact[]>([]);
  const [directory, setDirectory] = useState<Contact[]>([]);
  const [selection, setSelection] = useState<Selection>(() => {
    const courseId = window.sessionStorage.getItem(CHAT_COURSE_REQUEST_KEY);
    window.sessionStorage.removeItem(CHAT_COURSE_REQUEST_KEY);
    return courseId ? { type: 'course', id: courseId } : null;
  });
  const [mobileList, setMobileList] = useState(() => !window.matchMedia('(max-width: 760px)').matches);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refresh = async (initial = false) => {
    if (initial) setLoading(true);
    try {
      const [threadResult, contactResult] = audience === 'student'
        ? await Promise.all([
            apiFetch<{ courses: CourseThread[]; teachers: { teacher_id: string; teacher_name: string; branch_id: string | null; branch_name: string | null; photo_storage_key: string | null; unread_count: number; last_message_at: string | null }[] }>('/chat/threads', { silent: true }),
            apiFetch<{ teachers: Contact[] }>('/chat/teachers', { silent: true }),
          ])
        : await Promise.all([
            apiFetch<{ students: { student_id: string; student_name: string; branch_id: string | null; branch_name: string | null; photo_storage_key: string | null; unread_count: number; last_message_at: string | null }[] }>('/chat/teacher-threads', { silent: true }),
            Promise.resolve({ teachers: [] as Contact[] }),
          ]);
      const courseRows = audience === 'student' ? ('courses' in threadResult ? threadResult.courses ?? [] : []) : [];
      const directRows: Contact[] = audience === 'student'
        ? ('teachers' in threadResult ? threadResult.teachers ?? [] : []).map(item => ({ id: item.teacher_id, name: item.teacher_name, branch_id: item.branch_id, branch_name: item.branch_name, photo_storage_key: item.photo_storage_key, unread_count: item.unread_count, last_message_at: item.last_message_at }))
        : ('students' in threadResult ? threadResult.students ?? [] : []).map(item => ({ id: item.student_id, name: item.student_name, branch_id: item.branch_id, branch_name: item.branch_name, photo_storage_key: item.photo_storage_key, unread_count: item.unread_count, last_message_at: item.last_message_at }));
      setCourses(courseRows); setTeachers(directRows); setDirectory(contactResult.teachers ?? []); setError(null);
      setSelection(current => current ?? (courseRows[0] ? { type: 'course', id: courseRows[0].course_id } : directRows[0] ? { type: 'teacher', id: directRows[0].id } : null));
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Could not load your chats.'); }
    finally { setLoading(false); }
  };
  useEffect(() => {
    void refresh(true);
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 12000);
    return () => window.clearInterval(timer);
  }, [audience]);

  const contacts = useMemo(() => {
    const recent = new Set(teachers.map(item => item.id));
    return audience === 'student' ? [...teachers, ...directory.filter(item => !recent.has(item.id))] : teachers;
  }, [audience, teachers, directory]);
  const courseRows = courses.filter(item => {
    if (filter === 'waiting' && !Number(item.unread_count)) return false;
    if (filter === 'marked' && Number(item.unread_count)) return false;
    return item.course_title.toLowerCase().includes(search.toLowerCase()) || item.khat_type_name.toLowerCase().includes(search.toLowerCase());
  });
  const teacherRows = contacts.filter(item => !search || `${item.name} ${item.branch_name ?? ''}`.toLowerCase().includes(search.toLowerCase()));
  const activeCourse = selection?.type === 'course' ? courses.find(item => item.course_id === selection.id) : null;
  const activeTeacher = selection?.type === 'teacher' ? contacts.find(item => item.id === selection.id) : null;
  const unreadTotal = courses.reduce((sum, item) => sum + Number(item.unread_count || 0), 0) + teachers.reduce((sum, item) => sum + Number(item.unread_count || 0), 0);
  const selectChat = (next: Selection) => { setSelection(next); setMobileList(false); };

  return <main className="page portal-page chatrooms-page">
    <SectionHeading eyebrow={audience === 'student' ? 'Your reviews' : 'Student guidance'} title={audience === 'student' ? 'Chats' : 'Student messages'} text={audience === 'student' ? 'Your course conversations and private teacher guidance, together in one place.' : 'Private guidance conversations with your students.'} action={<span className="chatrooms-unread-total">{unreadTotal ? `${unreadTotal} unread` : 'All caught up'}</span>} />
    {error && <p className="error-text" role="alert">{error}</p>}
    <section className={`chatrooms-layout${mobileList ? ' is-mobile-list' : ' is-mobile-chat'}`} aria-label="Chats and contacts">
      <aside className="chatrooms-sidebar">
        <div className="chatrooms-toolbar">
          <div className="chatrooms-filters" role="group" aria-label="Filter course chats">
            {(['all', 'waiting', 'marked'] as Filter[]).map(value => <button type="button" key={value} className={filter === value ? 'active' : ''} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === 'all' ? 'All' : value === 'waiting' ? 'Waiting' : 'Marked'}</button>)}
          </div>
          <label className="chatrooms-search"><Search size={15} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search courses or teachers" aria-label="Search chats and teachers" /></label>
        </div>
        <div className="chatrooms-thread-list">
          <div className="chatrooms-list-label"><BookOpen size={14} /> Course chats <span>{courses.length}</span></div>
          {loading && <p className="chatrooms-list-state">Loading your courses…</p>}
          {!loading && !courseRows.length && <p className="chatrooms-list-state">No enrolled course chats match this filter.</p>}
          {courseRows.map(item => <button type="button" key={item.course_id} className={`chatrooms-thread${selection?.type === 'course' && selection.id === item.course_id ? ' active' : ''}`} onClick={() => selectChat({ type: 'course', id: item.course_id })}>
            <span className="chatrooms-thread-icon"><BookOpen size={16} /></span><span className="chatrooms-thread-copy"><strong>{displayCourseTitle(item.course_title)}</strong><small>{item.khat_type_name} · Level {Number(item.current_level_index) + 1}</small></span>{Number(item.unread_count) > 0 ? <b className="chatrooms-unread-badge">{item.unread_count}</b> : item.last_message_at ? <time>{new Date(item.last_message_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</time> : <span className="chatrooms-waiting">Open</span>}
          </button>)}
          <div className="chatrooms-list-label"><Users size={14} /> {audience === 'student' ? 'Teachers' : 'Students'} <span>{contacts.length}</span></div>
          {teacherRows.map(item => <button type="button" key={item.id} className={`chatrooms-thread${selection?.type === 'teacher' && selection.id === item.id ? ' active' : ''}`} onClick={() => selectChat({ type: 'teacher', id: item.id })}>
            <span className="chatrooms-thread-icon teacher">{item.name.split(/\s+/).map(part => part[0]).slice(0, 2).join('').toUpperCase()}</span><span className="chatrooms-thread-copy"><strong>{item.name}</strong><small>{item.branch_name ?? 'Teacher'} · Ask for guidance</small></span>{Number(item.unread_count) > 0 ? <b className="chatrooms-unread-badge">{item.unread_count}</b> : null}
          </button>)}
          {!loading && !teacherRows.length && <p className="chatrooms-list-state">No teachers match your search.</p>}
        </div>
      </aside>
      <section className="chatrooms-panel">
        {activeCourse ? <CourseJourney key={activeCourse.course_id} courseId={activeCourse.course_id} compact onBack={() => setMobileList(true)} />
          : activeTeacher ? <DirectTeacherChat key={activeTeacher.id} contact={activeTeacher} teacherId={audience === 'student' ? activeTeacher.id : currentUser?.id ?? ''} studentView={audience === 'student'} onRead={() => { void refresh(); }} onBack={() => setMobileList(true)} />
            : <div className="chatrooms-welcome"><span><MessageCircle size={24} /></span><h2>Your conversations</h2><p>{audience === 'student' ? 'Enroll in a course to get its private course chat, or choose any teacher to ask for guidance.' : 'Private guidance conversations with students will appear here.'}</p></div>}
      </section>
    </section>
  </main>;
}
