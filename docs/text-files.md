# Plan: 50 MB text and log files

**Status.** Done: the guard and threshold (files of 8 MB or more open in the large-text editor; text, CSV and TSV), line index,
go to line, search, filter, level colouring, wrapped lines, format profile and chrome. Measured in a
browser on a 51 MB, 500,000-line log: first lines on screen in about 100 ms, search 240 ms, page heap well under the 200 MB
budget. **Editing is done too** (see *Editing, as built* below): a piece table under a live line index, a caret and
selection drawn on the canvas with a hidden textarea taking the keyboard, undo and redo, Replace and Replace All,
autosave in the browser, upload to the account (up to the server's 50 MiB), "Open Selection as Document" and assistant tools.
**The text is drawn by the app's WebGL renderer, on the same camera as documents** (see *Drawing, as built*): JetBrains Mono,
smooth zoom and pan, no DOM rows. The editor is its own lazily loaded chunk (`textEditor/view.ts` and what it uses, about 60 kB):
`textEditor/handle.ts` is what the rest of the app holds.
**Not done:** opening the filter's matches (rather than a selection) as a document, saving a Windows-1252 file as
Windows-1252 (it is saved as UTF-8, which keeps every character).

## Editing, as built

- **Model.** `pieceTable.ts` keeps the text as pieces of two never-changed buffers (the file as opened, and one edits append
  to); an edit swaps a few pieces and copies no text, and undo puts the removed pieces back by reference. `lineIndex.ts`
  gives each line's start; `reindex(at, removeLength, insertLength)` rescans only the lines an edit touched and moves the
  rest by the change in length. Measured in Node on a 46 MB, 500,000-line log: a keystroke 0.22 ms and Enter 0.26 ms
  (budget 5 ms), Replace All over 500,000 matches 0.46 s plus 0.05 s to index the result (budget 2 s), the file as UTF-8 4 ms
  and as UTF-16 0.22 s (budget 1 s). Memory with edits was not measured in a browser: a Replace All briefly holds the old and
  the new text, and an undo step after it keeps the old one. `textDocument.ts` joins
  the two with the undo history: typing and deleting in a row are one step, and Replace All swaps in a whole new table and
  index as one step (undo swaps the old back; the last few such steps are kept).
- **Carets and keys.** `positions.ts` has the pure parts: a position is (line, column in UTF-16 units), turned into a byte
  offset by encoding the one line's prefix; characters move whole (emoji, letters with accents), words by letter runs; and the
  planners that turn Backspace, Delete, Enter, typing and paste into one byte-range edit. Lines longer than 20,000 bytes
  show a prefix: the caret cannot enter the rest, but an edit keeps it.
- **Page.** `view.ts` takes typing, input-method composition and the clipboard through a hidden textarea (`data-large-input`),
  which sits at the caret so an input method's window opens there. The app's canvas hands it pointer presses and drags (CSS pixels,
  turned to a line and column by `scene.ts`); the view pans the camera, with a margin, only when the caret is out of view.
  Ctrl/Cmd shortcuts are the app's own (undo, select all, find) because the textarea is not a form field to `isFormField`.
- **While showing only matching lines** an edit may change text within a line but not add, join or remove lines (the list of
  lines is the matches, which would shift under the caret). Edits wait until the line index is built.
- **Encoding.** The text is UTF-8 inside; on save it is written back as it came: UTF-8 (with its byte order mark if it had
  one) or UTF-16 (`encoding.ts`). A file that was not edited is saved and downloaded as the exact bytes it came as.
- **Saving.** The first edit gives the file a place in this browser (an ordinary stored `.txt`, `.csv` or `.tsv`, named so
  that it reopens as large text; a name with no such extension gets `.txt`) and autosave works as for any document. An
  unedited file is never stored. A file that is edited down below 8 MB reopens as an ordinary document. The account keeps
  files up to the server's 50 MiB; a bigger one stays in this browser, with a message.
- **Assistant.** The `text_file` tool (info, read, find, replace, edit_lines, insert_lines, delete_lines, undo, redo) acts on
  the editor; the paragraph tools are refused while it is open, since the document under it is empty.

Goal: open, scroll, search and copy from a 50 MB log (about 500,000 lines) without freezing or
running out of memory, and edit and save it.

## What we measured (the current text path)

Text files open as one paragraph per line in the ordinary document model. Node, on this machine,
lines like `2026-09-29T10:00:00Z INFO [worker-3] request id=42 …` (about 100 bytes each):

| File | Lines | Build model | Replica | Layout (all pages) | Pages | Heap |
|---|---|---|---|---|---|---|
| 2 MB | 20,000 | 9 ms | 16 ms | 0.4 s | 770 | 151 MB |
| 10 MB | 100,000 | 19 ms | 77 ms | 2.4 s | 3,847 | 707 MB |
| 51 MB | 500,000 | 105 ms | 351 ms | 24 s | 19,231 | **3.5 GB** |

Writing the 51 MB model as a `.docx` takes 1.4 s and produces 5 MB. Reading and building the
model is not the problem. About 7 KB of heap per line is: a paragraph, run and layout objects per
line, an id per paragraph for the editor, and 19,000 laid-out pages. A browser worker cannot hold
3.5 GB, and autosave would rewrite all of it after every edit. The ordinary path is fine up to
about 5 MB (25,000 lines, roughly 150 MB); beyond that it needs a different representation, not
tuning.

Making the model itself lazy (paragraphs created on demand) would touch the model, layout,
replica, editor, undo, collaboration, saving and the page protocol. Rejected: a large-file mode
that sits beside the ordinary path is far smaller and safer.

## Design: a large-text mode

Files over a threshold (start at 8 MB; tune from the benchmarks below) open in **large-text mode**
instead of the document model. The bytes stay bytes.

1. **Storage.** Keep the file as one `ArrayBuffer` (50 MB) and a **line index**: a `Uint32Array`
   of the byte offset of each line start (500,000 lines is 2 MB). Built in one pass over the bytes,
   looking for `\n` (0x0A), in a worker; `\r\n`, a lone `\r`, and a missing final newline are
   handled; the index is built in chunks so the first screen appears immediately and a progress
   readout covers the rest. Only lines in view are decoded (`TextDecoder` on a subarray), so memory
   is about the file size plus a few MB. UTF-16 and Windows-1252 files (see `textFiles.ts`) are
   converted to UTF-8 once at open, which doubles the UTF-16 case; acceptable.
2. **View.** A virtual list in the page (not the page/GL renderer): a scroll container as tall as
   the file, and only the lines in view, and a screenful either side, in the DOM, in a monospace
   font, with line numbers. Wrapped and unwrapped modes; wrapped needs per-line heights, computed
   from character counts (monospace) into a prefix-sum array so the scroll position maps to a line
   by binary search. Lines longer than a cap (say 10,000 characters) are cut with an expander, so a
   minified 50 MB single-line file doesn't hang.
3. **Search.** Streaming search in the worker over the bytes (literal, case, whole word, regex),
   reporting a count as it goes and the next and previous match at once; a cap on stored matches.
   Highlights on visible lines only. Go To Line. A **filter** ("show only lines matching…") is the
   log feature people use most: a second, smaller index of matching line numbers driving the same
   list.
4. **Copy.** Selecting across thousands of lines the browser can't hold in the DOM: a selection
   model of (line, column) to (line, column), drawn over the visible lines, and Copy that builds
   the text from the bytes.
5. **Levels and colour.** Optional line colouring by simple rules (ERROR, WARN, and so on),
   computed for visible lines only.
6. **Chrome.** A `textEditor` format profile, like the picture profile: the menus and toolbars show
   Find, Go To, Copy, Wrap, zoom and Download, and nothing that edits.

### Editing and saving (second stage)

- **Piece table** over the original buffer plus an append buffer: insert and delete at any point
  cost little and the file is never copied. Line index updated incrementally for the edited region.
  Undo and redo are lists of piece-table edits.
- **Save** by streaming the pieces into a `Blob` (no 50 MB string). Autosave stores the raw file
  (not a `.wdoc`) in IndexedDB as a blob, debounced (10 s or on leaving), and the library lists it
  with a "large text" kind. Cloud upload is off for these until the server's limits are known.
- **Download** writes the original bytes untouched if nothing was edited.

### Bridge to the ordinary editor

"Open this range as a document": select lines 1,000–3,000 (or the filter's matches, capped) and
open them as an ordinary text document, in a new tab. This is how a log turns into something to
annotate or convert.

## Steps

1. **Guard now (small):** above the threshold, don't build the model; open a read-only view. Even a
   bare list is better than the tab dying.
2. **Line index + virtual list + wrap + go to line** (worker + view), with tests and a benchmark.
3. **Search and filter.**
4. **Selection and copy; colouring; format profile and chrome.**
5. **Editing:** piece table, undo, save, library entry.
6. **Range to document.**

## Budgets (checked by a benchmark script that generates the file; it is not committed)

| What | Budget at 50 MB |
|---|---|
| Time to first lines on screen | < 500 ms |
| Line index complete | < 1 s (progress shown) |
| Scroll | 60 fps; any position reached in one frame |
| Search, whole file, literal | < 1.5 s; first match immediate |
| Memory (page + worker) | < 200 MB |
| Save after an edit (piece table to blob) | < 1 s |

## Tests

- Line index: `\n`, `\r\n`, `\r`, mixed endings, empty file, final line without newline, multi-byte
  characters at chunk boundaries, one enormous line, NUL bytes.
- Prefix sums and scroll mapping: every line reachable, wrapping consistent with character counts.
- Search: matches across chunk boundaries, case, whole word, regex, no matches, cap reached.
- Piece table: random edits against a plain string model (property test), undo and redo.
- Benchmarks above in Node, and the same file opened in the browser for the frame-rate and memory
  numbers.

## Decisions for you

1. **Viewer first, editing later?** Recommended: logs are read far more than edited, the viewer
   covers most of the value, and editing adds the piece table, undo, save and library work.
2. **Threshold.** 8 MB proposed. Below it, the ordinary document (formatting, comments, Convert To)
   still works; above it, only the viewer.
3. **Storing large files in the library or account.** Proposed: not for the viewer (opening
   doesn't save a copy); for edited files, this browser only.
4. **Fonts.** *Decided:* the editor draws with the shipped fonts like every document: JetBrains Mono, added for it and made the default monospace.

## Drawing, as built

- **One experience.** The editor no longer has a scroller or a zoom of its own. While it is open `main.ts` keeps using the one global
  `camera`, with `textView.bounds()` in place of the pages' bounds, so the wheel, Ctrl+wheel and pinch, touch, middle-drag, Cmd/Ctrl +/-/0,
  fit and the zoom menu behave exactly as in a document. The empty document under it is not touched (`arrange()` skips it).
- **Text on a grid.** `lines.ts` lays a line out in cells: 0.6 em each (JetBrains Mono's advance), two for wide East-Asian characters,
  none for combining marks, tabs to multiples of 8, wrapped at a fixed column count, which is what fits the window at 100% zoom
  (zooming scales the text, it never rewraps; resizing does). `scene.ts` turns that into document-space geometry: row heights (a
  Fenwick tree, estimated from line lengths and made exact as lines are laid out), the line and column at a point, and the rectangles
  of a caret, a selection and a search match. Both are pure and tested without a GPU.
- **Fonts.** `fonts.ts` loads JetBrains Mono on the main thread (atlases through the shared `AtlasLibrary`), and characters it lacks from
  its extra page, then Calibri and its pages, then the CJK pages, the order documents use. They are fetched when text first shows them.
  JetBrains Mono (regular, bold, italic, bold italic; OFL-1.1, made with `pnpm fonts`) is also the default monospace for plain text,
  Markdown code and code blocks; a document that names Courier New keeps it.
- **GPU.** `glRenderer.ts` builds the file in chunks of 128 lines, one glyph buffer per face plus a gutter rectangle each, cached (at least 24
  chunks, more when more are in view), with its own float64 origin so float32 stays exact on a 500,000-line file. Selection, search marks, the
  current line, the caret and composing text are rebuilt every frame for the rows in view. Building is limited to 10 ms a frame; the rest
  follows in later frames. There is no level of detail: text is drawn as text at every zoom (an earlier version drew a bar per line below
  4 px a row; it looked wrong and was removed). If zooming far out proves too slow, cap the zoom rather than switching representations.
- **Measured** on a 49 MB, 500,000-line log in Chromium: the slowest of 400 scroll steps took 1.5 ms of CPU (median 0.1 ms), jumping to any
  line builds in about 2 ms, zoomed out to the 1% minimum a frame is 0.3 ms with no glyphs, and the page heap settles near 100 MB after
  opening (a transient of about 550 MB while the file is read and converted).
- **Tests read the screen through `window.textEditor`** (`state()`, `pointOf()`, `numberPoint()`; see `e2e/files/large-helpers.ts`), since the
  text is on the GPU.

## Editing together
A text file in the account joins a room of kind `text` (`ops/src/textOps.ts`, `server/src/roomCore.ts`, `textEditor/textSync.ts`), up to
16 MiB (`MAX_SHARED_TEXT_BYTES`: the room holds the file a few times over while writing it, in a 128 MB Durable Object; a bigger file is
edited alone, with a message).
- **Changes** are `{at, remove, text}` in UTF-8 byte offsets, so the piece table and the server's bytes mean the same thing. The room
  logs and orders them like any other kind; a client whose change lost the race transforms it over the others' (`crossOps`: a replace
  is a delete and an insert, and two inserts at one place go in log order) and sends it again. `applyTextOps` writes the log into the
  file itself (every 15 s while people type, and when the room ends).
- **Undo** is the person's own: `TextReplica` keeps inverse changes and moves them over what others do, so Ctrl+Z never takes back
  someone else's typing. A change is at most 256 KB and a transaction at most 1 MB (a log row is limited to 2 MB); a paste or Replace All
  goes as several transactions that undo as one. While shared, Replace All is refused above 20,000 matches.
- **The room's file is UTF-8 without a BOM**: a UTF-16 or Windows-1252 file is normalised when it is shared.
- **Carets** are byte offsets, moved over each change that arrives; they are drawn by the renderer like the local selection.

## Plain text at every size
Since 0.9.1 every `.txt` (and any text file the app opens as text) uses this engine, not a document: `open()` in `main.ts` sends a `txt`
source to `openLarge` (`usesTextEngine` in `formats/textFiles.ts`; tables of 8 MB or more join it). What follows from that:
- A `.wdoc` saved by an older version as plain text is migrated when the layout worker reports format `txt` (`migrateText`): its text is
  exported and the editor takes it. Switching a Word document to Plain Text goes the same way, so it is final.
- Print and Convert To call `openAsDocument()` first: the file's text is opened as a document (up to 5 MB, `textEditor.fileTooBig`), in
  place of the file in the library, and the existing document code runs. Open Selection as Document uses the same `asDocument` option.
- Stored text files are indexed by line (`textSegments` and `isPlainText` in `docx/src/edit/segments.ts`), in the page's index job and on
  the server (`docIndex.ts`, `search.ts`).
- A text file's thumbnail in Documents is its first lines drawn on a page (`textThumbnail` in `thumbnail.ts`).
- The chrome talks to the text editor through `DocumentEngine` (`client/src/documentEngine.ts`): `main.ts` offers it as `engine()` (null for a
  document), and the menus' copy, cut, paste, undo, redo, select all, insert, find and zoom-to-fit ask it. Opening a text file runs the same
  `beginOpen` as a document, then tells the layout worker to `close`: no empty document is kept under the editor. The worker keeps the spelling
  settings and the person's added words with no document open (`applySettings`).
