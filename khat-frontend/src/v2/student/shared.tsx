import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, FileImage, Play, RefreshCw } from 'lucide-react';
import { API_BASE_URL, ApiError, getToken, getViewUrl, trackApiRequest } from '@/api';

/* Small helpers shared by the v2 student pages and competitions. */

export const SIZE_LABELS: Record<string, string> = { '07': '0.7 mm', '10': '1 mm', '20': '2 mm', '30': '3 mm', NP: 'Normal pen' };
export const SIZE_ORDER = ['07', '10', '20', '30', 'NP'];

export function sizeLabel(code: string | null | undefined): string {
  if (!code) return 'Any size';
  return SIZE_LABELS[code.toUpperCase()] ?? code;
}

export function sortSizes(sizes: string[]): string[] {
  return [...new Set(sizes.map(size => size.toUpperCase()))].sort((a, b) => {
    const ia = SIZE_ORDER.indexOf(a); const ib = SIZE_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
}

export const PEN_LABELS: Record<string, string> = { normal: 'Normal pen', cut: 'Cut pen' };
export function penLabel(pen: string | null | undefined): string {
  if (!pen) return 'Other courses';
  return PEN_LABELS[pen.toLowerCase()] ?? pen.charAt(0).toUpperCase() + pen.slice(1);
}

export const COURSE_TYPE_LABELS: Record<string, string> = { certification: 'Certification', crash: 'Crash course', mashq: 'Mashq worksheets' };
export function courseTypeLabel(type: string | null | undefined): string {
  if (!type) return 'Course';
  return COURSE_TYPE_LABELS[type.toLowerCase()] ?? type.charAt(0).toUpperCase() + type.slice(1).replace(/_/g, ' ');
}

export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError || error instanceof Error) return error.message || fallback;
  return fallback;
}

/** Splits "1. Watch… 2. Download…" or multi-line text into clean list items. */
export function splitInstructions(text: string | null | undefined): string[] {
  if (!text) return [];
  const byLine = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const items = byLine.length > 1 ? byLine : text.split(/\s(?=\d+[.)]\s)/).map(part => part.trim()).filter(Boolean);
  return items.map(item => item.replace(/^\d+[.)]\s*/, '').trim()).filter(Boolean);
}

export function formatDate(value: string | null | undefined, options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, options);
}

