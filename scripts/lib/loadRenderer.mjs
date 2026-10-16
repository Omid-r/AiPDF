/**
 * Import a renderer module in plain Node for unit tests.
 *
 * The renderer runs in the browser, where the local static server exposes
 * pdf.js and pdf-lib under virtual `/v/…` paths (src/main/server.js) and every
 * module is fetched over HTTP, so relative specifiers just work. Node has no
 * such server, so `import * as PL from '/v/pdf-lib.js'` fails and a naive copy
 * of the module also breaks its `./viewer.js` imports.
 *
 * This loader walks the module's relative import graph, rewrites both the
 * virtual `/v/…` specifiers and the relative ones so everything lands in one
 * flat directory, and imports that. Module behaviour is untouched — only the
 * dependency roots change.
 *
 *   import { loadRenderer } from './lib/loadRenderer.mjs';
 *   const pw = await loadRenderer('pdfwrite.js');
 *   const out = await pw.buildPdf(model, {});
 */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
export const NM = path.join(ROOT, 'node_modules');
const JS_DIR = path.join(ROOT, 'src', 'renderer', 'js');
const CACHE_DIR = path.join(ROOT, '.smoke', 'node-linked');

/** Virtual prefix -> real file (must mirror src/main/server.js). */
const VENDOR = {
  '/v/pdf-lib.js': path.join(NM, '@cantoo', 'pdf-lib', 'dist', 'pdf-lib.esm.min.js'),
  '/v/pdf.min.mjs': path.join(NM, 'pdfjs-dist', 'build', 'pdf.min.mjs'),
  '/v/pdf.worker.min.mjs': path.join(NM, 'pdfjs-dist', 'build', 'pdf.worker.min.mjs'),
};

/** POSIX-style file:// URL for a Windows path (ESM needs forward slashes). */
function fileUrl(p) {
  return 'file:///' + p.replace(/\\/g, '/').replace(/^\/+/, '');
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** All static import/dynamic-import specifiers in a source string. */
function specifiers(src) {
  const found = [];
  const re = /(?:import\s[^'"]*from\s*|import\s*\(\s*|export\s[^'"]*from\s*)['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) found.push(m[1]);
  return found;
}

/**
 * Rewrite a module's dependencies.
 * `.js` specifiers local to the renderer become flat `./name.js` inside the
 * cache; anything else (npm packages) is left alone for Node to resolve —
 * except the virtual `/v/…` prefixes, which get real paths.
 */
function rewrite(src, absPath) {
  let out = src;
  for (const [vprefix, target] of Object.entries(VENDOR)) {
    out = out.split(`'${vprefix}'`).join(`'${fileUrl(target)}'`);
    out = out.split(`"${vprefix}"`).join(`"${fileUrl(target)}"`);
  }
  const dir = path.dirname(absPath);
  for (const spec of specifiers(src)) {
    if (spec.startsWith('/') || spec.startsWith('node:') || !spec.startsWith('.')) continue;
    if (/\.(js|mjs|json)$/.test(spec) === false) continue;
    const target = path.resolve(dir, spec);
    const flat = './' + path.basename(target);
    out = out.split(`'${spec}'`).join(`'${flat}'`);
    out = out.split(`"${spec}"`).join(`"${flat}"`);
  }
  return out;
}

const written = new Set();

/** Copy one module (and everything it imports) into the flat cache dir. */
async function bundle(absPath) {
  const flatName = path.basename(absPath);
  const outPath = path.join(CACHE_DIR, flatName);
  if (written.has(flatName)) return;
  written.add(flatName);

  let src = await readFile(absPath, 'utf8');
  src = rewrite(src, absPath);
  await writeFile(outPath, src, 'utf8');

  for (const spec of specifiers(src)) {
    if (!spec.startsWith('.')) continue;
    if (!/\.(js|mjs)$/.test(spec)) continue;
    await bundle(path.resolve(path.dirname(absPath), spec));
  }
}

/**
 * Load one renderer module (filename under src/renderer/js), bundling its local
 * dependencies. Pass a fresh `key` to bust Node's ESM cache between test runs.
 */
export async function loadRenderer(name, opts = {}) {
  await mkdir(CACHE_DIR, { recursive: true });
  await bundle(path.join(JS_DIR, name));
  const entry = path.join(CACHE_DIR, path.basename(name));
  return import(fileUrl(entry) + (opts.fresh ? `?t=${Date.now()}` : ''));
}

/** Remove the cache so the next load re-reads the current source files. */
export async function clearRendererCache() {
  await rm(CACHE_DIR, { recursive: true, force: true });
}
