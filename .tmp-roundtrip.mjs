/**
 * TEMPORARY round-trip test for the new BRUSH and HIGHLIGHTER types.
 *
 * pdfwrite.js imports '/v/pdf-lib.js' + viewer.js and annots.js imports
 * viewer.js, so neither can be loaded in Node. Rather than hand-copying logic
 * (which can drift), this harness lifts the SHIPPED source at run time:
 *   - writeAnnotation(), appearanceFor(), makeFormXObject(), obj(), n() and
 *     extGState() are sliced out of pdfwrite.js and rebuilt with stub
 *     dependencies, so the dictionary writer under test IS the app's code;
 *   - parsePdfAnnotation(), sweptQuads() and velocityWidths() are loaded the
 *     same way, so the read-back path is the real one too;
 *   - byte-for-byte drift assertions prove each branch is still what I claim.
 * It writes a 1-page PDF, saves, reloads with pdf-lib AND with pdf.js (the
 * reader the app actually uses) and asserts type, geometry and appearance.
 */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import * as PL from '@cantoo/pdf-lib';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';

GlobalWorkerOptions.workerSrc = pathToFileURL('node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs').href;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const { PDFName, PDFNumber, PDFString, PDFHexString, PDFRawStream, PDFBool, PDFDocument, rgb } = PL;

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', `${name} — ${e.message}`]); }
};

const pdfwriteSrc = fs.readFileSync('src/renderer/js/pdfwrite.js', 'utf8');
const annotsSrc = fs.readFileSync('src/renderer/js/annots.js', 'utf8');
const toolsSrc = fs.readFileSync('src/renderer/js/tools.js', 'utf8');

/* ── 1. drift assertions: the branches under test, byte for byte ────────── */

const LITERALS = {
  'writer: subtype comes from ANNOT_TYPES': `const subtype = ANNOT_TYPES[a.type] || 'Square';`,
  'writer: /InkList written for ink + brush + highlighter': `  if ((a.type === 'ink' || a.type === 'brush' || a.type === 'highlighter') && a.paths) {
    dict.set(PDFName.of('InkList'), obj(doc, a.paths.map((p) => p.map((v) => n(v)))));
  }`,
  'writer: /IT names the tool': `  if (INK_INTENTS[a.type]) dict.set(PDFName.of('IT'), PDFName.of(INK_INTENTS[a.type]));`,
  'writer: /QuadPoints skipped for the highlighter': `  if (a.quads && a.quads.length && a.type !== 'highlighter') {`,
  'writer: /CA opacity': `if (a.opacity != null && a.opacity < 1) dict.set(PDFName.of('CA'), PDFNumber.of(n(a.opacity)));`,
  'writer: /BS carries the marker width': `dict.set(PDFName.of('BS'), obj(doc, { W: n(a.borderWidth), S: PDFName.of('S') }));`,
  'writer: /AP attached from appearanceFor()': `const ap = await appearanceFor(doc, page, a);`,
  'writer: brush taper baked per segment': `const w = widths ? (widths[i0] + widths[i0 + 1]) / 2 : base;`,
  'writer: highlighter multiply state': `const gs = extGState(doc, 1, 'Multiply');`,
  'writer: /Annots emitted in model order': `setAnnots(target, page, [...keep, ...markup, ...refs]);`,
  'model: ink intents': `export const INK_INTENTS = { brush: 'InkBrush', highlighter: 'InkMarker' };`,
  'model: ink subtype map': `brush: 'Ink', highlighter: 'Ink',`,
  'read-back: intent → type': `const type = INK_INTENT_TYPES[intent] || 'ink';`,
  'read-back: swept quads rebuilt': `if (type === 'highlighter') back.quads = paths.flatMap((p) => sweptQuads(p, base.borderWidth || 16));`,
  'read-back: pdf.js field name is data.it': `return raw.it || raw.intent || null;`,
  'read-back: /IT distinguishes measure (known bug class)': `const isMeasure = intent === 'LineDimension';`,
};
for (const [k, src] of Object.entries(LITERALS)) {
  await check(`drift: ${k}`, () => {
    const where = pdfwriteSrc.includes(src) || annotsSrc.includes(src) || toolsSrc.includes(src);
    assert.ok(where, `not present verbatim in any source file:\n${src}`);
  });
}

