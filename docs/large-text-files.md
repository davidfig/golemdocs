# Plan: 50 MB text and log files

**Status.** Done: the guard and threshold (files of 8 MB or more open in the viewer; text, CSV and TSV), line index,
virtual list, go to line, search, filter, line selection and copy, level colouring, text size, download of
the original bytes, format profile and chrome. Measured in a browser on a 51 MB, 500,000-line log: first lines
on screen in about 100 ms, search 240 ms, page heap well under the 200 MB budget. Wrapped lines are done too (on by default, Alt+Z or the button in the status bar
toggles it; a monospace column, so a line's rows are estimated from its length and corrected as lines are shown).
**Not done:** editing and saving (the piece table), and "open this range as a document".

Goal: open, scroll, search and copy from a 50 MB log (about 500,000 lines) without freezing or
running out of memory, and later edit and save it.

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
6. **Chrome.** A `largeText` format profile, like the picture profile: the menus and toolbars show
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
4. **Fonts.** The viewer uses the system monospace font (fast, no atlas). The document pages use
   the shipped fonts. Acceptable?
