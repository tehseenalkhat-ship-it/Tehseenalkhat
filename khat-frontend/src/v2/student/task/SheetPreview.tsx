import { useEffect, useRef, useState } from 'react';
import { FileText, ZoomIn } from 'lucide-react';
import type { StepFile } from '../../contracts';
import { objectUrl, viewUrl } from '../../chat/media';

const isPdfFile = (file: StepFile) => (file.contentType ?? '').includes('pdf') || /\.pdf$/i.test(file.originalFilename || file.canonicalName);

/**
 * Thumbnail of a worksheet / reference (image, or the first page of a PDF).
 * Loads only when it scrolls near the screen. Tap → onOpen(url) for the zoom viewer.
 */
export function SheetPreview({ file, alt, onOpen, tall = false }: { file: StepFile; alt: string; onOpen?: (url: string) => void; tall?: boolean }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [inView, setInView] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || inView) return;
    if (!('IntersectionObserver' in window)) { setInView(true); return; }
    const observer = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) { setInView(true); observer.disconnect(); } }, { rootMargin: '300px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [inView]);

  useEffect(() => {
    if (!inView) return;
    let alive = true;
    (async () => {
      try {
        if (isPdfFile(file)) {
          const { loadPdf, renderPdfPage } = await import('../../chat/pdf');
          const doc = await loadPdf(await objectUrl(file.storageKey), file.storageKey);
          const canvas = await renderPdfPage(doc, 1, 1400);
          if (alive) setUrl(canvas.toDataURL('image/jpeg', 0.86));
        } else {
          const value = await viewUrl(file.storageKey);
          if (alive) setUrl(value);
        }
      } catch { if (alive) setFailed(true); }
    })();
    return () => { alive = false; };
  }, [inView, file]);

  return (
    <button
      ref={ref}
      type="button"
      className={`v3t-thumb${tall ? ' is-tall' : ''}${url ? ' is-ready' : ''}`}
      onClick={() => url && onOpen?.(url)}
      disabled={!url || !onOpen}
      aria-label={`Open ${alt} — you can zoom in`}
    >
      {url
        ? <img src={url} alt={alt} loading="lazy" onError={() => setFailed(true)} />
        : <span className="v3t-thumb-empty"><FileText size={26} aria-hidden="true" /><small>{failed ? 'Preview not available' : 'Loading preview…'}</small></span>}
      {url && onOpen && <span className="v3t-thumb-zoom" aria-hidden="true"><ZoomIn size={16} /> Tap to zoom</span>}
    </button>
  );
}
