# Direct Editor rebuild — design

Date: 2026-10-14
Status: proposed
Owner decision recorded: add PDFium-WASM; sequence correctness first, then model.
Supersedes: nothing — the Direct Editor introduced in 2.x stays in place until each item below lands.

## 1. Why

The owner supplied a technical report on rebuilding Acrobat-style existing-text editing. This
spec applies that report to *this* codebase. The report was written without seeing the code, so
three of its recommendations do not survive contact with the stack, and its central warning turns
out to be exactly where the current editor is broken.

The report's closing line is the governing constraint:

> The largest architectural risk is not drawing editable rectangles. It is losing the
> relationship between logical text, displayed glyphs, and the original content that must be
> changed. Build that relationship first.

Everything below serves that relationship.

### 1.1 What the report recommends that this project cannot use

| Report recommendation | Verdict here |
| --- | --- |
| MuPDF / PyMuPDF (§10.2) | **Out.** MuPDF.js is AGPL; this app is MIT and distributed as a closed installer. |
| `insert_htmlbox`, redaction-based removal (§8.3, §11) | **Out.** PyMuPDF-only. `textops.js` already implements the equivalent in pure JS. |
| PDFium as the object-level engine (§10.1) | **In, but as one strategy among several** — see §2.2. |
| HarfBuzz shaping (§7.3) | **Deferred.** No shaping library is vendored; see §7 for what is claimed instead. |

### 1.2 What the report recommends that is already true here

`textops.js`'s offset-preserving tokenizer and `walkTextBlocks` provenance layer are a genuine
implementation of §5.1's "source-content provenance" and §8.2's Strategy B. `reflow-test.mjs`
already validates save → reopen → re-extract. Most attempts at this feature never get this far.
This work preserves that asset rather than replacing it.

## 2. Measured findings

Each item below was produced by running code, not by reading it. Reproduction notes are in §9.

### 2.1 Font handling silently destroys non-Latin text — highest severity

Two independent defects compound.

**(a) Custom font embedding is completely non-functional.** `pdfwrite.js:41` calls
`doc.embedFont(bytes, { subset: true })`. `@cantoo/pdf-lib@2.11.1`'s `CustomFontSubsetEmbedder`
calls `subset.includeGlyph(glyph)`; the pinned `@pdf-lib/fontkit@1.1.1` exposes only
`{_addGlyph, encode}` — `includeGlyph` is `undefined`. The call throws for *every* font.
`pdfwrite.js:44` catches it, writes a `console.warn`, and falls through to Standard-14.

**The fix that works in this renderer is not a fontkit swap.** Measured in the live app, three
candidates were tried and two fail:

- `@cantoo/fontkit@2.0.12` has `includeGlyph` and subsets correctly in Node (Arial 12 KB, Mangal
  5 KB). But its browser builds import four bare specifiers — `brotli/decompress.js`, `dfa`,
  `fflate`, `restructure` — and `restructure` and `brotli` ship **CJS only**. This renderer has no
  bundler and no import map, so the build cannot load. Verified by a failing parity guard:
  `Failed to resolve module specifier "restructure"`.
- `@pdf-lib/fontkit@1.1.1`'s UMD build **is** self-contained (zero external requires) and loads via
  the existing script-tag route. Its `create()` and `hasGlyphForCodePoint()` work on every font
  tested, which is all the coverage gate needs. Its subsetter is broken, so embedding uses
  `{ subset: false }` — full program, correct text, larger file (Arial ~583 KB, Mangal ~118 KB).
- With fontkit 1.1.1, complex-script fonts additionally threw `regeneratorRuntime is not defined`
  on embed: the GSUB shaping path was transpiled against that global. Supplying
  `regenerator-runtime@0.14.1` as a classic script **before** fontkit fixes it (Mangal then embeds
  at 118 KB). `runtime.js` sets `globalThis.regeneratorRuntime` itself, so no code change is
  needed beyond load order.

Consequence today, before the fix: user font upload, "Use for new text", and every embedded-font
reuse path silently produce Helvetica.

**(b) Standard-14 corrupts anything outside WinAnsi, without error.** Measured by dumping the
saved content stream. Input `नमस्ते` became six literal `0x3F` bytes — `??????`.

