/**
 * Pure PDF building for Tehseen al-Khat downloads and print packs.
 * Bytes in → PDF bytes out. No database, no storage, no network.
 *
 *  - stampFiles():      student downloads. Every page goes onto an A4 sheet with a small
 *                       header band (who downloaded it), a subtle watermark and a copyright
 *                       footer. The content is shrunk slightly so the band sits in the top
 *                       margin and never covers the writing area.
 *  - mergePlain():      staff downloads — the same A4 placement for images, PDFs copied as-is,
 *                       no stamp.
 *  - buildPrintPack():  teacher print pack. Each page carries the student, the step, the
 *                       printCode and a QR code `KHAT:<printCode>:<page>` in the top-right corner
 *                       so scanned pages can be returned to the right student automatically.
 */
import {
  PDFDocument,
  StandardFonts,
  rgb,
  degrees,
  type PDFFont,
  type PDFPage,
  type PDFImage,
  type PDFEmbeddedPage,
  type RGB,
} from 'pdf-lib';
import QRCode from 'qrcode';

// ---------- Units + page sizes ----------
export const MM = 72 / 25.4;
export const A4 = { w: 595.28, h: 841.89 } as const;

export type Rect = { x: number; y: number; width: number; height: number };
export type FileKind = 'pdf' | 'jpg' | 'png';

/** Detect the real file type from its first bytes (never trust the extension). */
export function detectKind(bytes: Uint8Array): FileKind | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'png';
  // %PDF- may be preceded by a little junk in the wild; look in the first 1 KB.
  const head = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 1024))).toString('latin1');
  if (head.includes('%PDF-')) return 'pdf';
  return null;
}

/** EXIF orientation of a JPEG (1 = upright). Phone photos are often stored sideways. */
export function jpegOrientation(bytes: Uint8Array): number {
  try {
    let offset = 2;
    while (offset + 4 < bytes.length) {
      if (bytes[offset] !== 0xff) return 1;
      const marker = bytes[offset + 1];
      const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
      if (marker === 0xda || marker === 0xd9) return 1; // start of scan / end: no EXIF found
      if (marker === 0xe1 && Buffer.from(bytes.subarray(offset + 4, offset + 10)).toString('latin1') === 'Exif\0\0') {
        const tiff = offset + 10;
        const little = bytes[tiff] === 0x49;
        const u16 = (p: number) => (little ? bytes[p] | (bytes[p + 1] << 8) : (bytes[p] << 8) | bytes[p + 1]);
        const u32 = (p: number) => (little
          ? (bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24)) >>> 0
          : ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0);
        const ifd = tiff + u32(tiff + 4);
        const entries = u16(ifd);
        for (let i = 0; i < entries; i++) {
          const entry = ifd + 2 + i * 12;
          if (entry + 12 > bytes.length) break;
          if (u16(entry) === 0x0112) {
            const value = u16(entry + 8);
            return value >= 1 && value <= 8 ? value : 1;
          }
        }
        return 1;
      }
      offset += 2 + length;
    }
  } catch {
    /* malformed EXIF: treat as upright */
  }
  return 1;
}

/** EXIF orientation → clockwise rotation needed to show the photo upright (mirrored variants approximated). */
function orientationToClockwise(orientation: number): 0 | 90 | 180 | 270 {
  if (orientation === 3 || orientation === 4) return 180;
  if (orientation === 6 || orientation === 5) return 90;
  if (orientation === 8 || orientation === 7) return 270;
  return 0;
}

// ---------- Safe text for the standard (WinAnsi) fonts ----------
const ARABIC_LATIN: Record<string, string> = {
  'ا': 'a', 'أ': 'a', 'إ': 'i', 'آ': 'aa', 'ٱ': 'a', 'ب': 'b', 'پ': 'p', 'ت': 't', 'ث': 'th', 'ج': 'j', 'چ': 'ch',
  'ح': 'h', 'خ': 'kh', 'د': 'd', 'ذ': 'dh', 'ر': 'r', 'ز': 'z', 'ژ': 'zh', 'س': 's', 'ش': 'sh', 'ص': 's',
  'ض': 'd', 'ط': 't', 'ظ': 'z', 'ع': "'", 'غ': 'gh', 'ف': 'f', 'ق': 'q', 'ك': 'k', 'ک': 'k', 'گ': 'g',
  'ل': 'l', 'م': 'm', 'ن': 'n', 'ه': 'h', 'ہ': 'h', 'ھ': 'h', 'ة': 'a', 'و': 'w', 'ؤ': "'", 'ي': 'y', 'ی': 'y',
  'ى': 'a', 'ئ': "'", 'ے': 'e', 'ء': "'", 'ٹ': 't', 'ڈ': 'd', 'ڑ': 'r', 'ں': 'n',
  '،': ',', '؛': ';', '؟': '?', 'ـ': '',
};

