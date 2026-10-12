# Document model and editing

This doc explains how a Word-style document is represented and changed: the model (`@golemdocs/docx`), the operations that edit it (`@golemdocs/ops`), the editor that turns input into operations (`@golemdocs/editor`), and where all of that runs (the layout worker). It also gives an overview of the other editors: the large text editor, the vector editor and the picture tools. Read it before touching anything that changes document content.

## How an edit flows

The layout worker (`client/src/layout/layoutWorker.ts`) owns the open document; the page thread only sends input and draws what comes back.

```
page thread (main.ts)                         layout worker
─────────────────────                         ─────────────────────────────────────────
hidden <textarea> keys/IME/paste              runCommand(wire)
  ui/textInput.ts: editKey, attachTextInput     │ (autoformat, raw/live-preview, font pages first)
menu / toolbar / shortcut                       ▼
  ui/commands.ts → chromeHost.ts              Editor.apply(Command)            editor/src/editor.ts
        │                                       │ plan -> Operation[]  (+ new caret Pos)
        ▼                                       ▼
  send(WireCommand)  ── postMessage ──►       Replica.edit(ops)                ops/src/replica.ts
  (main.ts, layout/protocol.ts)                 ├ Engine.apply(ops) -> Applied {inverse, maps, changed, structural}
                                                ├ History.record(inverse)      (undo)
                                                └ CollabClient.commit(tx)      (only when in a room)
                                                │
                                              Editor.changed(): LayoutSession.invalidate(changed paragraphs)
                                                │
                                              pump(): LayoutSession.run() in time slices
                                                │ encodePage() -> transferable GPU buffers
  applyLayout / applySelection  ◄── postMessage ┘ + SelectionUpdate (caret/selection rects, spell marks)
  PageRenderer (webgl/) draws
```

Key points:

- **Input becomes commands.** `Command` (`editor/src/types.ts`) is the editor's vocabulary (`insertText`, `delete`, `move`, `pointer`, `formatText`, `find`, `replaceAll`, ...). The page-side `WireCommand` (`client/src/layout/protocol.ts`) is a superset that also carries app-level things (format actions, spelling, PDF markup). `runCommand` in the worker handles the non-editor ones itself and forwards the rest to `Editor.apply`.
- **Commands become operations.** The editor never mutates the model directly. Each command plans a list of `Operation`s (plain JSON, see below) and calls `Replica.edit`, which applies them through `Engine`, records the inverses for undo, and (in a room) queues the transaction for the server.
- **Layout is incremental.** `Applied.changed` is the set of changed paragraphs; `Editor.changed()` passes them to `LayoutSession.invalidate` (`layout/src/document.ts`). `structural` (a section break changed) or `styles` widen the invalidation. See [Layout](layout.md).
- **Remote edits take the same road.** `Editor.receive(message)` (`editor/src/editing.ts`) applies the server's transactions, maps the selection through them, and invalidates layout.
- **Assistant and menus use the same functions.** AI tools in `client/src/layout/agentTools.ts` call into the editor; see "AI assistant parity" in `AGENTS.md`.

## Operations and the Engine (`ops/`)

