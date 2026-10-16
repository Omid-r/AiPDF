#!/usr/bin/env node
/**
 * Wrap .fixtures/scan-page.png in a PDF that contains NO text operators —
 * a faithful stand-in for a flatbed scan, used by the OCR tests.
 *
 *   node scripts/make-scan-pdf.mjs [pages]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as PL from '@cantoo/pdf-lib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, '.fixtures', 'scan-page.png');
const DST = path.join(ROOT, '.fixtures', 'scan.pdf');
const PAGES = Number(process.argv[2] || 1);

const png = fs.readFileSync(SRC);
const pdf = await PL.PDFDocument.create();
const img = await pdf.embedPng(png);

// A4 in points; the image was rendered at 300 DPI for exactly this size.
const W = 595.28, H = 841.89;
for (let i = 0; i < PAGES; i++) {
  const page = pdf.addPage([W, H]);
  page.drawImage(img, { x: 0, y: 0, width: W, height: H });
}
fs.writeFileSync(DST, await pdf.save());
console.log(`wrote ${DST} (${(fs.statSync(DST).size / 1024).toFixed(0)} KB, ${PAGES} page(s), no text operators)`);
