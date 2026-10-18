#!/usr/bin/env node
/**
 * Unit tests for table structure recognition (src/renderer/js/tables.js).
 *
 * Pure Node, no Electron, no DOM: detection works on text blocks and vector
 * segments only, so it is testable exactly like the other planners.
 *
 *   node scripts/table-detect-test.mjs
 */
import {
  detectTables, walkVectorPaths, tableForBlock, cellAtPoint, tableLabel,
} from '../src/renderer/js/tables.js';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

const blk = (x0, y0, x1, y1, text, size = 10) => ({
  coverRect: [x0, y0, x1, y1], rect: [x0, y0, x1, y1], text, size,
});

/** A grid of single-line cell blocks. cols/rows are [lo,hi] pairs. */
function gridBlocks(cols, rows, label = (r, c) => `${'ABCDEFGH'[c]}${r + 1}`) {
  const out = [];
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < cols.length; c++) {
      out.push(blk(cols[c][0], rows[r][0], cols[c][1], rows[r][1], label(r, c)));
    }
  }
  return out;
}

/* ── 1. A plain 3×3 table ─────────────────────────────────────────────────── */
{
  const cols = [[50, 150], [170, 270], [290, 390]];
  const rows = [[680, 700], [640, 660], [600, 620]];   // [bottom, top]
  const blocks = gridBlocks(cols, rows);
  const tables = detectTables(blocks, { page: 0, pageW: 595, pageH: 842 });
  check('a 3×3 grid is detected as one table', tables.length === 1, `tables=${tables.length}`);
  const t = tables[0];
  check('the table has 3 rows', t && t.rows.length === 3, t && `rows=${t.rows.length}`);
  check('the table has 3 columns', t && t.cols.length === 3, t && `cols=${t.cols.length}`);
  check('the table has 9 cells', t && t.cells.length === 9, t && `cells=${t.cells.length}`);
  check('every cell owns exactly one block',
    t && t.cells.every((c) => c.blocks.length === 1),
    t && JSON.stringify(t.cells.map((c) => c.blocks.length)));
  check('the top-left cell holds A1', t && t.cells[0].text === 'A1', t && t.cells[0].text);
  check('the bottom-right cell holds C3', t && t.cells[t.cells.length - 1].text === 'C3',
    t && t.cells[t.cells.length - 1].text);
  check('the table bbox spans the text', t && t.bbox[0] <= 50 && t.bbox[2] >= 390,
    t && JSON.stringify(t.bbox));
}

/* ── 2. A 2×2 borderless table ────────────────────────────────────────────── */
{
  const cols = [[50, 150], [170, 270]];
  const rows = [[680, 700], [640, 660]];
  const tables = detectTables(gridBlocks(cols, rows), { page: 0 });
  check('a 2×2 grid is detected', tables.length === 1, `tables=${tables.length}`);
  check('it reports 2 rows × 2 columns',
    tables[0] && tables[0].rows.length === 2 && tables[0].cols.length === 2,
    tables[0] && `${tables[0].rows.length}×${tables[0].cols.length}`);
}

/* ── 3. Two-column PROSE must not look like a table ───────────────────────── */
{
  const prose = (x0, x1, y0, y1) => blk(x0, y0, x1, y1,
    Array.from({ length: 20 }, (_, i) => `line ${i + 1} of a long paragraph`).join('\n'));
  const blocks = [
    prose(50, 280, 400, 700), prose(50, 280, 300, 380),
    prose(300, 530, 400, 700), prose(300, 530, 300, 380),
  ];
  const tables = detectTables(blocks, { page: 0 });
  check('two-column prose is NOT detected as a table', tables.length === 0, `tables=${tables.length}`);
}

/* ── 4. A single row of cells is not a table ──────────────────────────────── */
{
  const blocks = [blk(50, 680, 150, 700, 'A'), blk(170, 680, 270, 700, 'B'), blk(290, 680, 390, 700, 'C')];
  const tables = detectTables(blocks, { page: 0 });
  check('one row of cells is not a table', tables.length === 0, `tables=${tables.length}`);
}

/* ── 5. A single paragraph is not a table ─────────────────────────────────── */
{
  const blocks = [blk(50, 600, 400, 700, 'just one paragraph\nwith several lines\nof ordinary text')];
  const tables = detectTables(blocks, { page: 0 });
  check('a paragraph is not a table', tables.length === 0, `tables=${tables.length}`);
}

/* ── 6. Cell lookup by block and by point ─────────────────────────────────── */
{
  const cols = [[50, 150], [170, 270], [290, 390]];
  const rows = [[680, 700], [640, 660], [600, 620]];
  const blocks = gridBlocks(cols, rows);
  const tables = detectTables(blocks, { page: 0 });
  const hit = tableForBlock(tables, 4);   // index 4 = row 1, col 1 = B2
  check('tableForBlock finds the cell that owns a block', !!hit && hit.cell.text === 'B2',
    hit && hit.cell.text);
  const at = cellAtPoint(tables, 220, 650);   // centre of B2
  check('cellAtPoint finds the cell under a point', !!at && at.cell.text === 'B2',
    at && at.cell.text);
  check('cellAtPoint ignores a point outside the table', cellAtPoint(tables, 500, 650) === null);
  const label = hit ? tableLabel(hit.table, hit.cell, 0) : '';
  check('the cell label names the row and column', /Table 1 · R2C2 of 3×3/.test(label), label);
}

