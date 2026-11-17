import { useEffect, useRef, useState } from 'react';
import { FileText, ImageOff } from 'lucide-react';
import type { Attachment } from '../contracts';
import { isPdf, objectUrl, useFileUrl } from './media';
import { loadPdf, renderPdfPage } from './pdf';

function useVisible<T extends Element>(): [React.RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const io = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) { setVisible(true); io.disconnect(); } }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);
  return [ref, visible];
}

const pdfThumbCache = new Map<string, Promise<string>>();
function pdfThumb(storageKey: string): Promise<string> {
  let p = pdfThumbCache.get(storageKey);
  if (!p) {
    p = (async () => {
      const doc = await loadPdf(await objectUrl(storageKey), storageKey);
      const c = await renderPdfPage(doc, 1, 360);
      return c.toDataURL('image/jpeg', 0.8);
    })();
    pdfThumbCache.set(storageKey, p);
    p.catch(() => pdfThumbCache.delete(storageKey));
  }
  return p;
}

/** Square-ish preview of an attachment (photo or first PDF page). */
export function AttachmentThumb({ att, label, onOpen, className = '' }: { att: Attachment; label?: string | null; onOpen?: () => void; className?: string }) {
  const [ref, visible] = useVisible<HTMLButtonElement>();
  const pdf = isPdf(att);
  const { url: imgUrl, error } = useFileUrl(visible && !pdf ? att.storageKey : null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfFailed, setPdfFailed] = useState(false);
  useEffect(() => {
    if (!visible || !pdf) return;
    let alive = true;
    pdfThumb(att.storageKey).then(u => { if (alive) setPdfUrl(u); }).catch(() => { if (alive) setPdfFailed(true); });
    return () => { alive = false; };
  }, [visible, pdf, att.storageKey]);
  const src = pdf ? pdfUrl : imgUrl;
  return (
    <button ref={ref} type="button" className={`v2-thumb${pdf ? ' is-pdf' : ''} ${className}`} onClick={onOpen} aria-label={`Open ${label ?? att.originalFilename}`}>
      {src ? <img src={src} alt="" loading="lazy" draggable={false} /> : (
        <span className="v2-thumb-ph">{(error || pdfFailed) ? <ImageOff size={20} /> : pdf ? <FileText size={22} /> : null}</span>
      )}
      {pdf && <span className="v2-thumb-tag">PDF</span>}
      {label && <span className="v2-thumb-label">{label}</span>}
    </button>
  );
}

/** Preview of a local File (before upload). */
export function LocalFileThumb({ file, onRemove, label }: { file: File; onRemove?: () => void; label?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const pdf = file.type.includes('pdf') || /\.pdf$/i.test(file.name);
  useEffect(() => {
    let alive = true;
    let made: string | null = null;
    if (pdf) {
      void (async () => {
        try {
          const doc = await loadPdf(await file.arrayBuffer());
          const c = await renderPdfPage(doc, 1, 300);
          if (alive) setUrl(c.toDataURL('image/jpeg', 0.8));
        } catch { /* icon fallback */ }
      })();
    } else {
      made = URL.createObjectURL(file);
      setUrl(made);
    }
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [file, pdf]);
  return (
    <span className={`v2-thumb is-local${pdf ? ' is-pdf' : ''}`}>
      {url ? <img src={url} alt="" draggable={false} /> : <span className="v2-thumb-ph"><FileText size={22} /></span>}
      {pdf && <span className="v2-thumb-tag">PDF</span>}
      {label && <span className="v2-thumb-label">{label}</span>}
      {onRemove && <button type="button" className="v2-thumb-remove" onClick={onRemove} aria-label={`Remove ${file.name}`}>×</button>}
    </span>
  );
}