const charsetCache = new WeakMap<PDFFont, Set<number>>();
function charsetOf(font: PDFFont): Set<number> {
  let set = charsetCache.get(font);
  if (!set) {
    set = new Set(font.getCharacterSet());
    charsetCache.set(font, set);
  }
  return set;
}

/**
 * Make any text drawable with a standard PDF font: Arabic/Farsi/Urdu letters are
 * transliterated, accents are kept when the font has them (else stripped), anything
 * else that cannot be encoded is dropped. Never throws.
 * `supported` is the font's character set (code points); defaults to printable ASCII.
 */
export function pdfSafeText(input: unknown, supported?: Set<number>): string {
  if (input === null || input === undefined) return '';
  const text = String(input).replace(/[\r\n\t]+/g, ' ');
  const can = (ch: string) => {
    const cp = ch.codePointAt(0)!;
    return supported ? supported.has(cp) : cp >= 0x20 && cp <= 0x7e;
  };
  let out = '';
  for (const ch of text) {
    if (can(ch)) { out += ch; continue; }
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x0660 && cp <= 0x0669) { out += String(cp - 0x0660); continue; } // Arabic-Indic digits
    if (cp >= 0x06f0 && cp <= 0x06f9) { out += String(cp - 0x06f0); continue; } // Persian digits
    if (ch in ARABIC_LATIN) { out += ARABIC_LATIN[ch]; continue; }
    if (cp >= 0x064b && cp <= 0x065f) continue; // harakat
    if (cp === 0x2026 && !can(ch)) { out += '...'; continue; }
    if (cp === 0x2014 || cp === 0x2013) { out += '-'; continue; }
    if (cp === 0x00b7 || cp === 0x2022) { out += '-'; continue; }
    const stripped = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
    for (const part of stripped) if (part !== ch && can(part)) out += part;
  }
  return out.replace(/\s{2,}/g, ' ').trim();
}

/** Capitalise the first letter of each transliterated word (helps Arabic-script names read as names). */
function fieldText(input: unknown, font: PDFFont): string {
  const raw = input === null || input === undefined ? '' : String(input);
  const safe = pdfSafeText(raw, charsetOf(font));
  if (/[؀-ۿ]/.test(raw)) return safe.replace(/(^|\s)([a-z])/g, (_m, s: string, c: string) => s + c.toUpperCase());
  return safe;
}

/** Shrink the size down to minSize, then cut with an ellipsis, so the text fits maxWidth. */
export function fitText(text: string, font: PDFFont, maxWidth: number, size: number, minSize: number): { text: string; size: number } {
  let s = size;
  while (s > minSize && font.widthOfTextAtSize(text, s) > maxWidth) s = Math.max(minSize, s - 0.25);
  if (font.widthOfTextAtSize(text, s) <= maxWidth) return { text, size: s };
  const ell = charsetOf(font).has(0x2026) ? '…' : '...';
  let cut = text;
  while (cut.length > 1 && font.widthOfTextAtSize(cut + ell, s) > maxWidth) cut = cut.slice(0, -1);
  return { text: cut.trimEnd() + ell, size: s };
}

export function formatStampDate(date: Date, timeZone = 'Africa/Nairobi'): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

// ---------- Content placement (images and PDF pages fitted onto A4) ----------
type Content =
  | { kind: 'image'; image: PDFImage; w: number; h: number; rotate: 0 | 90 | 180 | 270 }
  | { kind: 'page'; page: PDFEmbeddedPage; w: number; h: number; rotate: 0 | 90 | 180 | 270 };

export type SourceFile = { bytes: Uint8Array; label?: string | null };

type Placed = { page: PDFPage; content: Rect | null; label: string; placeholder: boolean };

type Margins = { top: number; bottom: number; side: number };

function displaySize(c: { w: number; h: number; rotate: number }) {
  return c.rotate === 90 || c.rotate === 270 ? { w: c.h, h: c.w } : { w: c.w, h: c.h };
}

function a4For(w: number, h: number): [number, number] {
  return w > h * 1.05 ? [A4.h, A4.w] : [A4.w, A4.h];
}

/** Largest rect of the content's aspect that fits in the box, centred horizontally and aligned to the top. */
export function fitRect(contentW: number, contentH: number, box: Rect): Rect {
  const scale = Math.min(box.width / contentW, box.height / contentH);
  const width = contentW * scale;
  const height = contentH * scale;
  return { x: box.x + (box.width - width) / 2, y: box.y + box.height - height, width, height };
}

function drawContent(page: PDFPage, c: Content, r: Rect) {
  // r is the displayed (upright) rectangle; rotation is clockwise as in PDF /Rotate and EXIF.
  const { w: dw } = displaySize(c);
  const s = r.width / dw;
  const width = c.w * s;
  const height = c.h * s;
  let x = r.x;
  let y = r.y;
  let angle = 0;
  if (c.rotate === 90) { y = r.y + r.height; angle = -90; }
  else if (c.rotate === 180) { x = r.x + r.width; y = r.y + r.height; angle = 180; }
  else if (c.rotate === 270) { x = r.x + r.width; angle = 90; }
  const opts = { x, y, width, height, rotate: degrees(angle) };
  if (c.kind === 'image') page.drawImage(c.image, opts);
  else page.drawPage(c.page, opts);
}

