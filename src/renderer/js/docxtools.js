/**
 * Batch document tools — overlay, scale, blank-page removal, image extraction
 * and colour adjustment.
 *
 * Everything here is deliberately DOM-free so it can be unit-tested in plain
 * Node (scripts/tools-test.mjs) and reused from the UI layer. The functions
 * mutate the open document's page-op model; app.js turns each one into a
 * modal, a toast and a structural commit.
 */

/** Parse "1-3,5,8-10" into a sorted, de-duplicated array of 0-based indices. */
export function parsePageRange(text, count) {
  const set = new Set();
  for (const part of String(text || '').split(',')) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
      if (i >= 1 && i <= count) set.add(i - 1);
    }
  }
  return Array.from(set).sort((a, b) => a - b);
}

/** Every page index, 0-based. */
export function allPages(count) {
  return Array.from({ length: count }, (_, i) => i);
}

/** A page is "blank" when it carries no text and no non-trivial drawing ops.
 *  Mirrors pages.js isBlankPage() but reads a plain operators record so the
 *  same rule works on freshly parsed pages. */
export function isBlankPage(ops) {
  if (!ops) return false;
  return ops.hasText === false && ops.hasOps === false;
}

/** Collect the indices of pages that are blank by the rule above. */
export function findBlankPages(list) {
  const out = [];
  list.forEach((ops, i) => { if (isBlankPage(ops)) out.push(i); });
  return out;
}

/**
 * Convert a CSS-filter spec (used by the colour-adjustment UI) into numeric
 * factors. Returns null when nothing would change.
 */
export function filterSpecToFactors(spec) {
  const out = { brightness: 1, contrast: 1, invert: 0, grayscale: 0, sepia: 0, saturate: 1 };
  let touched = false;
  for (const part of String(spec || '').split(/\s+/)) {
    const m = /^([a-z-]+)\(([^)]+)\)$/i.exec(part);
    if (!m) continue;
    const v = Number(m[2]);
    if (!Number.isFinite(v)) continue;
    const k = m[1].toLowerCase();
    if (k === 'brightness') { out.brightness = v; touched = true; }
    else if (k === 'contrast') { out.contrast = v; touched = true; }
    else if (k === 'invert') { out.invert = v; touched = true; }
    else if (k === 'grayscale') { out.grayscale = v; touched = true; }
    else if (k === 'sepia') { out.sepia = v; touched = true; }
    else if (k === 'saturate') { out.saturate = v; touched = true; }
  }
  return touched ? out : null;
}

/**
 * Colour presets for Adjust Colors. Stirling's counterpart offers several;
 * these map onto the same canvas filter pipeline the app already uses for
 * redaction rasterisation.
 */
export const COLOR_PRESETS = [
  { id: 'lighten', label: 'Lighten', filter: 'brightness(1.18)' },
  { id: 'darken', label: 'Darken', filter: 'brightness(0.82)' },
  { id: 'contrast', label: 'Contrast boost', filter: 'contrast(1.35)' },
  { id: 'invert', label: 'Invert (night reading)', filter: 'invert(1)' },
  { id: 'grayscale', label: 'Grayscale', filter: 'grayscale(1)' },
  { id: 'sepia', label: 'Sepia', filter: 'sepia(0.75)' },
  { id: 'scan', label: 'Scanner effect', filter: 'grayscale(0.85) contrast(1.45) brightness(1.06)' },
  { id: 'faded', label: 'Faded photocopy', filter: 'contrast(0.78) brightness(1.12) sepia(0.28)' },
];

/** Named colour adjustment presets, keyed by id. */
export function colorPresetById(id) {
  return COLOR_PRESETS.find((p) => p.id === id) || null;
}

/**
 * Apply a numeric colour adjustment to RGBA pixel data in place.
 * Returned as a new Uint8ClampedArray so callers can compare before/after.
 */
export function applyColorAdjust(data, f) {
  if (!f) return data;
  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i], g = data[i + 1], b = data[i + 2];
    if (f.invert) { r = 255 - r; g = 255 - g; b = 255 - b; }
    if (f.grayscale || f.sepia) {
      const lin = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      if (f.sepia) {
        r = 255 * Math.min(1, lin * 1.07);
        g = 255 * Math.min(1, lin * 0.74);
        b = 255 * Math.min(1, lin * 0.43);
      } else {
        const v = lin * 255;
        r = g = b = v;
      }
    }
    if (f.saturate !== 1) {
      const lin = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      r = lin * 255 + (r - lin * 255) * f.saturate;
      g = lin * 255 + (g - lin * 255) * f.saturate;
      b = lin * 255 + (b - lin * 255) * f.saturate;
    }
    r *= f.brightness;
    g *= f.brightness;
    b *= f.brightness;
    r = (r - 128) * f.contrast + 128;
    g = (g - 128) * f.contrast + 128;
    b = (b - 128) * f.contrast + 128;
    out[i] = r;
    out[i + 1] = g;
    out[i + 2] = b;
    out[i + 3] = data[i + 3];
  }
  return out;
}

