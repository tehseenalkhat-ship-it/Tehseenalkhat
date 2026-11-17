// Builds a print-pack-like scanned PDF (QR "KHAT:<code>:<page>" in the top-right corner of each page)
// using pdf-lib + qrcode from khat-backend/node_modules. Run: node make_fixtures.cjs
const path = require('path');
const req = require('module').createRequire(path.resolve(__dirname, '../../../khat-backend/package.json'));
const { PDFDocument, rgb, StandardFonts, degrees } = req('pdf-lib');
const QRCode = req('qrcode');
const fs = require('fs');
(async () => {
  const sheet = fs.readFileSync(path.join(__dirname, 'fixtures/assess.png'));
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const img = await doc.embedPng(sheet);
  const pages = [
    { code: 'TK-7F3K2', n: 1, name: 'Fatema Saifuddin', rotate: false },
    { code: 'TK-AB12C', n: 1, name: 'Mustafa Ezzi', rotate: true },
    { code: null, n: 0, name: '', rotate: false },
    { code: 'TK-7F3K2', n: 2, name: 'Fatema Saifuddin', rotate: false },
  ];
  for (const p of pages) {
    const page = doc.addPage([595, 842]);
    page.drawImage(img, { x: 30, y: 30, width: 535, height: 735 });
    if (p.code) {
      page.drawRectangle({ x: 0, y: 782, width: 595, height: 60, color: rgb(0.95, 0.96, 0.97) });
      page.drawText(`${p.name} · FNK-C101 LV01 S05 · ${p.code} · page ${p.n}`, { x: 24, y: 806, size: 11, font, color: rgb(0.1, 0.15, 0.2) });
      const png = await QRCode.toBuffer(`KHAT:${p.code}:${p.n}`, { margin: 1, width: 240, errorCorrectionLevel: 'M' });
      const qr = await doc.embedPng(png);
      page.drawImage(qr, { x: 533, y: 784, width: 54, height: 54 });
    }
    if (p.rotate) page.setRotation(degrees(180));
  }
  fs.writeFileSync(path.join(__dirname, 'fixtures/scan.pdf'), await doc.save());
  // A 1-page worksheet PDF for the thread
  const w = await PDFDocument.create();
  const wi = await w.embedPng(fs.readFileSync(path.join(__dirname, 'fixtures/sheet2.png')));
  const wp = w.addPage([595, 842]);
  wp.drawImage(wi, { x: 0, y: 0, width: 595, height: 842 });
  fs.writeFileSync(path.join(__dirname, 'fixtures/worksheet.pdf'), await w.save());
  // A single scanned photo (JPEG-like PNG) with QR in the bottom-left
  console.log('fixtures written');
})();
