/**
 * backend-files tests: PDF stamping, merging, print packs (pdfStamp.ts) and the pure
 * helpers of the downloads / print / competitions routes (filesLogic.ts).
 * Run: npx tsx --test tests/v2/backend-files.test.ts
 * Sample PDFs are written to tests/v2/out/ for a visual check.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, crc32 } from 'node:zlib';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import {
  A4, MM, PRINT_LAYOUT, STAMP_LAYOUT, buildPrintPack, detectKind, fitRect, jpegOrientation, mergePlain, pdfSafeText,
  qrPayload, stampFile, stampFiles, watermarkRects, type StampOptions,
} from '../../src/v2/lib/pdfStamp.js';
import {
  bundleName, competitionOpenToBranch, contentDisposition, effectiveCompetitionStatus, isSafeStorageKey, mapLimit, normaliseBranchIds,
  normaliseExcerpts, normaliseSelections, pdfName, pickPackFiles, stampFieldsFrom, studentDownloadBlock, tooManyMessage, uniqueIds,
  validateWatermarkInput, watermarkSettingFrom, MAX_FILES_PER_PDF,
} from '../../src/v2/lib/filesLogic.js';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out');

// ---------- Fixture builders ----------
function png(width: number, height: number, channels: 1 | 3 | 4, pixel: (x: number, y: number) => number[]): Uint8Array {
  const colorType = channels === 1 ? 0 : channels === 3 ? 2 : 6;
  const raw = Buffer.alloc((width * channels + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width; x++) for (const v of pixel(x, y)) raw[o++] = v;
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = colorType;
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0)),
  ]));
}

/** A4 mistar at 150 dpi: sheet border, a title box at the very top, ruled baselines with nuqta guides. */
function mistarPng(landscape = false): Uint8Array {
  const [w, h] = landscape ? [1754, 1240] : [1240, 1754];
  return png(w, h, 1, (x, y) => {
    const inBorder = x >= 30 && x < w - 30 && y >= 30 && y < h - 30;
    if (!inBorder) return [255];
    if (x < 34 || x >= w - 34 || y < 34 || y >= h - 34) return [40];             // sheet border
    if (y >= 34 && y < 140 && (y < 38 || y >= 136)) return [90];                    // title box lines (top of sheet!)
    if (y >= 34 && y < 140 && x > 60 && x < 520 && y > 70 && y < 104 && (x + y) % 9 < 5) return [60]; // fake title text
    const row = (y - 180) % 110;
    if (y > 170 && row >= 0 && row < 2) return [70];                                // baseline
    if (y > 170 && row >= 0 && row < 70 && row % 70 < 1) return [180];
    if (y > 170 && (row === 55 || row === 56) && x % 12 < 6) return [175];           // dashed x-height
    if (y > 170 && row > 10 && row < 40 && x > 80 && x < 110 && Math.abs((x - 95) - (row - 25)) + Math.abs((x - 95) + (row - 25)) < 18) return [30]; // nuqta rhombus
    return [255];
  });
}

/** Department-logo-like RGBA watermark: gold ring + eight-point star, transparent background. */
function watermarkPng(): Uint8Array {
  const s = 600;
  return png(s, s, 4, (x, y) => {
    const dx = x - s / 2, dy = y - s / 2;
    const r = Math.hypot(dx, dy);
    const ring = r > 250 && r < 275;
    const sq1 = Math.abs(dx) < 150 && Math.abs(dy) < 150;
    const sq2 = Math.abs(dx + dy) / Math.SQRT2 < 150 && Math.abs(dx - dy) / Math.SQRT2 < 150;
    const star = (sq1 || sq2) && !(Math.abs(dx) < 120 && Math.abs(dy) < 120 && Math.abs(dx + dy) / Math.SQRT2 < 120 && Math.abs(dx - dy) / Math.SQRT2 < 120);
    const dot = r < 40;
    return ring || star || dot ? [120, 90, 30, 255] : [255, 255, 255, 0];
  });
}

