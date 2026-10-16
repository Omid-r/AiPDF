#!/usr/bin/env node
/**
 * Verifies the system-font index against the fonts actually installed on this
 * machine, which is the only input that can catch real-world filename and
 * name-table weirdness (double spaces, trailing spaces before the extension,
 * uppercase extensions, Mac vs Windows name records).
 *
 *   node scripts/fontindex-test.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { buildFontIndex, defaultDirs, readFontInfo, parseTableDirectory } = require(path.join(ROOT, 'src', 'main', 'fontindex.js'));

const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const dirs = defaultDirs(process.env, process.platform);
check('resolved font directories', dirs.length > 0, dirs.join(' | ') || 'none');

const t0 = Date.now();
const { faces, skippedCollections } = buildFontIndex(dirs);
const ms = Date.now() - t0;

check('indexed a substantial number of faces', faces.length > 50, `${faces.length} faces in ${ms}ms`);
check('index build is fast enough to cache on demand', ms < 8000, `${ms}ms`);
check('.ttc collections are counted, not silently dropped', skippedCollections > 0, `${skippedCollections} collection files skipped`);

// Every family must be a usable label: non-empty, no control characters.
const bad = faces.filter((f) => !f.family || /[\u0000-\u001f\u007f]/.test(f.family));
check('all family names are clean printable strings', bad.length === 0, bad.length ? `BAD: ${bad.slice(0, 3).map((f) => JSON.stringify(f.family)).join(' ')}` : `${faces.length} names`);

// The name table must be resolving real families, not falling back to filenames.
const known = ['Arial', 'Times New Roman', 'Courier New', 'Calibri', 'Segoe UI', 'Consolas'];
const hits = known.filter((k) => faces.some((f) => f.family === k));
check('recognised system families resolve by name', hits.length >= 3, `found: ${hits.join(', ') || 'none'}`);

// Styles should be distinct per face, and a family should have several styles.
const byFamily = new Map();
for (const f of faces) byFamily.set(f.family, (byFamily.get(f.family) || 0) + 1);
const multi = [...byFamily.entries()].filter(([, n]) => n > 1);
check('families expose multiple styles', multi.length > 5, `${byFamily.size} families, ${multi.length} with >1 style`);

// A collection file must be reported as such rather than mis-parsed.
const ttc = dirs.length ? null : null;
const sample = faces[0];
if (sample) {
  const info = readFontInfo(sample.file);
  check('re-reading a single file is stable', info && info.family === sample.family, `${sample.file.split(/[\\/]/).pop()} -> ${info && info.family}`);
}

const head = { collection: 'ttcf' };
const dir = parseTableDirectory(Buffer.concat([Buffer.from('ttcf'), Buffer.alloc(32)]));
check('collection signature is detected', !!dir && dir.collection === true, JSON.stringify(dir && { collection: dir.collection }));

console.log(`\nFONTINDEX_${results.every(Boolean) ? 'PASS' : 'FAIL'} ${results.filter(Boolean).length}/${results.length}`);
process.exit(results.every(Boolean) ? 0 : 1);
