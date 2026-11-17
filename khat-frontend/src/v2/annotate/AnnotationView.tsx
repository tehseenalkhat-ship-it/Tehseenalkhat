import { useEffect, useRef, useState } from 'react';
import { Loader2, MessageSquare, Mic, X, ZoomIn, ZoomOut } from 'lucide-react';
import type { Annotation, AnnotationPin, Attachment } from '../contracts';
import { objectUrl, useFileUrl } from '../chat/media';
import { loadImage } from '../chat/pdf';
import { VoicePlayer } from '../chat/VoicePlayer';
import { drawAll } from './draw';
import { loadPageBitmap } from './pages';
import { usePinchViewer } from './panzoom';
import './annotate.css';

function guessAttachment(storageKey: string, files: Attachment[]): Attachment {
  return files.find(f => f.storageKey === storageKey) ?? {
    storageKey,
    originalFilename: storageKey.split('/').pop() ?? 'sheet.jpg',
    contentType: /\.pdf$/i.test(storageKey) ? 'application/pdf' : 'image/jpeg',
  };
}

/** Bitmap of an annotation: the flattened image if saved, else the page with strokes drawn on it. */
async function annotationBitmap(a: Annotation, files: Attachment[]): Promise<HTMLCanvasElement> {
  if (a.flattenedStorageKey) {
    try {
      const img = await loadImage(await objectUrl(a.flattenedStorageKey));
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d')?.drawImage(img, 0, 0);
      return c;
    } catch { /* fall back to vectors */ }
  }
  const bmp = await loadPageBitmap(guessAttachment(a.fileStorageKey, files), a.pageIndex);
  const c = document.createElement('canvas');
  c.width = bmp.w; c.height = bmp.h;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(bmp.canvas, 0, 0);
  drawAll(ctx, a.strokes, a.pins, bmp.w, bmp.h);
  return c;
}

/** Thumbnail for the thread: corrected sheet + count of notes. */
export function AnnotationThumb({ annotation, onOpen }: { annotation: Annotation; onOpen: () => void }) {
  const { url } = useFileUrl(annotation.flattenedStorageKey);
  const voiceCount = annotation.pins.filter(p => p.voiceStorageKey).length;
  return (
    <button type="button" className="v2-annthumb" onClick={onOpen} aria-label={`Open corrected sheet with ${annotation.pins.length} notes`}>
      {url ? <img src={url} alt="" loading="lazy" /> : <span className="v2-annthumb-ph"><MessageSquare size={22} /></span>}
      {annotation.pins.length > 0 && (
        <span className="v2-annthumb-badge">{voiceCount > 0 && <Mic size={11} />}{annotation.pins.length} note{annotation.pins.length === 1 ? '' : 's'}</span>
      )}
    </button>
  );
}

/** Full-screen corrected sheet. Tap a numbered pin to hear / read the teacher's note for that spot. */
export function AnnotationView({ annotations, startIndex = 0, files = [], onClose }: { annotations: Annotation[]; startIndex?: number; files?: Attachment[]; onClose: () => void }) {
  const [index, setIndex] = useState(startIndex);
  const a = annotations[index];
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [error, setError] = useState(false);
  const [active, setActive] = useState<AnnotationPin | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewer = usePinchViewer(natural);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { closeRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') setIndex(i => Math.min(annotations.length - 1, i + 1));
      if (e.key === 'ArrowLeft') setIndex(i => Math.max(0, i - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [annotations.length, onClose]);

  useEffect(() => {
    if (!a) return;
    let alive = true;
    setNatural(null); setError(false); setActive(null);
    annotationBitmap(a, files).then(c => {
      if (!alive) return;
      const target = canvasRef.current;
      if (target) {
        target.width = c.width; target.height = c.height;
        target.getContext('2d')?.drawImage(c, 0, 0);
      }
      setNatural({ w: c.width, h: c.height });
    }).catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, [a, files]);

  if (!a) return null;
  const sortedPins = [...a.pins].sort((x, y) => x.n - y.n);
  return (
    <div className="v2-viewer" role="dialog" aria-modal="true" aria-label="Corrected sheet">
      <header className="v2-viewer-bar">
        <strong>Corrected sheet{annotations.length > 1 ? ` · ${index + 1} of ${annotations.length}` : ''}</strong>
        <span className="v2-viewer-spacer" />
        <button type="button" onClick={viewer.zoomOut} aria-label="Zoom out"><ZoomOut size={18} /></button>
        <button type="button" onClick={viewer.zoomIn} aria-label="Zoom in"><ZoomIn size={18} /></button>
        <button type="button" ref={closeRef} onClick={onClose} aria-label="Close"><X size={20} /></button>
      </header>
      <div className="v2-viewer-stage" ref={viewer.viewportRef} {...viewer.handlers}>
        {!natural && <div className="v2-viewer-loading">{error ? 'This sheet could not be opened.' : <Loader2 size={22} className="v2-spin" />}</div>}
        <div className="v2-viewer-layer" ref={viewer.layerRef} style={{ width: viewer.box.w, height: viewer.box.h }}>
          <canvas ref={canvasRef} className="v2-ann-canvas" />
          {natural && sortedPins.map(p => (
            <button
              key={p.n}
              type="button"
              className={`v2-ann-pin is-view${active?.n === p.n ? ' is-editing' : ''}${p.voiceStorageKey ? ' has-voice' : ''}`}
              style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
              onPointerDown={e => e.stopPropagation()}
              onClick={() => setActive(p)}
              aria-label={`Note ${p.n}${p.voiceStorageKey ? ', play voice note' : ''}`}
            >{p.n}</button>
          ))}
        </div>
        {annotations.length > 1 && (
          <div className="v2-viewer-nav">
            <button type="button" disabled={index === 0} onClick={() => setIndex(i => i - 1)} aria-label="Previous sheet">‹</button>
            <button type="button" disabled={index === annotations.length - 1} onClick={() => setIndex(i => i + 1)} aria-label="Next sheet">›</button>
          </div>
        )}
      </div>
      <footer className="v2-viewer-notes">
        {active ? (
          <div className="v2-viewer-note" aria-live="polite">
            <span className="v2-pin-badge">{active.n}</span>
            <div>
              {active.voiceStorageKey && <VoicePlayer key={active.n} storageKey={active.voiceStorageKey} durationSec={active.durationSec} label={`note ${active.n}`} autoPlay />}
              {active.text && <p>{active.text}</p>}
              {!active.voiceStorageKey && !active.text && <p className="muted">Look at this spot on your sheet.</p>}
            </div>
          </div>
        ) : sortedPins.length ? (
          <div className="v2-viewer-pinlist">
            <span className="muted">Tap a number to hear your teacher:</span>
            {sortedPins.map(p => <button key={p.n} type="button" className="v2-pin-badge is-button" onClick={() => setActive(p)} aria-label={`Note ${p.n}`}>{p.n}</button>)}
          </div>
        ) : <span className="muted">Pinch or double-tap to zoom.</span>}
      </footer>
    </div>
  );
}
