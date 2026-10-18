/**
 * Table structure recognition for the Direct Editor.
 *
 * A table is not an image-recognition problem here: the page already gives us
 * axis-aligned text blocks with exact geometry (textblocks.js) and, when a
 * content stream is available, the vector ruling lines that drew the borders.
 * From those we recover the authoring structure the research asks the editor to
 * respect — table → rows → columns → cells — so a cell edit can be scoped to the
 * CELL rather than to the whole line, reusing the writer's existing frame /
 * overset model unchanged.
 *
 * Two detectors, in priority order:
 *
 *   1. RULING LINES (walkVectorPaths). Stroked segments and thin filled bars
 *      give exact cell boundaries, including cells whose text is empty. When a
 *      grid of at least two vertical and two horizontal rules is found, the
 *      table is rebuilt from it (source: 'rules').
 *
 *   2. TEXT GEOMETRY. Blocks on a common baseline form a row; gutters that
 *      recur across rows form column boundaries; row band × column interval is
 *      a cell (source: 'text'). This covers borderless tables.
 *
 * Deliberately conservative, like groupTextBlocks: a false table would scope an
 * edit to a narrower rect than the text it replaces, so we require several rows,
 * several columns, and repeated column support. Two-column PROSE must not look
 * like a table — its paragraphs yield one block per column, so it fails the
 * "at least two blocks in a row" test.
 */

import { tokenize, mul, applyMatrix, IDENTITY } from './textops.js';

/* ── small numeric helpers ───────────────────────────────────────────────── */

const median = (a) => {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

/** Merge values within `tol` into one representative (their mean). */
function clusterAxis(values, tol = 2) {
  const out = [];
  for (const v of values.slice().sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && Math.abs(v - last.sum / last.n) <= tol) {
      last.sum += v; last.n++;
    } else {
      out.push({ sum: v, n: 1 });
    }
  }
  return out.map((c) => c.sum / c.n);
}

/* ── 1. Vector ruling lines from a decoded content stream ────────────────── */

/**
 * Walk a content stream and collect the straight segments that can act as table
 * rules, in PDF user space (y up), matching the coordinate system of
 * groupTextBlocks and walkTextBlocks.
 *
 * Only straight lines matter: `m`/`l` strokes, rectangle edges, and the closing
 * edge of `s`/`b`/`h`. Curves are ignored — a table border is not a bezier.
 * The CTM stack is tracked exactly like walkTextBlocks so a `q`/`cm` block that
 * scales or translates the page still yields page-space coordinates.
 *
 * Returns { h: [{y, x0, x1}], v: [{x, y0, y1}] }.
 */
export function walkVectorPaths(src) {
  const toks = tokenize(src);
  let ctm = IDENTITY;
  const stack = [];
  const operands = [];
  const h = [], v = [];
  let cx = 0, cy = 0, sx = 0, sy = 0;
  let path = [];

  const nums = (k) => operands.slice(-k).map((x) => (typeof x === 'object' ? 0 : x));
  const T = (x, y) => applyMatrix(ctm, x, y);

  const flush = () => {
    for (const seg of path) {
      const dx = Math.abs(seg.x1 - seg.x0);
      const dy = Math.abs(seg.y1 - seg.y0);
      if (dx <= 0.75 && dy >= 1) {
        v.push({ x: (seg.x0 + seg.x1) / 2, y0: Math.min(seg.y0, seg.y1), y1: Math.max(seg.y0, seg.y1) });
      } else if (dy <= 0.75 && dx >= 1) {
        h.push({ y: (seg.y0 + seg.y1) / 2, x0: Math.min(seg.x0, seg.x1), x1: Math.max(seg.x0, seg.x1) });
      }
    }
    path = [];
  };
  const closePath = () => { if (cx !== sx || cy !== sy) path.push({ x0: cx, y0: cy, x1: sx, y1: sy }); };

  for (const tk of toks) {
    if (tk.t === 'num') { operands.push(tk.v); continue; }
    if (tk.t === 'name' || tk.t === 'str' || tk.t === 'hex' || tk.t === '['
      || tk.t === ']' || tk.t === '{' || tk.t === '}' || tk.t === 'dictopen' || tk.t === 'dictclose') {
      operands.push(tk); continue;
    }
    if (tk.t !== 'op') { operands.length = 0; continue; }
    const op = tk.v;

    switch (op) {
      case 'q': stack.push(ctm.slice()); break;
      case 'Q': ctm = stack.pop() || IDENTITY; break;
      case 'cm': { const a = nums(6); if (a.length === 6) ctm = mul(ctm, a); break; }
      case 'm': {
        const a = nums(2);
        if (a.length === 2) { [cx, cy] = T(a[0], a[1]); sx = cx; sy = cy; }
        break;
      }
      case 'l': {
        const a = nums(2);
        if (a.length === 2) {
          const [nx, ny] = T(a[0], a[1]);
          path.push({ x0: cx, y0: cy, x1: nx, y1: ny });
          cx = nx; cy = ny;
        }
        break;
      }
      case 're': {
        const a = nums(4);
        if (a.length === 4) {
          const [x, y, w, hh] = a;
          const c = [T(x, y), T(x + w, y), T(x + w, y + hh), T(x, y + hh)];
          for (let i = 0; i < 4; i++) {
            const p = c[i], q = c[(i + 1) % 4];
            path.push({ x0: p[0], y0: p[1], x1: q[0], y1: q[1] });
          }
          [cx, cy] = c[0]; sx = cx; sy = cy;
        }
        break;
      }
      case 'h': closePath(); break;
      case 's': case 'b': case 'b*': closePath(); flush(); break;
      case 'S': case 'f': case 'F': case 'f*': case 'B': case 'B*': flush(); break;
      case 'n': case 'W': case 'W*': path = []; break;
      default: break;
    }
    operands.length = 0;
  }
  return { h, v };
}

