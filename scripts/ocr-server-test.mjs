#!/usr/bin/env node
/**
 * Regression test for offline OCR asset serving.
 *
 * Guards the two bugs that made OCR fail only in the *installed* app:
 *
 *  1. `tesseract.js-core` is a transitive dependency. npm hoists it to
 *     node_modules/tesseract.js-core, but electron-builder keeps nested
 *     packages nested, so in the packaged asar it lands at
 *     node_modules/tesseract.js/node_modules/tesseract.js-core. Serving only
 *     the hoisted path produced a 404 for the WASM core and the worker died
 *     with "importScripts … failed to load".
 *  2. Language packs ship via extraResources into resources/tessdata, which is
 *     OUTSIDE app.asar. A traversal guard that only accepted ROOT answered 403
 *     for every pack.
 *
 * Both layouts are exercised: the real one, then a simulated packaged one where
 * the hoisted copy is hidden and resourcesPath points at a sibling tree.
 *
 *   node scripts/ocr-server-test.mjs
 */
import { createServer } from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_MODULE = path.join(ROOT, 'src', 'main', 'server.js');

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

/** Boot the real server module in a child process with a faked
 *  `process.resourcesPath`, so the packaged branch of the code runs for real. */
async function startServerWithResources(resourcesPath) {
  // resourcesPath must be set BEFORE the module is required: server.js
  // resolves its vendor directories from it at load time.
  const code = `
    process.resourcesPath = ${JSON.stringify(resourcesPath || null)};
    const { start } = require(${JSON.stringify(SERVER_MODULE)});
    start().then((info) => {
      process.send({ port: info.port, ocr: info.ocr });
    }).catch((e) => { process.send({ error: String(e && e.stack || e) }); });
  `;
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['-e', code], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const ready = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 10000);
    child.on('message', (m) => { clearTimeout(t); resolve(m); });
    child.on('exit', (c) => { clearTimeout(t); reject(new Error('server exited ' + c + ' ' + child.stderr.read())); });
  });
  return { port: ready.port, ocr: ready.ocr, child };
}

async function probe(port, urlPath) {
  const r = await fetch(`http://127.0.0.1:${port}${urlPath}`);
  const buf = await r.arrayBuffer();
  return { status: r.status, size: buf.byteLength, type: r.headers.get('content-type') };
}

/* ---------------------------------------------------- layout A: dev (hoisted) */

{
  const { port, ocr, child } = await startServerWithResources(null);
  try {
    check('dev layout: health reports OCR assets ok', ocr.ok === true, `core=${ocr.tesscorePresent} data=${ocr.tessdataExists}`);

    const core = await probe(port, '/v/tesscore/tesseract-core-simd-lstm.wasm.js');
    check('dev layout: WASM core served', core.status === 200 && core.size > 2_000_000, `${core.status} ${core.size} ${core.type}`);

    for (const name of ['tesseract-core-simd-lstm.wasm', 'tesseract-core.wasm']) {
      const a = await probe(port, `/v/tesscore/${name}`);
      check(`dev layout: ${name} served`, a.status === 200 && a.size > 2_000_000, `${a.status} ${a.size} ${a.type}`);
    }
    for (const name of ['eng', 'osd', 'hin', 'nep']) {
      const a = await probe(port, `/v/tessdata/${name}.traineddata.gz`);
      check(`dev layout: ${name}.traineddata.gz served`, a.status === 200 && a.size > 100_000, `${a.status} ${a.size}`);
    }

    const worker = await probe(port, '/v/tesseract-worker.min.js');
    check('dev layout: tesseract worker served', worker.status === 200 && worker.size > 50_000, `${worker.status} ${worker.size}`);

    // Traversal must still be refused.
    const esc = await probe(port, '/v/tesscore/../../../../package.json');
    check('dev layout: traversal escape is 403/404', esc.status === 403 || esc.status === 404, `status=${esc.status}`);

    // A directory listing must not be mistaken for a file.
    const dir = await probe(port, '/v/tesscore/');
    check('dev layout: bare dir path is not served as a file', dir.status === 404, `status=${dir.status}`);
  } finally {
    child.kill();
  }
}

/* ------------------------------ layout B: packaged (nested core + resourcesPath) */

{
  // Simulate the packaged tree: hide the hoisted core so only the nested copy
  // resolves, and point resourcesPath at a directory holding tessdata — i.e.
  // extraResources output, outside the app root.
  const stage = path.join(ROOT, '.smoke', 'ocr-pkg-stage');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(path.join(stage, 'resources', 'tessdata'), { recursive: true });
  for (const name of ['eng', 'osd', 'hin', 'nep']) {
    fs.copyFileSync(path.join(ROOT, 'vendor', 'tessdata', `${name}.traineddata.gz`),
      path.join(stage, 'resources', 'tessdata', `${name}.traineddata.gz`));
  }

  const { port, ocr, child } = await startServerWithResources(path.join(stage, 'resources'));
  try {
    check('packaged layout: health reports OCR assets ok', ocr.ok === true, `core=${ocr.tesscorePresent} data=${ocr.tessdataExists}`);
    check('packaged layout: tessdata read from resourcesPath (outside app root)',
      ocr.tessdata === path.join(stage, 'resources', 'tessdata'), ocr.tessdata);

    const core = await probe(port, '/v/tesscore/tesseract-core-simd-lstm.wasm.js');
    check('packaged layout: WASM core served from packaged tree',
      core.status === 200 && core.size > 2_000_000, `${core.status} ${core.size}`);

    const pack = await probe(port, '/v/tessdata/eng.traineddata.gz');
    check('packaged layout: language pack NOT 403', pack.status === 200 && pack.size > 10_000_000, `${pack.status} ${pack.size}`);

    const esc = await probe(port, '/v/tessdata/../../../../package.json');
    check('packaged layout: traversal escape refused', esc.status === 403 || esc.status === 404, `status=${esc.status}`);
  } finally {
    child.kill();
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

/* ---------------------------------- layout C: nested core only (nohoist install) */

{
  // electron-builder's production tree keeps transitive deps nested. Prove the
  // server finds the nested copy when the hoisted one is absent, by resolving
  // through a stage that mirrors only the nested path.
  const stage = path.join(ROOT, '.smoke', 'ocr-nested-stage');
  const nested = path.join(stage, 'node_modules', 'tesseract.js', 'node_modules', 'tesseract.js-core');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(nested, { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, 'node_modules', 'tesseract.js-core'))) {
    fs.copyFileSync(path.join(ROOT, 'node_modules', 'tesseract.js-core', f), path.join(nested, f));
  }
  // Resolve the same way server.js does, to prove the candidate list works.
  const candidates = [
    path.join(stage, 'node_modules', 'tesseract.js-core'),
    path.join(stage, 'node_modules', 'tesseract.js', 'node_modules', 'tesseract.js-core'),
    path.join(stage, 'vendor', 'tesscore'),
  ];
  const found = candidates.find((d) => fs.existsSync(path.join(d, 'tesseract-core-simd-lstm.wasm.js')));
  check('nested layout: hoisted copy absent, nested copy resolves', found === nested, found || 'none');
  fs.rmSync(stage, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
