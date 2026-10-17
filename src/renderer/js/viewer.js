import * as pdfjsLib from '/v/pdf.min.mjs';
import {
  state, activeDoc, settings, emit, saveSettings, DEFAULT_SETTINGS,
} from './store.js';
import { $, el, clamp, mulMatrix, invertMatrix, applyTransform } from './util.js';
import { svgIcon } from './icons.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/v/pdf.worker.min.mjs';

export const pdfjs = pdfjsLib;

/* Rendered page records: index -> { wrap, canvas, textLayer, annSvg, formLayer, toolLayer,
   viewport, scale, rendered, renderTask, textContent, dims }                              */
const pageEls = new Map();
let scroller = null;
let pagesRoot = null;
let io = null;
let thumbIO = null;
let baseScale = 1;          // scale that makes the page fit the viewport (fitPage)
let fitWidthScale = 1;

export function initViewer() {
  scroller = $('#canvasWrap');
  pagesRoot = $('#pages');

  // Restore the persisted page-display preferences (Foxit View > Page Display)
  // as classes so the first paint matches the stored settings.
  pagesRoot.classList.toggle('facing', state.view.layout === 'facing');
  pagesRoot.classList.toggle('cover', !!state.view.coverPage);
  pagesRoot.classList.toggle('reverse', !!state.view.reverse);
  document.body.classList.toggle('show-grid', !!settings.grid);

  io = new IntersectionObserver(onIntersect, { root: scroller, rootMargin: '1400px 0px' });

  scroller.addEventListener('scroll', () => {
    emit('scroll');
    updateCurrentPage();
    onRulersScroll();
  }, { passive: true });

  // Ctrl + wheel zooms the document — the same gesture a trackpad pinch emits
  // (Chromium reports pinch as ctrl+wheel). A plain wheel keeps scrolling; only
  // the ctrl chord is hijacked, and preventDefault stops Electron's own
  // whole-page zoom from firing on top of ours. The zoom is anchored at the
  // cursor so the page point under the pointer stays put while the pages scale.
  scroller.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const rect = scroller.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const contentX = scroller.scrollLeft + cx;
    const contentY = scroller.scrollTop + cy;
    const before = currentScale();
    // Normalise line/page deltas to pixels, then clamp so a single inertial
    // fling cannot jump the zoom; exp() makes the step feel proportional.
    const raw = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 100 : e.deltaY;
    const d = clamp(raw, -120, 120);
    zoomBy(Math.exp(-d * 0.0018));
    const after = currentScale();
    if (before > 0 && after > 0) {
      const ratio = after / before;
      scroller.scrollLeft = contentX * ratio - cx;
      scroller.scrollTop = contentY * ratio - cy;
    }
  }, { passive: false });

  window.addEventListener('resize', () => {
    // Rulers are viewport-sized, so a resize repaints even when the scale did
    // not change. One frame, scheduled from the event — never a standing loop.
    scheduleRulers(true);
    if (state.view.zoomMode !== 'custom') requestAnimationFrame(() => { relayout(true); });
  });

  // A window 'resize' event does NOT fire when the scroller's width changes for
  // any other reason — the sidebar opening, the ribbon collapsing, the
  // properties panel growing all shrink #canvasWrap. In fitWidth/fitPage mode
  // that changes the scale, and nothing relaid the pages out, so rec.scale went
  // stale against currentScale(): buildTextLayer() then bailed on its scale
  // guard and never built a text layer at all (no selectable text, and no
  // Direct Editor hit targets). Watch the element itself instead of assuming
  // only the window can resize it. Debounced so a burst of layout changes is
  // one relayout, and guarded by rendered so it cannot loop on its own writes.
  if (typeof ResizeObserver !== 'undefined') {
    let scTimer = null;
    let scW = -1, scH = -1;
    const ro = new ResizeObserver((entries) => {
      const e = entries[entries.length - 1];
      const w = Math.round(e.contentRect.width), h = Math.round(e.contentRect.height);
      if (w === scW && h === scH) return;   // our own layout writes; ignore
      scW = w; scH = h;
      if (state.view.zoomMode === 'custom') return;
      clearTimeout(scTimer);
      scTimer = setTimeout(() => relayout(true), 60);
    });
    ro.observe(scroller);
  }

  initRulers();
}

/* ── Document lifecycle ─────────────────────────────────────────────────── */

export async function loadPdfBytes(bytes, opts = {}) {
  const task = pdfjsLib.getDocument({
    data: bytes.slice(0),
    cMapUrl: '/v/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/v/stdfonts/',
    isEvalSupported: false,
    disableAutoFetch: true,
    // Diagnostics hook: test harnesses can raise this to 5 (INFORMATIVE).
    verbosity: window.__aipdfVerbosity || 0,
    ...(opts.password ? { password: opts.password } : {}),
  });
  try {
    return await task.promise;
  } catch (err) {
    if (err && err.name === 'PasswordException') {
      const code = err.code; // 1 = need password, 2 = wrong password
      const e = new Error(code === 2 ? 'Incorrect password.' : 'This document is password protected.');
      e.needsPassword = code !== 2;
      e.passwordError = code === 2;
      throw e;
    }
    throw err;
  }
}