function normRotation(angle: number): 0 | 90 | 180 | 270 {
  const a = (((Math.round(angle / 90) * 90) % 360) + 360) % 360;
  return a as 0 | 90 | 180 | 270;
}

/** Turns one source file into content items (one per page). Unsupported files return null. */
async function contentsFor(doc: PDFDocument, file: SourceFile): Promise<Content[] | { copied: PDFPage[] } | null> {
  const kind = detectKind(file.bytes);
  if (kind === 'jpg') {
    const image = await doc.embedJpg(file.bytes);
    return [{ kind: 'image', image, w: image.width, h: image.height, rotate: orientationToClockwise(jpegOrientation(file.bytes)) }];
  }
  if (kind === 'png') {
    const image = await doc.embedPng(file.bytes);
    return [{ kind: 'image', image, w: image.width, h: image.height, rotate: 0 }];
  }
  if (kind === 'pdf') {
    const src = await PDFDocument.load(file.bytes, { ignoreEncryption: true, updateMetadata: false });
    const srcPages = src.getPages();
    if (!srcPages.length) return null;
    try {
      const embedded = await doc.embedPdf(src, srcPages.map((_, i) => i));
      return embedded.map((page, i) => ({
        kind: 'page' as const,
        page,
        w: page.width,
        h: page.height,
        rotate: normRotation(srcPages[i].getRotation().angle),
      }));
    } catch {
      // Some PDFs cannot be embedded as forms; copy the pages as they are instead.
      const copied = await doc.copyPages(src, srcPages.map((_, i) => i));
      return { copied };
    }
  }
  return null;
}

async function placeFiles(doc: PDFDocument, files: SourceFile[], margins: (w: number, h: number) => Margins, fonts: Fonts): Promise<Placed[]> {
  const placed: Placed[] = [];
  for (const file of files) {
    const label = file.label || 'file';
    let contents: Awaited<ReturnType<typeof contentsFor>> = null;
    try {
      contents = await contentsFor(doc, file);
    } catch {
      contents = null;
    }
    if (contents && 'copied' in contents) {
      for (const p of contents.copied) {
        doc.addPage(p);
        placed.push({ page: p, content: null, label, placeholder: false });
      }
      continue;
    }
    if (!contents) {
      const page = doc.addPage([A4.w, A4.h]);
      const m = margins(A4.w, A4.h);
      drawPlaceholder(page, fonts, label, { x: m.side, y: m.bottom, width: A4.w - 2 * m.side, height: A4.h - m.top - m.bottom }, file.bytes.length === 0);
      placed.push({ page, content: null, label, placeholder: true });
      continue;
    }
    for (const c of contents) {
      const d = displaySize(c);
      const [pw, ph] = a4For(d.w, d.h);
      const page = doc.addPage([pw, ph]);
      const m = margins(pw, ph);
      const box = { x: m.side, y: m.bottom, width: pw - 2 * m.side, height: ph - m.top - m.bottom };
      const r = fitRect(d.w, d.h, box);
      drawContent(page, c, r);
      placed.push({ page, content: r, label, placeholder: false });
    }
  }
  return placed;
}

function drawPlaceholder(page: PDFPage, fonts: Fonts, label: string, box: Rect, empty = false) {
  const title = empty ? 'Nothing to print here' : 'This file could not be added to the PDF';
  const sub = fitText(pdfSafeText(label, charsetOf(fonts.regular)), fonts.regular, box.width - 40, 10, 7);
  const hint = empty ? 'Please check this submission on the Tehseen al-Khat website.' : 'Please open it on the Tehseen al-Khat website instead.';
  const cy = box.y + box.height / 2;
  page.drawRectangle({ x: box.x + 20, y: cy - 50, width: box.width - 40, height: 100, borderColor: INK_SOFT, borderWidth: 0.6, borderDashArray: [4, 3] });
  const tw = fonts.bold.widthOfTextAtSize(title, 13);
  page.drawText(title, { x: box.x + (box.width - tw) / 2, y: cy + 14, size: 13, font: fonts.bold, color: INK });
  page.drawText(sub.text, { x: box.x + (box.width - fonts.regular.widthOfTextAtSize(sub.text, sub.size)) / 2, y: cy - 4, size: sub.size, font: fonts.regular, color: INK_SOFT });
  page.drawText(hint, { x: box.x + (box.width - fonts.regular.widthOfTextAtSize(hint, 9)) / 2, y: cy - 22, size: 9, font: fonts.regular, color: INK_SOFT });
}

// ---------- Look ----------
const INK = rgb(0.16, 0.15, 0.14);
const INK_SOFT = rgb(0.42, 0.4, 0.38);
const GOLD = rgb(0.6, 0.47, 0.22);
const GOLD_LINE = rgb(0.78, 0.68, 0.45);
const BAND = rgb(0.982, 0.975, 0.96);

