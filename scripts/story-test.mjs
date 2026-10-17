#!/usr/bin/env node
/**
 * Unit tests for the story / frame authoring model (src/renderer/js/story.js).
 *
 * These are the LAYOUT MODEL and the AUTHORING MODEL, exercised without a DOM
 * and without pdf-lib: wrapping, frame threading, overset, merge separators,
 * and the Engine facade (lines / merge / thread / preview / restore).
 *
 *   node scripts/story-test.mjs
 */
import {
  SCHEMA_VERSION, normRect, makeFrame, rectW, rectH, fitCount,
  layoutStory, storyFromEdit, mergeStories, threadStory, createEngine,
} from '../src/renderer/js/story.js';

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

/* Deterministic metrics: every glyph is 0.5em wide. Keeps the arithmetic
 * checkable by hand, which is the whole point of a pure layout test. */
const size = 10;
const measure = (t) => String(t).length * size * 0.5;
const frame = (page, r) => makeFrame(page, r);

/* ── rect / frame primitives ─────────────────────────────────────────────── */

check('normRect orders an inverted rect', JSON.stringify(normRect([350, 460, 38, 390])) === JSON.stringify([38, 390, 350, 460]));
check('rectW / rectH report the span', rectW([38, 390, 350, 460]) === 312 && rectH([38, 390, 350, 460]) === 70);
check('makeFrame rejects a malformed rect', (() => { try { makeFrame(0, [1, 2, 3]); return false; } catch { return true; } })());

/* ── fitCount: the reference composition rule ────────────────────────────── */

check('fitCount: a frame shorter than one line holds nothing', fitCount(['a'], 10, 10, 12) === 0, `h=10`);
check('fitCount: exactly one line + descent reserve', fitCount(['a', 'b'], 13.5, 10, 12) === 1, `h=13.5 -> 1`);
check('fitCount: two lines need first baseline + one step + reserve', fitCount(['a', 'b'], 25.5, 10, 12) === 2, `h=25.5 -> 2`);
check('fitCount never exceeds the line count', fitCount(['a'], 1000, 10, 12) === 1);

/* ── layoutStory: wrapping, consumption, overset ─────────────────────────── */

const shortStory = {
  text: 'hello world',
  style: { size, leading: 12, inset: 0 },
  frames: [frame(0, [38, 390, 350, 460])],
};
const l1 = layoutStory(shortStory, measure);
check('layout places a short story into its one frame', l1.placements.length === 1 && l1.placements[0].lines.length === 1, JSON.stringify(l1.placements[0]?.lines?.map((x) => x.text)));
check('layout reports no overset when everything fits', l1.overset === null);
check('layout consumes the whole story', l1.consumed === 'hello world'.length && l1.total === 11, `consumed=${l1.consumed}`);
check('first baseline sits one size below the frame top', l1.placements[0].lines[0].y === 460 - size, `y=${l1.placements[0].lines[0].y}`);

// A narrow frame forces wrapping (5pt/char, 80pt -> 16 chars), and a frame
// only one line tall then forces overset.
const wrapped = {
  text: 'aaa bbb ccc ddd eee fff ggg hhh',
  style: { size, leading: 12, inset: 0 },
  frames: [frame(0, [0, 0, 80, 13.5])],   // 13.5 tall -> exactly one line
};
const l2 = layoutStory(wrapped, measure);
check('layout wraps to the frame width', l2.placements[0].lines.length === 1, `${l2.placements[0].lines.length} line: ${JSON.stringify(l2.placements[0].lines.map((x) => x.text))}`);
check('layout reports overset for the text that did not fit', !!l2.overset && l2.overset.text.length > 0, JSON.stringify(l2.overset?.text));
check('overset suffix is the logical remainder, not a re-wrap artefact', !!l2.overset && /^eee/.test(l2.overset.text), JSON.stringify(l2.overset?.text));
check('placed + overset accounts for every glyph of the story', (() => {
  const strip = (s) => String(s).replace(/\s+/g, '');
  const placed = l2.placements[0].lines.map((x) => x.text).join('');
  return strip(placed) + strip(l2.overset.text) === strip(wrapped.text);
})(), `consumed=${l2.consumed}`);

/* ── layoutStory: threading across frames ────────────────────────────────── */

const threaded = {
  text: 'one two three four five six seven eight nine ten',
  style: { size, leading: 12, inset: 0 },
  frames: [
    frame(0, [0, 100, 60, 125.5]),   // 60 wide -> 6 chars/line; 25.5 tall -> 2 lines
    frame(1, [0, 100, 60, 125.5]),   // same again on page 2
  ],
};
const l3 = layoutStory(threaded, measure);
check('threaded layout fills frame 1 first', l3.placements[0].lines.length === 2, `${l3.placements[0].lines.length}`);
check('threaded layout continues into frame 2', l3.placements[1].lines.length >= 1, `${l3.placements[1].lines.length}`);
check('frame 2 is a different page, not a merged rectangle', l3.placements[0].page === 0 && l3.placements[1].page === 1);
check('logical ranges are contiguous across frames', l3.placements[0].logicalEnd === l3.placements[1].logicalStart, `${l3.placements[0].logicalEnd} -> ${l3.placements[1].logicalStart}`);
check('the last frame still reports overset for the tail', !!l3.overset, JSON.stringify(l3.overset?.text));

// Enough frames -> no overset at all.
const roomy = { ...threaded, frames: [frame(0, [0, 0, 400, 400])] };
const l4 = layoutStory(roomy, measure);
check('a roomy frame consumes the whole story with no overset', l4.overset === null && l4.consumed === roomy.text.length);

/* ── mergeStories: separators are the author's decision ──────────────────── */

