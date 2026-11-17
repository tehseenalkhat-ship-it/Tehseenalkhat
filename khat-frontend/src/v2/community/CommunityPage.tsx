// owner: insights — Communities: staff-made student groups with a simple WhatsApp-like chat.
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
  Archive, ArrowLeft, FileText, Loader2, MessageCircle, Paperclip, Plus, Search, Send, UserMinus, UserPlus, Users, X,
} from 'lucide-react';
import { apiFetch, getDownloadUrl, getSessionUser, getViewUrl, uploadFile } from '@/api';
import { Modal, PenLoader } from '@/components/ui';
import type { Attachment, GroupMessage, StudentGroup } from '../contracts';
import { ErrorBox, initials, useStaffScope } from '../insights/common';
import './community.css';

type Props = { mode: 'student' | 'staff' };

/** Extra shapes from groups.routes.ts (not in contracts.ts). */
type GroupMember = { userId: string; name: string; trNumber: string | null; className: string | null; branchName: string | null; role: string; memberRole: string };
type GroupCandidate = { userId: string; name: string; trNumber: string | null; className: string | null; branchName: string | null };

function timeLabel(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  if (d.toDateString() === new Date(now.getTime() - 86_400_000).toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
}

export function V2CommunityPage({ mode }: Props) {
  const isStaff = mode === 'staff';
  const scope = useStaffScope();
  const [groups, setGroups] = useState<StudentGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setGroups(await apiFetch<StudentGroup[]>('/v2/groups', { silent: true }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your groups.');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const shown = useMemo(() => (groups ?? []).filter(g => `${g.name} ${g.purpose ?? ''}`.toLowerCase().includes(filter.trim().toLowerCase())), [groups, filter]);
  const active = groups?.find(g => g.id === activeId) ?? null;
  const branchName = (id: string | null) => (id ? scope.branches.find(b => b.id === id)?.name ?? null : 'All branches');

  return (
    <main className={`page portal-page v2-com-page${active ? ' has-active' : ''}`}>
      <header className="v2-com-hero">
        <div>
          <p className="eyebrow"><Users size={13} /> Community</p>
          <h1>{isStaff ? 'Student groups' : 'My groups'}</h1>
          <p>{isStaff ? 'Make a group for a task or a special class — an Ashara decoration team, an advanced Thuluth cohort — and talk to everyone in it at once.' : 'Groups your teachers have added you to. Messages here are seen by everyone in the group.'}</p>
        </div>
        {isStaff && <button type="button" className="btn btn-primary v2-com-btn" onClick={() => setCreating(true)}><Plus size={16} /> New group</button>}
      </header>

      {error && <ErrorBox message={error} onRetry={() => void load()} />}

      <div className="v2-com-shell">
        <aside className="v2-com-list" aria-label="Groups">
          <label className="v2-com-search">
            <Search size={15} aria-hidden="true" />
            <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Search groups" aria-label="Search groups" />
          </label>
          {!groups && !error && <div className="v2-com-loading"><PenLoader compact label="Loading groups" /></div>}
          {groups && !shown.length && (
            <div className="v2-com-empty">
              <MessageCircle size={26} />
              <strong>{filter ? 'No group matches.' : isStaff ? 'No groups yet' : 'You are not in any group yet'}</strong>
              <span>{isStaff ? 'Press “New group” to make the first one.' : 'When a teacher adds you to a group, it will appear here.'}</span>
            </div>
          )}
          <ul>
            {shown.map(g => (
              <li key={g.id}>
                <button type="button" className={`v2-com-item${g.id === activeId ? ' is-active' : ''}`} onClick={() => setActiveId(g.id)}>
                  <span className="v2-com-avatar" aria-hidden="true">{initials(g.name)}</span>
                  <span className="v2-com-item-text">
                    <span className="v2-com-item-top"><strong>{g.name}</strong><time>{timeLabel(g.lastMessageAt ?? g.createdAt)}</time></span>
                    <small>{g.purpose || 'No description'}</small>
                    <small className="v2-com-item-meta">{g.memberCount} member{g.memberCount === 1 ? '' : 's'}{isStaff && scope.isMaster ? ` · ${branchName(g.branchId) ?? ''}` : ''}</small>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <section className="v2-com-chat-pane" aria-label="Group chat">
          {active
            ? <GroupChat key={active.id} group={active} isStaff={isStaff} onBack={() => setActiveId(null)} onChanged={g => setGroups(list => g ? (list ?? []).map(x => x.id === g.id ? g : x) : list)} onArchived={() => { setActiveId(null); void load(); }} />
            : (
              <div className="v2-com-placeholder">
                <MessageCircle size={34} />
                <strong>Choose a group</strong>
                <span>Its messages and files will show here.</span>
              </div>
            )}
        </section>
      </div>

      {creating && (
        <CreateGroup
          isMaster={scope.isMaster}
          branches={scope.branches}
          onClose={() => setCreating(false)}
          onCreated={g => { setCreating(false); setGroups(list => [g, ...(list ?? [])]); setActiveId(g.id); }}
        />
      )}
    </main>
  );
}

function CreateGroup({ isMaster, branches, onClose, onCreated }: { isMaster: boolean; branches: { id: string; name: string }[]; onClose: () => void; onCreated: (g: StudentGroup) => void }) {
  const user = getSessionUser();
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [branchId, setBranchId] = useState(user?.branchId ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const g = await apiFetch<StudentGroup>('/v2/groups', { method: 'POST', body: { name: name.trim(), purpose: purpose.trim() || null, ...(isMaster ? { branchId: branchId || null } : {}) } });
      onCreated(g);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not make the group.');
      setSaving(false);
    }
  };

  return (
    <Modal onClose={saving ? undefined : onClose} className="v2-com-modal">
      <form onSubmit={submit}>
        <p className="eyebrow">New group</p>
        <h2>Make a student group</h2>
        <label className="field-label">Group name
          <input className="field" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Ashara decoration team" maxLength={191} autoFocus required />
        </label>
        <label className="field-label">What is it for? <span className="muted">(optional)</span>
          <textarea className="field textarea" value={purpose} onChange={e => setPurpose(e.target.value)} placeholder="e.g. Writing the excerpts for the hall decoration" />
        </label>
        {isMaster && (
          <label className="field-label">Branch
            <select className="field" value={branchId} onChange={e => setBranchId(e.target.value)}>
              <option value="">All branches (mixed group)</option>
              {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
        )}
        {error && <p className="v2-com-warn" role="alert">{error}</p>}
        <div className="v2-com-modal-actions">
          <button type="button" className="btn btn-outline v2-com-btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="btn btn-primary v2-com-btn" disabled={saving || !name.trim()}>{saving ? 'Making…' : 'Make group'}</button>
        </div>
      </form>
    </Modal>
  );
}

function AttachmentView({ a }: { a: Attachment }) {
  const isImage = a.contentType.startsWith('image/');
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!isImage) return;
    let cancelled = false;
    getViewUrl(a.storageKey).then(u => { if (!cancelled) setUrl(u); }).catch(() => {});
    return () => { cancelled = true; };
  }, [a.storageKey, isImage]);
  const open = async () => {
    try { window.open(await getDownloadUrl(a.storageKey, a.originalFilename), '_blank', 'noopener'); } catch { /* ignore */ }
  };
  if (isImage) {
    return (
      <button type="button" className="v2-com-img" onClick={() => void open()} aria-label={`Open ${a.originalFilename}`}>
        {url ? <img src={url} alt={a.originalFilename} loading="lazy" /> : <span><Loader2 size={18} className="v2-com-spin" /></span>}
      </button>
    );
  }
  return (
    <button type="button" className="v2-com-file" onClick={() => void open()}>
      <FileText size={18} /><span>{a.originalFilename}</span>
    </button>
  );
}

function GroupChat({ group, isStaff, onBack, onChanged, onArchived }: { group: StudentGroup; isStaff: boolean; onBack: () => void; onChanged: (g: StudentGroup | null) => void; onArchived: () => void }) {
  const me = getSessionUser();
  const [messages, setMessages] = useState<GroupMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const latest = useRef<string | null>(null);

  const scrollDown = () => requestAnimationFrame(() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; });

  const load = useCallback(async (initial: boolean) => {
    try {
      const after = !initial && latest.current ? `?after=${encodeURIComponent(latest.current)}` : '';
      const rows = await apiFetch<GroupMessage[]>(`/v2/groups/${group.id}/messages${after}`, { silent: true });
      if (rows.length) latest.current = rows[rows.length - 1].createdAt;
      setMessages(current => {
        if (initial || !current) return rows;
        const known = new Set(current.map(m => m.id));
        const fresh = rows.filter(m => !known.has(m.id));
        return fresh.length ? [...current, ...fresh] : current;
      });
      if (initial || rows.length) scrollDown();
      setError(null);
    } catch (err) {
      if (initial) setError(err instanceof Error ? err.message : 'Could not load the messages.');
    }
  }, [group.id]);

  useEffect(() => {
    void load(true);
    const t = window.setInterval(() => { if (!document.hidden) void load(false); }, 8000);
    return () => window.clearInterval(t);
  }, [load]);

  const send = async () => {
    if (sending || (!text.trim() && !files.length)) return;
    setSending(true);
    try {
      const attachments: Attachment[] = [];
      for (const file of files) {
        const up = await uploadFile('groups', file);
        attachments.push({ storageKey: up.storageKey, originalFilename: up.originalFilename, contentType: file.type || 'application/octet-stream' });
      }
      const msg = await apiFetch<GroupMessage>(`/v2/groups/${group.id}/messages`, { method: 'POST', body: { body: text.trim() || null, attachments } });
      setMessages(current => [...(current ?? []).filter(m => m.id !== msg.id), msg]);
      latest.current = msg.createdAt;
      setText('');
      setFiles([]);
      onChanged({ ...group, lastMessageAt: msg.createdAt });
      scrollDown();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send. Please try again.');
    } finally {
      setSending(false);
    }
  };

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && window.matchMedia('(min-width: 761px)').matches) {
      event.preventDefault();
      void send();
    }
  };

  let lastDay = '';
  return (
    <div className="v2-com-chat">
      <header className="v2-com-chat-head">
        <button type="button" className="v2-com-back" onClick={onBack} aria-label="Back to groups"><ArrowLeft size={20} /></button>
        <span className="v2-com-avatar" aria-hidden="true">{initials(group.name)}</span>
        <div className="v2-com-chat-title">
          <strong>{group.name}</strong>
          <small>{group.memberCount} member{group.memberCount === 1 ? '' : 's'}{group.purpose ? ` · ${group.purpose}` : ''}</small>
        </div>
        <button type="button" className="v2-com-head-btn" onClick={() => setShowMembers(true)} aria-label={isStaff ? 'Members and settings' : 'Members'}>
          <Users size={18} /><span>{isStaff ? 'Members' : 'People'}</span>
        </button>
      </header>

      <div className="v2-com-messages" ref={scroller}>
        {!messages && !error && <div className="v2-com-loading"><PenLoader compact label="Loading messages" /></div>}
        {error && !messages && <ErrorBox message={error} onRetry={() => void load(true)} />}
        {messages && !messages.length && (
          <div className="v2-com-empty v2-com-empty-chat">
            <MessageCircle size={26} />
            <strong>No messages yet</strong>
            <span>{isStaff ? 'Say salaam and explain what the group is for.' : 'Your teacher will post here soon.'}</span>
          </div>
        )}
        {messages?.map(m => {
          const mine = m.senderId === me?.id;
          const day = dayLabel(m.createdAt);
          const showDay = day !== lastDay;
          lastDay = day;
          return (
            <div key={m.id} className="v2-com-msg-wrap">
              {showDay && <div className="v2-com-day"><span>{day}</span></div>}
              <div className={`v2-com-msg${mine ? ' is-mine' : ''}${m.senderRole !== 'student' ? ' is-staff' : ''}`}>
                {!mine && <span className="v2-com-sender">{m.senderName}{m.senderRole !== 'student' && <em>{m.senderRole === 'admin' ? 'Admin' : 'Teacher'}</em>}</span>}
                {m.attachments.length > 0 && <div className="v2-com-atts">{m.attachments.map(a => <AttachmentView key={a.storageKey} a={a} />)}</div>}
                {m.body && <p>{m.body}</p>}
                <time>{new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
              </div>
            </div>
          );
        })}
      </div>

      {error && messages && <p className="v2-com-warn v2-com-send-error" role="alert">{error}</p>}
      {files.length > 0 && (
        <div className="v2-com-pending">
          {files.map((f, i) => (
            <span key={`${f.name}-${i}`}><Paperclip size={12} />{f.name}<button type="button" onClick={() => setFiles(list => list.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`}><X size={12} /></button></span>
          ))}
        </div>
      )}
      <form className="v2-com-composer" onSubmit={e => { e.preventDefault(); void send(); }}>
        <input ref={fileInput} type="file" multiple hidden accept="image/*,application/pdf" onChange={e => { const list = Array.from(e.target.files ?? []); setFiles(cur => [...cur, ...list].slice(0, 10)); e.target.value = ''; }} />
        <button type="button" className="v2-com-icon" onClick={() => fileInput.current?.click()} aria-label="Attach photo or PDF"><Paperclip size={19} /></button>
        <textarea value={text} onChange={e => setText(e.target.value)} onKeyDown={onKey} rows={1} placeholder="Write a message" aria-label="Message" maxLength={4000} />
        <button type="submit" className="v2-com-send" disabled={sending || (!text.trim() && !files.length)} aria-label="Send">
          {sending ? <Loader2 size={19} className="v2-com-spin" /> : <Send size={19} />}
        </button>
      </form>

      {showMembers && <MembersPanel group={group} isStaff={isStaff} onClose={() => setShowMembers(false)} onCount={count => onChanged({ ...group, memberCount: count })} onArchived={onArchived} />}
    </div>
  );
}

function MembersPanel({ group, isStaff, onClose, onCount, onArchived }: { group: StudentGroup; isStaff: boolean; onClose: () => void; onCount: (n: number) => void; onArchived: () => void }) {
  const [members, setMembers] = useState<GroupMember[] | null>(null);
  const [q, setQ] = useState('');
  const [candidates, setCandidates] = useState<GroupCandidate[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadMembers = useCallback(async () => {
    try {
      const rows = await apiFetch<GroupMember[]>(`/v2/groups/${group.id}/members`, { silent: true });
      setMembers(rows);
      onCount(rows.length);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the members.');
    }
  }, [group.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void loadMembers(); }, [loadMembers]);

  useEffect(() => {
    if (!isStaff) return;
    let cancelled = false;
    const t = window.setTimeout(() => {
      apiFetch<GroupCandidate[]>(`/v2/groups/${group.id}/candidates?q=${encodeURIComponent(q.trim())}`, { silent: true })
        .then(rows => { if (!cancelled) setCandidates(rows); })
        .catch(() => {});
    }, 250);
    return () => { cancelled = true; window.clearTimeout(t); };
  }, [q, group.id, isStaff, members?.length]);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/v2/groups/${group.id}/members`, { method: 'POST', body: { userIds: [...picked] } });
      setPicked(new Set());
      setQ('');
      await loadMembers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add them.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (m: GroupMember) => {
    if (!window.confirm(`Remove ${m.name} from “${group.name}”?`)) return;
    try {
      await apiFetch(`/v2/groups/${group.id}/members/${m.userId}`, { method: 'DELETE' });
      await loadMembers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove.');
    }
  };

  const archive = async () => {
    if (!window.confirm(`Archive “${group.name}”? Messages are kept but nobody can write any more.`)) return;
    try {
      await apiFetch(`/v2/groups/${group.id}`, { method: 'PATCH', body: { archived: true } });
      onClose();
      onArchived();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not archive.');
    }
  };

  return (
    <Modal onClose={onClose} className="v2-com-modal v2-com-members">
      <p className="eyebrow">{group.name}</p>
      <h2>{isStaff ? 'Members' : 'People in this group'}</h2>

      {isStaff && (
        <div className="v2-com-add">
          <label className="v2-com-search">
            <Search size={15} aria-hidden="true" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Find a student by name or TR number" aria-label="Find a student" />
          </label>
          <ul className="v2-com-people v2-com-candidates">
            {candidates.map(c => {
              const on = picked.has(c.userId);
              return (
                <li key={c.userId}>
                  <label className={`v2-com-person${on ? ' is-picked' : ''}`}>
                    <input type="checkbox" checked={on} onChange={() => setPicked(cur => { const next = new Set(cur); if (next.has(c.userId)) next.delete(c.userId); else next.add(c.userId); return next; })} />
                    <span className="v2-com-avatar v2-com-avatar-sm">{initials(c.name)}</span>
                    <span><strong>{c.name}</strong><small>{[c.trNumber && `TR ${c.trNumber}`, c.className, c.branchName].filter(Boolean).join(' · ')}</small></span>
                  </label>
                </li>
              );
            })}
            {!candidates.length && <li className="muted v2-com-none">{q ? 'No student found.' : 'Type a name or TR number.'}</li>}
          </ul>
          <button type="button" className="btn btn-primary v2-com-btn v2-com-add-btn" disabled={!picked.size || busy} onClick={() => void add()}>
            <UserPlus size={16} /> {busy ? 'Adding…' : `Add ${picked.size || ''} to the group`}
          </button>
        </div>
      )}

      {error && <p className="v2-com-warn" role="alert">{error}</p>}
      <h3 className="v2-com-sub">{members ? `${members.length} in the group` : 'Loading…'}</h3>
      <ul className="v2-com-people">
        {members?.map(m => (
          <li key={m.userId} className="v2-com-person">
            <span className="v2-com-avatar v2-com-avatar-sm">{initials(m.name)}</span>
            <span><strong>{m.name}</strong><small>{[m.trNumber && `TR ${m.trNumber}`, m.className, m.branchName].filter(Boolean).join(' · ')}</small></span>
            {isStaff && <button type="button" className="v2-com-remove" onClick={() => void remove(m)} aria-label={`Remove ${m.name}`}><UserMinus size={16} /></button>}
          </li>
        ))}
      </ul>

      {isStaff && (
        <button type="button" className="v2-com-archive" onClick={() => void archive()}><Archive size={15} /> Archive this group</button>
      )}
    </Modal>
  );
}