type Fonts = { regular: PDFFont; bold: PDFFont; mono: PDFFont };
async function loadFonts(doc: PDFDocument): Promise<Fonts> {
  return {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    mono: await doc.embedFont(StandardFonts.CourierBold),
  };
}

// ---------- Student download stamp ----------
export type StampField = 'name' | 'email' | 'tr' | 'class' | 'branch' | 'date';
export const ALL_STAMP_FIELDS: StampField[] = ['name', 'email', 'tr', 'class', 'branch', 'date'];
export type StampProfile = { name: string; email?: string | null; trNumber?: string | null; className?: string | null; branchName?: string | null };
export type WatermarkPosition = 'center' | 'bottom-right' | 'diagonal-tile';
export type WatermarkInput = { bytes: Uint8Array | null; opacity: number; position: WatermarkPosition; scale: number };
export type StampOptions = {
  profile: StampProfile;
  fields: StampField[];
  watermark?: WatermarkInput | null;
  copyrightText?: string | null;
  date?: Date;
  timeZone?: string;
  documentTitle?: string | null;
  /** Unique sheet ID (e.g. FQ-7K3M2A, see sheetIds.ts) printed in the footer of every page. */
  sheetId?: string | null;
};
export type PagePlacement = { width: number; height: number; content: Rect | null };
export type StampResult = { bytes: Uint8Array; pageCount: number; skipped: string[]; pages: PagePlacement[] };

/** Download layout: thin band at the top, one footer line at the bottom. */
export const STAMP_LAYOUT = { headerH: 24, footerH: 18, side: 16, gap: 4 } as const;
const stampMargins = (): Margins => ({ top: STAMP_LAYOUT.headerH + STAMP_LAYOUT.gap, bottom: STAMP_LAYOUT.footerH + STAMP_LAYOUT.gap, side: STAMP_LAYOUT.side });
/** Student downloads with a sheet ID also carry a small QR (`KHAT:<sheetId>:<page>`) bottom-left, like the teacher pack. */
export const SHEET_QR = { size: 34, quietModules: 2, edge: 4 } as const;
const stampMarginsWithQr = (): Margins => ({ ...stampMargins(), bottom: SHEET_QR.edge + SHEET_QR.size + STAMP_LAYOUT.gap });

export function clampWatermark(w: Partial<WatermarkInput> | null | undefined): Omit<WatermarkInput, 'bytes'> {
  const opacity = Number(w?.opacity);
  const scale = Number(w?.scale);
  const position: WatermarkPosition = w?.position === 'bottom-right' || w?.position === 'diagonal-tile' ? w.position : 'center';
  return {
    opacity: Number.isFinite(opacity) ? Math.min(0.5, Math.max(0.02, opacity)) : 0.08,
    scale: Number.isFinite(scale) ? Math.min(1, Math.max(0.05, scale)) : 0.45,
    position,
  };
}

/** The header line, as drawable segments, honouring the chosen fields. Exported for tests. */
export function stampSegments(profile: StampProfile, fields: StampField[], date: Date, font: PDFFont, timeZone?: string): { left: { text: string; bold: boolean }[]; right: string } {
  const want = new Set(fields);
  const left: { text: string; bold: boolean }[] = [];
  const push = (text: string, bold = false) => { if (text) left.push({ text, bold }); };
  if (want.has('name')) push(fieldText(profile.name, font), true);
  if (want.has('email')) push(fieldText(profile.email, font));
  if (want.has('tr') && profile.trNumber) push(`TR ${fieldText(profile.trNumber, font)}`.trim());
  if (want.has('class') && profile.className) push(`Class ${fieldText(profile.className, font)}`.trim());
  if (want.has('branch')) push(fieldText(profile.branchName, font));
  const right = want.has('date') ? `Downloaded ${formatStampDate(date, timeZone)}` : '';
  return { left: left.filter(s => s.text && s.text !== 'TR' && s.text !== 'Class'), right };
}

