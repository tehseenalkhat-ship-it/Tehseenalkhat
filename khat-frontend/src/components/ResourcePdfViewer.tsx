import { useEffect, useRef, useState } from 'react';
import { BookOpen, ChevronLeft, ChevronRight, Download, ExternalLink, FileText, X, ZoomIn, ZoomOut } from 'lucide-react';
import { Document, Page, pdfjs } from 'react-pdf';
import { getFileObjectUrl, getViewUrl } from '@/api';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export type ResourceBook = { id: string; title: string; khat_type_id: string | null; file_storage_key: string; original_filename?: string | null };

export function ResourceBookCover({ book }: { book: ResourceBook }) {
  const coverRef = useRef<HTMLDivElement>(null);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const isPdf = (book.original_filename ?? book.file_storage_key).toLowerCase().endsWith('.pdf');

  useEffect(() => {
    const node = coverRef.current;
    if (!node || visible) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: '280px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const load = async () => {
      try {
        const resolved = isPdf ? await getFileObjectUrl(book.file_storage_key) : await getViewUrl(book.file_storage_key);
        if (cancelled) {
          if (resolved.startsWith('blob:')) URL.revokeObjectURL(resolved);
        } else setFileUrl(resolved);
      } catch {
        if (!cancelled) setLoadFailed(true);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [visible, book.file_storage_key, isPdf]);

  useEffect(() => () => {
    if (fileUrl?.startsWith('blob:')) URL.revokeObjectURL(fileUrl);
  }, [fileUrl]);

  return (
    <div className={`book-cover resource-book-cover${loadFailed ? ' is-fallback' : ''}`} ref={coverRef}>
      {fileUrl && !loadFailed ? (isPdf ? (
        <Document file={fileUrl} loading={<span className="resource-cover-placeholder"><span className="resource-cover-sheen" /></span>} error={<span className="resource-cover-placeholder"><FileText size={24} /></span>} onLoadError={() => setLoadFailed(true)}>
          <Page pageNumber={1} width={320} renderTextLayer={false} renderAnnotationLayer={false} onRenderError={() => setLoadFailed(true)} />
        </Document>
      ) : <img className="resource-cover-image" src={fileUrl} alt={`${book.title} cover`} onError={() => setLoadFailed(true)} loading="lazy" />) : (
        <div className="resource-cover-placeholder"><BookOpen size={25} /><span>{book.title}</span></div>
      )}
    </div>
  );
}

export default function ResourcePdfViewer({ book, url, onClose }: { book: ResourceBook; url: string; onClose: () => void }) {
  const [pageCount, setPageCount] = useState(0);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [stageWidth, setStageWidth] = useState(900);
  const [turning, setTurning] = useState<{ direction: 'forward' | 'backward'; targetPage: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const turnTimerRef = useRef<number | null>(null);
  const isSpread = stageWidth >= 900;
  const isPdf = (book.original_filename ?? book.file_storage_key).toLowerCase().endsWith('.pdf');
  const pageStep = isSpread ? 2 : 1;
  const maxPage = Math.max(1, pageCount);
  const spreadStart = isSpread ? Math.floor((page - 1) / 2) * 2 + 1 : page;
  const renderedPageWidth = Math.max(240, ((stageWidth - (isSpread ? 100 : 48)) / (isSpread ? 2 : 1)) * zoom);
  const downloadName = book.title.replace(/[\\/:*?"<>|]/g, '_') + '.pdf';

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width;
      if (width) setStageWidth(width);
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => {
    if (turnTimerRef.current !== null) window.clearTimeout(turnTimerRef.current);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowRight') goToPage(page + pageStep);
      if (event.key === 'ArrowLeft') goToPage(page - pageStep);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [page, pageStep, maxPage, onClose, turning, isSpread]);

  const goToPage = (target: number) => {
    if (turning) return;
    const boundedPage = Math.max(1, Math.min(maxPage, target));
    if (boundedPage === page) return;
    if (!isSpread) {
      setTurning({ direction: boundedPage > page ? 'forward' : 'backward', targetPage: boundedPage });
      turnTimerRef.current = window.setTimeout(() => {
        setPage(boundedPage);
        setTurning(null);
        turnTimerRef.current = null;
      }, 520);
      return;
    }
    setTurning({ direction: boundedPage > page ? 'forward' : 'backward', targetPage: boundedPage });
    turnTimerRef.current = window.setTimeout(() => {
      setPage(boundedPage);
      setTurning(null);
      turnTimerRef.current = null;
    }, 680);
  };
  const goPrevious = () => goToPage(page - pageStep);
  const goNext = () => goToPage(page + pageStep);

  return (
    <div className="resource-reader" role="dialog" aria-modal="true" aria-label={`Read ${book.title}`}>
      <header className="resource-reader-toolbar">
        <button className="resource-reader-close" type="button" onClick={onClose} aria-label="Close reader"><X size={19} /></button>
        <div className="resource-reader-title"><span>Resource library</span><strong>{book.title}</strong></div>
        <div className="resource-reader-tools">
          <span className="resource-reader-page-label">{pageCount ? `${spreadStart}${isSpread && spreadStart < pageCount ? `–${spreadStart + 1}` : ''} / ${pageCount}` : 'Loading PDF'}</span>
          <div className="resource-reader-divider" />
          <button type="button" onClick={() => setZoom(value => Math.max(.5, Math.round((value - .1) * 10) / 10))} disabled={zoom <= .5} aria-label="Zoom out" title="Zoom out"><ZoomOut size={17} /></button>
          <span className="resource-reader-zoom">{Math.round(zoom * 100)}%</span>
          <button type="button" onClick={() => setZoom(value => Math.min(2.5, Math.round((value + .1) * 10) / 10))} disabled={zoom >= 2.5} aria-label="Zoom in" title="Zoom in"><ZoomIn size={17} /></button>
          <a href={url} download={downloadName} aria-label="Download PDF"><Download size={17} /></a>
        </div>
      </header>
      <div className="resource-reader-stage" ref={stageRef}>
        <button className="resource-reader-nav previous" type="button" onClick={goPrevious} disabled={page <= 1} aria-label="Previous pages"><ChevronLeft size={23} /></button>
        <div className="resource-reader-canvas">
          <div className="resource-reader-aligner">
          {!isPdf ? <img className="resource-reader-image" src={url} alt={book.title} /> :
            <Document
              file={url}
              onLoadSuccess={({ numPages }) => { setPageCount(numPages); setPage(1); setError(null); }}
              onLoadError={loadError => setError(loadError.message || 'This PDF could not be opened.')}
              loading={<div className="resource-reader-message"><span className="resource-reader-spinner" /><strong>Preparing your book</strong><small>Loading pages securely…</small></div>}
              error={<div className="resource-reader-message resource-reader-error"><FileText size={27} /><strong>Unable to open this PDF</strong><small>{error ?? 'Check your connection and try again.'}</small><a href={url} target="_blank" rel="noreferrer">Open PDF in a new tab <ExternalLink size={13} /></a></div>}
            >
              {pageCount > 0 && (turning && isSpread ? (() => {
                const targetStart = Math.floor((turning.targetPage - 1) / 2) * 2 + 1;
                const forward = turning.direction === 'forward';
                const hingePage = forward ? spreadStart + 1 : spreadStart;
                const reversePage = forward ? targetStart : targetStart + 1;
                const underneathLeft = forward ? spreadStart : targetStart;
                const underneathRight = forward ? targetStart + 1 : spreadStart + 1;
                return <div className={`resource-reader-book is-spread is-book-turning turn-${turning.direction}`}>
                  <div className="resource-reader-underlay">
                    {underneathLeft <= pageCount ? <Page pageNumber={underneathLeft} width={renderedPageWidth} renderTextLayer={false} renderAnnotationLayer={false} /> : <span />}
                    {underneathRight <= pageCount ? <Page pageNumber={underneathRight} width={renderedPageWidth} renderTextLayer={false} renderAnnotationLayer={false} /> : <span />}
                  </div>
                  <div className={`resource-reader-turn-leaf turn-${turning.direction}`}>
                    <div className="resource-reader-turn-face front"><Page pageNumber={hingePage} width={renderedPageWidth} renderTextLayer={false} renderAnnotationLayer={false} /></div>
                    <div className="resource-reader-turn-face back"><Page pageNumber={reversePage} width={renderedPageWidth} renderTextLayer={false} renderAnnotationLayer={false} /></div>
                  </div>
                </div>;
              })() : <div key={spreadStart} className={`resource-reader-spread${isSpread ? ' is-spread' : ''}${turning ? ` resource-reader-single-turn turn-${turning.direction}` : ''}`}>
                <Page pageNumber={spreadStart} width={renderedPageWidth} renderTextLayer renderAnnotationLayer />
                {isSpread && spreadStart + 1 <= pageCount && <Page pageNumber={spreadStart + 1} width={renderedPageWidth} renderTextLayer renderAnnotationLayer />}
              </div>)}
            </Document>}
          </div>
        </div>
        <button className="resource-reader-nav next" type="button" onClick={goNext} disabled={!pageCount || spreadStart + pageStep > pageCount} aria-label="Next pages"><ChevronRight size={23} /></button>
      </div>
      {isPdf && <footer className="resource-reader-footer">
        <button type="button" onClick={goPrevious} disabled={page <= 1}><ChevronLeft size={16} /><span>Previous</span></button>
        <div className="resource-reader-scrubber"><input type="range" min="1" max={Math.max(1, pageCount)} step={pageStep} value={Math.min(page, Math.max(1, pageCount))} onChange={event => goToPage(Number(event.target.value))} disabled={!pageCount} aria-label="Go to PDF page" /><span className="resource-reader-page-count">Page {pageCount ? `${spreadStart}${isSpread && spreadStart < pageCount ? `–${spreadStart + 1}` : ''} of ${pageCount}` : '—'}</span></div>
        <button type="button" onClick={goNext} disabled={!pageCount || spreadStart + pageStep > pageCount}><span>Next</span><ChevronRight size={16} /></button>
      </footer>}
    </div>
  );
}
