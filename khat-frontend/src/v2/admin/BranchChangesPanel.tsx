import { useEffect, useState } from 'react';
import { BellRing, Check, ChevronDown, ChevronUp } from 'lucide-react';
import { apiFetch } from '@/api';
import type { BranchPolicyChanges } from '../announce/commsTypes';
import { plainPolicySummary, POLICY_WORDS } from '../announce/commsShared';
import { formatDate } from './shared';

// owner: admin-comms (v3 note 6.12) — the master team sees every rule a branch changed.

export function BranchChangesPanel({ branchName, compact }: { branchName?: (id: string) => string; compact?: boolean }) {
  const [data, setData] = useState<BranchPolicyChanges | null>(null);
  const [open, setOpen] = useState(false);
  const load = () => apiFetch<BranchPolicyChanges>('/v2/policies/branch-changes?limit=30', { silent: true }).then(setData).catch(() => setData(null));
  useEffect(() => { void load(); }, []);
  if (!data || !data.changes.length) return null;
  const markSeen = async () => {
    await apiFetch('/v2/policies/branch-changes/seen', { method: 'POST', body: {}, silent: true }).catch(() => {});
    setData(d => d && { ...d, newCount: 0, changes: d.changes.map(c => ({ ...c, isNew: false })) });
  };
  const shown = open ? data.changes : data.changes.filter(c => c.isNew).slice(0, compact ? 3 : 5);
  return (
    <section className={`v3-changes${data.newCount ? ' has-new' : ''}`} aria-label="Changes made by branches">
      <div className="v3-changes-head">
        <BellRing size={17} aria-hidden="true" />
        <div>
          <strong>{data.newCount ? `${data.newCount} rule${data.newCount === 1 ? '' : 's'} changed by branches` : 'Rules changed by branches'}</strong>
          <small>{data.newCount ? 'Since you last looked' : 'Nothing new since you last looked'}</small>
        </div>
        <span className="v2-grow" />
        {data.newCount > 0 && <button type="button" className="btn btn-outline v2-btn-sm" onClick={() => void markSeen()}><Check size={14} /> Seen</button>}
        <button type="button" className="v2-link" onClick={() => setOpen(o => !o)}>{open ? <>Hide <ChevronUp size={14} /></> : <>All changes <ChevronDown size={14} /></>}</button>
      </div>
      {shown.length > 0 && (
        <ul className="v3-changes-list">
          {shown.map(c => (
            <li key={c.id} className={c.isNew ? 'is-new' : ''}>
              <span className="v3-changes-branch">{c.branchName ?? (c.branchId && branchName ? branchName(c.branchId) : 'Branch')}</span>
              <span className="v3-changes-text">
                <b>{c.policyKey ? POLICY_WORDS[c.policyKey] ?? c.policyKey : 'A rule'}</b>
                <small>{plainPolicySummary(c.summary, c.policyKey)}</small>
              </span>
              <span className="v3-changes-meta">{c.actorName ?? '—'} · {formatDate(c.createdAt, true)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