`Operation` (`ops/src/types.ts`) addresses a paragraph by its **id** (Word's `w14:paraId`, stored in the file; `ids.ts` assigns missing ones deterministically on load via `DocumentIndex`) and a position by **model offset** (one per UTF-16 unit; tab, break, drawing and field characters count as one). Offsets never depend on fonts or layout, so an operation means the same on every client, on the server, and after a reload.

Operation families: text (`insertText`, `insertItem`, `insertContent`, `delete`, `formatText`), structure (`split`, `merge`, `insertBlocks`, `removeBlocks`, `removeBetween`), tables (`insertRow`, `removeRow`, `insertCell`, `removeCell`, `setTableGrid`, `setCellProperties`), and document-level state (`setParagraphProperties`, `setStyle`, `setDocumentProperties`, `setDocumentSection`, comments). The full list is the `Operation` union.

`Engine.apply(ops)` (`ops/src/engine.ts`) returns an `Applied`: per-step `inverse` operations and `PosMap`s, the `changed` paragraphs, and the `structural`/`styles` flags. Application is deterministic and forgiving: an operation whose target is gone does nothing, identically everywhere. Paragraphs are canonicalised with `normalizeInlines` (from `@golemdocs/docx`) so equal content has equal structure.

`Replica` (`ops/src/replica.ts`) wraps an `Engine` + `History` and optionally a `CollabClient`. A local edit is a `Transaction` (`{id, client, ops}`, id = client id + counter). Undo and redo are ordinary transactions (the inverse is applied as a new edit), so they work unchanged in a shared document.

`History` (`ops/src/history.ts`) keeps this user's inverses: typing within 1.5 s that continues where the last edit ended is one step (`group`), the stack holds 500 entries, and remote edits move entries through `History.map` (exact for recent entries, approximate for old ones). `Editor.historyMark/foldHistory/restoreHistory` let the worker treat several edits as one step (used by the live-preview raw-source paragraph).

`mapping.ts` (`PosMap`, `Mapping`, `mapPos`, `mapOperation`) moves positions and whole operations through other edits; it is used for rebasing, undo history and selections.

## The Editor (`editor/`)

`Editor` (`editor/src/editor.ts`) holds a `Selection` (anchor/focus as `{paragraph, offset}` with real `Paragraph` objects) over a `Replica` and a `LayoutSession`. The class is built as a chain of layers, each extending the one before (a class cannot span files):

`EditorBase` (`base.ts`: state, positions) > `EditorNavigation` (`navigation.ts`: caret movement, geometry from laid-out lines) > `EditorEditing` (`editing.ts`: `edit`, `changed`, undo/redo, remote `receive`, delete/split/merge planning) > `EditorLinks` (`links.ts`) > `EditorSearch` (`search.ts`) > `EditorFormatting` (`formatting.ts`) > `EditorComments` (`comments.ts`) > `EditorSections` (`sections.ts`) > `EditorTables` (`tables.ts`, also pasting content). `editor.ts` adds `apply`, the command dispatcher.

Selection and caret:

- The model selection is object-based, but everything that crosses a boundary (history, network presence, undo restore) uses `selectionIds` / `Pos` (paragraph **id** + offset), so it survives rebasing. `Replica.mapSelection` moves one through a `Mapping`.
- Caret and selection geometry (`Caret`, `SelectionGeometry`) is computed from the `PageLayout` lines (`navigation.ts`); the worker sends it to the page in each `SelectionUpdate`, where `webgl/selectionLayer.ts` draws it. Visible offsets (hidden text, caret x) only appear when talking to layout (`toModel` / `toVisible` in `@golemdocs/layout`).
- Word, character and grapheme rules (CJK-aware) are shared by every editor in `textUnits.ts` and `segment.ts`.

Pure helpers: `tableModel.ts` (merge/split cells as functions on a logical grid), `pattern.ts` (search expressions), `formatting.ts` (`withFormat`).

## Clipboard

- **Events and keys** live in the page: `ui/textInput.ts` (`attachTextInput`) owns the hidden textarea for both the document editor and the text editor, and `ui/clipboard.ts` reads and writes the system clipboard (`readClipboard`, `clipboardOf`, `writeClipboardText`).
- **Copy** returns the worker's last `selection.text` (kept up to a size limit); **cut** sends a backward `delete`.
- **Paste** goes through `pasteClipboard` in `main.ts`: HTML (up to `MAX_PASTED_HTML`, 2 MB) on formats that have marks becomes a `pasteHtml` command, otherwise plain text becomes `insertText`. In the worker `pasteHtml` converts with `htmlToPaste` (`formats/paste.ts`) and applies a `pasteContent` command (blocks plus style definitions; one undo step), falling back to `insertText`.
- Paste Special is `ui/pasteSpecialDialog.ts`; typed characters outside the core font atlases make the worker load font pages first (`session.ensurePages`).

## Find and replace

- **Document editor:** `ui/findDialog.ts` collects the query; `chromeHost.ts`/`main.ts` send `find` and `replaceAll` commands (`main.ts` around `find: (query, backward) => send(...)`). `EditorSearch` (`editor/src/search.ts`) searches paragraph text with `pattern.ts` (case, whole word, regex, `$1` references) and returns `found` / `replaced` counts, which the worker stores in `this.search`. Replace All is a single edit.
- **Large text:** `textEditor/search.ts` searches bytes in the background and shares `pattern.ts` with the document editor.
- **Search all documents:** `ui/searchPanel.ts` + `client/src/search/` (index worker); not part of the model.

## Other editors (overview)

| Editor | Where | Model and undo |
| --- | --- | --- |
| Large text (`.txt`, logs, CSV) | `client/src/textEditor/` (`handle.ts` is all the rest of the app holds; `view.ts` is a lazy chunk) | Piece table (`pieceTable.ts`) + `LineIndex`; own caret, undo and clipboard; byte-offset `TextOp`s (`ops/src/textOps.ts`) for rooms. Seen by the chrome as a `DocumentEngine` (`client/src/documentEngine.ts`, implemented as `textEngine` in `main.ts`). Details: [text-files.md](../text-files.md). |
| Vector drawing (SVG) | `client/src/vector/` (`model.ts` scene tree, `edit.ts` pure scene edits, `nodes.ts` object form), `ui/vectorEditor.ts` (pointer/keys), `ui/vectorLayer.ts` (paint), `ui/vectorSession.ts` (single lazy entry), `layout/vectorLayers.ts` | The editor works on a copy of the `Scene` and keeps earlier scenes for undo. The page sends `vectorScene` to the worker, which diffs it into objects for rooms (`ObjectSync`). Unmodelled SVG is kept as raw XML and written back. |
| Picture tools | `ui/drawLayer.ts` (sketching), `ui/cropLayer.ts`, `ui/pictureDialogs.ts`, `formats/imageDraw.ts`, `formats/imageEdit.ts` (canvas ops), `layout/pictureLayers.ts` | A picture's shapes are a keyed object list over untouched pixels; they are flattened only on export. Worker handles `shapes` / `shapesStep` (undo/redo of the person's own changes). |
| PDF markup | `layout/pdfAnnotator.ts`, `ui/formLayer.ts`, `ui/pdfEditTools.ts` | Annotations, fields and edits as object lists; see [pdf-editing.md](../pdf-editing.md). |