| Text | Standard-14 Helvetica | `0x3F` written |
| --- | --- | --- |
| `नमस्ते` (Devanagari) | corrupted | 6 |
| `مرحبا` (Arabic) | corrupted | 5 |
| `中文` (CJK) | corrupted | 2 |
| `₹` | corrupted | 1 |
| `é — • " " © €` | intact | 0 |

The existing guard cannot catch this. `pdfwrite.js:683` calls `font.encodeText(line)`, but
Standard-14 substitution does not throw — the code comment at `pdfwrite.js:677-681` concedes it.

Verified fix path: fontkit's `font.hasGlyphForCodePoint(cp)` works and is already vendored.
Measured coverage — Arial 0/6 Devanagari, Mangal 6/6. With `@cantoo/fontkit` and `{subset:true}`,
Mangal preserves `नमस्ते` end to end with zero `0x3F`.

**Net effect today:** any edit to a PDF whose font is not a Standard-14 match — which is most real
documents — writes question marks into the saved file, with no warning at any point.

### 2.2 PDFium-WASM works, but only on non-fragmented text

`@embedpdf/pdfium@2.15.1`: MIT, `dist/pdfium.wasm` 4,646,932 B, `index.browser.js` 293 KB, zero
runtime dependencies, plain ESM via `init({ wasmBinary })`. 420 typed `FPDF*` functions. All the
needed editing surface is present: `FPDFText_SetText`, `FPDFPage_GenerateContent`,
`FPDFPage_CountObjects` / `GetObject` / `RemoveObject` / `InsertObject`,
`FPDFPageObj_CreateTextObj` / `NewTextObj` / `SetMatrix` / `GetBounds`,
`FPDFTextObj_GetText` / `GetFont`, `FPDFText_GetCharOrigin` / `GetCharBox` / `GetLooseCharBox` /
`GetFillColor` / `GetFontSize` / `GetMatrix`, `FPDFText_LoadFont`, `FPDF_SaveAsCopy`.

Two APIs worth calling out because they are not in the report:

- `FPDFText_GetTextObject(textPage, charIndex)` returns the object that draws a given character.
  Cross-checked: for char 0 it returns exactly the first text object. This is §5.1's provenance
  layer, obtained directly rather than inferred.
- `FPDFText_HasUnicodeMapError(textPage, charIndex)` is a built-in encoding-coverage probe.

**Non-obvious loader gotchas, all measured:**

1. `init()` does **not** call `FPDF_InitLibrary()`. Without it, every page-level call traps with
   `RuntimeError: memory access out of bounds`, while document-level calls
   (`FPDF_GetPageCount`, `FPDF_GetDocPermissions`, `EPDF_IsEncrypted`) succeed — which makes the
   failure look document-specific. It is not.
2. The typed functions live on the module **root**, not on `.pdfium`. `.pdfium` carries the
   runtime helpers: `_malloc`, `wasmExports.free`, `HEAPU8`, `setValue`, `getValue`,
   `addFunction`, `removeFunction`, `UTF16ToString`, `stringToUTF16`.
3. `FPDFText_LoadPage` takes a **page**, not a document (1 argument).
4. `FPDF_PAGEOBJ_TEXT` is **1**, not 3. The histogram for `real-chrome.pdf` is `{"1": 1375}`.
5. `INITIAL_MEMORY` and `wasmMemory` overrides are both rejected — the build's asserts
   contradict each other and memory is internal. Do not try to tune it.
6. Do **not** hand-roll `FS_FILEWRITE` with `addFunction`. The callback never fires and the save
   traps with `null function or function signature mismatch`. Use the purpose-built helpers:
   `PDFiumExt_Init()`, `PDFiumExt_OpenFileWriter()`, `PDFiumExt_SaveAsCopy(doc, writer)`,
   `PDFiumExt_GetFileWriterSize(writer)`, `PDFiumExt_GetFileWriterData(writer, buf, size)`,
   `PDFiumExt_CloseFileWriter(writer)`.
7. After `FPDFText_SetText`, the existing `FPDF_TEXTPAGE` handle reads **stale** text. Do not
   verify in memory; verify from the saved bytes.

