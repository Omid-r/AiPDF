/**
 * Sensitive-data detection for AI Smart Redact (the Foxit "Smart Redact" /
 * Redactable pattern: auto-detect PII, review, then permanently remove).
 *
 * Two detection sources are combined:
 *  - regex scan (this module) — works with no AI configured, instant, offline
 *  - AI candidates (smartredact.js) — catches names, addresses and anything
 *    contextual; normalized through aijson.normalizePiiCandidates
 *
 * Pure module — no DOM, no imports — so the headless test gate exercises it
 * directly, including against real pdf.js text-content items.
 */

export const PII_TYPES = {
  email: { label: 'Email addresses', ai: false, color: '#c2410c' },
  phone: { label: 'Phone numbers', ai: false, color: '#a16207' },
  ssn: { label: 'National ID / SSN', ai: false, color: '#b91c1c' },
  creditcard: { label: 'Credit card numbers', ai: false, color: '#991b1b' },
  iban: { label: 'Bank / IBAN numbers', ai: false, color: '#7c2d12' },
  ip: { label: 'IP addresses', ai: false, color: '#4d7c0f' },
  dob: { label: 'Dates of birth', ai: false, color: '#86198f' },
  address: { label: 'Street addresses', ai: true, color: '#1d4ed8' },
  name: { label: 'Person names', ai: true, color: '#0e7490' },
  idnum: { label: 'Labelled ID numbers', ai: false, color: '#9333ea' },
  amount: { label: 'Money amounts', ai: false, color: '#374151' },
};

export const DEFAULT_CATEGORIES = ['email', 'phone', 'ssn', 'creditcard', 'iban', 'dob', 'address', 'name', 'idnum'];

/** Credit-card checksum so random 16-digit strings (order numbers, etc.)
 *  don't trigger redactions. */
