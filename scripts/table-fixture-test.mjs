#!/usr/bin/env node
/**
 * Integration test: detect tables on the real .fixtures/table.pdf.
 *
 * Loads the same page twice — pdf-lib for the content stream (ruling lines) and
 * pdf.js for the text content (blocks) — then runs the production detector over
 * both. Proves the ruled 3×3 table is rebuilt from its rules and the borderless
 * 2×2 table is found by text clustering, on a file that really exists.
 *
 *   node scripts/make-table-fixture.mjs && node scripts/table-fixture-test.mjs
 */
import * as PL from '@cantoo/pdf-lib';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { groupTextBlocks } from '../src/renderer/js/textblocks.js';
import { detectTables, walkVectorPaths, tableForBlock, cellAtPoint, tableLabel } from '../src/renderer/js/tables.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, '.fixtures', 'table.pdf');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

const bytes = new Uint8Array(await readFile(FIXTURE));

/* ── Content stream → ruling lines ────────────────────────────────────────── */
const pl = await PL.PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
const page = pl.getPage(0);
const { PDFName, PDFArray } = PL;
const entry = page.node.get(PDFName.of('Contents'));
const resolved = pl.context.lookup(entry);
const refs = resolved instanceof PDFArray
  ? Array.from({ length: resolved.size() }, (_, i) => resolved.get(i))
  : [entry];

const segments = { h: [], v: [] };
for (const ref of refs) {
  const obj = pl.context.lookup(ref);
  let raw = obj.contents instanceof Uint8Array ? obj.contents
    : (typeof obj.getContents === 'function' ? obj.getContents() : null);
  if (!raw) continue;
  const filter = obj.dict?.get?.(PDFName.of('Filter'))?.toString() || '';
  const buf = Buffer.from(raw);
  const text = (filter.includes('FlateDecode') ? zlib.inflateSync(buf) : buf).toString('latin1');
  const p = walkVectorPaths(text);
  segments.h.push(...p.h);
  segments.v.push(...p.v);
}
check('the ruled table contributes horizontal rules', segments.h.length >= 4, `h=${segments.h.length}`);
check('the ruled table contributes vertical rules', segments.v.length >= 4, `v=${segments.v.length}`);

/* ── Text content → blocks ────────────────────────────────────────────────── */
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const pdf = await pdfjs.getDocument({ data: bytes.slice(0), isEvalSupported: false }).promise;
const pdfPage = await pdf.getPage(1);
const tc = await pdfPage.getTextContent();
const blocks = groupTextBlocks(tc, 595).filter((b) => String(b.text || '').trim());
check('the page yields editable text blocks', blocks.length >= 10, `blocks=${blocks.length}`);

/* ── Detection ────────────────────────────────────────────────────────────── */
const tables = detectTables(blocks, { page: 0, pageW: 595, pageH: 842, paths: segments });
check('three tables are detected on the fixture', tables.length === 3, `tables=${tables.length}`);

const ruled = tables.find((t) => t.source === 'rules');
const borderless = tables.find((t) => t.source === 'text');
check('the ruled table is rebuilt from rules', !!ruled, JSON.stringify(tables.map((t) => t.source)));
check('the ruled table is 3×3', !!ruled && ruled.rows.length === 3 && ruled.cols.length === 3,
  ruled && `${ruled.rows.length}×${ruled.cols.length}`);
check('the ruled table has 9 cells', !!ruled && ruled.cells.length === 9, ruled && ruled.cells.length);
check('the ruled table reads A1..C3',
  !!ruled && ['A1', 'B1', 'C1', 'A2', 'B2', 'C2', 'A3', 'B3', 'C3'].every((s) => ruled.cells.some((c) => c.text === s)),
  ruled && JSON.stringify(ruled.cells.map((c) => c.text)));

check('the borderless table is found by text clustering', !!borderless, JSON.stringify(tables.map((t) => t.source)));
check('the borderless table is 2×2', !!borderless && borderless.rows.length === 2 && borderless.cols.length === 2,
  borderless && `${borderless.rows.length}×${borderless.cols.length}`);
