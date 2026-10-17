# Direct Editor redesign — research → implementation

This document maps *Direct PDF Editing Engine: Research, Design and Integration*
(Perplexity, 17 Oct 2026, prepared for Rocky Balbao / AVIROP) onto the code that
now ships in this repository. It is a traceability record, not a second design
proposal: every claim below names the file and the check that proves it.

---

## 1. The decision the research asks for

> "Build an object-owned, story-based editor. Keep physical PDF source objects,
> logical editable text, and destination frames separate. Offer three explicit
> actions: Edit line, Merge into paragraph, and Thread frames. A visual link
> alone must not decide whether geometry is merged, source line breaks are
> removed, or text may continue to another page."
> — §1 Executive decision

The previous Direct Editor failed that contract in one specific way, and the
research names it exactly:

> "White covering changes appearance but is not equivalent to deleting the
> selected text objects." — §9
>
> "A screenshot can look correct while the old searchable text remains
> underneath." — §4

The old editor covered the original run with an opaque wash and drew the
replacement as a `/FreeText` annotation. A screenshot looked right; a text
search, a copy-paste and a screen reader still saw the **old** words, and the
new words were not in the file's text layer at all. The rewrite below makes the
file agree with the page.

---

## 2. The four-box pipeline, and where each box lives

The research's architecture (§5) is four separable models. They are four
separable modules here too — none of them reaches into another's storage.

| Research box | Implementation | Notes |
|---|---|---|
| ORIGINAL PDF — source objects, text, fonts, geometry, transforms | `src/renderer/js/textops.js` (`walkTextBlocks`, `exciseText`), pdf.js text layer | Source objects are enumerated, never mutated in place. |
| AUTHORING MODEL — stories, styled runs, confirmed source ownership, line/flow mode, ordered frames | `src/renderer/js/story.js`, records built in `textedit.js` `commitBlockEdit` | `SCHEMA_VERSION = 2`; each record carries `sourceRefs`, `sourceRects`, `frames`, `mode`, `fontPolicy`. |
| LAYOUT MODEL — wrapping, baselines, placements, logical ranges, consumed text, overset | `story.js` `layoutStory` / `fitCount`, rendered by `annots.js` | One algorithm, two callers (preview and writer), so they cannot disagree about wrapping. |
| PDF WRITER — remove owned objects → insert replacements → regenerate → save candidate → reopen | `src/renderer/js/pdfwrite.js` `buildPdf` → `applyTextEdit` / `applyFramedEdit` | `buildPdf()` always reloads `doc.bytes.slice(0)`, so removal is never cumulative. |

### 2.1 Source model (§5.1)

- **Exclusive ownership.** `removeOwnedSource(doc, pageIndex, e)` excises
  **only** the rects listed in `e.sourceRects`, one at a time, with a dry run
  before each commit. A source object can therefore be claimed by at most one
  story — a second edit cannot silently re-own it. `e.exciseRect` (the union of
  the original footprint and everything this edit has previously drawn) is kept
  only as the fallback for a record written before `sourceRects` existed —
  schema-1 projects — so an older document still opens and saves.
