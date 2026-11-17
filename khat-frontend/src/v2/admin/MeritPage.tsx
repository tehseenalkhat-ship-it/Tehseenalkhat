import { useEffect, useMemo, useState } from 'react';
import { Award, CheckCircle2, ChevronLeft, ChevronRight, ClipboardCopy, FileSpreadsheet, FileText, History, ListTodo, UserCheck } from 'lucide-react';
import { apiFetch, getSessionUser } from '@/api';
import { downloadFromApi } from '../announce/commsShared';
import type { MeritEntry, MeritToGive, PoliciesResponse } from '../contracts';
import {
  ConfirmDialog, EmptyState, ErrorBox, Loading, PageHead, ToastHost, copyText, errorText, formatDate, loadBranches, loadStaff, plural, toast,
  type Branch, type StaffRow,
} from './shared';

type Props = Record<string, never>;
type Tab = 'give' | 'history';

function nairobiMonth(d = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit' }).formatToParts(d);
  return `${parts.find(p => p.type === 'year')?.value}-${parts.find(p => p.type === 'month')?.value}`;
}
function shiftMonth(m: string, delta: number): string {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function monthLabel(m: string): string {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export function V2MeritPage(_props: Props) {
  const [tab, setTab] = useState<Tab>('give');
  const [month, setMonth] = useState(nairobiMonth());
  const [branchId, setBranchId] = useState<string | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [isMaster, setIsMaster] = useState(false);
  const [officerName, setOfficerName] = useState<string | null>(null);
  const [data, setData] = useState<MeritToGive | null>(null);
  const [history, setHistory] = useState<MeritEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    void (async () => {
      // v3 audit 31: a teacher opening this page must not hit the admin-only /v2/policies (403).
      const me = getSessionUser();
      const isAdmin = me?.role === 'admin';
      const [b, p] = await Promise.all([loadBranches(), isAdmin ? apiFetch<PoliciesResponse>('/v2/policies').catch(() => null) : Promise.resolve(null)]);
      setBranches(b);
      const master = Boolean(p?.canEditGlobal);
      setIsMaster(master);
      setBranchId(master ? '' : p?.editableBranchIds[0] ?? me?.branchId ?? '');
    })();
  }, []);

  const query = `month=${month}${branchId ? `&branchId=${encodeURIComponent(branchId)}` : ''}`;
  const load = async () => {
    if (branchId === null) return;
    setLoading(true); setError(null);
    try {
      if (tab === 'give') {
        const res = await apiFetch<MeritToGive>(`/v2/merit/to-give?${query}`);
        setData(res);
        setSelected(new Set());
        if (res.officerUserId) {
          const staff: StaffRow[] = await loadStaff(branchId || null);
          setOfficerName(staff.find(s => s.id === res.officerUserId)?.name ?? null);
        } else setOfficerName(null);
      } else {
        setHistory(await apiFetch<MeritEntry[]>(`/v2/merit/history?${query}`));
      }
    } catch (err) { setError(errorText(err, 'Could not load merit points.')); } finally { setLoading(false); }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [tab, month, branchId]);

  const students = data?.students ?? [];
  const totalPoints = students.reduce((n, s) => n + s.total, 0);
  const chosen = students.filter(s => selected.has(s.studentId));
  const chosenPoints = chosen.reduce((n, s) => n + s.total, 0);
  const allOn = students.length > 0 && chosen.length === students.length;
  const thisMonth = nairobiMonth();

  const table = (rows = chosen.length ? chosen : students) => [
    ['TR number', 'Name', 'Branch', 'Points', 'For'].join('\t'),
    ...rows.map(s => [s.trNumber ?? '', s.studentName, s.branchName ?? '', String(s.total), s.entries.map(e => e.sourceLabel).join('; ')].join('\t')),
  ].join('\n');

  const exportAs = async (format: 'xlsx' | 'pdf') => {
    try {
      await downloadFromApi(`/v2/merit/export?format=${format}&what=${tab === 'give' ? 'to-give' : 'history'}&${query}`, `merit-${month}.${format}`);
    } catch (err) { toast(errorText(err, 'Could not download the list.'), { tone: 'error' }); }
  };
  const exportButtons = (
    <div className="v3-export">
      <button type="button" className="btn btn-outline v2-btn-sm" onClick={() => void exportAs('xlsx')}><FileSpreadsheet size={14} /> Excel</button>
      <button type="button" className="btn btn-outline v2-btn-sm" onClick={() => void exportAs('pdf')}><FileText size={14} /> PDF</button>
    </div>
  );

  const markGiven = async () => {
    const ids = chosen.flatMap(s => s.entries.map(e => e.id));
    try {
      await apiFetch('/v2/merit/mark-given', { method: 'POST', body: { entryIds: ids } });
      toast(`${plural(chosen.length, 'student')} marked as given.`);
      setData(d => d && ({ ...d, students: d.students.filter(s => !selected.has(s.studentId)) }));
      setSelected(new Set());
    } catch (err) { toast(errorText(err), { tone: 'error' }); }
  };

  return (
    <div className="page portal-page v2-admin">
      <PageHead
        eyebrow="Jamea portal"
        title="Merit points to give"
        text="Everything students have earned and are waiting for. The branch admin enters the points on the Jamea portal, then marks them as given — they leave this list. Merit points are for staff only; students do not see them."
        actions={exportButtons}
      />

      <div className="v2-merit-controls">
        <div className="v2-month" aria-label="Month">
          <button type="button" className="v2-icon-btn" aria-label="Previous month" onClick={() => setMonth(m => shiftMonth(m, -1))}><ChevronLeft size={18} /></button>
          <label><span className="sr-only">Month</span><input type="month" value={month} max={tab === 'give' ? thisMonth : undefined} onChange={e => e.target.value && setMonth(e.target.value)} /></label>
          <strong>{monthLabel(month)}</strong>
          <button type="button" className="v2-icon-btn" aria-label="Next month" disabled={tab === 'give' && month >= thisMonth} onClick={() => setMonth(m => shiftMonth(m, 1))}><ChevronRight size={18} /></button>
        </div>
        {isMaster && (
          <select className="field v2-branch-select" value={branchId ?? ''} onChange={e => setBranchId(e.target.value)} aria-label="Branch">
            <option value="">Every branch</option>
            {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        )}
        <div className="v2-tabs v2-tabs-inline" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'give'} className={tab === 'give' ? 'active' : ''} onClick={() => setTab('give')}><ListTodo size={15} /> To give</button>
          <button type="button" role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}><History size={15} /> Given</button>
        </div>
      </div>

      {error && <ErrorBox message={error} onRetry={() => void load()} />}
      {loading && <Loading label="Loading merit points…" />}

      {tab === 'give' && data && !loading && (
        <>
          {!data.canMarkGiven && (
            <div className="v2-banner"><UserCheck size={15} /><span>
              {isMaster
                ? <>Merit points are given by each branch’s admin. You can see every branch here and download the lists.</>
                : <>Merit points are given by your branch admin{officerName ? <> (or <b>{officerName}</b>)</> : null}. You can still see, copy and download the list.</>}
            </span></div>
          )}

          <div className="v2-stat-row">
            <div className="v2-stat"><strong>{students.length}</strong><span>students waiting</span></div>
            <div className="v2-stat"><strong>{totalPoints}</strong><span>points to give</span></div>
            <div className="v2-stat"><strong>{students.reduce((n, s) => n + s.entries.length, 0)}</strong><span>reasons</span></div>
          </div>

          {students.length === 0 ? (
            <EmptyState icon={<CheckCircle2 size={28} />} title={`Nothing to give for ${monthLabel(month)}`} text="When students pass levels or finish a certification, their points appear here by themselves." />
          ) : (
            <section className="v2-card v2-merit-list">
              <div className="v2-merit-head">
                <label className="v2-check"><input type="checkbox" checked={allOn} onChange={e => setSelected(e.target.checked ? new Set(students.map(s => s.studentId)) : new Set())} aria-label="Select everyone" /></label>
                <span>Student</span><span>TR number</span><span>For</span><span className="v2-right">Points</span>
              </div>
              {students.map(s => {
                const isOpen = open.has(s.studentId);
                return (
                  <div key={s.studentId} className={`v2-merit-row${selected.has(s.studentId) ? ' is-selected' : ''}`}>
                    <label className="v2-check"><input type="checkbox" checked={selected.has(s.studentId)} onChange={e => setSelected(x => { const n = new Set(x); if (e.target.checked) n.add(s.studentId); else n.delete(s.studentId); return n; })} aria-label={`Select ${s.studentName}`} /></label>
                    <span className="v2-merit-name"><strong>{s.studentName}</strong>{s.branchName && <small>{s.branchName}</small>}</span>
                    <span className="v2-merit-tr">{s.trNumber ?? <em className="muted">no TR</em>}</span>
                    <span className="v2-merit-src">
                      {(isOpen ? s.entries : s.entries.slice(0, 2)).map(e => (
                        <span key={e.id} className="v2-src-line"><span className={`v2-src-dot src-${e.source}`} />{e.sourceLabel} <b>+{e.points}</b>{e.earnedMonth !== month && <em> (carried from {monthLabel(e.earnedMonth)})</em>}</span>
                      ))}
                      {s.entries.length > 2 && <button type="button" className="v2-link" onClick={() => setOpen(o => { const n = new Set(o); if (n.has(s.studentId)) n.delete(s.studentId); else n.add(s.studentId); return n; })}>{isOpen ? 'Show less' : `+ ${s.entries.length - 2} more`}</button>}
                    </span>
                    <span className="v2-merit-total">{s.total}</span>
                  </div>
                );
              })}
            </section>
          )}

          {students.length > 0 && (
            <div className="v2-bulkbar v2-bulkbar-static">
              <strong>{chosen.length ? `${plural(chosen.length, 'student')} · ${chosenPoints} points` : 'Tick students, or copy everyone'}</strong>
              <div className="v2-bulk-actions">
                <button type="button" className="btn btn-outline v2-btn-sm" onClick={async () => { if (await copyText(table())) toast(`Copied ${plural(chosen.length || students.length, 'row')} — paste into the Jamea portal or a sheet.`); }}>
                  <ClipboardCopy size={14} /> Copy {chosen.length ? 'selected' : 'all'}
                </button>
                {data.canMarkGiven && <button type="button" className="btn btn-primary v2-btn-sm" disabled={!chosen.length} onClick={() => setConfirming(true)}><Award size={14} /> Mark as given on the Jamea portal</button>}
              </div>
            </div>
          )}
        </>
      )}

      {tab === 'history' && history && !loading && (
        history.length === 0
          ? <EmptyState icon={<History size={26} />} title={`Nothing given in ${monthLabel(month)}`} text="Points you mark as given appear here, with who gave them and when." />
          : (
            <section className="v2-card v2-history-table">
              <div className="v2-hist-head"><span>Given</span><span>Student</span><span>For</span><span className="v2-right">Points</span><span>By</span></div>
              {history.map(e => (
                <div key={e.id} className={`v2-hist-row${e.status === 'void' ? ' is-void' : ''}`}>
                  <span>{formatDate(e.givenAt)}</span>
                  <span><strong>{e.studentName}</strong><small>{[e.trNumber, e.branchName].filter(Boolean).join(' · ')}</small></span>
                  <span>{e.sourceLabel}{e.status === 'void' && <em className="muted"> (cancelled)</em>}</span>
                  <span className="v2-right"><b>{e.points}</b></span>
                  <span className="muted">{e.givenByName ?? '—'}</span>
                </div>
              ))}
            </section>
          )
      )}

      {confirming && (
        <ConfirmDialog
          title="Mark as given?"
          confirmLabel={`Yes, ${plural(chosen.length, 'student')} done`}
          onClose={() => setConfirming(false)}
          onConfirm={markGiven}
          text={<>Have you entered these <b>{chosenPoints} points</b> for <b>{plural(chosen.length, 'student')}</b> on the Jamea portal? They will leave this list. You can still see them under “Given”.</>}
        />
      )}
      <ToastHost />
    </div>
  );
}
