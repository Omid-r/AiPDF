import {
  state, activeDoc, settings, addAnnot, removeAnnots, updateAnnot, pushHistory, emit,
} from './store.js';
import {
  pageEl, clientToPdf, toPdf, toCss, currentScale,
} from './viewer.js';
import { makeAnnot, svgEl, normalizeRect, sweptQuads, renderPageAnnotations as renderAnnots } from './annots.js';
import { translateTextEdit, textEditDrawBox } from './textblocks.js';
import { MOVES_TOP, MOVES_BOTTOM, MOVES_LEFT, MOVES_RIGHT } from './geometry.js';
import { clamp, rgbToCss, rgbToHex, hexToRgb, toast, el } from './util.js';
import { openInlineTextbox } from './textedit.js';
import { pickStamp, pickSignature, pickImage } from './stamps.js';
import { showModal, formRow } from './dialog.js';

const DRAW_TOOLS = new Set([
  'rect', 'ellipse', 'line', 'arrow', 'ink', 'brush', 'highlighter', 'measure',
  'redact', 'whiteout', 'textbox', 'callout', 'roundRect', 'link',
]);
const CLICK_TOOLS = new Set(['note', 'stamp', 'signature', 'image', 'caret']);
const MARKUP_TOOLS = new Set(['highlight', 'underline', 'strikeout', 'squiggly']);
/** Freehand captures: they store a point list rather than two corners. */
const STROKE_TOOLS = new Set(['ink', 'brush', 'highlighter']);
/** Foxit's multi-vertex tools: click to add a vertex, double-click/Enter to
 *  finish. They store an explicit point list like strokes, but as vertices. */
const VERTEX_TOOLS = new Set(['polygon', 'polyline', 'cloud', 'areaHighlight']);

/** Every tool that puts an object on the page, plus the two pick-up tools.
 *
 *  The creating tools are here on purpose. They used to be a one-way door: a
 *  click with Text box / Rectangle / … always laid down a NEW object, so the
 *  one you had just drawn could never be picked up again to recolour it,
 *  retype it or move it — you had to hunt for the Select tool first, and even
 *  then switching tools dropped the selection. Now a click on existing
 *  geometry selects it and a click on bare page draws, which is what Acrobat
 *  and Foxit both do.
 */
const OBJECT_TOOLS = new Set([
  ...DRAW_TOOLS, ...CLICK_TOOLS, ...VERTEX_TOOLS, 'select', 'editText',
]);

/* A vertex path in progress: { page, pts: [[x,y], …] } for the current
   polygon/polyline/cloud/area-highlight or multi-segment measure. */
let polyPath = null;

/* Appearance a format painter picked up; null until the first click copies it. */
let copiedFormat = null;

let drag = null;
let quickBar = null;
/* Hand-tool pan: { x, y, left, top } while dragging the document scroller. */
let panDrag = null;

export function initTools() {
  const root = document.getElementById('pages');
  root.addEventListener('pointerdown', onPointerDown);
  root.addEventListener('dblclick', () => { if (polyPath) finishPolyPath(); });
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  document.addEventListener('selectionchange', onSelectionChange);
  // Enter closes a vertex path, Escape abandons it. Captured so the global
  // shortcut layer never sees the keystroke while a path is in progress.
  window.addEventListener('keydown', (e) => {
    if (!polyPath) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); finishPolyPath(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelPolyPath(); }
  }, true);
}

/* ── Routing ────────────────────────────────────────────────────────────── */

/**
 * Store a freshly drawn object, remember the gesture for undo, and leave it
 * SELECTED.
 *
 * `addAnnot()` already writes the new id into `state.selection`, but nothing
 * announced it, so the properties panel went on describing the *tool* while the
 * object the user had just drawn — the thing they wanted to recolour or retype —
 * had no panel at all. `emit('selection')` is what makes the ribbon colour
 * chips, the font controls and the properties panel land on it immediately.
 */
function commitNew(a, i, label) {
  addAnnot(a);
  pushHistory(label);
  renderAnnots(i);
  emit('annots');
  emit('selection');
}

function pageIndexOf(target) {
  const p = target.closest ? target.closest('.page') : null;
  if (!p) return null;
  return Number(p.dataset.i);
}

/**
 * The element that actually scrolls.
 *
 * #canvasWrap owns it — app.css gives it `overflow: auto` and viewer.js records
 * it as the viewer scroller. #pagesScroll has no overflow rule and simply grows
 * to fit its content, so writing scrollTop to it is a silent no-op. Two
 * hand-written references to the wrong id are exactly why the Hand tool's pan
 * never worked, so the lookup lives here once.
 */
function docScroller() {
  return document.getElementById('canvasWrap');
}

