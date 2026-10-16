/**
 * Generates two supplementary fixtures used by the headless parity test:
 *
 *  .fixtures/fixture-attach.pdf — the 2-page fixture plus one embedded file
 *      ("spec-v2.txt"), so the Attachments panel has real data to round-trip.
 *  .fixtures/fixture-layers.pdf — the same base plus a real optional-content
 *      group ("Layer 1") marking a filled rectangle, so the Layers panel has a
 *      genuine OCG to list and toggle.
 *
 * Run: node scripts/make-panel-fixtures.mjs
 */
import * as PL from '@cantoo/pdf-lib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(dir, '..', '.fixtures');
fs.mkdirSync(out, { recursive: true });

const {
  PDFDocument, StandardFonts, PDFName, PDFString, PDFRawStream, rgb,
} = PL;

async function baseDoc() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595.28, 841.89]);
  page.drawText('AiPDF Editor panel fixture.', { x: 50, y: 780, size: 16, font, color: rgb(0, 0, 0) });
  page.drawText('Layer and attachment round-trip target.', { x: 50, y: 750, size: 12, font, color: rgb(0, 0, 0) });
  return doc;
}

/* ── fixture with an embedded file ─────────────────────────────────────── */
{
  const doc = await baseDoc();
  doc.attach(new TextEncoder().encode('AiPDF attachment round-trip fixture.'), 'spec-v2.txt', {
    mimeType: 'text/plain',
    description: 'Attached spec sheet',
  });
  fs.writeFileSync(path.join(out, 'fixture-attach.pdf'), await doc.save());
  console.log('wrote fixture-attach.pdf');
}

/* ── fixture with a real optional-content group ────────────────────────── */
{
  const doc = await baseDoc();
  const page = doc.getPage(0);

  // The OCG dictionary, referenced by the catalog's /OCProperties and named
  // in the content stream's marked-content operator.
  const ocg = doc.context.obj({
    Type: 'OCG',
    Name: PDFString.of('Layer 1'),
  });
  const ocgRef = doc.context.register(ocg);
  const catalog = doc.catalog;
  catalog.set(PDFName.of('OCProperties'), doc.context.obj({
    OCGs: [ocgRef],
    D: {
      Order: [ocgRef],
      ON: [ocgRef],
    },
  }));

  // /Layer1 must resolve through the page resources for the BDC/EMC pair to
  // associate the drawn rectangle with the group.
  page.node.set(PDFName.of('Resources'), doc.context.obj({
    Properties: { Layer1: ocgRef },
  }));

  // A translucent red square, entirely inside the optional-content group.
  const stream = PDFRawStream.of(
    doc.context.obj({}),
    new TextEncoder().encode('q /Layer1 BDC 0.8 0.1 0.1 rg 60 600 200 120 re f EMC Q'),
  );
  const contents = page.node.get(PDFName.of('Contents'));
  page.node.set(PDFName.of('Contents'), doc.context.obj([
    contents,
    doc.context.register(stream),
  ]));

  fs.writeFileSync(path.join(out, 'fixture-layers.pdf'), await doc.save());
  console.log('wrote fixture-layers.pdf');
}
