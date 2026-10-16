import { state, activeDoc, pushHistory, emit } from './store.js';
import { pageDims, currentScale } from './viewer.js';
import { el, hexToRgb, rgbToHex, rgbToCss, clamp, bytesToDataUrl, toast } from './util.js';
import { showModal, popover, formRow } from './dialog.js';

const SVGNS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}, children = []) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) n.setAttribute(k, v);
  for (const c of [].concat(children)) if (c) n.appendChild(c);
  return n;
}

const STAMPS = [
  { label: 'APPROVED', color: '#178a4b', width: 170 },
  { label: 'DRAFT', color: '#b7791f', width: 130 },
  { label: 'CONFIDENTIAL', color: '#d92d3f', width: 210 },
  { label: 'FINAL', color: '#178a4b', width: 120 },
  { label: 'REVIEWED', color: '#3b5bfd', width: 165 },
  { label: 'REJECTED', color: '#d92d3f', width: 165 },
  { label: 'COPY', color: '#595f6d', width: 110 },
  { label: 'VOID', color: '#d92d3f', width: 105 },
  { label: 'FOR REVIEW', color: '#3b5bfd', width: 180 },
  { label: 'URGENT', color: '#d92d3f', width: 140 },
  { label: 'PAID', color: '#178a4b', width: 105 },
  { label: 'RECEIVED', color: '#595f6d', width: 165 },
];

export function pickStamp(clientX, clientY) {
  return new Promise((resolve) => {
    const grid = el('div', { class: 'pgrid' });
    const finish = (v) => { close(); resolve(v); };
    STAMPS.forEach((s) => {
      const b = el('div', {
        class: 'stamp-item',
        text: s.label,
        style: { color: s.color, borderColor: s.color, borderWidth: '1.5px' },
      });
      b.onclick = () => finish({ ...s, color: hexToRgb(s.color), height: Math.round(s.width * 0.28) });
      grid.appendChild(b);
    });
    const custom = el('div', { class: 'stamp-item', text: 'Custom…', style: { gridColumn: '1 / -1' } });
    custom.onclick = async () => {
      close();
      try { resolve(await customStampDialog()); } catch (e) { console.warn('custom stamp failed', e); resolve(null); }
    };
    grid.appendChild(custom);
    const box = el('div', {}, [el('div', { class: 'hint', text: 'Choose a stamp', style: { marginBottom: '6px' } }), grid]);
    const close = popover({ getBoundingClientRect: () => ({ left: clientX, right: clientX, bottom: clientY, top: clientY, width: 0, height: 0 }) }, box, { left: clientX });
  });
}

async function customStampDialog() {
  let label = 'CUSTOM', color = '#3b5bfd', fontSize = 16;
  const ok = await showModal({
    title: 'Custom stamp',
    width: 'narrow',
    body: (b) => {
      const t = el('input', { type: 'text', value: label });
      const c = el('input', { type: 'color', value: color, style: { height: '29px', padding: '0' } });
      const f = el('input', { type: 'number', value: String(fontSize), style: { width: '70px' } });
      b.appendChild(formRow('Text', t).row);
      b.appendChild(formRow('Colour', c).row);
      b.appendChild(formRow('Font size', f).row);
      t.oninput = () => { label = t.value; };
      c.oninput = () => { color = c.value; };
      f.oninput = () => { fontSize = Number(f.value); };
    },
    buttons: [
      { label: 'Cancel', value: false, kind: 'ghost' },
      { label: 'Place stamp', value: true, kind: 'primary', default: true },
    ],
  });
  if (!ok) return null;
  fontSize = Number.isFinite(fontSize) ? clamp(fontSize, 4, 200) : 16;
  const width = Math.max(80, label.length * fontSize * 0.62 + 24);
  return { label, color: hexToRgb(color), fontSize, width, height: Math.round(fontSize * 2.1) };
}

/* ── Signature ──────────────────────────────────────────────────────────── */

export async function pickSignature() {
  return signatureDialog('Signature');
}