/* ── 2. Text-geometry clustering ─────────────────────────────────────────── */

/** Blocks on a common baseline form a row. */
function clusterRows(items, medSize) {
  const tol = Math.max(2.5, medSize * 0.7);
  const sorted = items.slice().sort((a, b) => (b.rect[3] - a.rect[3]) || (a.rect[0] - b.rect[0]));
  const rows = [];
  for (const it of sorted) {
    const top = it.rect[3];
    const bottom = it.rect[1];
    const cy = (top + bottom) / 2;
    const row = rows[rows.length - 1];
    if (row) {
      const overlap = Math.min(row.top, top) - Math.max(row.bottom, bottom);
      const minH = Math.min(row.top - row.bottom, top - bottom);
      if ((overlap > 0 && overlap >= minH * 0.5) || Math.abs(row.cy - cy) <= tol) {
        row.items.push(it);
        row.top = Math.max(row.top, top);
        row.bottom = Math.min(row.bottom, bottom);
        row.cy = row.items.reduce((s, x) => s + (x.rect[1] + x.rect[3]) / 2, 0) / row.items.length;
        continue;
      }
    }
    rows.push({ items: [it], top, bottom, cy });
  }
  return rows;
}

/** Consecutive rows with at least two blocks are a table run. A large vertical
 *  gap starts a NEW table: two tables stacked on a page must not merge just
 *  because every row happens to have two cells.
 *
 *  The gap is measured against the run's OWN row pitch, not a fixed number of
 *  points. A heading or a paragraph sitting just above a table leaves a large
 *  gap to the table's first row, and a fixed threshold then rejects that first
 *  row — the table gets detected one row short, or (worse) a two-row table
 *  disappears completely. Once the run has two rows its own pitch is the only
 *  honest scale to judge "is this a new table?" against. */
function splitRuns(rows) {
  const runs = [];
  let cur = null;
  for (const r of rows) {
    if (r.items.length < 2) { cur = null; continue; }   // paragraphs end a run
    if (!cur) { cur = [r]; runs.push(cur); continue; }

    const last = cur[cur.length - 1];
    const gap = last.bottom - r.top;
    const rowH = Math.min(last.top - last.bottom, r.top - r.bottom) || 1;
    const pitch = cur.length > 1
      ? median(cur.slice(1).map((x, i) => Math.max(0, cur[i].bottom - x.top)))
      : null;
    const limit = pitch != null ? Math.max(pitch * 2.5, rowH * 3) : Math.max(24, rowH * 3);
    if (gap > limit) { cur = [r]; runs.push(cur); continue; }
    cur.push(r);
  }
  return runs.filter((run) => run.length >= 2);
}