export function clearPages() {
  io && io.disconnect();
  pageEls.clear();
  pagesRoot.innerHTML = '';
  setRulersReady(false);
}

export async function buildPages(doc) {
  clearPages();
  const d = activeDoc();
  const num = doc.numPages;
  d.pdf = doc;
  d.numPages = num;
  d.pageSizes = new Array(num);

  for (let i = 0; i < num; i++) {
    const page = await doc.getPage(i + 1);
    // Store the page size with its INTRINSIC /Rotate applied (and nothing
    // else). pageDims() swaps the stored size for the user rotation delta +
    // view rotation, and every writer/render path adds intrinsic + deltas
    // itself, so baking the delta in here would double-rotate.
    const vp = page.getViewport({ scale: 1, rotation: page.rotate || 0 });
    d.pageSizes[i] = { w: vp.width, h: vp.height };
  }
  for (let i = 0; i < num; i++) createPageEl(i);
  relayout(true);
  setRulersReady(true);
}

function createPageEl(i) {
  const d = activeDoc();
  const wrap = el('div', { class: 'page', dataset: { i: String(i) } });
  const canvas = el('canvas', { class: 'pdf' });
  const textLayer = el('div', { class: 'textLayer' });
  const annSvgWrap = el('div', { class: 'annLayer' });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  annSvgWrap.appendChild(svg);
  // Starts non-interactive; setTool() in app.js flips it to 'auto' for the
  // select tool so AcroForm widgets can actually be clicked and typed into.
  const formLayer = el('div', { class: 'formLayer', style: { position: 'absolute', inset: '0', pointerEvents: 'none' } });
  const toolLayer = el('div', { class: 'toolLayer', style: { position: 'absolute', inset: '0' } });
  const flash = el('div', { class: 'page-flash' });
  wrap.append(canvas, textLayer, annSvgWrap, formLayer, toolLayer, flash);
  pagesRoot.appendChild(wrap);

  const rec = { i, wrap, canvas, textLayer, svg, formLayer, toolLayer, flash, viewport: null, scale: 0, rendered: false, renderTask: null, textContent: null, textBuilt: false };
  pageEls.set(i, rec);
  io && io.observe(wrap);
  return rec;
}

/* ── Layout & scaling ───────────────────────────────────────────────────── */

/* A4 — the fallback while a document's page sizes are still being measured.
   buildPages() installs a hole-y array and fills it page by page; scroll,
   render and resize ticks can land inside that window, so pageDims() must
   never throw on a missing entry. */
const A4 = { w: 595.28, h: 841.89 };

export function pageDims(i) {
  const d = activeDoc();
  const s = d?.pageSizes?.[i];
  const rot = ((d?.pageRotate?.[i] || 0) + state.view.rotation) % 360;
  const swap = (rot === 90 || rot === 270);
  if (!s) return swap ? { w: A4.h, h: A4.w } : { w: A4.w, h: A4.h };
  return swap ? { w: s.h, h: s.w } : { w: s.w, h: s.h };
}

export function computeFitScales() {
  const d = activeDoc();
  if (!d || !d.numPages || !d.pageSizes || !d.pageSizes[0]) return { fitPage: 1, fitWidth: 1 };
  const pad = 36;
  const availW = Math.max(120, scroller.clientWidth - pad);
  const availH = Math.max(120, scroller.clientHeight - pad);
  const first = pageDims(0);
  let fitWidth = availW / first.w;
  let fitPage = Math.min(availW / first.w, availH / first.h);
  if (state.view.layout === 'facing') {
    const second = pageDims(1) || first;
    fitWidth = availW / (first.w + second.w + 18);
    fitPage = Math.min(fitWidth, availH / Math.max(first.h, second.h));
  }
  return { fitPage, fitWidth };
}

export function currentScale() {
  const { fitPage, fitWidth } = computeFitScales();
  baseScale = fitPage;
  fitWidthScale = fitWidth;
  if (state.view.zoomMode === 'fitPage') return fitPage;
  if (state.view.zoomMode === 'fitWidth') return fitWidth;
  return state.view.zoom;
}

export function setZoom(mode, value) {
  state.view.zoomMode = mode;
  if (mode === 'custom' && value) state.view.zoom = clamp(value, 0.08, 12);
  relayout(true);
  emit('zoom');
}

export function zoomBy(factor) {
  const cur = currentScale();
  setZoom('custom', clamp(cur * factor, 0.08, 12));
}

export function setLayout(mode) {
  state.view.layout = mode;
  pagesRoot.classList.toggle('facing', mode === 'facing');
  relayout(true);
  emit('zoom');
}

/** Foxit View > Page Display > Cover Page: a facing layout whose first page
 *  sits alone on its own row (the flexbox 100%-margin trick — the page keeps
 *  its size, the next one is pushed to a new line). */
export function setCoverPage(on) {
  state.view.coverPage = !!on;
  pagesRoot.classList.toggle('cover', state.view.coverPage);
  relayout(true);
  emit('zoom');
}

/** Foxit View > Reverse View: flip the reading order (right-to-left). */
export function setReverseView(on) {
  state.view.reverse = !!on;
  pagesRoot.classList.toggle('reverse', state.view.reverse);
  relayout(true);
  emit('zoom');
}

