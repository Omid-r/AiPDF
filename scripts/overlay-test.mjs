#!/usr/bin/env node
/**
 * Overlay integration test — the first tool in the batch-documents set.
 *
 * Builds two real PDFs, applies one as an overlay through the app's own
 * pdfwrite pipeline, and verifies the result with pdf.js (render + text) and
 * by inspecting the saved content operators directly. A broken overlay would
 * either throw inside buildPdf or produce a file that no longer renders.
 *
 *   node scripts/overlay-test.mjs
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PDFDocument as PdfLibDoc, StandardFonts, rgb } from '@cantoo/pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let n = 0;
function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { n++; console.log(`PASS  ${name}`); })
    .catch((e) => { console.log(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; });
}

/* Fixtures: a 2-page base doc and a 1-page "letterhead". */
async function makeBase() {
  const doc = await PdfLibDoc.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 2; i++) {
    const p = doc.addPage([400, 400]);
    p.drawText(`BASE page ${i + 1}`, { x: 40, y: 320, size: 18, font, color: rgb(0.1, 0.1, 0.1) });
  }
  return doc.save();
}

async function makeLetterhead() {
  const doc = await PdfLibDoc.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([400, 400]);
  p.drawRectangle({ x: 0, y: 350, width: 400, height: 50, color: rgb(0.85, 0.1, 0.1) });
  p.drawText('LETTERHEAD', { x: 40, y: 364, size: 22, font, color: rgb(1, 1, 1) });
  return doc.save();
}

const baseBytes = await makeBase();
const headBytes = await makeLetterhead();

/* The app serves standard-font metrics from /v/stdfonts/ (viewer.js); point
   pdf.js at the same files on disk or every Helvetica page warns and its text
   may read back empty. Buffer in -> never a plain Uint8Array, hence the copy. */
const STD_FONT_DATA_URL = path.join(ROOT, 'node_modules', 'pdfjs-dist', 'standard_fonts') + path.sep;
const openPdf = (bytes) => pdfjs.getDocument({
  data: Uint8Array.from(bytes),
  useSystemFonts: false,
  standardFontDataUrl: STD_FONT_DATA_URL,
}).promise;

const { loadRenderer } = await import('./lib/loadRenderer.mjs');
const { buildPdf } = await loadRenderer('pdfwrite.js');

/** Extract the raw operator text of a saved page's content streams. */
async function pageOperators(bytes, pageNo) {
  const doc = await openPdf(bytes);
  const page = await doc.getPage(pageNo);
  const ops = await page.getOperatorList();
  const out = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const f = ops.fnArray[i];
    const a = ops.argsArray[i];
    if (f === pdfjs.OPS.paintXObject || f === pdfjs.OPS.drawObject) out.push('XObject');
    if (typeof f === 'number') out.push(pdfjs.OPS[f] || String(f));
  }
  doc.destroy();
  return { names: out, count: ops.fnArray.length };
}

/** Minimal document model in the shape buildPdf expects for the overlay path. */
function overlayModel(opts = {}) {
  return {
    bytes: baseBytes,
    numPages: 2,
    password: null,
    overlay: {
      bytes: headBytes,
      pages: [0],
      x: opts.x ?? 0,
      y: opts.y ?? 0,
      scale: opts.scale ?? 1,
      opacity: opts.opacity ?? 1,
      fit: opts.fit ?? false,
    },
    pageOps: null, pageRotate: {}, crops: {}, stamps: [], annots: [],
    textEdits: [], newFields: [], ocr: null,
  };
}

async function textOf(bytes) {
  const doc = await openPdf(bytes);
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    out.push(tc.items.map((x) => x.str).join(' '));
  }
  doc.destroy();
  return out;
}

await t('overlay applies without throwing', async () => {
  const bytes = await buildPdf(overlayModel(), {});
  assert.ok(bytes.length > 1000, 'output is non-trivial');
  assert.equal(bytes[0], 0x25); // '%'
});

await t('overlay renders: the letterhead text is now on the page', async () => {
  const out = await buildPdf(overlayModel(), {});
  const pages = await textOf(out);
  assert.match(pages[0], /BASE page 1/, 'original text survives');
  assert.match(pages[0], /LETTERHEAD/, 'overlay text is present');
  assert.match(pages[1], /BASE page 2/, 'second page also overlaid');
  assert.match(pages[1], /LETTERHEAD/, 'overlay applied to every page');
});

await t('overlay scales content', async () => {
  const out = await buildPdf(overlayModel({ scale: 0.5 }), {});
  const pages = await textOf(out);
  assert.match(pages[0], /LETTERHEAD/, 'still drawn at 50%');
});

/** Find the y of the overlay's "LETTERHEAD" run in a rendered page. */
async function letterheadY(bytes, pageNo = 1) {
  const doc = await openPdf(bytes);
  const tc = await (await doc.getPage(pageNo)).getTextContent();
  doc.destroy();
  for (const it of tc.items) {
    if (/LETTERHEAD/.test(it.str)) return it.transform[5];
  }
  return null;
}

await t('overlay respects a non-zero offset', async () => {
  const plain = await buildPdf(overlayModel(), {});
  // A negative offset keeps the letterhead on the page so pdf.js still reports
  // it, and the measured shift must match exactly.
  const shifted = await buildPdf(overlayModel({ y: -40 }), {});
  const y0 = await letterheadY(plain);
  const y1 = await letterheadY(shifted);
  assert.ok(y0 != null, `letterhead found without offset (y=${y0})`);
  assert.ok(y1 != null, `letterhead found after offset (y=${y1})`);
  assert.equal(Math.round(y1 - y0), -40, `expected -40 shift, got ${Math.round(y1 - y0)}`);
});

await t('opacity < 1 does not corrupt the file', async () => {
  const out = await buildPdf(overlayModel({ opacity: 0.4 }), {});
  const pages = await textOf(out);
  assert.match(pages[0], /LETTERHEAD/);
  assert.match(pages[0], /BASE page 1/);
});

await t('fit mode scales to the page without error', async () => {
  const out = await buildPdf(overlayModel({ fit: true }), {});
  const pages = await textOf(out);
  assert.match(pages[0], /LETTERHEAD/);
});

await t('an unparseable overlay degrades gracefully, document intact', async () => {
  const m = overlayModel();
  m.overlay = { ...m.overlay, bytes: new Uint8Array([1, 2, 3, 4]) };
  const out = await buildPdf(m, {});
  const pages = await textOf(out);
  assert.match(pages[0], /BASE page 1/, 'base document is untouched');
  assert.doesNotMatch(pages[0] || '', /LETTERHEAD/, 'no overlay content leaked');
});

await t('a page range restricts which overlay pages are used', async () => {
  const out = await buildPdf(overlayModel({ pages: [] }), {});
  const pages = await textOf(out);
  assert.match(pages[0], /LETTERHEAD/, 'empty list means "all pages of the overlay"');
});

await t('overlay output re-opens in pdf-lib for further editing', async () => {
  const out = await buildPdf(overlayModel(), {});
  const again = await PdfLibDoc.load(out);
  assert.equal(again.getPageCount(), 2);
});

console.log(`\n${n} checks passed`);