export function luhn(digits) {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0, dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

const RX = [
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g],
  ['ssn', /\b\d{3}-\d{2}-\d{4}\b/g],
  ['iban', /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}\b/g],
  ['creditcard', /\b(?:\d[ -]?){13,19}\b/g],
  ['ip', /\b(?:(?:25[0-5]|2\d\d|1?\d?\d)\.){3}(?:25[0-5]|2\d\d|1?\d?\d)\b/g],
  ['dob', /(?:\bDOB\b|\bD\.O\.B\.?\b|\bDate of Birth\b|\bBirthday\b)\s*[:\-]?\s*([^\n;,|]{4,40})/gi],
  ['idnum', /\b(?:ID|Passport|Licen[cs]e|Aadhaar|PAN|VAT|Tax(?:\s+ID)?)\s*(?:No\.?|Number|#)\s*[:\-]?\s*[A-Z0-9][A-Z0-9-]{4,23}\b/gi],
  ['address', /\bAddress\s*(?:\d)?\s*[:\-]\s*([^\n]{6,90})/gi],
  ['amount', /(?:[$€£¥]\s?\d[\d,]*(?:\.\d{1,2})?|\d[\d,]{2,}(?:\.\d{1,2})?\s?(?:USD|EUR|GBP|INR|NPR|AUD|CAD))\b/g],
  ['phone', /(?:\+\d{1,3}[ .-]?)?(?:\(\d{1,4}\)[ .-]?\d{2,4}[ .-]?\d{2,4}(?:[ .-]\d{2,4}){0,2}|\d{3}[ .-]\d{3}[ .-]\d{4}|\d{3}[ .-]\d{2}[ .-]\d{4})/g],
];

const digitCount = (s) => (s.match(/\d/g) || []).length;

function typeOfMatch(type, raw) {
  const v = raw.trim().replace(/\s+/g, ' ');
  if (type === 'creditcard') {
    const digits = raw.replace(/[ -]/g, '');
    if (!luhn(digits)) return null;
    return digits.length >= 13 && digits.length <= 19 ? v : null;
  }
  if (type === 'phone') {
    // Phones need ≥9 digits and either a country code, parens or separators —
    // otherwise every plain number in the document would match.
    const d = digitCount(raw);
    if (d < 9 || d > 15) return null;
    if (!/^[+(\d]/.test(raw.trim())) return null;
    return v;
  }
  if (type === 'ip' && /^0\.0\.0\.0$/.test(raw.trim())) return null;
  if (type === 'amount' && digitCount(raw) < 1) return null;
  return v || null;
}

/** Scan page texts for the requested categories.
 *  pages: [{page (1-based), text}] · categories: array of PII_TYPES keys.
 *  Returns candidates [{page, text, type, reason}]. When one string matches
 *  several patterns (SSN also looks like a phone number) the more specific
 *  category listed first in RX wins and the duplicate is dropped. */
export function scanForPii(pages, categories = DEFAULT_CATEGORIES) {
  const want = new Set(categories);
  const out = [];
  const seen = new Set();
  for (const pg of pages || []) {
    const text = String(pg?.text || '');
    if (!text) continue;
    for (const [type, rx] of RX) {
      if (!want.has(type)) continue;
      rx.lastIndex = 0;
      let m;
      while ((m = rx.exec(text))) {
        const value = typeOfMatch(type, m[1] ?? m[0]);
        if (value) {
          const k = `${pg.page}|${value.toLowerCase()}`;
          if (!seen.has(k)) {
            seen.add(k);
            out.push({ page: pg.page, text: value, type, reason: 'Pattern match' });
          }
        }
        if (m.index === rx.lastIndex) rx.lastIndex++;
      }
    }
  }
  return out;
}

/** Merge AI candidates with regex ones: AI wins on (page, text) collisions,
 *  regardless of which type each detector assigned. */
export function mergePii(aiCands, regexCands) {
  const seen = new Set();
  const key = (c) => `${c.page}|${c.type}|${c.text.toLowerCase()}`;
  const loose = (c) => `${c.page}|${c.text.toLowerCase()}`;
  const out = [];
  for (const c of aiCands || []) {
    const k = key(c);
    if (seen.has(k)) continue;
    seen.add(k);
    seen.add(loose(c));
    out.push(c);
  }
  for (const c of regexCands || []) {
    const k = key(c);
    if (seen.has(k) || seen.has(loose(c))) continue;
    seen.add(k);
    seen.add(loose(c));
    out.push(c);
  }
  return out;
}

/** Build a char→text-item map over one page's pdf.js text content.
 *  `joined` is the geometry-faithful concatenation findRects searches (no
 *  separators — inserting any would break needles that legitimately span
 *  split items); `lines` newline-joins the items for DETECTION, so text at
 *  a line boundary ("…@acme.com" / "Phone: …") never fuses into one string. */
export function pageTextMap(items) {
  let joined = '';
  const map = [];
  const lines = [];
  for (const it of items || []) {
    if (!it.str) continue;
    map.push({ start: joined.length, end: joined.length + it.str.length, item: it });
    joined += it.str;
    lines.push(it.str);
  }
  return { joined, lines: lines.join('\n'), map };
}

/** All occurrences of `needle` on a mapped page as PDF-space rects
 *  [x0, y0, x1, y1]. Same item-geometry math as the agent's locateRect. */
export function findRects({ joined, map }, needle) {
  const nd = String(needle || '').trim();
  const out = [];
  if (!nd || !map.length) return out;
  const hay = joined.toLowerCase();
  const low = nd.toLowerCase();
  let at = hay.indexOf(low);
  while (at >= 0) {
    const first = map.find((m) => m.end > at);
    const last = map.find((m) => m.end > at + nd.length - 1) || first;
    if (first) {
      const a = first.item.transform, b = last.item.transform;
      const size = Math.hypot(a[2], a[3]) || 10;
      const x0 = Math.min(a[4], b[4]);
      const x1 = Math.max(a[4] + (first.item.width || 0), b[4] + (last.item.width || 0));
      out.push([x0, Math.min(a[5], b[5]) - size * 0.22, x1, Math.max(a[5], b[5]) + size * 0.9]);
    }
    at = hay.indexOf(low, at + Math.max(1, low.length));
  }
  return out;
}
