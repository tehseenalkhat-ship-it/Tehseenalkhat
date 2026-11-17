// owner: insights — "who needs a push, who is doing well" for teachers, coordinators and admins.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, BarChart3, BellRing, Download, Heart, Mail, Moon, Search, Send, Sparkles, Sprout, TrendingUp, Users, X,
} from 'lucide-react';
import { apiFetch, getSessionUser } from '@/api';
import { Modal, PenLoader } from '@/components/ui';
import type { EffectivePolicies, InsightsSummary, NudgeRequest, StudentInsight, StudentSegment } from '../contracts';
import { BranchSelect, ErrorBox, downloadCsv, initials, relativeDays, useStaffScope } from './common';
import { ClassView } from './ClassView';
import { InsightCharts } from './InsightCharts';
import { StudentAnalysisDrawer } from './StudentAnalysisDrawer';
import './insights.css';

type Props = Record<string, never>;

type SegmentMeta = { key: StudentSegment; label: string; hint: string; icon: typeof Heart; tone: string };

export const SEGMENT_META: SegmentMeta[] = [
  { key: 'needs_push', label: 'Needs a push', hint: 'No practice for a few weeks', icon: BellRing, tone: 'danger' },
  { key: 'needs_encouragement', label: 'Needs encouragement', hint: 'Revisions or low marks', icon: Heart, tone: 'warning' },
  { key: 'doing_well', label: 'Doing well', hint: 'Active and passing', icon: TrendingUp, tone: 'positive' },
  { key: 'new', label: 'New', hint: 'Joined recently, no work yet', icon: Sprout, tone: 'gold' },
  { key: 'dormant', label: 'Dormant', hint: 'Away for months — gentle message sent', icon: Moon, tone: 'muted' },
];
const metaFor = (segment: StudentSegment) => SEGMENT_META.find(m => m.key === segment)!;

const DEFAULT_TEMPLATE = 'Salaam {name}, we miss your writing! It has been {days} days since your last practice in {course}. Even ten minutes today will keep your pen moving — we are here to help.';
const PAGE = 100;

type NudgeResponse = { sent: number; emailed: number; emailSkipped: number; skipped: number; message: string };

function previewFor(template: string, s: StudentInsight | undefined): string {
  if (!s) return template;
  const days = s.lastActiveAt ? Math.max(0, Math.floor((Date.now() - Date.parse(s.lastActiveAt)) / 86_400_000)) : null;
  return template
    .replace(/\{days\}(\s+)days\b/g, (_m, space: string) => (days === 1 ? `1${space}day` : `${days ?? 'many'}${space}days`))
    .replace(/\{name\}/g, s.name.split(/\s+/)[0] || s.name)
    .replace(/\{course\}/g, s.courseTitle || s.courseCode || 'your course')
    .replace(/\{days\}/g, days == null ? 'many' : String(days));
}

