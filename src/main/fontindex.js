/**
 * System font index - reads fonts installed on this machine.
 *
 * In the main process because the renderer has no filesystem access, and as a
 * separate module because the name-table parser is pure and testable in plain
 * Node (scripts/fontindex-test.mjs).
 *
 * Only needed bytes are read: the table directory is at the head of the file and
 * gives the offset and length of the "name" table, so resolving a family name
 * costs two small reads instead of slurping ~200 KB across 340 files.
 *
 * Excluded on purpose:
 *   - .ttc collections: one file holds several faces and collection bytes cannot
 *     be embedded as-is, so they are counted and reported, not silently dropped.
 *   - .fon bitmap fonts: no usable outlines for PDF embedding.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const HEAD_BYTES = 1024;

function parseTableDirectory(head) {
  if (!head || head.length < 12) return null;
  const tag = head.toString('latin1', 0, 4);
  if (tag === 'ttcf') return { collection: true, tables: {} };
  const ok = tag === '\u0000\u0001\u0000\u0000' || tag === 'OTTO' || tag === 'true' || tag === 'typ1';
  if (!ok) return null;
  const numTables = head.readUInt16BE(4);
  const tables = {};
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (rec + 16 > head.length) break;
    tables[head.toString('latin1', rec, rec + 4)] = {
      offset: head.readUInt32BE(rec + 8),
      length: head.readUInt32BE(rec + 12),
    };
  }
  return { collection: false, tables };
}

function sanitize(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0xfeff) continue;
    if (c < 32 || c === 127) continue;
    out += s[i];
  }
  return out.trim();
}

function decodeNameString(bytes, platformID) {
  if (platformID === 3 || platformID === 0) {
    let out = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode(bytes.readUInt16BE(i));
    return sanitize(out);
  }
  return sanitize(bytes.toString('latin1'));
}

function readRange(filePath, offset, length) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(length);
    const got = fs.readSync(fd, buf, 0, length, offset);
    return got === length ? buf : buf.subarray(0, got);
  } finally {
    fs.closeSync(fd);
  }
}

function parseNameTable(filePath, tables) {
  const name = tables.name;
  if (!name || !name.length || name.offset + name.length > 1024 * 1024) return null;
  const t = readRange(filePath, name.offset, Math.min(name.length, 64 * 1024));
  if (t.length < 6) return null;
  const count = t.readUInt16BE(2);
  const stringsAt = t.readUInt16BE(4);
  const found = {};
  for (let i = 0; i < count; i++) {
    const rec = 6 + i * 12;
    if (rec + 12 > t.length) break;
    const platformID = t.readUInt16BE(rec);
    const nameID = t.readUInt16BE(rec + 6);
    const len = t.readUInt16BE(rec + 8);
    const off = t.readUInt16BE(rec + 10);
    const start = stringsAt + off;
    if (start + len > t.length) continue;
    if (nameID !== 1 && nameID !== 2 && nameID !== 4 && nameID !== 6) continue;
    const key = nameID === 1 ? 'family' : nameID === 2 ? 'subfamily' : nameID === 4 ? 'full' : 'postscript';
    if (found[key] && platformID !== 3) continue;
    const val = decodeNameString(t.subarray(start, start + len), platformID);
    if (val) found[key] = val;
  }
  return found;
}

function readFontInfo(filePath) {
  let head;
  try {
    head = readRange(filePath, 0, HEAD_BYTES);
  } catch {
    return null;
  }
  const dir = parseTableDirectory(head);
  if (!dir) return null;
  if (dir.collection) return { collection: true };
  const names = parseNameTable(filePath, dir.tables);
  if (!names || !names.family) return null;
  const style = names.subfamily || 'Regular';
  return {
    collection: false,
    family: names.family,
    style,
    postscript: names.postscript || null,
    fullName: names.full || (names.family + ' ' + style),
  };
}

function listFontFiles(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    const ext = path.extname(n).toLowerCase();
    if (ext !== '.ttf' && ext !== '.otf') continue;
    const full = path.join(dir, n);
    try { if (fs.statSync(full).isFile()) out.push(full); } catch { /* skip */ }
  }
  return out;
}

function countCollections(dir) {
  try { return fs.readdirSync(dir).filter((n) => path.extname(n).toLowerCase() === '.ttc').length; } catch { return 0; }
}

/**
 * Build the index of installed faces. Returns { faces, skippedCollections }.
 * Faces are deduplicated by PostScript name so one family spread over several
 * style files still appears once per style.
 */
function buildFontIndex(dirs) {
  const faces = [];
  const seen = new Set();
  let skippedCollections = 0;
  for (const dir of dirs) {
    skippedCollections += countCollections(dir);
    for (const file of listFontFiles(dir)) {
      const info = readFontInfo(file);
      if (!info || info.collection) continue;
      const key = info.postscript || (info.family + '|' + info.style);
      if (seen.has(key)) continue;
      seen.add(key);
      faces.push({ file, family: info.family, style: info.style, fullName: info.fullName });
    }
  }
  faces.sort((a, b) => a.family.localeCompare(b.family) || a.style.localeCompare(b.style));
  return { faces, skippedCollections };
}

function defaultDirs(env, platform) {
  if (platform !== 'win32') return [];
  const windir = env.SystemRoot || env.windir || 'C:\\Windows';
  const local = env.LOCALAPPDATA;
  const out = [path.join(windir, 'Fonts')];
  if (local) out.push(path.join(local, 'Microsoft', 'Windows', 'Fonts'));
  return out;
}

module.exports = { parseTableDirectory, readFontInfo, buildFontIndex, defaultDirs, listFontFiles };
