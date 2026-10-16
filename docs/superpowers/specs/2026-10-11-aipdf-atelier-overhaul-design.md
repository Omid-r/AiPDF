# AiPDF Editor — Atelier Overhaul (S1 Correctness · S2 Interaction · S3 Visual)

**Date:** 2026-10-11
**Status:** approved to implement (owner delegated: "give me new version of the application after completion")
**Direction chosen:** C · Atelier — warm, editorial, document-first. Warm ivory light is the default; warm charcoal dark is a first-class equal, not an inversion.

---

## 1. Goal

Ship a new packaged version of AiPDF Editor in which (a) every advertised feature actually
works, (b) the interface is operable by keyboard and assistive tech, and (c) the visual
language is a coherent premium system instead of 322 ad-hoc rules.

This spec covers S1 + S2 + S3 as one design, implemented in three phases. S4 (new PDF
capabilities) and the final packaging step are separate and follow.

## 2. Non-negotiable constraints

These are architectural facts about the project, not preferences:

- **No framework, no bundler, no Tailwind.** The renderer is native ES modules served over a
  localhost HTTP server (`src/main/server.js`). All CSS stays hand-written.
- **Engines are fixed:** `pdfjs-dist` 4.10.x (read/render/text/outline/annotation reading),
  `@cantoo/pdf-lib` 2.11.x (writing, AES-256), `@pdf-lib/fontkit`, `tesseract.js` 5.
- **Electron 33, Windows-first.** No invented APIs — every Electron/Chromium call must exist
  in 33. macOS-only roles (`recentDocuments`, `front`, `zoom`, `setRepresentedFilename`) are
  no-ops here and must not be relied on.
- **Annotation model stays in PDF space** with an SVG overlay; on-screen geometry converts back
  to PDF space at save. Do not change the coordinate contract.
- **New vendor assets** must go through `server.js`'s `/v/` mapping and `scripts/vendor.js`.
- **Every phase ends with the app verified launching and visible**, via `scripts/launch-test.mjs`.

## 3. Phase 1 — S1 Correctness

Make the advertised feature set real. Each item lists the defect and the intended behaviour.

### 3.1 Settings never restored (critical)
`store.js:54-56` merges `boot.settings`, but main.js returns the *whole* settings file
(`{settings:{…}, recents:[…]}`), so real values sit one level deeper and are never spread.
Result: theme, author, defaultZoom, tool, colour, opacity, fontSize, borderWidth, ocrLang,
newTextFont, sidebar state **and the entire AI config including the API key** are lost on every
restart; only `recents` survives.

**Fix:** read `boot.settings.settings`, merge over `DEFAULT_SETTINGS`, then apply the restored
values into runtime `state` (`app.js:46`, `store.js:88-91` currently snapshot defaults at module
load, before settings arrive). Remove the dead `process.env.USERNAME` fallback (`store.js:61` —
`process` does not exist in the renderer main world); take the author default from
`api.getPath('home')`-independent main-side info or leave it blank.

**Verify:** new headless test — set a setting, relaunch, assert it came back (including `ai.apiKey`).

### 3.2 Form fields cannot be interacted with (critical)
`viewer.js:98` creates the form layer with inline `pointerEvents:'none'`, and
`.field-widget`/its inputs (`app.css:607-619`) never re-enable it. `pointer-events` inherits, so
every rendered AcroForm widget is inert. AcroForm filling — a headline feature — is dead.

**Fix:** keep the layer non-interactive only while a markup tool is active; enable
`pointer-events:auto` on widgets in select/hand mode. Drive it from the existing tool state so
annotation drawing still gets the mouse.

**Verify:** functional test — open a form fixture, assert `document.elementFromPoint` over a
widget returns the input, type into it, save, reopen, assert the value persisted.

### 3.3 Encrypted documents cannot be saved; "Remove security" is dead (critical)
`doc.passwordProtected` is initialised `false` (`store.js:131`) and never set true anywhere.
`buildPdf` then calls `PDFDocument.load(doc.bytes)` with no password and no
`ignoreEncryption`, so pdf-lib throws `EncryptedPDFError` on any save of an encrypted file —
even one opened with only an owner password. Knock-on effects: `removeSecurity` (`app.js:775`)
always toasts "not password protected"; the `buildDocBytes` guard (`app.js:648`) is unreachable;
the status bar never shows the lock (`app.js:1048`).

