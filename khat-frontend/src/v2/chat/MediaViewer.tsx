import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Loader2, PenLine, X, ZoomIn, ZoomOut } from 'lucide-react';
import { Document, Page } from 'react-pdf';
import type { Attachment } from '../contracts';
import { usePinchViewer } from '../annotate/panzoom';
import { isPdf, objectUrl, useFileUrl } from './media';
import './pdf';

function ImageStage({ att }: { att: Attachment }) {
  const { url, error } = useFileUrl(att.storageKey);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const viewer = usePinchViewer(natural);
  useEffect(() => setNatural(null), [att.storageKey]);
  return (
    <>
      <div className="v2-viewer-stage" ref={viewer.viewportRef} {...viewer.handlers}>
        {!natural && <div className="v2-viewer-loading">{error ? 'This photo could not be opened.' : <Loader2 size={22} className="v2-spin" />}</div>}
        <div className="v2-viewer-layer" ref={viewer.layerRef} style={{ width: viewer.box.w, height: viewer.box.h }}>
          {url && <img src={url} alt={att.originalFilename} draggable={false} onLoad={e => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />}
        </div>
      </div>
      <div className="v2-viewer-zoombar">
        <button type="button" onClick={viewer.zoomOut} aria-label="Zoom out"><ZoomOut size={18} /></button>
        <button type="button" onClick={viewer.zoomIn} aria-label="Zoom in"><ZoomIn size={18} /></button>
      </div>
    </>
  );
}

function PdfStage({ att }: { att: Attachment }) {
  const [url, setUrl] = useState<string | null>(null);
  const [pages, setPages] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(600);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { let alive = true; void objectUrl(att.storageKey).then(u => { if (alive) setUrl(u); }); return () => { alive = false; }; }, [att.storageKey]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.min(1100, el.clientWidth - 24)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <>
      <div className="v2-viewer-pdf" ref={ref}>
        {url ? (
          <Document file={url} onLoadSuccess={d => setPages(d.numPages)} loading={<div className="v2-viewer-loading"><Loader2 size={22} className="v2-spin" /></div>} error={<div className="v2-viewer-loading">This PDF could not be opened.</div>}>
            {Array.from({ length: pages }, (_, i) => <Page key={i} pageNumber={i + 1} width={width * zoom} renderTextLayer={false} renderAnnotationLayer={false} className="v2-viewer-pdfpage" />)}
          </Document>
        ) : <div className="v2-viewer-loading"><Loader2 size={22} className="v2-spin" /></div>}
      </div>
      <div className="v2-viewer-zoombar">
        <button type="button" onClick={() => setZoom(z => Math.max(0.6, z / 1.25))} aria-label="Zoom out"><ZoomOut size={18} /></button>
        <button type="button" onClick={() => setZoom(z => Math.min(4, z * 1.25))} aria-label="Zoom in"><ZoomIn size={18} /></button>
      </div>
    </>
  );
}

/** Full-screen viewer for photos (pinch / double-tap zoom) and PDFs. Swipe arrows between files. */
export function MediaViewer({ items, startIndex = 0, onClose, caption, onAnnotate, annotateLabel = 'Draw on it' }: { items: Attachment[]; startIndex?: number; onClose: () => void; caption?: (a: Attachment, i: number) => string; onAnnotate?: ((att: Attachment) => void) | null; annotateLabel?: string }) {
  const [index, setIndex] = useState(startIndex);
  const att = items[index];
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') setIndex(i => Math.min(items.length - 1, i + 1));
      if (e.key === 'ArrowLeft') setIndex(i => Math.max(0, i - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [items.length, onClose]);
  if (!att) return null;
  const download = async () => {
    const u = await objectUrl(att.storageKey);
    const a = document.createElement('a');
    a.href = u; a.download = att.originalFilename; a.click();
  };
  return (
    <div className="v2-viewer" role="dialog" aria-modal="true" aria-label={att.originalFilename}>
      <header className="v2-viewer-bar">
        <strong>{caption ? caption(att, index) : att.originalFilename}{items.length > 1 ? ` · ${index + 1} of ${items.length}` : ''}</strong>
        <span className="v2-viewer-spacer" />
        {onAnnotate && <button type="button" className="v3ch-viewer-draw" onClick={() => onAnnotate(att)}><PenLine size={17} /> <span>{annotateLabel}</span></button>}
        <button type="button" onClick={() => void download()} aria-label="Download"><Download size={18} /></button>
        <button type="button" ref={closeRef} onClick={onClose} aria-label="Close"><X size={20} /></button>
      </header>
      {isPdf(att) ? <PdfStage key={att.storageKey} att={att} /> : <ImageStage key={att.storageKey} att={att} />}
      {items.length > 1 && (
        <div className="v2-viewer-nav">
          <button type="button" disabled={index === 0} onClick={() => setIndex(i => i - 1)} aria-label="Previous"><ChevronLeft size={22} /></button>
          <button type="button" disabled={index === items.length - 1} onClick={() => setIndex(i => i + 1)} aria-label="Next"><ChevronRight size={22} /></button>
        </div>
      )}
    </div>
  );
}
