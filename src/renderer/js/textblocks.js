/* Geometric text grouping for the Direct Editor.
 *
 * Two sources feed it, and both must produce the same shape:
 *
 *  1. native PDF text  — pdf.js TextItem runs, grouped into lines then blocks.
 *  2. OCR results      — Tesseract lines (already recognised), same grouping.
 *
 * The grouping is deliberately conservative: TextItem boundaries reflect
 * drawing operations, not authoring paragraphs, and a wrong merge is far more
 * destructive than a wrong split — merging across a column gutter makes an
 * edit swallow the neighbouring column.
 */

/** Style identity used for merging. Comparing pdf.js font *names* is wrong:
 *  producers emit a fresh name per subset/encoding, so the same visual style
 *  arrives as several names and every line becomes its own block. */
const styleKey = (family, size) => `${String(family || 'Helvetica').toLowerCase()}@${(size || 10).toFixed(1)}`;

/** Rotation bucket in whole degrees, snapped to the quadrant. Text at 89.7°
 *  and 90.3° is the same rotation as far as reading order is concerned. */
const rotBucket = (rad) => (Math.round((rad * 180) / Math.PI / 90) * 90 + 360) % 360;

const clampNum = (v, lo, hi) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);

/**
 * Turn pdf.js text items into geometric blocks.
 *
 * Returns blocks whose `coverRect` is axis-aligned in PDF space, with
 * `baseline`, `size`, `fontFamily`, `maxWidth`, `maxHeight`, `lineHeight`,
 * `itemIndices` and a stable `key`.
 */
export function groupTextBlocks(tc, pageWidth = 595) {
  if (!tc || !Array.isArray(tc.items)) return [];

  const runs = [];
  for (let index = 0; index < tc.items.length; index++) {
    const it = tc.items[index];
    if (!it || !it.str || !it.transform) continue;
    if (it.dir === 'ttb') continue;               // vertical writing: out of scope
    const t = it.transform;
    if (!Number.isFinite(t[4]) || !Number.isFinite(t[5])) continue;
    const size = Math.hypot(t[2], t[3]);
    if (!Number.isFinite(size) || size < 1) continue;
    // Invisible/near-zero-height text (OCR layers, hidden fields) is not
    // editable and would otherwise create phantom hit targets over the page.
    if (size < 1.5) continue;

    const angle = Math.atan2(t[1], t[0]);
    const rot = rotBucket(angle);
    const u = [Math.cos(angle), Math.sin(angle)];     // advance direction
    const n = [-Math.sin(angle), Math.cos(angle)];    // line-stacking direction

    // Width fallback: per-character producers, Type3 fonts and some Word
    // exports report width 0, which collapses every run onto its own origin
    // and shreds each line into one block per glyph. A rough advance estimate
    // keeps those documents groupable.
    let width = Math.max(0, Number(it.width) || 0);
    if (width < size * 0.08) {
      const chars = String(it.str).replace(/\s+/g, '').length || 1;
      width = chars * size * 0.5;
    }

    runs.push({
      index, text: it.str, x: t[4], y: t[5], end: t[4] + width * u[0], endY: t[5] + width * u[1],
      width, size, angle, rot, u, n,
      font: it.fontName,
      family: tc.styles?.[it.fontName]?.fontFamily || 'Helvetica',
      eol: !!it.hasEOL,
    });
  }
  if (!runs.length) return [];

  // Reading order: top-to-bottom, then left-to-right, within a rotation group.
  runs.sort((a, b) => b.y - a.y || a.x - b.x);

  /* ── Runs → lines ──────────────────────────────────────────────────── */
  const lines = [];
  for (const run of runs) {
    const prev = lines[lines.length - 1];
    const last = prev?.runs[prev.runs.length - 1];
    if (prev && last) {
      // Offset from the end of the previous run, in the line's own frame.
      const dx = run.x - last.end;
      const dy = run.y - last.endY;
      const gap = dx * last.u[0] + dy * last.u[1];          // along the baseline
      const drift = dx * last.n[0] + dy * last.n[1];        // across it
      const styleSame = styleKey(run.family, run.size) === styleKey(prev.family, prev.size);
      if (!last.eol
        && run.rot === prev.rot
        && styleSame
        && Math.abs(drift) < Math.max(1.2, run.size * 0.35)
        && gap > -run.size * 0.35 && gap < run.size * 1.5) {
        prev.runs.push(run);
        prev.end = run.end;
        prev.endY = run.endY;
        continue;
      }
    }
    lines.push({
      runs: [run], x: run.x, y: run.y, end: run.end, endY: run.endY,
      size: run.size, rot: run.rot, u: run.u, n: run.n,
      family: run.family, style: styleKey(run.family, run.size),
    });
  }

  /* ── Lines → blocks ────────────────────────────────────────────────── */
  const groups = [];
  for (const line of lines) {
    const prev = groups[groups.length - 1];
    const last = prev?.lines[prev.lines.length - 1];
    if (prev && last) {
      // Distance from the previous line measured along the stacking normal.
      const dy = line.y - last.y;
      const leading = dy * last.n[1] !== 0 ? Math.abs(dy) : Math.abs(dy);
      const indent = Math.abs(line.x - prev.x);
      if (line.rot === prev.rot
        && line.style === prev.style
        && leading > line.size * 0.6 && leading < line.size * 2.0
        && indent < line.size * 2.5) {
        prev.lines.push(line);
        prev.end = Math.max(prev.end, line.end);
        prev.right = Math.max(prev.right, line.end);
        continue;
      }
    }
    groups.push({
      lines: [line], x: line.x, end: line.end, right: line.end,
      style: line.style, family: line.family, size: line.size, rot: line.rot,
    });
  }

  return groups.map((g) => finishBlock(g, pageWidth, 'n', g.lines.flatMap((l) => l.runs.map((r) => r.index))));
}

