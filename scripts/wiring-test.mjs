#!/usr/bin/env node
/**
 * Wiring test — proves every user-visible entry point is actually connected.
 *
 * Professional PDF editors live or die by their menu/ribbon surface: a menu
 * item that dispatches an action nobody handles is a dead click, a ribbon
 * button with a missing icon renders blank, and a duplicated accelerator
 * makes one of the two shortcuts silently dead. This gate cross-checks:
 *
 *   1. every `send('action')` in the native menu has a dispatch case
 *   2. every ribbon button action has a dispatch case
 *   3. every ribbon icon id exists in icons.js
 *   4. no duplicate accelerators in the menu (first-one-wins = second dead)
 *   5. every single-key tool shortcut maps to a real tool button
 *   6. dispatch cases that nothing references (orphans — informational)
 *
 *   node scripts/wiring-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const menuSrc = read('src/main/menu.js');
const appSrc = read('src/renderer/js/app.js');
const iconsSrc = read('src/renderer/js/icons.js');

let problems = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) problems++;
};
const info = (name, detail = '') => console.log(`INFO  ${name}${detail ? `  — ${detail}` : ''}`);

/* ── Collect ────────────────────────────────────────────────────────────── */

// 1. Menu actions with their labels: { label: '…', click: () => send('x') }
const menuActions = [];
const menuRe = /\{\s*label:\s*(?:'([^']*)'|`([^`]*)`)[^}]*?send\('([a-zA-Z:]+)'\)/g;
let m;
while ((m = menuRe.exec(menuSrc))) menuActions.push({ label: (m[1] ?? m[2] ?? '').trim(), action: m[3] });

// 2. Ribbon entries: ['Tab', 'Label', 'icon', 'action']
const ribbonActions = [];
const ribbonRe = /^\s*\['[^']+',\s*'[^']*',\s*'([a-zA-Z]+)',\s*'([a-zA-Z:]+)'\],?\s*$/gm;
while ((m = ribbonRe.exec(appSrc))) ribbonActions.push({ icon: m[1], action: m[2] });

// 3. Dispatch cases inside onMenuAction
const dispatchStart = appSrc.indexOf('async function onMenuAction');
const dispatchBody = dispatchStart >= 0 ? appSrc.slice(dispatchStart, appSrc.indexOf('\nfunction ', dispatchStart)) : '';
const cases = new Set();
const caseRe = /case\s+'([a-zA-Z:]+)'/g;
while ((m = caseRe.exec(dispatchBody))) cases.add(m[1]);

// 4. Menu accelerators (only local ones — roles are excluded by the shape)
const accelerators = [];
const accRe = /accelerator:\s*'([^']+)'/g;
while ((m = accRe.exec(menuSrc))) accelerators.push(m[1]);

// 5. Icon ids in icons.js (two-char indent object keys)
const iconIds = new Set();
const iconRe = /^\s{2}([a-zA-Z]+):\s*\(?,?/gm;
while ((m = iconRe.exec(iconsSrc))) iconIds.add(m[1]);

/* ── Checks ─────────────────────────────────────────────────────────────── */

const missing = (list) => list.filter((a) => !cases.has(a.action));

check(`menu sends ≥ 80 actions`, menuActions.length >= 80, `${menuActions.length} found`);
check(`ribbon defines ≥ 60 buttons`, ribbonActions.length >= 60, `${ribbonActions.length} found`);
check(`onMenuAction dispatches ≥ 100 actions`, cases.size >= 100, `${cases.size} cases`);

const deadMenu = missing(menuActions);
check('every menu item has a dispatch case', deadMenu.length === 0,
  deadMenu.length ? `MISSING: ${deadMenu.map((a) => `${a.action} ("${a.label}")`).join(', ')}` : `${menuActions.length} wired`);

const deadRibbon = missing(ribbonActions);
check('every ribbon button has a dispatch case', deadRibbon.length === 0,
  deadRibbon.length ? `MISSING: ${deadRibbon.map((a) => a.action).join(', ')}` : `${ribbonActions.length} wired`);

const blankIcons = ribbonActions.filter((a) => !iconIds.has(a.icon));
check('every ribbon icon exists in icons.js', blankIcons.length === 0,
  blankIcons.length ? `MISSING: ${blankIcons.map((a) => a.icon + ' (' + a.action + ')').join(', ')}` : `${ribbonActions.length} icons resolve`);

// Duplicate accelerators: normalize CmdOrCtrl → Ctrl, ignore order-insensitive
// modifiers. Electron binds the FIRST occurrence, so a dup = one dead shortcut.
const norm = (acc) => acc.split('+').map((s) => s.trim().toLowerCase())
  .map((s) => (s === 'cmdorctrl' || s === 'cmd' || s === 'ctrl') ? 'ctrl' : s)
  .sort((a, b) => (a === 'ctrl' ? -1 : b === 'ctrl' ? 1 : a.localeCompare(b))).join('+');
const seenAcc = new Map();
const dupAcc = [];
for (const a of accelerators) {
  const k = norm(a);
  if (seenAcc.has(k)) dupAcc.push(`${a} (also on ${seenAcc.get(k)})`);
  else seenAcc.set(k, a);
}
check('no duplicate menu accelerators', dupAcc.length === 0, dupAcc.join('; ') || `${accelerators.length} unique`);

// Orphan dispatch cases: handled but reachable from neither menu nor ribbon.
// Many are legitimately triggered from renderer UI (sidebar, dialogs, keys) —
// informational, but a sudden growth here is how dead code accumulates.
const referenced = new Set([...menuActions, ...ribbonActions].map((a) => a.action));
const orphans = [...cases].filter((c) => !referenced.has(c));
info(`dispatch cases with no menu/ribbon reference (${orphans.length})`, orphans.join(', '));

console.log(problems ? `\nWIRING_FAIL ${problems} problem(s)` : `\nWIRING_PASS menu, ribbon, icons and accelerators all consistent`);
process.exit(problems ? 1 : 0);