export async function signatureDialog(title = 'Signature') {
  let mode = 'draw';
  let dataUrl = null;
  let typedName = '';
  const canvas = el('canvas', { class: 'canvas-pad' });
  const typeInput = el('input', { type: 'text', placeholder: 'Type your name', style: { display: 'none' } });
  const fileInfo = el('div', { class: 'hint', text: '', style: { display: 'none' } });

  const ok = await showModal({
    title,
    width: '',
    body: (b) => {
      const tabs = el('div', { class: 'tabs-row' });
      const mkTab = (id, label) => {
        const t = el('button', { text: label, class: id === 'draw' ? 'active' : '' });
        t.onclick = () => {
          mode = id;
          Array.from(tabs.children).forEach((c) => c.classList.remove('active'));
          t.classList.add('active');
          canvas.style.display = id === 'draw' ? '' : 'none';
          typeInput.style.display = id === 'type' ? '' : 'none';
          fileInfo.style.display = id === 'upload' ? '' : 'none';
          if (id === 'type') setTimeout(() => typeInput.focus(), 10);
        };
        return t;
      };
      tabs.append(mkTab('draw', 'Draw'), mkTab('type', 'Type'), mkTab('upload', 'Upload image'));
      b.appendChild(tabs);
      b.appendChild(canvas);
      b.appendChild(typeInput);
      b.appendChild(fileInfo);
      b.appendChild(el('div', { class: 'hint', text: 'Visual signature only: embedded as an image, not certificate-based digital signing.' }));

      setTimeout(() => setupPad(canvas), 20);

      typeInput.oninput = () => {
        typedName = typeInput.value;
        dataUrl = renderTypedSignature(typedName).toDataURL('image/png');
      };
      fileInfo.onclick = pickSigFile;
      fileInfo.style.cursor = 'pointer';
      Object.assign(fileInfo.style, { padding: '10px', border: '1px dashed var(--border)', borderRadius: '6px', textAlign: 'center' });
      fileInfo.textContent = 'Click to choose a PNG or JPG…';
    },
    buttons: [
      { label: 'Cancel', value: false, kind: 'ghost' },
      { label: 'Clear', value: 'clear', kind: 'ghost' },
      { label: 'Place signature', value: true, kind: 'primary', default: true },
    ],
  });

  async function pickSigFile() {
    const paths = await window.api.openDialog({
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }],
    });
    if (!paths || !paths[0]) return;
    const r = await window.api.readFile(paths[0]);
    if (!r.ok) return;
    const url = await bytesToDataUrl(r.data);
    const img = await loadImage(url);
    dataUrl = url;
    fileInfo.textContent = `Selected: ${paths[0].split(/[\\/]/).pop()} (${img.width}×${img.height})`;
  }

  if (ok === 'clear') return signatureDialog(title);
  if (!ok) return null;
  if (mode === 'draw' && !dataUrl) dataUrl = trimCanvas(canvas).toDataURL('image/png');
  if (!dataUrl) return null;
  const img = await loadImage(dataUrl);
  const maxW = 200;
  const scale = Math.min(1, maxW / img.width);
  return { dataUrl, width: Math.round(img.width * scale), height: Math.round(img.height * scale) };
}

function setupPad(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = 2;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#111827';
  let drawing = false, last = null;
  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  canvas.addEventListener('pointerdown', (e) => { drawing = true; last = pos(e); canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last = p;
    canvas.dataset.dirty = '1';
  });
  const stop = () => { drawing = false; canvas.dataset.drawn = canvas.dataset.dirty ? '1' : ''; };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointerleave', stop);
}

function trimCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width, minY = height, maxX = 0, maxY = 0, found = false;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        found = true;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (!found) return canvas;
  const pad = 6;
  const w = Math.max(1, maxX - minX + pad * 2), h = Math.max(1, maxY - minY + pad * 2);
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  out.getContext('2d').drawImage(canvas, minX - pad, minY - pad, w, h, 0, 0, w, h);
  return out;
}

function renderTypedSignature(name) {
  const c = document.createElement('canvas');
  c.width = 520; c.height = 150;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#111827';
  ctx.font = 'italic 62px "Segoe Script", "Brush Script MT", cursive, serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(name || 'Your name', 10, 75);
  return trimCanvas(c);
}

export async function pickImage() {
  const paths = await window.api.openDialog({
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }],
  });
  if (!paths || !paths[0]) return null;
  const r = await window.api.readFile(paths[0]);
  if (!r.ok) return null;
  const dataUrl = await bytesToDataUrl(r.data);
  const img = await loadImage(dataUrl);
  const maxW = 320;
  const s = Math.min(1, maxW / img.width);
  return { dataUrl, width: Math.round(img.width * s), height: Math.round(img.height * s) };
}

function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}


/* ── Watermark / header / footer / Bates dialogs ────────────────────────── */