function drawStampHeader(page: PDFPage, fonts: Fonts, segs: ReturnType<typeof stampSegments>) {
  const { width: W, height: H } = page.getSize();
  const h = STAMP_LAYOUT.headerH;
  page.drawRectangle({ x: 0, y: H - h, width: W, height: h, color: BAND });
  page.drawLine({ start: { x: 0, y: H - h }, end: { x: W, y: H - h }, thickness: 0.5, color: GOLD_LINE });
  const base = H - h / 2 - 2.6;
  let x = STAMP_LAYOUT.side;
  const brand = 'TEHSEEN AL-KHAT';
  page.drawText(brand, { x, y: base, size: 6.5, font: fonts.bold, color: GOLD });
  x += fonts.bold.widthOfTextAtSize(brand, 6.5) + 8;
  page.drawLine({ start: { x: x - 4, y: base - 1.5 }, end: { x: x - 4, y: base + 7 }, thickness: 0.4, color: GOLD_LINE });

  const rightSize = 7;
  const rightW = segs.right ? fonts.regular.widthOfTextAtSize(segs.right, rightSize) : 0;
  if (segs.right) page.drawText(segs.right, { x: W - STAMP_LAYOUT.side - rightW, y: base, size: rightSize, font: fonts.regular, color: INK_SOFT });

  const avail = W - STAMP_LAYOUT.side - rightW - 14 - x;
  const sep = '  \u00b7  ';
  const fontOf = (s: { bold: boolean }) => (s.bold ? fonts.bold : fonts.regular);
  const measure = (list: { text: string; bold: boolean }[], size: number) => list.reduce((sum, s, i) =>
    sum + fontOf(s).widthOfTextAtSize(s.text, size) + (i ? fonts.regular.widthOfTextAtSize(sep, size) : 0), 0);
  let size = 8;
  while (size > 6 && measure(segs.left, size) > avail) size -= 0.25;
  const parts = segs.left.map(s => ({ ...s }));
  // Still too long at 6 pt: shorten the longest plain part (usually the e-mail); the name stays whole if possible.
  for (let guard = 0; guard < 12 && parts.length && measure(parts, size) > avail; guard++) {
    const over = measure(parts, size) - avail;
    let idx = -1;
    parts.forEach((s, i) => { if (!s.bold && (idx < 0 || s.text.length > parts[idx].text.length)) idx = i; });
    if (idx < 0 || parts[idx].text.length <= 6) idx = parts.length - 1;
    const cur = fontOf(parts[idx]).widthOfTextAtSize(parts[idx].text, size);
    if (cur - over < 24) { parts.splice(idx, 1); continue; }
    parts[idx].text = fitText(parts[idx].text, fontOf(parts[idx]), cur - over, size, size).text;
  }
  for (let i = 0; i < parts.length; i++) {
    if (i) {
      page.drawText(sep, { x, y: base, size, font: fonts.regular, color: GOLD });
      x += fonts.regular.widthOfTextAtSize(sep, size);
    }
    const font = fontOf(parts[i]);
    page.drawText(parts[i].text, { x, y: base, size, font, color: parts[i].bold ? INK : INK_SOFT });
    x += font.widthOfTextAtSize(parts[i].text, size);
  }
}

function drawStampFooter(page: PDFPage, fonts: Fonts, copyright: string, pageNo: number, pageCount: number, sheetId?: string | null, qr?: PDFImage | null) {
  const { width: W } = page.getSize();
  const y = 7;
  const sheet = sheetId ? `Sheet ID ${sheetId}` : '';
  let left = STAMP_LAYOUT.side;
  if (qr) {
    page.drawImage(qr, { x: SHEET_QR.edge + 6, y: SHEET_QR.edge, width: SHEET_QR.size, height: SHEET_QR.size });
    left = SHEET_QR.edge + 6 + SHEET_QR.size + 4;
  }
  if (sheet) page.drawText(sheet, { x: left, y, size: 6.5, font: fonts.bold, color: INK });
  if (qr) left += fonts.bold.widthOfTextAtSize(sheet, 6.5) + 8;
  const num = `${pageNo} / ${pageCount}`;
  const numW = fonts.regular.widthOfTextAtSize(num, 6.5);
  page.drawText(num, { x: W - STAMP_LAYOUT.side - numW, y, size: 6.5, font: fonts.regular, color: INK_SOFT });
  if (copyright) {
    const fit = fitText(copyright, fonts.regular, W - 2 * STAMP_LAYOUT.side - 2 * (numW + 12) - (qr ? left : 0), 6.5, 5);
    const tw = fonts.regular.widthOfTextAtSize(fit.text, fit.size);
    const x = qr ? Math.max(left, (W - tw) / 2) : (W - tw) / 2;
    page.drawText(fit.text, { x, y, size: fit.size, font: fonts.regular, color: INK_SOFT });
  }
}

/** Where the watermark goes on a page. Exported for tests. */
export function watermarkRects(pageW: number, pageH: number, content: Rect, imgW: number, imgH: number, position: WatermarkPosition, scale: number): Rect[] {
  const aspect = imgH / imgW;
  if (position === 'bottom-right') {
    const width = Math.min(content.width * scale * 0.5, content.width * 0.4);
    const height = width * aspect;
    return [{ x: content.x + content.width - width - 10, y: content.y + 10, width, height }];
  }
  if (position === 'diagonal-tile') {
    const width = Math.max(40, pageW * scale * 0.38);
    const height = width * aspect;
    const stepX = width * 1.9;
    const stepY = Math.max(height * 2.4, width * 0.9);
    const rects: Rect[] = [];
    let row = 0;
    for (let y = -height; y < pageH; y += stepY, row++) {
      for (let x = -width + (row % 2 ? stepX / 2 : 0); x < pageW; x += stepX) rects.push({ x, y, width, height });
    }
    return rects;
  }
  let width = content.width * scale;
  let height = width * aspect;
  if (height > content.height * scale) { height = content.height * scale; width = height / aspect; }
  return [{ x: content.x + (content.width - width) / 2, y: content.y + (content.height - height) / 2, width, height }];
}

