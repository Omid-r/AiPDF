/**
 * Resize-handle regression test. Runs in plain Node, no Electron:
 *   node scripts/resize-test.mjs
 *
 * It asserts, for each of the eight handles, that ONLY the two edges that handle
 * owns move, and the other two stay exactly where they were. The rect is in PDF
 * user space (y upward), so index 1 is the screen bottom and index 3 the screen top.
 *
 * The legacy table is reproduced verbatim from the pre-fix tools.js so this file
 * also demonstrates that the assertions really do discriminate: running the same
 * expectations against the old logic must fail.
 */

import { resizeRect, normalizeRect } from '../src/renderer/js/geometry.js';

const ORIG = [100, 200, 300, 400];
const P = { x: 150, y: 350 };

const NAMES = ['top-left', 'top', 'top-right', 'right', 'bottom-right', 'bottom', 'bottom-left', 'left'];

// [x0, y0(screen bottom), x1, y1(screen top)]
const EXPECT = [
  [150, 200, 300, 350], // 0 top-left    -> left + top move
  [100, 200, 300, 350], // 1 top         -> top only
  [100, 200, 150, 350], // 2 top-right   -> right + top
  [100, 200, 150, 400], // 3 right       -> right only
  [100, 350, 150, 400], // 4 bottom-right-> right + bottom
  [100, 350, 300, 400], // 5 bottom      -> bottom only
  [150, 350, 300, 400], // 6 bottom-left -> left + bottom
  [150, 200, 300, 400], // 7 left        -> left only
];

/** Verbatim transcription of the tools.js logic before the fix. */
function legacyResize(h, b, p) {
  let nb = b.slice();
  if (h === 0) nb = [p.x, p.y, b[2], b[3]];
  else if (h === 1) nb = [b[0], p.y, b[2], b[3]];
  else if (h === 2) nb = [b[0], p.y, p.x, b[3]];
  else if (h === 3) nb = [b[0], b[1], p.x, b[3]];
  else if (h === 4) nb = [b[0], b[1], p.x, p.y];
  else if (h === 5) nb = [b[0], b[1], b[2], p.y];
  else if (h === 6) nb = [p.x, p.y, b[2], b[3]].map((v, k) => (k % 2 === 0 ? Math.min(p.x, b[2]) : Math.min(p.y, b[3])));
  else if (h === 7) nb = [p.x, b[1], b[2], b[3]];
  if (h === 6) nb = [p.x, b[1], b[2], b[3]];
  if (h === 0) nb = [p.x, p.y, b[2], b[3]];
  return normalizeRect(nb);
}

const eq = (a, b) => a.length === b.length && a.every((v, k) => Math.abs(v - b[k]) < 1e-9);
const show = (a) => `[${a.join(', ')}]`;

function run(label, fn) {
  const bad = [];
  for (let h = 0; h < 8; h++) {
    const got = fn(h, ORIG, P);
    if (!eq(got, EXPECT[h])) bad.push({ h, got });
  }
  console.log(`\n=== ${label} ===`);
  for (let h = 0; h < 8; h++) {
    const got = fn(h, ORIG, P);
    const ok = eq(got, EXPECT[h]);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${String(h)} ${NAMES[h].padEnd(12)} expect ${show(EXPECT[h])}  got ${show(got)}`);
  }
  return bad;
}

const legacyBad = run('LEGACY (pre-fix tools.js logic)', legacyResize);
const fixedBad = run('FIXED (src/renderer/js/geometry.js)', resizeRect);

// Crossing: dragging the right handle past the left edge must normalise, not invert.
const cross = resizeRect(3, ORIG, { x: 50, y: 300 });
const crossOk = eq(cross, [50, 200, 100, 400]);
console.log(`\n=== edge case: right handle dragged past left edge ===`);
console.log(`  ${crossOk ? 'PASS' : 'FAIL'}  expect [50, 200, 100, 400]  got ${show(cross)}`);

console.log(`\nlegacy mishandled ${legacyBad.length}/8 handles; fixed mishandled ${fixedBad.length}/8`);

if (legacyBad.length === 0) {
  console.error('\nTEST FILE IS NOT DISCRIMINATING: the legacy logic passed, so these assertions prove nothing.');
  process.exit(2);
}
if (fixedBad.length > 0 || !crossOk) {
  console.error('\nFAILED: fixed geometry does not match expected handle behaviour.');
  process.exit(1);
}
console.log('\nOK: all 8 handles correct, crossing normalised, legacy logic proven wrong.');