**The decisive result.** Controls on `.fixtures/real-chrome.pdf` (a Chrome-printed page, 1375 text
objects for 1434 characters — effectively one object per glyph), verified by re-extracting the
saved bytes with pdf.js, an engine independent of PDFium:

| Control | Operation | Extracted chars | Verdict |
| --- | --- | --- | --- |
| A | load + save, no edit | 1480 | intact |
| B | `FPDFPage_GenerateContent` only | 1480 | intact |
| C | `FPDFText_SetText` with the **identical** original bytes | 2788 | **corrupted** |
| D | `FPDFText_SetText` with new text | 2779 (+9 NUL) | **corrupted** |
| E | same edit on a simple one-object PDF | — | **clean**: `"Hello simple world sentence"` → `"Goodbye replaced text"` |

Control C is the important one: writing back the bytes that were just read is itself destructive,
so this is not an encoding mistake in the caller. `GenerateContent` alone is safe; `SetText` is
what damages the page.

**Conclusion:** PDFium is a correct implementation of §8.1 Strategy A — precise object editing —
and is unusable on per-character-fragmented text, which is what browsers and most report
generators emit. It cannot be *the* edit engine. The report's own §8 decision tree is the answer:
select a strategy per block.

Scope of what was measured: extraction correctness. Whether control D also corrupts the *rendered*
page was not measured; extraction damage alone is disqualifying for that document class.

### 2.3 The UI states a falsehood about deletion

`app.js:2221` reads *"Original text is deleted from the file on save — not covered up."* That is
unconditional. Excision is refused whenever the page's resources reference a Form XObject that
draws text (`textops.js:317-332`), and the writer then paints `bg: [1,1,1]` — the report's §8.4
"do not use this as your production implementation".

Nothing reports the fallback. `planExcision` has no logging; its refusals at `pdfwrite.js:641` and
`:656` are bare `continue`; `excised` is a local at `pdfwrite.js:1004` and is never returned;
`buildPdf` returns only bytes; `saveDoc` toasts `'Saved'`. `agent.js:368` asserts the opposite
claim. A user cannot currently tell whether their edit was genuinely removed or painted over.

### 2.4 Reflow is structurally impossible

`textblocks.js:52` joins reconstructed lines with `'\n'`. `wrapBlockText` (`textblocks.js:78-96`)
splits on `'\n'` and never merges across it. Every original line ending therefore becomes a
permanent hard break, so §1.1's "text reflows within its text box" cannot happen. §6 names this
exactly: *"a line ending inferred from the original page should not always become a permanent
newline."*

Compounding it, `maxWidth` at `textblocks.js:60` is derived from ink extent (`g.end - g.x + 3`),
which is §6's "layout rectangle versus ink bounds" conflation: the reconstructed box is narrower
than the true wrapping width, so reflow would wrap early even once breaks are fixed.

### 2.5 Coordinate transform is wrong for unrendered pages

`viewportOf`'s fallback (`viewer.js:471`) omits intrinsic `/Rotate`, while `pageDims` has already
baked it in at `viewer.js:120-125` — wrong twice over. There is no CropBox term anywhere in
`viewer.js:471-480`; `unrot` is declared at `:472` and never read. The rendered path
(`viewer.js:314-315`) is correct because it uses pdf.js's own viewport. This is §5.2's warning
verbatim: *"Do not rely on a universal pageHeight - y conversion. Crop boxes, page rotation, and
engine conventions matter."*

### 2.6 Excision has two unhandled hazards

`textops.js` contains no handling of `Tr` or of `Tf` outside `BT` — verified by grep, zero
matches. §8.2 names both as critical:

- Text with rendering mode 4–7 participates in **clipping**. Blanking such a `BT…ET` changes the
  clip path for everything painted after it.
- `BT` resets only `Tm` and `Tlm`. `Tf`, `Tc`, `Tw`, `Tz`, `Ts` and `TL` persist across `BT…ET`.
  Blanking a block that carries the only `Tf` can change the font of later text.

Current behaviour is to blank and hope.

### 2.7 Document preflight does not gate anything

