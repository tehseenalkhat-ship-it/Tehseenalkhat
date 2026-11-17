import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, Check, Copy, Lock, RefreshCw, X } from 'lucide-react';
import { apiFetch, ApiError, getSessionUser } from '@/api';
import { PenLoader } from '@/components/ui';
import type { PoliciesResponse } from '../contracts';
import './v2-admin.css';

export type Branch = { id: string; name: string };
export type StaffRow = { id: string; role: string; name: string; email: string; branch_id: string; is_coordinator: boolean };

export function errorText(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (err instanceof ApiError) return err.message || fallback;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

/** Generic loader: data, loading, error, reload. */
export function useLoad<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const reload = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError(null);
    try {
      setData(await loaderRef.current());
    } catch (err) {
      setError(errorText(err, 'Could not load this page.'));
    } finally {
      setLoading(false);
    }
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void reload(); }, deps);
  return { data, setData, loading, error, reload };
}

/** Admin scope is not in the session — /v2/policies tells us what the caller may change. */
export type AdminScopeInfo = { isMaster: boolean; editableBranchIds: string[]; homeBranchId: string | null };

export async function loadScope(): Promise<{ scope: AdminScopeInfo; policies: PoliciesResponse | null }> {
  const user = getSessionUser();
  // Teachers may open some staff pages (merit points): /v2/policies is for admins only, so do not ask.
  if (user?.role !== 'admin') return { scope: { isMaster: false, editableBranchIds: [], homeBranchId: user?.branchId ?? null }, policies: null };
  try {
    const policies = await apiFetch<PoliciesResponse>('/v2/policies');
    return { scope: { isMaster: policies.canEditGlobal, editableBranchIds: policies.editableBranchIds, homeBranchId: user?.branchId ?? null }, policies };
  } catch {
    return { scope: { isMaster: false, editableBranchIds: [], homeBranchId: user?.branchId ?? null }, policies: null };
  }
}

export async function loadBranches(): Promise<Branch[]> {
  try { return await apiFetch<Branch[]>('/branches', { silent: true }); } catch { return []; }
}

export async function loadStaff(branchId?: string | null): Promise<StaffRow[]> {
  const q = branchId ? `?branchId=${encodeURIComponent(branchId)}` : '';
  try { return await apiFetch<StaffRow[]>(`/admin/users${q}`, { silent: true }); } catch { return []; }
}

/* ---------------- Small presentational pieces ---------------- */

export function PageHead({ eyebrow, title, text, actions }: { eyebrow: string; title: string; text?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="v2-head">
      <div className="v2-head-copy">
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        {text && <p className="v2-head-text">{text}</p>}
      </div>
      {actions && <div className="v2-head-actions">{actions}</div>}
    </header>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="v2-error" role="alert">
      <AlertCircle size={17} />
      <span>{message}</span>
      {onRetry && <button type="button" className="v2-link" onClick={onRetry}><RefreshCw size={14} /> Try again</button>}
    </div>
  );
}

export function Loading({ label }: { label: string }) {
  return <div className="v2-loading"><PenLoader label={label} compact /><span className="muted">{label}</span></div>;
}

export function EmptyState({ icon, title, text, children }: { icon: ReactNode; title: string; text?: ReactNode; children?: ReactNode }) {
  return (
    <div className="v2-empty">
      <div className="v2-empty-icon" aria-hidden="true">{icon}</div>
      <h3>{title}</h3>
      {text && <p>{text}</p>}
      {children && <div className="v2-empty-actions">{children}</div>}
    </div>
  );
}

export function ReadOnlyBanner({ children }: { children: ReactNode }) {
  return <div className="v2-banner"><Lock size={15} /><span>{children}</span></div>;
}

