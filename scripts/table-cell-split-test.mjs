#!/usr/bin/env node
/**
 * Table-cell split gate — the "10 cells, 4 editable blocks" fix, verified on
 * the REAL document's OCR output.
 *
 * .fixtures/real-ocr-lines.json holds the Tesseract lines the app recognises
 * for the reported tender sheet (a scan: no native text, 2×5 ruled table).
 * The pure pipeline the Direct Editor consumes must turn those lines into
 * independent per-cell editable blocks. Also covers the AI-vision structured
 * builder (table cells as explicit line entries — the user's proven
 * PDF→Word idea).
 *
 *   node scripts/table-cell-split-test.mjs
 */
import { readFile } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { flatOcrLines, ocrSplitSegments, ocrCellBlock, blocksFromOcrLines, buildStructuredOcrLines } from '../src/renderer/js/textblocks.js';
import { tablesFromSegmentItems } from '../src/renderer/js/tables.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/* The dump is committed under scripts/fixtures (a real tender sheet's OCR
 * lines, captured via scripts/dump-real-ocr.mjs); .fixtures/ is gitignored. */
const DUMP = fs.existsSync(path.join(ROOT, 'scripts', 'fixtures', 'real-ocr-lines.json'))
  ? path.join(ROOT, 'scripts', 'fixtures', 'real-ocr-lines.json')
  : path.join(ROOT, '.fixtures', 'real-ocr-lines.json');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

const data = JSON.parse(await readFile(DUMP, 'utf8'));
const { dpi, pageW, pageH, lines } = data;
check('real OCR dump is present with lines', Array.isArray(lines) && lines.length >= 10, `${lines?.length} lines, dpi ${dpi}`);

const flat = flatOcrLines(lines, pageH, dpi);
const segs = ocrSplitSegments(flat);

/* The merged table row must segment into its cells: the GRP row carries the
 * bid number, the works description, the builder and the amount. */
const li8 = segs.filter((s) => s.li === 8);
check('the merged data row segments into its cells (≥3 segments)',
  li8.length >= 3,
  `${li8.length}: ${JSON.stringify(li8.map((s) => s.text.slice(0, 22)))}`);
check('the bid amount is its own segment',
  segs.some((s) => /18,?522,?961/.test(s.text)), JSON.stringify(segs.filter((s) => /\d{2},\d{3}/.test(s.text)).map((s) => s.text)));

const tables = tablesFromSegmentItems(segs, { page: 0 });
const t = tables[0];
check('a table grid is detected over the tender table',
  !!t && t.rows.length >= 2 && t.cols.length >= 3,
  t ? `${t.rows.length}x${t.cols.length} at ${JSON.stringify(t.bbox.map(Math.round))}` : 'none');

/* The full split — same steps splitOcrBlocksByCells runs. */
const blocks = blocksFromOcrLines(lines, pageW, pageH, dpi, 0);
const flatByLi = new Map(flat.map((l) => [l.li, l]));
const contains = (r, cell) => {
  const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2;
  return cx >= cell[0] && cx <= cell[2] && cy >= cell[1] && cy <= cell[3];
};
const inCell = (rect, cell) => contains(rect, cell.rect);
const cellKey = (t, c) => `${t.id}|${c.row}|${c.col}`;
const consumed = new Set();
const segsByCell = new Map();
blocks.forEach((block, bi) => {
  const lineIds = block.lineIds || [];
  const table = tables.find((tt) => {
    const [x0, y0, x1, y1] = tt.bbox;
    const r = block.coverRect;
    const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2;
    return cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1;
  });
  if (!table || !lineIds.length) return;
  const own = segs.filter((s) => lineIds.includes(s.li));
  if (!own.length) return;
  let mapped = 0;
  for (const seg of own) {
    const cell = table.cells.find((c) => inCell(seg.rect, c));
    if (!cell) continue;
    mapped++;
    const k = cellKey(table, cell);
    if (!segsByCell.has(k)) segsByCell.set(k, { table, cell, segs: [] });
    segsByCell.get(k).segs.push(seg);
  }
  if (mapped && mapped === own.length) consumed.add(bi);
});
const out = [];
blocks.forEach((b, bi) => { if (!consumed.has(bi)) out.push({ text: String(b.text || ''), rect: b.coverRect }); });
for (const rec of segsByCell.values()) {
  const piece = ocrCellBlock(rec.segs, flatByLi, rec.cell.rect, pageW, 0);
  if (piece && String(piece.text || '').trim()) out.push({ text: String(piece.text), rect: piece.ownRect || piece.coverRect, cell: true });
}