const JPG_B64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCABAADADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD1+iqs2l6dcytLPYW0sjdXeFWJ/Eimf2JpP/QLs/8AwHT/AAqCi7RVL+xNJ/6Bdn/4Dp/hR/Ymk/8AQLs//AdP8KALtFUv7E0n/oF2f/gOn+FPh0vTraVZYLC2ikXo6QqpH4gUAE2l6dcytLPYW0sjdXeFWJ/EisIwm41C+t9P8M6NLFZTLCZJ5vLZmMaSfdELcfvAOvat2bS9OuZWlnsLaWRurvCrE/iRWPo+kaY+p66radaMEv1CgwL8o+zQHA49ST+NADf7Nv8A/oVfD3/gW3/yPUNzFNYrDLeeFtDED3EMLNDcF2XzJFjBAMABwWB6it3+xNJ/6Bdn/wCA6f4VleI9I0yPTIWTTrRSb+zGVgUcG5jBHTuCRQBq/wBiaT/0C7P/AMB0/wAKfDpenW0qywWFtFIvR0hVSPxApn9iaT/0C7P/AMB0/wAKfDpenW0qywWFtFIvR0hVSPxAoAJtL065laWewtpZG6u8KsT+JFY+j6Rpj6nrqtp1owS/UKDAvyj7NAcDj1JP41sTaXp1zK0s9hbSyN1d4VYn8SKqyeF/D00hkl0HTHc9Wa0jJP44oAn/ALE0n/oF2f8A4Dp/hWV4j0jTI9MhZNOtFJv7MZWBRwbmMEdO4JFXP+ES8Nf9C9pX/gFH/hSr4U8OI4dPD+lqynIIs4wQfyoAsf2JpP8A0C7P/wAB0/wp8Ol6dbSrLBYW0Ui9HSFVI/ECmf2JpP8A0C7P/wAB0/wp8Ol6dbSrLBYW0Ui9HSFVI/ECgAm0vTrmVpZ7C2lkbq7wqxP4kUz+xNJ/6Bdn/wCA6f4U+bS9OuZWlnsLaWRurvCrE/iRTP7E0n/oF2f/AIDp/hQAf2JpP/QLs/8AwHT/AAo/sTSf+gXZ/wDgOn+FH9iaT/0C7P8A8B0/wo/sTSf+gXZ/+A6f4UgD+xNJ/wCgXZ/+A6f4U+HS9OtpVlgsLaKRejpCqkfiBTP7E0n/AKBdn/4Dp/hT4dL062lWWCwtopF6OkKqR+IFMD//2Q==';
const jpg = () => new Uint8Array(Buffer.from(JPG_B64, 'base64'));

/** Same JPEG with an EXIF APP1 segment saying "rotate 90° clockwise" (orientation 6), like phone photos. */
function jpgRotated(): Uint8Array {
  const base = Buffer.from(jpg());
  const tiff = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const len = Buffer.alloc(2); len.writeUInt16BE(payload.length + 2);
  return new Uint8Array(Buffer.concat([base.subarray(0, 2), Buffer.from([0xff, 0xe1]), len, payload, base.subarray(2)]));
}

async function twoPagePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= 2; n++) {
    const page = doc.addPage([A4.w, A4.h]);
    page.drawRectangle({ x: 20, y: 20, width: A4.w - 40, height: A4.h - 40, borderColor: rgb(0.2, 0.2, 0.2), borderWidth: 1 });
    page.drawText(`Assessment sheet - page ${n} (top line of the sheet)`, { x: 30, y: A4.h - 40, size: 12, font });
    for (let y = A4.h - 90; y > 40; y -= 46) page.drawLine({ start: { x: 30, y }, end: { x: A4.w - 30, y }, thickness: 0.8, color: rgb(0.35, 0.35, 0.35) });
  }
  return doc.save();
}

const profile = { name: 'Husain Jamaali', email: 'husain.jamaali@example.org', trNumber: '30412', className: '6B', branchName: 'Nairobi' };
const opts = (over: Partial<StampOptions> = {}): StampOptions => ({
  profile,
  fields: ['name', 'email', 'tr', 'class', 'branch', 'date'],
  watermark: { bytes: watermarkPng(), opacity: 0.08, position: 'center', scale: 0.45 },
  copyrightText: '© Tadreeb Fanni, Al-Jamea-tus-Saifiyah. For personal practice only. Not for sale or reproduction.',
  date: new Date('2026-11-10T09:00:00Z'),
  documentTitle: 'FNK-C101_MT_LV01_S01_P01_07_v1',
  ...over,
});

