import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ArrowRight, Award, BarChart3, BookOpen, CalendarDays, Check, ChevronRight, ClipboardList, FileSpreadsheet, Gauge, Images,
  Inbox, Library, ListChecks, Megaphone, MessagesSquare, Plus, RefreshCw, ScanLine, Settings2, ShieldCheck, Sparkles, Trophy, UserCog, Users, UsersRound,
  type LucideIcon,
} from 'lucide-react';
import { apiFetch, ApiError, getSessionUser } from '@/api';
import { openV2 } from '../nav';
import type { AdminToday, AdminTodayAlert, AdminTodayBranch, AdminTodaySeverity } from './adminHomeTypes';
import { ErrorBox, Loading, loadBranches, plural, type Branch } from './shared';
import { BranchCompare, HomeNames, type HomeCardKey } from './AdminHomeLists';
import { BranchChangesPanel } from './BranchChangesPanel';
import './admin-home.css';

// owner: admin-home — the calm "Today" page for admins (route v2-admin-home).

const BRANCH_KEY = 'khat.v2.home.branch';

function greeting(d = new Date()): string {
  const h = d.getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

function monthWord(month: string): string {
  const [y, m] = month.split('-').map(Number);
  if (!y || !m) return 'this month';
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' });
}

function waitLabel(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours)) return '—';
  if (hours < 1) return 'under 1 h';
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${Math.round(hours / 24)} days`;
}

const pctLabel = (v: number | null) => (v === null ? '—' : `${Math.round(v)}%`);

const WHEN: Record<AdminTodaySeverity, string> = { urgent: 'Today', soon: 'This week', info: 'When you can' };

/* ------------------------------------------------------------------ tools */
type Tool = { page: string; label: string; hint: string; icon: LucideIcon; masterOnly?: boolean };
type ToolGroup = { title: string; tools: Tool[] };

export const ADMIN_TOOL_GROUPS: ToolGroup[] = [
  { title: 'Courses', tools: [
    { page: 'v2-builder', label: 'Course builder', hint: 'Levels, steps and files', icon: BookOpen },
    { page: 'v2-logic', label: 'Logic sets', hint: 'Step and course types', icon: Settings2, masterOnly: true },
    { page: 'admin-courses', label: 'Old courses', hint: 'Courses made before v2', icon: BookOpen, masterOnly: true },
  ] },
  { title: 'Reviewing', tools: [
    { page: 'v2-inbox', label: 'Review inbox', hint: 'Mark and reply to work', icon: Inbox },
    { page: 'v2-scan-return', label: 'Return scanned work', hint: 'Send corrected paper back', icon: ScanLine },
    { page: 'queue', label: 'Old review queue', hint: 'Entries from before v2', icon: ClipboardList },
    { page: 'admin-logs', label: 'Entry logs', hint: 'Who reviewed what, when', icon: ListChecks, masterOnly: true },
  ] },
  { title: 'Students', tools: [
    { page: 'v2-insights', label: 'Student insights', hint: 'Who is doing well, who is stuck', icon: Sparkles },
    { page: 'v2-merit', label: 'Merit points', hint: 'Points to give this month', icon: Award },
    { page: 'v2-dept-chat', label: 'Funun al-Quran Department chat', hint: 'Messages from students', icon: MessagesSquare },
    { page: 'v2-announcements', label: 'Announcements & surveys', hint: 'Banner, email, student list', icon: Megaphone },
    { page: 'v2-community', label: 'Community', hint: 'Student groups and chat', icon: UsersRound },
    { page: 'admin-tr-numbers', label: 'TR number uploads', hint: 'Who may sign up', icon: FileSpreadsheet, masterOnly: true },
    { page: 'admin-certificates', label: 'Certificates & badges', hint: 'Designs and awards', icon: Award, masterOnly: true },
  ] },
  { title: 'Branches & people', tools: [
    { page: 'v2-policies', label: 'Branch policies & review network', hint: 'Rules, limits and helpers', icon: ShieldCheck },
    { page: 'v2-people', label: 'People & roles', hint: 'Teacher, branch admin, master admin', icon: UserCog },
    { page: 'admin-users', label: 'Teacher & load', hint: 'Teachers, admins and khat types', icon: Users, masterOnly: true },
    { page: 'v2-team', label: 'Team report', hint: 'How quickly work is answered', icon: Gauge },
  ] },
  { title: 'Events & showcase', tools: [
    { page: 'v2-competitions', label: 'Competitions & calls', hint: 'Open calls and results', icon: Trophy },
    { page: 'admin-showcase', label: 'Showcase moderation', hint: 'Approve shared work', icon: Images },
    { page: 'admin-events', label: 'Live events', hint: 'Classes and broadcasts', icon: CalendarDays, masterOnly: true },
    { page: 'admin-resources', label: 'Resources', hint: 'Books and reference files', icon: Library, masterOnly: true },
  ] },
  { title: 'Records', tools: [
    { page: 'admin-stats', label: 'Statistics', hint: 'Numbers over time', icon: BarChart3, masterOnly: true },
    { page: 'admin-governance', label: 'Data governance', hint: 'Students, teachers and records', icon: ShieldCheck, masterOnly: true },
  ] },
];

/** The groups (and tools) an admin may use: branch admins only see what applies to their branch. */
export function toolGroupsFor(isMaster: boolean): ToolGroup[] {
  return ADMIN_TOOL_GROUPS
    .map(g => ({ ...g, tools: g.tools.filter(t => isMaster || !t.masterOnly) }))
    .filter(g => g.tools.length > 0);
}

/* ------------------------------------------------------------------ page */
export function V2AdminHomePage() {
  const user = getSessionUser();
  const firstName = user?.name?.trim().split(/\s+/)[0] ?? '';
  const [branchId, setBranchId] = useState<string>(() => sessionStorage.getItem(BRANCH_KEY) ?? '');
  const [branches, setBranches] = useState<Branch[]>([]);
  const [data, setData] = useState<AdminToday | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [picked, setPicked] = useState<HomeCardKey | null>(null);

  const load = async (id = branchId) => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<AdminToday>(`/v2/admin/today${id ? `?branchId=${encodeURIComponent(id)}` : ''}`);
      setData(res);
    } catch (err) {
      if (id && err instanceof ApiError && (err.status === 403 || err.status === 404)) {
        // A remembered branch that is no longer allowed → back to the default view.
        sessionStorage.removeItem(BRANCH_KEY);
        setBranchId('');
        return;
      }
      setError(err instanceof Error && err.message ? err.message : 'Could not load today’s summary.');
    } finally {
      setBusy(false);
    }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(branchId); }, [branchId]);
  useEffect(() => { void loadBranches().then(setBranches); }, []);

  const chooseBranch = (id: string) => {
    if (id) sessionStorage.setItem(BRANCH_KEY, id); else sessionStorage.removeItem(BRANCH_KEY);
    setBranchId(id);
    setPicked(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const isMaster = data?.scope.isMaster ?? false;
  const groups = useMemo(() => toolGroupsFor(isMaster), [isMaster]);
  const scopeName = data?.scope.branchName ?? (isMaster ? 'All branches' : '');

  if (!data && busy) {
    return <div className="page portal-page v2-admin v2-home"><Loading label="Getting today ready…" /></div>;
  }

  const urgent = data?.alerts.filter(a => a.severity === 'urgent').length ?? 0;
  const visibleAlerts = data?.alerts.filter(a => !/merit officer/i.test(a.text)) ?? [];
  const calmLine = !data ? '' : urgent > 0
    ? `${plural(urgent, 'thing needs', 'things need')} you today.`
    : visibleAlerts.some(a => a.severity === 'soon') ? 'Nothing is urgent. A few things for this week.'
      : visibleAlerts.length ? 'All calm. A few small things when you can.' : 'All calm — nothing needs you right now.';

  return (
    <div className="page portal-page v2-admin v2-home">
      <header className="v2-home-head">
        <div className="v2-home-hello">
          <p className="eyebrow">{greeting()}{firstName ? `, ${firstName}` : ''}</p>
          <h1>Today</h1>
          {data && <p className="v2-home-calm"><span className={`v2-home-pulse${urgent ? ' is-urgent' : ''}`} aria-hidden="true" />{calmLine}</p>}
        </div>
        <div className="v2-home-tools-bar">
          {isMaster ? (
            <label className="v2-home-switch">
              <span className="sr-only">Branch</span>
              <select className="field" value={branchId} onChange={e => chooseBranch(e.target.value)} aria-label="Choose a branch">
                <option value="">All branches</option>
                {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </label>
          ) : scopeName ? <span className="v2-home-scope">{scopeName}</span> : null}
          {isMaster && (
            <button type="button" className="btn btn-outline v3-create-btn" onClick={() => openV2('v2-builder', { builderCourseId: null, courseId: null, builderAction: 'new' })}>
              <Plus size={15} /> Create course
            </button>
          )}
          <button type="button" className="v2-icon-btn v2-home-refresh" onClick={() => void load()} disabled={busy} aria-label="Refresh" title="Refresh">
            <RefreshCw size={17} className={busy ? 'v2-spin' : ''} />
          </button>
        </div>
      </header>

      {error && <ErrorBox message={error} onRetry={() => void load()} />}

      {data && (
        <>
          <NumberCards data={data} picked={picked} onPick={key => setPicked(p => (p === key ? null : key))} />
          {picked && <HomeNames card={picked} branchId={branchId} onClose={() => setPicked(null)} />}
          {isMaster && <div style={{ marginTop: 16 }}><BranchChangesPanel compact /></div>}
          {/* v3 (note 6.3): branch admins give merit points, so a missing “merit officer” is no longer a to-do. */}
          <DoNext alerts={data.alerts.filter(al => !/merit officer/i.test(al.text))} />
          {data.branches.length > 1 && <BranchSnapshot rows={data.branches} onPick={isMaster ? chooseBranch : undefined} />}
          {isMaster && data.branches.length > 1 && <BranchCompare rows={data.branches} onPick={chooseBranch} />}
          {data.branches.length === 1 && <SingleBranch row={data.branches[0]} />}
        </>
      )}

      <section className="v2-home-section" aria-labelledby="v2-home-tools">
        <div className="v2-home-section-head">
          <h2 id="v2-home-tools">All tools</h2>
          <p className="muted">Everything in one place, so the menu can stay short.</p>
        </div>
        <div className="v2-home-groups">
          {groups.map(g => (
            <div className="v2-home-group" key={g.title}>
              <h3>{g.title}</h3>
              <div className="v2-home-tiles">
                {g.tools.map(t => (
                  <button type="button" key={t.page} className="v2-home-tile" onClick={() => openV2(t.page)}>
                    <span className="v2-home-tile-icon" aria-hidden="true"><t.icon size={18} /></span>
                    <span className="v2-home-tile-copy"><strong>{t.label}</strong><small>{t.hint}</small></span>
                    <ChevronRight size={16} className="v2-home-tile-go" aria-hidden="true" />
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
      {data && <p className="v2-home-updated muted">Updated {new Date(data.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ number cards */
type CardDef = { key: HomeCardKey; icon: LucideIcon; label: string; value: ReactNode; note: ReactNode; tone?: 'urgent' | 'ok'; action: string; go: () => void };

function NumberCards({ data, picked, onPick }: { data: AdminToday; picked: HomeCardKey | null; onPick: (key: HomeCardKey) => void }) {
  const c = data.counts;
  const month = monthWord(data.month);
  const teachers = data.branches.reduce((n, b) => n + b.teachers, 0);
  const full = data.branches.reduce((n, b) => n + b.teachersFull, 0);
  const cards: CardDef[] = [
    {
      key: 'inbox', icon: Inbox, label: 'Waiting for review', value: c.waitingReview,
      note: c.overdue72h > 0 ? `${c.overdue72h} waited over 3 days` : c.waitingReview > 0 ? `Oldest: ${waitLabel(c.oldestWaitHours)}` : 'All answered',
      tone: c.overdue72h > 0 ? 'urgent' : c.waitingReview === 0 ? 'ok' : undefined,
      action: 'Open inbox', go: () => openV2('v2-inbox'),
    },
    {
      key: 'merit', icon: Award, label: 'Merit points to give', value: c.meritToGiveThisMonth,
      note: c.meritToGiveThisMonth > 0 ? `${c.meritToGiveThisMonth === 1 ? 'student' : 'students'} · ${month}` : `All given · ${month}`,
      tone: c.meritToGiveThisMonth === 0 ? 'ok' : undefined,
      action: 'Give points', go: () => openV2('v2-merit'),
    },
    {
      key: 'push', icon: Sparkles, label: 'Students who need a push', value: c.studentsNeedPush,
      note: c.dormant > 0 ? `+ ${c.dormant} quiet for a long time` : c.studentsNeedPush === 0 ? 'Everyone is moving' : 'Stuck or many tries',
      tone: c.studentsNeedPush === 0 && c.dormant === 0 ? 'ok' : undefined,
      action: 'See students', go: () => openV2('v2-insights', { segment: c.studentsNeedPush > 0 ? 'needs_push' : c.dormant > 0 ? 'dormant' : null }),
    },
    ...(data.scope.isMaster ? [{
        key: 'courses' as const, icon: BookOpen, label: 'Courses to finish', value: c.coursesWithMissingFiles + c.draftCourses,
        note: c.coursesWithMissingFiles > 0 ? `${plural(c.coursesWithMissingFiles, 'course')} missing files` : c.draftCourses > 0 ? `${plural(c.draftCourses, 'draft')}` : 'All files in place',
        action: 'Course builder', go: () => openV2('v2-builder', { builderCourseId: null, courseId: null }),
        tone: (c.coursesWithMissingFiles > 0 ? 'urgent' : c.draftCourses === 0 ? 'ok' : undefined) as CardDef['tone'],
      }] : []),
    {
        key: 'teachers' as const, icon: Users, label: 'Teachers at their limit', value: full,
        note: teachers ? `of ${plural(teachers, 'teacher')}` : 'No teachers yet',
        tone: teachers > 0 && full >= teachers ? 'urgent' : full === 0 && teachers > 0 ? 'ok' : undefined,
        action: 'Review network', go: () => openV2('v2-policies', { policiesView: 'network' }),
      },
  ];
  return (
    <section className="v2-home-cards" aria-label="Today in numbers">
      {cards.map(card => (
        <article
          key={card.key}
          className={`v2-home-card v3-tappable${card.tone ? ` is-${card.tone}` : ''}${picked === card.key ? ' is-picked' : ''}`}
          role="button"
          tabIndex={0}
          aria-expanded={picked === card.key}
          aria-label={`${card.label}: ${card.value}. Tap to see the names.`}
          onClick={() => onPick(card.key)}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(card.key); } }}
        >
          <div className="v2-home-card-top">
            <span className="v2-home-card-icon" aria-hidden="true"><card.icon size={17} /></span>
            <span className="v2-home-card-label">{card.label}</span>
          </div>
          <strong className="v2-home-card-value">{card.value}</strong>
          <span className="v2-home-card-note">{card.tone === 'ok' && <Check size={13} aria-hidden="true" />}{card.note}</span>
          <span className="v3-tap-hint">{picked === card.key ? 'Showing names below' : 'Tap to see names'}</span>
          <button type="button" className="btn btn-outline v2-home-card-btn" onClick={e => { e.stopPropagation(); card.go(); }}>{card.action} <ArrowRight size={14} /></button>
        </article>
      ))}
    </section>
  );
}

/* ------------------------------------------------------------------ do next */
function DoNext({ alerts }: { alerts: AdminTodayAlert[] }) {
  return (
    <section className="v2-home-section" aria-labelledby="v2-home-next">
      <div className="v2-home-section-head">
        <h2 id="v2-home-next">Do next</h2>
        {alerts.length > 0 && <p className="muted">Most important first. One tap takes you there.</p>}
      </div>
      {alerts.length === 0 ? (
        <div className="v2-home-allclear">
          <span aria-hidden="true"><Check size={18} /></span>
          <div><strong>All caught up</strong><small>Nothing needs you right now. Enjoy your writing.</small></div>
        </div>
      ) : (
        <ol className="v2-home-todo">
          {alerts.map((a, i) => (
            <li key={`${a.actionPage}-${i}`} className={`v2-home-todo-item is-${a.severity}`}>
              <span className="v2-home-todo-when">{WHEN[a.severity]}</span>
              <p className="v2-home-todo-text">{a.text}</p>
              <button type="button" className={`btn ${a.severity === 'urgent' ? 'btn-primary' : 'btn-outline'} v2-home-todo-btn`} onClick={() => openV2(a.actionPage, a.actionParams ?? {})}>
                {a.actionLabel} <ArrowRight size={14} />
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ branches */
function BranchSnapshot({ rows, onPick }: { rows: AdminTodayBranch[]; onPick?: (id: string) => void }) {
  return (
    <section className="v2-home-section" aria-labelledby="v2-home-branches">
      <div className="v2-home-section-head">
        <h2 id="v2-home-branches">Branches at a glance</h2>
        {onPick && <p className="muted">Tap a branch to see only its day.</p>}
      </div>
      <div className="v2-home-table-wrap">
        <table className="v2-home-table">
          <thead>
            <tr>
              <th scope="col">Branch</th>
              <th scope="col">Students</th>
              <th scope="col">Active <small>30 days</small></th>
              <th scope="col">Waiting</th>
              <th scope="col">Over 3 days</th>
              <th scope="col">Average wait</th>
              <th scope="col">Answered <small>in 3 days</small></th>
              <th scope="col">Merit to give</th>
              <th scope="col">Teachers full</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(b => (
              <tr key={b.branchId} className={onPick ? 'is-clickable' : ''} onClick={onPick ? () => onPick(b.branchId) : undefined}>
                <th scope="row">{onPick ? <button type="button" className="v2-home-branch-link" onClick={e => { e.stopPropagation(); onPick(b.branchId); }}>{b.name}</button> : b.name}</th>
                <td>{b.students}</td>
                <td>{b.active30d}</td>
                <td>{b.waiting}</td>
                <td className={b.overdue > 0 ? 'v2-home-bad' : ''}>{b.overdue}</td>
                <td>{waitLabel(b.avgWaitHours)}</td>
                <td>{pctLabel(b.answeredWithin72hPct)}</td>
                <td>{b.meritPending}</td>
                <td className={b.teachers > 0 && b.teachersFull >= b.teachers ? 'v2-home-bad' : ''}>{b.teachers ? `${b.teachersFull} of ${b.teachers}` : <span className="muted">No teachers</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="v2-home-branch-cards">
        {rows.map(b => (
          <button type="button" key={b.branchId} className="v2-home-branch-card" onClick={onPick ? () => onPick(b.branchId) : undefined} disabled={!onPick}>
            <span className="v2-home-branch-name">
              <strong>{b.name}</strong>
              {b.overdue > 0 ? <span className="v2-home-flag">{b.overdue} over 3 days</span> : null}
              {onPick && <ChevronRight size={16} aria-hidden="true" />}
            </span>
            <span className="v2-home-branch-stats">
              <span><b>{b.students}</b>students</span>
              <span><b>{b.active30d}</b>active</span>
              <span><b>{b.waiting}</b>waiting</span>
              <span><b>{pctLabel(b.answeredWithin72hPct)}</b>in 3 days</span>
            </span>
            <span className="v2-home-branch-foot muted">
              {b.teachers ? `${b.teachersFull} of ${plural(b.teachers, 'teacher')} full` : 'No teachers yet'}
              {b.meritPending > 0 ? ` · merit for ${plural(b.meritPending, 'student')}` : ''}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

function SingleBranch({ row }: { row: AdminTodayBranch }) {
  const items: [string, ReactNode][] = [
    ['Students', row.students],
    ['Active in 30 days', row.active30d],
    ['Average wait', waitLabel(row.avgWaitHours)],
    ['Answered in 3 days', pctLabel(row.answeredWithin72hPct)],
  ];
  return (
    <section className="v2-home-section" aria-labelledby="v2-home-branch">
      <div className="v2-home-section-head"><h2 id="v2-home-branch">{row.name} at a glance</h2></div>
      <div className="v2-home-glance">
        {items.map(([label, value]) => <div key={label}><b>{value}</b><span>{label}</span></div>)}
      </div>
    </section>
  );
}
