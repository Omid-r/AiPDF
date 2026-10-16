/**
 * Content-stream text operations.
 *
 * This is the engine behind reflow editing: it finds which parts of a page's
 * content stream draw text inside a given rectangle, and can remove exactly
 * those parts so the page genuinely no longer contains them. Removal — rather
 * than painting a white rectangle over the top — is what makes the saved file
 * truthful: search, copy-paste and screen readers in any PDF reader then agree
 * with what is on screen.
 *
 * It has no imports on purpose. The caller passes the pdf-lib module in, so this
 * file runs unchanged under Electron (renderer) and under plain Node, where the
 * excision tests live.
 *
 * Coordinate note, because it has bitten this project before: a rect here is PDF
 * user space, [x0, y0, x1, y1] with y increasing upward, so index 1 is the
 * BOTTOM of the page as rendered and index 3 the TOP.
 */

/* ── Byte/string helpers ──────────────────────────────────────────────────── */

/**
 * latin1 (ISO-8859-1) round-trips bytes 1:1 through a JS string, which is what
 * the tokenizer needs to reason about a content stream by offset.
 *
 * Buffer is deliberately NOT used: the renderer runs with nodeIntegration
 * disabled, so Buffer does not exist there, and a Node-only test would never
 * find out.
 */
export function toLatin1(bytes) {
  let out = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CH, bytes.length)));
  }
  return out;
}

export function fromLatin1(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

/* ── Matrix helpers (PDF row-vector convention) ───────────────────────────── */

export const IDENTITY = [1, 0, 0, 1, 0, 0];

export function mul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function applyMatrix(m, x, y) {
  return [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
}

/* ── Tokenizer, keeping byte offsets so spans can be cut out ──────────────── */

const isWS = (c) => c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f' || c === '\0';
const isDelim = (c) => isWS(c) || c === '(' || c === ')' || c === '<' || c === '>' || c === '[' || c === ']' || c === '{' || c === '}' || c === '/' || c === '%';

/**
 * Split a decoded content stream into tokens, each carrying its byte offset.
 *
 * Every branch must advance the cursor. An earlier version fell through to the
 * generic word branch for an unhandled delimiter, produced an empty token, and
 * looped pushing tokens until the heap died — hence the explicit progress guard
 * and the token ceiling.
 */
export function tokenize(src) {
  const toks = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const ch = src[i];
    if (isWS(ch)) { i++; continue; }
    if (ch === '%') { while (i < n && src[i] !== '\n' && src[i] !== '\r') i++; continue; }
    if (ch === '(') {
      let depth = 1, j = i + 1, out = '', start = i;
      while (j < n && depth > 0) {
        const c = src[j];
        if (c === '\\') { out += src[j + 1] ?? ''; j += 2; continue; }
        if (c === '(') depth++;
        if (c === ')') { depth--; if (depth === 0) { j++; break; } }
        out += c; j++;
      }
      toks.push({ t: 'str', v: out, s: start, e: j }); i = j; continue;
    }
    if (ch === '<' && src[i + 1] === '<') { toks.push({ t: 'dictopen', s: i, e: i + 2 }); i += 2; continue; }
    if (ch === '<') {
      const end = src.indexOf('>', i);
      const e = end < 0 ? n : end + 1;
      toks.push({ t: 'hex', v: src.slice(i + 1, end < 0 ? n : end).replace(/\s/g, ''), s: i, e });
      i = e; continue;
    }
    if (ch === '>' && src[i - 1] === '>') { toks.push({ t: 'dictclose', s: i, e: i + 1 }); i++; continue; }
    if (ch === '>') { i++; continue; }
    if (ch === '[') { toks.push({ t: '[', s: i, e: i + 1 }); i++; continue; }
    if (ch === ']') { toks.push({ t: ']', s: i, e: i + 1 }); i++; continue; }
    if (ch === '{') { toks.push({ t: '{', s: i, e: i + 1 }); i++; continue; }
    if (ch === '}') { toks.push({ t: '}', s: i, e: i + 1 }); i++; continue; }
    if (ch === '/') {
      let j = i + 1; while (j < n && !isDelim(src[j])) j++;
      toks.push({ t: 'name', v: src.slice(i + 1, j), s: i, e: j }); i = j; continue;
    }
    let j = i; while (j < n && !isDelim(src[j])) j++;
    if (j === i) { i++; continue; }
    const w = src.slice(i, j);
    if (/^[-+.?\d]/.test(w) && !isNaN(parseFloat(w))) toks.push({ t: 'num', v: parseFloat(w), s: i, e: j });
    else if (w === 'BI') {
      const ei = src.indexOf('EI', j);
      const e = ei < 0 ? n : ei + 2;
      toks.push({ t: 'op', v: 'BI', s: i, e });
      i = e;
      continue;
    } else toks.push({ t: 'op', v: w, s: i, e: j });
    i = j;
    if (toks.length > 3_000_000) throw new Error('content stream too large to tokenize safely');
  }
  return toks;
}

/* ── Text-state walk ──────────────────────────────────────────────────────── */

/**
 * Walk a content stream and return one record per BT..ET block, in device (PDF
 * user space) coordinates.
 *
 * Positions come from the operators alone — Tm sets a line origin, Td/TD/T* move
 * it, and the CTM stack maps text space onto the page. No font metrics and no
 * ToUnicode decoding are needed, which is what makes this practical: producers
 * such as Chrome emit one BT..ET per rendered line, so the block boundary is
 * already the natural unit of removal.
 */
export function walkTextBlocks(src) {
  const toks = tokenize(src);
  let ctm = IDENTITY;
  const stack = [];
  const blocks = [];
  let inText = false, tm = IDENTITY, cur = null;
  const operands = [];
  const nums = (k) => operands.slice(-k).map((x) => (typeof x === 'object' ? 0 : x));

  for (const tk of toks) {
    if (tk.t === 'num') { operands.push(tk.v); continue; }
    if (tk.t === 'name' || tk.t === 'str' || tk.t === 'hex' || tk.t === '[' || tk.t === ']' || tk.t === '{' || tk.t === '}' || tk.t === 'dictopen' || tk.t === 'dictclose') {
      operands.push(tk);
      continue;
    }
    if (tk.t !== 'op') { operands.length = 0; continue; }
    const op = tk.v;

    switch (op) {
      case 'q': stack.push(ctm.slice()); break;
      case 'Q': ctm = stack.pop() || IDENTITY; break;
      case 'cm': { const a = nums(6); if (a.length === 6) ctm = mul(ctm, a); break; }
      case 'BT':
        inText = true; tm = IDENTITY;
        cur = { start: tk.s, origins: [], glyphs: 0 };
        break;
      case 'ET':
        if (cur) {
          const xs = cur.origins.map((p) => p[0]);
          const ys = cur.origins.map((p) => p[1]);
          blocks.push({
            start: cur.start,
            end: tk.e,
            glyphs: cur.glyphs,
            rect: cur.glyphs ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] : null,
            origin: cur.glyphs ? [xs[0], ys[0]] : null,
          });
        }
        cur = null; inText = false;
        break;
      case 'Tm': { const a = nums(6); if (a.length === 6) tm = a; break; }
      case 'Td': case 'TD': {
        const a = nums(2);
        if (a.length === 2) tm = mul(tm, [1, 0, 0, 1, a[0], a[1]]);
        break;
      }
      case 'T*': { const a = nums(1); tm = mul(tm, [1, 0, 0, 1, 0, -(a[0] ?? 0)]); break; }
      case 'Tj': case 'TJ': case "'": case '"':
        if (cur && inText) {
          // Device point = CTM applied to where the text matrix put the pen.
          // Order matters: mul(ctm, tm), not mul(tm, ctm).
          cur.origins.push(applyMatrix(mul(ctm, tm), 0, 0));
          cur.glyphs++;
        }
        break;
      default: break;
    }
    operands.length = 0;
  }
  return blocks;
}