| Check | State |
| --- | --- |
| Signatures | Detected at `annots.js:365`, exposed as `d.hasSignature`, used **only** for a sidebar note. Never gates editing. `/Perms` and `DocMDP`: absent from `src/`. |
| Permissions | `getPermissions()` is **never called anywhere in `src/`**. `app.js:1477` even writes `modifying: false` on save, forbidding the edit just performed. |
| Encryption | Wired via `probeEncryption` (`pdfwrite.js:1259`), but gates **save only**, never the editor. |
| Scanned vs native | Detected (`ocr.js:110-135`, threshold 8 chars) but used only for a thumbnail badge. |

Editing a signed PDF therefore silently invalidates the signature, contrary to §13.2.

### 2.8 Other confirmed gaps

- **No glyph-coverage check anywhere.** `fontIsUsable` (`textedit.js:193-203`) is a *name*
  existence test, not a coverage test.
- **The Format panel has no font, size or colour controls**, despite the comment at
  `app.js:2151-2152` claiming them and `applyDirectFormat` supporting both. It offers only align,
  B/I/U, line spacing, char spacing, h-scale.
- **Absent entirely:** paragraph/line/object modes, split/merge, rotate, block-capability
  display, grouping confidence, collision and overflow warnings.
- **`bg: [1,1,1]` is hardcoded** (`textedit.js:133`) — a white rectangle over images, gradients
  and coloured panels, which §4.1 forbids.
- **Structural page ops destroy unsaved work.** `pages.js:28` clears `doc.textEdits` and
  `pages.js:50-52` resets history, so delete/duplicate/extract/reorder/rotate silently discards
  every pending Direct Editor commit.
- **No post-save validation in the shipping path.** It exists only in `reflow-test.mjs` and the
  in-app parity guards.
- **Packaging hazard introduced by this investigation:** `.spike/` is *not* in the `build.files`
  exclusion list in `package.json`. Its `node_modules` (a 4.6 MB wasm plus fontkit) would be
  packed into the asar. Must be excluded before any build.

### 2.9 Test corpus is too thin to catch any of this

`.fixtures/` holds `fixture.pdf`, `fixture-attach.pdf`, `fixture-layers.pdf`, `real-chrome.pdf`
and one build artifact. There is **no** signed, encrypted, permission-restricted, scanned,
rotated, non-Latin or multi-column fixture. §14.1's corpus is largely unbuilt, which is why
§2.1 survived to production.

## 3. Architecture

The report's §4 pipeline, mapped onto this codebase. New modules are marked **(new)**.

```
PDF document
  │
  ├─ preflight.js (new) .............. §3  permissions, signatures, encryption,
  │                                      native/scan classification
  ├─ viewer.js ....................... existing pdf.js render + text extraction
  │     └─ viewportOf() .............. FIX §5.2 rotation + CropBox
  ├─ reconstruct.js (new, replaces textblocks.js)
  │     .............................. §5  orientation → baseline projection →
  │                                      lines → columns → paragraphs, with
  │                                      confidence + reasons + warnings
  ├─ editmodel.js (new) .............. §6  TextBlock / Paragraph / TextRun /
  │                                      SourceReference; layoutRect ≠ inkRect;
  │                                      soft ≠ hard breaks
  ├─ fontresolve.js (new) ............ §7  coverage check, resolution chain,
  │                                      explicit missing-glyph decision
  ├─ textedit.js ..................... §4.1 four display layers, modes, split/merge,
  │                                      move/rotate, overflow + collision warnings
  ├─ commit.js (new) ................. §8  strategy selection A/B/C/D
  │     ├─ pdfium.js (new) ........... Strategy A — precise object edit
  │     ├─ textops.js ................ Strategy B — source-aware excision + rewrite
  │     │                               HARDENED for Tr / out-of-BT Tf
  │     └─ pdfwrite.js ............... Strategy C/D + honest per-edit reporting
  └─ validate.js (new) ............... §14.2 save → reopen → re-extract → compare
```

`textblocks.js`, `textops.js` and `textedit.js` keep their public names where other modules
import them, so the eight-file blast radius in §5 does not all have to change at once.

### 3.1 The engine adapter seam

Per §4.2, one interface hides both engines from the UI and the model:

