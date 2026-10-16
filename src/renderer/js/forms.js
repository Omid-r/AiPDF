import { state, activeDoc, pushHistory, emit } from './store.js';
import { pageEl, rectToCss, currentScale, clientToPdf } from './viewer.js';
import { readFormFields } from './pdfwrite.js';
import { el, toast } from './util.js';
import { showModal, confirmDialog } from './dialog.js';

export async function loadFormFields(doc) {
  try {
    const fields = await readFormFields(doc.bytes);
    doc.fields = (fields || []).map((f) => ({
      name: f.name,
      type: (f.type || '').replace('PDF', '').replace('Field', '') || 'Text',
      value: f.value ?? (f.checked ? 'true' : ''),
      options: f.options || [],
      widgets: f.widgets || [],
      page: f.widgets && f.widgets[0] ? f.widgets[0].page ?? 0 : 0,
      rect: f.widgets && f.widgets[0] ? f.widgets[0].rect : [60, 700, 260, 722],
    }));
  } catch (e) {
    console.warn('form read failed', e);
    doc.fields = [];
  }
}

export function renderFormFields(i) {
  const doc = activeDoc();
  const rec = pageEl(i);
  if (!doc || !rec) return;
  rec.formLayer.innerHTML = '';
  const s = currentScale();
  for (const f of doc.fields || []) {
    if (f.page !== i) continue;
    const c = rectToCss(i, f.rect);
    const x = c[0], y = c[1], w = Math.max(10, c[2] - c[0]), h = Math.max(10, c[3] - c[1]);
    const wrap = el('div', {
      class: `field-widget ${f.type.toLowerCase()}`,
      style: { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' },
      title: f.name,
    });
    if (f.type === 'CheckBox' || f.type === 'RadioGroup') {
      const inp = el('input', { type: 'checkbox' });
      inp.checked = String(f.value) === 'true' || f.value === true;
      inp.onchange = () => { f.value = inp.checked ? 'true' : 'false'; markDirtyField(f); };
      wrap.appendChild(inp);
    } else if (f.type === 'Dropdown' || f.type === 'OptionList') {
      const sel = el('select', { style: { height: '100%', border: '0', background: 'transparent' } });
      sel.appendChild(el('option', { value: '', text: '' }));
      (f.options || []).forEach((o) => sel.appendChild(el('option', { value: o, text: o })));
      sel.value = f.value || '';
      sel.onchange = () => { f.value = sel.value; markDirtyField(f); };
      wrap.appendChild(sel);
    } else {
      const ta = el('textarea', {
        style: { height: '100%', border: '0', background: 'transparent', resize: 'none', fontSize: Math.max(8, 10 * s) + 'px' },
      });
      ta.value = f.value || '';
      ta.oninput = () => { f.value = ta.value; markDirtyField(f); };
      ta.onfocus = () => wrap.classList.add('focus');
      ta.onblur = () => wrap.classList.remove('focus');
      wrap.appendChild(ta);
    }
    rec.formLayer.appendChild(wrap);
  }
}

function markDirtyField(f) {
  const doc = activeDoc();
  if (!doc) return;
  doc.dirty = true;
  emit('dirty', doc);
}

/* ── Creating fields ────────────────────────────────────────────────────── */

const FIELD_LABELS = {
  text: 'Text field',
  checkbox: 'Checkbox',
  radio: 'Radio group',
  dropdown: 'Dropdown',
  signature: 'Signature field',
};

export async function startFieldPlacement(type) {
  const doc = activeDoc();
  if (!doc) return;
  let name = '';
  let options = '';

  const ok = await showModal({
    title: `Add ${FIELD_LABELS[type] || 'field'}`,
    width: 'narrow',
    body: (b) => {
      const i = el('input', { type: 'text', value: `${type}Field${(doc.fields?.length || 0) + 1}` });
      b.appendChild(el('div', { class: 'hint', text: 'Field name', style: { marginBottom: '4px' } }));
      b.appendChild(i);
      i.oninput = () => { name = i.value; };
      name = i.value;
      if (type === 'dropdown' || type === 'radio') {
        const o = el('input', { type: 'text', placeholder: 'Option A, Option B, Option C' });
        b.appendChild(el('div', { class: 'hint', text: 'Options (comma separated)', style: { margin: '10px 0 4px' } }));
        b.appendChild(o);
        o.oninput = () => { options = o.value; };
      }
      setTimeout(() => i.focus(), 20);
    },
  });
  if (!ok || !name) return;
  state.pendingFormField = {
    type,
    name,
    options: options ? options.split(',').map((s) => s.trim()).filter(Boolean) : [],
  };
  state.tool = 'select';
  emit('tool');
  toast('Drag on the page to place the field', 'info', 4000);
}

export function createFieldAt(page, rect) {
  const doc = activeDoc();
  if (!doc || !state.pendingFormField) return;
  const { type, name, options } = state.pendingFormField;
  doc.newFields = doc.newFields || [];
  doc.newFields.push({ type, name, page, rect, options });
  doc.fields = doc.fields || [];
  doc.fields.push({
    name,
    type: type === 'checkbox' ? 'CheckBox' : type === 'dropdown' ? 'Dropdown' : type === 'radio' ? 'RadioGroup' : 'TextField',
    value: '',
    options,
    page,
    rect,
    isNew: true,
  });
  state.pendingFormField = null;
  pushHistory('add field');
  emit('annots');
  toast(`${name} added — it is written into the file on save`, 'ok');
}

export async function exportFormData() {
  const doc = activeDoc();
  if (!doc || !doc.fields || !doc.fields.length) return toast('This document has no form fields.', 'warn');
  const data = doc.fields.map((f) => ({ name: f.name, type: f.type, value: f.value }));
  const json = JSON.stringify(data, null, 2);
  const csv = ['name,type,value']
    .concat(data.map((d) => `${JSON.stringify(d.name)},${d.type},${JSON.stringify(String(d.value ?? ''))}`))
    .join('\r\n');
  let format = 'json'; // captured from the control — the modal DOM is gone by the time it resolves
  const fmt = await showModal({
    title: 'Export form data',
    width: 'narrow',
    body: (b) => {
      const sel = el('select', {});
      sel.append(el('option', { value: 'json', text: 'JSON' }), el('option', { value: 'csv', text: 'CSV' }));
      sel.onchange = () => { format = sel.value; preview.value = format === 'csv' ? csv : json; };
      b.appendChild(el('div', { class: 'form-row' }, [el('label', { text: 'Format' }), el('div', { class: 'fr-c' }, [sel])]));
      const preview = el('textarea', { class: 'mono', style: { minHeight: '150px', fontSize: '11px' } });
      preview.value = json;
      b.appendChild(preview);
    },
    buttons: [
      { label: 'Copy', value: 'copy', kind: 'ghost' },
      { label: 'Save…', value: 'save', kind: 'primary', default: true },
    ],
  });
  const chosen = format === 'csv' ? csv : json;
  if (fmt === 'copy') {
    try { await navigator.clipboard.writeText(chosen); toast('Copied to clipboard', 'ok'); } catch { toast('Copy failed', 'err'); }
    return;
  }
  if (fmt !== 'save') return;
  const path = await window.api.saveDialog({
    defaultPath: (doc.name || 'form').replace(/\.pdf$/i, '') + '.' + format,
    filters: [{ name: 'Data', extensions: [format] }],
  });
  if (!path) return;
  const res = await window.api.writeFile(path, new TextEncoder().encode(chosen));
  toast(res.ok ? 'Form data exported' : 'Export failed: ' + res.error, res.ok ? 'ok' : 'err');
}

/* ── Importing form data (Foxit Forms > Import) ─────────────────────────── */

/** Read a PDF literal string starting at `start` (text[start] === '('),
 *  honouring backslash escapes and nested parentheses. */
function readParenString(text, start) {
  let depth = 0;
  let out = '';
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      const nx = text[i + 1];
      if (nx === undefined) return null;
      out += nx === 'n' ? '\n' : nx === 'r' ? '\r' : nx === 't' ? '\t' : nx === '\n' ? '' : nx;
      i++;
      continue;
    }
    if (ch === '(') { depth++; if (depth > 1) out += ch; continue; }
    if (ch === ')') { depth--; if (depth === 0) return out; out += ch; continue; }
    out += ch;
  }
  return null;
}

