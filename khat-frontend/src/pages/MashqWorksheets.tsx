import { useEffect, useMemo, useRef, useState } from 'react';
import { PDFDocument } from 'pdf-lib';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import JSZip from 'jszip';
import { Document, Page, pdfjs } from 'react-pdf';
import { ArrowLeft, Download, FileText, LoaderCircle, X } from 'lucide-react';
import { apiFetch, ApiError, getFileObjectUrl } from '@/api';
import { navigate } from '@/components/ui';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

type SheetSize = '1mm' | '2mm' | '3mm';
type SheetMedia = { kind: 'pdf' | 'image' | 'video'; storageKey: string; originalFilename?: string };
type MashqLevel = { id: string; order_index: number; title: string; media: SheetMedia[]; sheet_files: Partial<Record<SheetSize, { storageKey: string; originalFilename?: string }>> };
type MashqCourse = { id: string; khat_type_id: string; category: string; title: string; description?: string };
type KhatType = { id: string; code: string; display_name: string };
type WorksheetGroupMeta = { key: string; number: string; category: string; title: string; year?: string; firstLevel: number; levelCount: number };
type ReadyPdf = { key: string; name: string; url: string; bytes: Uint8Array; pageCount: number };
type WorksheetPage = { id: string; label: string; pdf: ReadyPdf; pageNumber: number; displayPage: number };

const GROUPS: WorksheetGroupMeta[] = [
  { key: 'qs', number: '5.1', category: 'Al-Qasāʾid al-Sharīfa', title: 'Hubbi Lakum', year: '1445H', firstLevel: 0, levelCount: 2 },
  { key: 'ms', number: '5.2', category: 'Munājāt Sharīfa', title: 'ʿAbduka Rabbi', year: '1447H', firstLevel: 2, levelCount: 2 },
  { key: 'rh', number: '5.3', category: 'Rawḍat al-Hidāyāt', title: 'Rawḍat al-Hidāyāt', year: '', firstLevel: 4, levelCount: 1 },
];
const FILTER_KEY = 'khat_mashq_filter';

