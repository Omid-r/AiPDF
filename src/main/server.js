/** Local-only static server for AiPDF's ES-module renderer and bundled assets. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { under, requestAllowed } = require('./http-policy.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const NM = path.join(ROOT, 'node_modules');
const TESSDATA_DIR = process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'tessdata'))
  ? path.join(process.resourcesPath, 'tessdata') : path.join(ROOT, 'vendor', 'tessdata');
const TESSCORE_DIR = [
  path.join(NM, 'tesseract.js-core'),
  path.join(NM, 'tesseract.js', 'node_modules', 'tesseract.js-core'),
  path.join(ROOT, 'vendor', 'tesscore'),
].find(dir => fs.existsSync(path.join(dir, 'tesseract-core-simd-lstm.wasm.js'))) || null;

const MIME = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.mjs':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml',
  '.png':'image/png', '.jpg':'image/jpeg', '.woff':'font/woff', '.woff2':'font/woff2',
  '.ttf':'font/ttf', '.otf':'font/otf', '.ico':'image/x-icon',
  '.map':'application/json; charset=utf-8', '.bcmap':'application/octet-stream',
  '.pfb':'application/octet-stream', '.wasm':'application/wasm',
  '.traineddata':'application/octet-stream',
};
const VENDOR = [
  ['/v/pdf.min.mjs', path.join(NM, 'pdfjs-dist', 'build', 'pdf.min.mjs')],
  ['/v/pdf.worker.min.mjs', path.join(NM, 'pdfjs-dist', 'build', 'pdf.worker.min.mjs')],
  ['/v/pdf-lib.js', path.join(NM, '@cantoo', 'pdf-lib', 'dist', 'pdf-lib.esm.min.js')],
  ['/v/tesseract.min.js', path.join(NM, 'tesseract.js', 'dist', 'tesseract.min.js')],
  ['/v/tesseract-worker.min.js', path.join(NM, 'tesseract.js', 'dist', 'worker.min.js')],
  ['/v/regenerator-runtime.js', path.join(NM, 'regenerator-runtime', 'runtime.js')],
  ['/v/fontkit.umd.min.js', path.join(NM, '@pdf-lib', 'fontkit', 'dist', 'fontkit.umd.min.js')],
];
const VENDOR_DIRS = [
  ['/v/cmaps/', path.join(NM, 'pdfjs-dist', 'cmaps')],
  ['/v/stdfonts/', path.join(NM, 'pdfjs-dist', 'standard_fonts')],
  ['/v/icc/', path.join(NM, 'pdfjs-dist', 'icc')],
  ...(TESSCORE_DIR ? [['/v/tesscore/', TESSCORE_DIR]] : []),
  ['/v/tessdata/', TESSDATA_DIR],
];

function ocrHealth() {
  return {
    ok: !!TESSCORE_DIR && fs.existsSync(TESSDATA_DIR),
    tesscore: TESSCORE_DIR, tesscorePresent: !!TESSCORE_DIR,
    tessdata: TESSDATA_DIR, tessdataExists: fs.existsSync(TESSDATA_DIR),
    roots: [ROOT, ...[TESSDATA_DIR, TESSCORE_DIR].filter(dir => dir && !under(dir, ROOT))],
  };
}

function resolveRoute(raw) {
  const clean = decodeURIComponent(raw.split('?')[0].split('#')[0]);
  if (clean.includes('\0') || clean.includes('\\')) throw new Error('Invalid path');
  if (clean === '/__ocr-health') return 'health';
  if (clean === '/' || clean === '') return { file: path.join(RENDERER, 'index.html'), root: RENDERER };
  for (const [prefix, target] of VENDOR) {
    if (clean === prefix) return { file: target, root: path.dirname(target) };
  }
  for (const [prefix, dir] of VENDOR_DIRS) {
    if (clean.startsWith(prefix)) return { file: path.join(dir, clean.slice(prefix.length)), root: dir };
  }
  if (clean.startsWith('/v/')) return null;
  return { file: path.join(RENDERER, clean.replace(/^\/+/, '')), root: RENDERER };
}

function send(req, res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, {
    'Content-Type': type, 'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Length': Buffer.byteLength(body), ...extra,
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function streamFile(req, res, file) {
  fs.stat(file, (error, stat) => {
    if (res.destroyed) return;
    if (error || !stat.isFile()) return send(req, res, 404, 'Not found');
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const headers = {
      'Content-Type': type, 'Cache-Control': 'no-cache',
      'Last-Modified': stat.mtime.toUTCString(), 'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
    };
    if (req.headers['if-modified-since'] === headers['Last-Modified']) {
      res.writeHead(304, headers);
      return res.end();
    }
    res.writeHead(200, { ...headers, 'Content-Length': stat.size });
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });
}

async function start() {
  const server = http.createServer((req, res) => {
    if (!requestAllowed(req, server.address().port)) return send(req, res, 403, 'Forbidden');
    if (!['GET', 'HEAD'].includes(req.method)) return send(req, res, 405, 'Method not allowed', undefined, { Allow: 'GET, HEAD' });
    if ((req.url || '').length > 8192) return send(req, res, 414, 'URL too long');
    let route;
    try { route = resolveRoute(req.url || '/'); }
    catch { return send(req, res, 400, 'Malformed URL'); }
    if (route === 'health') return send(req, res, 200, JSON.stringify(ocrHealth()), 'application/json; charset=utf-8');
    if (!route) return send(req, res, 404, 'Not found');
    const file = path.resolve(route.file);
    if (!under(file, route.root)) return send(req, res, 403, 'Forbidden');
    // Validate both lexical and real paths; each request is confined to its own
    // route root, not the whole application directory. Not a defense against
    // same-user malware changing filesystem links during the subsequent read.
    Promise.all([fs.promises.realpath(file), fs.promises.realpath(route.root)]).then(([realFile, realRoot]) => {
      if (res.destroyed) return;
      if (!under(realFile, realRoot)) return send(req, res, 403, 'Forbidden');
      streamFile(req, res, realFile);
    }).catch(() => { if (!res.headersSent && !res.destroyed) send(req, res, 404, 'Not found'); else res.destroy(); });
  });
  await new Promise((resolve, reject) => {
    const onError = error => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', onError); resolve(); });
  });
  const port = server.address().port;
  const health = ocrHealth();
  if (!health.ok) console.warn(`[AiPDF] offline OCR assets incomplete: core=${health.tesscorePresent ? 'ok' : 'MISSING'} tessdata=${health.tessdataExists ? 'ok' : 'MISSING'}`);
  return { port, server, url: `http://127.0.0.1:${port}/index.html`, ocr: health };
}
module.exports = { start };