const reload = (bytes: Uint8Array) => PDFDocument.load(bytes);
const within = (inner: { x: number; y: number; width: number; height: number }, outer: { x: number; y: number; width: number; height: number }, eps = 0.01) =>
  inner.x >= outer.x - eps && inner.y >= outer.y - eps && inner.x + inner.width <= outer.x + outer.width + eps && inner.y + inner.height <= outer.y + outer.height + eps;

before(() => mkdirSync(OUT, { recursive: true }));

// ---------- pdfStamp: detection + text ----------
describe('file detection', () => {
  test('detects jpg / png / pdf by bytes, rejects others', async () => {
    assert.equal(detectKind(jpg()), 'jpg');
    assert.equal(detectKind(watermarkPng()), 'png');
    assert.equal(detectKind(await twoPagePdf()), 'pdf');
    assert.equal(detectKind(new Uint8Array(Buffer.from('RIFF....WEBPVP8 '))), null);
    assert.equal(detectKind(new Uint8Array()), null);
  });
  test('reads EXIF orientation', () => {
    assert.equal(jpegOrientation(jpg()), 1);
    assert.equal(jpegOrientation(jpgRotated()), 6);
    assert.equal(jpegOrientation(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00])), 1);
  });
});

describe('pdfSafeText (standard fonts cannot draw every script)', () => {
  test('keeps ASCII, strips accents, transliterates Arabic/Farsi/Urdu, drops the rest', () => {
    assert.equal(pdfSafeText('Husain Jamaali'), 'Husain Jamaali');
    assert.equal(pdfSafeText('Ḥusayn Jamālī'), 'Husayn Jamali');
    assert.equal(pdfSafeText('حسين جمالي'), 'hsyn jmaly');
    assert.equal(pdfSafeText('پرویز چوہدری'), 'prwyz chwhdry');
    assert.equal(pdfSafeText('TR ٣٠٤١٢'), 'TR 30412');
    assert.equal(pdfSafeText('名前 😀 ok'), 'ok');
    assert.equal(pdfSafeText('line1\nline2'), 'line1 line2');
    assert.equal(pdfSafeText(null), '');
  });
  test('uses the font character set when given (WinAnsi keeps é, ©)', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const set = new Set(font.getCharacterSet());
    assert.equal(pdfSafeText('Zoë © André', set), 'Zoë © André');
    assert.equal(pdfSafeText('Ḥusayn', set), 'Husayn');
  });
});

