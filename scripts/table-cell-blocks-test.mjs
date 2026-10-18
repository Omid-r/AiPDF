#!/usr/bin/env node
/**
 * Integration test: the editable block list must have ONE block per CELL.
 *
 * Reproduces the reported bug — "it treats every row as a cell". The fixture's
 * third table emits each row as a single text run positioned with ordinary
 * spaces, so text-block grouping produces one block spanning all three columns
 * and a click anywhere in the row edits the whole row.
 *
 *   node scripts/make-table-fixture.mjs && node scripts/table-cell-blocks-test.mjs
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import * as PL from '@cantoo/pdf-lib';
import { groupTextBlocks, textItemBoxes } from '../src/renderer/js/textblocks.js';
import { detectTables, tableForBlock, walkVectorPaths } from '../src/renderer/js/tables.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, '.fixtures', 'table.pdf');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

/* The production splitter lives in textedit.js, which pulls in the whole
 * renderer (store, viewer, annots…). Re-implement the same two steps here so the
 * test exercises the real primitives — item boxes, subset grouping and the
 * tables' own cell.blocks patching — without a DOM. `textedit.js` calls exactly
 * these. */
function splitBlocksByCells(tc, blocks, tables, pageWidth) {
  if (!tables.length || !tc?.items?.length) return { blocks, tables };
  const boxByIndex = new Map(textItemBoxes(tc).map((b) => [b.index, b]));
  const contains = (r, cell) => {
    const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2;
    return cx >= cell[0] && cx <= cell[2] && cy >= cell[1] && cy <= cell[3];
  };
  const cellKey = (t, c) => `${t.id}|${c.row}|${c.col}`;
  /* Global per-cell attribution (mirrors production splitBlocksByCells):
   * every item of every fully-inside block pools into its cell, then each
   * cell's union regroups ONCE — so a cell is one block however its text
   * arrived (row-run or per-line). */
  const itemsByCell = new Map();
  const consumed = new Set();
  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi];
    const table = tables.find((t) => contains(block.coverRect, t.bbox));
    if (!table || !block.itemIndices?.length) continue;
    let mapped = 0;
    for (const idx of block.itemIndices) {
      const b = boxByIndex.get(idx);
      if (!b) continue;
      const cell = table.cells.find((c) => contains(b.rect, c.rect));
      if (!cell) continue;
      mapped++;
      const k = cellKey(table, cell);
      if (!itemsByCell.has(k)) itemsByCell.set(k, { table, cell, idxs: new Set() });
      itemsByCell.get(k).idxs.add(idx);
    }
    if (!mapped || mapped < block.itemIndices.length) continue;
    consumed.add(bi);
  }
  const entries = [];
  for (let bi = 0; bi < blocks.length; bi++) {
    if (!consumed.has(bi)) entries.push({ block: blocks[bi], from: bi });
  }
  for (const { table, cell, idxs } of itemsByCell.values()) {
    for (const piece of groupTextBlocks(tc, pageWidth, idxs)) {
      if (!String(piece.text || '').trim()) continue;
      const own = [
        Math.max(piece.coverRect[0], cell.rect[0]),
        Math.max(piece.coverRect[1], cell.rect[1]),
        Math.min(piece.coverRect[2], cell.rect[2]),
        Math.min(piece.coverRect[3], cell.rect[3]),
      ];
      piece.ownRect = (own[2] - own[0] > 0.5 && own[3] - own[1] > 0.5) ? own : piece.coverRect.slice();
      entries.push({ block: piece, cell, table });
    }
  }

  const out = [];
  const origToFinal = new Map();
  const piecesByCell = new Map();
  for (const e of entries) {
    const at = out.length;
    out.push(e.block);
    if (e.from != null) origToFinal.set(e.from, at);
    if (e.cell) {
      const k = cellKey(e.table, e.cell);
      if (!piecesByCell.has(k)) piecesByCell.set(k, []);
      piecesByCell.get(k).push(at);
    }
  }
  for (const t of tables) {
    for (const cell of t.cells) {
      const kept = (cell.blocks || []).map((bi) => origToFinal.get(bi)).filter((x) => x != null);
      const split = piecesByCell.get(cellKey(t, cell)) || [];
      cell.blocks = [...split, ...kept].sort((a, b) => a - b);
    }
  }
  return { blocks: out, tables };
}

const bytes = new Uint8Array(await readFile(FIXTURE));

/* Content stream → rules (same path the app uses). */
const pl = await PL.PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
const page = pl.getPage(0);
const { PDFName, PDFArray } = PL;
const entry = page.node.get(PDFName.of('Contents'));
const resolved = pl.context.lookup(entry);
const refs = resolved instanceof PDFArray
  ? Array.from({ length: resolved.size() }, (_, i) => resolved.get(i))
  : [entry];
