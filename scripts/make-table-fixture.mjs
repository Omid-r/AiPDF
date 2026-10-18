#!/usr/bin/env node
/**
 * Build .fixtures/table.pdf — a page with a ruled 3×3 table and a borderless
 * 2×2 table — for the Direct Editor table tests.
 *
 *   node scripts/make-table-fixture.mjs
 */
import { PDFDocument, StandardFonts, rgb } from '@cantoo/pdf-lib';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.fixtures', 'table.pdf');

const doc = await PDFDocument.create();
const page = doc.addPage([595, 842]);
const font = await doc.embedFont(StandardFonts.Helvetica);
const black = rgb(0, 0, 0);

page.drawText('Table structure test', { x: 50, y: 780, size: 16, font, color: black });

/* Ruled 3×3 table. Boundaries: x 50/150/270/390, y 600/630/660/690. */
const xs = [50, 150, 270, 390];
const ys = [600, 630, 660, 690];
for (const x of xs) page.drawLine({ start: { x, y: ys[0] }, end: { x, y: ys[ys.length - 1] }, thickness: 1, color: black });
for (const y of ys) page.drawLine({ start: { x: xs[0], y }, end: { x: xs[xs.length - 1], y }, thickness: 1, color: black });

// Rows are drawn top-down for the label; the geometry is bottom-up.
for (let r = 0; r < 3; r++) {
  const y0 = ys[2 - r];                 // bottom of this row
  for (let c = 0; c < 3; c++) {
    page.drawText(`${'ABC'[c]}${r + 1}`, { x: xs[c] + 8, y: y0 + 8, size: 11, font, color: black });
  }
}

/* Borderless 2×2 table. Columns: 50..150 and 170..270. Rows: 440..460, 480..500. */
const bx = [[50, 150], [170, 270]];
const by = [[440, 460], [480, 500]];
for (let r = 0; r < 2; r++) {
  for (let c = 0; c < 2; c++) {
    page.drawText(`${'XY'[c]}${r + 1}`, { x: bx[c][0] + 8, y: by[r][0] + 8, size: 11, font, color: black });
  }
}

/* Ruled 3×3 table whose cells are laid out close enough together that text-block
 * grouping merges the whole row into ONE block — one Tj per cell, but the gap
 * between cells is under 1.5em, which is how dense real-world tables look. That
 * single row block is the reported bug: a click in any cell edits the whole row.
 * Each cell label is `<id>` + filler so a split is unambiguous. */
const mx = [50, 120, 190, 260];                  // 70pt columns
const my = [300, 330, 360, 390];
for (const x of mx) page.drawLine({ start: { x, y: my[0] }, end: { x, y: my[my.length - 1] }, thickness: 1, color: black });
for (const y of my) page.drawLine({ start: { x: mx[0], y }, end: { x: mx[mx.length - 1], y }, thickness: 1, color: black });
const FILL = 'abcdefghij';
for (let r = 0; r < 3; r++) {
  const y0 = my[2 - r];
  for (let c = 0; c < 3; c++) {
    page.drawText(`${'PQR'[c]}${r + 1}${FILL}`, { x: mx[c] + 2, y: y0 + 9, size: 10, font, color: black });
  }
}

const bytes = await doc.save();
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, bytes);
console.log(`wrote ${OUT} (${bytes.length} bytes)`);
