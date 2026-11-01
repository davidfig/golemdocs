# Plan: spreadsheets (.xlsx)

**Status.** On the `xlsx` branch (a long-lived branch in a worktree, kept in step with `main`). M0 and M1 are done; M2 (the
editor) has its first build in the app; M3 (the formula engine) and M4 (every function) are done and pass the oracle; M5
(data and formatting) is under way. See
*Progress* at the end for what exists, what was measured and what was learnt.

**Goal.** A spreadsheet editor, not a viewer: open, edit and save `.xlsx` with all of Excel's formulas and functionality, at
Excel's full size (1,048,576 rows by 16,384 columns), drawn by the app's WebGL renderer on the same camera as documents, and
zoomed out to 1% or less so a large part of a sheet is visible at once. No external libraries: the zip, inflate, XML and
number code already in the workspace is ours, and everything else (the formula engine, the statistics and financial
maths, number formats, charts) is written here.

The file always wins. The `.xlsx` is what the account and the vault hold; next to it the app keeps a **memory image**, a
cache of the workbook as it is held in memory, which opens in a fraction of the time. It is used only when it was made from
exactly this `.xlsx` by this version of the format; otherwise the `.xlsx` is read and a new image is made.

## Principles

1. **Columns, not rows.** Spreadsheets are reasoned about by column: a column is one field of one type with one format,
   formulas are filled down a column, ranges are column ranges (`SUM(B:B)`, `XLOOKUP(x, A:A, C:C)`, a table's `[Amount]`),
   filters and sorts key on a column. The model, the formula engine, the dependency graph and the memory image are all
   column-major. Only reading and writing the `.xlsx` (whose XML is row by row) and drawing tiles cross the grain.
2. **Its own engine beside documents.** A sheet is one plane scrolled two ways with fixed headers, not pages. Like the large
   text editor ([text-files.md](text-files.md)), it is its own lazily loaded chunk (`client/src/sheet/`, held by a small
   `sheet/handle.ts`), a `DocumentEngine` to the chrome, and drawn on the global `camera` with `TextRenderer`, `TextBatch`,
   `RectBatch` and `AtlasLibrary`. Every `.xlsx` opens this way, whatever its size.
3. **The workbook lives in a worker.** A sheet worker holds the model, runs the formula engine and builds GPU-ready tiles,
   as the layout worker does for documents. The page never holds cells.
4. **Lose nothing.** Whatever we don't model yet is kept and written back as it came, so open-edit-save in Golem Docs never
   damages a file Excel made.
5. **No dependency.** As AGENTS.md: ask before adding one. None is planned; the zip code is already in `docx/src/zip/`.

## 1. The model: column-major

Per sheet, a sparse map from column index to **Column**. A column is a balanced tree (a rope) of **chunks** of up to 4,096
rows, each chunk knowing its row count, so inserting or deleting rows splits and joins chunks instead of moving data, and
"row r of column C" is O(log n). A chunk stores its cells in the form that fits its contents:

- **Dense**: parallel typed arrays over its rows: kind (`Uint8Array`: blank, number, string, boolean, error, formula
  result), value (`Float64Array`, or a string id into the workbook's string pool), style.
- **Sparse**: the same, plus a `Uint16Array` of row offsets, for chunks that are mostly empty.
- **Runs**: styles (and often values: blanks, a repeated default) are run-length encoded, since a column's style is usually
  one style for thousands of rows.

A column of numbers is then one `Float64Array` per chunk: `SUM(B:B)` is a loop over contiguous memory, and the GPU tile
builder, the sort and the filter read the same arrays.

- **Strings**: one workbook pool (the shared strings as read, then new strings appended), held as UTF-8 bytes plus offsets,
  decoded only when shown or compared; a hash index is built only once something needs to look strings up.
- **Formulas** are stored per column as **runs**: a formula filled down 500,000 rows is one entry (its R1C1 form, compiled
  once) and a row span, which is also how `.xlsx` stores them (`<f t="shared">`). A cell's last computed value sits in the
  dense arrays like any value.
- **Row heights and column widths**: Fenwick trees of prefix sums with defaults, overrides and hidden flags, so "row at y"
  and "x of column c" are O(log n).
- **Everything else on a sheet** (merged cells, conditional formats, validation, tables, filters, outline groups, comments,
  hyperlinks, drawings and charts, protection, print setup, sheet views and panes) in their own small structures, keyed by
  ranges with an interval index per column where they are looked up per cell.
- **Edits** go to the chunk they touch (copy-on-write, so the memory image's arrays stay shareable and undo can keep the
  old chunk). Undo is a list of chunk and structure swaps.

## 1a. Formatting

Formatting is stored the way Excel stores it, as **shared style records that cells point to**, never as properties on a cell.
A million-row column formatted one way costs one style and one run, and a formatting command works on the few distinct
styles in a range, not on its cells.

**Four layers, resolved at draw time** (lowest first):

1. **The cell's own style** (direct formatting): a style id.
2. **Table styles**: a table names a style (`TableStyleMedium2`) and its options (header row, banded rows and columns,
   first and last column, total row). Nothing is written into the cells; the tile builder asks which part of a table a
   cell is in and lays that element's differential format under the cell's own. This is why a table's banding follows
   sorting and inserted rows.
3. **Conditional formats**: rules over ranges (cell value, formula, top/bottom, above average, duplicates, colour scales,
   data bars, icon sets), kept in an interval index per column and evaluated by the tile builder through the formula
   engine. A rule that matches lays its differential format on top; colour scales and data bars need the range's minimum,
   maximum or percentiles, computed once per rule and kept until a value in the range changes.
4. **Empty cells** take the row's style if the row has one (`<row s customFormat>`), else the column's (`<col style>`), else
   the default. A whole column or row formatted in Excel is one entry, not a million cells.

**The style table** (one per workbook, in the worker):

- Excel's own parts, each interned in its own table: **fonts** (family, size, bold, italic, underline kind, strike,
  colour, script, scheme font), **fills** (pattern and two colours, or a gradient), **borders** (each side's style and
  colour, diagonals), **number formats** (the format code, compiled once into a formatter), **alignment** (horizontal,
  vertical, wrap, shrink, indent, rotation, reading order) and **protection**. A **style** is a tuple of part ids plus its
  named cell style (Normal, Heading 1, Good...), the same as `cellXfs` in `styles.xml`, and a hash map finds the id of any
  tuple, so the same look is always the same id.
- **Differential formats** (`dxfs`: only the properties a rule or table element sets) in a table of their own.
- **Colours are kept as Excel writes them**: an RGB, a theme slot with a tint, or an indexed colour, and resolved only when
  drawn, so changing the workbook's theme repaints everything without touching a cell.
- Ids read from the file are kept as they were (cell `s="17"` is our style 17), so an unchanged cell is written back with the
  same index and `styles.xml` round-trips; new styles are appended. Parts of `styles.xml` we don't model (`extLst`, MRU
  colours) are kept.

**Per cell**, the style id lives in the column chunks like any value, **run-length encoded** (`start, length, style`):
columns are nearly always a few long runs. A chunk switches to a dense `Uint32Array` only when its runs would take more
room (a checkerboard).

