// owner: insights — small helpers shared by Insights, Team report and Community.
import { useEffect, useState, type ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import { apiFetch, getSessionUser } from '@/api';
import type { PoliciesResponse } from '../contracts';

export type BranchOption = { id: string; name: string };

/** Master admins can switch branches; everyone else sees their own branch. */
export function useStaffScope(): { isMaster: boolean; branches: BranchOption[]; ready: boolean } {
  const user = getSessionUser();
  const [state, setState] = useState<{ isMaster: boolean; branches: BranchOption[]; ready: boolean }>({ isMaster: false, branches: [], ready: user?.role !== 'admin' });

  useEffect(() => {
    let cancelled = false;
    const branchesP = apiFetch<BranchOption[]>('/branches', { silent: true }).catch(() => [] as BranchOption[]);
    const masterP = user?.role === 'admin'
      ? apiFetch<PoliciesResponse>('/v2/policies', { silent: true }).then(p => Boolean(p.canEditGlobal)).catch(() => false)
      : Promise.resolve(false);
    Promise.all([branchesP, masterP]).then(([branches, isMaster]) => {
      if (!cancelled) setState({ isMaster, branches: Array.isArray(branches) ? branches : [], ready: true });
    });
    return () => { cancelled = true; };
  }, [user?.id, user?.role]);

  return state;
}

export function relativeDays(iso: string | null, now = Date.now()): string {
  if (!iso) return 'Never';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const days = Math.floor((now - t) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 60) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 24) return `${months} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

export function hoursLabel(hours: number | null): string {
  if (hours == null) return '—';
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${Math.round(hours * 10) / 10} h`;
  return `${Math.round((hours / 24) * 10) / 10} days`;
}

export function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).map(part => part[0]).slice(0, 2).join('').toUpperCase() || '?';
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="branch-analytics-error v2-ins-error" role="alert">
      <span>{message}</span>
      {onRetry && <button type="button" onClick={onRetry}>Try again <RefreshCw size={13} /></button>}
    </div>
  );
}

export function BranchSelect({ branches, value, onChange, allowAll = true }: { branches: BranchOption[]; value: string; onChange: (id: string) => void; allowAll?: boolean }) {
  return (
    <label className="v2-ins-branch">
      <span>Branch</span>
      <select className="field" value={value} onChange={event => onChange(event.target.value)} aria-label="Choose branch">
        {allowAll && <option value="">All branches</option>}
        {branches.map(branch => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
      </select>
    </label>
  );
}

/** Simple CSS bar (no chart library). value / max, min visible sliver when value > 0. */
export function Bar({ value, max, tone = 'gold', label }: { value: number; max: number; tone?: 'gold' | 'positive' | 'warning' | 'danger' | 'muted'; label?: ReactNode }) {
  const pctValue = max > 0 ? Math.min(100, Math.max(value > 0 ? 3 : 0, (value / max) * 100)) : 0;
  return (
    <span className={`v2-bar v2-bar-${tone}`} role="presentation">
      <i style={{ width: `${pctValue}%` }} />
      {label !== undefined && <em>{label}</em>}
    </span>
  );
}

export function downloadCsv(filename: string, rows: (string | number | null | undefined)[][]): void {
  const escape = (value: string | number | null | undefined) => {
    const text = value == null ? '' : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const csv = '﻿' + rows.map(row => row.map(escape).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