/* ── 2. rebuild the shipped writer/reader with stubbed dependencies ─────── */

function slice(src, sig, label) {
  const start = src.indexOf(sig);
  assert.notEqual(start, -1, `${label || sig} not found in source`);
  let depth = 0, i = src.indexOf('{', start), end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  assert.notEqual(end, -1, `unbalanced braces in ${label || sig}`);
  return src.slice(start, end);
}
function exportedFn(src, name) { return slice(src, `export function ${name}(`, name).replace(/^export\s+/, ''); }

// Direct eval so the sliced helpers can still see `clamp`, which they import.
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sweptQuads = eval('(' + exportedFn(annotsSrc, 'sweptQuads') + ')');
const velocityWidths = eval('(' + exportedFn(toolsSrc, 'velocityWidths') + ')');

const writerSrc = [
  'let gsSeq = 0;',
  slice(pdfwriteSrc, 'function obj(doc, v)', 'obj'),
  slice(pdfwriteSrc, 'const n = (v) =>', 'n'),
  slice(pdfwriteSrc, 'function extGState(doc, alpha, blend)', 'extGState'),
  slice(pdfwriteSrc, 'function makeFormXObject(doc, content, bbox, resources)', 'makeFormXObject'),
  slice(pdfwriteSrc, 'async function appearanceFor(doc, page, a)', 'appearanceFor'),
  slice(pdfwriteSrc, 'async function writeAnnotation(doc, page, a)', 'writeAnnotation'),
  'return { writeAnnotation, appearanceFor, makeFormXObject, obj, n, extGState };',
].join('\n');

const ANNOT_TYPES = { ink: 'Ink', brush: 'Ink', highlighter: 'Ink', measure: 'Line', line: 'Line', arrow: 'Line' };
const INK_INTENTS = { brush: 'InkBrush', highlighter: 'InkMarker' };
const stubFont = { name: 'F1', ref: null, encodeText: () => '()', widthOfTextAtSize: () => 1 };
const api = await AsyncFunction(
  'PDFName', 'PDFNumber', 'PDFString', 'PDFHexString', 'PDFRawStream', 'PDFBool',
  'ANNOT_TYPES', 'INK_INTENTS', 'pdfDate', 'clamp', 'rgb', 'baseFont', 'wrapText',
  'dataUrlBytes', writerSrc,
)(PDFName, PDFNumber, PDFString, PDFHexString, PDFRawStream, PDFBool,
  ANNOT_TYPES, INK_INTENTS, (d) => `D:${d.getFullYear()}0101000000`, clamp, rgb,
  async () => stubFont, () => ['x'], () => null);

/* ── 3. write, save, reload ─────────────────────────────────────────────── */

const n3 = (v) => Number(Number(v).toFixed(3));
const near = (arr, want, eps, what) => arr.forEach((v, k) => assert.ok(Math.abs(v - want[k]) < eps, `${what}[${k}] = ${v}, wanted ${want[k]}`));

const stroke = [200, 700, 260, 690, 320, 700, 380, 680];
const widths = velocityWidths([[200, 700], [260, 690], [320, 700], [380, 680]], [0, 60, 90, 200], 8, 1);
const hlPath = [120, 600, 180, 596, 240, 602];
const model = [
  { type: 'ink', paths: [stroke], rect: [190, 670, 390, 710], borderWidth: 2, color: [0, 0, 0], opacity: 1, author: 'A', date: '2026-01-01' },
  { type: 'brush', paths: [stroke], widths, hardness: 0.85, rect: [190, 670, 390, 710], borderWidth: 8, color: [0.1, 0.2, 0.6], opacity: 1, author: 'A', date: '2026-01-01' },
  { type: 'highlighter', paths: [hlPath], quads: sweptQuads(hlPath, 16), rect: [110, 580, 250, 620], borderWidth: 16, color: [1, 0.85, 0.2], opacity: 0.45, author: 'A', date: '2026-01-01' },
  { type: 'measure', points: [100, 500, 300, 500], label: '2.78 in', rect: [98, 498, 302, 502], borderWidth: 1.5, color: [1, 0, 0], opacity: 1, author: 'A', date: '2026-01-01' },
];