/** Infer columns from gutters that recur across the run's rows, then build cells. */
function tableFromRun(run, byIndex, { page, medSize, gutterMin: gMin, minSupport: mSup }) {
  const all = run.flatMap((r) => r.items);
  if (all.length < 4) return null;

  // A table is made of CELLS, not paragraphs. Two-column prose can align into
  // the exact same rows × columns shape as a 2×2 table, so reject a run whose
  // blocks are tall multi-line paragraphs: a cell rarely exceeds a handful of
  // lines, and a row band rarely exceeds ~10 lines of text.
  const linesOf = (t) => String(t || '').split('\n').filter((s) => s.trim()).length || 1;
  const medLines = median(all.map((x) => linesOf(x.text)));
  if (medLines > 5) return null;
  const medRowH = median(run.map((r) => r.top - r.bottom));
  if (medRowH > Math.max(medSize * 10, 120)) return null;

  const left = Math.min(...all.map((x) => x.rect[0]));
  const right = Math.max(...all.map((x) => x.rect[2]));
  const top = Math.max(...run.map((r) => r.top));
  const bottom = Math.min(...run.map((r) => r.bottom));
  if (!(right > left && top > bottom)) return null;

  const gutterMin = gMin ?? Math.max(4, medSize * 0.8);
  const gaps = [];
  for (const r of run) {
    const row = r.items.slice().sort((a, b) => a.rect[0] - b.rect[0]);
    for (let i = 1; i < row.length; i++) {
      const gx0 = row[i - 1].rect[2];
      const gx1 = row[i].rect[0];
      if (gx1 - gx0 >= gutterMin) gaps.push({ row: r, x0: gx0, x1: gx1, cx: (gx0 + gx1) / 2 });
    }
  }
  if (!gaps.length) return null;

  // Cluster gutters across rows; a column boundary must recur.
  const tol = Math.max(3, medSize * 0.8);
  gaps.sort((a, b) => a.cx - b.cx);
  const clusters = [];
  for (const g of gaps) {
    const c = clusters[clusters.length - 1];
    if (c && (Math.abs(g.cx - c.cx) <= tol
      || (g.x0 <= c.x1 + tol && g.x1 >= c.x0 - tol))) {
      c.x0 = Math.min(c.x0, g.x0);
      c.x1 = Math.max(c.x1, g.x1);
      c.cx = (c.x0 + c.x1) / 2;
      c.rows.add(g.row);
      continue;
    }
    clusters.push({ x0: g.x0, x1: g.x1, cx: g.cx, rows: new Set([g.row]) });
  }
  const minSupport = mSup ?? Math.max(2, Math.ceil(run.length * 0.5));
  const gutters = clusters.filter((c) => c.rows.size >= minSupport).sort((a, b) => a.cx - b.cx);
  if (!gutters.length) return null;

  const bounds = [left, ...gutters.map((g) => g.cx), right];
  const cols = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    if (bounds[i + 1] - bounds[i] > 1) cols.push({ index: cols.length, x0: bounds[i], x1: bounds[i + 1] });
  }
  if (cols.length < 2) return null;

  const multiRows = run.filter((r) => r.items.length >= 2).length;
  if (multiRows < 2) return null;

  const rows = run.map((r, ri) => {
    const cells = cols.map((c) => ({ row: ri, col: c.index, rect: [c.x0, r.bottom, c.x1, r.top], blocks: [], text: '' }));
    for (const it of r.items) {
      const cx = (it.rect[0] + it.rect[2]) / 2;
      let ci = cols.findIndex((c) => cx >= c.x0 && cx < c.x1);
      if (ci < 0) ci = cx < cols[0].x0 ? 0 : cols.length - 1;
      cells[ci].blocks.push(it.i);
    }
    for (const cell of cells) {
      cell.text = cell.blocks.map((bi) => byIndex.get(bi)?.text || '').join('\n');
    }
    return { index: ri, y0: r.bottom, y1: r.top, cells };
  });

  return {
    page, source: 'text',
    bbox: [left, bottom, right, top],
    rows, cols,
    cells: rows.flatMap((r) => r.cells),
  };
}

/* ── 3. Rule grids (authoritative when a grid exists) ────────────────────── */

