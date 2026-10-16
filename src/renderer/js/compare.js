/**
 * PDF Comparison — an Acrobat-style side-by-side document comparison.
 *
 * Stirling-PDF compares two documents in the browser; this is our equivalent.
 * The engine is pure (no DOM, no Electron) so scripts/tools-test.mjs can
 * verify the diff against hand-written fixtures, and the UI is a thin layer
 * on top.
 *
 * Method: per-page text extraction, then a line-level longest-common-
 * subsequence diff. Lines matched to nothing on the other side are reported as
 * removed/added, so a one-word change inside a long paragraph still shows up
 * as a small diff instead of a whole-page rewrite.
 */

/** Split a page's text into comparable lines. */
export function toLines(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Normalise a line so whitespace and case differences do not create noise. */
export function normalizeLine(line) {
  return String(line || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Longest-common-subsequence table for two string arrays.
 * Returns the matched index pairs [i, j].
 */
function lcsPairs(a, b) {
  const n = a.length;
  const m = b.length;
  const table = new Array(n + 1);
  for (let i = 0; i <= n; i++) table[i] = new Array(m + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

/**
 * Diff two pages. Returns
 *   { removed: string[], added: string[], changed: boolean, matched: number }
 * `removed` exists only in A, `added` only in B.
 */
export function diffPages(aText, bText, opts = {}) {
  const a = toLines(aText);
  const b = toLines(bText);
  const key = opts.normalize === false ? (x) => x : normalizeLine;
  const aa = a.map(key);
  const bb = b.map(key);
  const pairs = lcsPairs(aa, bb);
  const removed = [];
  const added = [];
  let pi = 0;
  for (let i = 0; i < aa.length; i++) {
    if (pi < pairs.length && pairs[pi][0] === i) { pi++; continue; }
    removed.push(a[i]);
  }
  let pj = 0;
  for (let j = 0; j < bb.length; j++) {
    if (pj < pairs.length && pairs[pj][1] === j) { pj++; continue; }
    added.push(b[j]);
  }
  return { removed, added, matched: pairs.length, changed: removed.length > 0 || added.length > 0 };
}

/** Count the words in a line, used for the "N lines / M words" summary. */
export function countWords(lines) {
  return lines.reduce((n, l) => n + (String(l).split(/\s+/).filter(Boolean).length), 0);
}

/**
 * Build a full comparison from two already-extracted page-text arrays.
 *
 * `aPages` / `bPages` are arrays of strings. Returns
 *   { pages: [{ index, a, b, removed, added, matched, changed }],
 *     summary: { pages: n, changed, added, removed, identical,
 *                addedWords, removedWords } }
 */
export function buildComparison(aPages, bPages, opts = {}) {
  const pages = [];
  const n = Math.max(aPages.length, bPages.length);
  let changed = 0;
  let added = 0;
  let removed = 0;
  let addedWords = 0;
  let removedWords = 0;
  for (let i = 0; i < n; i++) {
    const a = aPages[i] ?? '';
    const b = bPages[i] ?? '';
    const d = diffPages(a, b, opts);
    if (d.changed) changed++;
    added += d.added.length;
    removed += d.removed.length;
    addedWords += countWords(d.added);
    removedWords += countWords(d.removed);
    pages.push({ index: i, a, b, ...d });
  }
  return {
    pages,
    summary: {
      pages: n,
      changed,
      added,
      removed,
      identical: n - changed,
      addedWords,
      removedWords,
    },
  };
}

/**
 * A plain-text report of the comparison — used by "Copy report" and by tests,
 * so the assertion does not depend on DOM structure.
 */
export function comparisonReport(cmp, nameA = 'A', nameB = 'B') {
  const s = cmp.summary;
  const out = [
    `Comparison of ${nameA} vs ${nameB}`,
    `${s.pages} page(s) · ${s.changed} changed · ${s.identical} identical`,
    `${s.added} line(s) only in ${nameB} (+${s.addedWords} words) · ${s.removed} line(s) only in ${nameA} (−${s.removedWords} words)`,
    '',
  ];
  for (const p of cmp.pages) {
    if (!p.changed) continue;
    out.push(`── Page ${p.index + 1} ──`);
    for (const l of p.removed) out.push(`- ${l}`);
    for (const l of p.added) out.push(`+ ${l}`);
    out.push('');
  }
  return out.join('\n');
}

/* ── Shared UI helper, kept separate from the app shell ─────────────────── */

/** Scroll a viewer page into view — used by the "go to page" links. */
export function jumpToPage(index) {
  const evt = new CustomEvent('app:gotoPage', { detail: index });
  window.dispatchEvent(evt);
}
