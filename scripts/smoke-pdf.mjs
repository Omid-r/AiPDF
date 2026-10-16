/**
 * Node smoke test for the pdf-lib operations the editor relies on.
 * Run: node scripts/smoke-pdf.mjs
 */
import * as PL from '@cantoo/pdf-lib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(dir, '..', '.smoke');
fs.mkdirSync(out, { recursive: true });

const { PDFDocument, StandardFonts, PDFName, PDFNumber, PDFString, PDFHexString, PDFRawStream, degrees, rgb } = PL;

const ok = [];
const bad = [];
const t = async (name, fn) => {
  try { await fn(); ok.push(name); } catch (e) { bad.push(`${name}: ${e.message}`); }
};

let doc;
await t('create + page + drawText', async () => {
  doc = await PDFDocument.create();
  const p = doc.addPage([595.28, 841.89]);
  const f = await doc.embedFont(StandardFonts.Helvetica);
  p.drawText('Hello', { x: 50, y: 700, size: 14, font: f, color: rgb(0, 0, 0), rotate: degrees(90) });
  p.drawRectangle({ x: 10, y: 10, width: 100, height: 40, color: rgb(1, 1, 1), borderWidth: 0 });
});

let annotRef;
await t('annot dict + appearance stream', async () => {
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.getPage(0);
  const dict = doc.context.obj({
    Type: 'Annot', Subtype: 'FreeText',
    Rect: [50, 700, 250, 740],
    F: 4,
    C: [1, 0.8, 0.2],
    T: PDFHexString.fromText('Tester'),
    M: PDFString.of('D:20260101000000Z'),
  });
  dict.set(PDFName.of('Contents'), PDFHexString.fromText('Note body'));
  dict.set(PDFName.of('CA'), PDFNumber.of(0.5));
  dict.set(PDFName.of('QuadPoints'), doc.context.obj([50, 740, 250, 740, 50, 700, 250, 700]));
  const apDict = doc.context.obj({
    Type: 'XObject', Subtype: 'Form', BBox: [50, 700, 250, 740],
    Resources: { Font: { [font.name]: font.ref } },
  });
  const stream = PDFRawStream.of(apDict, new TextEncoder().encode('q BT /F1 12 Tf 1 0 0 1 50 710 Tm (hi) Tj ET Q'));
  const apRef = doc.context.register(stream);
  dict.set(PDFName.of('AP'), doc.context.obj({ N: apRef }));
  annotRef = doc.context.register(dict);
  page.node.set(PDFName.of('Annots'), doc.context.obj([annotRef]));
});

await t('prepend content stream', async () => {
  const page = doc.getPage(0);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const d = doc.context.obj({ Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 595, 842], Resources: { Font: { [font.name]: font.ref } } });
  const s = PDFRawStream.of(d, new TextEncoder().encode('q BT /F1 40 Tf 0.5 0.5 0.5 rg 1 0 0 1 100 400 Tm (DRAFT) Tj ET Q'));
  const ref = doc.context.register(s);
  const cur = page.node.Contents();
  const arr = doc.context.obj([]);
  arr.push(ref);
  if (cur) arr.push(cur);
  page.node.set(PDFName.of('Contents'), arr);
});

let saved;
await t('save', async () => {
  saved = await doc.save({ useObjectStreams: true });
  fs.writeFileSync(path.join(out, 'basic.pdf'), saved);
  if (saved.length < 500) throw new Error('suspiciously small output');
});

await t('reload + Annots lookup', async () => {
  const d2 = await PDFDocument.load(saved, { updateMetadata: false });
  const page = d2.getPage(0);
  const annots = page.node.Annots();
  if (!annots) throw new Error('no /Annots after reload');
  const arr = annots.asArray();
  if (!arr.length) throw new Error('empty /Annots');
  const first = d2.context.lookup(arr[0]);
  const sub = first.get(PDFName.of('Subtype'));
  if (!sub || sub.asString() !== '/FreeText') throw new Error('subtype mismatch: ' + sub?.asString());
});
await t('widget filter helpers', async () => {
  const d2 = await PDFDocument.load(saved, { updateMetadata: false });
  const page = d2.getPage(0);
  const annots = page.node.Annots();
  const keep = [];
  for (const ref of annots.asArray()) {
    const dd = d2.context.lookup(ref);
    const sub = dd && dd.get && dd.get(PDFName.of('Subtype'));
    if (sub && (sub === PDFName.of('Widget') || (sub.asString && sub.asString() === '/Widget'))) keep.push(ref);
  }
  if (keep.length !== 0) throw new Error('expected zero widget annots');
});

