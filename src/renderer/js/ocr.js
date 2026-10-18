/**
 * OCR for flattened / scanned pages.
 *
 * Two engines sit behind one API:
 *
 *  - "tesseract" — Tesseract.js, fully local (English, Hindi, Nepali and
 *    mixed pairs). The engine, worker and WASM core are served from /v/…
 *    (see src/main/server.js); language packs download once from the CDN and
 *    are cached in IndexedDB.
 *  - "ai" — a vision model (Google Gemini natively, or any OpenAI-compatible
 *    provider) reads a high-DPI render of the page. This is dramatically
 *    better on low-quality scans, handwriting and complex layouts, and it
 *    uses the exact same provider stack as the assistant: base URL, API key,
 *    auth mode, custom headers and the model fetched from the provider.
 *  - "hybrid" (default) — AI when a provider is configured, Tesseract
 *    otherwise, with automatic fallback to Tesseract if the AI call fails.
 *
 * Recognition output is stored on the open document as
 * doc.ocr[pageIndex] = { text, confidence, langs, engine, at } —
 * viewer.getPageText() falls back to it, so AI/ask, the agent and search all
 * work on scans.
 */

/* Language packs are bundled in vendor/tessdata and served from /v/tessdata/,
 * so recognition never touches the network. The CDN stays only as a fallback
 * for a language that is not bundled. */
const TESSDATA_LOCAL = '/v/tessdata';
const TESSDATA_CDN = 'https://tessdata.projectnaptha.com/4.0.0';

/** Which packs are actually bundled — anything else has to come from the CDN. */
const BUNDLED = new Set(['eng', 'nep', 'hin', 'osd']);

import { settings, activeDoc } from './store.js';
import { aiReady, visionRequest } from './ai.js';
import { buildStructuredOcrLines } from './textblocks.js';
import { clamp } from './util.js';

export const OCR_LANGS = [
  { id: 'eng', label: 'English' },
  { id: 'nep', label: 'नेपाली (Nepali)' },
  { id: 'hin', label: 'हिन्दी (Hindi)' },
  { id: 'eng+nep', label: 'English + Nepali' },
  { id: 'eng+hin', label: 'English + Hindi' },
];

export const OCR_ENGINES = [
  { id: 'hybrid', label: 'Hybrid — AI first, local fallback' },
  { id: 'ai', label: 'AI vision (Gemini / OpenAI-compatible)' },
  { id: 'tesseract', label: 'Local Tesseract (offline)' },
];

/** Prompt for the vision models: plain-text transcription, layout-aware. */
const AI_OCR_PROMPT = `You are a precision OCR engine. Analyse this document page image and return ONLY a JSON object — no commentary, no markdown fences:
{"lines":[{"text":"...","bbox":{"x0":L,"y0":T,"x1":R,"y1":B}}],"tables":[{"cells":[{"row":0,"col":0,"text":"...","bbox":{"x0":L,"y0":T,"x1":R,"y1":B}}]}]}
Rules:
- bbox = that text's rectangle in THIS image's pixel coordinates (origin top-left, y grows down). Every line and every table cell needs one.
- lines = all text that is NOT inside a table, in reading order, with paragraph breaks as separate entries.
- tables: for EVERY table, one cell entry PER CELL — never one per row — each with its own bbox. Empty cells get an empty text but still a bbox.
- Transcribe numbers, dates, amounts and symbols exactly as printed. Best guess for unreadable words.`;

let T = null;            // Tesseract global
let worker = null;       // cached worker
let workerLangs = '';

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Failed to load ' + src));
    document.head.appendChild(s);
  });
}

async function getTesseract() {
  if (window.Tesseract) return window.Tesseract;
  await loadScript('/v/tesseract.min.js');
  if (!window.Tesseract) throw new Error('Tesseract failed to load');
  T = window.Tesseract;
  return T;
}

/**
 * Confirm the offline OCR assets are actually reachable before a worker is
 * created. The Tesseract worker imports its WASM core with importScripts, and a
 * 404 there surfaces from deep inside the worker as a bare
 * "NetworkError: Failed to execute 'importScripts'" — useless for diagnosis.
 * The main process knows where those files really are (see /__ocr-health in
 * src/main/server.js), so ask it first and report the resolved paths.
 */
