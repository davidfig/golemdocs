# Document formats

The editor works on one in-memory model (`WordDocument` from `@golemdocs/docx`). Every other file format is an edge: a *handler* reads bytes into the model on the way in and writes the model back to bytes on the way out. This doc covers the handler registry, the format libraries (`docx/`, `odt/`, `pdf/`), the app's own `.wdoc` container, and what each conversion loses.

## How it works

```
 file bytes --sourceFromFile (source.ts)--> DocumentSource {kind,name,bytes}
                                                   |  (posted to the layout worker)
                                                   v
                       layout/layoutWorker.ts load()  -> importDocument(kind, bytes)
                                                   |        HANDLERS[format]() (convert.ts, lazy chunk)
                                                   v
                            { document: WordDocument, extensions }   <- "what the model can't hold"
                                                   |
                      edit as `lens` (the format the document is edited as)
                                                   |
   save:  writeWdoc  (whole document, always)      |   export / switch format:
   .wdoc = docx + extensions/<ns>.json (+ original PDF)   exportDocument(doc, extensions, format, fonts)
```

Key ideas:

- **The model is always Word-shaped.** Markdown, HTML, LaTeX, CSV, pictures and so on are *lenses*: the document is a `WordDocument` plus an `Extensions` bag holding what only that format can express (Markdown front matter, a CSV's delimiter, a text file's BOM and line endings, ODF styles, HTML head/attributes...). Writing a format reads only its own namespace and ignores the rest, so exporting to the original format after any number of switches returns the original (`FormatHandler` doc comment in `client/src/formats/convert.ts`).
- **Picking the handler** is by file name (`sourceFromFile`, `client/src/formats/source.ts`: a table of extension regexes). Exceptions decided by bytes: a `.wdoc` is recognised by its stored `mimetype` entry whatever it is called (saved copies keep the lens's name, e.g. `Report.md`), a ZIP with `word/document.xml` is Word whatever the name (a room that ended writes plain Word under another name), and `.xml` is sniffed for DocBook / JATS / FB2 / OPML (`xmlDocumentKind`). Anything else matching `isTextName` (`textFiles.ts`: logs, config, source) opens as `txt`.
- **Lazy chunks.** `HANDLERS: Record<Format, () => Promise<FormatHandler>>` in `convert.ts` returns static handlers for the tiny ones (`docx`, `txt`, `csv`/`tsv`, `html`, `md` glue, `png`/`jpeg`/`webp`) and `import()`s the rest, so each format is its own chunk. Handlers that share code share a module (`handlers/markup.ts` for LaTeX/AsciiDoc/RST/Org/MediaWiki/Textile/Typst on top of `outline.ts`; `handlers/xmlDocuments.ts`; `handlers/webArchives.ts` for EPUB/MHTML/EML; `handlers/svg.ts`). The `md` handler dynamically imports `markdown.ts` itself so Markdown is one request. The size rules (about 20 kB threshold, no static+dynamic import of the same module) are in `AGENTS.md`.
- **`.doc` (Word 97) is import only**: `docImport.ts` (with `cfb.ts`, the compound-file reader) is imported directly by the layout worker, with no `Format` entry and no export.

## The format libraries

| Package | What it is |
| --- | --- |
| `docx/` (`@golemdocs/docx`) | Dependency-free OOXML reader/writer plus the document model: zip, xml, opc, model (`StyleResolver`, `ListCounter`), math (OMML/LaTeX/MathML), edit helpers, and the search index builder the server also uses (`docx/src/search`). Unmodelled content is kept (`extra`, `Raw`, `Wrapper`) so open then save loses nothing. See [docx/README.md](../../docx/README.md). |
| `odt/` (`@golemdocs/odt`) | `readOdt` / `writeOdt` between ODF 1.3 (`.odt`, flat `.fodt`) and `WordDocument` + `OdtExtension` (styles, sections, frames that the model lacks; `odt/src/extension.ts`). Has no README: start at `odt/src/index.ts`. |
| `pdf/` (`@golemdocs/pdf`) | Dependency-free PDF reader/writer: parser, filters, encryption, fonts, text extraction and reflow (`text/reflow.ts`), content scanning and editing (`edit/`), annotations and forms (`write/`). See [pdf/README.md](../../pdf/README.md) and [PDF editing](../pdf-editing.md). |

## Key files

| Path | Role |
| --- | --- |
| `client/src/formats/convert.ts` | `Format` union, `FORMAT_LIST`, `FormatHandler`, `HANDLERS`, `importDocument` / `exportDocument` / `convertContent`, `conversionIsLossy` |
| `client/src/formats/source.ts` | file name/bytes to `DocumentSource` (`sourceFromFile`), `stem`, `isZipName`, `xmlDocumentKind` |
| `client/src/formats/handlers/*.ts` | one `FormatHandler` (or a few) per format group |
| `client/src/formats/wdoc.ts` | the `.wdoc` container, `Extensions`, `readWdoc` / `writeWdoc` / `isWdoc` |
| `client/src/formats/roomDoc.ts` | the document a collaboration room shares (see below) |
| `client/src/formats/markdown.ts`, `markdownStyles.ts`, `frontMatter.ts` | Markdown reader/writer and the style conventions every text format shares |
| `client/src/formats/outline.ts` | outline <-> model for the lightweight markup formats (`latex.ts`, `asciidoc.ts`, `rst.ts`, `org.ts`, `mediawiki.ts`, `textile.ts`, `typst.ts`) |
| `client/src/formats/html.ts`, `rtfImport.ts` / `rtfExport.ts`, `docImport.ts`, `epub.ts`, `mhtml.ts`, `eml.ts`, `csv.ts`, `ipynb.ts`, `fb2.ts`, `docbook.ts`, `jats.ts`, `opml.ts` | per-format readers/writers |
| `client/src/formats/pdfImport.ts`, `pdfExport.ts`, `pdfPages.ts`, `pdfMarkup.ts`, `pdfFonts.ts` | PDF reflow into a document, document to PDF, page view and annotation |
| `client/src/formats/imageDoc.ts`, `vectorDoc.ts`, `images.ts`, `svgFromDocument.ts` | pictures and SVG drawings as page documents |
| `client/src/formats/plainText.ts`, `textFiles.ts` | text <-> document, encodings (UTF-8/16, Windows-1252), which extensions are text |
| `client/src/formats/wikiLinks.ts`, `embeds.ts`, `embedMarks.ts`, `docLinks.ts`, `ikiLinks.ts` | links between stored documents (below) |
| `client/src/formats/paste.ts` | clipboard HTML is read with the HTML importer into a scratch document |
| `client/src/storage/zipImport.ts`, `droppedFiles.ts` | importing a ZIP or dropped folder as documents in folders |

## Key data types

- `Format` (`convert.ts`): `'docx' | 'odt' | 'rtf' | 'html' | 'epub' | 'mhtml' | 'csv' | 'tsv' | 'tex' | 'adoc' | 'rst' | 'org' | 'mediawiki' | 'textile' | 'typst' | 'docbook' | 'jats' | 'fb2' | 'opml' | 'eml' | 'ipynb' | 'png' | 'jpeg' | 'webp' | 'svg' | 'svgz' | 'pdf' | 'md' | 'txt'`.
- `FormatHandler { read(bytes) -> {document, extensions}; write(document, extensions, fonts) -> bytes }`.
- `Extensions` (`wdoc.ts`): optional namespaces `md, txt, pdf, odt, html, csv, eml, ipynb, svg, img, vec`. `NAMESPACES` in the same file lists the ones persisted; add a key there too or it is silently not saved.
- `DocumentSource` (`client/src/layout/protocol.ts`): the tagged union (`kind: 'docx' | 'doc' | 'md' | ... | 'wdoc' | 'docx-url' | 'blank' | 'welcome'...`) the worker's `load()` switches on.
- `OpenContent`: an editable model in a non-PDF format, or a PDF's original bytes (a PDF opens as its own pages, not through the model).

## The .wdoc format

The app's native save format (`wdoc.ts`, `WDOC_VERSION = 1`): a ZIP whose first entry is a stored `mimetype` (`application/x-golem-document`, so `isWdoc` can sniff the first bytes), then `manifest.json` (`WdocManifest`: `version`, `lens` = format being edited as, `origin` = format first imported, `pagesCurrent`), `document.docx` (the flowing document, absent for a PDF not yet reflowed), `extensions/<ns>.json`, and `originals/source.pdf`. A file with a newer `version` is refused rather than misread. Everything stored in the browser and cloud is a `.wdoc` (see [Storage and sync](storage-and-sync.md)); the server only needs the inner `document.docx` (`server/src/stored.ts`).

`roomDoc.ts` is the variant for collaboration: a room's document is a `.wdoc` unless it is plain Word with no extensions, in which case it stays a plain `.docx`. `roomKind(format)` says whether a room edits `doc`, `objects` (PDF), `layers` (pictures) or `nodes` (SVG drawings). See [Collaboration](collaboration.md).

## Markdown, text and Obsidian-style import

- **Markdown** (`markdown.ts`, hand-rolled CommonMark + GFM tables/strikethrough) maps to model conventions documented at the top of that file: `Heading1..6` styles, `Quote`, `Code` paragraphs, real numbering, task items, tables with a header row. YAML front matter is split off (`splitFrontMatter`) into `extensions.md.frontMatter` and written back verbatim. Comments round-trip as CriticMarkup (`{==text==}{>>comment<<}`). Footnotes and raw HTML stay literal text. Nothing throws on odd input: unknown syntax degrades to text.
- **Obsidian-style links**: `[[Note]]`, `[[Note#Section]]`, `[[Note|label]]` and `![[embed]]` read to hyperlinks with a `doc:` address (`wikiLinks.ts`: titles, not ids, so links survive moves and other browsers; address helpers live in `@golemdocs/docx` `search/links.ts`, where the server-side index reads them too). Embeds stay placeholder links until `resolveEmbeds` (`embeds.ts`) looks the target up. Links that name folder paths follow renames and moves through `client/src/linkRename.ts` and `docLinks.ts` (`rewriteDocumentLinks`).
- **Plain text** (`handlers/txt.ts`, `plainText.ts`, `textFiles.ts`): encoding, BOM and line ending are kept in `extensions.txt` and restored on write. Files of 8 MB or more open in the large-text editor instead (see [text-files.md](../text-files.md)).
- **CSV/TSV** keep delimiter, line endings and encoding in `extensions.csv`.

## Conversion fidelity

`conversionIsLossy(from, to)` in `convert.ts` drives the "this loses something" warning. Rules in short:

- Same format: lossless. Switching is "up" the ladder text -> Markdown -> Word without loss; Word/ODT/RTF/HTML to Markdown, text or PDF loses styling, layout, comments and anything the target lacks.
- The lightweight markups (LaTeX, AsciiDoc, RST, Org, MediaWiki, Textile, Typst, DocBook, JATS, FB2, OPML, EML, ipynb) are lossy only when going to `txt` or `pdf` (they share Markdown's conventions via `outline.ts`); OPML and FB2 as a *target* are lossy from everything but text/CSV (OPML holds one-line entries; FB2 has no lists or code blocks).
- PDF is fixed layout: export lays the document out and writes real, selectable text (embedded subset fonts where a font file ships with the app, otherwise standard-14 fonts, so non-WinAnsi and CJK text becomes `?`; see header of `pdfExport.ts`). Import (`pdfImport.ts`) *reflows* recovered text and structure into a new document, so anything from a PDF is lossy (vector art such as logos, charts and QR codes is kept as pictures: `interpretPage(page, { paths: true })` keeps the painted paths with their clips, linear and radial gradients (`render/shading.ts`), tiling patterns, dashes, caps and joins, plus pictures drawn turned; `pdfDrawings.ts` groups the paths that touch and makes each group a `Scene` of the drawing editor (`vector/model.ts`), written as SVG by `vector/svgWrite.ts` and, for the PNG beside it, painted by `vector/paint.ts` (so it has no renderer of its own; without a canvas, as in Node tests, the PNG is one transparent pixel), and `pdfPlaced.ts` floats it on its page, with turned and mirrored pictures as Word's own `rot`/`flipH`/`flipV`; rules and boxes around text are left out; mesh shadings, JPEG 2000 and JBIG2 images are not read); text colors come from `extractText` (`TextItem.color`); running heads and feet (`ReflowResult.running`) become the document's header and footer with tab stops and PAGE/NUMPAGES fields; with a page per PDF page (`pageBreaks`, or placed things) the section's bottom margin is kept small so a line a point taller than the PDF's does not spill onto a new page, and a page's first paragraph carries the part of its top offset the margin (capped at a third of the page) cannot; the original bytes ride along in `originals/source.pdf`.
- Pictures are a page showing the image; PNG is lossless, JPEG/WebP compress. SVG stays vector only as SVG/SVGZ/PDF; to a raster it is pixels.
- HEIC/HEIF (iPhone photos) is read-only: `sniffImage` recognises it from its `ftyp` brand and reads the main picture's size (`ispe`, with `irot`) from the `meta` box, and it is turned into a JPEG when opened (the picture format's `read`), inserted or embedded (`toPng`), so a document never holds HEIC. `decodeImage` tries the browser's own decoder first (Safari) and only then `import()`s `formats/heicDecode.ts`, libheif-js with its wasm inlined: a single lazy chunk (over 1 MB) no other code may import statically.
- `.doc` import reads text, character/paragraph formatting, styles, lists, tables, links, inline PNG/JPEG, first-section page setup, comments; not headers/footers, footnotes, text boxes, tracked changes (see top of `docImport.ts`).

## Adding a format

1. Write the reader/writer in `client/src/formats/` (put heavy parsing there, not in the handler).
2. Add `handlers/<name>.ts` exporting a `FormatHandler` (read keeps extras in an `Extensions` namespace; write gives them back).
3. Add the name to `Format` and `FORMAT_LIST`, and a line to `HANDLERS` in `convert.ts` (static import only if a few hundred bytes).
4. If it has extension data: add the interface and key to `Extensions` and to `NAMESPACES` in `wdoc.ts`.
5. Recognise it: a regex and a `DocumentSource` kind in `source.ts` and `layout/protocol.ts`, a `case` in `load()` in `layout/layoutWorker.ts`, and the extension in `stem`.
6. Update `conversionIsLossy`, the Open/Save/Export menus and i18n strings.
7. Tests in `client/test/` (`convert.test.ts`, `wdoc.test.ts` are the models), then `pnpm --filter @golemdocs/client build` and read the chunk list.

## Invariants and gotchas

- `importDocument` must not throw on malformed text input where avoidable; Word `.doc` and encrypted files are refused with an error.
- Never import a handler module both statically and dynamically; the static one defeats the split.
- A `.wdoc` keeps the *lens* name on disk ("Report.md"); always sniff bytes, do not trust the extension.
- Writing must drop exactly what the target cannot express, and nothing in the `Extensions` of other formats.
- `NAMESPACES` (persisted) and `Extensions` (typed) must be kept in step by hand.

## Related docs

[Storage and sync](storage-and-sync.md) · [Server](server.md) · [Document model](document-model.md) · [Layout](layout.md) · [Collaboration](collaboration.md) · [PDF editing](../pdf-editing.md) · [Text files](../text-files.md) · [docx README](../../docx/README.md) · [pdf README](../../pdf/README.md)