let bytes;
const doc = await PDFDocument.create();
const page = doc.addPage([595.28, 841.89]);
await check('build: one annotation per new type through writeAnnotation()', async () => {
  const refs = [];
  for (const a of model) refs.push(await api.writeAnnotation(doc, page, a));
  page.node.set(PDFName.of('Annots'), doc.context.obj(refs));
});
await check('save', async () => { bytes = await doc.save({ useObjectStreams: true }); assert.ok(bytes.length > 500); });
fs.writeFileSync('.smoke/roundtrip.pdf', bytes);

const re = await PDFDocument.load(bytes, { updateMetadata: false });
const arr = re.getPage(0).node.Annots().asArray();
const dict = (k) => re.context.lookup(arr[k]);
const nm = (v) => (v && v.asString ? v.asString() : String(v));
const streamOf = (k) => re.context.lookup(dict(k).get(PDFName.of('AP')).get(PDFName.of('N')));

await check('reload: /Annots order equals model order (the z-order contract)', () => {
  assert.deepEqual(arr.map((r) => nm(re.context.lookup(r).get(PDFName.of('Subtype')))), ['/Ink', '/Ink', '/Ink', '/Line']);
});

await check('reload: brush → /Subtype /Ink + /InkList + /IT /InkBrush + /BS 8', () => {
  const d = dict(1);
  assert.equal(nm(d.get(PDFName.of('Subtype'))), '/Ink');
  assert.equal(nm(d.get(PDFName.of('IT'))), '/InkBrush');
  const ink = d.get(PDFName.of('InkList')).asArray().map((q) => q.asArray().map((v) => Number(v.asNumber())));
  assert.deepEqual(ink[0], stroke, '/InkList geometry changed');
  assert.equal(Number(d.get(PDFName.of('BS')).get(PDFName.of('W')).asNumber()), 8);
  assert.equal(d.get(PDFName.of('Widths')), undefined, 'no invented /Widths key');
  assert.equal(d.get(PDFName.of('QuadPoints')), undefined, 'a stroke must not write /QuadPoints');
});

await check('reload: the velocity taper is baked into the brush /AP stream', () => {
  const text = streamOf(1).getContentsString();
  const ws = [...text.matchAll(/([\d.]+) w/g)].map((m) => m[1]);
  assert.ok(new Set(ws).size >= 2, `expected several stroke widths (a taper), got ${JSON.stringify(ws)}`);
  assert.match(text, /1 J 1 j/, 'round caps/joins missing from the baked taper');
});

await check('reload: highlighter → /Subtype /Ink + /InkList + /IT /InkMarker + /CA 0.45', () => {
  const d = dict(2);
  assert.equal(nm(d.get(PDFName.of('Subtype'))), '/Ink');
  assert.equal(nm(d.get(PDFName.of('IT'))), '/InkMarker');
  assert.equal(d.get(PDFName.of('QuadPoints')), undefined);
  assert.equal(n3(Number(d.get(PDFName.of('CA')).asNumber())), 0.45);
  assert.deepEqual(d.get(PDFName.of('InkList')).asArray()[0].asArray().map((v) => Number(v.asNumber())), hlPath);
});

await check('reload: highlighter /AP fills its swept band under /BM /Multiply', () => {
  const ap = streamOf(2);
  const text = ap.getContentsString();
  assert.match(text, /\/GS\d+ gs/, 'no ExtGState selection in the stream');
  assert.match(text, /h f Q$/, 'swept band is not filled');
  const res = ap.dict.get(PDFName.of('Resources')).get(PDFName.of('ExtGState'));
  const key = res.keys()[0];
  const gs = re.context.lookup(res.get(key));
  assert.equal(nm(gs.get(PDFName.of('BM'))), '/Multiply');
});