// ---------- pdfStamp: student downloads ----------
describe('stampFile', () => {
  test('PNG worksheet → one A4 portrait page, content below the band and above the footer', async () => {
    const res = await stampFile({ bytes: mistarPng(), label: 'FNK-C101_MT_LV01_S01_P01_07_v1.png' }, opts());
    writeFileSync(join(OUT, 'download-png-center.pdf'), res.bytes);
    assert.equal(res.pageCount, 1);
    assert.deepEqual(res.skipped, []);
    const doc = await reload(res.bytes);
    assert.equal(doc.getPageCount(), 1);
    const { width, height } = doc.getPage(0).getSize();
    assert.ok(Math.abs(width - A4.w) < 0.01 && Math.abs(height - A4.h) < 0.01);
    const c = res.pages[0].content!;
    assert.ok(c.y + c.height <= height - STAMP_LAYOUT.headerH, 'content must not go under the header band');
    assert.ok(c.y >= STAMP_LAYOUT.footerH, 'content must not go under the footer');
    assert.ok(c.width / width > 0.9, 'content keeps at least ~90% of the page width');
    assert.match(doc.getSubject() ?? '', /Husain Jamaali/);
    assert.equal(doc.getTitle(), 'FNK-C101_MT_LV01_S01_P01_07_v1');
  });

  test('landscape PNG → landscape A4', async () => {
    const res = await stampFile({ bytes: mistarPng(true) }, opts({ watermark: { bytes: watermarkPng(), opacity: 0.1, position: 'bottom-right', scale: 0.45 } }));
    writeFileSync(join(OUT, 'download-landscape-bottomright.pdf'), res.bytes);
    const page = (await reload(res.bytes)).getPage(0);
    assert.ok(page.getWidth() > page.getHeight());
  });

  test('JPG → portrait; EXIF-rotated phone photo → upright (landscape) page', async () => {
    const a = await stampFile({ bytes: jpg() }, opts());
    assert.ok(a.pages[0].height > a.pages[0].width);
    const b = await stampFile({ bytes: jpgRotated() }, opts());
    assert.ok(b.pages[0].width > b.pages[0].height, '48x64 photo rotated 90° shows as 64x48');
    await reload(b.bytes);
  });

  test('2-page PDF → both pages stamped', async () => {
    const res = await stampFile({ bytes: await twoPagePdf() }, opts({ watermark: { bytes: watermarkPng(), opacity: 0.07, position: 'diagonal-tile', scale: 0.45 } }));
    writeFileSync(join(OUT, 'download-pdf-tiled.pdf'), res.bytes);
    assert.equal(res.pageCount, 2);
    assert.equal((await reload(res.bytes)).getPageCount(), 2);
    for (const p of res.pages) assert.ok(p.content && p.content.y + p.content.height <= p.height - STAMP_LAYOUT.headerH);
  });

  test('non-Latin names, empty fields and no watermark logo never crash', async () => {
    const res = await stampFile({ bytes: mistarPng() }, opts({
      profile: { name: 'حسين جمالي ✍️ 名前', email: null, trNumber: '٣٠٤١٢', className: 'ششم', branchName: 'نیروبی' },
      watermark: { bytes: null, opacity: 0.08, position: 'center', scale: 0.45 },
      copyrightText: '© تدريب فني — personal practice only',
    }));
    writeFileSync(join(OUT, 'download-arabic-name-text-watermark.pdf'), res.bytes);
    assert.equal((await reload(res.bytes)).getPageCount(), 1);
    assert.match((await reload(res.bytes)).getSubject() ?? '', /حسين/, 'metadata keeps the real (Unicode) name');
  });

  test('a very long e-mail/name is shortened, not overflowing; only enabled fields', async () => {
    const res = await stampFile({ bytes: jpg() }, opts({
      profile: { ...profile, name: 'Mohammed Burhanuddin Shabbir Hussain Jamaali Saifuddin', email: 'a.very.long.email.address.for.testing.purposes@some-long-domain-name.example.org' },
      fields: ['name', 'email', 'tr'],
    }));
    await reload(res.bytes);
  });

  test('broken watermark bytes are ignored', async () => {
    const res = await stampFile({ bytes: jpg() }, opts({ watermark: { bytes: new Uint8Array([1, 2, 3]), opacity: 0.08, position: 'center', scale: 0.4 } }));
    assert.equal(res.pageCount, 1);
  });
});

describe('stampFiles (print many) + mergePlain', () => {
  test('merges jpg + png + 2-page pdf + an unsupported file into one PDF', async () => {
    const res = await stampFiles([
      { bytes: jpg(), label: 'a.jpg' },
      { bytes: mistarPng(), label: 'b.png' },
      { bytes: await twoPagePdf(), label: 'c.pdf' },
      { bytes: new Uint8Array(Buffer.from('RIFF0000WEBPVP8 ')), label: 'photo.webp' },
    ], opts());
    writeFileSync(join(OUT, 'download-bundle.pdf'), res.bytes);
    assert.equal(res.pageCount, 5);
    assert.deepEqual(res.skipped, ['photo.webp']);
    assert.equal((await reload(res.bytes)).getPageCount(), 5);
  });

  test('staff merge: originals, no stamp', async () => {
    const res = await mergePlain([{ bytes: await twoPagePdf() }, { bytes: jpg() }], 'staff');
    assert.equal(res.pageCount, 3);
    const doc = await reload(res.bytes);
    assert.equal(doc.getPageCount(), 3);
    assert.equal(doc.getSubject(), undefined);
  });
});