function filenameSafe(value: string): string {
  return value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim();
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function extractPage(pdf: ReadyPdf, pageNumber: number): Promise<Blob> {
  return PDFDocument.load(pdf.bytes).then(async source => {
    if (pageNumber < 1 || pageNumber > source.getPageCount()) throw new Error('This worksheet page is no longer available. Refresh and try again.');
    const output = await PDFDocument.create();
    const [page] = await output.copyPages(source, [pageNumber - 1]);
    output.addPage(page);
    return new Blob([await output.save()], { type: 'application/pdf' });
  });
}

function PagePreview({ worksheet, setNumber, onDownload }: { worksheet: WorksheetPage; setNumber: string; onDownload: (trigger: HTMLButtonElement) => void }) {
  const handlePdfLoad = (document: PDFDocumentProxy) => {
    if (worksheet.pageNumber > document.numPages) return;
  };
  return (
    <article className="mashq-sheet-card">
      <div className="mashq-sheet-preview" aria-label={`${worksheet.label} preview`}>
        <Document file={worksheet.pdf.url} onLoadSuccess={handlePdfLoad} loading={<div className="mashq-sheet-loading"><LoaderCircle size={20} className="mashq-spin" /><span>Loading preview…</span></div>} error={<div className="mashq-sheet-loading mashq-sheet-preview-error"><FileText size={22} /><span>Preview unavailable</span></div>}>
          <Page pageNumber={worksheet.pageNumber} width={190} renderTextLayer={false} renderAnnotationLayer={false} loading={<div className="mashq-sheet-loading"><LoaderCircle size={20} className="mashq-spin" /></div>} />
        </Document>
        <span className="mashq-preview-page">Page {worksheet.displayPage}</span>
      </div>
      <div className="mashq-sheet-caption"><span>{setNumber} {worksheet.label}</span><button type="button" className="mashq-download-button" onClick={event => onDownload(event.currentTarget)}><Download size={13} /> Download</button></div>
    </article>
  );
}

export function MashqWorksheets() {
  const [khatType, setKhatType] = useState<KhatType | null>(null);
  const [levels, setLevels] = useState<MashqLevel[]>([]);
  const [pdfsByLevel, setPdfsByLevel] = useState<Record<string, ReadyPdf[]>>({});
  const [filter, setFilter] = useState(() => {
    const requested = window.sessionStorage.getItem(FILTER_KEY) ?? 'all';
    return ['all', ...GROUPS.map(group => group.key)].includes(requested) ? requested : 'all';
  });
  const [loading, setLoading] = useState(true);
  const [assetLoading, setAssetLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<{ label: string; kind: 'page'; worksheet: WorksheetPage } | { label: string; kind: 'set'; group: WorksheetGroupMeta; pages: WorksheetPage[] } | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const lastDownloadTriggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const urlsToRevoke: string[] = [];
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const types = await apiFetch<KhatType[]>('/khat-types');
        const naskh = types.find(type => type.code === 'naskh');
        if (!naskh) throw new Error('Naskh worksheet data is not available yet.');
        const courses = await apiFetch<MashqCourse[]>(`/courses?khatTypeId=${naskh.id}&category=secondary`);
        const worksheetCourse = courses.find(item => /mashq|worksheet/i.test(item.title));
        if (!worksheetCourse) throw new Error('The Naskh Mashq worksheet collection is not set up yet.');
        const courseLevels = await apiFetch<MashqLevel[]>(`/courses/${worksheetCourse.id}/levels`);
        if (cancelled) return;
        setKhatType(naskh);
        setLevels(courseLevels);
        setAssetLoading(true);
        const rows = await Promise.all(courseLevels.map(async level => {
          const pdfFiles = (level.media ?? []).filter(media => media.kind === 'pdf');
          const loaded = await Promise.all(pdfFiles.map(async (media, mediaIndex) => {
            try {
              const url = await getFileObjectUrl(media.storageKey);
              urlsToRevoke.push(url);
              const response = await fetch(url);
              if (!response.ok) throw new Error('Could not read worksheet PDF.');
              const bytes = new Uint8Array(await response.arrayBuffer());
              const document = await PDFDocument.load(bytes);
              return { key: `${level.id}:${mediaIndex}`, name: media.originalFilename ?? `worksheet-${level.order_index + 1}-${mediaIndex + 1}.pdf`, url, bytes, pageCount: document.getPageCount() } satisfies ReadyPdf;
            } catch (loadError) {
              console.error('Could not load a Mashq worksheet PDF:', loadError);
              return null;
            }
          }));
          return [level.id, loaded.filter((item): item is ReadyPdf => item !== null)] as const;
        }));
        if (!cancelled) {
          setPdfsByLevel(Object.fromEntries(rows));
        }
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof ApiError ? loadError.message : loadError instanceof Error ? loadError.message : 'Could not load Mashq worksheets.');
      } finally {
        if (!cancelled) {
          setLoading(false);
          setAssetLoading(false);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
      urlsToRevoke.forEach(url => URL.revokeObjectURL(url));
    };
  }, []);

  const selectedGroups = useMemo(() => GROUPS.filter(group => filter === 'all' || group.key === filter), [filter]);
  const pagesForGroup = (group: WorksheetGroupMeta): WorksheetPage[] => {
    const sourcePages = levels
      .filter(level => level.order_index >= group.firstLevel && level.order_index < group.firstLevel + group.levelCount)
      .flatMap(level => (pdfsByLevel[level.id] ?? []).flatMap(pdf => Array.from({ length: pdf.pageCount }, (_, index) => ({ pdf, pageNumber: index + 1 }))));
    return sourcePages.map((page, index) => ({
      id: `${page.pdf.key}:${page.pageNumber}`,
      label: `${group.title} · Page ${index + 1}`,
      pdf: page.pdf,
      pageNumber: page.pageNumber,
      displayPage: index + 1,
    }));
  };

  useEffect(() => {
    if (!confirmTarget) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !downloading) setConfirmTarget(null); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [confirmTarget, downloading]);

  useEffect(() => {
    if (confirmTarget) confirmButtonRef.current?.focus();
    else {
      lastDownloadTriggerRef.current?.focus();
      lastDownloadTriggerRef.current = null;
    }
  }, [confirmTarget]);

  const startDownload = async () => {
    if (!confirmTarget || downloading) return;
    const target = confirmTarget;
    setDownloading(true);
    setDownloadError(null);
    try {
      if (target.kind === 'page') {
        const blob = await extractPage(target.worksheet.pdf, target.worksheet.pageNumber);
        triggerDownload(blob, `${filenameSafe(target.label)}.pdf`);
      } else {
        const zip = new JSZip();
        const added = new Set<string>();
        for (const page of target.pages) {
          if (added.has(page.pdf.key)) continue;
          added.add(page.pdf.key);
          zip.file(filenameSafe(page.pdf.name), page.pdf.bytes);
        }
        if (added.size === 0) throw new Error('There are no worksheet files to download for this set.');
        const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
        triggerDownload(zipBlob, `${filenameSafe(target.group.number + ' ' + target.group.title)} - all sheets.zip`);
      }
      setConfirmTarget(null);
    } catch (downloadFailure) {
      setDownloadError(downloadFailure instanceof Error ? downloadFailure.message : 'The download could not be prepared. Please try again.');
    } finally {
      setDownloading(false);
    }
  };

  const changeFilter = (nextFilter: string) => {
    setFilter(nextFilter);
    window.sessionStorage.setItem(FILTER_KEY, nextFilter);
  };

  return (
    <main className="page portal-page mashq-worksheets-page">
      <button type="button" className="mashq-back-link" onClick={() => { window.sessionStorage.removeItem(FILTER_KEY); navigate('dashboard'); }}><ArrowLeft size={14} /> Your Path</button>
      <header className="mashq-page-header">
        <div><div className="mashq-page-tags"><span className="mashq-section-number">5</span><span className="mashq-pen-tag">Cut pen · Downloadable</span></div><h1>Mashq worksheets</h1><p>Choose a sheet and download it. All current sets are in Naskh.</p></div>
      </header>

      <aside className="mashq-practice-note"><strong>Practise on art paper.</strong><span>Print each worksheet and practise it on art paper. For more help, contact Funun al-Quran.</span></aside>

      <div className="mashq-category-filters" role="group" aria-label="Filter by worksheet category">
        {[{ key: 'all', label: 'All categories' }, ...GROUPS.map(group => ({ key: group.key, label: `${group.number} ${group.category}` }))].map(item => <button type="button" key={item.key} className={filter === item.key ? 'active' : ''} aria-pressed={filter === item.key} onClick={() => changeFilter(item.key)}>{item.label}</button>)}
      </div>

      {loading && <div className="mashq-page-message"><LoaderCircle size={19} className="mashq-spin" /> Loading Naskh worksheet data…</div>}
      {error && <div className="mashq-page-message is-error" role="alert">{error} <button type="button" onClick={() => window.location.reload()}>Try again</button></div>}
      {assetLoading && !loading && <div className="mashq-page-message"><LoaderCircle size={17} className="mashq-spin" /> Preparing worksheet previews…</div>}
      {downloadError && <p className="mashq-inline-error" role="alert">{downloadError}</p>}

      {!loading && !error && <div className="mashq-set-list">
        {selectedGroups.map(group => {
          const worksheets = pagesForGroup(group);
          const sourceLevelIds = levels.filter(level => level.order_index >= group.firstLevel && level.order_index < group.firstLevel + group.levelCount).map(level => level.id);
          const hasWorksheetFiles = sourceLevelIds.some(levelId => (pdfsByLevel[levelId] ?? []).length > 0);
          return <section className="mashq-set-panel" key={group.key}>
            <div className="mashq-set-heading"><div><div className="mashq-set-title-line"><span className="mashq-set-number">{group.number}</span><h2>{group.title}</h2></div><div className="mashq-set-meta"><span>Category: {group.category}</span><span>Script: {khatType?.display_name ?? 'Naskh'}</span>{group.year && <span>{group.year}</span>}<span>{assetLoading ? 'Loading sheets…' : `${worksheets.length} ${worksheets.length === 1 ? 'sheet' : 'sheets'}`}</span></div></div><button type="button" className="mashq-download-all" disabled={assetLoading || !hasWorksheetFiles} onClick={event => { lastDownloadTriggerRef.current = event.currentTarget; setConfirmTarget({ kind: 'set', group, pages: worksheets, label: `${group.number} ${group.title} · all ${worksheets.length} sheets` }); }}><Download size={14} /> Download all sheets</button></div>
            {hasWorksheetFiles ? <div className="mashq-sheet-grid">{worksheets.map(worksheet => <PagePreview key={worksheet.id} worksheet={worksheet} setNumber={group.number} onDownload={trigger => { lastDownloadTriggerRef.current = trigger; setConfirmTarget({ kind: 'page', worksheet, label: `${group.number} ${group.title} · Page ${worksheet.displayPage}` }); }} />)}</div> : <div className="mashq-set-empty">{assetLoading ? 'Loading attached PDFs…' : 'No printable worksheet PDFs are attached to this set yet.'}</div>}
          </section>;
        })}
        <p className="mashq-more-note">More genres will be added soon.</p>
      </div>}

      {confirmTarget && <div className="mashq-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !downloading) setConfirmTarget(null); }}>
        <section className="mashq-download-dialog" role="dialog" aria-modal="true" aria-labelledby="mashq-dialog-title" aria-describedby="mashq-dialog-note">
          <button type="button" className="mashq-dialog-close" aria-label="Close download note" disabled={downloading} onClick={() => setConfirmTarget(null)}><X size={17} /></button>
          <span className="mashq-dialog-context">{confirmTarget.label}</span><h2 id="mashq-dialog-title">Before you download</h2>
          <div className="mashq-dialog-note" id="mashq-dialog-note">This worksheet has to be practised on <strong>art paper</strong>. For more assistance, contact <strong>Funun al-Quran</strong>.</div>
          {downloadError && <p className="mashq-inline-error" role="alert">{downloadError}</p>}
          <div className="mashq-dialog-actions"><button type="button" className="mashq-cancel-download" disabled={downloading} onClick={() => setConfirmTarget(null)}>Cancel</button><button ref={confirmButtonRef} type="button" className="mashq-confirm-download" disabled={downloading} onClick={() => void startDownload()}>{downloading ? <><LoaderCircle size={14} className="mashq-spin" /> Preparing…</> : <><Download size={14} /> I understand, download</>}</button></div>
        </section>
      </div>}
    </main>
  );
}
