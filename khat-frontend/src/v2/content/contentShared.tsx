import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Download, ExternalLink, Minus, Plus, X } from 'lucide-react';
import { getDownloadUrl, getViewUrl } from '@/api';
import './content-v3.css';

/** Resolves storage keys to view URLs (cached per page). */
export function useViewUrls(keys: (string | null | undefined)[]): Record<string, string> {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const signature = keys.filter(Boolean).join('|');
  useEffect(() => {
    let cancelled = false;
    const missing = Array.from(new Set(keys.filter((k): k is string => !!k && !urls[k])));
    if (!missing.length) return;
    void Promise.all(missing.map(async k => { try { return [k, await getViewUrl(k)] as const; } catch { return null; } }))
      .then(list => { if (!cancelled) setUrls(prev => ({ ...prev, ...Object.fromEntries(list.filter((x): x is readonly [string, string] => !!x)) })); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  return urls;
}

/** Same rules as the backend (contentLogic.ts youTubeId). */
export function youTubeId(input: string | null | undefined): string | null {
  if (!input) return null;
  const raw = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw;
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    const host = url.hostname.toLowerCase().replace(/^www\.|^m\.|^music\./, '');
    let id: string | null = null;
    if (host === 'youtu.be') id = url.pathname.split('/')[1] ?? null;
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      id = url.pathname === '/watch' ? url.searchParams.get('v') : url.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?#]+)/)?.[1] ?? null;
    }
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  } catch { return null; }
}

export function effortLabel(minutes: number | null | undefined): string | null {
  if (!minutes || minutes < 1) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  if (!m) return h === 1 ? '1 hour' : `${h} hours`;
  return `${h} h ${m} min`;
}

export function cleanLabel(label: string | null | undefined): string | null {
  if (!label) return null;
  return /^selected for decoration$/i.test(label.trim()) ? 'Selected' : label;
}

export async function downloadStorageKey(storageKey: string, filename: string): Promise<void> {
  const url = await getDownloadUrl(storageKey, filename);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.target = '_blank';
  link.rel = 'noreferrer';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/** A full-screen layer (closes on backdrop tap and Escape). */
export function V3Layer({ children, onClose, label, wide = false }: { children: ReactNode; onClose: () => void; label: string; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);
  return (
    <div className="v3c-layer" role="dialog" aria-modal="true" aria-label={label} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`v3c-layer-box${wide ? ' is-wide' : ''}`}>
        <button type="button" className="v3c-layer-close" onClick={onClose} aria-label="Close"><X size={20} /></button>
        {children}
      </div>
    </div>
  );
}

/** YouTube-style player window, played on the site (privacy-enhanced embed). */
export function V3YouTubePlayer({ videoId, title, subtitle, description, onClose }: { videoId: string; title: string; subtitle?: string; description?: string | null; onClose: () => void }) {
  return (
    <V3Layer onClose={onClose} label={title} wide>
      <div className="v3c-yt">
        <div className="v3c-yt-frame">
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&rel=0&modestbranding=1&playsinline=1`}
            title={title}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
          />
        </div>
        <div className="v3c-yt-meta">
          <h2>{title}</h2>
          {subtitle && <small>{subtitle}</small>}
          {description && <p>{description}</p>}
          <a className="v3c-ghost-btn" href={`https://www.youtube.com/watch?v=${videoId}`} target="_blank" rel="noreferrer"><ExternalLink size={15} /> Open on YouTube</a>
        </div>
      </div>
    </V3Layer>
  );
}

/** Image viewer: open, zoom in / out (buttons, pinch, wheel), download. */
export function V3ImageViewer({ src, title, caption, storageKey, onClose }: { src: string; title: string; caption?: ReactNode; storageKey?: string; onClose: () => void }) {
  const [zoom, setZoom] = useState(1);
  const pinch = useRef<{ d: number; z: number } | null>(null);
  const clamp = (z: number) => Math.min(4, Math.max(1, Math.round(z * 100) / 100));
  return (
    <V3Layer onClose={onClose} label={title} wide>
      <div className="v3c-viewer">
        <div
          className="v3c-viewer-stage"
          onWheel={e => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); setZoom(z => clamp(z - e.deltaY / 300)); } }}
          onTouchStart={e => { if (e.touches.length === 2) pinch.current = { d: Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY), z: zoom }; }}
          onTouchMove={e => { if (e.touches.length === 2 && pinch.current) { const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); setZoom(clamp(pinch.current.z * d / pinch.current.d)); } }}
          onTouchEnd={() => { pinch.current = null; }}
        >
          <img src={src} alt={title} style={{ width: `${zoom * 100}%` }} />
        </div>
        <div className="v3c-viewer-bar">
          <div className="v3c-viewer-title"><strong>{title}</strong>{caption && <small>{caption}</small>}</div>
          <div className="v3c-viewer-tools">
            <button type="button" className="v3c-icon-btn" onClick={() => setZoom(z => clamp(z - 0.5))} disabled={zoom <= 1} aria-label="Zoom out"><Minus size={17} /></button>
            <span className="v3c-zoom-value">{Math.round(zoom * 100)}%</span>
            <button type="button" className="v3c-icon-btn" onClick={() => setZoom(z => clamp(z + 0.5))} disabled={zoom >= 4} aria-label="Zoom in"><Plus size={17} /></button>
            {storageKey && <button type="button" className="v3c-ghost-btn" onClick={() => void downloadStorageKey(storageKey, `${title.replace(/[\\/:*?"<>|]/g, '_')}.jpg`)}><Download size={15} /> Download</button>}
          </div>
        </div>
      </div>
    </V3Layer>
  );
}

/** Segmented tabs (sharp, outline). */
export function V3Tabs<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string; icon?: ReactNode }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="v3c-tabs" role="tablist" aria-label={label}>
      {options.map(o => (
        <button key={o.value} type="button" role="tab" aria-selected={value === o.value} className={value === o.value ? 'is-active' : ''} onClick={() => onChange(o.value)}>{o.icon}{o.label}</button>
      ))}
    </div>
  );
}
