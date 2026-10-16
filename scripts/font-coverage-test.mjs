/**
 * Coverage-gate regression test for the Direct Editor font fix (spec §2.1).
 *
 * Runs in plain Node. It exists because the defect it guards against was
 * invisible to every prior test: pdf-lib's Standard-14 encodeText() does not
 * throw when a character is missing, it writes 0x3F. A test that only checks
 * "save did not error" passes while the file fills with question marks.
 *
 * Usage: node scripts/font-coverage-test.mjs [windowsFontsDir]
 */
import { readFileSync, existsSync } from 'node:fs';
import { winAnsiMissing, embeddedFontMissing } from '../src/renderer/js/fontresolve.js';

const FONTS_DIR = process.argv[2] || 'C:/Windows/Fonts';
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

console.log('Standard-14 (WinAnsi) coverage');

// Each of these was measured against a real saved content stream: the ones
// marked corrupting produced literal 0x3F bytes in the file.
const CORRUPTING = { Devanagari: '\u0928\u092e\u0938\u094d\u0924\u0947', Arabic: '\u0645\u0631\u062d\u0628\u0627', CJK: '\u4e2d\u6587', Rupee: '\u20b9' };
const SAFE = { 'ASCII': 'Hello world 123', 'Latin-1': 'caf\u00e9 na\u00efve \u00a9\u00ae', 'CP1252 punctuation': '\u2014 \u2013 \u2022 \u201csmart\u201d \u20ac' };

for (const [label, text] of Object.entries(CORRUPTING)) {
  const missing = winAnsiMissing(text);
  check(`${label} is flagged as uncovered`, missing.length > 0, `got ${JSON.stringify(missing)}`);
}
for (const [label, text] of Object.entries(SAFE)) {
  const missing = winAnsiMissing(text);
  check(`${label} passes clean`, missing.length === 0, `unexpected ${JSON.stringify(missing)}`);
}
check('missing list is deduplicated', winAnsiMissing('\u4e2d\u4e2d\u4e2d').length === 1);
check('empty text has no gaps', winAnsiMissing('').length === 0);
check('newlines are not gaps', winAnsiMissing('a\nb\r\nc').length === 0);

console.log('\nEmbedded font coverage (fontkit cmap)');

const fontkitPath = new URL('../node_modules/@cantoo/fontkit/dist/main.cjs', import.meta.url);
let fontkit = null;
if (existsSync(fontkitPath)) {
  const mod = await import(fontkitPath.href);
  fontkit = mod.default ?? mod;
} else {
  console.log('  skip  @cantoo/fontkit not installed');
}

if (fontkit) {
  const find = (n) => { const p = `${FONTS_DIR}/${n}`; return existsSync(p) ? readFileSync(p) : null; };
  const arial = find('arial.ttf');
  const devanagariFace = find('mangal.ttf') || find('Nirmala.ttf') || find('NotoSansDevanagari-Regular.ttf');

  if (arial) {
    const m = await embeddedFontMissing(new Uint8Array(arial), '\u0928\u092e\u0938\u094d\u0924\u0947', fontkit);
    check('Arial reports Devanagari as missing', Array.isArray(m) && m.length === 6, `got ${JSON.stringify(m)}`);
    const ok = await embeddedFontMissing(new Uint8Array(arial), 'Hello \u2014 world', fontkit);
    check('Arial covers Latin + em-dash', Array.isArray(ok) && ok.length === 0, `got ${JSON.stringify(ok)}`);
  } else console.log('  skip  arial.ttf not found');

  if (devanagariFace) {
    const m = await embeddedFontMissing(new Uint8Array(devanagariFace), '\u0928\u092e\u0938\u094d\u0924\u0947', fontkit);
    check('a Devanagari face covers Devanagari', Array.isArray(m) && m.length === 0, `got ${JSON.stringify(m)}`);
  } else console.log('  skip  no Devanagari-capable system font found');

  check('unparseable bytes return null, not "covered"',
    (await embeddedFontMissing(new Uint8Array([1, 2, 3, 4]), 'abc', fontkit)) === null);
  check('missing bytes return null', (await embeddedFontMissing(null, 'abc', fontkit)) === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