**Fix:** detect encryption at open (pdf.js `password`/`unsupportedFeature` path plus a pdf-lib
load probe), record `passwordProtected` and the supplied password on the doc, pass them into
`buildPdf`, and wire `removeSecurity` to re-save without encryption.

**Verify:** smoke test — encrypt a fixture, open with password, save, assert the save succeeds;
then remove security and assert the result opens with no password.

### 3.4 Single-letter accelerators hijack typing (critical)
`menu.js:208-231` registers 18 bare-letter native accelerators (V H U S Q N C T R O L A P M E K
I X). Native accelerators fire before the page and have no editable-field guard, so typing in
the search bar, a form field or the inline text editor switches tools and swallows the key. The
renderer's own guarded map (`app.js:1576-1584`) is dead because the menu already consumed it.

**Fix:** remove bare-letter accelerators from the native menu; keep one guarded keymap in the
renderer as the single source of truth (see 4.1). Native menu retains only chord accelerators
(Ctrl/Cmd/Alt based), which do not conflict with typing.

### 3.5 Ctrl+K double-bound; documented shortcuts are wrong (major)
`menu.js:173` binds Ctrl+K → Preferences while `app.js:1569` binds Ctrl+K → command palette;
both fire. `index.html:23` and `app.js:1241` claim Ctrl+D is dark mode (it is Document
Properties — `menu.js:151`; dark mode is Ctrl+Shift+D). `index.html:55` claims Ctrl+K is the
palette.

**Fix:** Ctrl+K → command palette (the modern convention); Preferences moves to Ctrl+, .
Generate the in-app shortcut help and the title tooltips **from** the keymap table so they can
never drift again.

### 3.6 Menu items that do not do what they say (major)
- `ocr:all` ("OCR — All Scanned Pages") only calls `setSidebar('ocr')` (`app.js:1380-1384`);
  the actual run-all is a manual sidebar button (`sidebar.js:412`). → make it run OCR on all
  scanned pages, reporting progress through the busy surface (4.6).
- `protect:redactAll` is labelled "Apply & Sanitize" but calls `applyRedactions(false)`
  (`app.js:1433`) — apply only; sanitize is ribbon-only (`app.js:368`). → make the menu item
  match its label, or split into two items with honest labels.
- `stamp:headerFooter` hardcodes `headerFooterDialog('header')` (`app.js:1423`); the footer
  variant is ribbon-only. → open the dialog with both tabs reachable.
- File ▸ Open Recent uses the macOS-only `recentDocuments` role (`menu.js:134`) and is inert on
  Windows even though a working recents store exists. → build the submenu from `recents`,
  rebuild it when recents change, and handle clicks by opening the path.
- Window ▸ `zoom`/`front` roles (`menu.js:297,299`) are macOS-only no-ops. → remove on Windows.
- `page:insert` silently inserts a blank page despite the label "Insert Pages…"; `page:delete`
  deletes with no confirmation (the sidebar path does confirm — `sidebar.js:113`). → make the
  menu paths match the sidebar paths.

### 3.7 Measure annotations lose geometry on save (major)
`pdfwrite.js:294-297` writes `/L`, `/LE`, `/IT` only for `type==='line'||type==='arrow'`, but
`ANNOT_TYPES.measure === 'Line'` (`annots.js:23`), so a measure annotation is written as a
`/Line` with no coordinates and the `IT='LineDimension'` branch is unreachable. Only the
flattened appearance survives.

**Fix:** include `measure` in the line-geometry branch and set `/IT` correctly.
**Verify:** edit test — add a measure annotation, save, reopen, assert `/L` and `/IT` present.

### 3.8 Smaller defects
- `pdfwrite.js:290` — dead `a.inkList` branch; the model stores `a.paths`. Remove.
- `app.js:1627` — `import('./forms.js').then(...)` with no `.catch`; `viewer.js:198` —
  `renderPage(i)` called without await/catch. Both can surface as unhandled rejections.
- Silent `try/catch` that can hide data loss: `pdfwrite.js:363` (`drawText` unencodable glyphs),
  `pdfwrite.js:680-682`, `forms.js:19-22`, `store.js:68,71`. → keep the catch, but report
  through the error surface (4.6) instead of swallowing.
- `pdfwrite.js:722-738` — `renderRedactedPage` derives the page-size swap from
  `doc.pageRotate[i]` only, while `renderPageToCanvas` (`viewer.js:536`) rotates by
  `page.rotate + pageRotate[i]`; on pages with intrinsic `/Rotate`, sanitize boxes can land in
  the wrong place. → use the same combined rotation.