export function V2InsightsPage(_props: Props) {
  const user = getSessionUser();
  const scope = useStaffScope();
  const [branchId, setBranchId] = useState('');
  const [segment, setSegment] = useState<StudentSegment | ''>('');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [data, setData] = useState<InsightsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [composer, setComposer] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const request = useRef(0);
  const [view, setView] = useState<'students' | 'class'>('students');
  const [drawer, setDrawer] = useState<{ id: string; name: string } | null>(null);
  // v3 (5.11): tapping a group lists its students below and scrolls there
  const listRef = useRef<HTMLElement>(null);
  const [pendingScroll, setPendingScroll] = useState(false);
  const pickSegment = (next: StudentSegment | '') => { setSegment(next); setPendingScroll(true); };
  useEffect(() => {
    if (pendingScroll && !loading) {
      setPendingScroll(false);
      window.setTimeout(() => listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
    }
  }, [pendingScroll, loading]);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(query.trim()), 280);
    return () => window.clearTimeout(t);
  }, [query]);

  const params = useCallback((offset: number, limit: number) => {
    const p = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (branchId) p.set('branchId', branchId);
    if (segment) p.set('segment', segment);
    if (debounced) p.set('q', debounced);
    return p.toString();
  }, [branchId, segment, debounced]);

  const load = useCallback(async () => {
    const id = ++request.current;
    setLoading(true);
    setError(null);
    try {
      const result = await apiFetch<InsightsSummary>(`/v2/insights/students?${params(0, PAGE)}`);
      if (id === request.current) setData(result);
    } catch (err) {
      if (id === request.current) setError(err instanceof Error ? err.message : 'Could not load the students.');
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [params]);

  useEffect(() => { if (scope.ready) void load(); }, [load, scope.ready]);
  useEffect(() => { setSelected(new Set()); }, [branchId, segment]);

  const loadMore = async () => {
    if (!data) return;
    setLoadingMore(true);
    try {
      const more = await apiFetch<InsightsSummary>(`/v2/insights/students?${params(data.students.length, PAGE)}`);
      setData(current => current ? { ...current, students: [...current.students, ...more.students] } : more);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load more students.');
    } finally {
      setLoadingMore(false);
    }
  };

  const students = data?.students ?? [];
  const totalAll = data ? Object.values(data.counts).reduce((a, b) => a + b, 0) : 0;
  const allVisibleSelected = students.length > 0 && students.every(s => selected.has(s.studentId));
  const toggle = (id: string) => setSelected(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleAll = () => setSelected(allVisibleSelected ? new Set() : new Set(students.map(s => s.studentId)));
  const selectedStudents = useMemo(() => students.filter(s => selected.has(s.studentId)), [students, selected]);
  const branchName = scope.branches.find(b => b.id === (branchId || user?.branchId))?.name;

  const exportCsv = async () => {
    setExporting(true);
    try {
      const all = await apiFetch<InsightsSummary>(`/v2/insights/students?${params(0, 5000)}`);
      downloadCsv(`student-insights-${new Date().toISOString().slice(0, 10)}.csv`, [
        ['Name', 'TR number', 'Class', 'Branch', 'Group', 'Reason', 'Course', 'Level', 'Levels passed', 'Average mark', 'Sent back', 'Waiting for reply', 'Last active', 'Last gentle message'],
        ...all.students.map(s => [s.name, s.trNumber, s.className, s.branchName, metaFor(s.segment).label, s.reason, s.courseTitle || s.courseCode, s.currentLevel, s.levelsPassed, s.avgMark, s.revisions, s.pendingReviews, s.lastActiveAt?.slice(0, 10), s.lastNudgedAt?.slice(0, 10)]),
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not export the list.');
    } finally {
      setExporting(false);
    }
  };

  const onSent = (result: NudgeResponse, ids: string[]) => {
    setComposer(false);
    setSelected(new Set());
    setNotice(result.message);
    const now = new Date().toISOString();
    setData(current => current ? { ...current, students: current.students.map(s => ids.includes(s.studentId) ? { ...s, lastNudgedAt: now } : s) } : current);
  };

  return (
    <main className="page portal-page v2-ins-page">
      <header className="branch-analytics-hero v2-ins-hero">
        <div>
          <p className="eyebrow"><Activity size={13} /> Smart progress{branchName && !scope.isMaster ? ` · ${branchName}` : ''}</p>
          <h1>Who needs us today</h1>
          <p>Every student is placed in one group with a reason in plain words. Tap a student for their smart analysis, or open the class view to see the whole class at once.</p>
        </div>
        <div className="v2-ins-hero-actions">
          {scope.isMaster && <BranchSelect branches={scope.branches} value={branchId} onChange={setBranchId} />}
          <button type="button" className="btn btn-outline v2-ins-btn" onClick={() => void exportCsv()} disabled={exporting || !data}>
            <Download size={15} /> {exporting ? 'Preparing…' : 'Export CSV'}
          </button>
        </div>
      </header>

      <div className="v2-an-tabs" role="tablist" aria-label="Insights views">
        <button type="button" role="tab" aria-selected={view === 'students'} className={view === 'students' ? 'is-active' : ''} onClick={() => setView('students')}>
          <Users size={15} /> Students
        </button>
        <button type="button" role="tab" aria-selected={view === 'class'} className={view === 'class' ? 'is-active' : ''} onClick={() => setView('class')}>
          <BarChart3 size={15} /> Class view
        </button>
      </div>

      {view === 'class' && scope.ready && (
        <ClassView branchId={branchId} onOpenStudent={(id, name) => setDrawer({ id, name })} />
      )}

      {view === 'students' && <>
      <section className="v2-seg-grid" aria-label="Student groups">
        <button type="button" className={`v2-seg-card v2-tone-ink${segment === '' ? ' is-active' : ''}`} onClick={() => pickSegment('')} aria-pressed={segment === ''}>
          <span className="v2-seg-icon"><Users size={18} /></span>
          <strong>{data ? totalAll : '—'}</strong>
          <span className="v2-seg-label">All students</span>
          <small>Everyone in {scope.isMaster && !branchId ? 'all branches' : 'the branch'}</small>
        </button>
        {SEGMENT_META.map(meta => {
          const Icon = meta.icon;
          const active = segment === meta.key;
          return (
            <button type="button" key={meta.key} className={`v2-seg-card v2-tone-${meta.tone}${active ? ' is-active' : ''}`} onClick={() => pickSegment(active ? '' : meta.key)} aria-pressed={active}>
              <span className="v2-seg-icon"><Icon size={18} /></span>
              <strong>{data ? data.counts[meta.key] : '—'}</strong>
              <span className="v2-seg-label">{meta.label}</span>
              <small>{meta.hint}</small>
            </button>
          );
        })}
      </section>

      {notice && (
        <div className="v2-ins-notice" role="status">
          <Sparkles size={15} /><span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss"><X size={15} /></button>
        </div>
      )}
      {error && <ErrorBox message={error} onRetry={() => void load()} />}

      {data && <InsightCharts counts={data.counts} branchId={branchId} active={segment} onPick={pickSegment} onOpenClass={() => setView('class')} />}

      <section className="v2-ins-list-card" ref={listRef}>
        <div className="v2-ins-toolbar">
          <label className="v2-ins-search">
            <Search size={16} aria-hidden="true" />
            <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search name, TR number, class or course" aria-label="Search students" />
            {query && <button type="button" onClick={() => setQuery('')} aria-label="Clear search"><X size={14} /></button>}
          </label>
          <div className="v2-ins-toolbar-right">
            <label className="v2-check-all">
              <input type="checkbox" checked={allVisibleSelected} onChange={toggleAll} disabled={!students.length} />
              <span>Select all shown</span>
            </label>
            <button type="button" className="btn btn-primary v2-ins-btn v2-ins-send-desktop" disabled={!selected.size} onClick={() => setComposer(true)}>
              <Send size={15} /> Send a gentle message{selected.size ? ` (${selected.size})` : ''}
            </button>
          </div>
        </div>

        <p className="v2-ins-count muted">
          {loading ? 'Looking at every student…' : data ? `${data.total} student${data.total === 1 ? '' : 's'}${segment ? ` · ${metaFor(segment).label}` : ''}${debounced ? ` matching “${debounced}”` : ''}` : ''}
        </p>

        {loading && !data ? <div className="v2-ins-loader"><PenLoader compact label="Loading students" /></div> : null}

        {data && !students.length && !loading && (
          <div className="v2-ins-empty">
            <Sparkles size={22} />
            <strong>{debounced ? 'No student matches this search.' : segment ? `Nobody is in “${metaFor(segment).label}” right now.` : 'No students yet.'}</strong>
            <span className="muted">{segment === 'needs_push' || segment === 'dormant' ? 'That is good news — everyone is practicing.' : 'Try another group or clear the search.'}</span>
          </div>
        )}

        <ul className={`v2-ins-list${loading ? ' is-refreshing' : ''}`}>
          {students.map(s => {
            const meta = metaFor(s.segment);
            const checked = selected.has(s.studentId);
            return (
              <li
                key={s.studentId}
                className={`v2-ins-row v2-an-clickable v2-tone-${meta.tone}${checked ? ' is-selected' : ''}`}
                onClick={event => {
                  if ((event.target as HTMLElement).closest('.v2-ins-check, a, button, input')) return;
                  setDrawer({ id: s.studentId, name: s.name });
                }}
              >
                <label className="v2-ins-check" aria-label={`Select ${s.name}`}>
                  <input type="checkbox" checked={checked} onChange={() => toggle(s.studentId)} />
                </label>
                <span className="v2-ins-avatar" aria-hidden="true">{initials(s.name)}</span>
                <div className="v2-ins-main">
                  <div className="v2-ins-name">
                    <button type="button" className="v2-an-name-btn" onClick={() => setDrawer({ id: s.studentId, name: s.name })} title="Open smart analysis">{s.name}</button>
                    <span className={`v2-seg-pill v2-tone-${meta.tone}`}>{meta.label}</span>
                  </div>
                  <small className="v2-ins-sub">
                    {[s.trNumber && `TR ${s.trNumber}`, s.className, scope.isMaster && !branchId ? s.branchName : null].filter(Boolean).join(' · ') || 'No TR number'}
                  </small>
                  <p className="v2-ins-reason">{s.reason}</p>
                </div>
                <dl className="v2-ins-facts">
                  <div><dt>Course</dt><dd>{s.courseTitle || s.courseCode || '—'}{s.currentLevel ? ` · ${s.currentLevel}` : ''}</dd></div>
                  <div><dt>Avg mark</dt><dd>{s.avgMark == null ? '—' : `${s.avgMark}/10`}</dd></div>
                  <div><dt>Last active</dt><dd>{relativeDays(s.lastActiveAt)}</dd></div>
                  <div><dt>Messaged</dt><dd>{s.lastNudgedAt ? relativeDays(s.lastNudgedAt) : '—'}</dd></div>
                </dl>
              </li>
            );
          })}
        </ul>

        {data && students.length < data.total && (
          <div className="v2-ins-more">
            <button type="button" className="btn btn-outline v2-ins-btn" onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore ? 'Loading…' : `Show more (${data.total - students.length} left)`}
            </button>
          </div>
        )}
      </section>

      </>}

      {drawer && (
        <StudentAnalysisDrawer
          studentId={drawer.id}
          studentName={drawer.name}
          onClose={() => setDrawer(null)}
          onSent={id => {
            const now = new Date().toISOString();
            setData(current => current ? { ...current, students: current.students.map(st => st.studentId === id ? { ...st, lastNudgedAt: now } : st) } : current);
          }}
        />
      )}

      {view === 'students' && selected.size > 0 && !composer && (
        <div className="v2-ins-sendbar" role="region" aria-label="Selected students">
          <span><strong>{selected.size}</strong> selected</span>
          <button type="button" className="v2-ins-sendbar-clear" onClick={() => setSelected(new Set())}>Clear</button>
          <button type="button" className="btn btn-primary v2-ins-btn" onClick={() => setComposer(true)}><Send size={15} /> Gentle message</button>
        </div>
      )}

      {composer && (
        <NudgeComposer
          students={selectedStudents}
          branchId={branchId || user?.branchId || ''}
          onClose={() => setComposer(false)}
          onSent={onSent}
        />
      )}
    </main>
  );
}

function NudgeComposer({ students, branchId, onClose, onSent }: { students: StudentInsight[]; branchId: string; onClose: () => void; onSent: (result: NudgeResponse, ids: string[]) => void }) {
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<EffectivePolicies>(`/v2/policies/effective${branchId ? `?branchId=${encodeURIComponent(branchId)}` : ''}`, { silent: true })
      .then(p => {
        const template = typeof p['nudge.message_template'] === 'string' && (p['nudge.message_template'] as string).trim() ? p['nudge.message_template'] as string : DEFAULT_TEMPLATE;
        if (!cancelled) setMessage(current => current || template);
      })
      .catch(() => { if (!cancelled) setMessage(current => current || DEFAULT_TEMPLATE); });
    return () => { cancelled = true; };
  }, [branchId]);

  const send = async () => {
    setSending(true);
    setError(null);
    try {
      const ids = students.map(s => s.studentId);
      const body: NudgeRequest = { studentIds: ids, message: message.trim(), sendEmail: email };
      const result = await apiFetch<NudgeResponse>('/v2/insights/nudge', { method: 'POST', body });
      onSent(result, ids);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the message.');
      setSending(false);
    }
  };

  const recentlyNudged = students.filter(s => s.lastNudgedAt && Date.now() - Date.parse(s.lastNudgedAt) < 7 * 86_400_000).length;

  return (
    <Modal onClose={sending ? undefined : onClose} className="v2-ins-modal">
      <p className="eyebrow">Gentle message</p>
      <h2>Send to {students.length} student{students.length === 1 ? '' : 's'}</h2>
      <div className="v2-ins-recipients">
        {students.slice(0, 6).map(s => <span key={s.studentId}>{s.name}</span>)}
        {students.length > 6 && <span>+{students.length - 6} more</span>}
      </div>
      <label className="field-label">
        Your message
        <textarea className="field textarea v2-ins-textarea" value={message} onChange={event => setMessage(event.target.value)} maxLength={2000} placeholder="Loading your branch’s message…" />
      </label>
      <p className="v2-ins-help muted"><b>{'{name}'}</b>, <b>{'{course}'}</b> and <b>{'{days}'}</b> are filled in for each student.</p>
      {message && (
        <div className="v2-ins-preview">
          <span>What {students[0]?.name.split(/\s+/)[0] ?? 'they'} will read</span>
          <p>{previewFor(message, students[0])}</p>
        </div>
      )}
      <label className="v2-ins-email">
        <input type="checkbox" checked={email} onChange={event => setEmail(event.target.checked)} />
        <Mail size={15} />
        <span>Also send by email <small className="muted">(up to 80 emails a day)</small></span>
      </label>
      {recentlyNudged > 0 && <p className="v2-ins-warn">{recentlyNudged} of them already had a message this week.</p>}
      {error && <p className="v2-ins-warn" role="alert">{error}</p>}
      <div className="v2-ins-modal-actions">
        <button type="button" className="btn btn-outline v2-ins-btn" onClick={onClose} disabled={sending}>Cancel</button>
        <button type="button" className="btn btn-primary v2-ins-btn" onClick={() => void send()} disabled={sending || !message.trim()}>
          <Send size={15} /> {sending ? 'Sending…' : 'Send message'}
        </button>
      </div>
    </Modal>
  );
}
