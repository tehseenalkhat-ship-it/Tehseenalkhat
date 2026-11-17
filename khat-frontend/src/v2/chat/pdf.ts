import { pdfjs } from 'react-pdf';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// Same worker setup as src/components/ResourcePdfViewer.tsx (react-pdf presets a bare 'pdf.worker.mjs').
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export type PdfDoc = Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>;

const docCache = new Map<string, Promise<PdfDoc>>();

export function loadPdf(source: string | ArrayBuffer, cacheKey?: string): Promise<PdfDoc> {
  if (cacheKey && docCache.has(cacheKey)) return docCache.get(cacheKey)!;
  const task = typeof source === 'string'
    ? pdfjs.getDocument({ url: source })
    : pdfjs.getDocument({ data: new Uint8Array(source) });
  const promise = task.promise;
  if (cacheKey) {
    docCache.set(cacheKey, promise);
    promise.catch(() => docCache.delete(cacheKey));
  }
  return promise;
}

/** Renders one page (1-based) so its longest side is about `targetPx`. */
export async function renderPdfPage(doc: PdfDoc, pageNumber: number, targetPx: number): Promise<HTMLCanvasElement> {
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const scale = targetPx / Math.max(base.width, base.height);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas is not available in this browser.');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  page.cleanup();
  return canvas;
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/jpeg', quality = 0.88): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Could not prepare the image.'))), type, quality));
}

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not open this image.'));
    img.src = url;
  });
}