/** Human-readable byte size. */
export function fmtSize(bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** True when a byte length would make an OP item worth keeping. */
export function meaningfulSize(bytes, min = 16) {
  return typeof bytes === 'number' && bytes >= min;
}

/* ── Page-op model mutators (pure: no DOM, no IPC, no viewer) ───────────── */

/** Every page index, 0-based, for a document model. */
export function pageIndices(doc) {
  return Array.from({ length: doc.numPages || 0 }, (_, i) => i);
}

/**
 * The document's page-op list, created on demand.
 *
 * `doc.pageOps` is null until the first structural operation (insert, delete,
 * crop…) runs, so a tool that wants to rewrite the page list has to be able to
 * materialise it. Same shape pages.js ensureOps() builds: one 'src' item per
 * original page, in order.
 */
export function ensureOps(doc) {
  if (!doc) return null;
  if (!doc.pageOps || !Array.isArray(doc.pageOps.items)) {
    doc.pageOps = { items: pageIndices(doc).map((i) => ({ t: 'src', i })) };
  }
  return doc.pageOps.items;
}

/**
 * Scale every page's content. The op list is rebuilt with one wrapper per
 * page carrying the scale factor; buildPdf re-embeds the source page at the
 * new size, which is the only safe way to change a page's dimensions with
 * pdf-lib.
 *
 * Returns the number of pages that were scaled (0 means nothing to do).
 */
export function scalePages(doc, factor) {
  if (!doc || !doc.numPages) return 0;
  const f = Number(factor);
  if (!Number.isFinite(f) || f <= 0 || Math.abs(f - 1) < 1e-6) return 0;
  const items = ensureOps(doc);
  const out = [];
  let count = 0;
  for (const it of items) {
    if (it.t === 'src') {
      out.push({ t: 'scaled', i: it.i, sx: f, sy: f });
      count++;
    } else if (it.t === 'file') {
      out.push({ t: 'scaled-file', bytes: it.bytes, pages: it.pages, sx: f, sy: f });
      count++;
    } else if (it.t === 'raster') {
      out.push({ t: 'scaled-raster', i: it.i, sx: f, sy: f, rects: it.rects, dpi: it.dpi, filter: it.filter });
      count++;
    } else if (it.t === 'image') {
      out.push({ t: 'scaled-image', dataUrl: it.dataUrl, sx: f, sy: f, w: (it.w || 595.28) * f, h: (it.h || 841.89) * f });
      count++;
    } else if (it.t === 'blank') {
      out.push({ t: 'scaled-blank', sx: f, sy: f, w: (it.w || 595.28) * f, h: (it.h || 841.89) * f });
      count++;
    } else {
      out.push(it);              // already a scaled-* item: leave it alone
    }
  }
  doc.pageOps.items = out;
  return count;
}

/**
 * Drop blank pages from a document.
 *
 * `blank` is an array of booleans/undefined, one per page, where true means
 * the page is blank. Returns { removed, remaining }; the op list is only
 * mutated when something was actually removed, so a no-match call leaves the
 * document untouched.
 */
export function removeBlankPages(doc, blank) {
  if (!doc) return { removed: 0, remaining: 0 };
  const items = ensureOps(doc);
  const kill = new Set();
  (blank || []).forEach((b, i) => { if (b && items[i] && items[i].t === 'src') kill.add(i); });
  if (!kill.size) return { removed: 0, remaining: items.length };
  const kept = items.filter((_, i) => !kill.has(i));
  if (!kept.length) return { removed: 0, remaining: items.length };   // refuse to empty the doc
  doc.pageOps.items = kept;
  return { removed: kill.size, remaining: kept.length };
}

/**
 * Replace pages with rasterised copies of themselves (used by Adjust Colors
 * and Compress). A raster item carries a canvas-drawing job, so the original
 * vector content is replaced by an image — that is how a colour filter can
 * touch every pixel, including scans.
 *
 * `pages` is the list of page indices to rasterise; `filter` is the CSS
 * filter string the canvas will apply. Returns the number replaced.
 */
export function rasterizePages(doc, pages, filter, dpi = 150) {
  if (!doc || !doc.numPages) return 0;
  const want = new Set(pages || []);
  if (!want.size) return 0;
  const items = ensureOps(doc);
  let count = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!want.has(i)) continue;
    if (it.t === 'src') {
      items[i] = { t: 'raster', i: it.i, rects: [], dpi, filter };
      count++;
    } else if (it.t === 'raster') {
      items[i] = { ...it, dpi, filter };
      count++;
    } else if (it.t === 'scaled-raster') {
      items[i] = { ...it, dpi, filter };
      count++;
    }
  }
  return count;
}

/** Strip a raster item's filter, restoring the plain rasterisation path. */
export function clearRasterFilter(doc) {
  if (!doc || !doc.pageOps) return 0;
  let n = 0;
  for (const it of doc.pageOps.items || []) {
    if (it && it.filter) { delete it.filter; n++; }
  }
  return n;
}
