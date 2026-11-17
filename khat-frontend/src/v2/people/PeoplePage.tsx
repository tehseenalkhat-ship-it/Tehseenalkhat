import { useEffect, useState } from 'react';
import { AlertTriangle, Search, ShieldCheck, UserPlus } from 'lucide-react';
import { apiFetch } from '@/api';
import {
  ConfirmDialog, ErrorBox, Loading, PageHead, ToastHost, errorText, loadBranches, loadScope, toast, useLoad, type Branch,
} from '../admin/shared';
import type { PeopleResponse, Person, PersonChange, PersonRole } from '../announce/commsTypes';
import '../announce/v3-comms.css';

// owner: admin-comms (v3 note 6.4) — route v2-people. One list, one tap to change a role.
type Props = Record<string, never>;

const ROLE_LABEL: Record<PersonRole, string> = { student: 'Student', teacher: 'Teacher', branch_admin: 'Branch admin', master_admin: 'Master admin' };
const STAFF_ROLES: PersonRole[] = ['teacher', 'branch_admin', 'master_admin'];
const ROLE_HELP: Record<PersonRole, string> = {
  student: 'Learns on the site.',
  teacher: 'Reviews and marks the work of their branch.',
  branch_admin: 'Runs one branch: its rules, merit points, announcements. One per branch is usual.',
  master_admin: 'The Nairobi team: courses, fixed rules, every branch.',
};