function drawWatermark(page: PDFPage, fonts: Fonts, image: PDFImage | null, wm: Omit<WatermarkInput, 'bytes'>, content: Rect) {
  const { width: W, height: H } = page.getSize();
  if (image) {
    const rects = watermarkRects(W, H, content, image.width, image.height, wm.position, wm.scale);
    const rotate = wm.position === 'diagonal-tile' ? degrees(30) : undefined;
    for (const r of rects) page.drawImage(image, { ...r, opacity: wm.opacity, ...(rotate ? { rotate } : {}) });
    return;
  }
  // No logo uploaded yet: a quiet diagonal line of text does the same job.
  const text = 'FUNUN AL-QURAN  ·  TEHSEEN AL-KHAT';
  const diag = Math.hypot(content.width, content.height);
  const size = Math.min(40, (diag * 0.7) / Math.max(1, fonts.bold.widthOfTextAtSize(text, 1)));
  const tw = fonts.bold.widthOfTextAtSize(text, size);
  const angle = Math.atan2(content.height, content.width);
  const cx = content.x + content.width / 2;
  const cy = content.y + content.height / 2;
  const x = cx - (Math.cos(angle) * tw) / 2 + (Math.sin(angle) * size * 0.35);
  const y = cy - (Math.sin(angle) * tw) / 2 - (Math.cos(angle) * size * 0.35);
  page.drawText(text, { x, y, size, font: fonts.bold, color: GOLD, opacity: Math.min(wm.opacity * 0.7, 0.1), rotate: degrees((angle * 180) / Math.PI) });
}

async function embedWatermark(doc: PDFDocument, bytes: Uint8Array | null | undefined): Promise<PDFImage | null> {
  if (!bytes || !bytes.length) return null;
  try {
    const kind = detectKind(bytes);
    if (kind === 'png') return await doc.embedPng(bytes);
    if (kind === 'jpg') return await doc.embedJpg(bytes);
  } catch {
    /* a broken watermark must never stop a download */
  }
  return null;
}

function setMeta(doc: PDFDocument, title: string | null | undefined, subject: string, keywords: string[]) {
  if (title) doc.setTitle(title);
  doc.setAuthor('Funun al-Quran, Al-Jamea-tus-Saifiyah');
  doc.setCreator('Tehseen al-Khat');
  doc.setProducer('Tehseen al-Khat');
  doc.setSubject(subject);
  doc.setKeywords(keywords.filter(Boolean));
}

/** Stamp one or many files (images or PDFs) into ONE PDF for the given student. */
export async function stampFiles(files: SourceFile[], opts: StampOptions): Promise<StampResult> {
  const doc = await PDFDocument.create();
  const fonts = await loadFonts(doc);
  const withQr = Boolean(opts.sheetId);
  const placed = await placeFiles(doc, files, withQr ? stampMarginsWithQr : stampMargins, fonts);
  const wm = clampWatermark(opts.watermark ?? null);
  const wmImage = await embedWatermark(doc, opts.watermark?.bytes);
  const segs = stampSegments(opts.profile, opts.fields, opts.date ?? new Date(), fonts.regular, opts.timeZone);
  const copyright = pdfSafeText(opts.copyrightText ?? '', charsetOf(fonts.regular));
  const skipped = placed.filter(p => p.placeholder).map(p => p.label);
  const qrs: (PDFImage | null)[] = [];
  for (let i = 0; i < placed.length; i++) {
    qrs.push(withQr ? await doc.embedPng(await QRCode.toBuffer(qrPayload(String(opts.sheetId), i + 1), { type: 'png', errorCorrectionLevel: 'M', margin: SHEET_QR.quietModules, scale: 8, color: { dark: '#000000', light: '#ffffff' } })) : null);
  }
  placed.forEach((p, i) => {
    const { width: W, height: H } = p.page.getSize();
    const bottom = withQr ? SHEET_QR.edge + SHEET_QR.size : STAMP_LAYOUT.footerH;
    const content = p.content ?? { x: STAMP_LAYOUT.side, y: bottom, width: W - 2 * STAMP_LAYOUT.side, height: H - STAMP_LAYOUT.headerH - bottom };
    drawWatermark(p.page, fonts, wmImage, wm, content);
    drawStampHeader(p.page, fonts, segs);
    drawStampFooter(p.page, fonts, copyright, i + 1, placed.length, opts.sheetId ?? null, qrs[i]);
  });
  setMeta(doc, opts.documentTitle, `Licensed to ${opts.profile.name}${opts.profile.email ? ` <${opts.profile.email}>` : ''} for personal practice`,
    [opts.profile.email ?? '', opts.profile.trNumber ? `TR ${opts.profile.trNumber}` : '', opts.profile.branchName ?? '']);
  const pages = placed.map(p => ({ ...p.page.getSize(), content: p.content }));
  return { bytes: await doc.save(), pageCount: placed.length, skipped, pages };
}