/** Foxit View > Show Grid: a subtle alignment grid over every page. */
export function setGridVisible(on) {
  document.body.classList.toggle('show-grid', !!on);
  settings.grid = !!on;
  emit('layout');
}

export function setViewRotation(delta) {
  state.view.rotation = (state.view.rotation + delta + 360) % 360;
  relayout(true);
  emit('zoom');
}

export function relayout(force = false) {
  const d = activeDoc();
  if (!d || !d.numPages) return;
  const scale = currentScale();
  const rec0 = pageEls.get(0);
  if (!force && rec0 && Math.abs(rec0.scale - scale) < 1e-6) return;
  for (let i = 0; i < d.numPages; i++) {
    const rec = pageEls.get(i);
    if (!rec) continue;
    const { w, h } = pageDims(i);
    rec.wrap.style.width = Math.round(w * scale) + 'px';
    rec.wrap.style.height = Math.round(h * scale) + 'px';
    rec.scale = scale;
    rec.viewport = null;
    rec.textBuilt = false;
    rec.textLayer.innerHTML = '';
    if (rec.rendered) { rec.rendered = false; }
  }
  renderVisible();
  scheduleRulers(true);   // tick spacing follows the scale
  emit('layout');
}

/* ── Rendering ──────────────────────────────────────────────────────────── */

function onIntersect(entries) {
  for (const e of entries) {
    const i = Number(e.target.dataset.i);
    // Fire-and-forget: an uncaught rejection here surfaces as an unhandled
    // promise rejection with no context about which page failed.
    if (e.isIntersecting) renderPage(i).catch((err) => console.warn(`[viewer] renderPage(${i}) failed`, err));
    else unrenderPage(i);
  }
}

export function renderVisible() {
  const d = activeDoc();
  if (!d) return;
  const st = scroller.scrollTop, sh = scroller.clientHeight;
  for (let i = 0; i < d.numPages; i++) {
    const rec = pageEls.get(i);
    if (!rec) continue;
    const top = rec.wrap.offsetTop, h = rec.wrap.offsetHeight;
    if (top + h > st - 1200 && top < st + sh + 1200) renderPage(i);
    else unrenderPage(i);
  }
}

export async function renderPage(i) {
  const d = activeDoc();
  const rec = pageEls.get(i);
  if (!d || !rec) return;
  const scale = currentScale();
  if (rec.rendered && Math.abs(rec.scale - scale) < 1e-6) return;

  // Guard against re-entrant calls. renderVisible()/the intersection
  // observer fire renderPage() without awaiting, so two calls for the
  // same page can overlap and call page.render() on the same canvas.
  // If a render is already in flight, mark a re-render request and bail;
  // the in-flight render will re-trigger itself once it settles (so a
  // pending zoom/scale change is still honoured).
  if (rec.rendering) { rec.pendingRender = true; return; }
  rec.rendering = true;
  if (rec.renderTask) { try { rec.renderTask.cancel(); } catch {} rec.renderTask = null; }

  try {
    const page = await d.pdf.getPage(i + 1);
    const rotation = (page.rotate || 0) + (d.pageRotate?.[i] || 0) + state.view.rotation;
    const viewport = page.getViewport({ scale, rotation });
    rec.viewport = viewport;
    rec.scale = scale;

    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const canvas = rec.canvas;
    canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
    canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
    canvas.style.width = Math.floor(viewport.width) + 'px';
    canvas.style.height = Math.floor(viewport.height) + 'px';

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const task = page.render({
      canvasContext: ctx,
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      enableWebGL: false,
      optionalContentConfigPromise: d.ocgConfigPromise || undefined,
    });
    rec.renderTask = task;
    try {
      await task.promise;
    } catch (err) {
      if (err && err.name !== 'RenderingCancelledException') console.warn('render', err);
      return;
    }
    rec.rendered = true;
    await buildTextLayer(i);
    emit('pageRendered', i);
  } finally {
    rec.rendering = false;
    rec.renderTask = null;
    if (rec.pendingRender) { rec.pendingRender = false; renderPage(i); }
  }
}

function unrenderPage(i) {
  const rec = pageEls.get(i);
  if (!rec || !rec.rendered) return;
  if (rec.renderTask) { try { rec.renderTask.cancel(); } catch {} rec.renderTask = null; }
  rec.rendered = false;
  rec.textBuilt = false;
  rec.canvas.width = rec.canvas.height = 0;
  rec.textLayer.innerHTML = '';
  if (rec.svg) rec.svg.innerHTML = '';
}

/* ── Text layer ─────────────────────────────────────────────────────────── */

export async function getTextContent(i) {
  const d = activeDoc();
  if (!d) return null;
  const rec = pageEls.get(i);
  if (rec && rec.textContent) return rec.textContent;
  const page = await d.pdf.getPage(i + 1);
  const tc = await page.getTextContent({ normalizeWhitespace: false, includeMarkedContent: false });
  if (rec) rec.textContent = tc;
  return tc;
}

/** Full text of a page, with line breaks inferred from vertical jumps.
 *  Falls back to the OCR result when a page has no native text layer
 *  (scanned/flattened page that has been recognised). */
