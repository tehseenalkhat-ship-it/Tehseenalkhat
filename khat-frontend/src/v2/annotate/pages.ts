import type { Attachment } from '../contracts';
import { isPdf, objectUrl } from '../chat/media';
import { loadImage, loadPdf, renderPdfPage } from '../chat/pdf';

/** Longest side used for annotation bitmaps and the flattened image. */
export const PAGE_MAX_PX = 2000;

export type PageBitmap = { canvas: HTMLCanvasElement; w: number; h: number };

const bitmapCache = new Map<string, Promise<PageBitmap>>();

export function pageKey(storageKey: string, pageIndex: number): string {
  return `${storageKey}#${pageIndex}`;
}

export async function pdfPageCount(att: Attachment): Promise<number> {
  if (!isPdf(att)) return 1;
  const url = await objectUrl(att.storageKey);
  const doc = await loadPdf(url, att.storageKey);
  return doc.numPages;
}

/** Loads one page of an attachment (image → page 0, PDF → page n) as a canvas ≤ PAGE_MAX_PX. */
export function loadPageBitmap(att: Attachment, pageIndex: number): Promise<PageBitmap> {
  const key = pageKey(att.storageKey, pageIndex);
  const hit = bitmapCache.get(key);
  if (hit) return hit;
  const promise = (async () => {
    const url = await objectUrl(att.storageKey);
    if (isPdf(att)) {
      const doc = await loadPdf(url, att.storageKey);
      const canvas = await renderPdfPage(doc, pageIndex + 1, PAGE_MAX_PX);
      return { canvas, w: canvas.width, h: canvas.height };
    }
    const img = await loadImage(url);
    const scale = Math.min(1, PAGE_MAX_PX / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas is not available.');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return { canvas, w: canvas.width, h: canvas.height };
  })();
  bitmapCache.set(key, promise);
  promise.catch(() => bitmapCache.delete(key));
  while (bitmapCache.size > 10) bitmapCache.delete(bitmapCache.keys().next().value as string);
  return promise;
}
