/**
 * Verifies that the browser-facing vendor bundles exist where the local
 * static server expects them. The renderer loads pdf.js and pdf-lib straight
 * out of node_modules as self-contained ESM bundles, so there is no build
 * step — this script just fails loudly if a dependency layout changes.
 */
const fs = require('fs');
const path = require('path');

const NM = path.resolve(__dirname, '..', 'node_modules');
const REQUIRED = [
  ['@cantoo/pdf-lib', 'dist/pdf-lib.esm.min.js'],
  ['pdfjs-dist', 'build/pdf.min.mjs'],
  ['pdfjs-dist', 'build/pdf.worker.min.mjs'],
  ['pdfjs-dist', 'cmaps'],
  ['pdfjs-dist', 'standard_fonts'],
  // OCR + fontkit (served locally by src/main/server.js under /v/…)
  ['tesseract.js', 'dist/tesseract.min.js'],
  ['tesseract.js', 'dist/worker.min.js'],
  ['tesseract.js-core', 'tesseract-core-simd-lstm.wasm.js'],
  // Load order matters: regenerator-runtime defines the global fontkit's
  // complex-script shaping path expects. See src/main/server.js.
  ['regenerator-runtime', 'runtime.js'],
  ['@pdf-lib/fontkit', 'dist/fontkit.umd.min.js'],
];

let missing = 0;
for (const [pkg, rel] of REQUIRED) {
  const p = path.join(NM, pkg, rel);
  const ok = fs.existsSync(p);
  console.log(`${ok ? 'ok  ' : 'MISS'} ${pkg}/${rel}`);
  if (!ok) missing++;
}
if (missing) {
  console.error(`\n${missing} vendor file(s) missing — run: npm install`);
  process.exit(1);
}
console.log('\nVendor bundles ready.');
