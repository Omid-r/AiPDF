#!/usr/bin/env node
/**
 * Engine test for the content-stream text primitives (walk/group/excise).
 *
 * Note: pdfwrite.js now DOES call exciseText — a Direct Editor save removes the
 * owned source operators rather than covering them (see "Object-owned editing"
 * in README.md). This test exercises the primitive directly; the end-to-end
 * contract lives in scripts/truthful-save-test.mjs.
 *
 *   node scripts/reflow-test.mjs [file.pdf]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as PL from '@cantoo/pdf-lib';
import { walkTextBlocks, groupParagraphs, exciseText } from '../src/renderer/js/textops.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = process.argv[2] || path.join(ROOT, '.fixtures', 'real-chrome.pdf');

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const bytes = readFileSync(FILE);
const doc = await PL.PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });

/* ── read the page's text lines through the new engine ──────────────────── */
function pageStreamText(d, idx) {
  const page = d.getPage(idx);
  const c = page.node.Contents();
  const refs = c instanceof PL.PDFArray ? Array.from({ length: c.size() }, (_, i) => c.get(i)) : [c];
  let out = '';
  for (const r of refs) {
    const obj = d.context.lookup(r);
    if (!obj?.contents) continue;
    const raw = Buffer.from(obj.contents);
    const f = obj.dict?.get?.(PL.PDFName.of('Filter'))?.toString() || '';
    out += (f.includes('FlateDecode') ? inflateSync(raw) : raw).toString('latin1') + '\n';
  }
  return out;
}

const blocks = walkTextBlocks(pageStreamText(doc, 0));
check('content stream yields text blocks', blocks.length > 0, `${blocks.length} blocks`);

const paras = groupParagraphs(blocks);
check('lines group into paragraphs', paras.length >= 3, `${paras.length} paragraphs from ${blocks.length} lines`);

/* ── ground truth: what pdf.js says the page contains, with line positions ─ */
async function pdfLines(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const d = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
  const p = await d.getPage(1);
  const tc = await p.getTextContent();
  await d.destroy?.();
  const byY = new Map();
  for (const it of tc.items) {
    const y = Math.round(it.transform[5]);
    if (!byY.has(y)) byY.set(y, '');
    byY.set(y, byY.get(y) + it.str);
  }
  return byY;
}

const beforeLines = await pdfLines(await doc.save());
const beforeText = [...beforeLines.values()].join('\n');
check('pdf.js reads the unmodified page', beforeText.includes('indented') && beforeText.includes('Courier'), `${beforeLines.size} rendered lines`);

/* ── excise one paragraph and re-read ───────────────────────────────────── */
const target = paras.find((p) => p.lines.length >= 2) || paras[0];
const rect = [target.rect[0] - 2, target.rect[1] - 3, target.rect[2] + 2, target.rect[3] + 3];

const res = await exciseText(PL, doc, 0, [rect], { inflate: async (b) => inflateSync(b) });
check('excision reported removing blocks', res.removed >= 2, JSON.stringify({ removed: res.removed, kept: res.kept, refused: res.refused }));
check('excision did not refuse on XObject text', res.refused.length === 0, res.refused.join(',') || 'no form-xobject text');

const afterLines = await pdfLines(await doc.save());
const afterText = [...afterLines.values()].join('\n');
check('saved file still parses as a PDF', afterText.length > 0, `${afterLines.size} lines remain of ${beforeLines.size}`);

// Derive the expectations from geometry: lines whose baseline fell inside the
// excised rect must be gone, and lines outside it must all still be there.
const inside = [...beforeLines.entries()].filter(([y]) => y >= rect[1] - 1 && y <= rect[3] + 1);
const outside = [...beforeLines.entries()].filter(([y]) => !(y >= rect[1] - 1 && y <= rect[3] + 1));

const goneStillPresent = inside.filter(([, txt]) => {
  if (!txt.trim()) return false;
  const probe = txt.trim().slice(0, 18);
  return afterText.includes(probe);
});
check('every excised line is absent from the saved file', goneStillPresent.length === 0,
  goneStillPresent.length ? `STILL PRESENT: ${goneStillPresent.map(([, t]) => JSON.stringify(t.slice(0, 24))).join(' | ')}` : `${inside.length} lines removed and confirmed gone`);

const lostOutside = outside.filter(([, txt]) => txt.trim() && !afterText.includes(txt.trim().slice(0, 18)));
check('text outside the region is untouched', lostOutside.length === 0,
  lostOutside.length ? `LOST: ${lostOutside.map(([, t]) => JSON.stringify(t.slice(0, 24))).join(' | ')}` : `${outside.length} neighbouring lines intact`);

const d2 = await PL.PDFDocument.load(await doc.save());
check('output reloads in pdf-lib', d2.getPageCount() === 1, `${d2.getPageCount()} pages`);

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\nREFLOW_FAIL ${failed.length}/${results.length} checks failed` : `\nREFLOW_PASS all ${results.length} checks green`);
process.exit(failed.length ? 1 : 0);