const itemA = { text: 'first line', page: 0, coverRect: [10, 100, 90, 112], itemIndices: [0, 1], style: { size, leading: 12, fontFamily: 'Helvetica' } };
const itemB = { text: 'second line', page: 0, coverRect: [10, 86, 90, 98], itemIndices: [2], style: { size, leading: 12, fontFamily: 'Helvetica' } };
const itemC = { text: 'third', page: 0, coverRect: [10, 72, 90, 84], itemIndices: [3], style: { size, leading: 12, fontFamily: 'Helvetica' } };

const asParagraph = mergeStories([itemA, itemB], { frame: [10, 60, 300, 120], separators: [' '] });
check('merge with a space separator joins a soft wrap', asParagraph.text === 'first line second line', JSON.stringify(asParagraph.text));
check('merge keeps every source ref of every item', JSON.stringify(asParagraph.sourceRefs.itemIndices) === '[0,1,2]', JSON.stringify(asParagraph.sourceRefs.itemIndices));
check('merge records every source rect it will own', asParagraph.sourceRects.length === 2);
check('merge defaults to flow mode with one frame', asParagraph.mode === 'flow' && asParagraph.frames.length === 1);

const asBreaks = mergeStories([itemA, itemB, itemC], { frame: [10, 60, 300, 120], separators: ['\n', '\n'] });
check('merge with newline separators keeps intentional breaks', asBreaks.text === 'first line\nsecond line\nthird', JSON.stringify(asBreaks.text));

const asFragments = mergeStories([itemA, itemB], { frame: [10, 60, 300, 120], separators: [''] });
check('merge with an empty separator rejoins a split fragment', asFragments.text === 'first linesecond line');

const explicit = mergeStories([itemA, itemB], { frame: [10, 60, 300, 120], text: 'overridden' });
check('merge can take explicit replacement text', explicit.text === 'overridden');

/* ── threadStory ─────────────────────────────────────────────────────────── */

const threadedStory = threadStory(asParagraph, [frame(0, [10, 300, 300, 360]), frame(1, [10, 100, 300, 400])]);
check('thread sets the ordered frame list', threadedStory.frames.length === 2 && threadedStory.frames[0].page === 0 && threadedStory.frames[1].page === 1);
check('threading forces flow mode', threadedStory.mode === 'flow');

/* ── storyFromEdit: backward compatibility ───────────────────────────────── */

const legacy = storyFromEdit({ id: 'te1', page: 0, text: 'old', size: 11, lineHeight: 13, rect: [50, 700, 200, 730], baseline: [50, 710], itemIndices: [4, 5] });
check('a legacy edit becomes a story with one derived frame', legacy.frames.length === 1 && legacy.frames[0].page === 0, JSON.stringify(legacy.frames));
check('a legacy edit keeps its source refs', JSON.stringify(legacy.sourceRefs.itemIndices) === '[4,5]');
check('a legacy edit is stamped with the schema version', legacy.schemaVersion === SCHEMA_VERSION);

const modern = storyFromEdit({ id: 'te2', page: 0, text: 'x', size: 11, lineHeight: 13, frames: [{ page: 0, rect: [0, 0, 50, 50] }, { page: 2, rect: [0, 0, 50, 50] }] });
check('a framed edit keeps its frames as authored', modern.frames.length === 2 && modern.frames[1].page === 2);

/* ── Engine facade: the reference API surface ────────────────────────────── */

const doc = { pageSizes: [{ w: 595, h: 842 }], stories: [] };
const blocks = [
  { key: 'n:0.1', text: 'Alpha beta', coverRect: [38, 390, 350, 402], itemIndices: [0, 1] },
  { key: 'n:2', text: 'Gamma delta', coverRect: [38, 376, 350, 388], itemIndices: [2] },
  { key: 'n:3', text: 'Unrelated', coverRect: [38, 100, 350, 112], itemIndices: [3] },
];
const eng = createEngine(doc, { measure, blocksFor: () => blocks });

const lines = eng.lines(0);
check('engine.lines returns proposals with .sources', lines.length === 3 && Array.isArray(lines[0].sources), JSON.stringify(lines[0]?.sources));

const sourceIds = [...lines[0].sources, ...lines[1].sources];
const storyId = eng.merge(sourceIds, makeFrame(0, [38, 330, 350, 400]), 'Alpha beta Gamma delta');
check('engine.merge returns a story id', typeof storyId === 'string' && storyId.length > 0, storyId);
const story = eng.story(storyId);
check('the merged story owns exactly the selected sources', JSON.stringify(story.sourceRefs.itemIndices) === '[0,1,2]', JSON.stringify(story.sourceRefs.itemIndices));
check('the merged story does NOT own the unrelated source', !story.sourceRefs.itemIndices.includes(3));

eng.thread(storyId, [makeFrame(0, [38, 330, 350, 400]), makeFrame(1, [38, 100, 350, 400])]);
check('engine.thread sets a two-frame chain', eng.story(storyId).frames.length === 2);

const preview = eng.preview(storyId);
check('engine.preview returns a layout with an overset field', 'overset' in preview && Array.isArray(preview.placements));

const tiny = eng.merge([3], makeFrame(0, [0, 0, 20, 13.5]), 'a much longer string than fits');
const tinyPreview = eng.preview(tiny);
check('engine.preview flags overset for a too-small frame', !!tinyPreview.overset, JSON.stringify(tinyPreview.overset?.text));

check('engine.restore discards the story', eng.restore(storyId) === true && eng.story(storyId) === null);

/* ── verdict ─────────────────────────────────────────────────────────────── */

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\nSTORY_FAIL ${failed.length}/${results.length} checks failed` : `\nSTORY_PASS all ${results.length} checks green`);
process.exit(failed.length ? 1 : 0);