export const stampFile = (file: SourceFile, opts: StampOptions) => stampFiles([file], opts);

/** Staff: merge originals unstamped (images on A4, PDF pages copied as they are). */
export async function mergePlain(files: SourceFile[], title?: string | null): Promise<StampResult> {
  const doc = await PDFDocument.create();
  const fonts = await loadFonts(doc);
  const skipped: string[] = [];
  const pages: PagePlacement[] = [];
  for (const file of files) {
    const kind = detectKind(file.bytes);
    try {
      if (kind === 'pdf') {
        const src = await PDFDocument.load(file.bytes, { ignoreEncryption: true, updateMetadata: false });
        const copied = await doc.copyPages(src, src.getPageIndices());
        copied.forEach(p => { doc.addPage(p); pages.push({ ...p.getSize(), content: null }); });
        continue;
      }
    } catch {
      /* fall through to placeholder via placeFiles */
    }
    const placed = await placeFiles(doc, [file], () => ({ top: 18, bottom: 18, side: 18 }), fonts);
    placed.forEach(p => { if (p.placeholder) skipped.push(p.label); pages.push({ ...p.page.getSize(), content: p.content }); });
  }
  if (title) doc.setTitle(title);
  doc.setCreator('Tehseen al-Khat');
  doc.setProducer('Tehseen al-Khat');
  return { bytes: await doc.save(), pageCount: pages.length, skipped, pages };
}

// ---------- Teacher print pack ----------
export type PrintPackSubmission = {
  printCode: string;
  studentName: string;
  trNumber?: string | null;
  className?: string | null;
  branchName?: string | null;
  courseCode?: string | null;
  courseTitle?: string | null;
  levelCode?: string | null;
  levelDescription?: string | null;
  stepCode?: string | null;
  stepTitle?: string | null;
  attemptNo?: number | null;
  /** Unique sheet ID (FQ-XXXXXX) printed next to the print code. */
  sheetId?: string | null;
  files: SourceFile[];
};
export type PrintPackPage = { printCode: string; page: number; of: number; payload: string; qr: Rect; qrSymbol: Rect; modules: number; content: Rect | null; headerBottom: number; pageSize: { width: number; height: number } };
export type PrintPackResult = { bytes: Uint8Array; pageCount: number; pages: PrintPackPage[] };

export const qrPayload = (printCode: string, page: number) => `KHAT:${printCode}:${page}`;

/** QR symbol ≥ 2.2 cm with a 4-module quiet zone, in the top-right corner. */
export const PRINT_LAYOUT = { qrSymbol: 23 * MM, quietModules: 4, edge: 4 * MM, side: 14, footerH: 16, gap: 6 } as const;

export function qrModules(payload: string): number {
  return QRCode.create(payload, { errorCorrectionLevel: 'M' }).modules.size;
}

/** Where the QR goes on a page of the given size. Same corner on every page. */
export function qrPlacement(pageW: number, pageH: number, modules: number): { box: Rect; symbol: Rect } {
  const moduleSize = PRINT_LAYOUT.qrSymbol / modules;
  const total = PRINT_LAYOUT.qrSymbol + 2 * PRINT_LAYOUT.quietModules * moduleSize;
  const box = { x: pageW - PRINT_LAYOUT.edge - total, y: pageH - PRINT_LAYOUT.edge - total, width: total, height: total };
  const q = PRINT_LAYOUT.quietModules * moduleSize;
  return { box, symbol: { x: box.x + q, y: box.y + q, width: PRINT_LAYOUT.qrSymbol, height: PRINT_LAYOUT.qrSymbol } };
}

/** Header height of print-pack pages: tall enough for the QR (all codes use the same QR version). */
function printHeaderH(modules: number): number {
  const { box } = qrPlacement(A4.w, A4.h, modules);
  return box.height + PRINT_LAYOUT.edge + 2;
}

async function qrPng(payload: string): Promise<Buffer> {
  return QRCode.toBuffer(payload, { type: 'png', errorCorrectionLevel: 'M', margin: PRINT_LAYOUT.quietModules, scale: 10, color: { dark: '#000000', light: '#ffffff' } });
}

