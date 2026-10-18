#!/usr/bin/env node
/**
 * Real-world table integration test — the "10 cells, 4 editable blocks" report.
 *
 * Each table in the fixture is 5 columns × 2 rows (a 2-line header + a 3-line
 * data row with an empty remarks cell). Whatever way the borders are drawn —
 * Word-style filled rectangles, strokes with sub-point junction gaps, or clean
 * strokes — the real pipeline (content stream → walkVectorPaths →
 * groupTextBlocks → detectTables → the cell split) must yield ONE editable
 * block per non-empty cell, and no block may span a column boundary.
 *
 *   node scripts/make-table-realworld-fixture.mjs && node scripts/table-realworld-test.mjs
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import * as PL from '@cantoo/pdf-lib';
import { groupTextBlocks, textItemBoxes } from '../src/renderer/js/textblocks.js';
import { detectTables, walkVectorPaths } from '../src/renderer/js/tables.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, '.fixtures', 'table-realworld.pdf');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

/* Production split (same steps textedit.js runs; kept in step here because
 * textedit.js drags the whole renderer with it). */
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

/* Content stream → rules, exactly like pageRules/pageRulePaths does. */
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

/* The three table regions on the page (from the fixture maker):
 * T1 top 760 → 760-80; T2 top 640 → 560; T3 top 480 → 400. Columns 40..570. */
const REGIONS = {
  fill: [40, 680, 570, 760],
  gap: [40, 560, 570, 640],
  stroke: [40, 440, 570, 520],
};

const raw = groupTextBlocks(tc, 595).filter((b) => String(b.text || '').trim());
check('the page groups into blocks to begin with', raw.length >= 9, `${raw.length} raw blocks`);

const tables = detectTables(raw, { page: 0, pageW: 595, pageH: 842, paths });

for (const [style, [rx0, ry0, rx1, ry1]] of Object.entries(REGIONS)) {
  const t = tables.find((x) => {
    const [x0, y0, x1, y1] = x.bbox;
    return Math.abs(x0 - rx0) < 6 && Math.abs(y0 - ry0) < 8 && Math.abs(x1 - rx1) < 6 && Math.abs(y1 - ry1) < 8;
  });
  // The text-cluster detector cannot see the LAST column when its data cell is
  // empty (no gutter recurs there) — 4 columns is the honest minimum.
  check(`[${style}] a multi-column table is detected with the drawn boundaries`,
    !!t && t.rows.length >= 2 && t.cols.length >= 4,
    t ? `${t.rows.length}x${t.cols.length} at ${JSON.stringify(t.bbox.map(Math.round))}` : `NOT DETECTED — ${tables.length} tables: ${JSON.stringify(tables.map((x) => x.bbox.map(Math.round)))}`);

  const { blocks } = splitBlocksByCells(tc, raw, t ? [t] : [], 595);
  const inRegion = blocks.filter((b) => {
    const r = b.ownRect || b.coverRect;
    const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2;
    return cx >= rx0 && cx <= rx1 && cy >= ry0 && cy <= ry1;
  });
  // 10 cells, 1 empty; wrapped lines coalesce per column, so the honest range
  // is one-block-per-cell (≈9) down to one-per-line-band (≈12) — but never a
  // return to the 4 merged row-blocks the bug shipped with.
  check(`[${style}] cells are independently editable (7–12 blocks, was 4)`,
    inRegion.length >= 7 && inRegion.length <= 12,
    `${inRegion.length}: ${JSON.stringify(inRegion.map((b) => (b.text || '').replace(/\s+/g, ' ').slice(0, 22)))}`);

  // No editable block may cross a column edge (columns at x 105, 275, 455, 530).
  const EDGES = [105, 275, 455, 530];
  const spanners = inRegion.filter((b) => {
    const r = b.ownRect || b.coverRect;
    return EDGES.some((e) => r[0] < e - 1 && r[2] > e + 1);
  });
  check(`[${style}] no block spans a column boundary`, spanners.length === 0,
    JSON.stringify(spanners.map((b) => (b.text || '').replace(/\s+/g, ' ').slice(0, 30))));
}

/* Cell texts land in the right columns for the control table. */
const t3 = tables.find((x) => Math.abs(x.bbox[1] - 400) < 8);
if (t3) {
  const { blocks } = splitBlocksByCells(tc, raw, [t3], 595);
  const has = (frag) => blocks.some((b) => (b.text || '').replace(/\s+/g, ' ').includes(frag));
  check('[stroke] cell identities survive the split',
    has('RP/33701119') && has('Upgrading (Blacktop') && has('M/S Mandali Builders') && has('18,522,961.22') && has('Bid amount'),
    JSON.stringify(blocks.map((b) => (b.text || '').replace(/\s+/g, ' ').slice(0, 18))));
}

console.log(fail ? `\nREALTABLE_FAIL ${pass} pass, ${fail} fail` : `\nREALTABLE_PASS all ${pass} checks green`);
process.exit(fail ? 1 : 0);
