# Layout

Layout turns a document model (`WordDocument` from `@golemdocs/docx`) into positioned pages: glyphs, rectangles and images in page-relative points, independent of any file format or renderer. It runs in a Web Worker that also owns the document, the editor and the multiplayer replica, so typing and big relayouts never block the UI thread. This doc covers the layout engine (`layout/`), the worker and its message protocol (`client/src/layout/`), incremental relayout, the assistant tools that run in the worker, and the spelling hooks.

## How it works

```
 main thread                       layout worker (layoutWorker.ts)                 layout/ package
 -----------                       ---------------------------------               ---------------
 LayoutClient.command(wire) -----> handleInbox() (strict order)
                                    OpenDocument.runCommand -> Editor.apply  -----> session.invalidate(changed paras)
                                    pump(): while session.needsLayout:
                                      session.run({onPage, onSlice, ...}) ------->  paginate(): restart one page early,
                                         every SLICE_MS (12 ms):                     layoutParagraph / layoutTable per block,
                                         flush() = encodePage + post                 stop when a page's PageStart matches an
 applyLayout(update) <------------- {type:'layout', pages, order, drop,              old page past all changes (Converged)
 applySelection()                     overlays, faces, selection}
```

1. **Input.** `LayoutSession.create(doc, fonts)` (`layout/src/document.ts`) resolves styles, loads the faces, CJK/extra pages and math font the document needs (see [Rendering](rendering.md), "Fonts and atlases"), then `run()` paginates. The worker never lays out a paragraph directly; it asks the session.
2. **Output.** `PageLayout` objects (`layout/src/display.ts`): `glyphs` (per face: `GlyphList` of 20-byte instances), `background` / `foreground` `RectList`s, `images`, and `lines: LineRecord[]` (the geometry the editor uses for carets and hit-testing; never sent to the main thread). `encodePage` (`layout/src/wire.ts`) strips a page to typed arrays and JSON-safe values for transfer. Model objects never cross the thread boundary (an `ImageItem` keeps the `Drawing` it shows, so a click can find it; `encodePage` leaves it off).
3. **Pagination.** `paginate()` walks sections (`splitSections`) and their blocks through `LazyBlocks`, which lays blocks out on first use in order (list numbering advances as blocks are laid out) and keeps only a small window alive. It handles page and column breaks, columns (`SectionGeometry.columns`, equal widths), keep-with-next chains, keep-lines, widow/orphan control, space-before suppression after natural breaks, odd/even-page section breaks, floating images (`placeFloats`), table row splitting across pages with repeated header rows, and headers and footers (laid out as overlays after the body, because they need the page count; `onHeaderFooter`).
4. **Paragraphs** (`layout/src/paragraph.ts`): `layoutParagraph(paragraph, ctx, width)` collects visible text and run styles (`TextCollector`, `runs.ts`), shapes glyphs with face metrics (advances, with fallback to extra and CJK pages per character), then breaks lines greedily. A break is allowed after a space, tab, soft hyphen, after a hyphen or dash followed by a word character, and between CJK characters per kinsoku rules (`isBreakAfter`, `cjkBreakBetween`, `noLineStart`/`noLineEnd` in `fonts/cjk.ts`). Tab stops with leaders, justification (spaces stretch except on the last line), alignment, line spacing rules (`auto`, `exact`, `atLeast`), underline/strike/highlight rects, list labels, check boxes, inline images, math (`layout/src/math/`), and formatting marks (`marks.ts`) are all emitted per line. Each `LineLayout` also keeps caret stops (`stops`) and `SourceSpan`s mapping visible offsets to model offsets (`offsets.ts`).
5. **Tables** (`layout/src/table.ts`): `layoutTable` resolves the grid, widths (including percentage), cell merges, conditional style formatting (`tblLook` banding), borders and shading, and lays each cell's content as a `BoxLayout` (nested blocks). `emitRow` / `emitRowSlice` draw whole rows or the part that fits on a page.
6. **Caching.** `layoutParagraph` caches per `Paragraph` object in a `WeakMap`, keyed by font page versions, width, layer, list label and so on (`CachedParagraph`). Edits delete the changed paragraphs' entries. Page-dependent layouts (headers/footers with page fields) are not cached.

## Incremental relayout