/**
 * Build tables directly from a grid of ruling lines.
 *
 * Rules are grouped into connected components — a vertical rule joins a
 * horizontal one where they cross — so two tables on one page never merge and a
 * page border (two rules each way) is rejected as a 1×1 grid. A component with
 * at least three distinct x and y rules is a real grid; text blocks are then
 * assigned to the cell containing their centre. This is what recovers cells
 * whose text is empty and the exact border geometry that text clustering can
 * only approximate.
 */
function tablesFromRules(paths, items, byIndex, { page }) {
  const V = paths?.v || [];
  const H = paths?.h || [];
  if (V.length < 2 || H.length < 2) return [];

  const vr = V.map((s, i) => ({ i, x: s.x, y0: s.y0, y1: s.y1 }));
  const hr = H.map((s, i) => ({ i, y: s.y, x0: s.x0, x1: s.x1 }));
  const av = new Map(vr.map((r) => [r.i, []]));
  const ah = new Map(hr.map((r) => [r.i, []]));
  for (const v of vr) {
    for (const h of hr) {
      if (v.x >= h.x0 - 1 && v.x <= h.x1 + 1 && h.y >= v.y0 - 1 && h.y <= v.y1 + 1) {
        av.get(v.i).push(h.i);
        ah.get(h.i).push(v.i);
      }
    }
  }

  const seenV = new Set();
  const seenH = new Set();
  const comps = [];
  for (const start of vr) {
    if (seenV.has(start.i)) continue;
    const stack = [['v', start.i]];
    const comp = { v: [], h: [] };
    while (stack.length) {
      const [kind, id] = stack.pop();
      if (kind === 'v') {
        if (seenV.has(id)) continue;
        seenV.add(id); comp.v.push(vr[id]);
        for (const hid of av.get(id)) if (!seenH.has(hid)) stack.push(['h', hid]);
      } else {
        if (seenH.has(id)) continue;
        seenH.add(id); comp.h.push(hr[id]);
        for (const vid of ah.get(id)) if (!seenV.has(vid)) stack.push(['v', vid]);
      }
    }
    comps.push(comp);
  }

  const out = [];
  for (const comp of comps) {
    const xs = clusterAxis(comp.v.map((r) => r.x), 2);
    const ys = clusterAxis(comp.h.map((r) => r.y), 2);
    // Three boundaries each way = at least 2 columns and 2 rows. A page border
    // (two each way) is a 1×1 box, not a table.
    if (xs.length < 3 || ys.length < 3) continue;
    const x0 = xs[0], x1 = xs[xs.length - 1];
    const y0 = ys[0], y1 = ys[ys.length - 1];
    if (!(x1 - x0 > 4 && y1 - y0 > 4)) continue;

    const cols = [];
    for (let i = 0; i < xs.length - 1; i++) {
      if (xs[i + 1] - xs[i] > 1) cols.push({ index: cols.length, x0: xs[i], x1: xs[i + 1] });
    }
    if (cols.length < 2) continue;
    const rows = [];
    for (let j = ys.length - 2; j >= 0; j--) {
      const cells = cols.map((c) => ({
        row: rows.length, col: c.index, rect: [c.x0, ys[j], c.x1, ys[j + 1]], blocks: [], text: '',
      }));
      rows.push({ index: rows.length, y0: ys[j], y1: ys[j + 1], cells });
    }
    if (rows.length < 2) continue;

    for (const it of items) {
      const cx = (it.rect[0] + it.rect[2]) / 2;
      const cy = (it.rect[1] + it.rect[3]) / 2;
      if (cx < x0 - 2 || cx > x1 + 2 || cy < y0 - 2 || cy > y1 + 2) continue;
      const col = cols.find((c) => cx >= c.x0 - 1 && cx <= c.x1 + 1);
      const row = rows.find((r) => cy >= r.y0 - 1 && cy <= r.y1 + 1);
      if (col && row) row.cells[col.index].blocks.push(it.i);
    }
    const assigned = rows.reduce((n, r) => n + r.cells.reduce((m, c) => m + c.blocks.length, 0), 0);
    if (!assigned) continue;
    for (const row of rows) {
      for (const cell of row.cells) {
        cell.text = cell.blocks.map((bi) => byIndex.get(bi)?.text || '').join('\n');
      }
    }
    out.push({
      page, source: 'rules',
      bbox: [x0, y0, x1, y1],
      rows, cols,
      cells: rows.flatMap((r) => r.cells),
    });
  }
  return out;
}