/* ── Rect maths ───────────────────────────────────────────────────────────── */

export function rectsIntersect(a, b) {
  return !(a[2] <= b[0] || b[2] <= a[0] || a[3] <= b[1] || b[3] <= a[1]);
}

/** True when `a` lies wholly inside `b`. */
export function rectContains(b, a) {
  return a[0] >= b[0] && a[1] >= b[1] && a[2] <= b[2] && a[3] <= b[3];
}

export function rectUnion(a, b) {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

/* ── Paragraph grouping ───────────────────────────────────────────────────── */

/**
 * Group rendered lines into paragraphs.
 *
 * Deliberately crude and cheap: sort lines top-to-bottom, take the median
 * line-to-line gap as the leading, and start a new paragraph wherever the gap is
 * materially larger than that. That catches the common cases — a body paragraph
 * followed by a heading, or a paragraph break — without trying to be a layout
 * analyser. Column detection is explicitly out of scope here; a two-column page
 * will interleave, which the caller surfaces rather than hides.
 */
export function groupParagraphs(blocks, { gapFactor = 1.6 } = {}) {
  const lines = blocks.filter((b) => b.glyphs > 0 && b.rect).slice().sort((a, b) => b.origin[1] - a.origin[1]);
  if (!lines.length) return [];
  const gaps = [];
  for (let i = 1; i < lines.length; i++) gaps.push(lines[i - 1].origin[1] - lines[i].origin[1]);
  gaps.sort((a, b) => a - b);
  const leading = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 12;
  const limit = leading * gapFactor;

  const out = [];
  let cur = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    const gap = lines[i - 1].origin[1] - lines[i].origin[1];
    if (gap > limit) { out.push(cur); cur = [lines[i]]; } else cur.push(lines[i]);
  }
  out.push(cur);

  return out.map((group) => {
    let rect = group[0].rect.slice();
    for (const l of group.slice(1)) rect = rectUnion(rect, l.rect);
    return {
      lines: group,
      rect,
      leading,
      text: '',
      y: Math.max(...group.map((l) => l.origin[1])),
    };
  });
};