/**
 * Build the same block shape from OCR lines.
 *
 * `lines` come from Tesseract: { text, bbox:{x0,y0,x1,y1}, confidence, words }.
 * bbox is in canvas pixels at `dpi`; the page is `pageHeight` points tall.
 * PDF space has y increasing upward, canvas has it downward — hence the flip.
 */
export function blocksFromOcrLines(lines, pageWidth, pageHeight, dpi = 200, pageIndex = 0) {
  if (!Array.isArray(lines) || !lines.length) return [];
  const s = 72 / (dpi || 200);                      // px → pt
  const flat = [];

  for (let li = 0; li < lines.length; li++) {
    const ln = lines[li];
    const text = String(ln.text || '').trim();
    if (!text) continue;
    const bb = ln.bbox || {};
    const x0 = Number(bb.x0) || 0, x1 = Number(bb.x1) || 0;
    const y0 = Number(bb.y0) || 0, y1 = Number(bb.y1) || 0;
    if (x1 <= x0 || y1 <= y0) continue;

    // Median word height is the most reliable size signal Tesseract gives.
    const hs = (ln.words || []).map((w) => (w.bbox?.y1 || 0) - (w.bbox?.y0 || 0)).filter((h) => h > 1).sort((a, b) => a - b);
    const med = hs.length ? hs[Math.floor(hs.length / 2)] : (y1 - y0);
    const boxH = (y1 - y0) * s;
    const size = clampNum((med * s) / 0.72, 4, 96) || clampNum(boxH * 1.05, 4, 96);

    const top = pageHeight - y0 * s;                // topmost y in PDF space
    const bottom = pageHeight - y1 * s;
    flat.push({
      li, text,
      x: x0 * s, end: x1 * s,
      top, bottom,
      baseline: bottom + 0.23 * boxH,
      size, rot: 0, style: styleKey('Helvetica', Math.round(size)),
      family: 'Helvetica',
      confidence: ln.confidence ?? null,
    });
  }
  if (!flat.length) return [];

  /* Snapping the raw estimates to the page's modal size is the difference
   * between "looks like the original" and "letters sized 11 / 15 / 19
   * alternating on a single body paragraph". Tesseract's per-line bbox is
   * a few percent off depending on which letters happen to be in the line,
   * so the within-paragraph jitter is real, and a human editor would
   * normalise it by hand. A wide tolerance (anything within 0.7x–1.4x of the
   * mode) keeps genuine headings and footnotes apart from body text. */
  const sizes = flat.map((l) => l.size);
  const rounded = sizes.map((s) => Math.round(s * 2) / 2);
  const counts = new Map();
  rounded.forEach((s) => counts.set(s, (counts.get(s) || 0) + 1));
  let mode = rounded[0] || 10;
  let modeCount = 0;
  for (const [s, c] of counts) if (c > modeCount) { mode = s; modeCount = c; }
  const snap = (s) => (s >= mode * 0.72 && s <= mode * 1.4) ? mode : s;
  for (const l of flat) l.size = snap(l.size);

  /* Group OCR lines into paragraphs with the same geometry test as native. */
  const groups = [];
  for (const line of flat) {
    const prev = groups[groups.length - 1];
    const last = prev?.lines[prev.lines.length - 1];
    if (prev && last) {
      const leading = last.bottom - line.bottom;      // next line sits lower
      const indent = Math.abs(line.x - prev.x);
      if (Math.abs(line.size - last.size) < Math.max(1.2, last.size * 0.35)
        && leading > line.size * 0.5 && leading < line.size * 2.1
        && indent < line.size * 2.5) {
        prev.lines.push(line);
        prev.right = Math.max(prev.right, line.end);
        continue;
      }
    }
    groups.push({ lines: [line], x: line.x, end: line.end, right: line.end,
      style: line.style, family: line.family, size: line.size, rot: 0 });
  }

  return groups.map((g) => finishBlock(g, pageWidth, 'o', null, g.lines.map((l) => l.li), pageIndex));
}