async function assertOcrAssets(origin) {
  try {
    const r = await fetch(origin + '/__ocr-health');
    const h = await r.json();
    if (h && h.ok) return;
    throw new Error(
      'The bundled offline OCR files are missing or could not be located '
      + `(WASM core: ${h && h.tesscore ? 'not found' : h && h.tesscorePresent ? h.tesscore : 'missing'}, `
      + 'language packs: ' + (h && h.tessdataExists ? h.tessdata : 'missing') + '). '
      + 'Reinstall the application to restore them.'
    );
  } catch (e) {
    // The health probe itself failing (older build, transport error) must not
    // block OCR — fall through and let the worker report its own error.
    if (String(e && e.message).includes('offline OCR files are missing')) throw e;
  }
}

async function getWorker(langs, onProgress) {
  const t = await getTesseract();
  if (worker && workerLangs === langs) return worker;
  if (worker) { try { await worker.terminate(); } catch { /* ignore */ } worker = null; }
  const origin = location.origin;
  // Every requested language must be present locally; a single unbundled one
  // forces the whole set to the CDN, because Tesseract loads them together.
  const allBundled = String(langs || 'eng').split('+').every((l) => BUNDLED.has(l));
  const opts = {
    workerPath: origin + '/v/tesseract-worker.min.js',
    corePath: origin + '/v/tesscore',
    langPath: allBundled ? origin + TESSDATA_LOCAL : TESSDATA_CDN,
    logger: (m) => { if (onProgress) onProgress(m); },
  };
  await assertOcrAssets(origin);
  // Worker creation importScripts the ~4 MB WASM core over localhost. A
  // dropped connection surfaces as "NetworkError … importScripts … failed to
  // load"; one clean retry after tearing down the half-built worker recovers
  // from the transient case.
  try {
    worker = await t.createWorker(langs, 1, opts);
  } catch (e) {
    worker = null;
    console.warn('Tesseract worker creation failed, retrying once:', e);
    if (onProgress) onProgress({ status: 'restarting engine', progress: 0 });
    await new Promise((r) => setTimeout(r, 500));
    try {
      worker = await t.createWorker(langs, 1, opts);
    } catch (e2) {
      worker = null;
      throw new Error(`The local OCR engine could not load (${String(e2.message || e2).slice(0, 200)}). If this persists, reinstall the application to restore the bundled OCR files, or switch the OCR engine to "AI vision" in the OCR panel.`);
    }
  }
  workerLangs = langs;
  return worker;
}

/** Minimum text length below which a page is considered scanned/flattened. */
const SCANNED_THRESHOLD = 8;

/**
 * Flag pages that have (almost) no selectable text — the flattened-page
 * detection used by the competitors before offering OCR.
 */
export async function detectScannedPages(doc, onProgress) {
  const { getTextContent } = await import('./viewer.js');
  const scanned = new Set();
  for (let i = 0; i < doc.numPages; i++) {
    try {
      const tc = await getTextContent(i);
      const len = tc ? tc.items.reduce((n, it) => n + (it.str || '').trim().length, 0) : 0;
      if (len < SCANNED_THRESHOLD) scanned.add(i);
    } catch { scanned.add(i); }
    if (onProgress && i % 10 === 0) onProgress(i + 1, doc.numPages);
  }
  doc.scanned = scanned;
  doc.ocr = doc.ocr || {};
  return scanned;
}

export function isScanned(doc, i) {
  if (doc.scanned) return doc.scanned.has(i);
  return false;
}

/**
 * Which engine actually runs for the current settings. Hybrid picks AI when
 * the assistant is configured (base URL + key) and Tesseract otherwise.
 */
export function resolveOcrEngine() {
  const setting = (settings.ocr && settings.ocr.engine) || 'hybrid';
  if (setting === 'tesseract') return { engine: 'tesseract', setting };
  let aiUsable = false;
  try { aiUsable = aiReady(); } catch { aiUsable = false; }
  if (setting === 'ai') {
    if (!aiUsable) throw new Error('AI OCR is selected but no AI provider is configured — set one up in AI settings (Gemini or any OpenAI-compatible server).');
    return { engine: 'ai', setting };
  }
  return { engine: aiUsable ? 'ai' : 'tesseract', setting };
}