describe('watermark geometry', () => {
  const content = { x: 16, y: 22, width: 563, height: 791 };
  test('centre: centred inside the content, scaled', () => {
    const [r] = watermarkRects(A4.w, A4.h, content, 600, 600, 'center', 0.45);
    assert.ok(within(r, content));
    assert.ok(Math.abs(r.width - content.width * 0.45) < 0.01);
    assert.ok(Math.abs(r.x + r.width / 2 - (content.x + content.width / 2)) < 0.01);
  });
  test('bottom-right: small, inside the content corner', () => {
    const [r] = watermarkRects(A4.w, A4.h, content, 600, 300, 'bottom-right', 0.45);
    assert.ok(within(r, content));
    assert.ok(r.x > content.x + content.width / 2 && r.y < content.y + content.height / 2);
  });
  test('diagonal tile covers the page with several copies', () => {
    const rects = watermarkRects(A4.w, A4.h, content, 600, 600, 'diagonal-tile', 0.45);
    assert.ok(rects.length >= 6);
  });
  test('fitRect keeps aspect and top-aligns', () => {
    const r = fitRect(100, 50, { x: 0, y: 0, width: 200, height: 200 });
    assert.deepEqual(r, { x: 0, y: 100, width: 200, height: 100 });
  });
});

// ---------- pdfStamp: print pack ----------
describe('buildPrintPack', () => {
  test('every page: QR KHAT:<code>:<n> ≥ 2.2 cm with quiet zone, same top-right corner, content below the header', async () => {
    const res = await buildPrintPack([
      { printCode: 'TK-7F3K2', studentName: 'Fatema Saifuddin', trNumber: '41007', className: '5A', branchName: 'Nairobi', courseCode: 'FNK-C101', levelCode: 'LV02', levelDescription: 'مفردات', stepCode: 'S05', stepTitle: 'Level assessment', attemptNo: 2,
        files: [{ bytes: await twoPagePdf(), label: 'sheet.pdf' }, { bytes: jpgRotated(), label: 'photo.jpg' }] },
      { printCode: 'TK-Q9M4H', studentName: 'حسين جمالي', trNumber: null, branchName: 'Karachi', courseCode: 'NSK-C201', levelCode: 'LV01', stepCode: 'S03', stepTitle: 'Assessment',
        files: [{ bytes: mistarPng(), label: 'scan.png' }] },
      { printCode: 'TK-ABCDE', studentName: 'Empty Upload', files: [] },
    ], { generatedAt: new Date('2026-11-10T09:00:00Z') });
    writeFileSync(join(OUT, 'print-pack.pdf'), res.bytes);
    assert.equal(res.pageCount, 5);
    assert.equal((await reload(res.bytes)).getPageCount(), 5);
    assert.deepEqual(res.pages.map(p => p.payload), ['KHAT:TK-7F3K2:1', 'KHAT:TK-7F3K2:2', 'KHAT:TK-7F3K2:3', 'KHAT:TK-Q9M4H:1', 'KHAT:TK-ABCDE:1']);
    assert.deepEqual(res.pages.map(p => `${p.page}/${p.of}`), ['1/3', '2/3', '3/3', '1/1', '1/1']);
    for (const p of res.pages) {
      const { width: W, height: H } = p.pageSize;
      assert.ok(p.qrSymbol.width >= 2.2 * 10 * MM / 10 * 1 && p.qrSymbol.width >= 22 * MM - 0.01, `QR symbol ${p.qrSymbol.width / MM} mm ≥ 22 mm`);
      const quiet = (p.qr.width - p.qrSymbol.width) / 2;
      assert.ok(quiet >= (4 * p.qrSymbol.width) / p.modules - 0.01, 'quiet zone of 4 modules');
      assert.ok(within(p.qr, { x: 0, y: 0, width: W, height: H }), 'QR fully on the page');
      assert.ok(Math.abs(W - (p.qr.x + p.qr.width) - PRINT_LAYOUT.edge) < 0.01, 'right edge offset');
      assert.ok(Math.abs(H - (p.qr.y + p.qr.height) - PRINT_LAYOUT.edge) < 0.01, 'top edge offset');
      assert.ok(p.qr.y >= p.headerBottom, 'QR sits inside the header');
      if (p.content) assert.ok(p.content.y + p.content.height <= p.headerBottom, 'content never under the QR/header');
    }
    // Same QR rectangle on every portrait page.
    const portrait = res.pages.filter(p => p.pageSize.height > p.pageSize.width);
    assert.ok(portrait.every(p => JSON.stringify(p.qr) === JSON.stringify(portrait[0].qr)));
    assert.equal(qrPayload('TK-7F3K2', 3), 'KHAT:TK-7F3K2:3');
  });
});