```js
// commit.js
/** @typedef {'precise-object'|'source-replace'|'regional'|'cover'|'refused'} Strategy */

/**
 * @param {TextBlock} block
 * @param {BlockEdit} edit
 * @returns {Promise<{strategy: Strategy, reason: string, applied: boolean}>}
 */
export async function planCommit(block, edit) { /* §8 decision tree */ }
```

`pdfium.js` exports a lazily-initialised singleton and never leaks a pointer, a `HEAPU8` view or a
writer handle past its own boundary. If the wasm fails to load — offline first run, blocked file,
corrupt vendor copy — `commit.js` degrades to Strategy B and says so. PDFium is an enhancement,
never a hard dependency.

## 4. Data model

§6's shape, trimmed to what this app actually reads. Fields already consumed elsewhere are marked
so they cannot be renamed casually (§5).

```js
/** @typedef {{
 *   id: string,
 *   page: number,
 *   mode: 'paragraph'|'line'|'object',
 *   itemIndices: number[],          // consumed by pdfwrite, annots, viewer, agent
 *   sourceRefs: SourceRef[],        // NEW — content-stream byte ranges
 *   paragraphs: Paragraph[],        // NEW — soft/hard breaks separated
 *   layoutRect: Rect,               // NEW — inferred wrapping box
 *   coverRect: Rect,                // consumed by pdfwrite, annots — ink bounds
 *   exciseRect: Rect,               // consumed by pdfwrite ONLY
 *   baseline: [number, number],
 *   capabilities: BlockCapabilities,// NEW
 *   confidence: {grouping: number, reasons: string[], warnings: string[]},
 *   revision: number
 * }} TextBlock */

/** @typedef {{text: string, hardBreaks: number[], runs: TextRun[]}} Paragraph */

/** @typedef {{
 *   streamKey: string,
 *   operatorRange: [number, number],   // byte offsets, as walkTextBlocks returns
 *   objectIndex?: number               // PDFium page-object index, when available
 * }} SourceRef */

/** @typedef {{
 *   state: 'editable-original-font'|'editable-replacement-font'
 *        |'editable-after-ocr'|'move-resize-only'|'unsupported'|'blocked',
 *   missingGlyphs: string[],
 *   resolvedFont: {alias: string, source: 'document'|'user'|'system'|'standard14', embedded: boolean},
 *   excisable: boolean,
 *   excisionBlockers: string[],
 *   strategy: Strategy
 * }} BlockCapabilities */
```