export async function getPageText(i) {
  const tc = await getTextContent(i);
  let out = '';
  if (tc) {
    // Pending block edits are the current document text for Ask AI, the agent,
    // exports and page reading. The source operators in the PDF are unchanged
    // until saved (and remain under the visual cover afterwards).
    const d = activeDoc();
    const replacement = new Map();
    const consumed = new Set();
    for (const edit of d?.textEdits || []) {
      if (edit.page !== i || !edit.itemIndices?.length) continue;
      replacement.set(Math.min(...edit.itemIndices), edit);
      for (const index of edit.itemIndices) consumed.add(index);
    }
    let lastY = null;
    for (let index = 0; index < tc.items.length; index++) {
      const it = tc.items[index];
      const edit = replacement.get(index);
      if (consumed.has(index) && !edit) continue;
      if (!it.str && !edit) continue;
      const y = it.transform?.[5] ?? lastY;
      if (lastY != null && Math.abs(y - lastY) > 1.2) out += '\n';
      out += edit ? edit.text : it.str;
      lastY = y;
      if (!edit && it.hasEOL) out += '\n';
    }
    out = out.replace(/[ \t]+/g, ' ').trim();
  }
  if (!out) {
    const d = activeDoc();
    const o = d?.ocr?.[i];
    if (o && o.text) return o.text;
  }
  return out;
}

export async function buildTextLayer(i) {
  const rec = pageEls.get(i);
  if (!rec || rec.textBuilt || !rec.viewport) return;
  const tc = await getTextContent(i);
  if (!tc || !rec.viewport) return;
  if (Math.abs(rec.scale - currentScale()) > 1e-6) {
    // The scale moved while this page was still painting. Re-render so the
    // canvas and the text layer converge; returning here would leave the page
    // with a stale scale and no text layer at all. renderPage's finally block
    // picks up pendingRender, so one retry is enough — and it cannot loop,
    // because a retry only happens when the scale had actually moved.
    if (!rec.rendering) rec.pendingRender = true;
    return;
  }

  const layer = rec.textLayer;
  layer.innerHTML = '';
  const vp = rec.viewport;
  const frag = document.createDocumentFragment();

  tc.items.forEach((item, idx) => {
    if (!item.str) return;
    const style = tc.styles[item.fontName] || {};
    const tx = mulMatrix(vp.transform, item.transform);
    const angle = Math.atan2(tx[1], tx[0]);
    const fontHeight = Math.hypot(tx[2], tx[3]);
    if (!isFinite(fontHeight) || fontHeight <= 0) return;
    const ascent = style.ascent != null ? style.ascent : 0.85;

    const span = document.createElement('span');
    span.textContent = item.str;
    span.dataset.item = String(idx);
    span.style.fontSize = fontHeight + 'px';
    span.style.fontFamily = `${style.fontFamily || 'sans-serif'}, sans-serif`;
    span.style.left = tx[4] + 'px';
    span.style.top = (tx[5] - ascent * fontHeight) + 'px';
    if (Math.abs(angle) > 0.008) span.style.transform = `rotate(${angle}rad)`;
    if (style.vertical) span.style.writingMode = 'vertical-rl';
    frag.appendChild(span);
  });

  layer.appendChild(frag);
  rec.textBuilt = true;
}

/* ── Coordinate helpers ─────────────────────────────────────────────────── */

export function viewportOf(i) {
  const rec = pageEls.get(i);
  if (rec && rec.viewport) return rec.viewport;
  const d = activeDoc();
  if (!d) return null;
  const { w, h } = pageDims(i);
  const s = currentScale();
  // Deterministic fallback viewport (PDF space → CSS px, top-left origin).
  const rot = ((d.pageRotate?.[i] || 0) + state.view.rotation) % 360;
  const unrot = d.pageSizes[i];
  const base = [s, 0, 0, -s, 0, h * s];
  const rotM = rot === 90 ? [0, 1, -1, 0, 0, 0]
    : rot === 180 ? [-1, 0, 0, -1, 0, 0]
      : rot === 270 ? [0, -1, 1, 0, 0, 0]
        : [1, 0, 0, 1, 0, 0];
  // map unrotated PDF box → rotated CSS box
  const m = mulMatrix(rotM, base);
  return { transform: m, width: w * s, height: h * s, scale: s, rotation: rot };
}

/** Page-local CSS pixel point → PDF user-space point. */
export function toPdf(i, x, y) {
  const vp = viewportOf(i);
  const inv = invertMatrix(vp.transform);
  return applyTransform(inv, x, y);
}
/** PDF user-space point → page-local CSS pixel point. */
export function toCss(i, x, y) {
  const vp = viewportOf(i);
  return applyTransform(vp.transform, x, y);
}
export function rectToCss(i, r) {
  const a = toCss(i, r[0], r[1]);
  const b = toCss(i, r[2], r[3]);
  return [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)];
}
export function rectToPdf(i, r) {
  return rectToCssRect(i, r, true);
}
function rectToCssRect(i, r, toPdfSpace) {
  const a = toPdfSpace ? toPdf(i, r[0], r[1]) : toCss(i, r[0], r[1]);
  const b = toPdfSpace ? toPdf(i, r[2], r[3]) : toCss(i, r[2], r[3]);
  return [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)];
}