// ---------- filesLogic ----------
describe('filesLogic', () => {
  test('content disposition + names', () => {
    assert.equal(contentDisposition('FNK-C101_LV01_worksheets.pdf'), `attachment; filename="FNK-C101_LV01_worksheets.pdf"; filename*=UTF-8''FNK-C101_LV01_worksheets.pdf`);
    assert.match(contentDisposition('مفردات.pdf'), /filename="______\.pdf"; filename\*=UTF-8''%D9/);
    assert.ok(!contentDisposition('a"b\r\n.pdf').includes('\n'));
    assert.equal(pdfName('FNK-C101_MT_LV01_S01_P01_07_v1.jpg'), 'FNK-C101_MT_LV01_S01_P01_07_v1.pdf');
    assert.equal(pdfName(null), 'worksheet.pdf');
    assert.equal(bundleName([{ courseCode: 'FNK-C101', levelCode: 'LV01' }, { courseCode: 'FNK-C101', levelCode: 'LV01' }]), 'FNK-C101_LV01_worksheets.pdf');
    assert.equal(bundleName([{ courseCode: 'FNK-C101', levelCode: 'LV01' }, { courseCode: 'FNK-C101', levelCode: 'LV02' }]), 'FNK-C101_worksheets.pdf');
    assert.equal(bundleName([{ courseCode: 'A', levelCode: 'LV01' }, { courseCode: 'B', levelCode: 'LV01' }]), 'worksheets.pdf');
  });

  test('ids, limits, fields, watermark settings', () => {
    assert.deepEqual(uniqueIds(['a', 'b', 'a', '', 3, ' c ']), ['a', 'b', 'c']);
    assert.deepEqual(uniqueIds('x'), []);
    assert.equal(MAX_FILES_PER_PDF, 60);
    assert.match(tooManyMessage(61), /at most 60/);
    assert.deepEqual(stampFieldsFrom('["name","tr","bogus"]'), ['name', 'tr']);
    assert.deepEqual(watermarkSettingFrom('{"storageKey":"assets/x.png","opacity":3,"position":"nope","scale":0.3}'), { storageKey: 'assets/x.png', opacity: 0.5, position: 'center', scale: 0.3 });
    assert.equal(validateWatermarkInput({ storageKey: 'assets/logo.png', opacity: 0.08, position: 'diagonal-tile', scale: 0.4 }).ok, true);
    assert.equal(validateWatermarkInput({ storageKey: '../etc/passwd' }).ok, false);
    assert.equal(validateWatermarkInput({ opacity: 0.9 }).ok, false);
    assert.equal(validateWatermarkInput({ position: 'top' }).ok, false);
    assert.equal(isSafeStorageKey('https://evil/x'), false);
    assert.equal(isSafeStorageKey('corrections/abc.jpg'), true);
  });

  test('student download rules', () => {
    const ok = { role: 'worksheet', is_current: true, course_status: 'published', level_status: 'published', step_status: 'published' };
    const ctx = { courseBranchIds: [], studentBranchId: 'nbo', enrolled: false };
    assert.equal(studentDownloadBlock(ok, ctx), null);
    assert.equal(studentDownloadBlock({ ...ok, is_current: 1 }, ctx), null);
    assert.match(studentDownloadBlock({ ...ok, role: 'video' }, ctx)!, /Videos/);
    assert.match(studentDownloadBlock({ ...ok, is_current: false }, ctx)!, /older version/);
    assert.match(studentDownloadBlock({ ...ok, course_status: 'draft' }, ctx)!, /not open/);
    assert.match(studentDownloadBlock({ ...ok, course_status: 'held' }, ctx)!, /paused/);
    assert.equal(studentDownloadBlock({ ...ok, course_status: 'held' }, { ...ctx, enrolled: true }), null);
    assert.match(studentDownloadBlock({ ...ok, step_status: 'hidden' }, ctx)!, /not available/);
    assert.match(studentDownloadBlock(ok, { ...ctx, courseBranchIds: ['khi'] })!, /branch/);
    assert.equal(studentDownloadBlock(ok, { ...ctx, courseBranchIds: ['khi', 'nbo'] }), null);
  });

  test('print-pack file choice', () => {
    const files = [
      { storageKey: 'w1.jpg', originalFilename: 'w1', contentType: 'image/jpeg', forStepId: 's1' },
      { storageKey: 'w2.jpg', originalFilename: 'w2', contentType: 'image/jpeg', forStepId: 's2' },
      { storageKey: 'as.jpg', originalFilename: 'as', contentType: 'image/jpeg', forStepId: 's5' },
    ];
    assert.deepEqual(pickPackFiles(files, 's5', 'assessment_only').map(f => f.storageKey), ['as.jpg']);
    assert.equal(pickPackFiles(files, 's5', 'all_files').length, 3);
    assert.deepEqual(pickPackFiles(files.slice(0, 2), 's5', 'assessment_only').map(f => f.storageKey), ['w2.jpg']);
    assert.deepEqual(pickPackFiles([{ storageKey: 'x.jpg', originalFilename: 'x', contentType: 'image/jpeg' }], 's5', 'assessment_only').length, 1);
    assert.deepEqual(pickPackFiles([], 's5', 'assessment_only'), []);
  });

  test('competitions helpers', () => {
    assert.equal(normaliseBranchIds(null), null);
    assert.equal(normaliseBranchIds('[]'), null);
    assert.deepEqual(normaliseBranchIds('["a","b","a"]'), ['a', 'b']);
    assert.equal(competitionOpenToBranch(null, 'a'), true);
    assert.equal(competitionOpenToBranch(['b'], 'a'), false);
    assert.deepEqual(normaliseExcerpts(['  Bismillah  ', { text: '', imageStorageKey: null }, { text: 'وَقُل رَّبِّ زِدْنِي عِلْمًا', note: 'Thuluth, 50×70 cm' }, { imageStorageKey: 'assets/a.png' }, 5]), [
      { id: 'x1', text: 'Bismillah', imageStorageKey: null, note: null },
      { id: 'x3', text: 'وَقُل رَّبِّ زِدْنِي عِلْمًا', imageStorageKey: null, note: 'Thuluth, 50×70 cm' },
      { id: 'x4', text: null, imageStorageKey: 'assets/a.png', note: null },
    ]);
    const today = '2026-11-10';
    const base = { status: 'open', start_date: '2026-11-01', end_date: '2026-11-30', judge_teacher_id: null };
    assert.equal(effectiveCompetitionStatus(base, today), 'open');
    assert.equal(effectiveCompetitionStatus({ ...base, start_date: '2026-12-01' }, today), 'upcoming');
    assert.equal(effectiveCompetitionStatus({ ...base, end_date: '2026-11-09' }, today), 'closed');
    assert.equal(effectiveCompetitionStatus({ ...base, end_date: '2026-11-09', judge_teacher_id: 't' }, today), 'judging');
    assert.equal(effectiveCompetitionStatus({ ...base, status: 'completed' }, today), 'completed');
    const sel = normaliseSelections([{ entryId: 'e1', label: ' Winner ', rank: 1, publishToGallery: true }, { entryId: 'e1', label: 'dup' }, { entryId: 'e2', label: '', publishToGallery: true }, { entryId: 'e3', label: 'Selected for decoration', rank: '2' }]);
    assert.ok(sel.ok);
    if (sel.ok) assert.deepEqual(sel.value, [
      { entryId: 'e1', label: 'Winner', rank: 1, publishToGallery: true },
      { entryId: 'e2', label: null, rank: null, publishToGallery: false },
      { entryId: 'e3', label: 'Selected for decoration', rank: 2, publishToGallery: false },
    ]);
    assert.equal(normaliseSelections([]).ok, false);
  });

  test('mapLimit keeps order with bounded concurrency', async () => {
    let inFlight = 0, peak = 0;
    const out = await mapLimit([5, 1, 3, 2, 4], 2, async (n) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, n));
      inFlight--;
      return n * 10;
    });
    assert.deepEqual(out, [50, 10, 30, 20, 40]);
    assert.ok(peak <= 2);
  });
});
