/**
 * Validate assets/icon.ico: parses the ICONDIR, checks every embedded image
 * decodes as a real PNG (signature + IHDR dims matching the slot), and
 * confirms every IDAT chunk is valid zlib. Run after scripts/make-icon.mjs.
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { resolve } from 'node:path';

const path = resolve('assets/icon.ico');
const buf = readFileSync(path);

if (buf.length < 6) throw new Error('truncated');
const rsv = buf.readUInt16LE(0);
const type = buf.readUInt16LE(2);
const count = buf.readUInt16LE(4);
if (rsv !== 0 || type !== 1) throw new Error(`bad dir: rsv=${rsv} type=${type}`);
console.log(`ICONDIR  reserved=${rsv} type=${type} count=${count}`);

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

for (let i = 0; i < count; i++) {
  const o = 6 + 16 * i;
  const w = buf[o] || 256;
  const h = buf[o + 1] || 256;
  const planes = buf.readUInt16LE(o + 4);
  const bpp = buf.readUInt16LE(o + 6);
  const size = buf.readUInt32LE(o + 8);
  const offset = buf.readUInt32LE(o + 12);
  const data = buf.subarray(offset, offset + size);
  if (data.length < 8 || !data.subarray(0, 8).equals(PNG_SIG)) throw new Error(`entry ${i} not a PNG`);
  const ihdrType = data.subarray(12, 16).toString('ascii');
  if (ihdrType !== 'IHDR') throw new Error(`entry ${i} no IHDR`);
  const pw = data.readUInt32BE(16);
  const ph = data.readUInt32BE(20);
  if (pw !== w || ph !== h) throw new Error(`entry ${i} dims ${pw}x${ph} != dir ${w}x${h}`);

  let pos = 8;
  let foundEnd = false;
  let idatBytes = 0;
  while (pos < data.length) {
    const len = data.readUInt32BE(pos);
    const type = data.subarray(pos + 4, pos + 8).toString('ascii');
    const chunkData = data.subarray(pos + 8, pos + 8 + len);
    if (type === 'IDAT') {
      inflateSync(chunkData);
      idatBytes += len;
    } else if (type === 'IEND') {
      foundEnd = true;
    }
    pos += 12 + len;
  }
  if (!foundEnd) throw new Error(`entry ${i} missing IEND`);
  console.log(`  ${w}x${h}  planes=${planes} bpp=${bpp}  ${size} B  PNG OK  idat=${idatBytes} B`);
}
console.log('icon.ico OK');
