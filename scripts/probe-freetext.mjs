/**
 * Probe: what does pdf.js actually hand back for a FreeText annotation?
 * Writes a FreeText with a Times-Bold font, red text, size 14 and /Q 1
 * (centred), then dumps the raw annotation keys pdf.js exposes.
 * Uses the same pdfjs-dist build the app serves.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { PDFDocument, PDFName, PDFString, PDFNumber } from '@cantoo/pdf-lib';
import * as pdfjs from 'pdfjs-dist/build/pdf.min.mjs';

const pdfDoc = await PDFDocument.create();
const page = pdfDoc.addPage([600, 800]);
const helv = await pdfDoc.embedFont('Helvetica');

const ann = pdfDoc.context.obj({
  Type: PDFName.of('Annot'),
  Subtype: PDFName.of('FreeText'),
  Rect: [100, 600, 300, 660],
  Contents: PDFString.of('Hello probe'),
  DA: PDFString.of('/Times-Bold 14 Tf 1 0 0 rg'),
  Q: PDFNumber.of(1),
  F: PDFNumber.of(4),
});
const annRef = pdfDoc.context.register(ann);
page.node.set(PDFName.of('Annots'), pdfDoc.context.obj([annRef]));

const bytes = await pdfDoc.save();
writeFileSync('.smoke/probe-freetext.pdf', bytes);

const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }).promise;
const p1 = await doc.getPage(1);
const annots = await p1.getAnnotations();
console.log('annotation count:', annots.length);
for (const a of annots) {
  console.log('--- raw keys ---');
  for (const k of Object.keys(a)) {
    const v = a[k];
    const shown = (v && typeof v === 'object') ? JSON.stringify(v).slice(0, 120) : String(v);
    console.log(`  ${k} = ${shown}`);
  }
  console.log('--- interesting fields ---');
  console.log('  defaultAppearance  :', JSON.stringify(a.defaultAppearance));
  console.log('  textAlign          :', JSON.stringify(a.textAlign));
  console.log('  textAlignment      :', JSON.stringify(a.textAlignment));
  console.log('  fontSize           :', JSON.stringify(a.fontSize));
  console.log('  fontColor          :', JSON.stringify(a.fontColor));
  console.log('  color              :', JSON.stringify(a.color));
  console.log('  backgroundColor    :', JSON.stringify(a.backgroundColor));
}
