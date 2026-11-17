import jsQR from 'jsqr';
import { canvasToBlob, loadImage, loadPdf, renderPdfPage } from '../chat/pdf';

export type ScannedPage = {
  id: string;
  source: string;          // file name
  sourcePage: number;      // 1-based page within the file
  code: string | null;     // printCode from the QR, e.g. TK-7F3K2
  pageNo: number | null;   // page number from the QR
  blob: Blob;              // upright JPEG ready to upload
  thumb: string;           // small data URL
};

const QR_RE = /^KHAT:([A-Z0-9-]+):(\d+)$/i;
export function parseKhatQr(text: string): { code: string; page: number } | null {
  const m = QR_RE.exec(text.trim());
  return m ? { code: m[1].toUpperCase(), page: Number(m[2]) } : null;
}

function scaled(src: HTMLCanvasElement, sx: number, sy: number, sw: number, sh: number, maxSide: number, rotate180: boolean): ImageData {
  const scale = Math.min(maxSide / Math.max(sw, sh), 3);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(sw * scale));
  c.height = Math.max(1, Math.round(sh * scale));
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = scale < 1;
  if (rotate180) { ctx.translate(c.width, c.height); ctx.rotate(Math.PI); }
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return ctx.getImageData(0, 0, c.width, c.height);
}

function tryDecode(img: ImageData): string | null {
  const r = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
  return r?.data ?? null;
}

/**
 * Finds `KHAT:<code>:<page>` on a page: whole page first, then each corner (35 %) upscaled;
 * both upright and turned 180° (sheets fed upside down). Returns the rotation that worked.
 */
export function decodePage(canvas: HTMLCanvasElement): { code: string; page: number; rotated: boolean } | null {
  const W = canvas.width, H = canvas.height;
  const cw = Math.round(W * 0.35), ch = Math.round(H * 0.35);
  const regions: [number, number, number, number, number][] = [
    [0, 0, W, H, 1400],
    [W - cw, 0, cw, ch, 900], [0, 0, cw, ch, 900], [W - cw, H - ch, cw, ch, 900], [0, H - ch, cw, ch, 900],
  ];
  for (const rotated of [false, true]) {
    for (const [x, y, w, h, max] of regions) {
      const text = tryDecode(scaled(canvas, x, y, w, h, max, rotated));
      const parsed = text ? parseKhatQr(text) : null;
      if (parsed) return { ...parsed, rotated };
    }
  }
  return null;
}

function rotate180(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  const ctx = c.getContext('2d')!;
  ctx.translate(c.width, c.height);
  ctx.rotate(Math.PI);
  ctx.drawImage(src, 0, 0);
  return c;
}

function thumbOf(c: HTMLCanvasElement): string {
  const s = 220 / Math.max(c.width, c.height);
  const t = document.createElement('canvas');
  t.width = Math.round(c.width * s); t.height = Math.round(c.height * s);
  t.getContext('2d')!.drawImage(c, 0, 0, t.width, t.height);
  return t.toDataURL('image/jpeg', 0.75);
}

async function processCanvas(canvas: HTMLCanvasElement, source: string, sourcePage: number): Promise<ScannedPage> {
  const found = decodePage(canvas);
  const upright = found?.rotated ? rotate180(canvas) : canvas;
  const blob = await canvasToBlob(upright, 'image/jpeg', 0.85);
  return { id: `${source}#${sourcePage}#${Math.random().toString(36).slice(2, 7)}`, source, sourcePage, code: found?.code ?? null, pageNo: found?.page ?? null, blob, thumb: thumbOf(upright) };
}

/** Turns dropped files (one PDF or many images) into decoded pages. Calls onPage as each finishes. */
export async function scanFiles(files: File[], onPage: (p: ScannedPage) => void, onProgress: (label: string) => void): Promise<void> {
  for (const file of files) {
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    if (isPdf) {
      const doc = await loadPdf(await file.arrayBuffer());
      for (let n = 1; n <= doc.numPages; n += 1) {
        onProgress(`Reading ${file.name} — page ${n} of ${doc.numPages}`);
        const canvas = await renderPdfPage(doc, n, 2000);
        onPage(await processCanvas(canvas, file.name, n));
        canvas.width = 0; canvas.height = 0;
      }
      void doc.destroy();
    } else if (file.type.startsWith('image/') || /\.(jpe?g|png|webp)$/i.test(file.name)) {
      onProgress(`Reading ${file.name}`);
      const url = URL.createObjectURL(file);
      try {
        const img = await loadImage(url);
        const s = Math.min(1, 2400 / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.naturalWidth * s); canvas.height = Math.round(img.naturalHeight * s);
        canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
        onPage(await processCanvas(canvas, file.name, 1));
      } finally { URL.revokeObjectURL(url); }
    }
    await new Promise(r => setTimeout(r, 0));
  }
}
