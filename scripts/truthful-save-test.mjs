#!/usr/bin/env node
/**
 * Proves the writer's removal contract: a replaced run is GONE from the file,
 * not hidden under a white rectangle.
 *
 * This is the engine half of the check. It builds a synthetic page, removes one
 * owned run through the same `exciseText` the writer calls, inserts a
 * replacement, then re-reads the saved bytes with pdf.js — an independent
 * extractor, so "the words are gone" is not this code marking its own homework.
 *
 *   node scripts/truthful-save-test.mjs
 */
import { deflateSync, inflateSync } from 'node:zlib';
import * as PL from '@cantoo/pdf-lib';
import { exciseText, walkTextBlocks } from '../src/renderer/js/textops.js';

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const inflate = async (b) => inflateSync(b);

/** Independent reader: pdf.js is a different codebase from the writer. */
async function extract(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const d = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
  let out = '';
  for (let i = 1; i <= d.numPages; i++) {
    const p = await d.getPage(i);
    const tc = await p.getTextContent();
    out += tc.items.map((it) => it.str).join('\n') + '\n';
  }
  await d.destroy?.();
  return out;
}

/* ── Build a page with three clearly separated lines ─────────────────────── */

async function makeDoc() {
  const doc = await PL.PDFDocument.create();
  const font = await doc.embedFont(PL.StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText('KEEPFIRST line stays put', { x: 50, y: 700, size: 14, font });
  page.drawText('REMOVEME owned by the edit', { x: 50, y: 660, size: 14, font });
  page.drawText('KEEPLAST line also stays', { x: 50, y: 620, size: 14, font });
  return { doc, page, font };
}

const before = await makeDoc();
const beforeText = await extract(await before.doc.save());
check('the synthetic page extracts all three lines', ['KEEPFIRST', 'REMOVEME', 'KEEPLAST'].every((s) => beforeText.includes(s)), JSON.stringify(beforeText.replace(/\n/g, '|')));

/* ── The rect that owns exactly the middle line ──────────────────────────── */

const ownedRect = [45, 645, 350, 678];

/** Append raw operators as a NEW content stream — exactly what the writer's
 *  appendPageOps does, and deliberately NOT page.drawText: pdf-lib's own
 *  content-stream object is a different shape from the one exciseText writes
 *  back, so drawing through pdf-lib after an excision is not the writer's path. */
function appendOps(doc, page, body) {
  const stream = doc.context.register(doc.context.flateStream(body));
  const cur = page.node.Contents();
  const arr = cur instanceof PL.PDFArray ? cur.asArray() : (cur ? [cur] : []);
  page.node.set(PL.PDFName.of('Contents'), doc.context.obj([...arr, stream]));
}

function drawLine(doc, page, font, text, x, y, size = 14) {
  const key = page.node.newFontDictionary(font.name, font.ref);
  appendOps(doc, page, `q BT /${key} ${size} Tf 0 0 0 rg 1 0 0 1 ${x} ${y} Tm ${font.encodeText(text)} Tj ET Q`);
}

/* ── 1. Excision removes the owned run and nothing else ──────────────────── */

const doc = (await makeDoc()).doc;
const font = await doc.embedFont(PL.StandardFonts.Helvetica);
const dry = await exciseText(PL, doc, 0, [ownedRect], { inflate, dryRun: true });
check('dry-run finds exactly the owned run', dry.removed === 1, JSON.stringify({ removed: dry.removed, kept: dry.kept }));

const real = await exciseText(PL, doc, 0, [ownedRect], { inflate });
check('excision commits one removal', real.removed === 1, JSON.stringify({ removed: real.removed, kept: real.kept }));

// Insert the replacement AFTER excision, the way the writer does.
drawLine(doc, doc.getPage(0), font, 'REPLACEMENT inserted here', 50, 660);

const afterText = await extract(await doc.save());
check('the owned run is GONE from the saved file', !afterText.includes('REMOVEME'), JSON.stringify(afterText.replace(/\n/g, '|')));
check('the replacement is present as real text', afterText.includes('REPLACEMENT'), JSON.stringify(afterText.replace(/\n/g, '|')));
check('the line above survives', afterText.includes('KEEPFIRST'));
check('the line below survives', afterText.includes('KEEPLAST'));

/* ── 2. A cover-only edit would have FAILED the same check ───────────────── */
// Guard against a regression that quietly reverts to washing: this asserts the
// distinction the research draws between "hidden" and "removed".

const coverDoc = (await makeDoc()).doc;
const coverPage = coverDoc.getPage(0);
coverPage.drawRectangle({ x: 45, y: 645, width: 305, height: 33, color: PL.rgb(1, 1, 1), borderWidth: 0 });
coverPage.drawText('REPLACEMENT inserted here', { x: 50, y: 660, size: 14, font: await coverDoc.embedFont(PL.StandardFonts.Helvetica) });
const coverText = await extract(await coverDoc.save());
check('a white cover still leaves the original extractable (the failure mode)', coverText.includes('REMOVEME'), JSON.stringify(coverText.replace(/\n/g, '|')));

/* ── 3. A merged paragraph excises each owned rect separately ────────────── */

const mergeDoc = (await makeDoc()).doc;
const mf = await mergeDoc.embedFont(PL.StandardFonts.Helvetica);
// Own lines 1 and 3, skip line 2 — a union rect would wrongly delete line 2.
const r1 = [45, 685, 350, 720];
const r3 = [45, 605, 350, 640];
const merged = await exciseText(PL, mergeDoc, 0, [r1, r3], { inflate });
check('merged excision reports per-rect counts', merged.perRect[0] === 1 && merged.perRect[1] === 1, JSON.stringify(merged.perRect));
drawLine(mergeDoc, mergeDoc.getPage(0), mf, 'MERGED paragraph text', 50, 700);
const mergeText = await extract(await mergeDoc.save());
check('the skipped middle line is NOT deleted by a merged edit', mergeText.includes('REMOVEME'), JSON.stringify(mergeText.replace(/\n/g, '|')));
check('both owned lines are gone', !mergeText.includes('KEEPFIRST') && !mergeText.includes('KEEPLAST'));
check('the merged replacement is present', mergeText.includes('MERGED'));

/* ── 4. walkTextBlocks sees the right origins ────────────────────────────── */

function streamOf(d, idx) {
  const page = d.getPage(idx);
  const c = page.node.Contents();
  const refs = c instanceof PL.PDFArray ? Array.from({ length: c.size() }, (_, i) => c.get(i)) : [c];
  let out = '';
  for (const r of refs) {
    const obj = d.context.lookup(r);
    if (!obj) continue;
    const enc = obj.contents instanceof Uint8Array ? obj.contents
      : obj.contents ? Uint8Array.from(obj.contents)
        : (typeof obj.getContents === 'function' ? obj.getContents() : null);
    if (!enc) continue;
    const raw = Buffer.from(enc);
    const f = obj.dict?.get?.(PL.PDFName.of('Filter'))?.toString() || '';
    out += (f.includes('FlateDecode') ? inflateSync(raw) : raw).toString('latin1') + '\n';
  }
  return out;
}
const fresh = (await makeDoc()).doc;
const blocks = walkTextBlocks(streamOf(fresh, 0)).filter((b) => b.glyphs > 0);
check('walkTextBlocks finds one block per drawn line', blocks.length === 3, `${blocks.length}`);
check('the middle block origin sits inside the owned rect',
  blocks.some((b) => b.origin[0] >= ownedRect[0] && b.origin[0] <= ownedRect[2] && b.origin[1] >= ownedRect[1] && b.origin[1] <= ownedRect[3]),
  JSON.stringify(blocks.map((b) => b.origin)));

/* ── verdict ─────────────────────────────────────────────────────────────── */

void deflateSync;
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\nTRUTHFUL_FAIL ${failed.length}/${results.length} checks failed` : `\nTRUTHFUL_PASS all ${results.length} checks green`);
process.exit(failed.length ? 1 : 0);