export function Switch({ checked, onChange, label, disabled, id }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; id?: string }) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`v2-switch${checked ? ' on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="v2-switch-knob" />
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange, disabled, label, size = 'md' }: {
  value: T; options: { value: T; label: ReactNode; hint?: string }[]; onChange: (v: T) => void; disabled?: boolean; label: string; size?: 'sm' | 'md';
}) {
  return (
    <div className={`v2-seg v2-seg-${size}`} role="radiogroup" aria-label={label}>
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={disabled}
          title={o.hint}
          className={value === o.value ? 'active' : ''}
          onClick={() => onChange(o.value)}
        >{o.label}</button>
      ))}
    </div>
  );
}

export function NumberStepper({ value, onChange, min = 0, max = 9999, step = 1, unit, disabled, label }: {
  value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; unit?: string; disabled?: boolean; label: string;
}) {
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  return (
    <div className="v2-stepper">
      <button type="button" aria-label={`Less ${label}`} disabled={disabled || value <= min} onClick={() => onChange(clamp(value - step))}>−</button>
      <input
        type="number"
        inputMode="numeric"
        aria-label={label}
        value={Number.isFinite(value) ? value : ''}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={e => { const n = Number(e.target.value); if (Number.isFinite(n)) onChange(clamp(n)); }}
      />
      <button type="button" aria-label={`More ${label}`} disabled={disabled || value >= max} onClick={() => onChange(clamp(value + step))}>+</button>
      {unit && <span className="v2-stepper-unit">{unit}</span>}
    </div>
  );
}

/* ---------------- Toasts (with optional Undo) ---------------- */

type ToastItem = { id: number; text: string; tone: 'ok' | 'error'; action?: { label: string; run: () => void } };
let pushToastImpl: ((t: Omit<ToastItem, 'id'>) => void) | null = null;

export function toast(text: string, opts: { tone?: 'ok' | 'error'; action?: { label: string; run: () => void } } = {}) {
  pushToastImpl?.({ text, tone: opts.tone ?? 'ok', action: opts.action });
}

export function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => {
    let n = 0;
    pushToastImpl = t => {
      const id = ++n;
      setItems(list => [...list.slice(-2), { ...t, id }]);
      window.setTimeout(() => setItems(list => list.filter(i => i.id !== id)), t.action ? 7000 : 3800);
    };
    return () => { pushToastImpl = null; };
  }, []);
  return (
    <div className="v2-toasts" aria-live="polite">
      {items.map(t => (
        <div key={t.id} className={`v2-toast ${t.tone === 'error' ? 'is-error' : ''}`}>
          {t.tone === 'error' ? <AlertCircle size={16} /> : <Check size={16} />}
          <span>{t.text}</span>
          {t.action && <button type="button" onClick={() => { t.action?.run(); setItems(l => l.filter(i => i.id !== t.id)); }}>{t.action.label}</button>}
          <button type="button" aria-label="Dismiss" className="v2-toast-x" onClick={() => setItems(l => l.filter(i => i.id !== t.id))}><X size={14} /></button>
        </div>
      ))}
    </div>
  );
}

/* ---------------- Dialog ---------------- */

export function Dialog({ title, eyebrow, onClose, children, footer, wide }: { title: string; eyebrow?: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const first = ref.current?.querySelector<HTMLElement>('input, textarea, select, button:not(.v2-dialog-x)');
    first?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);
  return (
    <div className="v2-dialog-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className={`v2-dialog${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="v2-dialog-head">
          <div>
            {eyebrow && <p className="eyebrow">{eyebrow}</p>}
            <h2>{title}</h2>
          </div>
          <button type="button" className="v2-dialog-x" aria-label="Close" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="v2-dialog-body">{children}</div>
        {footer && <div className="v2-dialog-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmDialog({ title, text, confirmLabel, danger, onConfirm, onClose }: { title: string; text: ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => void | Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={<>
        <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
        <button type="button" className={`btn btn-primary${danger ? ' v2-btn-danger' : ''}`} disabled={busy} onClick={async () => { setBusy(true); try { await onConfirm(); onClose(); } finally { setBusy(false); } }}>{busy ? 'Working…' : confirmLabel}</button>
      </>}
    >
      <div className="v2-dialog-text">{text}</div>
    </Dialog>
  );
}

/* ---------------- Clipboard ---------------- */

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export function CopyButton({ text, label = 'Copy', done = 'Copied', className = 'btn btn-outline v2-btn-sm' }: { text: string | (() => string); label?: string; done?: string; className?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button type="button" className={className} onClick={async () => {
      const value = typeof text === 'function' ? text() : text;
      if (await copyText(value)) { setOk(true); window.setTimeout(() => setOk(false), 1800); }
    }}>
      {ok ? <Check size={14} /> : <Copy size={14} />} {ok ? done : label}
    </button>
  );
}

export function formatDate(iso: string | null | undefined, withTime = false): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-GB', withTime ? { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short', year: 'numeric' });
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function slugKey(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'custom';
}
