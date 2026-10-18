#!/usr/bin/env node
/**
 * Build .fixtures/table-realworld.pdf — three ruled tables modelled on the
 * real-world failure report ("10 cells, only 4 editable blocks"): a 5-column
 * × 2-row Nepali-tender-style table whose cells hold multi-line text, drawn
 * three different ways real generators do it:
 *
 *   T1  borders as thin FILLED rectangles (Word/LibreOffice `re f`) — each
 *       rule is a pair of parallel edges ~0.8 apart that must be merged
 *   T2  borders as strokes whose lines DON'T QUITE TOUCH (0.6pt gaps at the
 *       junctions) — grid connectivity must tolerate near-misses
 *   T3  borders as plain strokes (control — the shipped fixture's style)
 *
 *   node scripts/make-table-realworld-fixture.mjs
 */
import { PDFDocument, StandardFonts, rgb } from '@cantoo/pdf-lib';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.fixtures', 'table-realworld.pdf');

const doc = await PDFDocument.create();
const page = doc.addPage([595, 842]);
const font = await doc.embedFont(StandardFonts.Helvetica);
const black = rgb(0, 0, 0);

page.drawText('Real-world table structure test', { x: 50, y: 790, size: 14, font, color: black });

/* Six x-edges = five real columns (portrait, like the tender sheet: narrow id,
 * two wide text columns, an amount, a remarks column). Text in every column
 * starts just inside its own left edge. */
const XS = [40, 105, 275, 455, 530, 570];

/* Two rows: a 2-line header and a 3-line data row — the "10 cells" case is
 * 5 columns × 2 rows, every cell independent. */
const HEADER = [
  ['S.N.'],
  ['Project name'],
  ['Contractor awarded,', 'company address'],
  ['Bid amount', '(incl. VAT &', 'PS)'],
  ['Remarks'],
];
const DATA = [
  ['RP/33701119-', '4/083/84-3'],
  ['Upgrading (Blacktop', 'Works) of Benighat-', 'Arughat-Larke Road'],
  ['M/S Mandali Builders,', 'Siranchowk-05,', 'Gorkha'],
  ['18,522,961.22'],
  [], // empty remarks cell — a place to type, not a duplicate
];

function drawCellText(y0, rowH, lines, colIndex, size = 8.5) {
  const x = XS[colIndex] + 4;
  let ty = y0 + rowH - size - 4;
  for (const line of lines) {
    if (line) page.drawText(line, { x, y: ty, size, font, color: black });
    ty -= size + 2.5;
  }
}

/** One table with row heights [headerH, dataH], top edge at yTop. */
function drawTable(yTop, headerH, dataH, style) {
  const ys = [yTop - headerH - dataH, yTop - headerH, yTop];
  const X0 = XS[0], X1 = XS[XS.length - 1];
  const vSegs = XS.map((x) => [x, ys[0], ys[2]]);
  const hSegs = ys.map((y) => [y, X0, X1]);

  const stroke = (x0, y0, x1, y1) =>
    page.drawLine({ start: { x: x0, y: y0 }, end: { x: x1, y: y1 }, thickness: 1, color: black });
  const fillRect = (x0, y0, x1, y1) => {
    const t = 0.8;
    if (Math.abs(x1 - x0) < 2) page.drawRectangle({ x: x0 - t / 2, y: y0, width: t, height: y1 - y0, color: black });
    else page.drawRectangle({ x: x0, y: y0 - t / 2, width: x1 - x0, height: t, color: black });
  };

  for (const [x, y0, y1] of vSegs) {
    if (style === 'fill') fillRect(x, y0, x, y1);
    else if (style === 'gap') stroke(x, y0 + 0.6, x, y1 - 0.6); // near-miss junctions
    else stroke(x, y0, x, y1);
  }
  for (const [y, x0, x1] of hSegs) {
    if (style === 'fill') fillRect(x0, y, x1, y);
    else if (style === 'gap') stroke(x0 + 0.6, y, x1 - 0.6, y);
    else stroke(x0, y, x1, y);
  }

  drawCellText(ys[1], headerH, HEADER[0], 0);
  drawCellText(ys[1], headerH, HEADER[1], 1);
  drawCellText(ys[1], headerH, HEADER[2], 2);
  drawCellText(ys[1], headerH, HEADER[3], 3);
  drawCellText(ys[1], headerH, HEADER[4], 4);
  drawCellText(ys[0], dataH, DATA[0], 0);
  drawCellText(ys[0], dataH, DATA[1], 1);
  drawCellText(ys[0], dataH, DATA[2], 2);
  drawCellText(ys[0], dataH, DATA[3], 3);
  drawCellText(ys[0], dataH, DATA[4], 4);
  return yTop - headerH - dataH;
}

let y = 760;
y = drawTable(y, 34, 46, 'fill') - 40;   // T1 — Word-style filled-rect rules
page.drawText('T1 fill-rect rules', { x: 50, y: y + 18, size: 9, font, color: black });
y = drawTable(y, 34, 46, 'gap') - 40;    // T2 — strokes with 0.6pt junction gaps
page.drawText('T2 gapped strokes', { x: 50, y: y + 18, size: 9, font, color: black });
y = drawTable(y, 34, 46, 'stroke') - 40; // T3 — control: clean strokes
page.drawText('T3 clean strokes', { x: 50, y: y + 18, size: 9, font, color: black });

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, await doc.save());
console.log('WROTE ' + OUT);