/** Shared finishing step: text, geometry and the stable identity key. */
function finishBlock(g, pageWidth, kind, itemIndices, lineIds, pageIndex = 0) {
  const isOcr = kind === 'o';
  const text = isOcr
    ? g.lines.map((l) => l.text).join('\n')
    : g.lines.map((line) => line.runs.map((r, j) => {
      if (!j) return r.text;
      const previous = line.runs[j - 1];
      const gap = r.x - previous.end;
      return gap > line.size * 0.16 && !/\s$/.test(previous.text) && !/^\s/.test(r.text) ? ' ' + r.text : r.text;
    }).join('')).join('\n');

  const indices = isOcr ? [] : (itemIndices || []).slice().sort((a, b) => a - b);

  let low, high, baseline, angle = 0;
  if (isOcr) {
    const first = g.lines[0], last = g.lines[g.lines.length - 1];
    low = last.bottom;
    high = first.top;
    baseline = [first.x, first.baseline];
  } else {
    const last = g.lines[g.lines.length - 1];
    const first = g.lines[0];
    low = last.y - last.size * 0.28;
    high = first.y + first.size * 1.08;
    baseline = [first.x, first.y];
    angle = first.rot || 0;
  }

  const left = Math.min(...g.lines.map((l) => l.x));
  const right = Math.max(...g.lines.map((l) => (isOcr ? l.end : l.end)));
  const coverRect = [left - 0.7, Math.min(low, high), right + 0.7, Math.max(low, high)];

  const key = isOcr
    ? `o:${pageIndex}:${(lineIds || []).join('.')}`
    : `n:${indices.join('.')}`;

  return {
    key, kind,
    itemIndices: indices,
    lineIds: isOcr ? (lineIds || []) : undefined,
    text, size: g.size, fontFamily: g.family,
    baseline, color: [0, 0, 0],
    coverRect, rect: coverRect.slice(),
    angle,
    maxWidth: Math.max(10, Math.min(Math.max(10, (pageWidth || 595) - left - 3), right - left + 3)),
    maxHeight: Math.abs(coverRect[3] - coverRect[1]),
    lineHeight: g.lines.length > 1
      ? Math.abs((isOcr ? g.lines[0].top : g.lines[0].y) - (isOcr ? g.lines[g.lines.length - 1].top : g.lines[g.lines.length - 1].y)) / (g.lines.length - 1)
      : g.size * 1.2,
  };
}

/** Find the pending edit that owns a block.
 *
 *  OCR blocks have no text-item indices, so identity comes from `key`. Native
 *  blocks match on `key` too when it exists, and fall back to index overlap
 *  for edits recorded before keys were introduced. */
