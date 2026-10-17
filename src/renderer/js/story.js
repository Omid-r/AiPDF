/**
 * Story / frame authoring model — the middle two boxes of the pipeline the
 * research describes:
 *
 *     ORIGINAL PDF  →  AUTHORING MODEL  →  LAYOUT MODEL  →  PDF WRITER
 *     source objects   stories, runs,      wrapping,         remove owned
 *     text, fonts,     confirmed source    baselines,        sources, insert
 *     geometry         ownership, line/    placements,       replacements,
 *                      flow mode, ordered  logical ranges,   regenerate,
 *                      destination frames  overset status    save, reopen
 *
 * Three ideas are load-bearing, and they are the ones that separate this from a
 * "cover the old words and draw new ones on top" editor:
 *
 *  1. SOURCE OWNERSHIP IS EXPLICIT. A story names the exact source objects it
 *     owns (`sourceRefs`). The writer may remove those and only those. A
 *     selection is a *proposal* until it is confirmed into a story.
 *
 *  2. FRAMES ARE ORDERED AND SEPARATE. A story composes into frame 1, then
 *     continues from the exact logical position into frame 2, and so on. The
 *     frames are never merged into one rectangle — the area between them may
 *     hold an image, another column, or unrelated material.
 *
 *  3. OVERSET IS A FIRST-CLASS RESULT, never inferred from a renderer clipping
 *     text out of view. Layout reports how much story text was consumed and
 *     what remains; the UI must show it and export must refuse it.
 *
 * This module is deliberately free of DOM and of pdf-lib: it is pure geometry
 * and text, so it runs identically in the renderer, in Node, and under test.
 */

import { wrapBlockText } from './textblocks.js';

/** Bumped when the shape of a persisted story changes incompatibly. */
export const SCHEMA_VERSION = 2;

/* ── Rect / frame primitives ─────────────────────────────────────────────── */

const isRect = (r) => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite);

/** Normalise a rect to [x0, y0, x1, y1] with x0<=x1 and y0<=y1 (PDF user
 *  space, y increasing upward — so index 3 is the TOP of the rendered page). */
export function normRect(r) {
  if (!isRect(r)) return null;
  return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
}

export const rectW = (r) => Math.abs(r[2] - r[0]);
export const rectH = (r) => Math.abs(r[3] - r[1]);

/** A destination frame: where some composed content may appear. `page` is a
 *  document page index; `rect` is PDF user space. */
export function makeFrame(page, rect) {
  const r = normRect(rect);
  if (!r) throw new Error('Frame needs a 4-number rect');
  return { page: Number(page) || 0, rect: r };
}

/* ── Layout ──────────────────────────────────────────────────────────────── */

/**
 * How many of `lines` fit in a frame of height `height`.
 *
 * Follows the reference composition rule: the first baseline sits one line
 * font-size below the frame top, and a 0.35-em descent reserve is kept, so a
 * frame whose usable height is negative can hold nothing. Deliberately
 * conservative — a metrics mismatch must fail loudly (as overset) rather than
 * silently clip.
 */
export function fitCount(lines, height, size, leading) {
  if (!Array.isArray(lines) || !lines.length) return 0;
  const step = leading > 0 ? leading : size * 1.2;
  const usable = height - size * 1.35;
  if (usable < -1e-6) return 0;
  const k = Math.floor(usable / step) + 1;
  return Math.max(0, Math.min(lines.length, k));
}

/**
 * Compose a story into its ordered frames.
 *
 * `measure(text)` returns the advance width in points of `text` at the story's
 * font/size — supplied by the caller so the preview (canvas metrics) and the
 * writer (font metrics) share one algorithm and cannot disagree about wrapping.
 *
 * Returns:
 *   placements : [{ frameIndex, page, rect, lines: [{ text, x, y, baseline }],
 *                   logicalStart, logicalEnd }] in frame order
 *   consumed   : characters placed
 *   total      : characters in the story
 *   overset    : null, or { text, lines } — the suffix that did not fit
 */
