import { readFileSync, readdirSync } from 'node:fs';

const DIR = 'src/renderer/js';
const files = readdirSync(DIR).filter(f => f.endsWith('.js'));
const exportsMap = {};

for (const f of files) {
  const raw = readFileSync(`${DIR}/${f}`, 'utf8');
  const names = new Set();
  for (const m of raw.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  for (const m of raw.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (let part of m[1].split(',')) {
      part = part.trim();
      if (!part) continue;
      const as = part.split(/\s+as\s+/);
      names.add((as[1] || as[0]).trim());
    }
  }
  exportsMap[f] = names;
}

/** Blank out comments, strings, template literals and regex literals while
 *  preserving length and newlines, so call-site scanning never trips over text
 *  that only looks like code. */
function stripLiterals(src) {
  const n = src.length;
  let out = '';
  let i = 0;
  let prev = '';              // last significant char, to spot regex starts
  const blank = (k) => { out += src[k] === '\n' ? '\n' : ' '; };
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && src[i + 1] === '*') {
      let k = i + 2;
      while (k < n && !(src[k] === '*' && src[k + 1] === '/')) { blank(k); k++; }
      k = Math.min(k + 2, n);
      i = k;
      continue;
    }
    if (c === '/' && /[=(,:;[!&|?{}%+\-*<~^]/.test(prev)) {
      let k = i + 1, inClass = false;
      while (k < n) {
        const ch = src[k];
        if (ch === '\\') { k += 2; continue; }
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) { k++; break; }
        else if (ch === '\n') break;
        k++;
      }
      while (i < k) { blank(i); i++; }
      while (i < n && /[dgimsuvy]/.test(src[i])) { out += ' '; i++; }
      prev = '/';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      let k = i + 1;
      while (k < n) {
        if (src[k] === '\\') { k += 2; continue; }
        if (src[k] === q) { k++; break; }
        k++;
      }
      while (i < k && i < n) { blank(i); i++; }
      prev = q;
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

/** Identifiers every environment provides. */
const GLOBALS = new Set([
  'console', 'document', 'window', 'Math', 'JSON', 'Object', 'Array', 'String',
  'Number', 'Boolean', 'Set', 'Map', 'WeakMap', 'Date', 'Promise', 'Error', 'TypeError',
  'RangeError', 'SyntaxError', 'isNaN', 'parseInt', 'parseFloat', 'setTimeout',
  'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame',
  'Uint8Array', 'Int8Array', 'Uint16Array', 'Int32Array', 'Float32Array', 'Uint32Array',
  'ArrayBuffer', 'TextEncoder', 'TextDecoder', 'atob', 'btoa', 'performance', 'localStorage',
  'navigator', 'alert', 'confirm', 'prompt', 'structuredClone', 'AbortController', 'AbortSignal',
  'fetch', 'Blob', 'File', 'FileReader', 'URL', 'URLSearchParams', 'crypto', 'globalThis',
  'HTMLElement', 'Element', 'Node', 'SVGSVGElement', 'SVGElement', 'Image',
  'ResizeObserver', 'IntersectionObserver', 'MutationObserver', 'DOMParser', 'XMLSerializer',
  'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'WheelEvent',
  'CSS', 'getComputedStyle', 'Worker', 'WebSocket', 'FormData', 'Headers', 'Request',
  'Response', 'Intl', 'RegExp', 'Function', 'Symbol', 'BigInt', 'Proxy', 'Reflect',
  'undefined', 'null', 'true', 'false', 'this', 'super', 'require', 'module', 'exports',
  'process', '__dirname', '__filename', 'arguments', 'queueMicrotask', 'reportError',
  'screen', 'location', 'history', 'parent', 'top', 'self',
  'ImageData', 'OffscreenCanvas', 'Path2D', 'TextMetrics', 'NodeList', 'HTMLCollection',
  'DocumentFragment', 'matchMedia', 'SpeechSynthesisUtterance', 'speechSynthesis',
  'open', 'close', 'focus', 'blur', 'print',
  'decodeURIComponent', 'encodeURIComponent', 'isFinite', 'NaN', 'Infinity', 'Infinity',
]);

/** Reserved words and control-flow constructs: legal before a `(` but never
 *  imports. */
const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'instanceof', 'in',
  'of', 'new', 'delete', 'void', 'yield', 'await', 'throw', 'case', 'do', 'else',
  'function', 'class', 'const', 'let', 'var', 'async', 'export', 'import', 'default',
]);

let problems = 0;
let checked = 0;
for (const f of files) {
  const raw = readFileSync(`${DIR}/${f}`, 'utf8');
  const src = stripLiterals(raw);
  const lineOf = (idx) => raw.slice(0, idx).split('\n').length;

  /* 1 - every named import must exist in its target module. Parsed from the
          raw source because stripping blanks the module specifier strings. */
  const bound = new Set();
  const namespaces = new Set();
  for (const m of raw.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    // "exportedName as localName": validate the exported name, bind the local one.
    const pairs = m[1].split(',').map((part) => {
      const a = part.trim().split(/\s+as\s+/);
      return { src: (a[0] || '').trim(), local: (a[1] || a[0] || '').trim() };
    }).filter((p2) => p2.src);
    const target = m[2].replace(/^\.\//, '');
    pairs.forEach((pr) => bound.add(pr.local));
    if (!target.endsWith('.js') || target.startsWith('/')) continue;
    const ex = exportsMap[target];
    if (!ex) { console.log(`[${f}] imports from missing file ./${target}`); problems++; continue; }
    for (const pr of pairs) {
      if (!ex.has(pr.src)) { console.log(`[${f}] imports '${pr.src}' from ./${target} - NOT EXPORTED`); problems++; }
    }
  }
  for (const m of raw.matchAll(/import\s*\*\s*as\s+([A-Za-z0-9_$]+)\s*from/g)) namespaces.add(m[1]);
  for (const m of raw.matchAll(/import\s+([A-Za-z0-9_$]+)\s*(?:,\s*\{[^}]*\})?\s*from\s*['"]/g)) bound.add(m[1]);

  /* Lazy modules are pulled in with `await import(...)`, so those names are
     perfectly bound even though no static import names them. */
  for (const m of raw.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*await\s+import\(/g)) {
    for (const part of m[1].split(',')) {
      const nm = part.trim().split(/\s+as\s+/)[0].trim();
      if (nm) bound.add(nm);
    }
  }

  /* Names introduced by parameter lists (callbacks, destructuring) and by
     object-literal method definitions are bindings too. */
  const extra = new Set();
  const rxFn = /(?:function\s*\*?\s*[A-Za-z0-9_$]*\s*)?\(([^()]*)\)\s*(?:=>|\{)/g;
  let pm;
  while ((pm = rxFn.exec(raw)) !== null) {
    for (const part of pm[1].split(',')) {
      const seg = part.replace(/[{}[\].\s]/g, ' ').trim().split(/\s+/).pop();
      if (seg && /^[A-Za-z0-9_$]+$/.test(seg) && seg !== 'async') extra.add(seg);
    }
  }
  for (const m of raw.matchAll(/[{,;\n]\s*(?:async\s+)?([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{/g)) extra.add(m[1]);
  {
    const rx = /(?:const|let|var)\s*\{/g;
    let dm;
    while ((dm = rx.exec(raw)) !== null) {
      let depth = 1, k = dm.index + dm[0].length;
      while (k < raw.length && depth > 0) {
        if (raw[k] === '{') depth++;
        else if (raw[k] === '}') depth--;
        k++;
      }
      const body = raw.slice(dm.index + dm[0].length, k - 1).replace(/\{[^{}]*\}/g, ',');
      for (const part of body.split(',')) {
        const seg = part.trim();
        if (!seg) continue;
        const dot = seg.split(':').pop().split('=')[0].trim();
        if (/^[A-Za-z0-9_$]+$/.test(dot)) extra.add(dot);
      }
    }
  }

  const isLocal = (nm) => {
    if (bound.has(nm) || namespaces.has(nm) || GLOBALS.has(nm) || KEYWORDS.has(nm) || extra.has(nm)) return true;
    if (!/^[A-Za-z0-9_$]+$/.test(nm)) return false;
    const re = new RegExp(
      String.raw`(?:^|[;\n\r{}])\s*(?:export\s+)?(?:async\s+)?(?:const|let|var|function\*?|class)\s+${nm}\b`
    );
    return re.test(src) || re.test(raw);
  };

  /* 2 - every CALLED identifier must resolve. The lookbehind skips method
          calls (`.push(`) and member access. */
  const callRe = /(?<![.\w$])([a-z][A-Za-z0-9_$]*)\s*\(/g;
  const seen = new Set();
  let m;
  while ((m = callRe.exec(src)) !== null) {
    const nm = m[1];
    if (seen.has(nm)) continue;
    seen.add(nm);
    checked++;
    if (!isLocal(nm)) {
      console.log(`[${f}:${lineOf(m.index)}] call to '${nm}' is not imported or declared here`);
      problems++;
    }
  }
}

if (problems) {
  console.log(`AUDIT FOUND ${problems} problem(s)`);
  process.exitCode = 1;
} else {
  console.log(`AUDIT OK: imports resolve, ${checked} call sites checked across ${files.length} files`);
}
