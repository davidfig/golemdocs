# Editing PDFs

A PDF opens as its own pages. There are two modes, chosen with the buttons at the top right:

- **Fill In**: the form's fields are inputs. Nothing else on the page changes.
- **Edit PDF**: everything on the page can change. Text is edited where it sits; pictures, shapes and drawings are moved, resized, restyled and deleted; text, pictures, shapes, white-outs and redactions are added; pages are deleted, turned, moved, copied and added; form fields are moved, added and renamed.

Nothing is written into the file until it is exported. What has been done is a list of **edits** kept with the document (the `.wdoc`'s `pdf` extension, `edits`), next to the annotation and form-field layers. Undo steps through all three together.

## How an edit is applied

`@word/pdf` (`pdf/src/edit/`) turns the list into pages:

| File | What it does |
|---|---|
| `scan.ts` | Walks a page's content once. Every text-showing operator becomes a **run** (its glyphs' bytes, advances, font, size, color); every image, painted path and form XObject becomes an **object**. Each carries the index of the operator that draws it. All in user space (points, y up). |
| `blocks.ts` | Guesses structure: runs on a baseline are a **line**; three or more left-aligned lines that wrap into each other are a **paragraph**; anything else is a single line. Two lines are never joined: joining two lines that happen to be about as long would pull text out of one into the other on an edit, whereas splitting a real paragraph only stops it rewrapping. |
| `text.ts` | Edits a block as text. A block becomes **cells**, one per glyph, each still holding the bytes it was shown with. The new text is matched against them (longest common subsequence), so characters that stay keep their own glyphs and style, and characters typed take the style of their neighbours. Cells are wrapped into lines and emitted as content operators. |
| `apply.ts` | `applyEdits(doc, edits)` makes a document's pages hold exactly a list of edits. **It always starts again from each page's original content** (kept aside the first time), so the list can change freely (undo, redo, an edit taken back) and the same list always gives the same page. |

Things worth knowing:

- **Unchanged lines are left alone, byte for byte.** Only lines whose cells changed are removed from the content and shown again. Removed text is replaced by a kerning adjustment of the same advance, so text that follows it in the same text object doesn't move.
- **Glyphs that were already there are shown from their original bytes in their original font.** That is why editing works in subset fonts: nothing has to be re-encoded. Only a character that is *new* needs a font that has it: the run's own font if `TextFont.characters` lists it (for a subset font, only glyphs it actually holds: codes with a width and, for embedded TrueType, an outline). Otherwise `fallback.ts` tries, in order: another font in the file made from the same face (another subset, or the form's default resources); the same embedded program, through a copy of the font dictionary that reaches every glyph it has an outline for (fonts embedded whole); and last a standard font (WinAnsi characters only), Helvetica, Times or Courier by the font's name and flags (widths decide whether it is monospaced), set at the size that matches the font's x-height and the horizontal scaling that matches its widths. Characters none of these can show leave a gap.
- **New text goes where the old text was**, right after the text object of the block's last run (with the graphics state undone so the coordinates hold), so stacking order and reading order are kept. Things added (shapes, pictures, text boxes) go on top.
- **Redaction is real.** It runs last, over the content as edited so far, dropping the glyphs inside the box from each run and any picture, shape or drawing wholly inside it. Exporting a file with edits is a *full* save, so the original content stream isn't left in the file behind the new one. A picture only partly under a redaction stays whole under the box (its pixels can't be erased without decoding it); `ApplyResult.partial` reports that and the page says so.
- **Page operations make a new file.** The current edits, markup and fields are baked into a copy, the page is deleted/turned/moved/copied/added in it, and the copy becomes the document's PDF. The old file stays in the undo history (`PdfAnnotator.replaceView`, `reopen`), so undo goes back across it.

## In the app

- `client/src/layout/pdfAnnotator.ts` (in the layout worker) owns the layers and the undo history, and knows what is picked.
- `client/src/formats/pdfPages.ts` shows the pages: `setEdits` applies a list, `original(index)` scans the file's own page (from a second, untouched copy) to find what a click hit.
- `client/src/ui/pdfTextLayer.ts` is the editor over a picked block: the page shows the block blank while it is open, and the editor draws the text in the same place, size and color.
- `client/src/ui/pdfEditTools.ts` is the palette (tools, the selection's settings, page buttons) and the layer with the selection frame and the drag-to-place catcher.

## Fonts

The app draws with glyph atlases (images), which a PDF can't use. So next to each family's atlas there is the font file itself (`client/public/fonts/<family>/<face>.ttf`, the open-source face that stands in for the Word font: Liberation, Carlito, Caladea, Selawik, Comic Relief; all OFL). `pnpm fonts` writes them with the atlases, and `pnpm fonts --ttf-only` copies them and lists them in the manifest (`font`) without rebuilding atlases.

- A file is fetched only when an edit sets text in that family (`client/src/formats/pdfFonts.ts`), kept, and looked up synchronously when edits are applied (`ApplyOptions.fontFile`).
- `appFonts.ts` embeds it once per document and style; it is written subset to the glyphs used when the file is saved. Characters it lacks fall back to the nearest standard font.
- An embedded font's widths grow as glyphs are used, so after each application they are brought up to date and the fonts read so far are forgotten (`syncFonts`); otherwise later glyphs would be read at a default width.
- The page view recognises an embedded font by the substitute's name, and the editing box loads the same font file as a web font, so what is typed looks like what the page draws.

## Limits

- Only the page's own content is edited. Text inside a form XObject is part of that object (moved or deleted whole). Rotated, vertical and outline-only text isn't editable (it is left as it is; a redaction does take it out).
- Font, size and color apply to a whole block. A block or text box can be set in any family the app has a font file for (Arial, Times New Roman, Courier New, Calibri, Cambria, Segoe UI, Comic Sans MS), or in Helvetica, Times or Courier. Georgia isn't offered: its source is a variable font, which can't be embedded as bold or italic yet.
- The renderer draws upright text, rectangles, straight lines and pictures; other drawings and shadings are edited (they can be selected, moved and deleted) but not shown.
- Scanned pages are a picture: there is no text to edit. Use a white-out or redaction, or add text.
- Encrypted files are decrypted on open and saved unencrypted, as everywhere else.

## Testing

```sh
pnpm --filter @word/pdf test                                     # includes edit.test.ts and edit-corpus.test.ts
pnpm --filter @word/client test                                  # includes pdfAnnotator.test.ts
EDIT_CORPUS=.cache/pdfjs/test/pdfs pnpm --filter @word/pdf test  # the same edits on every file of a corpus (see fetch-corpus)
```