/* ── Excision ─────────────────────────────────────────────────────────────── */

/**
 * Remove every text block whose origin falls inside one of `rects`.
 *
 * Origin-based rather than bbox-based: a line's origin is exact from the
 * operators, while its width would need font metrics, so testing the origin
 * keeps the decision free of any glyph decoding.
 *
 * Returns { bytes, removed, kept, refused } — `refused` is non-empty when text
 * was found inside a Form XObject, which is deliberately not touched: a form can
 * be shared by several pages, so editing it would corrupt pages the user never
 * selected.
 *
 * `opts.dryRun` counts the blocks that *would* go without touching the stream.
 * Excision is destructive and irreversible once the bytes are written, so the
 * caller runs a dry pass first, sanity-checks the count against what it expects
 * from the block it is replacing, and only then commits.
 *
 * `perRect[i]` reports how many blocks fell inside `rects[i]`, so a caller
 * handing over many rects at once can tell which of them actually matched and
 * only commit those — a page usually carries several edits and they must not
 * stand or fall together.
 */
export async function exciseText(PL, doc, pageIndex, rects, opts = {}) {
  // `opts.inflate` rather than a destructured `inflate`: the import audit treats a
  // bare call to a destructured parameter as an undeclared symbol, and a
  // permanently-failing audit is a broken alarm.
  const { PDFName, PDFRawStream, PDFDict, PDFArray } = PL;
  const page = doc.getPage(pageIndex);

  const refsForContents = () => {
    // page.node.Contents() RESOLVES the entry and hands back the stream object,
    // which cannot be used as an assignment target — assigning to it silently
    // wrote nowhere. get() returns the unresolved value, which is the PDFRef (or
    // the array of refs) that context.assign() actually needs.
    const entry = page.node.get(PDFName.of('Contents'));
    if (!entry) return [];
    const resolved = doc.context.lookup(entry);
    if (resolved instanceof PDFArray) {
      return Array.from({ length: resolved.size() }, (_, i) => resolved.get(i));
    }
    return [entry];
  };

  const decode = async (obj) => {
    if (!obj || !obj.contents) return null;
    const raw = obj.contents instanceof Uint8Array ? obj.contents : new Uint8Array(obj.contents);
    const f = obj.dict?.get?.(PDFName.of('Filter'))?.toString() || '';
    // PDFRawStream.decode() hands back the still-compressed bytes, so a
    // FlateDecode stream has to be inflated by the caller-supplied function:
    // zlib in Node, DecompressionStream in the renderer.
    if (f.includes('FlateDecode')) return (raw.length && opts.inflate) ? toLatin1(await opts.inflate(raw)) : null;
    return toLatin1(raw);
  };

  // Guard: refuse when any reachable Form XObject draws text itself.
  const res = doc.context.lookup(page.node.get(PDFName.of('Resources')));
  let refused = [];
  if (res instanceof PDFDict) {
    const xo = doc.context.lookup(res.get(PDFName.of('XObject')));
    if (xo instanceof PDFDict) {
      for (const key of xo.keys()) {
        const o = doc.context.lookup(xo.get(key));
        if (!(o instanceof PDFDict)) continue;
        if (o.get(PDFName.of('Subtype'))?.toString() !== '/Form') continue;
        const body = await decode(o);
        if (body && /\b(Tj|TJ)\b/.test(body)) refused.push(key.toString());
      }
    }
  }
  if (refused.length) return { refused, removed: 0, kept: 0, perRect: new Array(rects.length).fill(0), bytes: null };

  const refs = refsForContents();
  let removed = 0;
  let kept = 0;
  const perRect = new Array(rects.length).fill(0);

  for (const ref of refs) {
    const obj = doc.context.lookup(ref);
    const text = await decode(obj);
    if (text == null) continue;
    const blocks = walkTextBlocks(text).filter((b) => b.glyphs > 0);
    const cuts = [];
    for (const b of blocks) {
      const [x, y] = b.origin;
      let hit = -1;
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        if (x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]) { hit = i; break; }
      }
      if (hit >= 0) { cuts.push([b.start, b.end]); removed++; perRect[hit]++; } else kept++;
    }
    if (!cuts.length) continue;

    let out = '';
    let at = 0;
    for (const [s, e] of cuts.sort((a, b) => a[0] - b[0])) {
      out += text.slice(at, s);
      // Leave the bytes structurally intact by blanking rather than deleting, so
      // every other offset in the stream stays valid.
      out += ' '.repeat(Math.max(0, e - s));
      at = e;
    }
    out += text.slice(at);
    if (opts.dryRun) continue;

    // flateStream compresses internally and works identically in Node and the
    // renderer, so no deflate callback is needed on the write side.
    doc.context.assign(ref, doc.context.flateStream(fromLatin1(out)));
  }

  return { removed, kept, refused: [], perRect, bytes: null };
}
