/**
 * Rectangle geometry with no DOM or viewer dependencies, so it stays unit-
 * testable in plain Node (see scripts/resize-test.mjs).
 *
 * Coordinate space is PDF user space: origin bottom-left, +y upward. That
 * means for a normalised rect [x0, y0, x1, y1]:
 *   index 1 (y0) is the LOWEST y, which renders as the BOTTOM of the screen, and
 *   index 3 (y1) is the HIGHEST y, which renders as the TOP of the screen.
 * Every handle rule below is written against that fact. Mixing it up is what
 * made the resize handles drive the opposite edge, so the mapping is spelled out
 * in the table rather than implied by a comment.
 */

export function normalizeRect(r) {
  return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
}

/**
 * Resize `orig` by dragging the screen handle `h` to PDF-space point `p`.
 *
 * Handle indices match the order used by drawSelectionDecor in annots.js, which
 * positions them in CSS space (top-left origin, +y downward):
 *   0 top-left  1 top  2 top-right  3 right  4 bottom-right  5 bottom  6 bottom-left  7 left
 *
 * A screen-TOP drag must therefore rewrite index 3, and a screen-BOTTOM drag
 * index 1. `left` and `right` behave the same in both spaces.
 */
const MOVES_TOP = new Set([0, 1, 2]);
const MOVES_BOTTOM = new Set([4, 5, 6]);
const MOVES_LEFT = new Set([0, 6, 7]);
const MOVES_RIGHT = new Set([2, 3, 4]);

export function resizeRect(h, orig, p) {
  const nb = orig.slice();
  if (MOVES_LEFT.has(h)) nb[0] = p.x;
  if (MOVES_RIGHT.has(h)) nb[2] = p.x;
  if (MOVES_TOP.has(h)) nb[3] = p.y;
  if (MOVES_BOTTOM.has(h)) nb[1] = p.y;
  return normalizeRect(nb);
}

/** Per-handle cursor, so hovering the right edge does not offer an up/down drag. */
export const HANDLE_CURSORS = ['nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize'];