- **Whole-object granularity.** This is the research's MVP boundary
  ("This MVP works at whole-source-object granularity; arbitrary glyph-range
  splitting is future work" — §5.1). `exciseText` removes the objects whose
  bounds fall inside the owned rect; it does not split a multiword object.
- **Refusal over damage.** When the owned text lives inside a shared **Form
  XObject**, `exciseText` refuses. Editing it would change every page that
  shares the form — pages the user never opened. The edit falls back to the
  conservative cover and records `fallbackReason`, which
  `drainExportWarnings()` reports.
- **Document hash / sidecar identity.** *Not implemented.* See §7 below.

### 2.2 Authoring model (§5.2)

`commitBlockEdit` writes one record per block. The fields that matter:

```js
schemaVersion: 2,                    // migrate, never guess
mode: 'line' | 'flow',               // §7.1 line mode vs flow mode
sourceRefs: { itemIndices, lineIds }, // the owned source objects
sourceRects: [...],                  // one rect per owned object — NOT a union
frames: [{ page, rect }],            // ordered; always >= 1
fontPolicy,                          // what will draw the text, and what cannot
consumed, total, overset,            // §7.2
```

Three decisions are encoded here deliberately:

- **`sourceRects` is a list, never a union.** Merging two selections that skip a
  line must not delete the skipped line. The union would; the list does not.
  This is the §5.1 exclusivity rule applied to a multi-object selection.
- **`frames` is never empty.** An ordinary in-place edit is a *one-frame story*;
  only threading adds more. This keeps one record shape for both paths, so the
  writer, the layout preview and the inspector all read the same field.
- **`mode` governs composition, not the writer's ink constraint.** Line mode
  means the *user* cannot author a soft wrap; it does not license the writer to
  run text off the page. See §4.3 for why the two must agree.

### 2.3 Layout model (§5.3)

`layoutStory(story, measure)` returns exactly the shape the research asks for:

```
placements: [{ frameIndex, page, rect, lines: [{ text, x, y, baseline }],
               logicalStart, logicalEnd }]
consumed, total, overset: null | { text, lines }
```

`measure` is injected, so the preview uses canvas metrics and the writer uses
pdf-lib font metrics **through the same algorithm** — the research's explicit
requirement: "supplied by the caller so the preview (canvas metrics) and the
writer (font metrics) share one algorithm and cannot disagree about wrapping."

The implemented composition rules mirror §7.1:

| §7.1 rule | Code |
|---|---|
| frame is an outer ink constraint | `fitCount(lines, rectH(frame), size, leading)` |
| baseline starts one line font size below the frame top | `layoutStory`: `y = top - size - i*leading` |
| 0.35-em descent reserve | `fitCount`: `usable = height - size * 1.35` |
| horizontal inset | `story.style.inset` (0 by default; the writer keeps `maxWidth`) |
| greedy longest-line-that-fits, retreat to a space, emergency break for long tokens | `wrapBlockText` (shared by writer and preview) |
| no font-size reduction, no auto pagination, no neighbour displacement | nothing implements them — by design |

### 2.4 Writer boundary (§5.4)

> "The writer accepts validated ownership plus composed placements, not arbitrary
> erase rectangles. Work on a fresh candidate document. Remove owned source
> objects, add replacement text, generate content, save, reopen and validate."
> — §5.4

`buildPdf()` satisfies this literally:

1. It loads a **fresh candidate** from the original bytes every time.
2. `applyTextEdit` calls `removeOwnedSource` **first**, then draws.
3. Blocks are written as raw content-stream operators (`Tc` / `Tz` / `Tm` / `Tj`
   into the **page's own** stream, never a Form XObject) so the replacement is
   ordinary, selectable, re-excisable text.
4. The parity guards reopen the saved file with pdf.js — an **independent
   extractor** — and assert on what a third party can read.

Because the candidate is rebuilt from the original, "Restore original" is exact
by construction and removal is never cumulative (§10.1).

---

## 3. The three explicit actions (§3.4)

| Research label | Implementation | UI |
|---|---|---|
| Edit line | `commitBlockEdit(pageIndex, block, text, { mode: 'line' })` | Direct Editor → click a block |
| Make paragraph | `mergeBlocksIntoParagraph(pageIndex, blockIndices, { separators })` | Properties panel → **Make paragraph with next block** |
| Link frames | `threadEditFrames(eid, frames)` | Properties panel → **Continue on next page** / **Unlink frames** |
| Split story | — | *not implemented* (§7) |
| Restore original | `createEngine().restore(storyId)`; the panel's **Delete** drops the edit record | partial |

### 3.1 Separators are never guessed (§3.2)

> "Explicitly confirm reading order and source-boundary separators: a space for a
> soft source wrap, LF for an intentional break, or no character for a split
> fragment. … Never automatically remove all final hyphens." — §3.2

`mergeStories` takes `separators[i]` — `' '`, `'\n'` or `''` — and the panel
exposes them as a three-option select labelled for what they *mean*, not what
they type:

```
Join with a space (soft wrap)
Keep a line break
Join with nothing (split fragment)
```

`mergeStories` never strips a trailing hyphen. The reasoning is the research's:
a discretionary split may be rejoined, a genuine compound must keep its hyphen,
and only the user can tell which is which.

### 3.2 Frames are ordered and separate (§3.3)

> "Do not merge the frames into one large rectangle: the intervening area may
> contain an image, another column, or unrelated material." — §3.3

`layoutStory` walks the frame list in order, carrying a `rest` string and a
logical cursor forward — it never computes a bounding box over the frames. On
screen each frame is outlined **separately** (`rect.story-frame`, dashed), with a
flow arrow marking where the text continues, and a threaded story deliberately
carries **no** text box: one box cannot express text that continues onto another
page.

### 3.3 Overset is first-class (§7.2)

> "Preview returns consumed and total logical positions and an overset flag. …
> Export refuses overset output. … Store overset text in the authoring model;
> never infer success from a renderer clipping excess content out of view."
> — §7.2 / §5.3

- The model stores `overset: { text, lines }` — the actual suffix, not a boolean.
- The page shows an **overset badge** (`+N lines`) and the panel shows a
  red warning plus `Placed N of M characters` / `Overset: yes`.
- `exportWarnings` carries an `overset` entry per offending edit, surfaced by
  `drainExportWarnings()`.
- The text is never discarded from the model, so the user can fix it by
  enlarging a frame, adding one, or editing the text — the three remedies the
  research names.

### 3.4 Naming (§3.4)

Separate, literal labels — no ambiguous "Link":

- **Edit line** → the Direct Editor's per-block commit
- **Make paragraph with next block** (+ an explicit join choice)
- **Continue on next page** / **Unlink frames**
- **Restore original** semantics are carried by **Delete**, which drops the
  record and returns the source to its original state

Source-order numbers are drawn on every editable block
(`.editable-text-block .block-order`) so two visually similar runs can be told
apart *before* a merge is confirmed.

---

## 4. Behaviour that changed, and why

### 4.1 The replacement is page text, not an annotation

A Direct Editor commit still creates its text box — it is the on-screen handle
for dragging and re-editing. But the **saved file** now carries the replacement
as ordinary page content, and the paired box is omitted from the file:

```js
// pdfwrite.js — buildPdf, annotation section
const contentBoxes = new Set();
for (const e of doc.textEdits || []) {
  if (e.boxId && e.removal === 'excise') contentBoxes.add(e.boxId);
}
```

`FreeText` is in `MANAGED_SUBTYPES`, so the box's old byte-ref is not preserved
either — the annotation genuinely leaves the file. An annotation is invisible to
a text search, a screen reader and copy-paste, so writing both would have
reproduced the original lie in a new place.

### 4.2 The live wash stops drawing once removal is proven

`annots.js` paints the cover wash only while removal is unknown (before the
first save) or when it genuinely failed:

```js
if (e.bg && e.removal !== 'excise') { /* wash */ }
```

Otherwise a white wash would sit on top of a page whose own background is not
white — a patch the file does not contain.

### 4.3 The model and the writer must agree about wrapping

`applyTextEdit` hard-wraps **every** block at its box width. The model's overset
estimate used to skip wrapping in line mode, so a long line-mode edit reported
"no overset" while the file clipped it. That is precisely the silent clip §7.2
forbids. The model now wraps exactly as the writer does:

```js
const overLines = wrapBlockText(text, edit.maxWidth || block.maxWidth || 10, overMeasure);
```

At save time the writer overwrites `consumed` / `total` / `overset` with its own
font-accurate numbers; the model's values are the on-screen estimate.

### 4.4 A silent-failure bug in the excise path

`exciseText`'s content-stream decoder required `obj.contents`. pdf-lib's own
`PDFContentStream` has **no** `.contents` and must be read via `getContents()`.
The result was that the *second* edit on a page found no text, refused to excise,
and quietly fell back to covering — a truthful save that was truthful only the
first time. `decode()` now accepts both shapes:

```js
const encoded = obj.contents instanceof Uint8Array ? obj.contents
  : obj.contents ? Uint8Array.from(obj.contents)
    : (typeof obj.getContents === 'function' ? obj.getContents() : null);
```

---

## 5. Coordinate handling (§11)

The research gives the exact transform for the supported page class
(unrotated, zero-origin, unit scale):

```
x_pdf = x_ui / zoom
y_pdf = page_height - y_ui / zoom
```

This is what the app already does (`V.clientToPdf` / `V.toCss`, and
`toCss` in `annots.js` for the overlay). The research's warning is respected:
the simple formula is **not** applied to rotated or non-zero-origin pages
without an explicit matrix, and the `rotation` / `CropBox` paths handle those
separately.

The research's proposed transport operations map onto the in-process engine:

| Proposed message | Implementation |
|---|---|
| `inspect` | `createEngine(doc).lines(pageIndex)` |
| `create_story` | `merge(sourceIds, frame, text, opts)` |
| `thread_frames` | `thread(storyId, frames)` |
| `preview` | `preview(storyId)` → `layoutStory` |
| `undo` / `redo` | `pushHistory` / the app's structural undo |
| `export` | `buildPdf(doc)` |

---

## 6. Verification (§13)

The research's three independent correctness targets are each covered by a
separate check, because "passing one does not prove the others" (§4):

| Target (§4) | Check | Result |
|---|---|---|
| **Logical** — text/order/style stay available | `truthful:` parity guards + `scripts/truthful-save-test.mjs` extract the saved file with **pdf.js**, an independent extractor | 46/46 rows, 14/14 checks |
| **Visual** — glyphs in the right places, no collateral change | `reflow-test` (neighbouring lines intact), `overset-badge-test`, `direct-edit-test` | 9/9, 24/24, 22/22 |
| **Document** — fonts, refs, annotations stay consistent | `font-coverage-test`, parity `font:` rows, `markup` / `object-edit` / `textbox-resize` | 15/15, 4/4, 40/40 |

The load-bearing row is:

```
truthful: a replaced block is REMOVED from the file and the replacement is real text
  originalGone=true added=true
  needle="AiPDF Editor functional "
  after="This sentence on page one must be extractable by pdf.js. REFLOWPROOF"
```

`originalGone=true` is the §9 property (the old words are gone, not hidden);
`added=true` is the §5.4 property (the replacement is real page text). Both are
measured by reopening the file, not by trusting the in-memory model.

Full suite (all green):

| Suite | Checks |
|---|---|
| `story-test.mjs` | 42 |
| `truthful-save-test.mjs` | 14 |
| `reflow-test.mjs` | 9 |
| `overset-badge-test.mjs` | 24 |
| `--parity-test` (incl. 5 `truthful:` rows) | 46 rows |
| `direct-edit-test.mjs` | 22 |
| `object-edit-test.mjs` | 22 |
| `markup-test.mjs` | 12 |
| `textbox-resize-test.mjs` | 6 |
| `font-coverage-test.mjs` | 15 |
| `audit-imports.mjs` | 1406 call sites / 27 files |

---

## 7. Deliberate limits, and the research's exclusions (§12)

The research is emphatic that a narrow, honest engine beats a broad, lying one:

> "Keep false acceptance more costly than requiring a manual fallback for an
> unsupported page." — Gate 3

What this implementation **does not** do, matching §12's exclusion list:

- **Nested Form XObject editing.** `exciseText` refuses and falls back to a
  cover. "Recursively changing one shared definition without instance ownership
  can produce effects beyond the selected occurrence." (§9)
- **OCR / scan reconstruction as native text.** A recognised scan's glyphs are
  pixels; there is nothing to excise, so the cover fallback applies and
  `fallbackReason` says so.
- **Rotated / scaled / sheared text and non-standard page geometry** as
  ownership targets.
- **Arbitrary Unicode, complex scripts, bidi** — beyond the existing font
  coverage gate, which warns before a character would be lost rather than
  silently substituting `?`.
- **Rich paragraph/list/table layout, automatic pagination, hyphenation.**
- **PDF/A or PDF/UA certification, secure redaction, tagged-structure repair.**
  The panel's About text says this out loud: "Still not secure redaction: use
  Redact + Sanitize for that."

Not yet implemented from the research, tracked as remaining work:

- **Split story** (§3.3) as a distinct operation from unthreading.
- **A JSON sidecar** with original SHA-256, schema version and revision
  (§10.2). The authoring model currently lives in the app's document model;
  `buildPdf()` reconstructing from `doc.bytes.slice(0)` gives the *behavioural*
  guarantee §10.1 asks for (no cumulative regeneration, exact restore) without
  the persistence format.
- **`expected_revision` staleness rejection** (§10.1) — single-user desktop app,
  no concurrent clients.
- **Glyph-cluster source maps** (§5.3, Gate 2) — needed for correct caret and
  selection behaviour on complex scripts.
- **Raster outside-region diffs** (§13) — the writer is validated by text
  round-trip, not by a perceptual image diff.
- **Backend swap to PDFium** (§15). This app uses pdf.js (render) + pdf-lib
  (write) inside Electron. The research's PDFium lifetime rules (removed objects
  transfer ownership; text-page handles must be closed before removal;
  `GenerateContent` before save) therefore do not apply, but their *intent* is
  preserved by working on a fresh candidate and reopening it.

---

## 8. Files touched by this redesign

| File | Role |
|---|---|
| `src/renderer/js/story.js` | **new** — authoring + layout model, pure; `createEngine` reference API |
| `src/renderer/js/pdfwrite.js` | object-owned removal, framed composition, content-vs-annotation boundary, export warnings |
| `src/renderer/js/textedit.js` | record enrichment, `mergeBlocksIntoParagraph`, `threadEditFrames`, `previewEditLayout`, committed-block skip |
| `src/renderer/js/textops.js` | `exciseText` content-stream decode fix |
| `src/renderer/js/annots.js` | overset badge, story frames, flow arrows, wash gating |
| `src/renderer/js/app.js` | Story / Make paragraph / Composition panel, box→edit routing, truthful tooltip, `truthful:` parity guards |
| `src/renderer/js/tools.js` | clicking a story frame or wash selects the edit |
| `src/renderer/css/app.css` | `.block-order`, `.story-frame`, `.overset-badge` |
| `scripts/story-test.mjs`, `scripts/truthful-save-test.mjs`, `scripts/overset-badge-test.mjs` | **new** suites |
| `README.md` | "Object-owned editing — remove, don't cover" |
