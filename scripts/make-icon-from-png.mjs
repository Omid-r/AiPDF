/**
 * Build assets/icon.ico (and assets/icon.png) from a supplied source PNG.
 *
 * This is the counterpart to make-icon.mjs, which DRAWS the bronze "A" mark from
 * shape predicates. That approach cannot express artwork, so when the icon is a
 * real image we have to resample it instead — and no image library is available
 * here, so the PNG is decoded by hand and resampled with premultiplied-alpha box
 * filtering.
 *
 *   node scripts/make-icon-from-png.mjs [source.png]
 *
 * Premultiplication matters: averaging straight RGBA over a transparent edge
 * drags the black of the empty pixels into the visible ones and leaves a dark
 * halo around the artwork at 16px and 24px.
 *
 * A contact sheet is written to .smoke/icon-sizes.png so the small sizes can be
 * actually looked at rather than assumed.
 */
import { inflateSync, deflateSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, process.argv[2] || 'assets/icon-source.png');
const OUT_DIR = resolve(ROOT, 'assets');
const SMOKE = resolve(ROOT, '.smoke');

/* ── PNG decode ─────────────────────────────────────────────────────────── */

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos); pos += 4;
    const type = buf.toString('ascii', pos, pos + 4); pos += 4;
    const data = buf.subarray(pos, pos + len); pos += len;
    pos += 4; // CRC — validated by the decoder downstream, skipped here
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
      if (bitDepth !== 8 || colorType !== 6) {
        throw new Error(`source must be 8-bit RGBA, got depth=${bitDepth} colourType=${colorType}`);
      }
      if (interlace !== 0) throw new Error('interlaced (Adam7) PNGs are not supported');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = w * bpp;
  const out = Buffer.alloc(stride * h);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[rp++];
    const line = raw.subarray(rp, rp + stride);
    rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) {
        throw new Error(`unknown scanline filter ${filter}`);
      }
      cur[x] = v & 0xff;
    }
  }
  return { w, h, rgba: new Uint8Array(out) };
}

/* ── Resample ───────────────────────────────────────────────────────────── */

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

function resizePremul(src, sw, sh, dw, dh) {
  const out = new Uint8Array(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor((y * sh) / dh);
    const y1 = Math.max(Math.min(Math.ceil(((y + 1) * sh) / dh), sh), y0 + 1);
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor((x * sw) / dw);
      const x1 = Math.max(Math.min(Math.ceil(((x + 1) * sw) / dw), sw), x0 + 1);
      let pr = 0, pg = 0, pb = 0, pa = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * sw + sx) * 4;
          const a = src[i + 3];
          pr += (src[i] * a) / 255;
          pg += (src[i + 1] * a) / 255;
          pb += (src[i + 2] * a) / 255;
          pa += a;
          n++;
        }
      }
      const A = pa / n;
      const o = (y * dw + x) * 4;
      out[o + 3] = clamp255(Math.round(A));
      if (A > 0.5) {
        out[o] = clamp255(Math.round(pr / n / (A / 255)));
        out[o + 1] = clamp255(Math.round(pg / n / (A / 255)));
        out[o + 2] = clamp255(Math.round(pb / n / (A / 255)));
      }
    }
  }
  return out;
}

/* ── PNG encode ─────────────────────────────────────────────────────────── */

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
    raw[y * stride] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * stride + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function encodeIco(entries) {
  const n = entries.length;
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(n, 4);
  const ents = Buffer.alloc(16 * n);
  let offset = 6 + 16 * n;
  entries.forEach((e, i) => {
    const o = i * 16;
    const b = e.size >= 256 ? 0 : e.size;
    ents[o] = b;
    ents[o + 1] = b;
    ents[o + 2] = 0;
    ents[o + 3] = 0;
    ents.writeUInt16LE(1, o + 4);
    ents.writeUInt16LE(32, o + 6);
    ents.writeUInt32LE(e.png.length, o + 8);
    ents.writeUInt32LE(offset, o + 12);
    offset += e.png.length;
  });
  return Buffer.concat([dir, ents, ...entries.map((e) => e.png)]);
}

/* ── Contact sheet, so the small sizes can be inspected ─────────────────── */

function composite(sheet, W, x0, y0, img, size, bg) {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const a = img[i + 3] / 255;
      const o = ((y0 + y) * W + (x0 + x)) * 4;
      for (let k = 0; k < 3; k++) sheet[o + k] = Math.round(img[i + k] * a + bg[k] * (1 - a));
      sheet[o + 3] = 255;
    }
  }
}

/* ── Build ──────────────────────────────────────────────────────────────── */

const { w: SW, h: SH, rgba: SRC_PX } = decodePng(readFileSync(SRC));
if (SW !== SH) throw new Error(`source must be square for an ICO, got ${SW}x${SH}`);
console.log(`source ${SRC} — ${SW}x${SH} RGBA`);

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256].filter((s) => s <= SW);
if (!ICO_SIZES.includes(256)) console.warn('WARN: source is smaller than 256px; the largest ICO entry will be soft');

const scaled = ICO_SIZES.map((size) => ({ size, px: resizePremul(SRC_PX, SW, SH, size, size) }));
const entries = scaled.map((e) => ({ size: e.size, png: encodePng(e.size, e.size, e.px) }));

const ico = encodeIco(entries);
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(resolve(OUT_DIR, 'icon.ico'), ico);
writeFileSync(resolve(OUT_DIR, 'icon.png'), encodePng(SW, SH, SRC_PX));
for (const e of entries) console.log(`  ico ${e.size}x${e.size}  ${e.png.length} B`);
console.log(`icon.ico ${ico.length} B, ${entries.length} sizes`);
console.log(`icon.png ${SW}x${SH} (native source size, not upscaled)`);

const PAD = 14;
const LIGHT = [0xf2, 0xf0, 0xed];
const DARK = [0x1d, 0x1b, 0x1a];
const rowW = scaled.reduce((t, e) => t + e.size + PAD, PAD);
const rowH = 256 + PAD * 2;
const W = rowW;
const H = rowH * 2;
const sheet = new Uint8Array(W * H * 4);
let x = PAD;
for (const e of scaled) {
  composite(sheet, W, x, PAD, e.px, e.size, LIGHT);
  composite(sheet, W, x, rowH + PAD, e.px, e.size, DARK);
  x += e.size + PAD;
}
mkdirSync(SMOKE, { recursive: true });
writeFileSync(resolve(SMOKE, 'icon-sizes.png'), encodePng(W, H, sheet));
console.log(`contact sheet -> .smoke/icon-sizes.png (${W}x${H}, light row then dark row)`);
