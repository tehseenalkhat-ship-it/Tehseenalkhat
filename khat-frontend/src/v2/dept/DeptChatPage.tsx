import { useCallback, useEffect, useMemo, useState } from 'react';
import { MessageSquarePlus, RefreshCw, Search, X } from 'lucide-react';
import { ApiError, apiFetch } from '@/api';
import { PenLoader } from '@/components/ui';
import { initials, timeLabel } from '../chat/media';
import { readV2Param } from '../nav';
import { DeptConversation } from './DeptConversation';
import type { DeptListResponse, DeptThreadSummary } from './types';
import './dept.css';

type Props = { mode: 'student' | 'staff' };

/**
 * Route `v2-dept-chat`. Students: one WhatsApp-style chat with the Funun al-Quran Department.
 * Staff: WhatsApp-desktop layout — list of student chats (unread first) + the open chat; on a phone, list → chat.
 */
export function V2DeptChatPage({ mode }: Props) {
  if (mode === 'student') {
    return (
      <div className="page v3ch-dept-page is-student">
        <DeptConversation studentId="me" mode="student" />
      </div>
    );
  }
  return <StaffDeptChat />;
}

function shortTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return timeLabel(iso);
  const y = new Date(today); y.setDate(today.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function StaffDeptChat() {
  const [threads, setThreads] = useState<DeptThreadSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [newChat, setNewChat] = useState(false);
  const [openId, setOpenId] = useState<string | null>(() => readV2Param('studentId'));

  const load = useCallback(async (initial = false) => {
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set('q', q.trim());
      if (newChat) params.set('all', '1');
      const res = await apiFetch<DeptListResponse>(`/v2/dept-chat${params.toString() ? `?${params}` : ''}`, { silent: !initial });
      if (res.mode === 'staff') setThreads(res.threads);
      setError(null);
    } catch (err) {
      if (initial) setError(err instanceof ApiError ? err.message : 'The chats could not be loaded.');
    }
  }, [q, newChat]);

  useEffect(() => { const t = window.setTimeout(() => void load(threads === null), q ? 250 : 0); return () => window.clearTimeout(t); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [load]);
  useEffect(() => {
    const id = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 15_000);
    return () => window.clearInterval(id);
  }, [load]);

  const shown = useMemo(() => (threads ?? []).filter(t => (filter === 'unread' ? t.unread > 0 : true)).filter(t => (newChat || q ? true : !!t.lastAt)), [threads, filter, newChat, q]);
  const totalUnread = (threads ?? []).reduce((s, t) => s + t.unread, 0);
  const open = (id: string) => {
    setOpenId(id);
    setThreads(prev => prev?.map(t => (t.studentId === id ? { ...t, unread: 0 } : t)) ?? prev);
  };

  return (
    <div className={`page v3ch-dept-page is-staff${openId ? ' has-open' : ''}`}>
      <aside className="v3ch-dept-list" aria-label="Student chats">
        <header className="v3ch-dept-list-head">
          <div>
            <h1>Funun al-Quran chats</h1>
            <p>{totalUnread ? `${totalUnread} unread message${totalUnread === 1 ? '' : 's'}` : 'Students write here; any teacher of the branch can reply.'}</p>
          </div>
          <button type="button" className={`v3ch-dept-new${newChat ? ' is-on' : ''}`} onClick={() => setNewChat(v => !v)} aria-pressed={newChat} aria-label={newChat ? 'Close new chat' : 'Start a new chat'} title="New chat">
            {newChat ? <X size={20} /> : <MessageSquarePlus size={20} />}
          </button>
        </header>
        <div className="v3ch-dept-search">
          <Search size={16} />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder={newChat ? 'Find a student by name or TR number' : 'Search chats'} aria-label="Search" />
          {q && <button type="button" onClick={() => setQ('')} aria-label="Clear search"><X size={15} /></button>}
        </div>
        {!newChat && (
          <div className="v3ch-dept-filters" role="tablist">
            <button type="button" role="tab" aria-selected={filter === 'all'} className={filter === 'all' ? 'is-active' : ''} onClick={() => setFilter('all')}>All</button>
            <button type="button" role="tab" aria-selected={filter === 'unread'} className={filter === 'unread' ? 'is-active' : ''} onClick={() => setFilter('unread')}>Unread{totalUnread ? ` · ${totalUnread}` : ''}</button>
          </div>
        )}
        {newChat && <p className="v3ch-dept-hint">Choose a student to start a chat. They are emailed when you write.</p>}
        <div className="v3ch-dept-items" data-testid="dept-list">
          {threads === null && !error && <PenLoader compact label="Loading chats…" />}
          {error && (
            <div className="v3ch-dept-empty"><p className="v2-inline-error" role="alert">{error}</p><button type="button" className="btn btn-outline" onClick={() => void load(true)}><RefreshCw size={15} /> Try again</button></div>
          )}
          {threads !== null && !shown.length && (
            <div className="v3ch-dept-empty"><p>{filter === 'unread' ? 'No unread messages. Well done!' : q ? 'No student found.' : 'No chats yet. When a student writes to the department, it appears here.'}</p></div>
          )}
          {shown.map(t => (
            <button key={t.studentId} type="button" className={`v3ch-dept-item${openId === t.studentId ? ' is-open' : ''}${t.unread ? ' is-unread' : ''}`} onClick={() => open(t.studentId)}>
              <span className="v2-avatar" aria-hidden="true">{initials(t.name)}</span>
              <span className="v3ch-dept-item-main">
                <span className="v3ch-dept-item-top"><strong>{t.name}</strong><time>{shortTime(t.lastAt)}</time></span>
                <span className="v3ch-dept-item-bottom">
                  <span>{t.lastPreview ?? [t.trNumber && `TR ${t.trNumber}`, t.className, t.branchName].filter(Boolean).join(' · ')}</span>
                  {t.unread > 0 && <b aria-label={`${t.unread} unread`}>{t.unread}</b>}
                </span>
              </span>
            </button>
          ))}
        </div>
      </aside>
      <main className="v3ch-dept-main">
        {openId ? (
          <DeptConversation key={openId} studentId={openId} mode="staff" onBack={() => setOpenId(null)} onChanged={() => void load()} />
        ) : (
          <div className="v3ch-dept-placeholder">
            <span className="v3ch-dept-placeholder-logo" aria-hidden="true"><img src="/funun-logo-white.png" alt="" /></span>
            <h2>Funun al-Quran Department</h2>
            <p>Choose a chat on the left. Students’ questions come here instead of to one teacher, so any teacher of the branch can reply.</p>
          </div>
        )}
      </main>
    </div>
  );
}