- `ai.js:867-877` — the AI settings dialog never writes `ai.provider`, so it is stuck at
  `'openai'` and the Ollama no-key branch is unreachable. `ai.enabled` is written but never
  read. → write provider, and either honour `enabled` or delete it.
- Dead settings declared but never read or written (`store.js:21,24,31,44`): `layout`,
  `contextOpen`, `stampFont`, `ai.autoCitations`. → wire them up or delete them; no zombies.
- Orphaned debug pages served from the renderer tree: `src/renderer/__renderprobe.html`,
  `__rp_a.html` … `__rp_d.html`. → delete.
- Dead IPC/preload surface never called by the renderer: `setTheme`, `zoom`, `getPath`,
  `messageBox`, `showInFolder`, `openPath`, `fileExists`, `fileInfo` and their main handlers.
  `setTheme` becomes live in 4.7; the rest are either wired up where this spec needs them or
  removed.

## 4. Phase 2 — S2 Interaction foundation

S3 re-skins these primitives, so they must exist first.

### 4.1 One shortcut registry
A single declarative table (id, keys, action, label, group, `when` predicate) is the only place
a shortcut is defined. The renderer keydown handler, the command palette, the shortcut-help
dialog, the ribbon tooltips and the native menu accelerators are all *generated* from it.
Editable-field guard lives in one place. This is what makes 3.4/3.5/4.2 impossible to reintroduce.

### 4.2 Focus and keyboard operability
- Visible `:focus-visible` ring on every interactive control (currently zero in the renderer).
- Remove the scattered `outline:none` (`app.css:188,247,346,451,488,519,615`) and replace with
  a token-driven ring that never disappears.
- Modal focus trap + `aria-modal` + focus restore to the invoking element (`dialog.js:13-98`
  currently does none of this, and focuses via `setTimeout(…,20)`); same for the command palette
  (`app.js:1154-1195`) and popovers (`dialog.js:149-164`).
- Roving tabindex / arrow-key navigation for the tool rail, mode tabs, document tabs, thumbnail
  list, and comment list.

### 4.3 Accessibility attributes
`role`, `aria-label`, `aria-pressed`/`aria-checked`/`aria-selected`, `aria-expanded`,
`aria-live` for toasts and the busy/error surface, `alt`/`aria-hidden` on decorative SVG.
Today the renderer has **zero** `aria-*`, `role=`, or `tabindex`. Target: every control in the
rail, ribbon, sidebar, tabs, dialogs and status bar is named and its state is exposed.

### 4.4 Context menus
None exist (zero `contextmenu` listeners). Add a real context-menu component and wire it to:
page canvas (select tool, rotate, extract, delete, insert, crop-later hook), thumbnails
(multi-select aware), annotations (edit, duplicate, delete, properties), document tabs (close,
close others, save, show in folder), and text selection (copy, highlight, ask AI). This replaces
the ribbon-only paths for destructive page ops and gives them a confirmation.

### 4.5 Panels and ribbon overflow
- Sidebar (`--w-side:274px`) and context panel (`--w-ctx:300px`) become drag-resizable with
  persisted widths, and collapse-to-rail. `min-width` currently equals `width`
  (`app.css:278,280`).
- The ribbon is `overflow-x:auto` with the scrollbar hidden (`app.css:207,209`), so groups clip
  silently at narrow widths. Replace with an explicit overflow affordance (edge fade +
  chevron, or a "More" overflow menu) and never hide the fact that content is cut off.
- Revive the zoom control: `.zoom-pill` is `display:none` and nothing ever adds `.on`
  (`app.css:438-444`), while `renderZoomOptions()` (`app.js:1060`) populates a select nobody can
  see. Either make it a real, reachable control or delete it — no dead UI.