**Pictures in the text** (inline or floating, Word and the formats that open as it). A click on a picture selects it: the selection is the one model position holding its `Drawing` (like an equation), found by `EditorLinks.pictureUnder` from the `drawing` each `ImageItem` carries (a picture behind the text is picked only where there is no text). So Delete, typing, copy and Undo need nothing special. `selectedPicture()` gives the worker what it sends as `SelectionUpdate.picture` (page, rectangle, which picture) for `ui/pictureFrame.ts` (frame and four resize handles, a DOM layer like the crop box). Commands: `moveDrawing` (drop at a point: in line goes to the text there, floating gets its page position, `placedOnPage` in `editor/src/drawings.ts`, and is re-anchored to the paragraph under it), `moveDrawingToParagraph` (assistant), `resizeDrawing`, `replacePicture`; each is one undoable step that deletes and re-inserts the drawing and keeps it selected. In `main.ts` a press waits for the worker's answer (`pressed`, `settlePress`) to know whether it took hold of a picture: a drag then carries the frame (`dragPicture`) and the drop sends `moveDrawing`; otherwise the drag selects text as before. A double click opens the picture in the image editor (`editPicture`): the document is saved and put away, the picture opens as an unsaved picture document (`OpenDocument.detour`, which nothing saves) with `PictureDetourBar` over it, and Done opens the document again (`openSource(local:…)`) and sends `select` + `replacePicture` (`pendingPicture`, applied when it has loaded); Cancel only opens it again. Not offered in a room others are in (opening it again would leave the room). Vector drawings keep their own in-place editor (`embeddedDrawing`).

The picture, drawing and PDF editors all use `ObjectReplica`/`ObjectSync` (`ops/src/objects.ts`, `layout/objectSync.ts`): changes are `put`/`del` of one keyed object in a layer, with the person's own undo.