**Soft vs hard breaks** is the load-bearing change. `paragraphs[].text` holds the paragraph with
original line endings removed; `hardBreaks[]` holds only user-entered newlines. Reconstruction
infers which original line endings were paragraph ends (via §5.6's signals) and stores them as
separate paragraphs rather than as `\n`. This is what makes reflow possible.

**`layoutRect` vs `coverRect`.** `layoutRect` is the inferred wrapping box: left edge from the
paragraph, right edge from the page's or column's right text margin — not from this block's ink.
`coverRect` stays the ink bounds, because that is what excision and the preview mask need.

## 5. Blast radius

Eight files outside `textedit.js` / `textblocks.js` / `textops.js` read this model. Fields read
**by name** elsewhere cannot change meaning silently:

| Field | Read at |
| --- | --- |
| `itemIndices` | `pdfwrite.js:650,671`; `annots.js:802,819`; `viewer.js:390-392` |
| `coverRect` | `pdfwrite.js:636,691`; `annots.js:801`; `app.js:739` |
| `exciseRect` | `pdfwrite.js:636` only |
| `id` | `pdfwrite.js:658,1008` — the join key for the excised set |
| `bg` | `pdfwrite.js:690`; `annots.js:813` |
| `baseline` `size` `maxWidth` `maxHeight` `hScale` `fontFamily` `color` `angle` `text` | `pdfwrite.js:666-729`; `annots.js:803-834` |

Also: `viewer.js:389-405` (`getPageText`) feeds pending edits into Ask AI, the agent, exports and
read-aloud, keyed by `Math.min(...itemIndices)`; `agent.js:339-350` hand-builds **non-block**
edits with no `itemIndices`, so every invariant added must tolerate that; `search.js` does *not*
read `textEdits`, so Find already disagrees with `getPageText` — a pre-existing inconsistency this
work should close, not widen.

## 6. Font policy

Implements §7.2's ladder, with the dependency corrected.

1. Keep `@pdf-lib/fontkit@1.1.1` (the only self-contained build) and add
   `regenerator-runtime@0.14.1`, loaded first. Embed with `{ subset: false }`; record every
   substitution in a drained log so the save report can describe what landed. Subsetting returns
   as a follow-up via a main-process `@cantoo/fontkit` IPC, where the CJS build works and the
   renderer never sees it.
2. On document open, register the page's own embedded fonts via the existing
   `extractFontProgram` → `registerCustomFont` path, so the original font is the *first* candidate
   rather than something the user must find in View ▸ Document fonts.
3. Before any commit, run `hasGlyphForCodePoint` over the replacement string for the resolved
   font. For Standard-14, use the WinAnsi range directly rather than a font parse.
4. Resolution order: document's own embedded font → user font of the same family → installed
   system font → Standard-14 **only if coverage passes** → otherwise stop and ask.
5. Missing glyphs are an explicit user decision, never a silent substitution (§14.4). Offer:
   pick another font, keep the original characters unedited, or accept replacement glyphs — with
   the missing characters listed.
6. Prefer substituting a whole run over mixing fallbacks inside a word (§7.2).

## 7. Shaping — an honest limit, now measured

§7.3 requires HarfBuzz-class shaping for correct caret, selection and line breaking in complex
scripts. No shaping library is vendored and adding one is out of scope for this rebuild.

What is therefore claimed: **coverage**, not shaping. With the font fix, Devanagari and Arabic
code points are preserved in the saved file and no longer become `?`.

The limit was then measured rather than assumed. `नमस्ते` written through the cleanest font path
available in this stack (`@cantoo/fontkit` + `{subset:true}`, in Node) and through the app both
render as **unshaped base glyphs** — the virama and matra drawn as separate marks rather than
forming conjuncts — because fontkit's `layout()` performs no Devanagari reordering. Extraction of
the app's output reads `नमè`, not the logical string. Both were confirmed by rendering the saved
bytes with PDFium and inspecting the images.

So the honest contract is: Latin and WinAnsi text round-trip exactly; complex scripts are
preserved as glyphs but are neither shaped nor guaranteed to extract back to their logical form.
The UI must not imply otherwise. Caret movement stays code-point based, so a ligature or conjunct
may take more than one arrow key.

## 8. Commit planner

§8's decision tree, with §2.2's measurement built in as the gate on Strategy A.

```
Is the block's text carried by few, whole-string text objects?
    (chars-per-object above threshold, verified via PDFium object enumeration)
  YES + font covers replacement  → A: precise object edit (PDFium SetText + GenerateContent)
  NO, but source provenance is safe
  and the region is isolated      → B: source-aware excision + rewrite (textops.js)
  No provenance, region validated → C: guarded regional removal + replacement
  None of the above               → D: cover, REPORTED AS A COVER, or refuse
```

Strategy A's gate exists because of control C/D in §2.2. The fragmentation test is mandatory, not
an optimisation: applying A to a per-character page destroys the page's text layer.

Every outcome is reported. `buildPdf` returns `{bytes, report}` where `report` is per-edit
`{id, strategy, applied, reason}`. Save surfaces a summary; a cover fallback is never presented as
a deletion. `app.js:2221`'s unconditional claim and `agent.js:368`'s contradictory one are both
removed in favour of the real per-edit state.

## 9. Hardening and validation

**`textops.js` (§8.2 hazards).** Before blanking any `BT…ET`, refuse when the block sets a
clipping render mode (`Tr` 4–7 followed by `W n`), or when it carries a `Tf`/`Tc`/`Tw`/`Tz`/`Ts`/
`TL` that later text depends on without re-setting it. Refusal is a capability result, not an
exception: the planner moves to the next strategy.

**Post-save validation (§14.2).** Every save runs: reopen the bytes with pdf.js → re-extract the
affected pages → assert the replacement is present, the original absent, and neighbours unchanged.
This already exists in `reflow-test.mjs`; it moves into the shipping path behind a setting, and a
failure is surfaced rather than logged.

**Preflight gating (§13.2).** Signed document → content editing blocked by default, with a clearly
labelled "save an unsigned copy" path. Permission-restricted → warn before the first edit. Scanned
page → blocks report `editable-after-ocr`, not an empty editor.

**Coordinate fix (§5.2).** `viewportOf`'s fallback must include intrinsic `/Rotate`, must not
double-apply it, and must account for CropBox offset. Add a rotated and a cropped fixture.

**Structural-op guard.** Any op that calls `reloadDocFromBytes` must warn when pending text edits
exist, and offer to save first. Silent loss is not acceptable.

**Reproduction artefacts.** The measurements in §2 came from `.spike/pdfium/roundtrip.mjs` and the
font probes. `.spike/` is throwaway and must be added to `build.files` exclusions before any
packaging run.

## 10. Sequencing

The owner chose correctness first, then model. Two rounds, each ending in an installed, verified
build.

**Round 1 — correctness and honesty.** No new engine, no model change. Items §2.1 (both halves),
§2.3, §2.4, §2.5, §2.6, §2.7, plus the missing font/size/colour controls and the packaging
exclusion. Fixtures added for signed, encrypted, restricted, scanned, rotated and Devanagari cases.

**Round 2 — model and PDFium.** `editmodel.js`, `reconstruct.js`, `commit.js`, `pdfium.js`,
`validate.js`; capability states surfaced in the UI; paragraph/line/object modes; split/merge;
move/rotate; collision warnings; Strategy A gated on the fragmentation test.

## 11. Acceptance tests

From §14.4, made concrete and each tied to a finding above.

1. Devanagari, Arabic and `₹` survive an edit with no `0x3F` in the saved file, and no silent
   Standard-14 substitution. Full logical extraction of complex scripts is *not* asserted — see §7.
2. A document font is reused automatically; no silent Helvetica fallback.
3. Missing glyphs produce an explicit decision listing the characters, never a silent `?`. *(§6)*
4. A typo correction leaves neighbouring content byte-identical outside the edit region.
5. A longer paragraph reflows inside its box; original line endings are not permanent. *(§2.4)*
6. Resizing changes wrapping without changing font size.
7. Overflow warns; text is never silently shrunk.
8. Every save reports per-edit strategy; a cover fallback is never described as a deletion. *(§2.3)*
9. Post-save validation reopens the bytes and fails loudly on mismatch. *(§9)*
10. `real-chrome.pdf`-class fragmented text never reaches Strategy A. *(§2.2)*
11. A simple one-object PDF edits cleanly through Strategy A. *(§2.2 control E)*
12. Rotated and cropped pages place the caret correctly. *(§2.5)*
13. Clipping text and shared `Tf` cause refusal, not corruption. *(§2.6)*
14. A signed document blocks content editing and offers an unsigned copy. *(§2.7)*
15. Undo/redo restores text and geometry; a structural op with pending edits warns first. *(§2.8)*

## 12. Open risks

- **Fragmentation threshold for Strategy A** is not yet calibrated. Control E passed at 1
  object/27 chars; control D failed at 1375 objects/1434 chars. The boundary needs a labelled
  corpus before it is trusted. Until then the threshold is set conservatively and every refusal is
  reported.
- **PDFium wasm cost** — 4.6 MB vendored, plus parse and init time — is unmeasured in the
  renderer. Round 2 must measure cold-init latency before making it non-lazy.
- **Shaping** remains unsolved (§7), now measured rather than assumed: complex scripts render
  unshaped and do not extract back to their logical string, in this app and in the cleanest
  available font path alike. HarfBuzz is the only real fix and is out of scope.
- **`@cantoo/fontkit` cannot load in the renderer** — measured, not guessed. Its browser builds
  import `brotli`, `dfa`, `fflate` and `restructure`, two of which are CJS-only, and there is no
  bundler or import map here. It stays a Node/main-process tool for the subsetting follow-up; the
  renderer keeps the self-contained `@pdf-lib/fontkit` UMD plus `regenerator-runtime`.
- **Embed size.** `{ subset: false }` embeds whole font programs: ~583 KB for a full retail face,
  ~118 KB for Mangal, and much less for a document's own already-subsetted font — the common case.
  Acceptable for correctness-first; the main-process subsetting IPC removes it.