function pageRangeControls(doc) {
  const from = el('input', { type: 'number', value: '1', min: '1', max: String(doc.numPages), style: { width: '66px' } });
  const to = el('input', { type: 'number', value: String(doc.numPages), min: '1', max: String(doc.numPages), style: { width: '66px' } });
  const odd = el('select', {}, [
    el('option', { value: 'all', text: 'All pages' }),
    el('option', { value: 'odd', text: 'Odd pages' }),
    el('option', { value: 'even', text: 'Even pages' }),
  ]);
  odd.style.width = 'auto';
  return { from, to, odd };
}

export async function watermarkDialog() {
  const doc = activeDoc();
  if (!doc) return;
  let kind = 'text';
  let text = 'DRAFT';
  let image = null;
  let fontSize = 56, color = '#8a8f9c', opacity = 0.16, angle = -45, scale = 60, behind = true;
  const range = pageRangeControls(doc);

  const ok = await showModal({
    title: 'Add watermark',
    body: (b) => {
      const tabs = el('div', { class: 'tabs-row' });
      const textWrap = el('div', {});
      const imgWrap = el('div', {}, [
        el('div', { class: 'hint', text: 'No image selected.' }),
        el('button', { class: 'mini-btn', text: 'Choose image…' }),
      ]);
      const mkTab = (id, label) => {
        const t = el('button', { text: label, class: id === 'text' ? 'active' : '' });
        t.onclick = () => {
          kind = id;
          Array.from(tabs.children).forEach((c) => c.classList.remove('active'));
          t.classList.add('active');
          textWrap.style.display = id === 'text' ? '' : 'none';
          imgWrap.style.display = id === 'image' ? '' : 'none';
        };
        return t;
      };
      tabs.append(mkTab('text', 'Text'), mkTab('image', 'Image'));
      imgWrap.style.display = 'none';
      b.appendChild(tabs);

      const t = el('input', { type: 'text', value: text });
      const fs = el('input', { type: 'number', value: String(fontSize), style: { width: '66px' } });
      const col = el('input', { type: 'color', value: color, style: { width: '40px', padding: '0' } });
      const op = el('input', { type: 'range', min: '0.02', max: '1', step: '0.02', value: String(opacity) });
      const opv = el('span', { class: 'hint', text: Math.round(opacity * 100) + '%' });
      const ang = el('input', { type: 'range', min: '-90', max: '90', step: '1', value: String(angle) });
      const angv = el('span', { class: 'hint', text: angle + '°' });
      const sc = el('input', { type: 'range', min: '10', max: '150', step: '5', value: String(scale) });
      const scv = el('span', { class: 'hint', text: scale + '%' });
      const bh = el('input', { type: 'checkbox' }); bh.checked = behind;

      textWrap.append(
        formRow('Text', t).row,
        formRow('Font size', fs).row,
        formRow('Colour', col).row,
        formRow('Opacity', el('div', { class: 'range' }, [op, opv])).row,
        formRow('Rotation', el('div', { class: 'range' }, [ang, angv])).row,
      );
      b.appendChild(textWrap);

      const choose = imgWrap.querySelector('button');
      const hint = imgWrap.querySelector('.hint');
      choose.onclick = async () => {
        const res = await pickImage();
        if (!res) return;
        image = res.dataUrl;
        hint.textContent = 'Image selected.';
      };
      const scRow = formRow('Size', el('div', { class: 'range' }, [sc, scv]));
      imgWrap.appendChild(scRow.row);
      b.appendChild(imgWrap);

      b.appendChild(el('div', { class: 'divider' }));
      b.appendChild(formRow('Pages', el('div', { class: 'flex' }, [range.from, el('span', { text: '→' }), range.to, range.odd])).row);
      b.appendChild(formRow('Behind content', el('label', { class: 'cb' }, [bh, el('span', { text: 'Draw watermark underneath the page text' })])).row);

      t.oninput = () => { text = t.value; };
      fs.oninput = () => { fontSize = Number(fs.value); };
      col.oninput = () => { color = col.value; };
      op.oninput = () => { opacity = Number(op.value); opv.textContent = Math.round(opacity * 100) + '%'; };
      ang.oninput = () => { angle = Number(ang.value); angv.textContent = angle + '°'; };
      sc.oninput = () => { scale = Number(sc.value); scv.textContent = scale + '%'; };
      bh.onchange = () => { behind = bh.checked; };
    },
  });
  if (!ok) return;
  doc.stamps.push({
    id: 'st' + Math.random().toString(36).slice(2, 8),
    kind: 'watermark',
    text: kind === 'text' ? text : '',
    image: kind === 'image' ? image : null,
    fontSize, color: hexToRgb(color), opacity, angle, scale, behind,
    from: Number(range.from.value), to: Number(range.to.value), odd: range.odd.value,
  });
  pushHistory('watermark');
  emit('stamps');
}