export async function buildPrintPack(subs: PrintPackSubmission[], opts: { generatedAt?: Date; timeZone?: string } = {}): Promise<PrintPackResult> {
  const doc = await PDFDocument.create();
  const fonts = await loadFonts(doc);
  const generated = formatStampDate(opts.generatedAt ?? new Date(), opts.timeZone);
  // One header height for the whole pack (the widest QR decides) so pages look the same.
  const maxModules = Math.max(21, ...subs.map(s => qrModules(qrPayload(s.printCode, 99))));
  const headerH = printHeaderH(maxModules);
  const margins = (): Margins => ({ top: headerH + PRINT_LAYOUT.gap, bottom: PRINT_LAYOUT.footerH + PRINT_LAYOUT.gap, side: PRINT_LAYOUT.side });
  const pages: PrintPackPage[] = [];
  let total = 0;

  for (let si = 0; si < subs.length; si++) {
    const sub = subs[si];
    const files = sub.files.length ? sub.files : [{ bytes: new Uint8Array(), label: 'No file was uploaded for this submission' }];
    const placed = await placeFiles(doc, files, margins, fonts);
    for (let pi = 0; pi < placed.length; pi++) {
      const page = placed[pi].page;
      const { width: W, height: H } = page.getSize();
      const n = pi + 1;
      const payload = qrPayload(sub.printCode, n);
      const modules = qrModules(payload);
      const { box, symbol } = qrPlacement(W, H, modules);

      // Header: white, so the QR quiet zone stays clean. First page of each student gets a dark strip.
      page.drawRectangle({ x: 0, y: H - headerH, width: W, height: headerH, color: rgb(1, 1, 1) });
      page.drawLine({ start: { x: PRINT_LAYOUT.side, y: H - headerH }, end: { x: W - PRINT_LAYOUT.side, y: H - headerH }, thickness: 0.8, color: INK });
      if (n === 1) page.drawRectangle({ x: 0, y: H - 5, width: box.x - 6, height: 5, color: INK });

      const textW = box.x - PRINT_LAYOUT.side - 10;
      const f = fonts;
      const name = fitText(fieldText(sub.studentName, f.bold), f.bold, textW, 15, 9);
      let y = H - 30;
      page.drawText(name.text, { x: PRINT_LAYOUT.side, y, size: name.size, font: f.bold, color: INK });

      const who = [sub.trNumber ? `TR ${fieldText(sub.trNumber, f.regular)}` : '', sub.className ? `Class ${fieldText(sub.className, f.regular)}` : '', fieldText(sub.branchName, f.regular)].filter(Boolean).join('   ·   ');
      y -= 15;
      if (who) {
        const t = fitText(who, f.regular, textW, 9.5, 7);
        page.drawText(t.text, { x: PRINT_LAYOUT.side, y, size: t.size, font: f.regular, color: INK_SOFT });
      }
      const level = [sub.levelCode, fieldText(sub.levelDescription, f.regular)].filter(Boolean).join(' ');
      const step = [sub.stepCode, fieldText(sub.stepTitle, f.regular)].filter(Boolean).join(' ');
      const where = [fieldText(sub.courseCode || sub.courseTitle, f.regular), level, step, sub.attemptNo && sub.attemptNo > 1 ? `attempt ${sub.attemptNo}` : ''].filter(Boolean).join('   ›   ');
      y -= 13;
      if (where) {
        const t = fitText(pdfSafeText(where, charsetOf(f.regular)), f.regular, textW, 9.5, 7);
        page.drawText(t.text, { x: PRINT_LAYOUT.side, y, size: t.size, font: f.regular, color: INK });
      }
      // printCode (readable fallback when a QR cannot be read) + page n/N
      const codeY = H - headerH + 9;
      page.drawText(sub.printCode, { x: PRINT_LAYOUT.side, y: codeY, size: 15, font: f.mono, color: INK });
      let cx = PRINT_LAYOUT.side + f.mono.widthOfTextAtSize(sub.printCode, 15) + 12;
      const pageLabel = `Page ${n} of ${placed.length}`;
      page.drawText(pageLabel, { x: cx, y: codeY + 2, size: 9.5, font: f.bold, color: INK });
      cx += f.bold.widthOfTextAtSize(pageLabel, 9.5) + 12;
      const subLabel = `Student ${si + 1} of ${subs.length}`;
      page.drawText(subLabel, { x: cx, y: codeY + 2, size: 8, font: f.regular, color: INK_SOFT });
      cx += f.regular.widthOfTextAtSize(subLabel, 8) + 12;
      if (sub.sheetId && cx + f.bold.widthOfTextAtSize(`Sheet ID ${sub.sheetId}`, 8.5) < box.x - 6) {
        page.drawText(`Sheet ID ${sub.sheetId}`, { x: cx, y: codeY + 2, size: 8.5, font: f.bold, color: INK });
      }

      const png = await doc.embedPng(await qrPng(payload));
      page.drawImage(png, { ...box });

      pages.push({ printCode: sub.printCode, page: n, of: placed.length, payload, qr: box, qrSymbol: symbol, modules, content: placed[pi].content, headerBottom: H - headerH, pageSize: { width: W, height: H } });
      // footer
      const foot = `Correct on paper, scan every page, then use "Upload marked items" on the website.   ${generated}${sub.sheetId ? `   ·   ${sub.sheetId}` : ''}`;
      page.drawText(foot, { x: PRINT_LAYOUT.side, y: 7, size: 6.5, font: f.regular, color: INK_SOFT });
      total++;
    }
  }
  doc.setTitle(`Print pack - ${subs.length} submission${subs.length === 1 ? '' : 's'}`);
  doc.setCreator('Tehseen al-Khat');
  doc.setProducer('Tehseen al-Khat');
  return { bytes: await doc.save(), pageCount: total, pages };
}