### 4.6 Busy, progress and error surfaces
`setBusy()` (`app.js:1082-1087`) only rewrites text in the 28px status bar across 13 call sites;
there is no spinner, no progress bar (except OCR's), and `.st-err` (`app.css:435`) is defined but
never used. Add: a global busy/progress component (determinate where possible — OCR, save,
merge, batch), an error slot that surfaces the currently-swallowed failures from 3.8, and toast
variants that actually exist in CSS (`.info` is passed by 5 call sites but has no rule).

### 4.7 Undo affordance and theme→main sync
- Undo/Redo buttons have no disabled state (`renderChrome` never sets it; no `.qbtn:disabled`
  rule). Reflect history depth, and surface the history label that `pushHistory()` already
  receives (`app.js:1593`) but never shows.
- `applyTheme()` only toggles `body.dark` (`app.js:171-176`) and never calls `api.setTheme`
  (`preload.js:27` → `main.js:514`), so `nativeTheme.themeSource` stays `'system'` and the
  Windows caption glyph colour is frozen at window creation. Sync theme to main and call
  `setTitleBarOverlay` so caption symbols follow the theme.
- Kill the boot flash: `backgroundColor` (`main.js:67`) and the CSS `--bg-app`
  (`app.css:8,49`) disagree; make one drive the other.

### 4.8 Window chrome correctness
`.tb-spacer-native { width: 138px }` (`app.css:136`) is a magic number for 3×46px caption
buttons, `titleBarOverlay.height` is 36 in main (`main.js:74`) while `--h-title` is an
independent 36px literal in CSS (`app.css:36`), and `.palette { top: 74px }` (`app.css:512`)
hardcodes 36+36+2. Derive all of these from one source and inject the real overlay metrics from
main, so a chrome change cannot misalign the caption buttons.

## 5. Phase 3 — S3 Atelier visual system

### 5.1 Token architecture (three layers)
1. **Primitive** — raw palette values, never referenced by components.
2. **Semantic** — `--bg-app`, `--bg-sunken`, `--surface`, `--surface-raised`, `--border`,
   `--border-strong`, `--text-1/2/3`, `--accent`, `--accent-hover`, `--accent-text`,
   `--ok/--warn/--danger/--highlight`, `--ring`. Components reference only these.
3. **Component** — per-component overrides where genuinely needed.

Light (warm ivory) and dark (warm charcoal) are two semantic mappings over shared primitives,
switched by `data-theme` on `<html>` (replacing the `body.dark` class). No
`filter: invert(1) hue-rotate(180deg)` page-canvas hack (`app.css:359`).

Consolidate the current 33 hard-coded component colours into tokens — notably `#fff` used 12×
for on-accent text while `--accent-text` already exists, `#7b5bff` duplicated, three
re-encodings of `--ok`, three of `--warn`, and the split shadow inks
(`rgba(16,20,32,…)` light vs `rgba(0,0,0,…)` dark).

### 5.2 Scales
- **Type:** replace 16 ad-hoc sizes (8.5→30px, including half-pixel steps) with a scale
  (`--text-xs/sm/base/md/lg/xl/2xl`) and 3 weights from a real variable/system stack. Kill the
  non-standard 550/650/680 weights that snap unpredictably on non-variable Segoe UI. Serif
  (Georgia stack) is reserved for document identity and metadata, per Atelier.
- **Space:** replace 22 spacing literals with a 4px-based scale (`--space-1..10`).
- **Radius:** replace 16 values with `--radius-sm/md/lg/pill`.
- **Shadow:** elevation scale (`--elev-1..4`) with warm-tinted ink, replacing 7+7 split literals.
- **z-index:** a named scale (`--z-rail/ribbon/sidebar/popover/modal/palette/toast`) replacing
  the 6 magic numbers where modal(200) < popover(205) < palette(210).
- **Motion:** duration/easing tokens, and honour `prefers-reduced-motion` (currently four
  unconditional animations).

### 5.3 Component consolidation
- **One** button family with size and variant modifiers, replacing 6 near-identical square
  icon-button classes (`.icon-btn`, `.qbtn`, `.tbtn`, `.rail-btn`, `.zoom-pill button`,
  `.tab .t-close`) plus `.rbtn`, `.mini-btn`, `.mode-tab`, `.stamp-item`, `.ai-chip`, `.chip`,
  `.cite`, `.swatch`. Real `:hover/:focus-visible/:active/:disabled` on all of them.
- **One** toggle/switch component (currently three mechanisms: native checkbox in `.chk`,
  `label.cb`, and an `.active` class).
- **One** tab component (currently three implementations: document `.tab`, `.mode-tab`,
  dialog `.tabs-row`).
- Real **tooltips** (currently only native `title`), styled **sliders** and **colour pickers**
  (currently bare `input[type=range]`/`input[type=color]` with per-call-site inline styles at
  7 sites each), and a **list-item** primitive replacing the 8 bespoke item classes.
- Toast `.info` variant gets a rule.

### 5.4 Iconography
Keep `icons.js`'s 76-glyph 24×24 stroke set as the single source, but: make unknown names fail
loudly in dev instead of silently falling back to `info` (`icons.js:89`), delete the unused
`iconEl()` (`icons.js:95-101`, zero call sites), and replace the three hand-typed inline "x"
SVGs (`dialog.js:41`, `util.js:152`, `ai.js:766`). Retire the raw text glyphs `− + ⛶`
(`index.html:116-119`) and the `🔒` emoji (`app.js:1048`) in favour of set glyphs; replace the
CSS `content:" •"` dirty indicator (`app.css:133`) with a real element.

### 5.5 Contrast
Fix the failures found in the audit: `--text-3 #8b91a0` on `--panel #ffffff` is ≈3.2:1 and is
used at 10.5px for ribbon group titles, page numbers, hints and property titles; badge text is
`#fff` on accent at 9px and 8.5px. Target ≥4.5:1 for body text, ≥3:1 for large text and UI
boundaries, and a minimum 11px for any real label.

## 6. Testing and verification

Every phase must leave all of these green:

| Gate | Command | Asserts |
| --- | --- | --- |
| Launch | `node scripts/launch-test.mjs` | window visible on screen, rAF fires, renderer booted |
| Boot | `npm start -- --boot-test` | renderer links, zero console errors |
| View | `npm start -- --functional-test .fixtures/fixture.pdf` | parse, text, annotations, forms |
| Edit | `npm start -- --edit-test .fixtures/fixture.pdf` | annotate → save → reopen round-trip |
| PDF engine | `node scripts/smoke-pdf.mjs` | pdf-lib ops, AES-256 round-trip |
| Imports | `node scripts/audit-imports.mjs` | no missing named exports |

New gates added by this spec: settings round-trip (3.1), form-widget interactivity (3.2),
encrypted save + remove-security (3.3), measure-annotation geometry (3.7), shortcut-registry
consistency (4.1 — no accelerator may collide, and help/tooltips must match the table), and an
a11y sweep (4.2/4.3 — every interactive element has an accessible name and a visible focus
state).

`scripts/launch-test.mjs` must not use `windowsHide` on `spawn` — it sets
`STARTUPINFO wShowWindow=SW_HIDE`, so Windows creates the child window hidden and the
visibility assertion measures the harness instead of the app. (This was a real false negative
during diagnosis.)

## 7. Phasing

1. **P1 — Correctness (S1).** Highest value, lowest risk. Ends with the app doing what its
   menus claim.
2. **P2 — Interaction foundation (S2).** Shortcut registry, focus, ARIA, context menus, panels,
   busy/error, theme sync, chrome metrics.
3. **P3 — Atelier visual system (S3).** Tokens, scales, component consolidation, iconography,
   contrast. This is the last phase precisely because it re-skins what P2 builds.
4. **P4 — Package.** Version bump, `electron-builder --win`, and verification that the
   *installed* app opens (the copy in `C:\Program Files\AiPDF Editor` is a stale 1.0.0 build
   from before every fix in this document).

## 8. Out of scope (deferred to S4)

OCR→searchable text layer, form flatten + XFDF, compress/optimize, document compare, crop,
hyperlinks, attachments, batch processing, digital signatures (`@signpdf/*` + `node-forge` in the
main process). Explicitly **not** attempted at any point: PDF/A conformance, true text reflow,
accessibility tag creation, high-fidelity Word/Excel export — none are honestly achievable in a
pure-JS renderer stack, and shipping fake output is worse than shipping none.

## 9. Risks

- **Concurrent editing.** Another session was rewriting `main.js`, `app.js`, `viewer.js` and
  `menu.js` during diagnosis. The owner has granted this workstream exclusive ownership; if that
  changes, stop rather than merge blind.
- **Renderer surface area.** `app.js` is 1659 lines and `viewer.js` 552; P2/P3 touch both
  heavily. Where a file has grown past one responsibility, split it as part of the change rather
  than adding to it.
- **Regression risk in the annotation round-trip.** The PDF-space ↔ screen-space contract is
  subtle; the edit test is the guard and must stay green after every change to `annots.js`,
  `pdfwrite.js` or `viewer.js`.
- **Frame starvation.** The launch bug had two independent causes (preload zoom call, GPU
  first-paint stall). `launch-test.mjs` exists because `--boot-test` cannot see this class of
  failure — `__aipdfBooted` is set by JS alone and passes while the window is invisible.