/* Acceptance: the table zone (bottom band of the page) holds many narrow
 * independent blocks, none spanning most of the table width. */
const tableZone = out.filter((b) => {
  const r = b.rect || [];
  return ((r[1] + r[3]) / 2) < pageH * 0.34 && r.length === 4;
});
check('the table zone resolves into many independent blocks (≥6, was 3-4)',
  tableZone.length >= 6, `${tableZone.length}: ${JSON.stringify(tableZone.map((b) => b.text.replace(/\n/g, '⏎').slice(0, 24)))}`);
const wide = tableZone.filter((b) => (b.rect[2] - b.rect[0]) > pageW * 0.55);
check('no table block spans most of the table width', wide.length === 0,
  JSON.stringify(wide.map((b) => b.text.slice(0, 30))));
const joined = (frag) => tableZone.some((b) => b.text.replace(/\s+/g, ' ').toLowerCase().includes(frag));
check('each key cell is its own block (bid no. / works / builder / amount are SEPARATE)',
  joined('grp') && joined('upgrading') && joined('mandali') && joined('18,522,961.22')
    && !tableZone.some((b) => /grp/i.test(b.text) && /upgrading/i.test(b.text)),
  JSON.stringify(tableZone.map((b) => b.text.replace(/\n/g, ' ').slice(0, 26))));

/* ── AI-vision structured builder ───────────────────────────────────────── */
const aiSample = {
  lines: [
    { text: 'सुचना paragraph text', bbox: { x0: 20, y0: 40, x1: 430, y1: 70 } },
    { text: 'ठेक्का नम्बर | योजनाको नाम row read across', bbox: { x0: 20, y0: 150, x1: 430, y1: 170 } },
  ],
  tables: [{
    cells: [
      { row: 0, col: 0, text: 'ठेक्का नम्बर', bbox: { x0: 20, y0: 150, x1: 100, y1: 170 } },
      { row: 0, col: 1, text: 'योजनाको नाम', bbox: { x0: 110, y0: 150, x1: 240, y1: 170 } },
      { row: 1, col: 0, text: 'GRP/33701119-4/083/84-3', bbox: { x0: 20, y0: 180, x1: 100, y1: 220 } },
      { row: 1, col: 1, text: '', bbox: { x0: 110, y0: 180, x1: 240, y1: 220 } },
    ],
  }],
};
const aiLines = buildStructuredOcrLines(aiSample);
check('AI structured builder: cell entries become lines, covered freeform dropped',
  aiLines.length === 4
    && aiLines.some((l) => l.text === 'सुचना paragraph text')
    && aiLines.some((l) => l.text === 'ठेक्का नम्बर')
    && aiLines.some((l) => l.text === 'योजनाको नाम')
    && aiLines.some((l) => l.text === 'GRP/33701119-4/083/84-3')
    && !aiLines.some((l) => l.text.includes('row read across')),
  JSON.stringify(aiLines.map((l) => l.text.slice(0, 24))));
check('AI structured builder: garbage in → no lines (caller falls back)',
  buildStructuredOcrLines(null).length === 0 && buildStructuredOcrLines({ lines: 'nope' }).length === 0);

console.log(fail ? `\nCELLSPLIT_FAIL ${pass} pass, ${fail} fail` : `\nCELLSPLIT_PASS all ${pass} checks green`);
process.exit(fail ? 1 : 0);