export function editForBlock(doc, page, block) {
  const list = doc?.textEdits || [];
  if (!list.length) return undefined;
  if (block.key) {
    const byKey = list.find((e) => e.page === page && e.key === block.key);
    if (byKey) return byKey;
  }
  if (!block.itemIndices?.length) return undefined;
  const ids = new Set(block.itemIndices);
  return list.find((e) => e.page === page && e.itemIndices?.some((i) => ids.has(i)));
}

/* ── Cover + free-move model ─────────────────────────────────────────────
 *
 * A committed Direct Editor edit owns TWO footprints in PDF space:
 *
 *  - coverRect: fixed over the ORIGINAL text. The writer always paints it
 *    opaque, so the old glyphs never show through. It never moves — moving
 *    it would uncover the original.
 *  - the text box (rect + baseline): where the replacement is drawn. The
 *    user can drag it anywhere on the page; the cover stays behind.
 *
 * translateTextEdit moves the text box only. Pure (no DOM): unit-tested in
 * scripts/tools-test.mjs alongside the other planners. */

export function translateTextEdit(edit, dx, dy) {
  if (!edit || !Number.isFinite(dx) || !Number.isFinite(dy) || (!dx && !dy)) return edit;
  const shiftRect = (r) => (Array.isArray(r) && r.length === 4
    ? [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy] : r);
  if (Array.isArray(edit.rect)) edit.rect = shiftRect(edit.rect);
  if (Array.isArray(edit.baseline)) edit.baseline = [edit.baseline[0] + dx, edit.baseline[1] + dy];
  // coverRect and exciseRect deliberately untouched: the cover must keep
  // hiding the original text no matter where the replacement travels.
  return edit;
}

/** PDF-space box the replacement text is drawn in. The on-screen preview
 *  (annots.js) and the writer (pdfwrite.js) share it so the background wash
 *  behind moved text matches what the saved file paints. Falls back to the
 *  edit's rect for single-run edits, which carry no baseline box. */
export function textEditDrawBox(e) {
  if (!e) return null;
  if (e.itemIndices?.length && Array.isArray(e.baseline) && e.baseline.length === 2) {
    const size = Number(e.size) || 11;
    return [
      e.baseline[0],
      e.baseline[1] - size * 0.3 - (Number(e.maxHeight) || 0),
      e.baseline[0] + (Number(e.maxWidth) || 10),
      e.baseline[1] + size * 1.1,
    ];
  }
  return Array.isArray(e.rect) ? e.rect.slice() : null;
}

const sameRect = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === 4 && b.length === 4
  && a.every((v, k) => Math.abs(v - b[k]) < 1e-6);

/**
 * Every rect the writer must wash before drawing the replacement: the fixed
 * cover over the original, every box a previous save drew into (so
 * move → save → move → save cannot leave ghost copies in the file), and the
 * current draw box. The preview paints the same list — screen and file agree.
 */
export function textEditWashes(e) {
  const out = [];
  const push = (r) => {
    if (!Array.isArray(r) || r.length !== 4 || !r.every(Number.isFinite)) return;
    if (!out.some((o) => sameRect(o, r))) out.push(r.slice());
  };
  push(e?.coverRect);
  for (const b of e?.priorBoxes || []) push(b);
  push(textEditDrawBox(e));
  return out;
}

export function blockText(doc, page, block) {
  return editForBlock(doc, page, block)?.text ?? block.text;
}

/* Shared wrapping policy for preview and writer; caller supplies actual font
 * metrics. Explicit newlines are kept; a word longer than the box is split. */
export function wrapBlockText(text, maxWidth, measure) {
  const out = [];
  for (const paragraph of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    if (!paragraph) { out.push(''); continue; }
    let line = '';
    for (const part of paragraph.match(/\S+\s*|\s+/gu) || []) {
      if (line && measure(line + part) > maxWidth) { out.push(line.trimEnd()); line = part.trimStart(); }
      else line += part;
      while (line.length > 1 && measure(line) > maxWidth) {
        let cut = 1;
        while (cut < line.length && measure(line.slice(0, cut + 1)) <= maxWidth) cut++;
        out.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}