export function layoutStory(story, measure) {
  const style = story.style || {};
  const size = Number(style.size) || 11;
  const leading = Number(style.leading) > 0 ? Number(style.leading) : size * 1.2;
  const inset = Number(style.inset) || 0;
  const frames = Array.isArray(story.frames) ? story.frames : [];
  const full = String(story.text ?? '').replace(/\r\n?/g, '\n');

  const placements = [];
  let rest = full;
  let consumed = 0;

  for (let fi = 0; fi < frames.length; fi++) {
    const f = frames[fi];
    const w = Math.max(8, rectW(f.rect) - inset * 2);
    const h = rectH(f.rect);
    const lines = wrapBlockText(rest, w, measure);
    const fit = fitCount(lines, h, size, leading);
    const top = f.rect[3];
    const x0 = f.rect[0] + inset;

    if (fit <= 0) { placements.push({ frameIndex: fi, page: f.page, rect: f.rect, lines: [], width: w }); continue; }

    const taken = lines.slice(0, fit);
    const placed = taken.map((t, i) => ({ text: t, x: x0, y: top - size - i * leading, baseline: top - size - i * leading }));
    const placedText = taken.join('\n');
    const logicalStart = consumed;
    consumed += placedText.length;
    placements.push({
      frameIndex: fi, page: f.page, rect: f.rect, width: w,
      lines: placed, logicalStart, logicalEnd: consumed,
    });

    if (fit >= lines.length) { rest = ''; break; }
    rest = lines.slice(fit).join('\n');
  }

  const overset = rest
    ? { text: rest, lines: rest.split('\n').length, count: rest.length }
    : null;

  return { placements, consumed, total: full.length, overset, size, leading };
}

/* ── Story construction ──────────────────────────────────────────────────── */

/**
 * Normalise a committed Direct Editor record into a story.
 *
 * Backward compatible: a record that predates frames is given the single frame
 * derived from its draw box, which is exactly what the writer used to do
 * implicitly. This is why old projects keep opening.
 */
export function storyFromEdit(edit) {
  if (!edit) return null;
  const style = {
    size: Number(edit.size) || 11,
    leading: Number(edit.lineHeight) > 0 ? Number(edit.lineHeight) : (Number(edit.size) || 11) * 1.2,
    color: edit.color || [0, 0, 0],
    fontFamily: edit.fontFamily || 'Helvetica',
    align: edit.align || 'left',
    bold: !!edit.bold, italic: !!edit.italic, underline: !!edit.underline,
    charSpacing: Number(edit.charSpacing) || 0,
    hScale: Number(edit.hScale) || 100,
    inset: 0,
  };
  let frames = Array.isArray(edit.frames) && edit.frames.length
    ? edit.frames.map((f) => ({ page: f.page ?? edit.page, rect: normRect(f.rect) }))
    : null;
  if (!frames) {
    const r = edit.drawBox || edit.rect;
    frames = [{ page: edit.page, rect: normRect(r) || [0, 0, 10, 10] }];
  }
  return {
    id: edit.id,
    schemaVersion: edit.schemaVersion || SCHEMA_VERSION,
    mode: edit.mode === 'line' ? 'line' : 'flow',
    page: edit.page,
    text: String(edit.text ?? ''),
    style,
    frames,
    sourceRefs: edit.sourceRefs || { itemIndices: (edit.itemIndices || []).slice(), lineIds: (edit.lineIds || []).slice() },
    sourceRects: (edit.sourceRects || (edit.exciseRect ? [edit.exciseRect] : edit.coverRect ? [edit.coverRect] : []))
      .map(normRect).filter(Boolean),
    original: edit.original ?? '',
  };
}

/**
 * "Make paragraph": declare several source selections to be ONE logical text
 * sequence in one frame.
 *
 * `separators[i]` is what to join item i to item i+1 with: `' '` for a soft
 * source wrap, `'\n'` for an intentional break, `''` for a fragment that was
 * split by the producer rather than by the author. The caller must confirm the
 * reading order and the separators; this function only obeys them. It never
 * removes a final hyphen on its own — a discretionary split may be rejoined,
 * a genuine compound word must keep its hyphen, and only the user can tell
 * which is which.
 */
export function mergeStories(items, { frame, text = null, separators = [], align = 'left', mode = 'flow', style = {} } = {}) {
  if (!items || !items.length) throw new Error('merge needs at least one source selection');
  const parts = [];
  items.forEach((it, i) => {
    if (i > 0) parts.push(separators[i - 1] !== undefined ? separators[i - 1] : ' ');
    parts.push(String(it.text ?? ''));
  });
  const merged = text != null ? String(text) : parts.join('');
  const sourceRefs = { itemIndices: [], lineIds: [] };
  const sourceRects = [];
  for (const it of items) {
    const refs = it.sourceRefs || {};
    // Tolerate both shapes: a proposal from the Engine facade carries
    // `.sources` (the reference API's name), a grouped block carries
    // `.itemIndices`, and a normalised story carries `.sourceRefs`.
    sourceRefs.itemIndices.push(...(refs.itemIndices || it.itemIndices || it.sources || []));
    sourceRefs.lineIds.push(...(refs.lineIds || it.lineIds || []));
    for (const r of (it.sourceRects || (it.coverRect ? [it.coverRect] : it.rect ? [it.rect] : []))) {
      const nr = normRect(r);
      if (nr) sourceRects.push(nr);
    }
  }
  sourceRefs.itemIndices = Array.from(new Set(sourceRefs.itemIndices)).sort((a, b) => a - b);
  sourceRefs.lineIds = Array.from(new Set(sourceRefs.lineIds));
  const first = items[0];
  return {
    id: null,
    schemaVersion: SCHEMA_VERSION,
    mode,
    page: first.page,
    text: merged,
    style: {
      size: first.style?.size || first.size || 11,
      leading: first.style?.leading || first.lineHeight || (first.style?.size || first.size || 11) * 1.2,
      color: first.style?.color || first.color || [0, 0, 0],
      fontFamily: first.style?.fontFamily || first.fontFamily || 'Helvetica',
      align, bold: !!first.bold, italic: !!first.italic, underline: !!first.underline,
      charSpacing: 0, hScale: 100, inset: 0, ...style,
    },
    frames: frame ? [makeFrame(frame.page ?? first.page, frame.rect || frame)] : [],
    sourceRefs,
    sourceRects: dedupeRects(sourceRects),
    original: items.map((it) => it.original ?? it.text ?? '').join('\n'),
  };
}