export function V2PeoplePage(_props: Props) {
  const scope = useLoad(async () => {
    const [s, b] = await Promise.all([loadScope(), loadBranches()]);
    return { isMaster: s.scope.isMaster, branches: b };
  });
  const [role, setRole] = useState<PersonRole | ''>('');
  const [branchId, setBranchId] = useState('');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => { const t = window.setTimeout(() => setQuery(q.trim()), 300); return () => window.clearTimeout(t); }, [q]);
  const people = useLoad(() => {
    const p = new URLSearchParams();
    if (role) p.set('role', role);
    if (branchId) p.set('branchId', branchId);
    if (query) p.set('q', query);
    return apiFetch<PeopleResponse>(`/v2/people?${p}`);
  }, [role, branchId, query]);
  const [pending, setPending] = useState<{ person: Person; change: PersonChange; text: string } | null>(null);

  const apply = async (person: Person, change: PersonChange) => {
    try {
      const res = await apiFetch<{ person: Person; note: string | null }>(`/v2/people/${person.id}`, { method: 'PATCH', body: change });
      people.setData(d => d && { ...d, people: d.people.map(p => (p.id === person.id ? res.person : p)) });
      toast(res.note ?? `${person.name} updated.`);
    } catch (err) { toast(errorText(err), { tone: 'error' }); }
  };
  const ask = (person: Person, change: PersonChange) => {
    const branches = scope.data?.branches ?? [];
    const text = change.role
      ? `${person.name} will become ${ROLE_LABEL[change.role].toLowerCase()}${change.role === 'master_admin' ? ' — they can change everything, in every branch' : ''}.`
      : change.branchId ? `${person.name} moves to ${branches.find(b => b.id === change.branchId)?.name ?? 'another branch'}.` : `${person.name} ${change.isCoordinator ? 'becomes' : 'is no longer'} the coordinator.`;
    setPending({ person, change, text });
  };

  const counts = people.data?.counts;
  const canEdit = Boolean(people.data?.canEdit);
  const branches: Branch[] = scope.data?.branches ?? [];

  return (
    <div className="page portal-page v2-admin v3-page">
      <PageHead
        eyebrow="Funun al-Quran"
        title="People & roles"
        text={canEdit
          ? 'Everyone who teaches or runs a branch. Tap a role to change it — the person sees it the next time they sign in. Every change is written in the history.'
          : 'The teachers and admins of your branch. Roles are changed by the master team.'}
      />
      {scope.error && <ErrorBox message={scope.error} onRetry={() => void scope.reload()} />}
      {counts && (
        <div className="v3-counts" role="tablist" aria-label="Show">
          <button type="button" role="tab" aria-selected={role === ''} className={role === '' ? 'on' : ''} onClick={() => setRole('')}><b>{counts.teacher + counts.branch_admin + counts.master_admin}</b>All staff</button>
          {STAFF_ROLES.filter(r => canEdit || counts[r] > 0).map(r => <button key={r} type="button" role="tab" aria-selected={role === r} className={role === r ? 'on' : ''} onClick={() => setRole(r)}><b>{counts[r]}</b>{ROLE_LABEL[r]}{counts[r] === 1 ? '' : 's'}</button>)}
          {canEdit && <button type="button" role="tab" aria-selected={role === 'student'} className={role === 'student' ? 'on' : ''} onClick={() => setRole('student')}><UserPlus size={13} /> Make a student a teacher</button>}
        </div>
      )}
      <div className="v3-toolbar">
        <label className="v2-search" style={{ flex: 1, minWidth: 200 }}><Search size={16} /><input value={q} onChange={e => setQ(e.target.value)} placeholder={role === 'student' ? 'Search a student by name, email or TR' : 'Search by name or email'} aria-label="Search people" /></label>
        {scope.data?.isMaster && (
          <select className="field" style={{ width: 'auto', minWidth: 170 }} value={branchId} onChange={e => setBranchId(e.target.value)} aria-label="Branch">
            <option value="">Every branch</option>
            {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        )}
      </div>
      {people.error && <ErrorBox message={people.error} onRetry={() => void people.reload()} />}
      {people.loading && !people.data && <Loading label="Loading people…" />}
      {people.data && people.data.people.length === 0 && <div className="v3-empty"><strong>Nobody found</strong>{role === 'student' && !query ? 'Type a name to find the student.' : 'Try another name.'}</div>}
      {(() => {
        // v3 audit 32: flag people without a (valid) branch — they see no branch work and get no branch messages.
        const missing = people.data && scope.data ? people.data.people.filter(p => !branches.some(b => b.id === p.branchId)) : [];
        return missing.length > 0 ? (
          <p className="v3-nobranch-note" role="status"><AlertTriangle size={15} aria-hidden="true" /> {missing.length === 1 ? `${missing[0].name} has` : `${missing.length} people have`} no branch. {canEdit ? 'Choose a branch for them below.' : 'Ask the master team to set it.'}</p>
        ) : null;
      })()}
      {people.data && (
        <div className="v3-people">
          {people.data.people.map(p => (
            <article key={p.id} className={`v3-person${scope.data && !branches.some(b => b.id === p.branchId) ? ' is-nobranch' : ''}`}>
              <div className="v3-person-name">
                <b>{p.name}</b>
                <small>{p.email}{p.trNumber ? ` · TR ${p.trNumber}` : ''}</small>
              </div>
              <div>
                <div className="v3-roles" role="radiogroup" aria-label={`Role of ${p.name}`}>
                  {(p.role === 'student' ? (['student', ...STAFF_ROLES] as PersonRole[]) : STAFF_ROLES).map(r => (
                    <button key={r} type="button" role="radio" aria-checked={p.role === r} className={p.role === r ? 'on' : ''} disabled={!canEdit || p.role === r} title={ROLE_HELP[r]} onClick={() => ask(p, { role: r })}>{ROLE_LABEL[r]}</button>
                  ))}
                </div>
                {p.role === 'teacher' && (
                  <label className="v3-person-coord"><input type="checkbox" checked={p.isCoordinator} disabled={!canEdit} onChange={e => ask(p, { isCoordinator: e.target.checked })} /> Coordinator (sees the whole branch’s numbers)</label>
                )}
              </div>
              <div>
                {canEdit ? (
                  <select className="field" value={branches.some(b => b.id === p.branchId) ? p.branchId : ''} onChange={e => e.target.value && ask(p, { branchId: e.target.value })} aria-label={`Branch of ${p.name}`}>
                    {!branches.some(b => b.id === p.branchId) && <option value="">No branch — choose one</option>}
                    {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                ) : <span className="v3-chip">{p.branchName || '—'}</span>}
              </div>
            </article>
          ))}
        </div>
      )}
      {!canEdit && people.data && <p className="v3-muted v3-small" style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 6 }}><ShieldCheck size={14} /> Need a change? Ask the master team.</p>}
      {pending && (
        <ConfirmDialog
          title="Change this?"
          text={pending.text}
          confirmLabel="Yes, change it"
          onClose={() => setPending(null)}
          onConfirm={() => apply(pending.person, pending.change)}
        />
      )}
      <ToastHost />
    </div>
  );
}
