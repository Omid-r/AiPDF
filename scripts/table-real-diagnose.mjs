#!/usr/bin/env node
/**
 * Diagnose the real tender PDF end-to-end with the production pipeline:
 *   content stream → walkVectorPaths (rules) → groupTextBlocks (blocks)
 *   → detectTables (grid) → the cell split.
 * Prints every intermediate so the exact failure is visible.
 *
 *   node scripts/table-real-diagnose.mjs "path/to/file.pdf"
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import * as PL from '@cantoo/pdf-lib';
import { groupTextBlocks, textItemBoxes } from '../src/renderer/js/textblocks.js';
import { detectTables, walkVectorPaths } from '../src/renderer/js/tables.js';

const FILE = process.argv[2];
if (!FILE) { console.error('usage: node scripts/table-real-diagnose.mjs <pdf>'); process.exit(1); }
const bytes = new Uint8Array(await readFile(FILE));

const pl = await PL.PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
const plPage = pl.getPage(0);
const { PDFName, PDFArray, PDFDict } = PL;

/* Collect content streams: page Contents + any Form XObjects (one level deep). */
const streams = [];
function collectRefs(entry, depth = 0) {
  if (entry == null || depth > 2) return;
  const resolved = pl.context.lookup(entry);
  if (resolved instanceof PDFArray) {
    for (let i = 0; i < resolved.size(); i++) collectRefs(resolved.get(i), depth);
    return;
  }
  const obj = entry != null ? pl.context.lookup(entry) : resolved;
  if (!obj) return;
  const raw = obj.contents instanceof Uint8Array ? obj.contents
    : (typeof obj.getContents === 'function' ? obj.getContents() : null);
  const filter = obj.dict?.get?.(PDFName.of('Filter'))?.toString() || '';
  if (raw) {
    const buf = Buffer.from(raw);
    const text = (filter.includes('FlateDecode') ? zlib.inflateSync(buf) : buf).toString('latin1');
    streams.push(text);
  }
  // Descend into XObject Forms.
  const xo = obj.dict?.get?.(PDFName.of('Resources'))
    ? pl.context.lookup(obj.dict.get(PDFName.of('Resources'))) : null;
  const xoDict = xo?.get?.(PDFName.of('XObject')) ? pl.context.lookup(xo.get(PDFName.of('XObject'))) : null;
  if (xoDict instanceof PDFDict) {
    for (const [, value] of xoDict.entries()) {
      const inner = pl.context.lookup(value);
      const st = inner?.dict?.get?.(PDFName.of('Subtype'))?.toString() || '';
      if (st === '/Form') collectRefs(value, depth + 1);
    }
  }
}
const contents = plPage.node.get(PDFName.of('Contents'));
collectRefs(contents);
// Also page-level Resources XObjects (rules sometimes live ONLY there).
{
  const res = plPage.node.get(PDFName.of('Resources'));
  const r = res ? pl.context.lookup(res) : null;
  const xoDict = r?.get?.(PDFName.of('XObject')) ? pl.context.lookup(r.get(PDFName.of('XObject'))) : null;
  if (xoDict instanceof PDFDict) {
    for (const [, value] of xoDict.entries()) {
      const inner = pl.context.lookup(value);
      const st = inner?.dict?.get?.(PDFName.of('Subtype'))?.toString() || '';
      if (st === '/Form') collectRefs(value, 1);
    }
  }
}
console.log(`content streams collected: ${streams.length} (lens ${streams.map((s) => s.length).join(', ')})`);

const paths = { h: [], v: [] };
for (const text of streams) {
  const p = walkVectorPaths(text);
  paths.h.push(...p.h);
  paths.v.push(...p.v);
}
console.log(`rules: ${paths.h.length} horizontal, ${paths.v.length} vertical`);
const uniqH = [...new Set(paths.h.map((s) => s.y.toFixed(1)))];
const uniqV = [...new Set(paths.v.map((s) => s.x.toFixed(1)))];
console.log(`distinct H ys: ${uniqH.slice(0, 30).join(', ')}`);
console.log(`distinct V xs: ${uniqV.slice(0, 30).join(', ')}`);

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const pdf = await pdfjs.getDocument({ data: bytes.slice(0), isEvalSupported: false }).promise;
const pdfPage = await pdf.getPage(1);
const vp = pdfPage.getViewport({ scale: 1 });
const tc = await pdfPage.getTextContent();
console.log(`text items: ${tc.items.length}, page ${Math.round(vp.width)}x${Math.round(vp.height)}`);

const blocks = groupTextBlocks(tc, vp.width).filter((b) => String(b.text || '').trim());
console.log(`\ngroupTextBlocks → ${blocks.length} blocks:`);
for (const b of blocks) {
  const r = b.coverRect.map(Math.round);
  console.log(`  ${JSON.stringify(r)} size=${b.size?.toFixed?.(1)} "${String(b.text).replace(/\s+/g, ' ').slice(0, 60)}"`);
}

const tables = detectTables(blocks, { page: 0, pageW: vp.width, pageH: vp.height, paths });
console.log(`\ndetectTables → ${tables.length} table(s)`);
for (const t of tables) {
  console.log(`  ${t.id} source=${t.source} bbox=${JSON.stringify(t.bbox.map(Math.round))} rows=${t.rows.length} cols=${t.cols.length}`);
  for (const row of t.rows) {
    console.log(`    row y[${Math.round(row.y0)},${Math.round(row.y1)}] cells=${row.cells.map((c) => c.blocks.length).join(',')}`);
  }
}

/* The split (same steps as textedit.js splitBlocksByCells). */
function splitBlocksByCells(tc, blocks, tables, pageWidth) {
  if (!tables.length || !tc?.items?.length) return { blocks, tables };
  const boxByIndex = new Map(textItemBoxes(tc).map((b) => [b.index, b]));
  const contains = (r, cell) => {
    const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2;
    return cx >= cell[0] && cx <= cell[2] && cy >= cell[1] && cy <= cell[3];
  };
  const cellKey = (t, c) => `${t.id}|${c.row}|${c.col}`;
  const entries = [];
  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi];
    const table = tables.find((t) => contains(block.coverRect, t.bbox));
    if (!table || !block.itemIndices?.length) { entries.push({ block, from: bi }); continue; }
    const perCell = new Map();
    for (const idx of block.itemIndices) {
      const b = boxByIndex.get(idx);
      if (!b) continue;
      const cell = table.cells.find((c) => contains(b.rect, c.rect));
      if (!cell) continue;
      if (!perCell.has(cell)) perCell.set(cell, new Set());
      perCell.get(cell).add(idx);
    }
    if (!perCell.size) { entries.push({ block, from: bi }); continue; }
    for (const [cell, idxs] of perCell) {
      for (const piece of groupTextBlocks(tc, pageWidth, idxs)) {
        if (!String(piece.text || '').trim()) continue;
        entries.push({ block: piece, cell, table });
      }
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

const split = splitBlocksByCells(tc, blocks, tables, vp.width);
console.log(`\nafter split → ${split.blocks.length} blocks`);
for (const b of split.blocks) {
  const r = (b.ownRect || b.coverRect).map(Math.round);
  console.log(`  ${JSON.stringify(r)} "${String(b.text).replace(/\s+/g, ' ').slice(0, 55)}"`);
}