check('the borderless table reads X1..Y2',
  !!borderless && ['X1', 'Y1', 'X2', 'Y2'].every((s) => borderless.cells.some((c) => c.text === s)),
  borderless && JSON.stringify(borderless.cells.map((c) => c.text)));

/* ── Row/column attribution ───────────────────────────────────────────────────
 * Detection is only half the feature: an edit has to land in the RIGHT cell.
 * Rows are reported top-down while the fixture's rules were authored bottom-up,
 * so A1 must resolve to row 0 / col 0 and C3 to row 2 / col 2. */
const idxOf = (s) => blocks.findIndex((b) => String(b.text || '').trim() === s);
const at = (s) => tableForBlock(tables, idxOf(s));
const a1 = at('A1'), c3 = at('C3'), x1 = at('X1'), y1 = at('Y1');
check('A1 resolves to the top-left cell', !!a1 && a1.cell.row === 0 && a1.cell.col === 0,
  a1 && `R${a1.cell.row}C${a1.cell.col}`);
check('C3 resolves to the bottom-right cell', !!c3 && c3.cell.row === 2 && c3.cell.col === 2,
  c3 && `R${c3.cell.row}C${c3.cell.col}`);
check('A1 and C3 belong to the SAME table', !!a1 && !!c3 && a1.table.id === c3.table.id);
check('X1 lands in the LEFT column of the borderless table',
  !!x1 && x1.table.source === 'text' && x1.cell.col === 0,
  x1 && `${x1.table.source} R${x1.cell.row}C${x1.cell.col}`);
check('Y1 lands in the RIGHT column of the borderless table',
  !!y1 && y1.table.source === 'text' && y1.cell.col === 1,
  y1 && `${y1.table.source} R${y1.cell.row}C${y1.cell.col}`);
check('X1 and Y1 share a row (the row is attributed, not the block)',
  !!x1 && !!y1 && x1.cell.row === y1.cell.row && x1.table.id === y1.table.id);
check('the two tables do not overlap',
  !!ruled && !!borderless
  && !(borderless.bbox[0] < ruled.bbox[2] && borderless.bbox[2] > ruled.bbox[0]
    && borderless.bbox[1] < ruled.bbox[3] && borderless.bbox[3] > ruled.bbox[1]));

/* A click inside a cell rect must find that cell — this is what the Direct
 * Editor uses to scope the editor to the cell rather than the whole row. */
const b2 = ruled?.cells.find((c) => c.text === 'B2');
const hit = b2 ? cellAtPoint(tables, (b2.rect[0] + b2.rect[2]) / 2, (b2.rect[1] + b2.rect[3]) / 2) : null;
check('a point inside cell B2 finds cell B2', !!hit && hit.cell.text === 'B2',
  hit && `${hit.cell.text}`);
check('the cell label names the table, cell and grid size',
  !!b2 && tableLabel(ruled, b2, 0) === 'Table 1 · R2C2 of 3×3',
  b2 && tableLabel(ruled, b2, 0));

/* ── The merged-row table ─────────────────────────────────────────────────────
 * Its cells are close enough together that text-block grouping merges a whole
 * row into one 200pt block. Detection must still see the 3×3 GRID (it comes
 * from the rules, not from the text), and the splitter — covered by
 * scripts/table-cell-blocks-test.mjs — turns that row block into 9 cell blocks.
 * Here we only assert the grid exists, so a regression in either half is
 * visible in one of the two suites. */
const merged = tables.find((t) => t.source === 'rules' && t.bbox[1] > 280 && t.bbox[3] < 400);
check('the merged-row table is still detected from its rules', !!merged,
  JSON.stringify(tables.map((t) => [t.source, Math.round(t.bbox[1])])));
check('the merged-row table is 3×3', !!merged && merged.rows.length === 3 && merged.cols.length === 3,
  merged && `${merged.rows.length}×${merged.cols.length}`);
check('the merged-row table exposes all 9 cells', !!merged && merged.cells.length === 9,
  merged && merged.cells.length);
check('at the detection stage one row block lands in a single cell',
  !!merged && merged.cells.filter((c) => c.blocks.length > 0).length < 9,
  merged && JSON.stringify(merged.cells.map((c) => c.blocks.length)));

console.log(`\nTABLE_FIXTURE_RESULT pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