- Every `PageLayout` records a `PageStart` (`document.ts`): the pagination state at the top of its body (section, block, line, row, list counters, previous-block spacing state, and whether layout can `restartable` there).
- `session.invalidate(paragraphs, {structural?})` records dirty paragraphs and the earliest page holding them. `invalidateStyles()` and structural changes (sections, styles, Flow width, formatting marks) restart from page 0 and disable page reuse (`noReuse`).
- `run()` restarts **one page before** the first change (keep-with-next and widow control can pull content back), at a restartable page. As each new page starts, `sameStart` compares its state with old pages past every change; on a match it throws an internal `Converged` and **keeps the old pages from there on**, moved if the count changed. Pages keep their ids when kept, so an edit sends only changed pages (`LayoutUpdate.pages`, with `order` listing every id and `drop` listing removed ones).
- An edit that shifts everything after it (a line added early in a 500-page document) re-paginates to the end in slices, nearest pages first. Every `sliceMs` the worker `flush()`es finished pages and yields via `MessageChannel` (`yieldTask`) so newer commands get in. A newer `invalidate()` during a slice throws `Superseded` and `run` returns `completed: false`; `pump()` loops until `needsLayout` is false.
- `session.displayPages` blends new pages with old ones after them while a run is in progress, so the screen shows a best guess; the editor's `geometry()`, `caret()` and `hitTest` use these.
- Large-document performance relies on: lazy block layout, the paragraph cache, convergence, slice streaming (first pages show quickly; `LayoutTimings.body/headers/fonts/read` are reported on `done`), GPU upload on demand, and `LayoutSession.linesOf(paragraph, hint)` searching outward from where a paragraph was last seen.

## The worker and its protocol

`layoutWorkerEntry.ts` is a stub that imports `layoutWorker.ts`; `vite.config.ts` forces the worker's code into a `layoutCore` chunk so Safari does not run the entry twice. `LayoutClient` (`client/src/layout/layoutClient.ts`) is the main-thread side; `protocol.ts` defines `ToWorker` and `FromWorker`.

