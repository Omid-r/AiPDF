import { state, activeDoc, emit } from './store.js';
import { getTextContent, pageEl, scrollToPage, scrollToRectOnPage, currentScale } from './viewer.js';
import { escapeHtml } from './util.js';

export async function runSearch(query, opts = {}) {
  const doc = activeDoc();
  if (!doc) return [];
  const q = query || '';
  state.search.query = q;
  if (q.length < 1) {
    state.search.matches = [];
    state.search.index = -1;
    clearHighlights();
    emit('search');
    return [];
  }
  const cs = opts.caseSensitive ?? state.search.caseSensitive;
  const ww = opts.wholeWord ?? state.search.wholeWord;
  const needle = cs ? q : q.toLowerCase();
  const matches = [];

  for (let i = 0; i < doc.numPages; i++) {
    const tc = await getTextContent(i);
    if (tc) {
      for (let k = 0; k < tc.items.length; k++) {
        const str = tc.items[k].str;
        if (!str) continue;
        const hay = cs ? str : str.toLowerCase();
        let from = 0;
        for (;;) {
          const at = hay.indexOf(needle, from);
          if (at < 0) break;
          from = at + Math.max(1, needle.length);
          if (ww) {
            const before = at > 0 ? str[at - 1] : ' ';
            const after = str[at + needle.length] || ' ';
            if (/[\wÀ-ɏ]/.test(before) || /[\wÀ-ɏ]/.test(after)) continue;
          }
          const item = tc.items[k];
          matches.push({
            page: i,
            item: k,
            start: at,
            end: at + needle.length,
            match: str.slice(at, at + needle.length),
            context: str,
            rect: itemRect(item),
          });
        }
      }
    }
    // OCR'd scanned pages have no native text items — search the
    // recognised text so finds work on flattened documents too.
    const o = doc.ocr?.[i];
    if (o && o.text) {
      const hay = cs ? o.text : o.text.toLowerCase();
      let from = 0;
      for (;;) {
        const at = hay.indexOf(needle, from);
        if (at < 0) break;
        from = at + Math.max(1, needle.length);
        if (ww) {
          const before = at > 0 ? o.text[at - 1] : ' ';
          const after = o.text[at + needle.length] || ' ';
          if (/[\wÀ-ɏ]/.test(before) || /[\wÀ-ɏ]/.test(after)) continue;
        }
        matches.push({
          page: i,
          item: -1,
          start: at,
          end: at + needle.length,
          match: o.text.slice(at, at + needle.length),
          context: o.text,
          ocr: true,
          rect: null,
        });
      }
    }
  }
  state.search.matches = matches;
  state.search.index = matches.length ? 0 : -1;
  highlightMatches();
  emit('search');
  if (matches.length) goToMatch(0);
  return matches;
}

function itemRect(item) {
  const t = item.transform;
  const size = Math.hypot(t[2], t[3]);
  const x = t[4], y = t[5];
  return [x, y - size * 0.2, x + (item.width || 0), y + size];
}

export function highlightMatches() {
  clearHighlights();
  const doc = activeDoc();
  if (!doc) return;
  const byPage = new Map();
  for (const m of state.search.matches) {
    if (!byPage.has(m.page)) byPage.set(m.page, []);
    byPage.get(m.page).push(m);
  }
  for (const [page, list] of byPage) {
    const rec = pageEl(page);
    if (!rec || !rec.textLayer) continue;
    for (const m of list) {
      const span = rec.textLayer.querySelector(`span[data-item="${m.item}"]`);
      if (!span) continue;
      span.dataset.search = '1';
      const text = span.textContent;
      span.innerHTML =
        escapeHtml(text.slice(0, m.start)) +
        `<mark>${escapeHtml(text.slice(m.start, m.end))}</mark>` +
        escapeHtml(text.slice(m.end));
    }
  }
}

export function clearHighlights() {
  document.querySelectorAll('.textLayer span[data-search]').forEach((span) => {
    span.textContent = span.textContent; // collapse marks back to plain text
    span.removeAttribute('data-search');
  });
}

export function goToMatch(index) {
  const m = state.search.matches;
  if (!m.length) return;
  const i = ((index % m.length) + m.length) % m.length;
  state.search.index = i;
  const hit = m[i];
  scrollToPage(hit.page);
  setTimeout(() => {
    const rec = pageEl(hit.page);
    if (!rec) return;
    const span = rec.textLayer.querySelector(`span[data-item="${hit.item}"]`);
    if (span) {
      const r = span.getBoundingClientRect();
      const wr = rec.wrap.getBoundingClientRect();
      scrollToRectOnPage(hit.page, pdfRectFromCss(hit.page, [r.left - wr.left, r.top - wr.top, r.right - wr.left, r.bottom - wr.top]));
    } else if (hit.rect) {
      scrollToRectOnPage(hit.page, hit.rect);
    }
  }, 90);
  emit('search');
}

function pdfRectFromCss(page, r) {
  const inv = (x, y) => {
    const rec = pageEl(page);
    return rec ? cssToPdf(rec, x, y) : { x: 0, y: 0 };
  };
  const a = inv(r[0], r[1]);
  const b = inv(r[2], r[3]);
  return [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)];
}

function cssToPdf(rec, x, y) {
  // Inline inverse of the viewport transform (avoids a circular import).
  const m = rec.viewport ? rec.viewport.transform : [currentScale(), 0, 0, -currentScale(), 0, 0];
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c || 1;
  return {
    x: (d * (x - e) - c * (y - f)) / det,
    y: (a * (y - f) - b * (x - e)) / det,
  };
}

export function nextMatch() { goToMatch((state.search.index ?? -1) + 1); }
export function prevMatch() { goToMatch((state.search.index ?? 1) - 1); }