Shared UI components (dropdowns, `LayerTree`, cursors, shape lists) are mandated in `AGENTS.md` ("Consistent UI"); the vector editor and picture tools must use the same ones.

## Key files

| Path | Role |
| --- | --- |
| `ops/src/types.ts` | `Operation`, `Pos`, `Transaction`, `RunFormat` |
| `ops/src/engine.ts` | `Engine.apply`, `Applied`, `Step` |
| `ops/src/ids.ts` | `DocumentIndex`, `blockKey`, paragraph id rules |
| `ops/src/mapping.ts` | `PosMap`, `Mapping`, `mapOperation` |
| `ops/src/history.ts` | `History`, undo grouping, `HistoryMark` |
| `ops/src/replica.ts` | `Replica`: edit, undo/redo, collab hookup |
| `editor/src/editor.ts` + layer files | `Editor`, command dispatch |
| `editor/src/types.ts` | `Command`, `CommandResult`, `Selection`, `Caret` |
| `client/src/layout/layoutWorker.ts` | Owns document, `runCommand`, `pump`, `flush` |
| `client/src/layout/layoutClient.ts` | Page-side wrapper (`LayoutClient`, `DocumentListener`) |
| `client/src/layout/protocol.ts` | `WireCommand`, `ToWorker`, `FromWorker`, `LayoutUpdate`, `SelectionUpdate` |
| `client/src/layout/autoformat.ts`, `livePreview.ts` | Markdown shortcuts as you type; live-preview source paragraph |
| `client/src/layout/autocorrect.ts`, `typos.ts`, `ui/autoCorrect.ts`, `ui/replacementsDialog.ts` | Autocorrect as you type (smart quotes, dashes, symbols, capitals, links, English typos, the user's replacement list) and its per-rule settings; the list is `word.replacements.v1`, synced with the account |
| `client/src/layout/agentTools.ts` | Assistant edit tools (reuse editor functions) |
| `client/src/ui/textInput.ts`, `ui/clipboard.ts` | Keyboard, IME and clipboard for canvas editors |
| `client/src/documentEngine.ts` | Interface the chrome uses for non-document editors |
| `client/src/document/arrange.ts` | Only a `Page`/`Bounds` positioning helper, not the model |

## Invariants and gotchas

- **Never mutate the model outside `Replica.edit`/`Engine.apply`.** Anything else is invisible to undo, layout invalidation and collaboration.
- **Operations must stay deterministic and total.** Every client (and the server's `snapshot.ts`) replays the same log; an operation that throws or depends on layout will desynchronise rooms. New operation types need an inverse, a `PosMap`, a `mapOperation` case, an `isOperation` validator case (the server rejects unknown ones), and a fuzz/test addition in `ops/test/`.
- **Addresses are ids + model offsets**, never `Paragraph` references across a boundary; selections that leave the worker or enter `History` must use `Pos`.
- **A command that adds characters outside the core atlases must wait for font pages** (`runCommand` re-enters after `ensurePages`); equations wait for `ensureMath`.
- **Viewers and offline rooms are read-only**: `readOnly` in the worker blocks everything except selection/view commands.
- **The document is in the worker.** The page cannot read it synchronously; use a `ToWorker` request (`save`, `agent`, ...).
- **Format-dependent behavior** goes through `ui/formats.ts` (`FORMATS[kind]`), e.g. which marks a format can hold.
- Large pieces of UI and editors are lazy chunks; keep new code behind the existing entry modules (see `AGENTS.md`, "Bundle size").

## Related docs

- [Layout](layout.md) and [Rendering](rendering.md)
- [Formats](formats.md)
- [UI](ui.md)
- [Assistant](assistant.md)
- [Collaboration](collaboration.md)
- [Large text files](../text-files.md)
- [PDF editing](../pdf-editing.md)
- [Chunked storage](../chunked-storage.md)
- [`ops/README.md`](../../ops/README.md) (operation table and protocol; parts about `devServer.ts` are outdated, see [Collaboration](collaboration.md))
