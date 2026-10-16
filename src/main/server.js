/**
 * Tiny static file server bound to 127.0.0.1 on an ephemeral port.
 *
 * The renderer is served over HTTP (never file://) so that native ES modules,
 * import.meta and the pdf.js Web Worker all behave exactly as they do on the
 * web — no CORS/opaque-origin surprises, no bundler required.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const NM = path.join(ROOT, 'node_modules');
// OCR language packs live in vendor/tessdata in dev and are copied to
// resources/tessdata by electron-builder's extraResources in the packaged
// app, so "offline OCR" stays offline after install.
const TESSDATA_DIR = (process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'tessdata')))
  ? path.join(process.resourcesPath, 'tessdata')
  : path.join(ROOT, 'vendor', 'tessdata');

/**
 * Locate the Tesseract WASM core.
 *
 * It is a *transitive* dependency (tesseract.js -> tesseract.js-core). npm
 * hoists it to node_modules/tesseract.js-core, but electron-builder rebuilds
 * the production tree from package.json and keeps nested packages nested, so
 * in the packaged asar the core sits at
 * node_modules/tesseract.js/node_modules/tesseract.js-core. Serving only the
 * hoisted path made every OCR run in the installed app die with
 * "importScripts … /v/tesscore/tesseract-core-simd-lstm.wasm.js failed to load",
 * because /v/tesscore/ resolved to a directory that does not exist there.
 *
 * Resolve whichever layout is actually present, and keep vendor/tesscore as an
 * escape hatch for a hand-placed copy.
 */
const TESSCORE_DIR = [
  path.join(NM, 'tesseract.js-core'),
  path.join(NM, 'tesseract.js', 'node_modules', 'tesseract.js-core'),
  path.join(ROOT, 'vendor', 'tesscore'),
].find((dir) => fs.existsSync(path.join(dir, 'tesseract-core-simd-lstm.wasm.js'))) || null;

/** True when `child` is `parent` or lives inside it. */
function isUnder(child, parent) {
  return child === parent || child.startsWith(parent + path.sep);
}

/**
 * Roots the server may read from. Everything under ROOT (src, renderer,
 * node_modules, vendor) plus any vendor directory that lives *outside* ROOT —
 * which in the packaged app means the extraResources copy under resources/.
 * The guard still rejects traversal escapes such as /v/tesscore/../../.. .
 */
const ALLOWED_ROOTS = [ROOT, ...[TESSDATA_DIR, TESSCORE_DIR].filter((d) => d && !isUnder(d, ROOT))];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.traineddata': 'application/octet-stream',
};

/** Virtual prefixes -> real directories (used for pdf.js assets + vendors). */
const VENDOR = [
  ['/v/pdf.min.mjs', path.join(NM, 'pdfjs-dist', 'build', 'pdf.min.mjs')],
  ['/v/pdf.worker.min.mjs', path.join(NM, 'pdfjs-dist', 'build', 'pdf.worker.min.mjs')],
  ['/v/pdf-lib.js', path.join(NM, '@cantoo', 'pdf-lib', 'dist', 'pdf-lib.esm.min.js')],
  // OCR (Tesseract.js) + fontkit — served locally so OCR works offline
  // (only the language packs come from the CDN, and those are cached).
  ['/v/tesseract.min.js', path.join(NM, 'tesseract.js', 'dist', 'tesseract.min.js')],
  ['/v/tesseract-worker.min.js', path.join(NM, 'tesseract.js', 'dist', 'worker.min.js')],
  // The UMD fontkit build, because it is the only self-contained one. Neither
  // @pdf-lib/fontkit's ESM nor @cantoo/fontkit's browser builds work here: they
  // import bare specifiers (restructure, brotli, dfa, fflate), two of which
  // ship CJS only, and this renderer has no bundler and no import map.
  // regenerator-runtime must load first — fontkit's GSUB path was transpiled
  // expecting that global, and without it every complex-script font (Devanagari,
  // Arabic, Indic) throws "regeneratorRuntime is not defined" on embed.
  ['/v/regenerator-runtime.js', path.join(NM, 'regenerator-runtime', 'runtime.js')],
  ['/v/fontkit.umd.min.js', path.join(NM, '@pdf-lib', 'fontkit', 'dist', 'fontkit.umd.min.js')],
];