/* ── 7. Vector rules from a content stream ────────────────────────────────── */
{
  // One stroked horizontal line, one stroked vertical line, and a thin filled
  // rectangle (a rule drawn as a filled bar).
  const src = [
    'q', '50 100 m 250 100 l S',            // horizontal at y=100, x 50..250
    '100 100 m 100 300 l S',                // vertical at x=100, y 100..300
    '50 500 200 0.6 re f',                  // thin filled bar at y≈500
    'Q',
  ].join('\n');
  const paths = walkVectorPaths(src);
  const hz = paths.h.filter((s) => Math.abs(s.y - 100) < 0.5);
  check('a stroked horizontal line is found', hz.length === 1, JSON.stringify(paths.h));
  check('its extent is 50..250', hz[0] && Math.abs(hz[0].x0 - 50) < 0.5 && Math.abs(hz[0].x1 - 250) < 0.5,
    hz[0] && `${hz[0].x0}..${hz[0].x1}`);
  const vt = paths.v.filter((s) => Math.abs(s.x - 100) < 0.5);
  check('a stroked vertical line is found', vt.length === 1, JSON.stringify(paths.v));
  check('its extent is 100..300', vt[0] && Math.abs(vt[0].y0 - 100) < 0.5 && Math.abs(vt[0].y1 - 300) < 0.5,
    vt[0] && `${vt[0].y0}..${vt[0].y1}`);
  const bar = paths.h.filter((s) => s.y > 490 && s.y < 510);
  check('a thin filled rectangle contributes horizontal rules', bar.length >= 1, JSON.stringify(paths.h));
}

/* ── 8. A transformed (q/cm) path is reported in page space ───────────────── */
{
  const src = 'q 2 0 0 2 10 20 cm 0 0 m 50 0 l S Q';   // scaled ×2 and moved
  const paths = walkVectorPaths(src);
  const s = paths.h[0];
  check('a cm-transformed rule is mapped to page space',
    s && Math.abs(s.y - 20) < 0.5 && Math.abs(s.x0 - 10) < 0.5 && Math.abs(s.x1 - 110) < 0.5,
    s && JSON.stringify(s));
}

/* ── 9. A ruled grid is rebuilt from its rules ───────────────────────────── */
{
  const xs = [50, 150, 270, 390];
  const ys = [600, 630, 660, 690];
  const blocks = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      // ys is bottom-up; rows are reported top-down, so label r=0 as row 3.
      blocks.push(blk(xs[c] + 5, ys[r] + 5, xs[c + 1] - 5, ys[r + 1] - 5, `${'ABC'[c]}${3 - r}`));
    }
  }
  const paths = {
    v: xs.map((x) => ({ x, y0: ys[0], y1: ys[ys.length - 1] })),
    h: ys.map((y) => ({ y, x0: xs[0], x1: xs[xs.length - 1] })),
  };
  const tables = detectTables(blocks, { page: 0, paths });
  check('a ruled 3×3 grid is detected', tables.length === 1, `tables=${tables.length}`);
  const t = tables[0];
  check('the ruled table is sourced from rules', t && t.source === 'rules', t && t.source);
  check('the ruled table has 3 rows × 3 columns',
    t && t.rows.length === 3 && t.cols.length === 3, t && `${t.rows.length}×${t.cols.length}`);
  check('the ruled table has 9 cells', t && t.cells.length === 9, t && t.cells.length);
  check('every ruled cell owns one block', t && t.cells.every((c) => c.blocks.length === 1));
  check('ruled cell C3 holds its text', t && t.cells[8].text === 'C3', t && t.cells[8].text);
}

/* ── 10. A page border is not a table ────────────────────────────────────── */
{
  const blocks = gridBlocks([[50, 150], [170, 270]], [[680, 700], [640, 660]]);
  const paths = {
    v: [{ x: 0, y0: 0, y1: 842 }, { x: 595, y0: 0, y1: 842 }],
    h: [{ y: 0, x0: 0, x1: 595 }, { y: 842, x0: 0, x1: 595 }],
  };
  const tables = detectTables(blocks, { page: 0, paths });
  check('a page border alone does not become a rule table',
    !tables.some((t) => t.source === 'rules'), JSON.stringify(tables.map((t) => t.source)));
  check('the 2×2 text grid is still recognised', tables.length === 1 && tables[0].cells.length === 4,
    JSON.stringify(tables.map((t) => t.cells.length)));
}

console.log(`\nTABLE_DETECT_RESULT pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