**Commands map styles, not cells.** "Bold" on `A1:Z1000000`: for each column, for each run, `newStyle = withBold(oldStyle)`,
memoised as `(oldStyle, command) → newStyle`. A range with three distinct styles costs three lookups and a rewrite of the
runs. Undo keeps the old runs (copy-on-write chunks). Formatting a whole column or row sets the column's or row's style and
maps the cells already in it, as Excel does.

**Text inside a cell** with mixed formatting (one word bold) is a rich string: the string pool entry carries runs (offset,
font part id), as in `sharedStrings.xml`. Plain strings carry nothing.

**Drawing.** The tile builder resolves the four layers into a **draw style**: face, size, colours as RGBA, fill, the four
border edges, alignment and a compiled number formatter. It is memoised by
`(style, table element, conditional result)`, so a tile of a thousand cells usually resolves a handful. Where two cells
share an edge with different borders, Excel's precedence (the heavier, then the later one) is applied once per edge in the
tile. The overview pyramid takes its texel colours from the same draw styles.

**In the memory image** the part tables, the style tuples, the dxfs, the rich-text runs and the run arrays are sections
like the rest, so formatting maps with no parsing either.

## 2. The memory image (a cache format any Golem type can use)

A versioned binary container, written by the app, never by hand:

```
header   magic "GOLEMIMG", container version, kind ("sheet"), kind schema version,
         source fingerprint (SHA-256 and byte length of the .xlsx it was made from)
table    sections: name, offset, length, element type, alignment
sections column chunks' typed arrays, the string pool, formula runs and their compiled bytecode,
         the dependency graph, Fenwick trees, styles, sheet structures (JSON for the small ones),
         and the parts of the .xlsx kept as they came
```

- **Opening is mapping, not parsing.** Sections are 8-byte aligned, so each becomes a typed-array view on the one
  `ArrayBuffer`, with no copy. The first sheet's visible columns are read first (`Blob.slice` on the stored record), so the
  first screen is up before the rest of the image has been read.
- **When it is used.** On open: fingerprint the `.xlsx` (SHA-256 with `crypto.subtle`: tens of ms for 10 MB, a few hundred
  for 100 MB; to be measured) and look up the image by document. It opens only if the container version, the kind's schema
  version and the fingerprint all match. Anything else (an older app, a newer app, an agent edited the file in the vault, a
  change arrived from another device) means the `.xlsx` is read and a new image is written in the background. An image is
  never upgraded in place: a new schema version throws the old ones away.
- **When it is written.** After the `.xlsx` is saved, from the same state, with the new file's fingerprint, so an image
  never describes a file that wasn't written. A failed or missing image costs only speed.
- **Where.** A new IndexedDB store (`images`, keyed by document id, in `storage/local.ts`), per device. It is not uploaded
  and not written into the vault folder: the vault stays plain files for people and agents, and a folder shared by iCloud or
  Dropbox would otherwise carry one device's cache to another. (The server could make images for a new device later.)
- **Generic.** The container (`client/src/image/`, or a workspace package if the server needs it) knows nothing about
  sheets: a kind registers its schema version and its write and map functions. Large PDFs, large documents (their laid-out
  pages) and text files' line index are candidates later.

## 3. Reading and writing .xlsx

- **Streaming inflate.** `ZipEntry.read()` (`docx/src/zip/zip.ts`) inflates a whole part. Add `ZipEntry.stream()` (chunks
  from `DecompressionStream('deflate-raw')`, same size guard) and Zip64 (Excel writes it for big parts; the reader refuses it
  today). A 50 MB `.xlsx` is often 0.5 to 1 GB of XML: it is never a string.
- **A byte scanner for `sheetData`** (and `sharedStrings.xml`), not an XML parser: a resumable state machine over UTF-8 that
  knows `<row>`, `<c r s t>`, `<v>`, `<f>` (shared, array, data-table), `<is>`, rich-text runs and entities. It fills a
  4,096-row band and then **transposes** the band into column chunks, so the model is column-major from the first row.
  Everything outside `sheetData` and the small parts (workbook, styles, theme, tables, comments, charts) go through `parseXml`.
- **Progressive.** The worker posts each band as it lands, so the first screen draws while the sheet is still being read;
  formulas whose inputs are not in yet show the value Excel saved (`<v>`) until calculation catches up.
- **Writing** streams row by row, reading across the columns with one chunk cursor each. Parts we haven't changed are copied
  as their compressed bytes (the zip writer already can); parts we model are written from the model; parts we don't model
  yet are kept verbatim, with their relationships, and references inside them are moved when rows or columns are inserted or
  deleted (the formula engine's reference-shifting code does this for every kind of reference, see 4).

## 4. The formula engine

"Full support" is the core of this project. The pieces:

- **Grammar**: Excel's full formula language: A1 and R1C1, absolute and relative, whole rows and columns, 3D references
  (`Sheet1:Sheet3!A1`), defined and table names, structured references (`Table1[[#This Row],[Amount]]`), external
  references (keep the cached values), array constants, the spill (`A1#`) and implicit-intersection (`@`) operators, the
  range, union and intersection operators, and localised function names on reading the legacy forms.
- **Compiled to bytecode** per formula run (so a filled-down column is compiled once); relative references are resolved
  per row at evaluation. Values: number, string, boolean, error, blank, reference, array, lambda.
- **Column-aware evaluation**: a range argument is a view over column chunks, not a copy; aggregates, lookups and the
  `*IFS` family run over typed arrays; a lookup on a sorted column uses binary search, and on a column that is looked up
  repeatedly builds a hash index kept with the column until it changes.
- **Dependencies by column interval**: each column keeps an interval tree of the formula runs that read it ("rows
  10..500,000 of column B are read by the run in D2:D500001"), so a change marks dirty exactly what depends on it, and a
  filled-down column is one node, not 500,000. Dynamic dependencies (`INDIRECT`, `OFFSET`, `INDEX` returning references)
  are found as they evaluate. Topological recalculation of only what is dirty, cycle detection, and iterative calculation
  when the workbook asks for it.
- **Recalculation in the worker**, in slices so the page stays live, showing progress; independent groups can later run in
  more workers.
- **Excel's semantics, exactly**: 15-significant-digit results and comparisons, the 1900 leap-year bug and the 1904 system,
  coercion rules (text to number, blanks in each context), error propagation, volatile functions (`NOW`, `RAND`,
  `OFFSET`...), dynamic arrays and spilling (`#SPILL!`), `LET`, `LAMBDA` and its helpers (`MAP`, `REDUCE`, `SCAN`,
  `BYROW`...), legacy array formulas (CSE), data tables (`TABLE()`).
- **The function library: all of it**, by Excel's categories: math and trigonometry, statistical (with the distributions
  and their inverses: gamma, beta, t, F, chi-squared, binomial..., which need careful numerical code: incomplete gamma and
  beta, inverse by Newton and bisection), financial (including `XIRR`, `PRICE`, `YIELD` and the bond family), date and time,
  text (including the DBCS ones), lookup and reference, logical, information, engineering (complex numbers, Bessel,
  conversions), database, compatibility, and the newer dynamic-array ones (`FILTER`, `SORT`, `SORTBY`, `UNIQUE`, `SEQUENCE`,
  `TAKE`, `DROP`, `VSTACK`, `HSTACK`, `WRAPROWS`, `TEXTSPLIT`, `GROUPBY`, `PIVOTBY`...). A machine-readable catalogue
  (`sheet/functions/catalogue.ts`: name, category, arity, argument kinds, volatile, which version of Excel added it, status)
  drives the parser, autocomplete, the help, and a status doc of what is done.
- **Functions that reach outside the workbook** (`WEBSERVICE`, `RTD`, the `CUBE*` family, `STOCKHISTORY`, `IMAGE`, data
  types): see decision 3.
- **The oracle.** A corpus of `.xlsx` files whose cached values were computed by Excel: our engine recalculates every
  formula and must give Excel's result. Each function gets its own fixture sheet of edge cases (made once in Excel, committed),
  plus real-world workbooks for scale (built by `scripts/sheets/oracle.ts`, which has Excel itself calculate them; see *Tests*
  and *M0 findings*). LibreOffice can generate more by hand during development, but Excel is the reference
  where they differ.

## 5. Drawing: a hashed tile pyramid

The plane is cut into tiles kept in a map keyed by `(level, tx, ty)`, a spatial hash, built by the sheet worker and only
uploaded and drawn on the page (the `EncodedPage` contract: glyph and rect instances, transferred, not copied). Each tile
has its own float64 origin, so float32 stays exact a million rows down.

- **Level 0: cells** (64 rows by 16 columns). Formatted values laid out with the layout package's `FontSet` (Calibri,
  Aptos, Arial... through the same substitutes and font pages as documents, CJK included), fills, borders, gridlines,
  overflow of text into empty neighbours (decided in the worker, which knows them), wrap, rotation, conditional formats
  (colour scales, data bars, icon sets), merged cells, in-cell pictures, sparklines.