const paths = { h: [], v: [] };
for (const ref of refs) {
  const obj = pl.context.lookup(ref);
  const raw = obj.contents instanceof Uint8Array ? obj.contents
    : (typeof obj.getContents === 'function' ? obj.getContents() : null);
  if (!raw) continue;
  const filter = obj.dict?.get?.(PDFName.of('Filter'))?.toString() || '';
  const buf = Buffer.from(raw);
  const text = (filter.includes('FlateDecode') ? zlib.inflateSync(buf) : buf).toString('latin1');
  const p = walkVectorPaths(text);
  paths.h.push(...p.h);
  paths.v.push(...p.v);
}

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const pdf = await pdfjs.getDocument({ data: bytes.slice(0), isEvalSupported: false }).promise;
const pdfPage = await pdf.getPage(1);
const tc = await pdfPage.getTextContent();

/* ── Before splitting: the merged-row table is one block per ROW ─────────── */
const raw = groupTextBlocks(tc, 595).filter((b) => String(b.text || '').trim());
const rawTables = detectTables(raw, { page: 0, pageW: 595, pageH: 842, paths });
const mergedRaw = raw.filter((b) => /^P\d/.test(b.text));
check('the merged-row table starts as one block per row', mergedRaw.length === 3,
  `${mergedRaw.length}: ${JSON.stringify(mergedRaw.map((b) => b.text))}`);
check('a raw row block spans more than one column',
  mergedRaw.every((b) => (b.coverRect[2] - b.coverRect[0]) > 150),
  mergedRaw.map((b) => Math.round(b.coverRect[2] - b.coverRect[0])).join(','));

/* ── After splitting: one block per CELL ─────────────────────────────────── */
const { blocks, tables } = splitBlocksByCells(tc, raw, rawTables, 595);
const merged = blocks.filter((b) => /^[PQR]\d/.test(b.text.trim()));
check('every cell of the merged-row table becomes its own block', merged.length === 9,
  `${merged.length}: ${JSON.stringify(merged.map((b) => b.text.slice(0, 4)))}`);
check('the cell blocks carry the cell text, not the row text',
  ['P1', 'Q1', 'R1', 'P2', 'Q2', 'R2', 'P3', 'Q3', 'R3'].every((s) => merged.some((b) => b.text.trim().startsWith(s))),
  JSON.stringify(merged.map((b) => b.text.slice(0, 2))));
check('no split block still spans the whole row',
  merged.every((b) => (b.coverRect[2] - b.coverRect[0]) < 120),
  merged.map((b) => Math.round(b.coverRect[2] - b.coverRect[0])).join(','));

const at = (s) => {
  const i = blocks.findIndex((b) => b.text.trim().startsWith(s));
  return { i, hit: i >= 0 ? tableForBlock(tables, i) : null };
};
const q2 = at('Q2'), p2 = at('P2'), r2 = at('R2');
check('Q2 resolves to row 1 column 1 of its own table',
  !!q2.hit && q2.hit.cell.row === 1 && q2.hit.cell.col === 1,
  q2.hit && `R${q2.hit.cell.row}C${q2.hit.cell.col}`);
check('P2 and R2 are DIFFERENT cells of the SAME table',
  !!p2.hit && !!r2.hit && p2.hit.cell.col === 0 && r2.hit.cell.col === 2
  && p2.hit.table.id === r2.hit.table.id && p2.hit.table.id === q2.hit.table.id);
check('no cell claims more than one block in that table',
  q2.hit && q2.hit.table.cells.every((c) => c.blocks.length <= 1),
  q2.hit && JSON.stringify(q2.hit.table.cells.map((c) => c.blocks.length)));
check('each cell block owns only its own text items',
  !!q2.hit && q2.hit.cell.blocks.length === 1
  && blocks[q2.hit.cell.blocks[0]].text.trim().startsWith('Q2'),
  q2.hit && JSON.stringify(q2.hit.cell.blocks.map((bi) => blocks[bi].text.slice(0, 2))));

/* ── The already-per-cell tables must be untouched by the split ──────────── */
const ruled = tables.find((t) => t.source === 'rules' && t.rows.length === 3 && t.cols.length === 3);
check('the ordinary ruled table still has 9 cells with one block each',
  !!ruled && ruled.cells.filter((c) => c.blocks.length === 1).length === 9,
  ruled && JSON.stringify(ruled.cells.map((c) => c.blocks.length)));
check('A1..C3 are still individually addressable',
  ['A1', 'B1', 'C1', 'A2', 'B2', 'C2', 'A3', 'B3', 'C3'].every((s) => at(s).hit?.cell.blocks.length === 1),
  JSON.stringify(blocks.map((b) => b.text.slice(0, 2))));

/* ── Nothing was lost or duplicated ─────────────────────────────────────── */
const allText = blocks.map((b) => b.text.trim()).join(' ');
for (const s of ['A1', 'C3', 'X1', 'Y2', 'P1', 'Q3', 'R2']) {
  check(`"${s}" survives the split`, allText.split(/\s+/).some((w) => w.startsWith(s)), allText.slice(0, 120));
}
check('the split replaces 3 row blocks with 9 cell blocks',
  blocks.filter((b) => b.text.trim()).length === raw.length + 6,
  `raw=${raw.length} split=${blocks.filter((b) => b.text.trim()).length}`);

console.log(`\nTABLE_CELL_BLOCKS_RESULT pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