const VENDOR_DIRS = [
  ['/v/cmaps/', path.join(NM, 'pdfjs-dist', 'cmaps')],
  ['/v/stdfonts/', path.join(NM, 'pdfjs-dist', 'standard_fonts')],
  ['/v/icc/', path.join(NM, 'pdfjs-dist', 'icc')],
  // null until TESSCORE_DIR lands — resolve() falls through to a 404, which the
  // renderer surfaces as a clear "OCR assets missing" error via /__ocr-health.
  ...(TESSCORE_DIR ? [['/v/tesscore/', TESSCORE_DIR]] : []),
  // Language packs live in the project, not the CDN, so "offline OCR" means
  // offline: no network hop is involved in recognising a page.
  ['/v/tessdata/', TESSDATA_DIR],
];

/** Where the offline OCR assets actually resolved — surfaced to the renderer
 *  over /__ocr-health so a packaging mistake reads as a diagnosis, not as a
 *  cryptic importScripts NetworkError from inside the worker. */
function ocrHealth() {
  return {
    ok: !!TESSCORE_DIR && fs.existsSync(TESSDATA_DIR),
    tesscore: TESSCORE_DIR,
    tesscorePresent: !!TESSCORE_DIR,
    tessdata: TESSDATA_DIR,
    tessdataExists: fs.existsSync(TESSDATA_DIR),
    roots: ALLOWED_ROOTS,
  };
}

function resolve(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  if (clean === '/' || clean === '') return path.join(RENDERER, 'index.html');
  if (clean === '/__ocr-health') return '__ocr-health';

  for (const [prefix, target] of VENDOR) {
    if (clean === prefix) return target;
  }
  for (const [prefix, dir] of VENDOR_DIRS) {
    if (clean.startsWith(prefix)) return path.join(dir, clean.slice(prefix.length));
  }
  if (clean.startsWith('/v/')) return null;
  return path.join(RENDERER, clean.replace(/^\/+/, ''));
}

function send(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function streamFile(req, res, file) {
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found');
    const mtime = st.mtime.toUTCString();
    // no-cache + Last-Modified: the client may cache, but must revalidate —
    // a cheap 304 for unchanged files instead of re-downloading multi-MB
    // vendor bundles (the Tesseract WASM core is ~4 MB) on every OCR run.
    const ims = req.headers['if-modified-since'];
    if (ims && ims === mtime) {
      res.writeHead(304, {
        'Content-Type': type,
        'Cache-Control': 'no-cache',
        'Last-Modified': mtime,
      });
      return res.end();
    }
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
      'Last-Modified': mtime,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(file).pipe(res);
  });
}

async function start() {
  const server = http.createServer((req, res) => {
    const file = resolve(req.url || '/');
    if (file === '__ocr-health') {
      return send(res, 200, JSON.stringify(ocrHealth()), 'application/json; charset=utf-8');
    }
    if (!file) return send(res, 404, 'Not found');
    // Traversal guard: everything must live under one of the allowed roots.
    // ROOT covers src/renderer/node_modules/vendor; the extra roots cover the
    // electron-builder extraResources copy under resources/, which sits OUTSIDE
    // app.asar and used to be rejected with 403 in the packaged app.
    const abs = path.resolve(file);
    if (!ALLOWED_ROOTS.some((r) => isUnder(abs, r))) return send(res, 403, 'Forbidden');
    streamFile(req, res, abs);
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const health = ocrHealth();
  if (!health.ok) {
    console.warn(`[AiPDF] offline OCR assets incomplete: core=${health.tesscorePresent ? 'ok' : 'MISSING'} tessdata=${health.tessdataExists ? 'ok' : 'MISSING'}`);
  }
  return { port, server, url: `http://127.0.0.1:${port}/index.html`, ocr: health };
}

module.exports = { start };