await check('reload: measure keeps /L + /IT /LineDimension + /Cap (known bug class)', () => {
  const d = dict(3);
  assert.equal(nm(d.get(PDFName.of('IT'))), '/LineDimension');
  assert.equal(String(d.get(PDFName.of('Cap'))), 'true');
  assert.deepEqual(d.get(PDFName.of('L')).asArray().map((v) => Number(v.asNumber())), [100, 500, 300, 500]);
});

/* ── 4. the real read-back path: pdf.js → parsePdfAnnotation() ──────────── */

const annotsStub = `
const state = { colorRgb: [1, .85, .2], opacity: .45 };
const settings = { author: 'User' };
const activeDoc = () => null;
const rectToCss = () => [0, 0, 0, 0];
const toCss = () => ({ x: 0, y: 0 });
const currentScale = () => 1;
const pageEl = () => null;
const renderStampPreviews = () => {};
const uid = (p) => p + Math.random().toString(36).slice(2, 9);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const rgbToCss = () => 'rgb(0,0,0)';
const readableOn = () => '#000';
` + annotsSrc.replace(/^import[\s\S]*?from\s*'[^']*';[ \t]*$/gm, '');
assert.equal(annotsStub.match(/from '\.\//g), null, 'annots.js import strip failed');
fs.writeFileSync('.smoke/annots-readback.mjs', annotsStub);
const A = await import(pathToFileURL('.smoke/annots-readback.mjs').href);

const pdfjsDoc = await getDocument({ data: bytes.slice(0), isEvalSupported: false, verbosity: 0 }).promise;
const raw = (await (await pdfjsDoc.getPage(1)).getAnnotations()).filter((x) => x.subtype !== 'Widget');
const parsed = raw.map((r) => A.parsePdfAnnotation(r, 0));

await check('pdf.js surfaces /IT as data.it (what annots.js reads)', () => {
  assert.equal(raw[1].it, 'InkBrush', `got ${JSON.stringify(raw[1].it)}`);
  assert.equal(raw[2].it, 'InkMarker', `got ${JSON.stringify(raw[2].it)}`);
});

await check('read-back: parsePdfAnnotation() recovers every new type', () => {
  assert.deepEqual(parsed.map((p) => p && p.type), ['ink', 'brush', 'highlighter', 'measure'],
    JSON.stringify(parsed.map((p) => p && p.type)));
});

await check('read-back: geometry, colour, width and opacity survive', () => {
  assert.deepEqual(parsed[1].paths[0], stroke);
  near(parsed[1].color, [0.1, 0.2, 0.6], 0.01, 'brush colour');   // pdf.js quantises /C to 8 bits
  assert.equal(n3(parsed[1].borderWidth), 8, 'brush base width lost');
  assert.deepEqual(parsed[2].paths[0], hlPath);
  assert.equal(n3(parsed[2].opacity), 0.45);
  assert.deepEqual(parsed[3].points, [100, 500, 300, 500]);
  assert.equal(parsed[3].label, '2.78 in', `caption lost: ${JSON.stringify(parsed[3].label)}`);
});

await check('read-back: highlighter swept quads are rebuilt from /InkList', () => {
  const q = parsed[2].quads;
  assert.ok(q && q.length >= 2, `expected rebuilt quads, got ${JSON.stringify(q)}`);
  assert.deepEqual(q[0].map(n3), sweptQuads(hlPath, 16)[0].map(n3));
});

await check('KNOWN GAP: brush per-vertex widths do not survive /InkList', () => {
  assert.equal(parsed[1].widths, undefined);
  assert.ok(widths.some((w) => Math.abs(w - 8) > 0.2), 'fixture produced no taper at all');
});

console.log('');
for (const [k, m] of results) console.log(`${k === 'PASS' ? '  ✓' : '  ✗'} ${m}`);
const failed = results.filter(([k]) => k === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} round-trip checks passed`);
process.exit(failed ? 1 : 0);