/* Rule snapping is intentionally NOT applied to a text-derived table: a page
 * border is itself a pair of rules each way, and snapping to it would turn a
 * 2×2 text table into a page-sized grid. Rule geometry is used only when it
 * forms a genuine grid (tablesFromRules), which is authoritative. */

/* ── Public API ──────────────────────────────────────────────────────────── */

/**
 * Detect tables on a page.
 *
 * @param {Array} blocks   groupTextBlocks / blocksFromOcrLines output.
 * @param {Object} opts    { page, pageW, pageH, paths } — paths from
 *                         walkVectorPaths, when a content stream is available.
 * @returns {Array} tables [{ id, page, source, bbox, rows, cols, cells }]
 */
export function detectTables(blocks, opts = {}) {
  const { page = 0, pageW = 595, pageH = 842, paths = null } = opts;
  const byIndex = new Map();
  const items = [];
  for (let i = 0; i < (blocks || []).length; i++) {
    const b = blocks[i];
    const rect = b?.coverRect || b?.rect;
    if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isFinite)) continue;
    if (!String(b.text || '').trim()) continue;
    if (!(rect[2] > rect[0] && rect[3] > rect[1])) continue;
    const it = { i, rect, size: Number(b.size) || 10, text: String(b.text), block: b };
    items.push(it);
    byIndex.set(i, it);
  }
  if (items.length < 4) return [];

  const medSize = median(items.map((x) => x.size)) || 10;

  // Ruling lines are authoritative when they form a real grid: they give exact
  // boundaries and recover empty cells.
  const ruleTables = paths ? tablesFromRules(paths, items, byIndex, { page }) : [];

  // Text clustering finds borderless tables. A text table that overlaps a rule
  // table is the SAME table seen twice, so it is dropped.
  const rows = clusterRows(items, medSize);
  const runs = splitRuns(rows);
  const textTables = [];
  for (const run of runs) {
    const t = tableFromRun(run, byIndex, { page, medSize });
    if (t) textTables.push(t);
  }

  const overlaps = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
  const tables = [...ruleTables];
  for (const t of textTables) {
    if (ruleTables.some((r) => overlaps(t.bbox, r.bbox))) continue;
    tables.push(t);
  }
  tables.forEach((t, k) => { t.id = `t${page}_${k}`; });
  return tables;
}

/**
 * Table detection over OCR column segments (tablesFromSegmentItems).
 *
 * A scan has no vector rules, so the grid must come from text geometry alone.
 * The caller first cuts OCR lines into cell-sized segments (textblocks
 * ocrSplitSegments); this then runs the same row-cluster → gutter-cluster
 * machinery detectTables uses for borderless tables and returns the identical
 * {bbox, rows, cols, cells} shape, with cell.blocks holding SEGMENT ids.
 */
export function tablesFromSegmentItems(segments, opts = {}) {
  const { page = 0 } = opts;
  const items = [];
  const byIndex = new Map();
  for (const s of segments || []) {
    const rect = s?.rect;
    if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isFinite)) continue;
    if (!String(s.text || '').trim()) continue;
    if (!(rect[2] > rect[0] && rect[3] > rect[1])) continue;
    const it = { i: s.i, rect, size: Number(s.size) || 10, text: String(s.text) };
    items.push(it);
    byIndex.set(s.i, it);
  }
  if (items.length < 4) return [];

  const medSize = median(items.map((x) => x.size)) || 10;
  const rows = clusterRows(items, medSize);
  const runs = splitRuns(rows);
  const out = [];
  for (const run of runs) {
    // Segments are already cell-cut (pipes + gutters), so record every gutter
    // even a single band wide — a real column needs no second witness here,
    // and requiring one silently fuses narrow neighbours (col1|col2 at 9pt in
    // the tender sheet). The paragraph guards in tableFromRun still reject
    // prose.
    const t = tableFromRun(run, byIndex, { page, medSize, gutterMin: Math.max(3, medSize * 0.5), minSupport: 1 });
    if (t) out.push(t);
  }
  extendUpward(out, rows, byIndex);
  out.forEach((t, k) => { t.id = `t${page}_${k}`; });
  return out;
}