function onPointerDown(e) {
  if (e.button !== 0) return;
  // The Hand tool pans the document from anywhere in the scroller — pages,
  // page gaps or the background — before the per-page routing runs.
  // `state.spacePan` is set while the user holds Space, so the Hand's pan is
  // reachable from EVERY tool (Acrobat/Foxit keep Select + Hand always live):
  // you can grab-scroll the page without leaving the tool you were drawing with.
  if (state.tool === 'hand' || state.spacePan) {
    const sc = docScroller();
    if (!sc) return;
    panDrag = { x: e.clientX, y: e.clientY, left: sc.scrollLeft, top: sc.scrollTop };
    document.body.classList.add('panning');
    state.spacePanned = true;   // a drag happened during this Space hold
    e.preventDefault();
    return;
  }
  const i = pageIndexOf(e.target);
  if (i == null) return;
  const doc = activeDoc();
  if (!doc) return;

  const onHandle = e.target.classList && e.target.classList.contains('handle');
  const onAnn = !!e.target.closest('.ann');
  const onBlock = !!e.target.closest('.textedit');
  // A vertex path in progress owns the click: each one drops another vertex,
  // so picking an object up mid-path would silently abandon the shape.
  const pathBusy = !!polyPath && VERTEX_TOOLS.has(state.tool);

  if (OBJECT_TOOLS.has(state.tool) && (onAnn || onBlock || state.tool === 'select') && !pathBusy) {
    // Committed Direct Editor blocks move freely: the cover wash stays over
    // the original text while the replacement travels. Handled before
    // annotations — the block preview is not an .ann, so the lookup below
    // would miss it and a drag would fall through to the tool layer.
    const teNode = e.target.closest ? e.target.closest('.textedit') : null;
    if (teNode && teNode.dataset.eid) {
      const ed = doc.textEdits.find((x) => x.id === teNode.dataset.eid);
      // A threaded story spans an ordered frame chain, so a frame on ANY of its
      // pages must be able to re-open the story's panel — not only the first.
      const threaded = !!(ed && Array.isArray(ed.frames) && ed.frames.length > 1);
      const onThisPage = !!ed && (ed.page === i || (threaded && ed.frames.some((f) => f.page === i)));
      if (ed && onThisPage) {
        if (e.shiftKey && !state.selection.includes(ed.id)) state.selection = [...state.selection, ed.id];
        else if (!e.shiftKey) state.selection = [ed.id];
        renderAnnots(i);
        emit('selection');
        // Dragging one frame's outline would silently desynchronise the chain
        // (the other frames would keep the old geometry), so a threaded story is
        // selected for the panel without starting a move. Its geometry is edited
        // through Link / Unlink frames instead.
        if (threaded) { e.preventDefault(); return; }
        drag = {
          mode: 'moveText', i, eid: ed.id,
          last: clientToPdf(i, e.clientX, e.clientY),
          from: textEditDrawBox(ed),
          moved: false,
        };
        e.preventDefault();
        return;
      }
    }
    if (onAnn) {
      const id = e.target.closest('.ann').dataset.id;
      selectAnnot(id, e.shiftKey);
      if (!onHandle) {
        const a = doc.annots.find((x) => x.id === id);
        if (a) {
          drag = { mode: onHandle ? 'resize' : 'move', i, id, start: clientToPdf(i, e.clientX, e.clientY), orig: JSON.parse(JSON.stringify(a)), handle: Number(e.target.dataset.h || 0) };
        }
      } else {
        drag = { mode: 'resize', i, id, start: clientToPdf(i, e.clientX, e.clientY), orig: JSON.parse(JSON.stringify(doc.annots.find((x) => x.id === id))), handle: Number(e.target.dataset.h || 0) };
      }
      e.preventDefault();
      return;
    }
    if (state.tool === 'select') {
      state.selection = [];
      renderAnnots(i);
      emit('selection');
    }
  }

  if (state.tool === 'eraser') {
    eraseAt(i, e.clientX, e.clientY);
    drag = { mode: 'erase', i };
    return;
  }

  if (state.tool === 'formatPainter') {
    formatPainterAt(i, e);
    return;
  }

  if (state.tool === 'eyedropper') {
    eyedropperAt(i, e.clientX, e.clientY);
    return;
  }

  if (MARKUP_TOOLS.has(state.tool)) return;   // browser text selection handles it
  if (state.tool === 'editText') return;

  // A draw starts on BARE page surface. This used to be `e.target === toolLayer`,
  // but the tool layer sits on top of the annotation layer and was switched to
  // `pointer-events:auto` for every drawing tool, so it swallowed the click
  // before any object could be seen — which is why a text box or a shape could
  // be created but never selected, moved or recoloured again. The tool layer is
  // now always inert (app.js setTool) and the real geometry is the hit target,
  // so "not on an object and still somewhere on the page" is what starts a draw.
  const onWidget = !!e.target.closest?.('.formLayer');
  const onLayer = !onAnn && !onHandle && !onBlock && !onWidget && !!e.target.closest?.('.page');
  if (!onLayer) return;

  const start = clientToPdf(i, e.clientX, e.clientY);

  // Foxit's polygon/polyline/cloud/area-highlight family: each click drops a
  // vertex, double-click or Enter closes the shape. Kept separate from the
  // press-drag-release draw tools because there is no drag rectangle at all.
  if (VERTEX_TOOLS.has(state.tool)) {
    if (polyPath && polyPath.page === i) {
      // A second click near the first point closes the polygon.
      const first = polyPath.pts[0];
      if (state.tool === 'polygon' || state.tool === 'cloud' || state.tool === 'areaHighlight') {
        if (Math.hypot(clientToPdf(i, e.clientX, e.clientY).x - first[0], clientToPdf(i, e.clientX, e.clientY).y - first[1]) * currentScale() < 10) {
          finishPolyPath();
          e.preventDefault();
          return;
        }
      }
      polyPath.pts.push([start.x, start.y]);
    } else {
      polyPath = { page: i, pts: [[start.x, start.y]] };
    }
    drawPolyPreview(i);
    e.preventDefault();
    return;
  }

  if (CLICK_TOOLS.has(state.tool)) {
    placeClickTool(i, start, e.clientX, e.clientY);
    return;
  }
  if (DRAW_TOOLS.has(state.tool)) {
    drag = { mode: 'draw', i, start, cur: start, points: [[start.x, start.y]], times: [performance.now()] };
    // Capture on the page, not the tool layer: the layer is pointer-inert now,
    // so a capture on it would be dropped and a fast drag that leaves the page
    // would stop mid-stroke.
    const surface = e.target.closest?.('.page');
    try { surface?.setPointerCapture?.(e.pointerId); } catch { /* not capturable */ }
    e.preventDefault();
  }
}