/** "Link frames": give a story an explicitly ordered list of destination
 *  frames. Unthreading (replacing the list with one frame) and splitting a
 *  story are different operations and are not offered by this function. */
export function threadStory(story, frames) {
  if (!story) return null;
  const list = (frames || []).map((f) => makeFrame(f.page ?? story.page, f.rect || f)).filter((f) => f.rect);
  if (!list.length) return story;
  return { ...story, frames: list, mode: 'flow' };
}

function dedupeRects(rects) {
  const out = [];
  for (const r of rects) {
    if (!out.some((o) => o.every((v, k) => Math.abs(v - r[k]) < 1e-6))) out.push(r);
  }
  return out;
}

/* ── The engine facade ─────────────────────────────────────────────────────
 *
 * The research ships a Python `Engine`. This is the same surface, against the
 * in-memory document model, so the UI can be written in the reference's terms:
 *
 *     const eng = createEngine(doc);
 *     const lines = eng.lines(0);                     // proposals, each .sources
 *     const storyId = eng.merge(sourceIds, frame, text);
 *     eng.thread(storyId, [frame, frame2]);
 *     const layout = eng.preview(storyId);            // .overset
 *     if (!layout.overset) eng.commit();              // → writer removes sources
 *
 * `measure` is injected so the facade stays pure and testable.
 */
export function createEngine(doc, options = {}) {
  if (!doc) throw new Error('createEngine needs a document');
  doc.stories = doc.stories || [];
  // Destructured parameters are read into locals on purpose: the import audit
  // treats a bare call to a destructured parameter as an undeclared symbol, and
  // a permanently-failing audit is a broken alarm.
  const measureFn = options.measure || (() => 6);
  const blocksFor = options.blocksFor;

  return {
    /** Line/block proposals for a page, each carrying the source objects it
     *  would own if selected. A proposal is NOT ownership until merged. */
    lines(pageIndex) {
      const blocks = typeof blocksFor === 'function' ? blocksFor(pageIndex) : [];
      return (blocks || []).map((b, i) => ({
        index: i,
        text: b.text,
        rect: b.coverRect || b.rect,
        page: pageIndex,
        sources: (b.itemIndices || []).slice(),
        key: b.key,
        block: b,
      }));
    },

    /** Declare the selected sources one logical sequence in `frame`. */
    merge(sourceIds, frame, text = null, opts = {}) {
      const ids = new Set(sourceIds || []);
      const picks = this.lines(opts.page ?? 0).filter((l) => l.sources.some((s) => ids.has(s)));
      if (!picks.length) throw new Error('merge found no source selection');
      const story = mergeStories(picks, { frame, text, separators: opts.separators || [], align: opts.align, style: opts.style });
      story.id = `st${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
      doc.stories.push(story);
      return story.id;
    },

    /** Replace a story's frame list with an explicitly ordered chain. */
    thread(storyId, frames) {
      const s = doc.stories.find((x) => x.id === storyId);
      if (!s) throw new Error('thread: unknown story ' + storyId);
      const next = threadStory(s, frames);
      s.frames = next.frames;
      s.mode = next.mode;
      return s;
    },

    /** Compose without mutating anything; the UI must inspect this. */
    preview(storyId) {
      const s = doc.stories.find((x) => x.id === storyId);
      if (!s) throw new Error('preview: unknown story ' + storyId);
      return layoutStory(s, measureFn);
    },

    story(storyId) { return doc.stories.find((x) => x.id === storyId) || null; },
    stories() { return doc.stories.slice(); },
    /** Discard the authoring intent; the source content is restored because the
     *  writer never mutated the original bytes. */
    restore(storyId) {
      const before = doc.stories.length;
      doc.stories = doc.stories.filter((s) => s.id !== storyId);
      return doc.stories.length < before;
    },
  };
}