/** Parse the /T (name) /V (value) pairs out of an FDF file. */
export function parseFdf(text) {
  const tokens = [];
  const rx = /\/([TV])\s*\(/g;
  let m;
  while ((m = rx.exec(text))) {
    const v = readParenString(text, m.index + m[0].length - 1);
    if (v != null) tokens.push([m[1], v]);
  }
  const out = [];
  let cur = null;
  for (const [k, v] of tokens) {
    if (k === 'T') { if (cur) out.push(cur); cur = { name: v, value: '' }; }
    else if (cur) cur.value = v;
  }
  if (cur) out.push(cur);
  return out;
}

/** Parse the CSV this app writes (name,type,value with JSON-quoted values).
 *  A cell that starts and ends with a quote is JSON-parsed, so escapes such
 *  as \n inside a value survive the round trip. */
export function parseCsv(text) {
  const rows = [];
  let cells = [];
  let cell = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      cell += ch;
      // consume until the closing quote; a doubled quote is one literal.
      for (i++; i < text.length; i++) {
        if (text[i] === '"' && text[i + 1] === '"') { cell += '""'; i++; continue; }
        if (text[i] === '"') { cell += '"'; break; }
        cell += text[i];
      }
      continue;
    }
    if (ch === ',') { cells.push(cell); cell = ''; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      cells.push(cell); cell = '';
      if (cells.some((c) => c.trim() !== '')) rows.push(cells);
      cells = [];
      continue;
    }
    cell += ch;
  }
  cells.push(cell);
  if (cells.some((c) => c.trim() !== '')) rows.push(cells);
  const deq = (s) => {
    const t = s.trim();
    if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
      try { return JSON.parse(t); } catch { return t.slice(1, -1); }
    }
    return t;
  };
  if (!rows.length) return [];
  const head = rows[0].map((h) => deq(h).toLowerCase());
  const nameIdx = Math.max(0, head.findIndex((h) => h === 'name'));
  const valIdx = Math.max(1, head.findIndex((h) => h === 'value'));
  return rows.slice(1).map((r) => ({ name: deq(r[nameIdx] || ''), value: deq(r[valIdx] ?? '') }));
}