export async function headerFooterDialog(kind = 'header') {
  const doc = activeDoc();
  if (!doc) return;
  let left = kind === 'header' ? '' : 'Page {page} of {pages}';
  let center = kind === 'header' ? '{filename}' : '';
  let right = kind === 'header' ? '{date}' : '';
  let fontSize = 9, color = '#3a3f4b', margin = 28, behind = true, startAt = 1;
  const range = pageRangeControls(doc);

  const ok = await showModal({
    title: kind === 'header' ? 'Add header' : 'Add footer',
    body: (b) => {
      const mk = (v, cb) => {
        const i = el('input', { type: 'text', value: v });
        i.oninput = () => cb(i.value);
        return i;
      };
      b.appendChild(formRow('Left', mk(left, (v) => { left = v; })).row);
      b.appendChild(formRow('Centre', mk(center, (v) => { center = v; })).row);
      b.appendChild(formRow('Right', mk(right, (v) => { right = v; })).row);
      const fs = el('input', { type: 'number', value: String(fontSize), style: { width: '66px' } });
      const col = el('input', { type: 'color', value: color, style: { width: '40px', padding: '0' } });
      const mg = el('input', { type: 'number', value: String(margin), style: { width: '66px' } });
      const bh = el('input', { type: 'checkbox' }); bh.checked = behind;
      b.appendChild(formRow('Font size', fs).row);
      b.appendChild(formRow('Colour', col).row);
      b.appendChild(formRow('Margin (pt)', mg).row);
      b.appendChild(formRow('Pages', el('div', { class: 'flex' }, [range.from, el('span', { text: '→' }), range.to, range.odd])).row);
      b.appendChild(formRow('Behind content', el('label', { class: 'cb' }, [bh, el('span', { text: 'Draw underneath page content' })])).row);
      b.appendChild(el('div', {
        class: 'hint',
        text: 'Tokens: {page} {pages} {date} {time} {filename} {author} {bates}',
      }));
      fs.oninput = () => { fontSize = Number(fs.value); };
      col.oninput = () => { color = col.value; };
      mg.oninput = () => { margin = Number(mg.value); };
      bh.onchange = () => { behind = bh.checked; };
    },
  });
  if (!ok) return;
  doc.stamps.push({
    id: 'st' + Math.random().toString(36).slice(2, 8),
    kind,
    parts: [
      { text: left, align: 'left' },
      { text: center, align: 'center' },
      { text: right, align: 'right' },
    ],
    fontSize, color: hexToRgb(color), margin, behind,
    from: Number(range.from.value), to: Number(range.to.value), odd: range.odd.value, start: startAt,
  });
  pushHistory(kind);
  emit('stamps');
}

export async function batesDialog() {
  const doc = activeDoc();
  if (!doc) return;
  let prefix = '', start = 1, step = 1, pad = 5, suffix = '';
  let fontSize = 10, color = '#d92d3f', margin = 24, position = 'footer';
  const range = pageRangeControls(doc);

  const ok = await showModal({
    title: 'Bates numbering',
    body: (b) => {
      const mk = (v, cb, w) => {
        const i = el('input', { type: 'text', value: v, style: w ? { width: w } : {} });
        i.oninput = () => cb(i.value);
        return i;
      };
      const mkNum = (v, cb, w) => {
        const i = el('input', { type: 'number', value: String(v), style: { width: w || '66px' } });
        i.oninput = () => cb(Number(i.value));
        return i;
      };
      b.appendChild(formRow('Prefix', mk(prefix, (v) => { prefix = v; }, '110px')).row);
      b.appendChild(formRow('Start', mkNum(start, (v) => { start = v; })).row);
      b.appendChild(formRow('Increment', mkNum(step, (v) => { step = v; })).row);
      b.appendChild(formRow('Digits', mkNum(pad, (v) => { pad = v; })).row);
      b.appendChild(formRow('Suffix', mk(suffix, (v) => { suffix = v; }, '110px')).row);
      const pos = el('select', {}, [
        el('option', { value: 'footer', text: 'Bottom of page' }),
        el('option', { value: 'header', text: 'Top of page' }),
      ]);
      const fs = el('input', { type: 'number', value: String(fontSize), style: { width: '66px' } });
      const col = el('input', { type: 'color', value: color, style: { width: '40px', padding: '0' } });
      const mg = el('input', { type: 'number', value: String(margin), style: { width: '66px' } });
      b.appendChild(formRow('Position', pos).row);
      b.appendChild(formRow('Font size', fs).row);
      b.appendChild(formRow('Colour', col).row);
      b.appendChild(formRow('Margin (pt)', mg).row);
      b.appendChild(formRow('Pages', el('div', { class: 'flex' }, [range.from, el('span', { text: '→' }), range.to, range.odd])).row);
      b.appendChild(el('div', {
        class: 'hint',
        text: `Preview: ${prefix}${String(start).padStart(pad, '0')}${suffix}`,
      }));
      pos.onchange = () => { position = pos.value; };
      fs.oninput = () => { fontSize = Number(fs.value); };
      col.oninput = () => { color = col.value; };
      mg.oninput = () => { margin = Number(mg.value); };
    },
  });
  if (!ok) return;
  doc.stamps.push({
    id: 'st' + Math.random().toString(36).slice(2, 8),
    kind: position,
    parts: [{ text: `${prefix}{bates}${suffix}`, align: 'right' }],
    fontSize, color: hexToRgb(color), margin, behind: false,
    from: Number(range.from.value), to: Number(range.to.value), odd: range.odd.value,
    start, step, pad,
  });
  pushHistory('bates');
  emit('stamps');
}