- **Levels 1 and up: the overview.** Below about 3 pixels a row text can't be read and drawing it costs glyphs for
  nothing, so beneath that zoom the sheet is drawn from a **pyramid of textures**: at level 1 one texel is one cell, each
  texture covers 256 by 256 cells, and every level up halves the resolution (2 by 2 cells a texel, then 4 by 4...). A
  texel is the cell as it would look from far away: its fill colour, blended with its text colour weighted by how much of the
  cell its text covers (the text's measured width), so columns of numbers read as grey bands, headers as darker rows, fills
  and conditional colours as colour. At 1% a million rows is a few thousand screen pixels high, so a handful of
  textures draw the whole sheet. Levels are built column by column from the chunks, lazily and by need, and a level-k
  texture is built from the four level-(k-1) textures under it when those exist.
- **Between levels** the two are cross-faded over a short zoom range, so zooming in from 1% to 100% never jumps. The text
  editor rejected a level of detail because a bar per line looked wrong at reading zooms; here the overview takes over only
  where text is already unreadable, and it is a picture of the cells, not a symbol for them. To be judged on real sheets
  in step M0.
- **Zoom range**: the sheet sets `camera.minZoom` lower (0.1%, to be tuned so the whole of a full sheet fits), and the
  pyramid has as many levels as that needs (about 12 for 16,384 columns by 1M rows).
- **Visible tiles** come from the Fenwick trees (row and column ranges on screen), then the keys in that rectangle at the
  chosen level. Missing tiles are requested and drawn as soon as they arrive, with the next level up drawn in their place
  meanwhile. LRU caches per level, an upload budget per frame (as `glRenderer.ts`). A cell edit invalidates its level-0 tile
  and the one texel above it on each level; a row height or column width change moves origins only.
- **Fixed parts**: row and column headers and frozen panes are drawn in extra passes with a camera pinned on one axis and
  the scissor; selection, the active cell, the fill handle, formula reference colours, search marks and other people's
  cells are rebuilt per frame for what is in view.
- **Charts** are drawn by the vector painter the drawing editor already has (`vector/paint.ts`), from a chart model read
  from DrawingML chart XML, into textures like a document's SVG pictures, sharp at the size shown.

## 6. The editor

Built together with the viewer: the first build that opens a sheet also edits and saves it.

- **Cells**: type over a cell or edit in place (an in-document editor over the cell, as `LinkPopover`), the formula bar,
  formula autocomplete and argument hints from the catalogue, reference colouring and pointing at cells while typing a
  formula, F4 to cycle `$`.
- **Selection and keys like Excel**: ranges, multiple ranges, whole rows and columns, Ctrl+arrows to the data's edge, Shift,
  Ctrl+Space and Shift+Space, Go To and Go To Special, Name Box.
- **Structure**: insert and delete rows, columns and cells (with shift), hide, group and outline, resize, autofit, freeze
  panes, split, sheets (add, rename, move, copy, hide, colour).
- **Data**: fill handle and series, Flash Fill (inferring a pattern from examples, as Excel does), sort, autofilter and advanced filter, tables, data validation,
  remove duplicates, text to columns, find and replace (values or formulas, by sheet or workbook).
- **Formatting**: fonts, fills, borders, alignment, number formats (with Excel's full format-code language: sections,
  conditions, colours, dates, elapsed time, fractions, locale), cell styles, conditional formatting with its rule editor,
  format painter, merge.
- **Analysis**: pivot tables (model, calculation and refresh from the workbook's own data), charts (insert and edit), goal
  seek, scenarios, data tables, Solver (see decision 4).
- **Review**: notes and threaded comments, protection of sheets and workbook (as Excel's: not security).
- **Clipboard**: TSV and an HTML table out (pasting in a document makes a table); TSV, HTML tables and our own rich format in;
  paste special (values, formats, formulas, transpose, operations).
- **Undo and redo** for all of it; autosave like documents; Print and PDF export of a sheet or a print area.
- **Chrome**: a `sheet` format profile; ribbon-like toolbars made from the shared UI parts (AGENTS.md: `dropdown`,
  `segmented`, `colorButton`, `showDialog`...), sheet tabs, status bar showing sum, average and count of the selection.
- **Macros** (`.xlsm`): the VBA project is kept and written back, never run (decision 3).

## 7. Storage, rooms and the rest of the app

- **Storage**: the raw `.xlsx` is the stored document (not a `.wdoc`), in the browser, the account and the vault; chunked
  storage covers files of 2 MiB or more; the server's 50 MiB limit applies, with a message, as for text files. The memory
  image sits beside it on each device (section 2).
- **Rooms**: a new room kind, `cells`, `watch` in `ROOM_POLICY` at first (one holder edits). Then shared: cell changes merge
  per cell; inserted and deleted rows and columns transform each other and the references in formulas; structure changes
  (sheets, tables, pivots) are objects with last-writer-wins. Alone in a room behaves exactly like no room.
- **Elsewhere**: thumbnails from the level-0 renderer; server search indexing of cell text; Convert To and Paste into a
  document as a table; `.xlsm`, `.xltx`, `.xltm` read and written; CSV and TSV in the grid (decision 2); `.ods` and `.xls`
  (BIFF8) later, on the same model.

## Milestones (on the `xlsx` branch)

- **M0. Foundations and measurements.** A generator for test workbooks (100k and 1M rows, 10 to 200 columns, numbers,
  strings, dates, styles, filled-down formulas); the Excel-made oracle corpus started; streaming inflate and the scanner
  timed in Node; a throwaway prototype of the overview pyramid at 1% on a real sheet, to settle how the far zoom looks.
- **M1. Core.** Zip streaming and Zip64, scanner and transposition, the column model, styles and number formats, the
  memory-image container and the sheet kind, round-trip writing (open then save leaves every part we don't change
  byte-identical). Pure and tested in Node.
- **M2. The editor, first build.** Tile pyramid and renderer, the view and chrome, selection, typing values, undo,
  insert and delete rows and columns, resize, freeze, sheets, clipboard, find and replace, autosave and upload, memory
  image used on open. Formulas show their saved values and are kept on save.
- **M3. Formula engine core.** Grammar, bytecode, dependency graph, recalculation, dynamic arrays, names and tables,
  reference shifting, and the first categories of functions (math, logical, lookup, text, date, information) passing the
  oracle.
- **M4. Every function.** The remaining categories, statistical and financial last as they are the most numerical work,
  driven by the catalogue until it reads complete.
- **M5. Data and formatting.** Sort, filter, tables, validation, conditional formatting, the full formatting UI, fill
  series, paste special, comments, protection, outline.
- **M6. Analysis and pictures.** Charts (read, draw, insert, edit), sparklines, pivot tables, what-if tools, print and PDF.
- **M7. Together and around.** `cells` rooms, search indexing, thumbnails, CSV in the grid, Convert To.

The branch merges to `main` when decision 1 says, with a What's New entry then.

## Budgets (to be confirmed in M0)

| What | 1M rows by 10 columns (~50 MB .xlsx) |
|---|---|
| First screen from the `.xlsx` | < 1 s; whole file read < 10 s, with progress, editable meanwhile |
| Open from the memory image | < 300 ms to first screen, < 2 s to everything |
| Scroll and zoom, 0.1% to 6400% | 60 fps; any cell reached in one frame plus one tile build |
| Edit a cell that feeds a 1M-row filled-down column | < 100 ms to see the result on screen |
| Memory (page + workers) | < 600 MB |
| Save (`.xlsx` and image) | < 5 s, off the main thread |

## Tests

- Node unit tests for the scanner (tags split across chunks, missing `r`, shared and array formulas, Zip64, a zip bomb
  refused), the column ropes (random insert and delete against a plain array model), Fenwick trees, number formats against a
  table of Excel's outputs, the memory image (write, map, version and fingerprint mismatch fall back to the `.xlsx`),
  reference shifting, and round-trip byte-identity.
- **Three-way checks against Excel**, which runs on the development Mac through `scripts/sheets/excel.ts` (not in CI, and
  not in `pnpm test`, which only reads the committed files):
  1. **Excel calculates, we must agree.** The oracle (above): Excel's saved values are the expected results; the engine
     recalculates every fixture and must give the same, reported per function in a generated status table.
  2. **We round-trip losslessly.** Every Excel-made fixture (the oracle's, and real workbooks built in Excel with charts,
     tables, conditional formats, pivots) is opened, saved and reopened by us: the model is the same, and every part we did not
     change is byte-identical. Runs in `pnpm test`.
  3. **Excel accepts what we write.** Our saved files go back through Excel (`excel.ts <file>`): it must open them without
     a repair (with alerts off, a file it would repair fails the run), recalculate them to the same values, and save them;
     reading Excel's save back must give our model again.
- Overview pyramid: a level-k texel equals the blend of its four children.
- e2e under `e2e/sheets/`: open, zoom to 1% and back, edit, formulas recalculating, insert rows, copy and paste with a
  document, save and reopen (from the image and from the file), download. Read through a `window.sheetEditor` hook, as
  `window.textEditor` does.

## Decisions

The recommendations below were taken as decided when work went ahead unassisted (2026-10-31); any can be changed.

1. **When does the branch merge?** Recommended: after M3, behind nothing. At that point `.xlsx` opens, edits, saves and
   recalculates the common functions, which beats today (it doesn't open at all), and the rest continues on `main`. The
   alternative is to keep it on the branch until M6, which means a long time of keeping it in step with `main`.
2. **CSV and TSV.** Today they open as a Word table (and in the text editor from 8 MB). Recommended: once M2 lands, CSV
   and TSV open in the grid at every size (saved back as CSV, formulas not kept, with a note), like `.txt` moved to the text
   engine.
3. **What "full functionality" leaves out.** Recommended: VBA macros are kept but never run (running them is running
   untrusted code); functions that need the network or an outside service (`WEBSERVICE`, `RTD`, `CUBE*`, `STOCKHISTORY`,
   linked data types, external workbook links) keep their saved values and are not refreshed; Power Query and data
   connections are kept, not run. Everything that is computed from the workbook itself is in.
4. **Solver.** It is a real optimiser (simplex, GRG nonlinear, evolutionary). Recommended: in, in M6, simplex and GRG first.
5. **Where the image container lives.** Recommended: `client/src/image/` until a second user (or the server) needs it,
   then a workspace package.

## Progress

### M6: analysis and pictures (under way, 2026-11-01)

**Charts, read and drawn** (`sheet/charts/`). `readCharts` (`model.ts`) follows the sheet's `<drawing>` to its drawing part
and each anchor holding a chart (`twoCellAnchor`, `oneCellAnchor`, `absoluteAnchor`) to its chart part, and reads the
chartSpace into a `Chart`: groups by kind (bar and column, line, area, pie, doughnut, scatter; their 3-D forms as flat),
direction, grouping (clustered, stacked, percentage), gap and hole sizes, the first slice's angle; each series' name,
categories (or x values) and values as references with the file's cached points, its colour and its points' colours,
line and markers; the title (or, for a one-series pie, the series' name, as Excel shows it), the legend's place, and the
axes (fixed bounds, own number format, gridlines, deleted). The parts are written back unchanged; the model goes in the
memory image.

`chartScene` (`scene.ts`, in the worker) reads each series from its cells now through the engine (`formulaReference`, the
cached points when a reference can't be read), and `layoutChart` lays the chart out in its box (`chartBox`: its anchor
through the sheet's row and column sizes) as triangles (a colour per vertex) and text runs, in points: the chart area,
title, legend (series, or a pie's categories), value axis on a round scale (`niceScale`, starting at zero unless the
values are far from it), category labels thinned out where they would overlap, gridlines, then bars (clustered or
stacked, up or across), lines with round joins and markers (gaps break them), stacked areas, scatter points, pie and
doughnut sectors. Colours not given are the theme's accents in turn (`defaultColor`). Text is placed by an anchor and an
alignment, since only the page has the fonts: the layout leaves room by an estimate.

The page asks for a sheet's scenes (`charts` request) whenever its workbook info changes (an edit, a load) or another
sheet shows (`SheetEditorView.loadCharts`), and the renderer draws them in each pane over the cells, under the selection
(`drawCharts`): a `TriangleBatch` per chart (`webgl/shapes/triangleBatch.ts`, new: triangles in points, placed by
uniforms like rectangles) and its text through the cell fonts, kept until the scene or the fonts change. Checked by
`charts.xlsx` (written by `scripts/sheets/fixtures.ts`, a chart of each kind) and Excel's own save of it
(`charts-excel.xlsx`), which read the same.

Charts follow edits: `moveCharts` (with the other moves in `moveReferences`) rewrites every chart's references to the moved
sheet and shifts the anchors of the charts on it (a corner in deleted rows or columns lands at their start); a renamed or
deleted sheet rewrites them through `rewriteAll` (`rewriteChart`). Undo restores them with the formulas (the book-wide
snapshot keeps every sheet's charts). When a sheet's layout is written, `writeCharts` writes each chart's anchor into its
drawing part and each series' references into its chart part by position (everything else in the parts as it was); Excel
opens charts moved this way, ours and its own (`charts-moved`, `charts-excel-moved` in `check.ts`), and keeps them.

**Next in M6**: inserting a chart
(Insert › Chart over a selection) and editing one (kind, title, legend, series); sparklines; pivot tables; what-if tools
(Goal Seek, data tables, scenarios, Solver); print and PDF.

### M5: data and formatting (done, 2026-11-01)

**Done.** Formatting: the app's own commands (Bold, Italic, Underline, Strikethrough, fonts and sizes, Grow and Shrink, text
and fill colours, alignment, Clear Formatting) work on cells when a workbook is open: `formatAllows` lets them, the chrome
hands them to the open editor first (`DocumentEngine.format`), and the toolbar shows the active cell's look
(`SheetEditorView.formatState`, from `CellContent.look`). The Sheet menu adds number formats, decimal places, borders, wrap
and vertical alignment, and Merge and Center. A change is one `format` edit (`format/styleChange.ts`: `restyle` makes the
style a cell's style becomes, interned, so most cells share a few); whole columns and rows change the column's or row's own
style and the cells in it that hold something, never a million empty cells. Sort (`sort` edit, `currentRegion`, Excel's
order and header guess; formulas move with their rows, their relative references as if copied). Replace and Replace All in
the find bar (`replace` edit: the contents as typed, entered again as if typed). Double-clicking a column header's edge
fits the column (the worker sends each style's longest texts, the page measures them with the cells' fonts).

**Conditional formatting** (`sheet/conditional.ts`): read from the XML around the cells (and from an image's copy of it),
evaluated in the worker as tiles are built (`ConditionalPainter`: `cellIs`, formula rules and every rule type Excel writes a
formula for, top/bottom, above/below average, duplicate and unique, blanks and errors, colour scales, data bars); a cell's
differential formats laid over its style make a style of its own (`TileCache.overlay`, indexes from `OVERLAY_STYLES`).
Their ranges and formulas move with inserted and deleted rows and columns, and they are written from the model. Icon sets
(`CfRule.icons`): a value gets the icon past the highest threshold it reaches (`gte="0"`: past it, not at it; `reverse`
flips the order; `iconFor`, with Excel's sets in `ICON_SETS`), carried in `CellPaint.icon` and drawn at the cell's left by
`drawIcon` in rows of spans, as the renderer draws its other small shapes (arrows, circles, flags, triangles; ratings,
quarters and boxes filled to their level).

**AutoFill** (`fill.ts`, the `fill` edit): the handle at a single selection's corner (`FILL_HANDLE`, drawn by the renderer)
is dragged down, up, right or left; along each line numbers carry on their least-squares trend (one number is copied, one
date goes on by days), month and day names and text ending in a number count on, and formulas are copied with their
references moved; a formula filled from one cell joins one run (`joinRuns`).

**AutoFilter** (`filter.ts`, `filterCard.ts`): Sheet › Filter puts one over the block around the active cell (the `autoFilter`
edit, with Excel's hidden `_xlnm._FilterDatabase` name); the renderer draws a button at the right of each header cell
(`filterButton`, blue where the column filters), and pressing it opens a card over the sheet (the shared `.wm-over` card,
as the link form uses) to sort the range by the column or tick the values to show (the `filter` edit hides the other rows).
Read from and written to `<autoFilter>`; columns filtered other ways (custom, top 10) are kept as they were.

**Checked in Excel** (`scripts/sheets/check.ts`, the typed workbook): formatting, a whole column's style, a sort, a fill,
an AutoFilter with a column filtered, and conditional formats made here (rules and differential formats written from the
model: `ruleElement`, `StyleTable.internDxf`) open in Excel, which keeps every one of them when it saves.

**Tables** (`tables.ts`): read from each sheet's table parts (`readTables` in `read.ts`; kept in the memory image), and
written back with their ranges as they are now (`tableXml`), which follow inserted and deleted rows and columns
(`moveTables`). Structured references (`Sales[Amount]`, `Sales[[#Headers],[A]:[C]]`, `[#All]`, `[@Price]`) are resolved by
the engine (`Host.structured`, `resolveStructured`); a formula typed in a table with `[@Price]` is stored as Excel stores
it, `T[[#This Row],[Price]]` (`expandStructured`). The built-in styles (Light, Medium, Dark) are drawn in their shape: the
header in the style's theme colour, banded rows tinted from it, the totals row bold (`tablePaint`, `TileCache.tableStyle`;
a cell's own fill and colour win). Checked by the oracle's `tables` group (a table on the Data sheet) and in Excel, which
keeps a table grown by an inserted row. Sheet › Insert Table makes one (`createTable`, `newTable`: the first row its
header, empty header cells named Column1...); the writer gives a new table its part and relationship, removes those of
tables gone, and writes `<tableParts>` from the model; Excel opens it.

A table's own AutoFilter is its `filterColumns` (read from the table's `<autoFilter>`, written back by `tableXml`;
`tableFilter` gives it as an `AutoFilter` over the header and data rows). The page gets each in `SheetInfo.tableFilters`;
the renderer draws every filter's buttons the same way, and the card, the `filterValues` request and the `filter` edit
name the table (`table`), so a table and the sheet's AutoFilter work alike. A formula typed into one cell of a table
column whose other data cells are empty fills the column (`calculatedColumn` in the `input` edit, rebased to the first
data row), as Excel's calculated columns do; Excel refuses a shared formula with a structured reference, so the writer
writes such a run cell by cell (`hasBrackets`). The column's formula is kept in its `<calculatedColumnFormula>` (`withCalculated`, on a copy of the table's XML so undo has the old one), and rows inserted into the table's data get it (`fillCalculated`).

**Data validation** (`validation.ts`): rules read from and written to `<dataValidations>` (a rule made here gets its own
element; its ranges and formulas follow inserted and deleted rows and columns). A list rule puts an arrow just right of
the active cell (`choicesButton`, drawn as the filter's buttons are, `dropButton`); it, or Alt+Down, opens the shared
popup menu of its choices (written out, or a range's values). After typing, the worker checks the cells against their
rules (`allows`: whole, decimal, date, time, text length, list, custom) and takes the edit back for good
(`History.refuse`) when one refuses it, showing the rule's own message. Learnt in Excel: a rule refuses a value only when
it has `showErrorMessage="1"`. The tests' fixture `validation.xlsx` is written by our writer (`scripts/sheets/fixtures.ts`)
and opened in Excel by `check.ts`.

**Notes** (`notes.ts`, `noteCard.ts`): Excel's notes (comments) are read from the sheet's comments part; tiles mark their
cells (`CellPaint.note`, a red corner), and resting the pointer on one shows it in a card in the documents' comment look
(`.wm-comment`). They follow inserted and deleted rows and columns (a note goes with its deleted cell), and a sheet
written rewrites the comments part and the VML drawing Excel shows them with (each shape's row, column and anchor;
`writeNotes`); Excel opens notes moved and deleted this way and keeps them. Sheet › New Note opens `NoteEditor` beside the
active cell (the comments panel's text box and buttons in the same card; Enter or a press elsewhere keeps the text, Escape
drops it; `CommandRegistry.execute` leaves it the focus) and Delete Note takes the note away, both the `note` edit
(`newNote`, `withText`). A new note is signed with the comment author's name and added to `<authors>`, and gets a hidden
shape in the drawing (`noteShape`, numbered from the drawing's `idmap` block). A sheet's first note brings its parts
(`newNoteParts`: a comments part, a VML drawing, their relationships, and `<legacyDrawing>` through the one-shot
`Worksheet.legacyDrawing`); deleting its last takes them away again (`removeNoteParts`, keeping a drawing that also holds
other shapes). Excel opens both kinds (`notes-made`, `notes-new` in `check.ts`) and keeps the notes. Not yet: threaded
comments.

**Paste** (`pasteCells.ts`): a range copied here and pasted while the clipboard still holds its text is pasted as cells
(the `pasteCells` edit: values, formulas moved as copied, looks), even onto another sheet; Sheet › Paste Special pastes
only values, formulas or formats, or transposed. Text from elsewhere is pasted as typed (the `paste` edit).

**Protection** (`protection.ts`): `<sheetProtection>`'s attributes are the model's `Worksheet.protection` (read and written
as they are; kept in the image). On a protected sheet `applyEdit` refuses (`refuses`, message `sheetProtected`) what
touches a locked cell (every style is locked unless its `<protection locked="0">` says not; empty cells take their row's
or column's style; `lockedRange` checks the rows past the data through those) and what the attributes don't allow
(formatting cells, rows or columns, inserting and deleting, sort, the AutoFilter, notes as objects; tables, merges and
groups never). Workbook edits (sheets added, renamed, moved) are not the sheet's to refuse. The page refuses typing into a
locked cell at once (`CellContent.locked`, trusted only for the cell it is of) and makes the formula bar read-only there;
a hidden cell's formula shows as its value. Sheet › Protection › Protect Sheet and Unprotect Sheet (`protect` edit,
`protectDialog.ts`) take a password, kept as Excel keeps it: SHA-512 over the salt and the UTF-16LE password, then over
the hash and the round number 100,000 times (`spunHash`, a hand-written `sha512`; Web Crypto's digest is async and too slow
for 100,000 rounds). Older files' 16-bit `password` hash is checked too (`legacyHash`). Checked in Excel: it unprotects a
sheet we protected with our password, and a password Excel set opens here. The password fields are text fields drawn as
dots (`-webkit-text-security`), so the browser doesn't offer to save a sheet's password as a sign-in. Lock Cells and Unlock
Cells are a `format` edit (`StyleChange.locked`).

After a modal dialog over the sheet closes, `afterCard` drops an edit the formula bar started only because the focus came
back to it, and takes the focus away and gives it back: Chrome can return the focus to the sheet's text box without its
caret, and keys then type nothing.

**Outline groups**: each row's and column's level and collapsed flag (`rowOutline`, `colOutline`, read from and written
to `<row outlineLevel collapsed>` and `<col>`, with `sheetFormatPr`'s `outlineLevelRow`/`outlineLevelCol`, which Excel
uses to show its gutter) go to the page in `SheetInfo.outline`. `Geometry` makes room for a gutter left of the row
headers and above the column headers (`gutterLeft`, `gutterTop`, `OUTLINE_STEP` a level), the renderer draws each group's
bar and its +/- box at the summary row or column after it, and the level buttons where the gutters meet; `hit` reports
them as `outline`. Sheet › Group groups or ungroups the selected rows or columns (the `group` edit, seven levels deep), the
box collapses or expands a group (`collapse`: rows hidden, deeper collapsed groups staying shut), and a level button
shows everything down to its level (`outlineLevel`); all three are `outlineEdit` in `edit.ts`.

A workbook opens at A1 at 100%: `openSheet` places the camera, and `placeCamera` (Word's centering, run on a resize or as
the last document's pages arrive) leaves a workbook alone.

**The Sheet toolbar** (`DEFAULT_LAYOUT` in `toolbarLayout.ts`): currency, percent, more and fewer decimals, borders, merge
and center, wrap, vertical alignment, sort and filter, as buttons of the Sheet menu's own commands (their icons in
`icons.ts`, `sheet*`). Sheet commands are available only for a workbook (`formatAllows`), so the toolbar is empty, and
hidden, for every other document, as the Picture toolbar is for anything but a picture.

M5 is done.

### M4: every function (2026-10-31)

**What exists.** `functions/catalogue.ts` lists every function Excel 365 has, by Excel's categories; a test fails while any
is undefined (`sheetEngine.test.ts`), and none is. New modules: `engineering.ts` (bases, bits, complex numbers, Bessel
functions by their integral forms, `CONVERT`), `database.ts` (the `D*` functions), `bonds.ts` (coupon dates and day counts,
`PRICE`, `YIELD`, `DURATION`, accrued interest, discounted securities, T-bills, odd first and last periods, French
depreciation), `regression.ts` (`LINEST`, `LOGEST`, `TREND`, `GROWTH`, the hypothesis tests), `ets.ts` (`FORECAST.ETS` and
its kin) and `misc.ts` (`ARRAYTOTEXT`, `BAHTTEXT`, the `REGEX*` functions, `ENCODEURL`, `FILTERXML`, `CELL`, `INFO`,
`PERCENTOF`, `TRIMRANGE`, `GROUPBY`, `PIVOTBY`). A function's name on its own is the function (`BYROW(x,SUM)`), written
`_xleta.SUM` in the file; LET and LAMBDA parameters are written `_xlpm.x` (Excel refuses a file without them).

**Functions that reach outside the workbook** (the cube functions, `RTD`, `WEBSERVICE`, `STOCKHISTORY`, `IMAGE`,
`TRANSLATE`, `DETECTLANGUAGE`, `COPILOT`) are listed under `external`: a formula calling one keeps the value it was saved
with, and a workbook holding one is saved asking Excel to recalculate on opening.

**Checked.** The oracle has 15 groups and 1,225 cases, every one calculated as Excel calculates it (Excel's iterative
solvers, RATE, IRR, XIRR and YIELD, stop a few digits short of the exact root, and its Bessel functions are approximations
good to about 7 digits, so those are compared more loosely; `CELL("address")` on another sheet names the file, so only its
spelling is checked). Learnt from it: actual/actual `ACCRINT` measures a part of a period against the first interest
period's length and counts whole periods as one; actual/actual `PRICEMAT` counts days over 365; `CONVERT`'s mmHg is
133.322 Pa; Excel computes complex powers in polar form and `IMSEC`, `IMTAN`, `IMCOT` by their double-angle forms (the
last digit shows it). Microsoft's worked examples in the function documentation (`.cache/tools/doc-examples.ts`) agree
too. Excel for Mac has no `ENCODEURL` or `FILTERXML` (Windows only), so those two are checked only by our tests.
`FORECAST.ETS` and its kin fit their smoothing constants by least squares; Excel does not publish its fitting, so their
values agree with Excel's in kind, not to every digit, and are not in the oracle. `CELL`'s `width`, `format` and
`filename` answer defaults.

### M3: the formula engine (2026-10-31)

**What exists.** `sheet/formula/`: `parser.ts` (the grammar, to a tree), `evaluate.ts` (the tree compiled once per text to
closures; a run's relative references move by the cell's offset from the run's first cell, so a filled-down column is
compiled once), `runtime.ts` (what compiled formulas share: the `Host` the workbook is to them, implicit intersection,
ranges read as arrays, element-by-element operators, the counting rules of `SUM` and its kin), `values.ts`, `functions/`
(the library: one module per category, registered by name in `registry.ts`; `criteria.ts` for the `*IF(S)` criteria and
wildcards, `special.ts` for the gamma and beta functions and inverting distributions), `engine.ts` (dependencies,
recalculation, spills) and `move.ts` (references following inserted and deleted rows and columns, renamed and deleted
sheets). The worker recalculates after every edit, undo and redo (`worker.ts`, `recalculate`), and the page redraws the
cells that changed on every sheet (`Changed.elsewhere`). Tests: `client/test/sheetEngine.test.ts`, the oracle
(`sheetOracle.test.ts`, every case now also calculated), an e2e spec, and `scripts/sheets/check.ts` (a workbook typed and
calculated here, which Excel opens and recalculates to the same values).

**How it works.** Plan section 4 holds, with these choices made:
- *Closures, not bytecode*: a compiled formula is a tree of closures; it costs about 1.8 µs a cell on a filled-down
  `B2*C2` (2,000,000 formula cells recalculate in 3.7 s, `.cache/tools/engine-bench.ts`).
- *Dependencies per run*: each reference of a run is one entry under the columns it reads (one list per sheet for wide
  references), with each end of its rows fixed or moving with the cell; which rows of a run read a changed row is worked out
  from that, so an edit marks dirty exactly the cells that read it. Formulas whose references cannot be known before they
  run (`INDIRECT`, `OFFSET`, volatile functions, a range built with `:` from a function, a spill reference `A1#`, names
  that are not plain ranges) are recalculated on every change. The index is rebuilt after an edit that changes formulas.
- *Calculating*: dirty cells are calculated in order down each column; a cell read while dirty is calculated first, so the
  order needs no sort; a chain deeper than 400 is worked on from its far end instead of recursing (`Defer`), so a chain of
  a million cells does not overflow the stack; a cell reached again while it is being calculated is a circular reference
  and keeps its value.
- *Spills*: a dynamic formula's array fills the cells to its right and below unless one holds something (`#SPILL!`); the
  engine remembers which cells each spill filled, takes them back when it shrinks or is blocked, and recalculates it when a
  cell in its range is typed into or cleared. A spilled formula is kept as the file keeps one (an array formula over its
  range, `cm="1"`), and the writer adds `xl/metadata.xml` (the dynamic-array cell metadata) when a workbook has none.
  Formulas typed here are dynamic (as in Excel 365); formulas from a file without `cm` keep legacy implicit intersection.
- *Moving references* (`move.ts`): an insert or delete moves every reference to the sheet in every formula and defined
  name, as Excel does (ranges grow and shrink, deleted cells become `#REF!`); a run is cut where a relative reference starts
  to reach moved rows, and each piece gets its own text. Undo restores every column's formulas and the names.
- *Saving*: our values are Excel's, so the writer no longer asks Excel to recalculate on opening, unless a formula uses what
  the engine cannot calculate yet (an unknown function, a table reference, a data table: `Engine.incomplete`).

**The oracle.** All 1,045 cases (10 groups) calculate to Excel's values, numbers within 1 part in 10^13, except Excel's
iterative `RATE`, `IRR` and `XIRR`, which stop a few digits short of the root (ours is the exact root; compared to 7
digits). Learnt: `MINUTE` and `SECOND` round the time to the nearest second first; `AND` skips text given directly that is
not TRUE or FALSE; `UPPER` leaves `ß` alone; Excel's `INDEX(range,0,1)` in a dynamic formula spills the column.

**Functions so far** (about 380): math and trigonometry, logical, text, information, lookup and reference, date and time,
statistical with the distributions, financial without the bond family, and the dynamic-array and LAMBDA helpers. M4 adds
the rest (engineering, database, the bond family, the rest of text and statistics), a catalogue of what is done, and
oracle groups for each.

**Not done yet in M3**: structured references (with tables, M5); number literals printed as Excel prints them when a
formula is typed (`=ABS(-0)` is saved by Excel as `ABS(0)`); iterative calculation of circular references when the
workbook asks for it. An inserted row above two million formula cells recalculates all of them (about 4 s); the worker
does it in 50 ms slices (`recalculateInSlices`), answering tile requests between them, while edits and saves wait.

### M2: the editor, first build (2026-10-31)

**What exists.** A workbook dropped, opened or imported opens in the spreadsheet editor: `sheet/handle.ts` is what the app holds
(the rest is a lazy chunk), `sheet/view.ts` the page (formula bar and name box, sheet tabs, find bar, the in-cell editor, keys,
mouse, clipboard), `sheet/renderer.ts` and `geometry.ts` the drawing (panes for frozen rows and columns, headers, cell tiles,
the overview, the selection), `sheet/fonts.ts` the cells' fonts, `sheet/cellText.ts` where text goes in a cell, `sheet/worker.ts`
the worker (protocol in `protocol.ts`) holding the workbook with `edit.ts` (edits and undo), `input.ts` (what typing means),
`tiles.ts`, `draw.ts`, `clipboard.ts` and `find.ts`. The app's wiring is in `main.ts` (`openSheet`, `sheetEngine`), the Sheet
menu in `ui/chrome.ts` (`SHEET_OPS`), the `xlsx` kind in `ui/formats.ts`, the memory images in IndexedDB (`images`,
`storage/local.ts`). Tests: `client/test/sheetEdit.test.ts`, `e2e/sheets/sheet.spec.ts`.

**How it behaves.** The workbook's structure opens first; the active sheet streams in and shows as it comes (the worker pauses
every 50 ms so tile requests are answered meanwhile), then the other sheets; then the memory image is kept with the stored
copy, and the next open maps it (`fromImage` in the test hook). Saving writes the `.xlsx` and a new image from one state of
the workbook (edits wait for a save under way; tiles do not). Typing follows Excel's input rules and gives a General cell the
format the typing implied. Formulas typed are kept, written to the file, and shown blank until the engine (M3) calculates them;
a save with changed cells asks Excel to recalculate on opening.

**Learnt in the app.** A long save blocked tile requests until saves pressed the pause too; the autosave started by opening a
file must never end someone's typing (`save()` leaves the cell editor alone); an edit sent but not answered must count as
undoable, or the chrome refuses an Undo pressed at once (`inFlight`); actions reach a host only if `chromeHost.ts` lists them
(`SUPPORTED`).

**Not done yet in M2** (each is small, or belongs to a later milestone): Replace (find works), autofit by double-clicking a
header's edge, dragging past the window's edge to scroll, workbook thumbnails in Documents, a dark-mode look for the headers.
Known: a shared 11 kB chunk (`refs-*.js`) between the sheet view and the `.xlsx` handler, both lazy.

### M1: the core (done, 2026-10-31)

**What exists** (all of it pure and tested in Node, `client/test/sheet*.test.ts`):

| Path | What it is |
| --- | --- |
| `docx/src/zip/zip.ts` | `ZipEntry.stream()`, ZIP64 read and write, `deflatePieces` (a part deflated as it is made) |
| `docx/src/opc/package.ts` | `OpcPackage.stream`, `setDeflated`, `original`; `[Content_Types].xml` copied as it is while no type changed |
| `client/src/sheet/model/column.ts` | `Column` (a rope of sparse or dense chunks, rows inserted and deleted without moving data, snapshots for undo), formula runs, `Grid` |
| `client/src/sheet/model/sizes.ts` | row heights and column widths: arithmetic until one differs, then a Fenwick tree |
| `client/src/sheet/model/strings.ts` | the string pool, kept as bytes |
| `client/src/sheet/model/styles.ts`, `theme.ts` | the style table (styles.xml kept as a tree and appended to), theme colours and tints |
| `client/src/sheet/model/worksheet.ts`, `workbook.ts` | a sheet and a workbook, with what the file said that the model does not hold |
| `client/src/sheet/format/numberFormat.ts` | Excel's number formats: all 798 oracle cases give Excel's text |
| `client/src/sheet/formula/fileNames.ts`, `shift.ts` | `_xlfn.` prefixes; moving relative references (shared formulas) |
| `client/src/sheet/xlsx/read.ts`, `sheetScanner.ts`, `sharedStrings.ts`, `worksheetXml.ts` | the reader |
| `client/src/sheet/xlsx/write.ts` | the writer |
| `client/src/image/container.ts`, `client/src/sheet/image.ts` | the memory image: the container, and a workbook's image |
| `scripts/sheets/` | `generate.ts`, `bench.ts`, `excel.ts` + `excel.applescript`, `oracle.ts` + `oracle/cases.ts`, `check.ts` |

**Measured** (1M rows by 20 columns, 135 MB file, 733 MB of sheet XML, Node on Apple silicon): read 9.0 s (first rows after
110 ms), 13 bytes a cell; **open from the image 90 ms** (fingerprint 72 ms, map 16 ms; the image is 237 MB); write after an
edit 19.7 s, of which about 13 s is waiting on the platform's deflate (`CompressionStream`, which has no faster level and
cannot be split across threads). A 50 MB workbook of ordinary data saves in about 8 s, off the main thread: over the 5 s
budget. The way to meet it is a deflate of our own (fast LZ77 and Huffman, flushed per band so bands can be compressed in
several workers and joined); left for later, since saving runs in the background.

**Excel accepts what we write.** `scripts/sheets/check.ts` writes 12 workbooks (the oracle's with edits, styles, merges and
panes; one made from scratch; the generated 100k-row one with rows inserted through its shared formulas) and has Excel
open each with alerts off: all opened without repair, and Excel's saves kept every value and formula (1.8 million cells).

**Learnt from Excel's files:**
- Excel writes `<v xml:space="preserve">` for a value with leading or trailing spaces, and `<v/>` for an empty string.
- A saved number literal is printed Excel's way (`1.5e-10` as `0.00000000015`).
- `TEXT` and cells share the 11-character General; a negative date is `#VALUE!` in `TEXT`; Excel refuses a fraction whose
  numerator passes 65,535 (fixed denominator) or 2^31 - 1.
- Excel numbers theme colours with each dark/light pair swapped (theme 0 is `lt1`, 1 is `dk1`).
- `calcChain.xml` must go when cells change, or Excel repairs the file; until the engine recalculates (M3), a save with
  changed cells asks Excel to recalculate on opening (`fullCalcOnLoad`).

### M0: foundations (done, 2026-10-31)

**What existed then.** `ZipEntry.stream()`, the first scanners and column model, `scripts/sheets/generate.ts` and
`bench.ts`, and a throwaway prototype of the far zoom (`client/proto/`, removed in M1: M2 builds the real view).

**Reading** (Apple silicon; generated workbooks: numbers, shared strings, dates, booleans, one shared formula a group):

| | 100k rows x 20 (13 MB file, 71 MB XML) | 1M rows x 20 (135 MB file, 733 MB XML) |
|---|---|---|
| Inflate only (Node) | 0.23 s | 2.1 s |
| Inflate and scan, Node | 0.84 s | 8.2 s |
| Inflate and scan, Chrome worker | 0.93 s | (whole prototype, with overview tiles and the fetch: 13.2 s) |
| First 4,096 rows ready | 41 ms | 55 ms |
| Model | 27 MB, 14.8 bytes a cell | 261 MB, 14.5 bytes a cell |

- The scanner runs at about 90 MB of XML a second, Node and Chrome alike; the profile is flat (CRC 13%, the scanner's loops the
  rest), so no single fix doubles it. A 50 MB `.xlsx` of ordinary data is under 300 MB of XML, about 4 s: within budget.
  Candidates for later: find `</c>` while reading the cell instead of before (one pass, not two), skip the CRC when the memory
  image is about to be written from the same bytes.
- A filled-down column was one formula run, as designed: 2,000,000 formulas in 2 runs.
- **Never format to measure.** The prototype first built the overview from each cell's formatted text (`toLocaleString`,
  `Date`): 6.4 s for 100k rows. Estimating the shown width from the number and its format took it to 1.3 s. The overview and
  overflow need a width estimate per (format, value) that makes no string; number formats (M1) compile to both a formatter and
  a width function.
- **The worker must answer while it reads.** In the prototype the request for the cells on screen waited until the whole
  file was read: the read loop's awaits resolve as microtasks and the message queue starves. The real worker reads in slices
  that yield to the event loop (or reads in a second worker), so viewport requests are answered within a frame.

**The far zoom.** One texel a cell, with mipmaps for the levels above, drawn as quads on the camera: a frame is 0.1 to 0.7 ms
at any zoom down to 0.05%, and columns read as bands of their own grey (numbers, text, dates, booleans each look different;
a sparse column shows as ticks). The cross-fade between the overview and text, from 9 down to 4 pixels a row, reads well:
at about 7 pixels the text is tiny but its shape matches the overview's bands, so nothing jumps.

A long, narrow sheet zoomed out far is a narrow strip (1M rows by 20 columns at 1% is 15 pixels wide, showing 3,840 rows).
*Decided:* sheets zoom both axes together, like documents; no separate column scale and no folding.

**The oracle.** `scripts/sheets/oracle.ts` writes a workbook per group of cases (`scripts/sheets/oracle/cases.ts`: 233 cases
in 9 groups: math, logical, text, lookup, date, statistical, financial, info, dynamic arrays), has Excel calculate and save
it (`scripts/sheets/excel.ts`, `excel.applescript`: through a folder in Excel's sandbox, workbooks closed by name so nothing
else open in Excel is touched; about 10 s for all nine), and keeps Excel's files as `client/test/fixtures/sheets/oracle/`
(124 kB). `client/test/sheetOracle.test.ts` reads them back. What it taught:

- **Excel refuses a whole file over one formula it would not let you type.** `1E+308` (the largest literal is
  9.99999999999999E+307) and `RANK.AVG(3,{1,3,3,5})` (its second argument must be a range) made Excel unable to open the
  file at all. Our formula parser must refuse the same formulas, or a file we save will not open. `oracle.ts` finds such a
  case itself, one case at a time, when Excel refuses a group.
- **Excel normalises what it saves**: number literals are printed its way (`ABS(-0)` as `ABS(0)`, a 20-digit literal to
  15 digits). Every function name, with its `_xlfn.` and `_xlfn._xlws.` prefix, matched our list (`sheet/formula/fileNames.ts`)
  in both directions.
- **Excel writes an empty-string result as `<v/>`**, which the scanner read as a blank cell; fixed and tested.
- The values already show the quirks the engine must match: `-2^2` is 4, `0.1+0.2=0.3` is TRUE (15-digit comparison),
  `2^-1074` is 0 (no denormals), `DATE(1900,2,29)` is 60, `TIME(25,0,0)` is 0.04166666666666674, `SUM` over a range holding
  `#N/A` is `#N/A`, and dynamic arrays spill as expected.