function onPointerMove(e) {
  if (panDrag) {
    const sc = docScroller();
    if (sc) {
      sc.scrollLeft = panDrag.left - (e.clientX - panDrag.x);
      sc.scrollTop = panDrag.top - (e.clientY - panDrag.y);
    }
    return;
  }
  if (polyPath) {
    // Rubber-band the in-progress path to the cursor, but only when the pointer
    // is actually over the page being drawn on.
    const pg = e.target && e.target.closest ? e.target.closest('.page') : null;
    if (pg && Number(pg.dataset.i) === polyPath.page) {
      const p = clientToPdf(polyPath.page, e.clientX, e.clientY);
      drawPolyPreview(polyPath.page, toCss(polyPath.page, p.x, p.y));
    }
    return;
  }
  if (!drag) return;
  const i = drag.i;
  const p = clientToPdf(i, e.clientX, e.clientY);

  if (drag.mode === 'draw') {
    drag.cur = p;
    if (STROKE_TOOLS.has(state.tool)) {
      // Distance is measured on screen so a fast flick tapers the same way at
      // every zoom level; the stored points stay in PDF space.
      const last = drag.points[drag.points.length - 1];
      const px = Math.hypot(p.x - last[0], p.y - last[1]) * currentScale();
      // Ink keeps its original every-move sampling; the two markers drop
      // sub-pixel jitter so the taper is not driven by noise.
      if (state.tool === 'ink' || px > 0.8) {
        drag.points.push([p.x, p.y]);
        drag.times.push(performance.now());
      }
    }
    drawPreview(i);
  } else if (drag.mode === 'move') {
    const a = activeDoc().annots.find((x) => x.id === drag.id);
    if (!a) return;
    const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
    if (dx || dy) drag.moved = true;
    const o = drag.orig;
    const mapped = { ...o };
    mapped.rect = [o.rect[0] + dx, o.rect[1] + dy, o.rect[2] + dx, o.rect[3] + dy];
    if (o.points) mapped.points = o.points.map((v, k) => v + (k % 2 === 0 ? dx : dy));
    if (o.paths) mapped.paths = o.paths.map((pp) => pp.map((v, k) => v + (k % 2 === 0 ? dx : dy)));
    if (o.quads) mapped.quads = o.quads.map((q) => q.map((v, k) => v + (k % 2 === 0 ? dx : dy)));
    if (o.leader) mapped.leader = [o.leader[0] + dx, o.leader[1] + dy];
    updateAnnot(a.id, mapped);
    renderAnnots(i);
    emit('selection');
  } else if (drag.mode === 'moveText') {
    const ed = activeDoc().textEdits.find((x) => x.id === drag.eid);
    if (!ed) return;
    // Incremental deltas through the shared helper: the text box travels
    // while the cover rect stays over the original text.
    const dx = p.x - drag.last.x, dy = p.y - drag.last.y;
    if (dx || dy) drag.moved = true;
    translateTextEdit(ed, dx, dy);
    drag.last = p;
    renderAnnots(i);
    emit('selection');
  } else if (drag.mode === 'resize') {
    const a = activeDoc().annots.find((x) => x.id === drag.id);
    if (!a) return;
    // `to` is absolute — recomputed from the rect captured at pointer-down, so a
    // long drag cannot accumulate error. `from` must therefore be where the
    // annotation actually is NOW, not that original rect; passing the original
    // here re-mapped quads, paths and points on every pointer move and made the
    // geometry balloon outwards. app.js:1931 already gets this right.
    //
    // KNOWN LIMITATION (documented by the 5 handle checks in
    // scripts/text-tool-test.mjs): resizeRect maps the handle to fixed rect
    // indices, which assumes screen axes == PDF axes. On pages with /Rotate or
    // a manual view rotation the two disagree and edge drags freeze. A
    // screen-space rewrite was tried and inverted on the rotated fixture — it
    // needs a proper rotation-mapping pass of its own.
    const to = resizeRect(drag.handle, drag.orig.rect, p);
    if (to.some((v, k) => Math.abs(v - drag.orig.rect[k]) > 1e-6)) drag.moved = true;
    transformAnnot(a, a.rect.slice(), to);
    renderAnnots(i);
    emit('selection');
  } else if (drag.mode === 'erase') {
    eraseAt(i, e.clientX, e.clientY);
  }
}

function onPointerUp(e) {
  if (panDrag) {
    panDrag = null;
    document.body.classList.remove('panning');
    return;
  }
  if (!drag) return;
  const d = drag;
  drag = null;
  clearPreview(d.i);

  if (d.mode === 'draw') {
    const end = clientToPdf(d.i, e.clientX, e.clientY);
    void finishDraw(d, end);
  } else if (d.mode === 'move' || d.mode === 'resize' || d.mode === 'moveText') {
    if (d.mode === 'moveText') {
      // Remember where this save-position was, so the writer can wash it on
      // the next save — otherwise move → save → move → save leaves the older
      // copy visible in the file. Capped: ancient positions are the user's to
      // white out. A click without a drag selects only (no history entry).
      const ed = activeDoc()?.textEdits.find((x) => x.id === d.eid);
      if (ed && d.moved) {
        if (d.from) ed.priorBoxes = [...(ed.priorBoxes || []), d.from].slice(-8);
        pushHistory('move text block');
      }
    } else if (d.moved) {
      // Selecting with a drawing tool armed now enters this path too, so a
      // plain click must not push an undo step — otherwise every pick-up
      // adds a no-op "transform annotation" to the history.
      pushHistory('transform annotation');
    }
    emit('selection');
  }
}

/* ── Shape finishing ────────────────────────────────────────────────────── */

/** Finish a press-drag-release draw. Async because the link tool opens a dialog
 *  to pick its destination before the annotation is created. */