await t('copyPages + setRotation', async () => {
  const d2 = await PDFDocument.load(saved, { updateMetadata: false });
  const out2 = await PDFDocument.create();
  const pages = await out2.copyPages(d2, [0, 0]);
  pages.forEach((p, i) => { out2.addPage(p); if (i === 1) p.setRotation(degrees(90)); });
  const b = await out2.save();
  fs.writeFileSync(path.join(out, 'copied.pdf'), b);
});

await t('encrypt (AES-256)', async () => {
  const d2 = await PDFDocument.load(saved, { updateMetadata: false });
  d2.encrypt({
    userPassword: 'user123', ownerPassword: 'owner123',
    permissions: { printing: 'highResolution', modifying: false, copying: false, annotating: true, fillingForms: true, contentAccessibility: true, documentAssembly: false },
  });
  const b = await d2.save();
  fs.writeFileSync(path.join(out, 'encrypted.pdf'), b);
  const d3 = await PDFDocument.load(b, { updateMetadata: false, ignoreEncryption: true });
  if (!d3.isEncrypted) throw new Error('not encrypted after reload');
});
await t('encrypt + open with password round-trip', async () => {
  const c = await PDFDocument.create();
  c.addPage([200, 200]).drawText('secret', { size: 12 });
  c.encrypt({ userPassword: 'open123', ownerPassword: 'own123' });
  const b = await c.save();
  const opened = await PDFDocument.load(b, { password: 'open123', updateMetadata: false });
  if (opened.getPageCount() !== 1) throw new Error('could not decrypt with user password');
});

await t('form fields', async () => {
  const d = await PDFDocument.create();
  const p = d.addPage([595, 842]);
  const form = d.getForm();
  const tf = form.createTextField('name');
  tf.addToPage(p, { x: 50, y: 700, width: 200, height: 20 });
  tf.setText('Ada');
  const cb = form.createCheckBox('agree');
  cb.addToPage(p, { x: 50, y: 670, width: 16, height: 16 });
  cb.check();
  const dd = form.createDropdown('pick');
  dd.addOptions(['a', 'b']);
  dd.addToPage(p, { x: 50, y: 640, width: 100, height: 20 });
  dd.select('b');
  const b = await d.save();
  fs.writeFileSync(path.join(out, 'form.pdf'), b);
  const d2 = await PDFDocument.load(b, { updateMetadata: false });
  const f2 = d2.getForm();
  if (f2.getTextField('name').getText() !== 'Ada') throw new Error('text field round-trip failed');
  if (!f2.getCheckBox('agree').isChecked()) throw new Error('checkbox round-trip failed');
  if (f2.getDropdown('pick').getSelected()[0] !== 'b') throw new Error('dropdown round-trip failed');
  const widgets = [];
  for (const w of f2.getField('name').acroField.getWidgets()) {
    const r = w.getRectangle();
    widgets.push([r.x, r.y, r.x + r.width, r.y + r.height]);
  }
  if (!widgets.length) throw new Error('no widgets found');
});

await t('embedPng', async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8DAwMDAxMDAwMAAAA4AAwHwbXkAAAAASUVORK5CYII=',
    'base64'
  );
  const d = await PDFDocument.create();
  const p = d.addPage([200, 200]);
  const img = await d.embedPng(new Uint8Array(png));
  p.drawImage(img, { x: 0, y: 0, width: 100, height: 100, opacity: 0.5, rotate: degrees(45), xOrigin: 50, yOrigin: 50 });
  await d.save();
});

console.log('\nPASS:');
ok.forEach((o) => console.log('  ✓ ' + o));
if (bad.length) {
  console.log('\nFAIL:');
  bad.forEach((b) => console.log('  ✗ ' + b));
  process.exit(1);
}
console.log('\nAll pdf-lib smoke checks passed. Output in', out);