/* ── Live preview of stamps on the page ─────────────────────────────────── */

export function stampPageInRange(st, pageNumber) {
  const from = st.from || 1, to = st.to || 1e9;
  if (pageNumber < from || pageNumber > to) return false;
  if (st.odd === 'odd' && pageNumber % 2 === 0) return false;
  if (st.odd === 'even' && pageNumber % 2 === 1) return false;
  return true;
}

export function stampTextForPage(st, pageNumber, totalPages, docName) {
  const tokens = {
    page: pageNumber,
    pages: totalPages,
    date: new Date().toLocaleDateString(),
    time: new Date().toLocaleTimeString(),
    filename: docName || 'document.pdf',
    author: state.author || '',
    bates: String((st.start ?? 1) + (pageNumber - (st.from || 1)) * (st.step ?? 1)).padStart(st.pad ?? 4, '0'),
  };
  const exp = (s) => String(s || '').replace(/\{(\w+)\}/g, (_, k) => String(tokens[k] ?? ''));
  return exp;
}

export function renderStampPreviews(parent, i, s) {
  const doc = activeDoc();
  if (!doc) return;
  const dims = pageDims(i);
  const pw = dims.w * s, ph = dims.h * s;
  for (const st of doc.stamps || []) {
    if (!stampPageInRange(st, i + 1)) continue;
    const col = rgbToCss(st.color || [0.4, 0.4, 0.4], 1);
    if (st.kind === 'watermark') {
      if (st.image) {
        parent.appendChild(svgEl('image', {
          x: pw * 0.15, y: ph * 0.3, width: pw * 0.7, height: ph * 0.4,
          href: st.image, preserveAspectRatio: 'xMidYMid meet',
          opacity: st.opacity ?? 0.18,
          transform: `rotate(${st.angle ?? 0} ${pw / 2} ${ph / 2})`,
        }));
      } else if (st.text) {
        parent.appendChild(svgEl('text', {
          x: pw / 2, y: ph / 2, fill: col, opacity: st.opacity ?? 0.16,
          'font-size': (st.fontSize || 52) * s * 0.75, 'text-anchor': 'middle', 'font-weight': '700',
          'font-family': 'Helvetica,Arial,sans-serif',
          transform: `rotate(${st.angle ?? -45} ${pw / 2} ${ph / 2})`,
        }, [document.createTextNode(st.text)]));
      }
      continue;
    }
    const size = (st.fontSize || 10) * s;
    const margin = (st.margin ?? 28) * s;
    const isFooter = st.kind === 'footer' || st.kind === 'bates';
    const y = isFooter ? ph - margin : margin + size;
    for (const part of st.parts || []) {
      const txt = stampTextForPage(st, i + 1, doc.numPages, doc.name)(part.text);
      if (!txt) continue;
      const x = part.align === 'center' ? pw / 2 : part.align === 'right' ? pw - margin : margin;
      parent.appendChild(svgEl('text', {
        x, y, fill: col, 'font-size': size, 'font-family': 'Helvetica,Arial,sans-serif',
        'text-anchor': part.align === 'center' ? 'middle' : part.align === 'right' ? 'end' : 'start',
      }, [document.createTextNode(txt)]));
    }
  }
}
