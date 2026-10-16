/**
 * Font capability and resolution — the report's §7.1/§7.2, applied.
 *
 * The problem this exists to stop: pdf-lib writes Standard-14 text as WinAnsi
 * codes, and any code point outside WinAnsi is silently replaced with 0x3F —
 * a literal question mark in the saved file. Measured: "नमस्ते" became six
 * 0x3F bytes, Arabic five, "中文" two, "₹" one. encodeText() does not throw,
 * so no amount of try/catch around it catches this.
 *
 * So coverage is checked BEFORE an edit is allowed to commit, and a gap is a
 * decision the user makes, not a substitution they discover later.
 *
 * No static imports, on purpose — same rule as textops.js. fonts.js is pulled
 * in lazily so the coverage arithmetic stays runnable under plain Node, where
 * the tests live. Callers pass fontkit in, or it is fetched on demand.
 */

/* ── Standard-14 coverage ───────────────────────────────────────────────────
 * pdf-lib's StandardFontEmbedder encodes every standard font — including
 * Symbol and ZapfDingbats — through WinAnsi, so WinAnsi is the correct test
 * for all of them, not just the text faces. Verified empirically: '€' writes
 * 0x80, '—' writes 0x97, 'é' writes 0xE9, and '₹' writes 0x3F. */

/** The CP1252-specific range 0x80-0x9F. Everything else WinAnsi covers is
 *  0x20-0x7E and 0xA0-0xFF, which are identity-mapped to Unicode. */
const WINANSI_HIGH = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6,
  0x2030, 0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c,
  0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0x017e, 0x0178,
]);

export function winAnsiHas(cp) {
  if (cp === 0x0a || cp === 0x0d || cp === 0x09) return true;
  if (cp >= 0x20 && cp <= 0x7e) return true;
  if (cp >= 0xa0 && cp <= 0xff) return true;
  return WINANSI_HIGH.has(cp);
}

/** Code points in `text` that a Standard-14 font would turn into '?'. */
export function winAnsiMissing(text) {
  const out = new Set();
  for (const ch of String(text ?? '')) {
    if (!winAnsiHas(ch.codePointAt(0))) out.add(ch);
  }
  return [...out];
}

/* ── Embedded font coverage ─────────────────────────────────────────────── */

const coverageCache = new WeakMap();

/**
 * Code points in `text` that `fontBytes` has no glyph for, using fontkit's
 * cmap. `hasGlyphForCodePoint` is the authoritative check: measured on real
 * Windows fonts, Arial returns false for all six Devanagari code points while
 * Mangal returns true for all six.
 *
 * Returns null when coverage cannot be determined (unparseable font), which
 * callers must treat as "unknown", never as "covered".
 */
export async function embeddedFontMissing(fontBytes, text, fontkit) {
  if (!fontBytes) return null;
  const key = String(text ?? '');
  const cached = coverageCache.get(fontBytes);
  if (cached?.key === key) return cached.missing;
  try {
    const fk = fontkit || (await loadFontkit());
    const font = fk.create(new Uint8Array(fontBytes));
    const out = new Set();
    for (const ch of key) {
      if (ch === '\n' || ch === '\r' || ch === '\t') continue;
      if (!font.hasGlyphForCodePoint(ch.codePointAt(0))) out.add(ch);
    }
    const missing = [...out];
    coverageCache.set(fontBytes, { key, missing });
    return missing;
  } catch (e) {
    console.warn('font coverage check failed:', e);
    return null;
  }
}

async function loadFontkit() {
  const fonts = await import('./fonts.js');
  return fonts.getFontkit();
}

/* ── Document font registry ─────────────────────────────────────────────── */

/** BaseFont names have no spaces ("TimesNewRoman"); pdf.js reports the family
 *  from the font's name table ("Times New Roman"). Normalising both is the
 *  only way they meet. */
const normKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

let docFontIndex = null;

/**
 * Index the open document's own embedded fonts and register them under the
 * family names pdf.js reports, so the ORIGINAL font is the first candidate for
 * replacement text.
 *
 * This was previously reachable only by the user opening View ▸ Document fonts
 * and clicking "Use for new text" for that exact face. Nothing called it on
 * open, so baseFont() missed and produced Standard-14 — which is how an
 * ordinary edit came to write question marks.
 */
export async function indexDocumentFonts(bytes) {
  if (!bytes) return new Map();
  if (docFontIndex) return docFontIndex;
  const index = new Map();
  try {
    const fonts = await import('./fonts.js');
    const { all } = await fonts.extractFontInfo(bytes);
    for (const rec of all) {
      if (!rec?.program?.bytes) continue;
      const key = normKey(rec.name);
      if (!key) continue;
      // First embedded program wins; a document rarely carries two faces that
      // normalise identically, and when it does either is a better match for
      // the original than Helvetica is.
      if (!index.has(key)) index.set(key, rec);
    }
  } catch (e) {
    console.warn('document font index failed:', e);
  }
  docFontIndex = index;
  return index;
}

export function resetDocumentFonts() { docFontIndex = null; }

/** The document's own font program for a pdf.js family name, if it has one. */
export function documentFontFor(family) {
  return docFontIndex?.get(normKey(family)) || null;
}

/* ── Resolution ladder (§7.2) ───────────────────────────────────────────── */

const STANDARD14 = /^(helvetica|times|courier|symbol|zapfdingbats)/i;

/**
 * Work out which font will actually draw `text`, and what it cannot draw.
 *
 * Order per §7.2: the document's own embedded font, then a font already
 * registered under that family, then Standard-14 only when coverage passes.
 * System-font matching is deliberately NOT attempted here — resolving an
 * arbitrary installed face is a licence and metric question the user should
 * answer in the font picker, not something to do silently mid-commit.
 *
 * @returns {Promise<{alias: string, source: 'document'|'registered'|'standard14',
 *                    missing: string[], coverageKnown: boolean}>}
 */
export async function resolveFontFor(family, text, bytes = null) {
  const index = bytes ? await indexDocumentFonts(bytes) : (docFontIndex || new Map());
  const fonts = await import('./fonts.js');

  // 1. The document's own embedded font — the closest possible match.
  const docFont = index.get(normKey(family));
  if (docFont?.program?.bytes) {
    const missing = await embeddedFontMissing(docFont.program.bytes, text);
    if (missing === null || missing.length === 0) {
      fonts.registerCustomFont(family, docFont.program.bytes, 'embedded');
      return { alias: family, source: 'document', missing: missing || [], coverageKnown: missing !== null };
    }
  }

  // 2. A font already registered under this family (user upload, or a
  //    previous call's registration).
  const registered = fonts.getCustomFont(family);
  if (registered?.bytes) {
    const missing = await embeddedFontMissing(registered.bytes, text);
    if (missing === null || missing.length === 0) {
      return { alias: family, source: 'registered', missing: missing || [], coverageKnown: missing !== null };
    }
  }

  // 3. Standard-14 — acceptable only when WinAnsi actually covers the text.
  const stdMissing = winAnsiMissing(text);
  const isStandard = STANDARD14.test(String(family || ''));
  return {
    alias: family,
    source: 'standard14',
    missing: stdMissing,
    // A named non-standard family falling through to Standard-14 is itself a
    // substitution, so coverage of the *family* is unknown even when WinAnsi
    // happens to hold every code point.
    coverageKnown: isStandard && stdMissing.length === 0,
  };
}
