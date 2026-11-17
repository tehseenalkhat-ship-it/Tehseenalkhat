import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, Minus, Plus, RefreshCw, RotateCcw, X } from 'lucide-react';

const MIN = 1;
const MAX = 6;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Full-screen image viewer: pinch / wheel / buttons to zoom, drag to move, double-tap to zoom in or out,
 * plus a Download button. Works with finger, Apple Pencil and mouse.
 */
export function ZoomViewer({ url, title, onClose, onDownload, downloading = false, footer }: {
  url: string;
  title: string;
  onClose: () => void;
  onDownload?: () => void;
  downloading?: boolean;
  footer?: React.ReactNode;
}) {
  const [scale, setScale] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; scale: number } | null>(null);
  const lastTap = useRef(0);
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === '+' || event.key === '=') zoomBy(1.4);
      if (event.key === '-') zoomBy(1 / 1.4);
    };
    window.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = overflow; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose]);

  const applyScale = useCallback((next: number) => {
    const value = clamp(next, MIN, MAX);
    setScale(value);
    if (value === 1) setPos({ x: 0, y: 0 });
  }, []);
  const zoomBy = (factor: number) => setScale(current => { const value = clamp(current * factor, MIN, MAX); if (value === 1) setPos({ x: 0, y: 0 }); return value; });
  const reset = () => { setScale(1); setPos({ x: 0, y: 0 }); };

  const onPointerDown = (event: React.PointerEvent) => {
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale };
    } else if (pointers.current.size === 1) {
      const now = Date.now();
      if (now - lastTap.current < 300) { if (scale > 1) reset(); else applyScale(2.5); lastTap.current = 0; }
      else lastTap.current = now;
    }
  };
  const onPointerMove = (event: React.PointerEvent) => {
    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;
    const current = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, current);
    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      applyScale(pinch.current.scale * (Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, pinch.current.dist)));
    } else if (pointers.current.size === 1 && scale > 1) {
      setPos(p => ({ x: p.x + current.x - previous.x, y: p.y + current.y - previous.y }));
    }
  };
  const onPointerUp = (event: React.PointerEvent) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  };

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => { event.preventDefault(); zoomBy(event.deltaY < 0 ? 1.15 : 1 / 1.15); };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, []);

  return createPortal(
    <div className="v3t-zoom" role="dialog" aria-modal="true" aria-label={title}>
      <div className="v3t-zoom-bar">
        <strong className="v3t-zoom-title">{title}</strong>
        <button type="button" className="v3t-zoom-close" onClick={onClose} aria-label="Close"><X size={22} /></button>
      </div>
      <div
        ref={stageRef}
        className={`v3t-zoom-stage${scale > 1 ? ' is-zoomed' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <img src={url} alt={title} draggable={false} style={{ transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})` }} />
      </div>
      <div className="v3t-zoom-tools">
        <div className="v3t-zoom-group" role="group" aria-label="Zoom">
          <button type="button" onClick={() => zoomBy(1 / 1.4)} disabled={scale <= MIN} aria-label="Zoom out"><Minus size={20} /></button>
          <span className="v3t-zoom-level" aria-live="polite">{Math.round(scale * 100)}%</span>
          <button type="button" onClick={() => zoomBy(1.4)} disabled={scale >= MAX} aria-label="Zoom in"><Plus size={20} /></button>
          <button type="button" onClick={reset} disabled={scale === 1} aria-label="Fit to screen"><RotateCcw size={18} /></button>
        </div>
        {onDownload && (
          <button type="button" className="btn btn-outline v3t-zoom-download" onClick={onDownload} disabled={downloading}>
            {downloading ? <RefreshCw size={17} className="v2s-spin" /> : <Download size={17} />} {downloading ? 'Preparing…' : 'Download'}
          </button>
        )}
        {footer}
      </div>
      <p className="v3t-zoom-hint">Pinch or use + and − to zoom · drag to move · double-tap to zoom in</p>
    </div>,
    document.body,
  );
}