/** Normalise an imported value into the field model's representation. */
export function normFieldValue(field, value) {
  const v = value == null ? '' : String(value);
  const t = String(field.type || '').toLowerCase();
  if (t === 'checkbox' || t === 'radio' || t === 'radiogroup') {
    return /^(1|true|yes|on)$/i.test(v.trim()) ? 'true' : '';
  }
  return v;
}

export async function importFormData() {
  const doc = activeDoc();
  if (!doc || !doc.fields || !doc.fields.length) return toast('This document has no form fields.', 'warn');
  const paths = await window.api.openDialog({ title: 'Choose form data (JSON, CSV or FDF)' });
  if (!paths || !paths[0]) return;
  const r = await window.api.readFile(paths[0]);
  if (!r.ok) return toast('Could not read that file.', 'err');
  const text = new TextDecoder().decode(r.data);
  let rows = [];
  try {
    if (text.trimStart().startsWith('%FDF')) rows = parseFdf(text);
    else if (/^\s*[[{]/.test(text)) {
      const parsed = JSON.parse(text);
      rows = Array.isArray(parsed) ? parsed : [parsed];
    } else rows = parseCsv(text);
  } catch (e) {
    return toast('That file is not valid form data: ' + (e.message || e), 'err');
  }
  const byName = new Map(doc.fields.map((f) => [f.name, f]));
  let applied = 0;
  for (const row of rows || []) {
    const f = byName.get(String(row.name || ''));
    if (!f) continue;
    f.value = normFieldValue(f, row.value);
    applied++;
  }
  if (!applied) return toast('No field names in that file match this document.', 'warn');
  doc.dirty = true;
  emit('dirty', doc);
  for (let i = 0; i < doc.numPages; i++) renderFormFields(i);
  toast(`Imported ${applied} field value(s)`, 'ok');
}

/** Foxit Forms > Reset Form: clear every field back to empty. */
export async function resetForm() {
  const doc = activeDoc();
  if (!doc || !doc.fields || !doc.fields.length) return toast('This document has no form fields.', 'warn');
  const ok = await confirmDialog('Reset every form field to its empty state?', { title: 'Reset form', danger: true });
  if (!ok) return;
  for (const f of doc.fields) f.value = '';
  doc.dirty = true;
  emit('dirty', doc);
  for (let i = 0; i < doc.numPages; i++) renderFormFields(i);
  toast('Form reset', 'ok');
}