/** Human label for a stored OCR record ("AI gemini-2.5-flash" / "Tesseract 91%"). */
export function ocrEngineLabel(rec) {
  if (rec && rec.engine === 'ai') return `AI · ${rec.model || 'vision model'}`;
  return 'Tesseract (local)';
}

/**
 * Recognise one page with the configured engine. Resolves with the stored
 * record. `onProgress` receives { status, progress } updates.
 *
 * In Hybrid mode either engine can fall back to the other: AI vision failing
 * (bad key, quota, offline) drops to local Tesseract, and a local engine
 * failure (blocked localhost, corrupt worker) drops to AI vision when a
 * provider is configured — an OCR run should survive one broken path.
 */
export async function ocrPage(pageIndex, langs = 'eng', onProgress) {
  const { engine, setting } = resolveOcrEngine();
  try {
    if (engine === 'ai') return await ocrPageAI(pageIndex, langs, onProgress);
    return await ocrPageTesseract(pageIndex, langs, onProgress);
  } catch (e) {
    if (setting !== 'hybrid') throw e;
    if (engine === 'ai') {
      console.warn('AI OCR failed, falling back to Tesseract:', e);
      if (onProgress) onProgress({ status: 'AI failed — local fallback', progress: 0.1 });
      return ocrPageTesseract(pageIndex, langs, onProgress);
    }
    let aiUsable = false;
    try { aiUsable = aiReady(); } catch { aiUsable = false; }
    if (aiUsable) {
      console.warn('Tesseract OCR failed, falling back to AI vision:', e);
      if (onProgress) onProgress({ status: 'Local engine failed — AI fallback', progress: 0.1 });
      return ocrPageAI(pageIndex, langs, onProgress);
    }
    throw e;
  }
}

/** Local engine path (Tesseract, 200 DPI render). */
async function ocrPageTesseract(pageIndex, langs = 'eng', onProgress) {
  const { renderPageToCanvas } = await import('./viewer.js');
  const doc = activeDocRef();
  if (!doc) throw new Error('No document open');
  const canvas = await renderPageToCanvas(pageIndex, 200);
  return ocrCanvas(canvas, langs, onProgress, pageIndex, 200);
}

/**
 * AI engine path: render the page at high DPI and let the configured vision
 * model (Gemini or OpenAI-compatible) transcribe it. Goes through the exact
 * same provider stack as the assistant — base URL, API key, auth mode,
 * custom headers and the fetched model all apply.
 */
async function ocrPageAI(pageIndex, langs = 'eng', onProgress) {
  const { renderPageToCanvas } = await import('./viewer.js');
  const doc = activeDocRef();
  if (!doc) throw new Error('No document open');
  const dpi = clamp(Number(settings.ocr && settings.ocr.dpi) || 150, 72, 400);
  if (onProgress) onProgress({ status: 'rendering page', progress: 0.15 });
  const canvas = await renderPageToCanvas(pageIndex, dpi);
  const dataUrl = canvas.toDataURL('image/png');
  try { canvas.width = canvas.height = 0; } catch { /* ignore */ }

  const hint = String((settings.ocr && settings.ocr.langHint) || '').trim();
  const langName = (OCR_LANGS.find((l) => l.id === langs) || {}).label || '';
  const prompt = AI_OCR_PROMPT + (hint ? `\nThe page is written in: ${hint}.` : langName && langs !== 'eng' ? `\nThe page is written in: ${langName}.` : '');
  if (onProgress) onProgress({ status: 'AI reading page', progress: 0.45 });
  const text = await visionRequest(prompt, dataUrl);
  if (onProgress) onProgress({ status: 'recognised', progress: 1 });

  /* The vision model returns structured output (lines + per-CELL table
   * entries — the same idea as the user's proven PDF→Word flow). Parse it so
   * doc.ocr carries a real line list; the Direct Editor's per-cell table
   * split then works on AI-recognised pages exactly like Tesseract ones.
   * Unparseable responses fall back to plain text (no lines). */
  const { extractJson } = await import('./aijson.js');
  const parsed = extractJson(text, 'object');
  const lines = buildStructuredOcrLines(parsed);

  const plain = lines.length
    ? lines.map((l) => l.text).join('\n')
    : String(text || '').trim();
  const rec = {
    text: plain,
    lines: lines.length ? lines : undefined,
    confidence: null,
    langs,
    engine: 'ai',
    model: settings.ai && settings.ai.model,
    at: Date.now(),
  };
  doc.ocr = doc.ocr || {};
  doc.ocr[pageIndex] = rec;
  if (rec.text.length >= SCANNED_THRESHOLD && doc.scanned) doc.scanned.delete(pageIndex);
  return rec;
}