export function monthLabel(month: string): string {
  const [year, m] = month.split('-').map(Number);
  if (!year || !m) return month;
  return new Date(year, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

export function currentMonthNairobi(): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  const year = parts.find(part => part.type === 'year')?.value ?? String(new Date().getFullYear());
  const month = parts.find(part => part.type === 'month')?.value ?? String(new Date().getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

export function firstName(name: string | null | undefined): string {
  return (name ?? '').trim().split(/\s+/)[0] || 'A student';
}

// ---------- PDF downloads (stamped on the server) ----------

function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(header);
  if (star) { try { return decodeURIComponent(star[1].replace(/"/g, '').trim()); } catch { /* fall through */ } }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain ? plain[1].trim() : null;
}

/** Fetches a PDF (or any binary) with the session token, like getFileObjectUrl does. */
export async function fetchPdf(path: string, options: { method?: string; body?: unknown; fallbackName: string }): Promise<{ blob: Blob; filename: string }> {
  return trackApiRequest(async () => {
    const token = getToken();
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    let response: Response;
    try {
      response = await fetch(`${API_BASE_URL}${path}`, {
        method: options.method ?? 'GET',
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw new ApiError(0, 'We could not reach the server. Please check your internet and try again.');
    }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new ApiError(response.status, (data as { error?: string }).error ?? 'This file could not be prepared. Please try again.');
    }
    const blob = await response.blob();
    return { blob, filename: filenameFromDisposition(response.headers.get('Content-Disposition')) ?? options.fallbackName };
  });
}

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function openBlob(blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const opened = window.open(url, '_blank', 'noopener');
  if (!opened) {
    const anchor = document.createElement('a');
    anchor.href = url; anchor.target = '_blank'; anchor.rel = 'noopener';
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
  }
  window.setTimeout(() => URL.revokeObjectURL(url), 120_000);
}

export function pdfName(base: string): string {
  return `${base.replace(/\.[a-z0-9]+$/i, '').replace(/[\\/:*?"<>|]/g, '-')}.pdf`;
}

// ---------- Signed media ----------

function useInView<T extends Element>(rootMargin = '200px'): [React.RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (seen || !ref.current) return;
    if (!('IntersectionObserver' in window)) { setSeen(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setSeen(true); observer.disconnect(); }
    }, { rootMargin });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [seen, rootMargin]);
  return [ref, seen];
}

const viewUrlCache = new Map<string, Promise<string>>();
export function cachedViewUrl(storageKey: string): Promise<string> {
  let pending = viewUrlCache.get(storageKey);
  if (!pending) {
    pending = getViewUrl(storageKey);
    pending.catch(() => viewUrlCache.delete(storageKey));
    viewUrlCache.set(storageKey, pending);
  }
  return pending;
}

/** Image from storage, loaded only when it scrolls near the screen. */
export function SignedImage({ storageKey, alt, className = '', onClickUrl }: { storageKey: string | null | undefined; alt: string; className?: string; onClickUrl?: (url: string) => void }) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!inView || !storageKey) return;
    let cancelled = false;
    cachedViewUrl(storageKey).then(value => { if (!cancelled) setUrl(value); }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [inView, storageKey]);
  const body = url
    ? <img src={url} alt={alt} loading="lazy" onError={() => setFailed(true)} />
    : <span className="v2s-media-placeholder" aria-hidden="true"><FileImage size={20} />{failed || !storageKey ? <small>Preview not available</small> : null}</span>;
  return (
    <div ref={ref} className={`v2s-signed-image ${className}`}>
      {url && onClickUrl ? <button type="button" className="v2s-signed-image-button" onClick={() => onClickUrl(url)} aria-label={`Open ${alt}`}>{body}</button> : body}
    </div>
  );
}

/** Video that only fetches its signed URL when the student taps play (saves phone data). */
export function SignedVideo({ storageKey, title }: { storageKey: string; title: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    setLoading(true); setError(null);
    try { setUrl(await cachedViewUrl(storageKey)); }
    catch (err) { setError(errorMessage(err, 'The video could not be opened.')); }
    finally { setLoading(false); }
  };
  if (url) return <div className="v2s-video"><video src={url} controls autoPlay playsInline preload="metadata" aria-label={title} /></div>;
  return (
    <div className="v2s-video">
      <button type="button" className="v2s-video-poster" onClick={() => void start()} disabled={loading} aria-label={`Play video: ${title}`}>
        <span className="v2s-video-play">{loading ? <RefreshCw size={20} className="v2s-spin" /> : <Play size={22} fill="currentColor" />}</span>
        <small>{error ?? (loading ? 'Opening video…' : 'Tap to watch the video')}</small>
      </button>
    </div>
  );
}

export function InlineError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="v2s-inline-error" role="alert">
      <AlertCircle size={17} aria-hidden="true" />
      <span>{message}</span>
      {onRetry && <button type="button" className="btn btn-outline" onClick={onRetry}>Try again</button>}
    </div>
  );
}

export function EmptyState({ icon, title, text, action }: { icon: ReactNode; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="v2s-empty">
      <span className="v2s-empty-icon" aria-hidden="true">{icon}</span>
      <strong>{title}</strong>
      {text && <p>{text}</p>}
      {action}
    </div>
  );
}

/** Lightweight full-screen image viewer. */
export function ImageLightbox({ url, alt, onClose }: { url: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="v2s-lightbox" role="dialog" aria-modal="true" aria-label={alt} onClick={onClose}>
      <img src={url} alt={alt} onClick={event => event.stopPropagation()} />
      <button type="button" className="btn btn-outline v2s-lightbox-close" onClick={onClose}>Close</button>
    </div>
  );
}

/** Bottom sheet on phones, centred dialog on larger screens. */
export function Sheet({ title, onClose, children, wide = false, labelledBy }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; labelledBy?: string }) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = overflow; previous?.focus?.(); };
  }, [onClose]);
  const id = labelledBy ?? `v2s-sheet-${title.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div className="v2s-sheet-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={panelRef} tabIndex={-1} className={`v2s-sheet${wide ? ' is-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={id}>
        <header className="v2s-sheet-header">
          <h2 id={id}>{title}</h2>
          <button type="button" className="v2s-icon-button" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="v2s-sheet-body">{children}</div>
      </div>
    </div>
  );
}

/** Loads the Amiri font once (Arabic text and course/level titles on v2 student pages). */
export function ensureAmiri(): void {
  if (typeof document === 'undefined' || document.getElementById('v2s-amiri-font')) return;
  const link = document.createElement('link');
  link.id = 'v2s-amiri-font';
  link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=Amiri:ital,wght@0,400;0,700;1,400&display=swap';
  document.head.appendChild(link);
}

export const hasArabic = (text: string | null | undefined): boolean => /[؀-ۿ]/.test(text ?? '');
