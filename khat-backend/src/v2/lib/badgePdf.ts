/**
 * v3 builder — the printable badge (A4 landscape PDF): the admin-uploaded artwork,
 * the student's name, what it was earned for and the date. Plain enough to print
 * at home and to upload to JHS. Pure: bytes in → bytes out.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import { detectKind, fitText, formatStampDate, pdfSafeText } from './pdfStamp.js';

export type BadgePdfInput = {
  studentName: string;
  trNumber?: string | null;
  branchName?: string | null;
  title: string;            // 'Level 1 completed'
  subtitle: string;         // 'Fann al-Khat 1 · Certification course'
  awardedAt: Date;
  badgeId: string;          // printed small, so a teacher can check it
  artwork?: Uint8Array | null;
  sample?: boolean;         // admin preview: says SAMPLE in the corner
};

const INK = rgb(0.13, 0.15, 0.2);
const SOFT = rgb(0.4, 0.42, 0.46);
const GOLD = rgb(0.62, 0.49, 0.22);
const GOLD_LIGHT = rgb(0.86, 0.78, 0.58);
const PAPER = rgb(0.995, 0.99, 0.975);

const W = 841.89;
const H = 595.28;

async function embedArtwork(doc: PDFDocument, bytes: Uint8Array | null | undefined): Promise<PDFImage | null> {
  if (!bytes?.length) return null;
  try {
    const kind = detectKind(bytes);
    if (kind === 'png') return await doc.embedPng(bytes);
    if (kind === 'jpg') return await doc.embedJpg(bytes);
  } catch { /* a broken image must never stop the download */ }
  return null;
}

function centred(page: PDFPage, text: string, y: number, font: PDFFont, size: number, color = INK, maxWidth = W - 160) {
  const fit = fitText(pdfSafeText(text), font, maxWidth, size, Math.max(8, size * 0.55));
  const tw = font.widthOfTextAtSize(fit.text, fit.size);
  page.drawText(fit.text, { x: (W - tw) / 2, y, size: fit.size, font, color });
}

/** Simple seal used until the master team uploads badge artwork. */
function drawSeal(page: PDFPage, cx: number, cy: number, r: number, font: PDFFont) {
  page.drawCircle({ x: cx, y: cy, size: r, color: rgb(0.97, 0.94, 0.86), borderColor: GOLD, borderWidth: 2.5 });
  page.drawCircle({ x: cx, y: cy, size: r - 9, borderColor: GOLD_LIGHT, borderWidth: 1 });
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    page.drawCircle({ x: cx + Math.cos(a) * (r - 4.5), y: cy + Math.sin(a) * (r - 4.5), size: 1.6, color: GOLD });
  }
  const t = 'FUNUN';
  const t2 = 'AL-QURAN';
  page.drawText(t, { x: cx - font.widthOfTextAtSize(t, 15) / 2, y: cy + 2, size: 15, font, color: GOLD });
  page.drawText(t2, { x: cx - font.widthOfTextAtSize(t2, 10) / 2, y: cy - 14, size: 10, font, color: GOLD });
}

export async function buildBadgePdf(input: BadgePdfInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([W, H]);
  const serif = await doc.embedFont(StandardFonts.TimesRoman);
  const serifBold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const sans = await doc.embedFont(StandardFonts.Helvetica);
  const sansBold = await doc.embedFont(StandardFonts.HelveticaBold);

  page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: PAPER });
  page.drawRectangle({ x: 22, y: 22, width: W - 44, height: H - 44, borderColor: GOLD, borderWidth: 2 });
  page.drawRectangle({ x: 30, y: 30, width: W - 60, height: H - 60, borderColor: GOLD_LIGHT, borderWidth: 0.8 });

  centred(page, 'FUNUN AL-QURAN  ·  AL-JAMEA-TUS-SAIFIYAH', H - 70, sansBold, 10, GOLD);
  centred(page, 'Tehseen al-Khat', H - 88, serif, 12, SOFT);

  // artwork box
  const boxTop = H - 108;
  const boxH = 210;
  const art = await embedArtwork(doc, input.artwork);
  if (art) {
    const scale = Math.min(300 / art.width, boxH / art.height);
    const w = art.width * scale;
    const h = art.height * scale;
    page.drawImage(art, { x: (W - w) / 2, y: boxTop - h - (boxH - h) / 2, width: w, height: h });
  } else {
    drawSeal(page, W / 2, boxTop - boxH / 2, 82, serifBold);
  }

  let y = boxTop - boxH - 34;
  centred(page, 'This badge is awarded to', y, serif, 13, SOFT);
  y -= 38;
  centred(page, input.studentName || 'Student', y, serifBold, 30, INK);
  y -= 16;
  page.drawLine({ start: { x: W / 2 - 150, y }, end: { x: W / 2 + 150, y }, thickness: 0.8, color: GOLD_LIGHT });
  y -= 30;
  centred(page, input.title, y, serifBold, 19, GOLD);
  y -= 22;
  if (input.subtitle) centred(page, input.subtitle, y, serif, 13, INK);
  y -= 20;
  const who = [input.trNumber ? `TR ${input.trNumber}` : null, input.branchName].filter(Boolean).join('  ·  ');
  centred(page, [`Awarded on ${formatStampDate(input.awardedAt).replace(/,?\s+\d{1,2}:\d{2}.*$/, '')}`, who].filter(Boolean).join('  ·  '), y, sans, 10, SOFT);

  const foot = `Badge ID ${input.badgeId.slice(0, 8).toUpperCase()}  ·  You may print this badge or upload it to your JHS profile.`;
  centred(page, foot, 44, sans, 8, SOFT);
  if (input.sample) page.drawText('SAMPLE', { x: W - 100, y: H - 56, size: 14, font: sansBold, color: rgb(0.8, 0.8, 0.82) });

  doc.setTitle(`${pdfSafeText(input.title)} - ${pdfSafeText(input.studentName)}`);
  doc.setAuthor('Funun al-Quran, Al-Jamea-tus-Saifiyah');
  doc.setCreator('Tehseen al-Khat');
  doc.setProducer('Tehseen al-Khat');
  return doc.save();
}