/** Convert a client (screen) point to page-local CSS pixels. */
export function clientToPage(i, clientX, clientY) {
  const rec = pageEls.get(i);
  if (!rec) return { x: 0, y: 0 };
  const r = rec.wrap.getBoundingClientRect();
  return { x: clientX - r.left, y: clientY - r.top };
}
export function clientToPdf(i, clientX, clientY) {
  const p = clientToPage(i, clientX, clientY);
  return toPdf(i, p.x, p.y);
}

/* ── Navigation ─────────────────────────────────────────────────────────── */

export function scrollToPage(i, opts = {}) {
  const rec = pageEls.get(i);
  if (!rec) return;
  const wrap = rec.wrap;
  if (state.view.layout === 'single') showSinglePage(i);
  const top = wrap.offsetTop - 12;
  scroller.scrollTo({ top: Math.max(0, top), behavior: opts.smooth === false ? 'auto' : 'smooth' });
  setCurrentPage(i);
}

export function scrollToRectOnPage(i, pdfRect, { smooth = true, flash = true } = {}) {
  const c = rectToCss(i, pdfRect);
  const rec = pageEls.get(i);
  if (!rec) return;
  const top = rec.wrap.offsetTop + c[1] - scroller.clientHeight * 0.3;
  scroller.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
  if (flash) flashRect(i, pdfRect);
}

let flashTimer = null;
export function flashRect(i, pdfRect) {
  const rec = pageEls.get(i);
  if (!rec) return;
  const c = rectToCss(i, pdfRect);
  const s = currentScale();
  const box = el('div', {
    style: {
      position: 'absolute',
      left: (c[0] - 3) + 'px', top: (c[1] - 3) + 'px',
      width: Math.max(6, (c[2] - c[0]) + 6) + 'px', height: Math.max(6, (c[3] - c[1]) + 6) + 'px',
      background: 'var(--sel, rgba(164,112,60,.25))', border: '2px solid var(--accent)', borderRadius: '3px',
      pointerEvents: 'none', zIndex: '30', transition: 'opacity .3s',
    },
  });
  rec.wrap.appendChild(box);
  clearTimeout(flashTimer);
  setTimeout(() => { box.style.opacity = '0'; setTimeout(() => box.remove(), 400); }, 1400);
}

export function setCurrentPage(i) {
  const d = activeDoc();
  if (!d) return;
  if (d.currentPage === i) return;
  d.currentPage = i;
  emit('page', i);
}

export function updateCurrentPage() {
  const d = activeDoc();
  if (!d || !d.numPages) return;
  const st = scroller.scrollTop + scroller.clientHeight * 0.35;
  let best = 0, bestDist = Infinity;
  for (let i = 0; i < d.numPages; i++) {
    const rec = pageEls.get(i);
    if (!rec) continue;
    const mid = rec.wrap.offsetTop + rec.wrap.offsetHeight / 2;
    const dist = Math.abs(mid - st);
    if (dist < bestDist) { bestDist = dist; best = i; }
  }
  setCurrentPage(best);
}

export function showSinglePage(i) {
  if (state.view.layout !== 'single') return;
  for (const [idx, rec] of pageEls) rec.wrap.classList.toggle('hidden', idx !== i);
}
export function applyLayoutToDom() {
  const d = activeDoc();
  if (!d) return;
  pagesRoot.classList.toggle('facing', state.view.layout === 'facing');
  if (state.view.layout === 'single') showSinglePage(d.currentPage || 0);
  else for (const [, rec] of pageEls) rec.wrap.classList.remove('hidden');
}

/* ── Page element accessors (used by tool/annotation layers) ────────────── */

export function pageEl(i) { return pageEls.get(i) || null; }
export function pageElMap() { return pageEls; }
export function scrollerEl() { return scroller; }

/* ── Thumbnails ─────────────────────────────────────────────────────────── */

const THUMB_W = 132;
export async function renderThumb(i, canvas) {
  const d = activeDoc();
  if (!d) return;
  const { w, h } = pageDims(i);
  const scale = Math.min(THUMB_W / w, 220 / h);
  const page = await d.pdf.getPage(i + 1);
  const rotation = (page.rotate || 0) + (d.pageRotate?.[i] || 0);
  const vp = page.getViewport({ scale, rotation });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(vp.width * dpr);
  canvas.height = Math.floor(vp.height * dpr);
  canvas.style.width = Math.floor(vp.width) + 'px';
  canvas.style.height = Math.floor(vp.height) + 'px';
  const ctx = canvas.getContext('2d');
  try {
    await page.render({
      canvasContext: ctx, viewport: vp,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      optionalContentConfigPromise: d.ocgConfigPromise || undefined,
    }).promise;
  } catch { /* cancelled or unsupported */ }
}

/** Force every page (and thumbnail) to render again — used when the
 *  optional-content (layer) visibility changes. */
export function rerenderAllPages() {
  for (const [, rec] of pageEls) {
    if (rec.renderTask) { try { rec.renderTask.cancel(); } catch {} rec.renderTask = null; }
    rec.rendered = false;
    rec.textBuilt = false;
    if (rec.canvas) { rec.canvas.width = rec.canvas.height = 0; }
  }
  document.querySelectorAll('.thumb canvas').forEach((cv) => { cv.dataset.done = ''; });
  renderVisible();
}

