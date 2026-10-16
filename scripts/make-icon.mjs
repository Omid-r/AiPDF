/**
 * Generates the application icon:  assets/icon.ico  (+ assets/icon.png).
 *
 * No image libraries are available in this environment, so the icon is
 * rasterised from scratch: shapes are exact inside/outside predicates evaluated
 * on a supersampled grid (16 samples per output pixel → clean antialiasing),
 * then encoded as PNG (zlib from Node core) and packed into an ICO container.
 *
 * Artwork mirrors the in-app brand mark (a bronze rounded square carrying an
 * "A") plus an ivory sparkle for the AI assistant, so the installer, taskbar,
 * window and title bar all read as one product.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'assets');

/* ── Palette (mirrors --c-bronze-* in app.css) ──────────────────────────── */
const BRONZE_500 = [0xa4, 0x70, 0x3c];
const BRONZE_700 = [0x7d, 0x53, 0x29];
const IVORY = [0xff, 0xfd, 0xf9];

/* ── Shape predicates, all in normalised 0..1 coordinates ───────────────── */

const SQ_R = 0.22; // corner radius of the brand square

function inRoundedSquare(u, v) {
  const r = SQ_R;
  const cx = Math.min(Math.max(u, r), 1 - r);
  const cy = Math.min(Math.max(v, r), 1 - r);
  const dx = u - cx;
  const dy = v - cy;
  return dx * dx + dy * dy <= r * r;
}

/** Barycentric point-in-triangle (winding agnostic). */
function inTri(u, v, ax, ay, bx, by, cx, cy) {
  const d1 = (u - bx) * (ay - by) - (ax - bx) * (v - by);
  const d2 = (u - cx) * (by - cy) - (bx - cx) * (v - cy);
  const d3 = (u - ax) * (cy - ay) - (cx - ax) * (v - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/** The "A" letterform: outer triangle, minus the counter, minus the leg gap.
 *  The band left between the two cut-outs is the crossbar. */
const A_OUT = [0.47, 0.20, 0.70, 0.84, 0.24, 0.84];
const A_CNT = [0.47, 0.335, 0.546, 0.545, 0.394, 0.545];
const A_GAP = [0.47, 0.615, 0.565, 0.84, 0.375, 0.84];

function inA(u, v) {
  if (!inTri(u, v, ...A_OUT)) return false;
  if (inTri(u, v, ...A_CNT)) return false;
  if (inTri(u, v, ...A_GAP)) return false;
  return true;
}

/** Four-point concave sparkle (8 vertices: 4 tips, 4 pinched waists). */
const SPARKLE = (() => {
  const cx = 0.78;
  const cy = 0.30;
  const R = 0.115;   // tip length
  const w = 0.038;   // waist inset — small → spiky
  const k = Math.SQRT1_2;
  const tips = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  const waists = [[1, -1], [1, 1], [-1, 1], [-1, -1]];
  const pts = [];
  for (let i = 0; i < 4; i++) {
    pts.push([cx + tips[i][0] * R, cy + tips[i][1] * R]);
    pts.push([cx + waists[i][0] * w * k, cy + waists[i][1] * w * k]);
  }
  return pts;
})();

function inPoly(u, v, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0];
    const yi = pts[i][1];
    const xj = pts[j][0];
    const yj = pts[j][1];
    if ((yi > v) !== (yj > v) && u < ((xj - xi) * (v - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/* ── Rasteriser ─────────────────────────────────────────────────────────── */

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, t) => a + (b - a) * t;

/** CSS `linear-gradient(140deg, bronze-500, bronze-700)`. */
function brandColour(u, v) {
  const t = clamp01(0.5 + (u - 0.5) * 0.643 + (v - 0.5) * 0.766);
  return [
    lerp(BRONZE_500[0], BRONZE_700[0], t),
    lerp(BRONZE_500[1], BRONZE_700[1], t),
    lerp(BRONZE_500[2], BRONZE_700[2], t),
  ];
}

/** Straight-alpha source-over into `buf`. */
function blend(buf, i, c, a) {
  const o = i * 4;
  const aD = buf[o + 3];
  const aO = a + aD * (1 - a);
  if (aO <= 0) return;
  for (let k = 0; k < 3; k++) buf[o + k] = (c[k] * a + buf[o + k] * aD * (1 - a)) / aO;
  buf[o + 3] = aO;
}

function render(size) {
  const ss = 4;                    // 16 samples per output pixel
  const W = size * ss;
  const px = size * size;
  const cov = new Float64Array(px);
  const buf = new Float64Array(px * 4);

  const paint = (test, colourAt) => {
    cov.fill(0);
    for (let y = 0; y < W; y++) {
      const v = (y + 0.5) / W;
      const row = ((y / ss) | 0) * size;
      for (let x = 0; x < W; x++) {
        if (test((x + 0.5) / W, v)) cov[row + ((x / ss) | 0)] += 1;
      }
    }
    const total = ss * ss;
    for (let i = 0; i < px; i++) {
      const a = cov[i] / total;
      if (a <= 0) continue;
      blend(buf, i, colourAt(((i % size) + 0.5) / size, ((((i / size) | 0) + 0.5) / size)), a);
    }
  };

  paint(inRoundedSquare, brandColour);
  paint(inA, () => IVORY);
  paint((u, v) => inPoly(u, v, SPARKLE), () => IVORY);

  const out = new Uint8Array(px * 4);
  for (let i = 0; i < px * 4; i++) out[i] = Math.max(0, Math.min(255, Math.round(buf[i])));
  return out;
}

/* ── PNG encoder ────────────────────────────────────────────────────────── */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function encodePng(w, h, rgba) {
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * stride + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: truecolour + alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ── ICO container ──────────────────────────────────────────────────────── */

function encodeIco(entries) {
  const n = entries.length;
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // type: icon
  dir.writeUInt16LE(n, 4);
  const ents = Buffer.alloc(16 * n);
  let offset = 6 + 16 * n;
  entries.forEach((e, i) => {
    const o = i * 16;
    const b = e.size >= 256 ? 0 : e.size; // 0 encodes 256
    ents[o] = b;
    ents[o + 1] = b;
    ents[o + 2] = 0; // palette
    ents[o + 3] = 0; // reserved
    ents.writeUInt16LE(1, o + 4); // colour planes
    ents.writeUInt16LE(32, o + 6); // bits per pixel
    ents.writeUInt32LE(e.png.length, o + 8);
    ents.writeUInt32LE(offset, o + 12);
    offset += e.png.length;
  });
  return Buffer.concat([dir, ents, ...entries.map((e) => e.png)]);
}

/* ── Build ──────────────────────────────────────────────────────────────── */

mkdirSync(OUT_DIR, { recursive: true });

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const entries = ICO_SIZES.map((size) => ({ size, png: encodePng(size, size, render(size)) }));

writeFileSync(resolve(OUT_DIR, 'icon.ico'), encodeIco(entries));
writeFileSync(resolve(OUT_DIR, 'icon.png'), encodePng(512, 512, render(512)));

for (const e of entries) console.log(`  ico ${e.size}x${e.size}  ${e.png.length} B`);
console.log(`icon.ico  ${encodeIco(entries).length} B  (${ICO_SIZES.length} sizes)`);
console.log('assets/icon.png written (512x512)');