async function finishDraw(d, end) {
  const i = d.i;
  const s = currentScale();
  let rect = normalizeRect([d.start.x, d.start.y, end.x, end.y]);
  const minSizePdf = 6 / s;
  const tool = state.tool;

  if (STROKE_TOOLS.has(tool)) {
    if (d.points.length < 2) return;
    const xs = d.points.map((p) => p[0]), ys = d.points.map((p) => p[1]);
    const width = tool === 'brush' ? (settings.brushSize || 6)
      : tool === 'highlighter' ? (settings.highlighterSize || 16)
        : (settings.borderWidth || 2);
    // Only the brush is velocity-tapered; the pencil and the marker stay flat.
    const widths = tool === 'brush' ? velocityWidths(d.points, d.times, width, s) : null;
    const pad = (widths ? Math.max(...widths) : width) / 2 + 3 / s;
    rect = [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
    const flat = d.points.flat();
    const extra = { paths: [flat], borderWidth: width };
    if (widths) { extra.widths = widths; extra.hardness = clamp(settings.brushHardness ?? 0.85, 0, 1); }
    if (tool === 'highlighter') extra.quads = sweptQuads(flat, width);
    const a = makeAnnot(tool, i, rect, extra);
    commitNew(a, i, tool);
    return;
  }

  if (tool === 'line' || tool === 'arrow' || tool === 'measure') {
    const len = Math.hypot(end.x - d.start.x, end.y - d.start.y);
    if (len < 2 / s) return;
    const pad = 2 / s;
    rect = normalizeRect([d.start.x - pad, d.start.y - pad, end.x + pad, end.y + pad]);
    const a = makeAnnot(tool, i, rect, { points: [d.start.x, d.start.y, end.x, end.y], borderWidth: settings.borderWidth || 1.5 });
    if (tool === 'measure') {
      const scaleInfo = activeDoc().measureScale;
      const px = Math.hypot(end.x - d.start.x, end.y - d.start.y);
      a.label = formatMeasure(px, scaleInfo);
    }
    commitNew(a, i, tool);
    return;
  }

  if (rect[2] - rect[0] < minSizePdf || rect[3] - rect[1] < minSizePdf) {
    // treat as a click: give shape tools a sensible default box
    const w = 120 / s, h = 60 / s;
    rect = [d.start.x, d.start.y - h, d.start.x + w, d.start.y];
  }

  if (tool === 'textbox' || tool === 'callout') {
    const a = makeAnnot(tool, i, rect, {
      // The Typewriter settings, which is what the properties panel edits for
      // this tool. These used to read `settings.fontSize` and a `newTextFont`
      // key that does not exist anywhere, so every box silently came out as
      // 11pt Helvetica no matter what the user had picked.
      fontSize: settings.textSize || 11,
      // A font registered from the Fonts panel (embedded reuse or user TTF)
      // is honoured here and embedded on save via pdfwrite.baseFont().
      fontFamily: settings.textFont || 'Helvetica',
      borderWidth: 0.8,
      text: '',
      leader: tool === 'callout' ? [d.start.x, d.start.y] : null,
    });
    commitNew(a, i, tool);
    openInlineTextbox(a.id);
    return;
  }

  if (tool === 'link') {
    if (rect[2] - rect[0] < minSizePdf || rect[3] - rect[1] < minSizePdf) return;
    const target = await linkTargetDialog(doc_numPages());
    if (!target) return;
    const a = makeAnnot('link', i, rect, { borderWidth: 0, ...target });
    commitNew(a, i, 'link');
    toast('Link added — it is written into the file on save', 'ok');
    return;
  }

  const a = makeAnnot(tool, i, rect, {
    borderWidth: tool === 'whiteout' ? 0 : (settings.borderWidth || 1.5),
    fill: defaultFillFor(tool),
    corner: tool === 'roundRect' ? Math.min(rect[2] - rect[0], rect[3] - rect[1]) * 0.16 : undefined,
  });
  commitNew(a, i, tool);
}

/** Which tools start life with a fill. A callout always does, so its text stays
 *  readable over the page; shapes follow the user's Fill setting. Picking None in
 *  the properties panel then makes the fill genuinely transparent — neither the
 *  preview nor the writer fakes a background any more. */
function defaultFillFor(tool) {
  const shape = tool === 'rect' || tool === 'ellipse' || tool === 'roundRect';
  if (tool !== 'callout' && !(shape && settings.fillEnabled)) return null;
  return hexToRgb(settings.fillColor || '#ffffff');
}

/** Fill colour for the live drag preview, from the same rule the created
 *  annotation uses — otherwise a callout previews unfilled and then appears
 *  with a white card the moment the mouse is released. */
function previewFillCss() {
  const f = defaultFillFor(state.tool);
  return f ? rgbToCss(f) : 'none';
}

function doc_numPages() {
  return activeDoc() ? activeDoc().numPages : 1;
}

/** Foxit's "Add web link / Go to a page view" dialog for a freshly dragged
 *  rectangle. Returns the destination to store on the annotation. */
async function linkTargetDialog(numPages) {
  let kind = 'uri';
  let uri = 'https://';
  let page = 1;
  const ok = await showModal({
    title: 'Add link',
    width: 'narrow',
    body: (b) => {
      const sel = el('select', {});
      sel.append(
        el('option', { value: 'uri', text: 'Web link (open a web page)' }),
        el('option', { value: 'goto', text: 'Go to a page view' }),
      );
      const uriIn = el('input', { type: 'text', value: uri, placeholder: 'https://example.com' });
      const pageIn = el('input', { type: 'number', min: '1', max: String(numPages), value: '1', style: { width: '70px', display: 'none' } });
      sel.onchange = () => { kind = sel.value; uriIn.style.display = kind === 'uri' ? '' : 'none'; pageIn.style.display = kind === 'goto' ? '' : 'none'; };
      uriIn.oninput = () => { uri = uriIn.value; };
      pageIn.oninput = () => { page = Number(pageIn.value) || 1; };
      b.append(formRow('Action', el('div', { class: 'flex' }, [sel])).row);
      b.append(formRow('Web address', uriIn).row);
      b.append(formRow('Page', pageIn).row);
      b.append(el('div', { class: 'hint', text: 'The link is saved into the PDF and opens in any reader.' }));
      setTimeout(() => uriIn.focus(), 20);
    },
    buttons: [
      { label: 'Cancel', value: false, kind: 'ghost' },
      { label: 'Add link', value: true, kind: 'primary', default: true },
    ],
  });
  if (!ok) return null;
  if (kind === 'goto') return { dest: 'goto', destPage: clamp(Math.round(page) || 1, 1, numPages) - 1 };
  const u = String(uri || '').trim();
  if (!u) return null;
  return { dest: 'uri', uri: u };
}

function formatMeasure(pdfUnits, scale) {
  if (scale && scale.unitsPerPoint) {
    const v = pdfUnits * scale.unitsPerPoint;
    return `${v.toFixed(2)} ${scale.unit || 'units'}`;
  }
  const inches = pdfUnits / 72;
  if (inches < 1) return `${(inches * 25.4).toFixed(1)} mm`;
  if (inches < 12) return `${inches.toFixed(2)} in`;
  return `${(inches / 12).toFixed(2)} ft`;
}

/* ── Click-to-place tools ───────────────────────────────────────────────── */

async function placeClickTool(i, pt, clientX, clientY) {
  const s = currentScale();
  if (state.tool === 'note') {
    const size = 20 / s;
    const a = makeAnnot('note', i, [pt.x, pt.y - size, pt.x + size, pt.y], { icon: 'Note' });
    commitNew(a, i, 'note');
    openInlineTextbox(a.id, { note: true, clientX, clientY });
    return;
  }
  if (state.tool === 'caret') {
    // Foxit's "Insert Text" markup: a caret that marks where text should go.
    const h = 14 / s;
    const a = makeAnnot('caret', i, [pt.x, pt.y - h, pt.x + h * 0.42, pt.y + h * 0.5], {
      borderWidth: 1.2, caret: true,
    });
    commitNew(a, i, 'insert text');
    return;
  }
  if (state.tool === 'stamp') {
    const picked = await pickStamp(clientX, clientY);
    if (!picked) return;
    const w = (picked.width || 160) / s, h = (picked.height || 44) / s;
    const a = makeAnnot('stamp', i, [pt.x, pt.y - h, pt.x + w, pt.y], {
      stampLabel: picked.label || 'STAMP',
      color: picked.color || state.colorRgb,
      fontSize: 14,
    });
    commitNew(a, i, 'stamp');
    return;
  }
  if (state.tool === 'signature' || state.tool === 'image') {
    const res = state.tool === 'signature' ? await pickSignature() : await pickImage();
    if (!res) return;
    const w = (res.width || 180) / s, h = (res.height || 60) / s;
    const a = makeAnnot(state.tool === 'signature' ? 'signature' : 'image', i, [pt.x, pt.y - h, pt.x + w, pt.y], {
      image: res.dataUrl,
    });
    commitNew(a, i, state.tool);
    return;
  }
}

/* ── Eraser ─────────────────────────────────────────────────────────────── */

function eraseAt(i, clientX, clientY) {
  const doc = activeDoc();
  if (!doc) return;
  const p = clientToPdf(i, clientX, clientY);
  const tol = 8 / currentScale();
  const hits = doc.annots.filter((a) => a.page === i && hitAnnot(a, p, tol));
  if (hits.length) { removeAnnots(hits.map((a) => a.id)); pushHistory('erase'); renderAnnots(i); emit('annots'); }
}

function hitAnnot(a, p, tol) {
  const r = a.rect;
  return p.x >= r[0] - tol && p.x <= r[2] + tol && p.y >= r[1] - tol && p.y <= r[3] + tol;
}

/* ── Selection & transform ──────────────────────────────────────────────── */

export function selectAnnot(id, additive = false) {
  if (additive) {
    const i = state.selection.indexOf(id);
    if (i >= 0) state.selection.splice(i, 1); else state.selection.push(id);
  } else {
    state.selection = [id];
  }
  const doc = activeDoc();
  if (doc) {
    const a = doc.annots.find((x) => x.id === id);
    if (a) renderAnnots(a.page);
  }
  emit('selection');
}

export function transformAnnot(a, from, to) {
  const fw = from[2] - from[0], fh = from[3] - from[1];
  const tw = to[2] - to[0], th = to[3] - to[1];
  const sx = fw ? tw / fw : 1, sy = fh ? th / fh : 1;
  const map = (x, y) => [to[0] + (x - from[0]) * sx, to[1] + (y - from[1]) * sy];
  const mapFlat = (arr) => {
    const out = [];
    for (let k = 0; k < arr.length; k += 2) out.push(...map(arr[k], arr[k + 1]));
    return out;
  };
  a.rect = to.slice();
  if (a.quads) a.quads = a.quads.map(mapFlat);
  if (a.paths) a.paths = a.paths.map(mapFlat);
  if (a.points) a.points = mapFlat(a.points);
  if (a.leader) a.leader = map(a.leader[0], a.leader[1]);
  // Marker widths are lengths, so a resize scales them; a move leaves them be.
  if (a.widths) {
    const f = (sx + sy) / 2;
    if (f !== 1) a.widths = a.widths.map((w) => w * f);
  }
}

/* ── Brush taper, format painter, eyedropper ────────────────────────────── */

/** Velocity → width. Screen speed is folded into PDF units so the taper does
 *  not change with zoom; the result is smoothed so a jittery mouse hums
 *  rather than buzzes. */
export function velocityWidths(points, times, base, scale = 1) {
  const out = [];
  let w = base;
  for (let k = 0; k < points.length; k++) {
    if (k > 0) {
      const dt = Math.max(8, (times[k] || 0) - (times[k - 1] || 0));
      const dist = Math.hypot(points[k][0] - points[k - 1][0], points[k][1] - points[k - 1][1]) * scale;
      const v = dist / dt;                       // CSS pixels per millisecond
      w += (base * clamp(1 - v / 24, 0.3, 1) - w) * 0.35;
    }
    out.push(clamp(w, base * 0.18, base));
  }
  return out;
}

const FORMAT_KEYS = ['color', 'fill', 'opacity', 'borderWidth', 'fontSize', 'fontFamily', 'align', 'hardness', 'dash', 'textColor'];

/** Snapshot the appearance the painter will hand out, remembering the source
 *  type so text-only properties are never pushed onto a shape. */
function pickAppearance(a) {
  const out = { type: a.type };
  for (const k of FORMAT_KEYS) {
    if (a[k] === undefined) continue;
    out[k] = Array.isArray(a[k]) ? a[k].slice() : a[k];
  }
  return out;
}

function appearancePatch(f, target) {
  const p = {};
  if (f.color) p.color = f.color.slice();
  if (f.opacity != null) p.opacity = f.opacity;
  if (f.borderWidth != null) p.borderWidth = f.borderWidth;
  if ('fill' in f) p.fill = f.fill == null ? null : f.fill.slice();
  const isText = target.type === 'textbox' || target.type === 'callout';
  if (isText && (f.type === 'textbox' || f.type === 'callout')) {
    if (f.fontSize != null) p.fontSize = f.fontSize;
    if (f.fontFamily) p.fontFamily = f.fontFamily;
    if (f.align) p.align = f.align;
  }
  if (target.type === 'brush' && f.hardness != null) p.hardness = f.hardness;
  return p;
}

function formatPainterAt(i, e) {
  const doc = activeDoc();
  if (!doc) return;
  const node = e.target.closest ? e.target.closest('.ann') : null;
  const hit = node ? doc.annots.find((x) => x.id === node.dataset.id) : null;
  if (!copiedFormat) {
    if (!hit) return;
    copiedFormat = pickAppearance(hit);
    toast('Format copied — click other objects to apply it', 'info', 2600);
    return;
  }
  if (!hit) return;                       // an empty click keeps the format loaded
  const ids = state.selection.length > 1 && state.selection.includes(hit.id)
    ? state.selection.slice()
    : [hit.id];
  const targets = doc.annots.filter((a) => ids.includes(a.id));
  for (const t of targets) updateAnnot(t.id, appearancePatch(copiedFormat, t), { silent: true });
  // One gesture, one undo step, however many objects it touched.
  pushHistory('format painter');
  renderAnnots(i);
  emit('annots');
  emit('selection');
  copiedFormat = null;
  emit('tool', 'select');
}

/** Called by app.js whenever the tool changes, so a half-finished pick does
 *  not silently land on the next thing the user clicks. */
export function clearFormat() { copiedFormat = null; }

function eyedropperAt(i, clientX, clientY) {
  const canvas = pageEl(i)?.canvas;
  if (!canvas || !canvas.width || !canvas.height) return;
  const box = canvas.getBoundingClientRect();
  if (!box.width || !box.height) return;
  const px = Math.floor((clientX - box.left) * (canvas.width / box.width));
  const py = Math.floor((clientY - box.top) * (canvas.height / box.height));
  if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return;
  let d;
  try {
    d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(px, py, 1, 1).data;
  } catch (err) {
    toast('Could not read that pixel: ' + (err && err.message ? err.message : err), 'err');
    return;
  }
  if (!d || !d.length) return;
  const a = d[3] / 255;
  // A transparent sample is the white page showing through, not black: flatten
  // it over white so blank pixels give a usable colour instead of a surprise.
  const rgb = [0, 1, 2].map((k) => clamp((d[k] * a + 255 * (1 - a)) / 255, 0, 1));
  emit('eyedropper', rgbToHex(rgb));
}

/* ── Drag preview ───────────────────────────────────────────────────────── */

function drawPreview(i) {
  const rec = pageEl(i);
  if (!rec || !rec.svg) return;
  let g = rec.svg.querySelector('.preview');
  if (!g) { g = svgEl('g', { class: 'preview' }); rec.svg.appendChild(g); }
  g.innerHTML = '';
  const s = currentScale();
  const c = rgbToCss(state.colorRgb, 1);
  const toCssPt = (p) => toCss(i, p.x, p.y);
  if (state.tool === 'ink') {
    let d = '';
    drag.points.forEach((p, k) => { const q = toCss(i, p[0], p[1]); d += (k === 0 ? 'M ' : 'L ') + q.x.toFixed(1) + ' ' + q.y.toFixed(1) + ' '; });
    g.appendChild(svgEl('path', { d, fill: 'none', stroke: c, 'stroke-width': Math.max(1, (settings.borderWidth || 2) * s * 0.8), 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    return;
  }
  if (state.tool === 'brush') {
    const base = settings.brushSize || 6;
    const widths = velocityWidths(drag.points, drag.times, base, s);
    const pts = drag.points.map((p) => toCss(i, p[0], p[1]));
    for (let k = 0; k + 1 < pts.length; k++) {
      g.appendChild(svgEl('line', {
        x1: pts[k].x, y1: pts[k].y, x2: pts[k + 1].x, y2: pts[k + 1].y,
        stroke: c, 'stroke-width': Math.max(0.5, ((widths[k] + widths[k + 1]) / 2) * s), 'stroke-linecap': 'round',
      }));
    }
    return;
  }
  if (state.tool === 'highlighter') {
    const w = settings.highlighterSize || 16;
    const poly = sweptQuads(drag.points.flat(), w).map((q) => {
      const p = [];
      for (let k = 0; k < 8; k += 2) p.push(toCss(i, q[k], q[k + 1]));
      return p.map((pt) => `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(' ');
    });
    for (const points of poly) {
      g.appendChild(svgEl('polygon', { points, fill: c, opacity: state.opacity ?? 0.4, style: 'mix-blend-mode:multiply' }));
    }
    return;
  }
  const a = toCssPt(drag.start), b = toCssPt(drag.cur);
  if (state.tool === 'line' || state.tool === 'arrow' || state.tool === 'measure') {
    g.appendChild(svgEl('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: c, 'stroke-width': Math.max(1, (settings.borderWidth || 1.5) * s * 0.75) }));
    if (state.tool === 'arrow' || state.tool === 'measure') {
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const L = 9;
      g.appendChild(svgEl('path', {
        d: `M ${b.x} ${b.y} L ${b.x + Math.cos(ang + 2.6) * L} ${b.y + Math.sin(ang + 2.6) * L} M ${b.x} ${b.y} L ${b.x + Math.cos(ang - 2.6) * L} ${b.y + Math.sin(ang - 2.6) * L}`,
        stroke: c, 'stroke-width': Math.max(1, 1.6), fill: 'none',
      }));
    }
    return;
  }
  const r = [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y)];
  if (state.tool === 'ellipse') {
    g.appendChild(svgEl('ellipse', { cx: r[0] + r[2] / 2, cy: r[1] + r[3] / 2, rx: Math.max(0.5, r[2] / 2), ry: Math.max(0.5, r[3] / 2), fill: previewFillCss(), stroke: c, 'stroke-width': Math.max(1, (settings.borderWidth || 1.5) * s * 0.75) }));
  } else if (state.tool === 'redact') {
    g.appendChild(svgEl('rect', { x: r[0], y: r[1], width: r[2], height: r[3], fill: 'rgba(0,0,0,.5)', stroke: '#d92d3f', 'stroke-width': 1.2, 'stroke-dasharray': '4 3' }));
  } else if (state.tool === 'whiteout') {
    g.appendChild(svgEl('rect', { x: r[0], y: r[1], width: r[2], height: r[3], fill: '#fff', stroke: '#999', 'stroke-width': 1 }));
  } else {
    g.appendChild(svgEl('rect', { x: r[0], y: r[1], width: r[2], height: r[3], fill: previewFillCss(), stroke: c, 'stroke-width': Math.max(1, (settings.borderWidth || 1.5) * s * 0.75) }));
  }
}

function clearPreview(i) {
  const rec = pageEl(i);
  if (rec && rec.svg) { const g = rec.svg.querySelector('.preview'); if (g) g.remove(); }
}

/* ── Vertex tools: polygon / polyline / cloud / area highlight / measure ──── */

/** Live preview for a vertex path in progress: the committed vertices as a
 *  closed (or open) outline, plus a rubber band to the cursor. */
function drawPolyPreview(i, cursorPt) {
  const rec = pageEl(i);
  if (!rec || !rec.svg) return;
  let g = rec.svg.querySelector('.preview');
  if (!g) { g = svgEl('g', { class: 'preview' }); rec.svg.appendChild(g); }
  g.innerHTML = '';
  const s = currentScale();
  const c = rgbToCss(state.colorRgb, 1);
  const pts = (polyPath ? polyPath.pts : []).map((p) => toCss(i, p[0], p[1]));
  if (!pts.length) return;
  const ptsAttr = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const sw = Math.max(1, (settings.borderWidth || 1.5) * s * 0.75);
  if (state.tool === 'areaHighlight') {
    // Area highlight covers the region with a translucent wash, like Foxit does.
    g.appendChild(svgEl('polygon', { points: ptsAttr, fill: c, opacity: state.opacity ?? 0.4, style: 'mix-blend-mode:multiply' }));
  } else {
    const closed = (state.tool === 'polygon' || state.tool === 'cloud') && pts.length > 2;
    const fillOn = settings.fillEnabled && closed;
    if (fillOn) g.appendChild(svgEl('polygon', { points: ptsAttr, fill: rgbToCss(hexToRgb(settings.fillColor || '#ffffff'), 1), stroke: 'none', opacity: 0.9 }));
    const linePts = cursorPt ? pts.concat([cursorPt]) : pts;
    g.appendChild(svgEl(closed ? 'polygon' : 'polyline', {
      points: linePts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '),
      fill: 'none', stroke: c, 'stroke-width': sw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    }));
  }
  for (const p of pts) g.appendChild(svgEl('circle', { cx: p.x, cy: p.y, r: 2.6, fill: c }));
  if (cursorPt) g.appendChild(svgEl('circle', { cx: cursorPt.x, cy: cursorPt.y, r: 3.4, fill: 'none', stroke: c, 'stroke-width': 1 }));
}

/** Commit the vertex path as an annotation. Enter/double-click/click-on-first-
 *  vertex all land here. */
function finishPolyPath() {
  if (!polyPath) return;
  const i = polyPath.page;
  const pts = polyPath.pts.slice();
  polyPath = null;
  clearPreview(i);
  if (pts.length < 2) return;

  const s = currentScale();
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const pad = (settings.borderWidth || 1.5) / 2 + 3 / s;
  const rect = normalizeRect([Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad]);
  const flat = pts.flat();

  if (state.tool === 'measureArea') {
    if (pts.length < 3) { toast('Click at least three points to enclose an area.', 'warn'); return; }
    let perim = 0, twiceArea = 0;
    for (let k = 0; k < pts.length; k++) {
      const a = pts[k], b = pts[(k + 1) % pts.length];
      perim += Math.hypot(b[0] - a[0], b[1] - a[1]);
      twiceArea += a[0] * b[1] - b[0] * a[1];
    }
    const areaSq = Math.abs(twiceArea) / 2;
    const sc = activeDoc()?.measureScale;
    const a = makeAnnot('measureArea', i, rect, {
      poly: true, points: flat, borderWidth: settings.borderWidth || 1.5,
      label: `Perimeter ${formatMeasure(perim, sc)} · Area ${formatArea(areaSq, sc)}`,
    });
    commitNew(a, i, 'measure area');
    return;
  }

  const type = state.tool;
  const extra = { poly: true, points: flat, borderWidth: settings.borderWidth || 1.5 };
  if (type === 'polygon' || type === 'cloud') extra.closed = true;
  if ((type === 'polygon' || type === 'cloud') && settings.fillEnabled) extra.fill = hexToRgb(settings.fillColor || '#ffffff');
  const a = makeAnnot(type, i, rect, extra);
  commitNew(a, i, type);
}

/** Area in the document's calibration units, falling back to in²/ft². */
function formatArea(sqUnits, scale) {
  if (scale && scale.unitsPerPoint) {
    const v = sqUnits * scale.unitsPerPoint * scale.unitsPerPoint;
    return `${v.toFixed(2)} ${scale.unit || 'units'}²`;
  }
  const sqIn = sqUnits / (72 * 72);
  if (sqIn < 1) return `${(sqIn * 25.4 * 25.4).toFixed(1)} mm²`;
  return `${sqIn.toFixed(2)} in²`;
}

export function cancelPolyPath() {
  if (!polyPath) return;
  const i = polyPath.page;
  polyPath = null;
  clearPreview(i);
}

/* ── Text markup from the browser selection ─────────────────────────────── */

export function selectionQuadsOnPage(i) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const rec = pageEl(i);
  if (!rec) return null;
  const wrapRect = rec.wrap.getBoundingClientRect();
  const quads = [];
  for (let r = 0; r < sel.rangeCount; r++) {
    const range = sel.getRangeAt(r);
    if (!rec.textLayer.contains(range.commonAncestorContainer) && !rec.wrap.contains(range.commonAncestorContainer)) continue;
    for (const cr of Array.from(range.getClientRects())) {
      if (cr.width < 0.6 || cr.height < 0.6) continue;
      const x0 = cr.left - wrapRect.left, y0 = cr.top - wrapRect.top;
      const x1 = cr.right - wrapRect.left, y1 = cr.bottom - wrapRect.top;
      const p0 = toPdf(i, x0, y0);
      const p1 = toPdf(i, x1, y0);
      const p2 = toPdf(i, x0, y1);
      const p3 = toPdf(i, x1, y1);
      quads.push([p0.x, p0.y, p1.x, p1.y, p2.x, p2.y, p3.x, p3.y]);
    }
  }
  return quads.length ? quads : null;
}

export function applyMarkupFromSelection(tool) {
  const doc = activeDoc();
  if (!doc) return;
  const i = doc.currentPage ?? 0;
  const quads = selectionQuadsOnPage(i);
  if (!quads) return false;
  const text = window.getSelection().toString().replace(/\s+/g, ' ').trim();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of quads) for (let k = 0; k < 8; k += 2) {
    x0 = Math.min(x0, q[k]); x1 = Math.max(x1, q[k]);
    y0 = Math.min(y0, q[k + 1]); y1 = Math.max(y1, q[k + 1]);
  }
  const pad = 2 / currentScale();
  const a = makeAnnot(tool, i, [x0 - pad, y0 - pad, x1 + pad, y1 + pad], { quads, text });
  addAnnot(a);
  pushHistory(tool);
  renderAnnots(i);
  emit('annots');
  window.getSelection().removeAllRanges();
  hideQuickBar();
  return true;
}

document.addEventListener('mouseup', (e) => {
  if (!MARKUP_TOOLS.has(state.tool)) return;
  if (quickBar && quickBar.contains(e.target)) return;
  setTimeout(() => {
    if (applyMarkupFromSelection(state.tool)) {
      // stay in the same tool so users can mark several passages
    }
  }, 0);
});

/* ── Floating quick-action bar for text selection ───────────────────────── */

function onSelectionChange() {
  if (state.tool !== 'select') { hideQuickBar(); return; }
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) { hideQuickBar(); return; }
  const range = sel.getRangeAt(0);
  const rects = Array.from(range.getClientRects());
  if (!rects.length) { hideQuickBar(); return; }
  showQuickBar(rects[rects.length - 1]);
}

function showQuickBar(rect) {
  hideQuickBar();
  const bar = document.createElement('div');
  bar.className = 'popover';
  bar.style.cssText += ';display:flex;gap:2px;padding:4px;';
  const mk = (label, title, fn) => {
    const b = document.createElement('button');
    b.className = 'tbtn';
    b.title = title;
    b.style.cssText = 'width:auto;height:26px;padding:0 8px;font-size:11.5px;';
    b.textContent = label;
    b.onclick = () => { fn(); };
    return b;
  };
  bar.appendChild(mk('Highlight', 'Highlight (H)', () => applyMarkupFromSelection('highlight')));
  bar.appendChild(mk('Underline', 'Underline (U)', () => applyMarkupFromSelection('underline')));
  bar.appendChild(mk('Strike', 'Strikethrough (S)', () => applyMarkupFromSelection('strikeout')));
  bar.appendChild(mk('Copy', 'Copy', () => document.execCommand('copy')));
  bar.appendChild(mk('Ask AI', 'Ask the AI about this passage', () => {
    const text = window.getSelection().toString();
    hideQuickBar();
    emit('ai:askSelection', text);
  }));
  document.getElementById('overlayRoot').appendChild(bar);
  const w = bar.offsetWidth, h = bar.offsetHeight;
  bar.style.left = clamp(rect.left, 8, window.innerWidth - w - 8) + 'px';
  bar.style.top = Math.max(8, rect.bottom + 6) + 'px';
  quickBar = bar;
}

function hideQuickBar() {
  if (quickBar) { quickBar.remove(); quickBar = null; }
}

export { hideQuickBar };