function activeDocRef() {
  return activeDoc() || null;
}

/**
 * Pull a flat line list out of a Tesseract result.
 *
 * `data.lines` is present on recent versions; older ones only nest lines under
 * blocks → paragraphs, and the geometry is what the Direct Editor needs, so
 * both shapes are handled.
 */
function extractLines(data) {
  if (Array.isArray(data?.lines) && data.lines.length) return data.lines;
  const out = [];
  for (const b of data?.blocks || []) {
    for (const p of b.paragraphs || []) {
      for (const l of p.lines || []) out.push(l);
    }
  }
  return out;
}

/** Recognise an arbitrary canvas and store the result for `pageIndex`. */
export async function ocrCanvas(canvas, langs = 'eng', onProgress, pageIndex = null, dpi = null) {
  const { activeDoc } = await import('./store.js');
  const doc = activeDoc();
  const w = await getWorker(langs, onProgress);
  if (onProgress) onProgress({ status: 'engine ready', progress: 0.1 });
  // PSM 1 = auto + OSD. The default (3) sometimes drops large headings on
  // scans where the body text dominates the orientation signal.
  const { data } = await w.recognize(canvas, { tessedit_pageseg_mode: '1' }, { blocks: true, text: true });
  if (onProgress) onProgress({ status: 'recognised', progress: 1 });

  // Geometry is kept as well as text: the Direct Editor edits recognised words
  // in place on the page, which is impossible from a bare transcript.
  const lines = extractLines(data).map((l) => ({
    text: String(l.text || ''), bbox: l.bbox || null,
    confidence: l.confidence ?? null,
    words: (l.words || []).map((wd) => ({ text: String(wd.text || ''), bbox: wd.bbox || null, confidence: wd.confidence ?? null })),
  })).filter((l) => l.bbox && l.text.trim());

  const rec = {
    text: (data.text || '').trim(),
    confidence: Math.round(data.confidence ?? 0),
    langs,
    engine: 'tesseract',
    at: Date.now(),
    lines,
    dpi: dpi || null,
    imageSize: [canvas.width, canvas.height],
  };
  if (pageIndex != null && doc) {
    doc.ocr = doc.ocr || {};
    doc.ocr[pageIndex] = rec;
    // Recognised pages are no longer "unknown" — they are searchable now.
    if (rec.text.length >= SCANNED_THRESHOLD && doc.scanned) doc.scanned.delete(pageIndex);
  }
  try { canvas.width = canvas.height = 0; } catch { /* ignore */ }
  return rec;
}

/**
 * Recognise a page with the LOCAL engine only, at a resolution good enough to
 * place text back on the page.
 *
 * The editor cannot use the AI engine here: a vision model returns prose with
 * no coordinates, and without word boxes there is nothing to click or cover.
 * So this path always runs Tesseract, whatever the OCR engine setting is.
 */
export async function recognizePageForEditing(pageIndex, langs = 'eng', onProgress) {
  const { renderPageToCanvas } = await import('./viewer.js');
  const doc = activeDoc();
  if (!doc) throw new Error('No document open');
  // 300 DPI is the sweet spot for English business text: fine enough that
  // tesseract reads 8-pt footnotes, fast enough to finish a page in seconds.
  const dpi = clampNum(Math.max(Number(settings.ocr && settings.ocr.dpi) || 300, 250), 200, 400);
  if (onProgress) onProgress({ status: 'rendering page', progress: 0.1 });
  const canvas = await renderPageToCanvas(pageIndex, dpi);
  if (onProgress) onProgress({ status: 'reading text', progress: 0.35 });
  return ocrCanvas(canvas, langs, onProgress, pageIndex, dpi);
}

function clampNum(v, lo, hi) { return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo; }

export async function terminateOcr() {
  if (worker) { try { await worker.terminate(); } catch { /* ignore */ } worker = null; workerLangs = ''; }
}

/** True once the module has been imported successfully (used by boot test). */
export const ocrAvailable = true;