export const THUMB_WIDTH = THUMB_W;
export function thumbSize(i) {
  const { w, h } = pageDims(i);
  const s = Math.min(THUMB_W / w, 220 / h);
  return { w: Math.round(w * s), h: Math.round(h * s) };
}

/* ── Export helpers used by other modules ───────────────────────────────── */

export async function renderPageToCanvas(i, dpi = 150) {
  const d = activeDoc();
  const dbg = (s) => { try { (window.__aipdfOcrProgress || []).push(s); } catch { /* ignore */ } };
  dbg(`r: getPage(${i})`);
  const page = await d.pdf.getPage(i + 1);
  dbg('r: page proxy ok');
  const rotation = (page.rotate || 0) + (d.pageRotate?.[i] || 0);
  const scale = dpi / 72;
  const vp = page.getViewport({ scale, rotation });
  dbg(`r: viewport ${Math.round(vp.width)}x${Math.round(vp.height)}`);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(vp.width));
  canvas.height = Math.max(1, Math.floor(vp.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  dbg('r: calling render');
  const task = page.render({ canvasContext: ctx, viewport: vp, optionalContentConfigPromise: activeDoc()?.ocgConfigPromise || undefined });
  dbg('r: render dispatched, awaiting');
  await task.promise;
  dbg('r: render complete');
  return canvas;
}

/* ── Rulers ─────────────────────────────────────────────────────────────── */

/* PDF user space is 1/72 inch, so every measurement unit is a fixed divisor of
   points. The unit in play is a user preference (settings.measureUnit) and the
   fallback is the store's own default — nothing here hard-codes a unit. */
const PT_PER_UNIT = { cm: 28.3464567, mm: 2.83464567, in: 72, pt: 1 };
const UNIT_ORDER = Object.keys(PT_PER_UNIT);
// Major-tick steps, in whole units. 1-2-5 families, plus the 1/4 that inches want.
const STEP_LADDER = [0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
const MIN_MAJOR_PX = 34;   // never number two ticks closer than this
const MIN_MINOR_PX = 7;    // never put minor ticks closer than this
const MAX_TICKS = 400;     // pathological-zoom guard: bail rather than grind

const RD = {};             // ruler DOM handles, populated by initRulers()
const RG = { hRect: null, vRect: null, ref: -1 };
const RPt = { x: 0, y: 0, page: null, over: false };
let rulersInitialised = false;
let rulersReady = false;   // a document is on screen
let rulersOn = false;
let rulerFrame = 0;        // id of the single queued frame (0 = none)
let rulerPaint = true;

/** The unit the ruler measures in: the stored preference when it is one we
 *  can convert, otherwise the default the store itself ships with. */
export function currentRulerUnit() {
  const u = settings.measureUnit;
  return PT_PER_UNIT[u] != null ? u : DEFAULT_SETTINGS.measureUnit;
}

function rulerMetrics() {
  const unit = currentRulerUnit();
  const pxPerUnit = PT_PER_UNIT[unit] * currentScale();
  let step = STEP_LADDER[STEP_LADDER.length - 1];
  for (const s of STEP_LADDER) {
    if (s * pxPerUnit >= MIN_MAJOR_PX) { step = s; break; }
  }
  return { unit, pxPerUnit, step, minors: minorCount(step, pxPerUnit, unit) };
}

/** Largest subdivision that still breathes. Binary for inches (halves and
 *  quarters), decimal for the rest (tenths and fifths). */
const MINOR_SETS = { cm: [2, 5, 10], mm: [2, 5, 10], in: [2, 4], pt: [2, 5, 10] };

function minorCount(step, pxPerUnit, unit) {
  const candidates = MINOR_SETS[unit] || MINOR_SETS[DEFAULT_SETTINGS.measureUnit];
  for (let i = candidates.length - 1; i >= 0; i--) {
    if ((step * pxPerUnit) / candidates[i] >= MIN_MINOR_PX) return candidates[i];
  }
  return 2;
}

function rulerTickLabel(n, step) {
  if (n === 0) return '0';
  const d = step >= 1 ? 0 : step >= 0.5 ? 1 : 2;
  return (n * step).toFixed(d);
}

/* Canvas paints cannot reference CSS custom properties, so the token values
 * are read off the ruler layer itself (it inherits the active theme, whether
 * dark mode is set on <html data-theme> or on the legacy <body class="dark">).
 * Cached, and invalidated by the theme MutationObserver below.               */
let rulerTokensCache = null;
function rulerTokens() {
  if (rulerTokensCache) return rulerTokensCache;
  const cs = getComputedStyle(RD.layer);
  const colour = (v) => (/^(#|rgb|hsl|oklch|color)/i.test(v) ? v : 'currentColor');
  const num = (v, fb) => { const n = parseFloat(v); return Number.isFinite(n) ? n : fb; };
  rulerTokensCache = {
    text: colour(cs.getPropertyValue('--text-3').trim()),
    tick: colour(cs.getPropertyValue('--border-strong').trim()),
    edge: colour(cs.getPropertyValue('--border').trim()),
    accent: colour(cs.getPropertyValue('--accent').trim()),
    fontSize: num(cs.getPropertyValue('--text-xs'), 11),
    fontFamily: cs.getPropertyValue('--font-sans').trim() || 'sans-serif',
  };
  return rulerTokensCache;
}

/** Which page the rulers measure from: the page under the pointer when there
 *  is one, else the first page still visible in the viewport. pageDims() has
 *  already swapped w/h for rotated pages, so the wrap we read here is the box
 *  the ruler has to line up with.                                            */
function rulerRefPage() {
  if (RPt.over && RPt.page != null && pageEls.has(RPt.page)) return RPt.page;
  const top = scroller ? scroller.scrollTop : 0;
  for (const [i, rec] of pageEls) {
    if (rec.wrap.classList.contains('hidden')) continue;
    if (rec.wrap.offsetTop + rec.wrap.offsetHeight > top) return i;
  }
  return 0;
}

function rulerTick(ctx, horiz, p, thick, len) {
  if (len <= 0) return;
  const base = thick - 0.5;         // the page-side edge ticks hang off
  if (horiz) { ctx.moveTo(p, base); ctx.lineTo(p, base - len); }
  else { ctx.moveTo(base, p); ctx.lineTo(base - len, p); }
}

/** Draw one ruler strip. `zero` is the page's origin expressed in this strip's
 *  own CSS pixels and `r` is the strip's rect, so the corner-chip offset, the
 *  centring of the page and the scroll position are all accounted for by the
 *  rects they were measured from.                                            */
function paintRuler(canvas, horiz, zero, r, m, tk) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const bw = Math.max(1, Math.round(r.width));
  const bh = Math.max(1, Math.round(r.height));
  canvas.width = Math.round(bw * dpr);
  canvas.height = Math.round(bh * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, bw, bh);

  const span = horiz ? bw : bh;     // axis the measurement runs along
  const thick = horiz ? bh : bw;    // cross axis = strip thickness
  const gap = m.step * m.pxPerUnit;
  if (!(gap > 0.5) || !isFinite(gap)) return;
  const last = Math.floor((span - zero) / gap);
  if (last > MAX_TICKS) return;

  const major = thick - 14;
  const minor = thick - 20;
  ctx.lineWidth = 1;
  ctx.strokeStyle = tk.tick;
  ctx.beginPath();
  for (let n = 0; n <= last; n++) {
    const p = Math.round(zero + n * gap) + 0.5;
    if (p >= 0 && p <= span) rulerTick(ctx, horiz, p, thick, major);
    for (let k = 1; k < m.minors; k++) {
      const q = Math.round(zero + n * gap + (gap * k) / m.minors) + 0.5;
      if (q >= 0 && q <= span) rulerTick(ctx, horiz, q, thick, minor);
    }
  }
  ctx.stroke();

  ctx.beginPath();
  ctx.strokeStyle = tk.edge;
  if (horiz) { ctx.moveTo(0.5, thick - 0.5); ctx.lineTo(span - 0.5, thick - 0.5); }
  else { ctx.moveTo(thick - 0.5, 0.5); ctx.lineTo(thick - 0.5, span - 0.5); }
  ctx.stroke();

  const z = Math.round(zero) + 0.5;
  if (z >= 0 && z <= span) {
    ctx.beginPath();
    ctx.strokeStyle = tk.accent;
    rulerTick(ctx, horiz, z, thick, major + 3);
    ctx.stroke();
  }

  ctx.fillStyle = tk.text;
  ctx.font = `${tk.fontSize}px ${tk.fontFamily}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lane = thick - major - 6;   // the clear band above the ticks
  for (let n = 0; n <= last; n++) {
    const p = zero + n * gap;
    if (p < 8 || p > span - 8) continue;
    const text = rulerTickLabel(n, m.step);
    if (horiz) { ctx.fillText(text, p, lane); continue; }
    ctx.save();
    ctx.translate(lane, p);
    ctx.rotate(-Math.PI / 2);        // vertical numbers read bottom-to-top
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }
}

/** Pin the layer to the scrollport. Because the box is exactly the client
 *  rect translated by (scrollLeft, scrollTop), its far edges land on
 *  scrollWidth/scrollHeight at most — it can never grow the scroll range. */
function pinRulers() {
  if (!RD.layer || !scroller) return;
  const x = scroller.scrollLeft;
  const y = scroller.scrollTop;
  if (pinRulers.x === x && pinRulers.y === y) return;
  pinRulers.x = x; pinRulers.y = y;
  RD.layer.style.transform = `translate(${x}px, ${y}px)`;
}
pinRulers.x = -1; pinRulers.y = -1;

function positionRulerMarks() {
  if (!RD.layer) return;
  const show = rulersOn && rulersReady && RPt.over && RG.hRect && RG.vRect;
  RD.layer.classList.toggle('marked', !!show);
  if (!show) return;
  RD.mh.style.transform = `translateX(${clamp(RPt.x - RG.hRect.left, 0, RG.hRect.width)}px)`;
  RD.mv.style.transform = `translateY(${clamp(RPt.y - RG.vRect.top, 0, RG.vRect.height)}px)`;
}

function syncRulerUnitChip() {
  const u = currentRulerUnit();
  if (RD.unit && RD.unit.textContent !== u) RD.unit.textContent = u;
  if (RD.toggle) {
    RD.toggle.setAttribute('aria-pressed', String(rulersOn));
    RD.toggle.classList.toggle('active', rulersOn);
    const tip = rulersOn ? 'Hide rulers' : 'Show rulers';
    if (RD.toggle.getAttribute('data-tip') !== tip) RD.toggle.setAttribute('data-tip', tip);
  }
}

function refreshRulers() {
  pinRulers();
  syncRulerUnitChip();
  if (!rulersOn || !rulersReady || !activeDoc()) { positionRulerMarks(); return; }
  const ref = rulerRefPage();
  const rec = pageEls.get(ref);
  if (!rec) return;
  RG.ref = ref;
  const m = rulerMetrics();
  const pr = rec.wrap.getBoundingClientRect();
  const hr = RD.hc.getBoundingClientRect();
  const vr = RD.vc.getBoundingClientRect();
  RG.hRect = hr; RG.vRect = vr;
  const tk = rulerTokens();
  paintRuler(RD.hc, true, pr.left - hr.left, hr, m, tk);
  paintRuler(RD.vc, false, pr.top - vr.top, vr, m, tk);
  positionRulerMarks();
}

/* One queued frame, scheduled only by scroll / resize / cursor / layout
 * events. Paints coalesce: a scroll burst redraws once, per frame.           */
function scheduleRulers(paint) {
  if (!RD.layer || !rulersReady) return;
  if (paint) rulerPaint = true;
  if (rulerFrame) return;
  rulerFrame = requestAnimationFrame(() => {
    rulerFrame = 0;
    const mustPaint = rulerPaint;
    rulerPaint = false;
    if (mustPaint) { refreshRulers(); return; }
    // A pointer moving onto another page re-bases both rulers, so it needs a
    // repaint too — otherwise the ticks would still measure the old page.
    if (rulersOn && rulersReady && rulerRefPage() !== RG.ref) refreshRulers();
    else positionRulerMarks();
  });
}

/** Scroll hook: pinning is a single style write, so it stays synchronous and
 *  costs nothing while the rulers are switched off. */
function onRulersScroll() {
  if (!RD.layer) return;
  if (rulersOn && rulersReady) scheduleRulers(true);
  else pinRulers();
}

export function initRulers() {
  if (rulersInitialised) return;
  const layer = $('#rulers');
  if (!layer || !scroller) return;           // markup absent: feature stays dark
  rulersInitialised = true;
  RD.layer = layer;
  RD.hc = $('#rulerHCanvas');
  RD.vc = $('#rulerVCanvas');
  RD.mh = $('#rulerMarkH');
  RD.mv = $('#rulerMarkV');
  RD.toggle = $('#rulerToggle');
  RD.unit = $('#rulerUnit');

  if (RD.toggle) {
    RD.toggle.innerHTML = svgIcon('measure', 13, 1.8);
    RD.toggle.onclick = () => toggleRulers();
  }
  if (RD.unit) {
    RD.unit.onclick = () => {
      const i = UNIT_ORDER.indexOf(currentRulerUnit());
      setRulerUnit(UNIT_ORDER[(i + 1) % UNIT_ORDER.length]);
    };
  }
  syncRulerUnitChip();

  scroller.addEventListener('pointermove', (e) => {
    if (!rulersOn) return;
    const host = e.target && e.target.closest ? e.target.closest('.page') : null;
    RPt.x = e.clientX; RPt.y = e.clientY;
    RPt.page = host ? Number(host.dataset.i) : null;
    RPt.over = true;
    scheduleRulers(false);
  }, { passive: true });
  scroller.addEventListener('pointerleave', () => {
    if (!rulersOn) return;
    RPt.over = false;
    scheduleRulers(false);
  });

  // app.js owns theme switching; watch the attributes instead of editing it.
  new MutationObserver(() => {
    rulerTokensCache = null;
    scheduleRulers(true);
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
  new MutationObserver(() => {
    rulerTokensCache = null;
    scheduleRulers(true);
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
}

function setRulersReady(on) {
  rulersReady = !!on;
  if (!RD.layer) return;
  RD.layer.classList.toggle('ready', rulersReady);
  if (!rulersReady) RD.layer.classList.remove('marked');
  pinRulers();
  scheduleRulers(true);
}

/** Turn the rulers on or off. Safe to call from a menu action in app.js.
 *  @param {boolean} on  @returns {boolean} the resulting visibility */
export function setRulersVisible(on) {
  rulersOn = !!on;
  if (RD.layer) {
    RD.layer.classList.toggle('on', rulersOn);
    if (!rulersOn) RD.layer.classList.remove('marked');
  }
  syncRulerUnitChip();
  scheduleRulers(true);
  return rulersOn;
}

/** @returns {boolean} the new visibility state. */
export function toggleRulers() { return setRulersVisible(!rulersOn); }

/** @returns {boolean} whether the rulers are currently shown. */
export function rulersVisible() { return rulersOn; }

/** Set the measurement unit and persist it. @returns {string} the unit in use. */
export function setRulerUnit(unit) {
  if (PT_PER_UNIT[unit] == null) return currentRulerUnit();
  settings.measureUnit = unit;
  saveSettings();
  syncRulerUnitChip();
  scheduleRulers(true);
  return currentRulerUnit();
}