/**
 * Pull tightly-pitched text bands above a detected grid INTO it as extra rows.
 *
 * A table's header often has a second line whose cells hold a single segment
 * ("(मू.अ. कर र पि.एस. समेत)"), which breaks the run detector and leaves the
 * first row out of the grid. A band belongs to the table when it sits directly
 * above at wrapped-line pitch (gap ≤ 0.6× the smaller band height — real row
 * separations, or the space above the table, are larger) and all of its text
 * lies within the grid's column span. Absorbed bands become ordinary rows so
 * the header cells split exactly like the body ones.
 */
function extendUpward(tables, bands, byIndex) {
  if (!tables.length) return;
  const bandOfItem = new Map();
  bands.forEach((b, bi) => { for (const it of b.items) bandOfItem.set(it.i, bi); });
  const used = new Set();
  for (const t of tables) {
    let [x0, y0, x1, y1] = t.bbox;
    // topmost band currently in the table
    let topBi = -1;
    for (const row of t.rows) for (const cell of row.cells) for (const bi of cell.blocks) {
      const b = bandOfItem.get(bi);
      if (b != null) topBi = topBi < 0 ? b : Math.min(topBi, b);
    }
    if (topBi <= 0) continue;
    for (;;) {
      const candBi = topBi - 1;
      if (candBi < 0 || used.has(candBi)) break;
      const cand = bands[candBi];
      const prev = bands[topBi];
      const candH = cand.top - cand.bottom;
      const prevH = prev.top - prev.bottom;
      const gap = Math.abs(cand.bottom - prev.top);
      if (gap > 0.6 * Math.min(candH, prevH)) break;
      // Membership by segment CENTER: a header's last column often overflows
      // the grid's right edge by a point or two — the glyphs are still the
      // table's.
      if (!cand.items.every((it) => {
        const cx = (it.rect[0] + it.rect[2]) / 2;
        return cx >= x0 - 3 && cx <= x1 + 3;
      })) break;
      // Absorb: new top row, cells by column.
      const rowCells = t.cols.map((c) => ({
        row: 0, col: c.index, rect: [c.x0, cand.bottom, c.x1, cand.top], blocks: [], text: '',
      }));
      for (const it of cand.items) {
        const cx = (it.rect[0] + it.rect[2]) / 2;
        let ci = rowCells.findIndex((c) => cx >= c.rect[0] && cx <= c.rect[2]);
        if (ci < 0) ci = 0;
        rowCells[ci].blocks.push(it.i);
      }
      for (const cell of rowCells) cell.text = cell.blocks.map((bi) => byIndex.get(bi)?.text || '').join('\n');
      for (const row of t.rows) { row.index += 1; for (const cell of row.cells) cell.row = row.index; }
      t.rows.unshift({ index: 0, y0: cand.bottom, y1: cand.top, cells: rowCells });
      t.cells = t.rows.flatMap((r) => r.cells);
      y1 = cand.top;
      used.add(candBi);
      topBi = candBi;
    }
    t.bbox = [x0, y0, x1, y1];
  }
}

/** The table cell that owns a given block index, or null. */
export function tableForBlock(tables, blockIndex) {
  for (const table of tables || []) {
    for (const row of table.rows) {
      for (const cell of row.cells) {
        if (cell.blocks.includes(blockIndex)) return { table, cell, row, col: cell.col };
      }
    }
  }
  return null;
}

/** The table cell containing a PDF-space point, or null. */
export function cellAtPoint(tables, x, y) {
  for (const table of tables || []) {
    const [x0, y0, x1, y1] = table.bbox;
    if (x < x0 || x > x1 || y < y0 || y > y1) continue;
    for (const row of table.rows) {
      for (const cell of row.cells) {
        const r = cell.rect;
        if (x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]) return { table, cell, row };
      }
    }
  }
  return null;
}

/** Human label for the panel / editor note: "Table 1 · R2C3 of 3×4". */
export function tableLabel(table, cell, index = 0) {
  const rows = table?.rows?.length || 0;
  const cols = table?.cols?.length || 0;
  const r = (cell?.row ?? 0) + 1;
  const c = (cell?.col ?? 0) + 1;
  return `Table ${index + 1} · R${r}C${c} of ${rows}×${cols}`;
}