- **Ordering.** Messages are handled strictly in order (`inbox`, `handleInbox`). Only the start of an `open` holds the queue (it waits for the locale). Commands sent while a document is loading wait on `OpenDocument.setUp`. Every message carries a `doc` number; the client drops answers for older documents (`message.doc !== this.doc`), but registers new faces from any document, since the worker will not resend them.
- **Page to worker:** `open` (a `DocumentSource` of ~30 kinds: docx, pdf, md, html, txt, welcome...), `command` (a `WireCommand`: editor commands plus `format`, `spellNext`, `spellCheck`, `spellWords`, `spellAt`, `countWords`, `pasteHtml`, PDF commands...), `reflow`, `marks`, `locale`, `warm` (a document is still downloading: load the default font's faces now), `insertImage`, `shapes` / `vectorScene` (picture and drawing layers), `save`, `convert`, `media`, `linkAt`, `agent`, `spellText`, `pointer` and `joinRoom` / `leave` (multiplayer), `close`.
- **Worker to page:** `opened`, `layout` (`LayoutUpdate`: faces, pages, overlays, order, drop, and the current `SelectionUpdate`), `done` (first full layout finished, with timings), `selection` (caret, highlight rects, spell marks, format state for the toolbar, comments, remote carets...), `error`, `notice`, `saved`, `media`, `linkAt`, `agentResult`, `spellText`, `roomState`, `pointers`, `remoteEdit`.
- **Request/response** pairs use a numeric `request` id (`save`, `convert`, `media`, `linkAt`, `agent`, `spellText`).
- `selection()` packs geometry into `Float64Array`s (`rects`: page, x, y, w, h; `spellMarks`: plus kind) that are transferred. A selection update accompanies every layout so text and caret change in the same frame.
- `OpenDocument` (`layoutWorker.ts`) holds the document, `Replica` (ops), `Editor` (`@golemdocs/editor`), `LayoutSession`, optional PDF view/annotator, picture layers, and the multiplayer `RoomClient`. PDFs shown as pages bypass the session: `pumpPdf` lays pages out lazily via `formats/pdfPages.ts`.

## Spelling and grammar hooks

- `spellCheck` (live on/off and the user's dictionary), `spellWords`, `spellNext`, `spellAt` are `WireCommand`s. `OpenDocument.spellMarks(editor)` asks `issuesOf(paragraph, ...)` for each visible paragraph (`editor.marks` maps text offsets to line rectangles) and returns squiggle rects with kind 0 (spelling) or 1 (grammar). The word being typed is not marked until the caret leaves it.
- Dictionaries (`client/src/spelling/`) load lazily per language the first time a paragraph in that language is checked; marks are re-sent when they arrive (`loadingMarks`). Grammar rules are English only (`spelling/grammar.ts`). Squiggles are drawn on the main thread by `SelectionLayer` (see [Rendering](rendering.md)).
- `spellText` checks plain-text file lines without any document (used by the large-text editor).

## Assistant tools

`client/src/layout/agentTools.ts` implements the assistant's document tools. `runAgentTool(env, name, argsJson)` looks the name up in `TOOLS` (own properties only), parses JSON args, and returns text for the model. Tools change the document only through `env.run(WireCommand)`, the same path typing and the menus use, so edits undo, lay out and sync to rooms. PDF documents use `agentPdfTools.ts`. Descriptions live in `server/src/assistantTools.ts` and must match names and arguments. See AGENTS.md ("AI assistant parity") and `client/test/agentTools.test.ts`, `assistantParity.test.ts`.

## Key files

| Path | Role |
| --- | --- |
| `layout/src/document.ts` | `LayoutSession`: pagination, sections, columns, headers/footers, incremental relayout |
| `layout/src/paragraph.ts` | Line breaking, alignment, tabs, decorations, per-paragraph cache |
| `layout/src/table.ts` | Table and box layout, row slicing |
| `layout/src/runs.ts`, `context.ts` | Text collection, run style resolution (`RunStyle`, `LayoutContext`) |
| `layout/src/display.ts` | `PageLayout`, `LineRecord`, glyph/rect instance formats |
| `layout/src/wire.ts` | `encodePage`, `describeFace`, `EncodedPage`, `FaceDescriptor` |
| `layout/src/offsets.ts` | Visible text to model offsets (`SourceSpan`) |
| `layout/src/reflow.ts`, `marks.ts`, `source.ts` | Flow width, formatting marks, Markdown source display (module-level switches) |
| `layout/src/fonts/`, `math/` | Font resolution and loading, equation layout |
| `client/src/layout/layoutWorker.ts` | The worker: `OpenDocument`, `pump`, `flush`, command dispatch, spelling, save/convert |
| `client/src/layout/layoutClient.ts` | Page-side API and listener dispatch |
| `client/src/layout/protocol.ts` | `ToWorker`, `FromWorker`, `LayoutUpdate`, `SelectionUpdate` |
| `client/src/layout/agentTools.ts`, `agentPdfTools.ts` | Assistant tools run in the worker |
| `client/src/layout/formatting.ts`, `selectionFormat.ts` | Menu/toolbar formatting actions and toolbar state |
| `client/src/layout/autoformat.ts`, `livePreview.ts` | Markdown shortcuts, source shown at the caret |
| `client/src/layout/autocorrect.ts` | Autocorrect as you type: pure rules (what the text typed so far should become); the worker's `autoCorrected` applies one as a single undoable replacement that Backspace takes back |
| `editor/src/` | `Editor`: commands, hit-testing (`navigation.ts`), selection geometry |

## Key data types

`WordDocument` (docx), `LayoutSession`, `PageLayout`, `PageStart`, `LineLayout` (per-glyph typed arrays) and `LineRecord` (editor-facing line geometry), `ParagraphLayout`, `TableLayout`, `SectionGeometry`, `RunResult` (`from`, `added`, `removed`, `moved`, `convergedAt`), `EncodedPage`, `LayoutUpdate`, `SelectionUpdate`, `WireCommand`.

## Invariants and gotchas

- All coordinates are points, page-relative, y down. Layout is pure and has no DOM; it runs in Node for tests and could run on a server.
- Always `session.invalidate(...)` the changed paragraphs (the `Editor` does this) before `run()`; include a paragraph that was split so the restart page is known. A paragraph never laid out forces a restart from page 0.
- `reflow`, `marks` and `source` are module-level switches (`setReflowWidth`, `setFormattingMarks`, `setShowingSource`); after changing one the caller must relayout (`OpenDocument.relayout()`).
- Edits that add text with uncovered characters must load pages first (`ensurePages`) or the glyphs fall back wrongly; `runCommand` does this before applying. Math needs `ensureMath`.
- Pages are transferred and then dead in the worker; the worker keeps layout objects it still needs and only encodes pages in `pending` that are still in `keep`.
- Messages may arrive while a document is still loading: anything that needs the document must await `setUp`. Never block the worker for long; slice and `yieldTask`.
- Table cell paragraphs are flattened for invalidation (`tableHasAny`): a change in a cell marks the whole table block dirty.
- Header/footer layouts are not cached and depend on page number/count; `layoutOverlays` re-lays them when the count changes.
- Tests: `layout/test/` (`layout.test.ts`, `incremental.test.ts` for convergence, `cjk`, `extraPages`, `math*`, `offsets`) and `client/test/layoutWorker*.test.ts`.

## Related docs

- [Rendering](rendering.md)
- [Plain text files](../text-files.md)
- [Chunked storage](../chunked-storage.md)
- [Localization](../localization.md)
