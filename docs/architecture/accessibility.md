# Accessibility

The document is drawn on a WebGL canvas, so assistive technology cannot read it unless we describe it ourselves. The canvas stays the only thing anyone sees. Next to it, the page keeps two invisible HTML layers that screen readers can read, built from what the layout worker already knows about the document. This is the approach VS Code, Google Docs and Flutter take.

There are two layers because people use screen readers in two ways: editing (moving the caret, typing) and reading (going through headings, lists and tables). Both are built only in **Screen Reader Mode**.

**Every new feature comes with its accessibility** (the rule in `AGENTS.md`): a keyboard way to do everything, accessible names and roles from the shared controls, what only the canvas shows passed to Screen Reader Mode (the mirror, the reading layer or `announce()`), colours that work in High Contrast and `forced-colors`, and e2e checks in `e2e/accessibility/`. The sections below are the pieces to build it from.

## Screen Reader Mode

A browser cannot tell whether a screen reader is running, so the layers are behind a setting: Tools › Screen Reader Mode (Mod+Alt+Z), also in Tools › Options › Accessibility.

- Kept in `golem.screenReader` (`ui/screenReader.ts`). It is a preference, so it is in `SYNCED_KEYS` and follows the account.
- While it is off, the document's textarea carries an `aria-description` that tells a screen reader user the shortcut. Turning it on or off is announced.
- The page tells the layout worker with `{ type: 'a11y', on }`. Only while it is on does the worker add the text around the caret to each `SelectionUpdate` and answer `a11yPages` requests, so nobody else pays for it.
- `screenReaderSupport.ts` (`ScreenReaderSupport`) is the page's side: `main.ts` hands it every selection, layout and render, and it drives the mirror, the reading layer and the announcements.

## Editing: the textarea mirrors the text near the caret

All keyboard input already goes to the hidden `<textarea id="input">` (`ui/textInput.ts`). It used to be emptied after every keystroke. In Screen Reader Mode it holds the text around the caret instead, with `selectionStart`, `selectionEnd` and `selectionDirection` matching our selection. Screen readers then read characters, words and lines as the caret moves, read a selection, and echo typing.

- **Worker side** (`layout/a11y.ts`):
  - `readableText` turns a paragraph into the text a screen reader should hear. Deleted text and field codes are skipped. A tab becomes `\t`, a line break `\n`, and a picture `U+FFFC`. Each character keeps its model offset.
  - `caretContext` builds the `{ text, anchor, focus }` sent as `SelectionUpdate.context`.
    - A caret or a selection within one paragraph gets up to 1,000 characters each side (`CONTEXT_RADIUS`).
    - A selection across paragraphs joins them with `\n`, capped at 2,000 characters, keeping the selection's direction.
    - In a header, footer or text box it is the paragraph the caret is in.
    - When a picture is selected, the context is `null`.
- **Page side** (`ui/caretMirror.ts`): `CaretMirror` writes the value and the selection only when they changed. It never writes during an input-method composition: after `compositionend` it re-shows the latest context on the next tick, so typing Chinese or Japanese keeps working.
- **PDFs** shown as pages: the worker sends the text of the line the caret is on (`pdfContext`).
- **Plain text files** (the large-text editor, `textEditor/view.ts`) mirror their own textarea the same way: the caret's line, or the lines selected (`linesContext` in `ui/caretMirror.ts`). Their reading layer is empty: the file is one long run of lines with no structure to describe.

## Reading: an invisible copy of the document's structure

`ui/readingLayer.ts` (`ReadingLayer`) is a `role="document"` element over the canvas. It holds:

- a list of the document's headings, as links;
- the pages in view, each built as real HTML;
- "Back to page n" and "Continue reading on page n" buttons at either end.

Each piece is absolutely placed over its line on the canvas and scaled with the camera. That gives VoiceOver touch exploration, lets magnifiers follow the focus, and lets the reader's cursor track what is on screen. The text is transparent, so nothing shows.

- **Only pages near the view are built:** those in view plus two either side. After the view settles (150 ms), the layer asks the worker for the pages it does not have (`{ type: 'a11yPages', pages, headings }`). A layout change drops the pages it changed and marks the headings stale.
- **Building a page** (`pageNodes` in `layout/a11y.ts`) groups each page's lines by paragraph, in reading order. For each paragraph it records:
  - its kind: heading (with level, from `HeadingReader`: Heading 1–6, Title or the outline level), list item (ordered or not), paragraph, or picture;
  - its text, split into parts so links become `<a>`;
  - its box on the page;
  - the table cell it is in, if any (table, row, column, header row).
  Header and footer paragraphs are left out. Pictures are read by their alt text, or else their name.
- **On the page** (`pageElement`, `nodeElement`):
  - headings become `h1`–`h6`;
  - list items become `li` in `ul` or `ol`;
  - tables become `role="table"` / `row` / `cell` / `columnheader` divs, so each cell can still sit over its own place;
  - pictures become `role="img"` with an `aria-label`.
- **Back to editing:** activating a heading link or a piece puts the caret there (`goTo`) and focuses the textarea, so a user can switch between reading and editing. A link to another site opens as usual.
- **PDFs:** each page's text lines (`pdfAnnotator.pageLines`) become paragraphs. They have no headings, and activating one does not move a caret.

## Announcements

`ui/announce.ts` has one polite and one urgent live region for the whole app, and `announce(message, urgent?)` speaks through them. `screenReaderSupport.ts` (`selectionMessages`) announces what only shows on the canvas:

- marks turned on or off with the caret still ("Bold on");
- the paragraph's style when the caret moves into a paragraph of another style ("Heading 2");
- the page when the caret moves to another page ("Page 4 of 12");
- people joining and leaving a shared document;
- a spelling or grammar mistake the caret moves onto ("Spelling error: teh"). The worker sends the one under the caret (`SelectionUpdate.mistake`, from the check-as-you-type results); it is not said while the word is being typed, since the text changed;
- where Find landed ("Found: …the words around it…", `foundSnippet`), since the focus stays in the Find dialog.

Other parts of the window announce what they show only to the eye while the focus stays put: the Thesaurus how many meanings it found ("happy: 4 meanings"), the command palette how many rows a search found once typing pauses, the Share dialog that a person was removed, Keyboard Shortcuts that it is waiting for keys, and the notes at the bottom of the window when they appear (`showNotice`).

Messages already shown in a dialog (Find's "No matches", a form's error) keep their own `role="status"` or `alert` next to the text: `announce` is for what only the canvas shows. The status bar is not a live region: its counts change with every keystroke.

## Getting around the window from the keyboard

`ui/focusRegions.ts`:

- **F6 / Shift+F6** cycle between the parts of the window: menu bar, each visible toolbar, the document, the side panels (comments, files, pages), the status bar and the notes at the bottom of the window while they show. `chrome.regions()` gives the menu bar and toolbars; `main.ts` adds the rest.
- **Toolbars** are `role="toolbar"`. Their buttons stay out of the Tab order, because Tab in the document is a tab character.
  - The arrow keys, Home and End move between the controls.
  - Enter and Space press the focused control.
  - Escape goes back to the document.
- **Skip link:** a "Skip to the document" link is the first thing Tab reaches.
- **Headings and tables:** Edit › Next Heading and Previous Heading (Mod+Alt+PageDown / PageUp), Next Table and Previous Table (with Shift) put the caret at the start of the next one (the worker's `jump` command, `jumpTarget` in `layout/a11y.ts`), or say there is none.
- **Menus** (`ui/menu.ts`): opened from the keyboard (F10, Alt and a letter, or Alt alone), they move the real focus through their titles and items, so screen readers read each one. Closing a submenu returns the focus to its row.
- **Popups** (`ui/popup.ts`, `popupKeys`): the arrow keys, Home and End move through the options, Enter or Space chooses one, and Tab and Escape close the popup. Closing it returns the focus to the button that opened it. This covers `dropdown`, split buttons and colour palettes, since they all open through `openPopup`.
- **Context menus** (`ui/popupMenu.ts`, `showPopupMenu`: the document's right-click menu with its synonyms, the files sidebar, the layers panel, the Documents screen) take the keyboard when they open, as a system menu does: Up, Down, Home and End move through the rows (`menuKeys`, shared with the spelling menu, `ui/spellMenu.ts`), Enter or Space picks, Right opens a submenu (a list still being looked up gets the keyboard when its rows arrive) and Left or Escape closes it, and Escape or Tab closes the menu, whose `onClose` gives the keyboard back. A spelling menu the pointer opened by resting on a word leaves the keyboard in the document. Shift+F10 opens a menu from the keyboard wherever a right click does (`onContextMenu`, `ui/contextMenu.ts`); in the document the menu key and Shift+F10 open it for the word at the caret (`caretMenu` in `main.ts`, which sends `spellAt` with `caret: true` so the worker uses its own caret rather than the page's, which may lag behind keys just pressed).
- **Shared controls** follow the ARIA patterns:
  - `segmented` (`ui/dom.ts`) is a radio group: one Tab stop on the chosen option, Left and Right to choose (Up and Down are left to the popup around it).
  - `roving` (`ui/dom.ts`) is the same pattern for any group: the item marked current is the one Tab stop, the arrow keys (Up and Down too when asked), Home and End move and choose, and the Tab stop follows the mark however it changes. `tabList` makes a `role="tablist"` strip one (Left and Right), links each tab and its pane (`aria-controls`, `aria-labelledby`) and gives panes `role="tabpanel"`; every dialog's tab strip uses it (Find, Page Setup, Paragraph, Properties, the equation keys, and the format dialogs' `tabStrip`). The format dialogs' galleries (Bullets and Numbering) are radio groups through `gallery` (`formatDialogs/parts.ts`), where every arrow moves, since a gallery wraps onto rows.
  - `choiceButton` (`ui/dropdown.ts`) is named by its label and described by the choice it shows (`aria-describedby`), so "Style, Regular" is read; a group of its choices under a heading is a `role="group"` named by it. The format dialogs' colour fields (`colorField`) are described by the colour's name.
  - `listBox` (`ui/listBox.ts`) keeps the focus on the list and points at the picked row with `aria-activedescendant`; rows under a heading go in a `role="group"` named by it (`optionGroup`). `pickOption` does the marking for every list whose rows don't take the focus: the list box, the command palette (whose search box is a `role="combobox"` over its list) and Customize Toolbars' two lists.
  - Colour swatches are named by colour ("Dark red", `ui/colorName.ts`, from hue and lightness), with the code as their tooltip, and the colour in use has `aria-current`.
  - The layers panel (`LayerTree`) is a tree. It has one Tab stop, rows with `aria-level` and `aria-expanded`, and are named with "hidden" or "locked" when they are. Up, Down, Home and End move; Right and Left open, close or go to the group; Enter or Space picks (with Ctrl or Shift as for clicks); F2 renames; Shift+F10 opens the row's menu. F6 reaches it.
  - The link form closes with Escape however it was opened.
- **Dialogs** give the keyboard back to what had it when they close (the browser does this for a modal `<dialog>`). If that is gone, a listener in `main.ts` (a capture `close` listener on the document) puts it in the document instead of leaving it on nothing. A dialog is named by its title bar (`dialogTitleBar` sets the dialog's `aria-labelledby` to its title, unless the dialog has a different name of its own). Controls repeated per row say whose they are (the Share dialog's "Access for Ana", "Remove Ana"), and a key button in Keyboard Shortcuts says the key it has now.
- **Notes at the bottom of the window** (a new version, the reload offer, a sign-in that ran out, the shared-computer note) are shown and hidden through `showNotice` (`ui/notice.ts`): one is read out when it appears, F6 reaches it, and when it goes while it has the keyboard the keyboard goes back where it came from.
- **Shapes** in drawings (`vectorEditor.ts`) and on pictures (`drawLayer.ts`) take the same keys, from `ui/shapeKeys.ts`: the arrow keys move what is picked, Alt and an arrow resize it with its top-left corner staying put, and Shift makes either ten times as big. In Screen Reader Mode each press says where it is and how big ("Left 20, top 40, 120 by 80", `announceBox`).
- **PDF form fields** are real HTML controls over the page (`ui/formLayer.ts`), named by the field's description (`TU`, read in `pdf/src/write/forms.ts`) or else its name. A radio button adds its own choice to the name, and a required field has `aria-required`.

## Spreadsheets

A workbook (xlsx, CSV, TSV) is drawn by the spreadsheet editor (`sheet/view.ts`, `sheet/renderer.ts`) on the same canvas, with its own textareas: `.wm-sheet-input` takes the keys while no cell is being edited, and `.wm-sheet-editor` is a real textarea over the cell being edited. There is no reading layer: a sheet has no reading order to describe, and the cells are reached from the keyboard.

- **Editing a cell** needs no mirror: the cell editor (F2, a double click, or typing) holds the cell's text, so a screen reader echoes typing and reads the caret's moves itself. It is named by its cell ("Editing B2"); the formula bar is a real textarea too.
- **Moving the active cell** (arrows, Tab, Enter, Ctrl+arrows, Page keys, the name box's Go To, Find) is announced once the cell's contents have come from the worker (`SheetEditorView.speak`, at the end of `loadContent`). The words are built in `sheet/a11y.ts`:
  - `cellMessage`: the address and shown value ("blank" for an empty cell), then its formula, the merged range it starts, its note's text (asked of the worker only for a cell in `SheetInfo.notes`), a list validation, a filter button, a PivotTable and a locked cell on a protected sheet. A value or note longer than 300 characters is cut;
  - `rangeMessage`: a range selected ("B2 to D5 selected"), whole columns or rows, the whole sheet, and how many ranges Ctrl+click made;
  - `sheetMessage`: put first when another sheet shows ("Data, sheet 2 of 3");
  - `chartMessage`: a chart picked ("Column chart: Sales, 1 of 2"), by `ChartScene.kind` (the first group's kind, a bar chart that stands up being a column chart) and title.
  `speak` keeps what it last said (`said`: sheet, cell, range), so a reload of the same cell's contents after an edit is not said again. Nothing is built while Screen Reader Mode is off; turning it on says where the selection is. While it is off, the cells' textarea has the same `aria-description` hint as the document's.
- **Keys** (`SheetEditorView.key`):
  - Alt+Down opens a list validation's choices, or the filter card of a filter's header cell (the card puts the keyboard in it, and gives it back to the cells when Escape or a button closes it: `FilterCardRequest.closed`);
  - Shift+F2 opens the active cell's note to read or change;
  - the menu key or Shift+F10 opens the menu a right click would (`keyboardMenu`): the active cell's, with a PivotTable's commands first, or the picked chart's;
  - Mod+Alt+5 picks the next chart over the cells (Excel's Ctrl+Alt+5) and scrolls to it; while one is picked, Tab and Shift+Tab go to the next and previous, Delete removes it, and Escape goes back to the cells (which says the active cell again).
- **F6** (`SheetEditorView.regions`, through `SheetEditor.regions` in `main.ts`'s `focusRegions`): in place of the document, a workbook's parts are the formula bar (its name box), the find bar while it shows, the cells (`.wm-sheet-cells`, a `display: contents` group around the two textareas) and the sheet tabs.
- **Sheet tabs** are a tab list (`role="tablist"` on `.wm-sheet-tablist`) with one Tab stop, on the active sheet's tab. Left, Right, Home and End switch sheets with the keyboard staying on the tabs; Enter or a click goes to the cells; F2 renames; Shift+F10 opens the tab's menu; Escape goes back to the cells.
- **Dialogs and cards** are modal `<dialog>`s or in-document cards from the shared parts (`sheet/dialogParts.ts`), with labelled fields and `role="alert"` messages, and give the keyboard back through `afterCard`. Scenario Manager's list and Solver's constraints use the shared `listBox`. The filter card's values are a group named "Values to show".
- **Forced colours:** `sheetView.draw` gets `forcedColors()` like the document, and `SheetRenderer` hands it to its text, rectangle and overview shaders, and clears the desk in the page colour. Gridlines are drawn mid grey, so they become the text colour rather than vanishing into the page. Charts keep their own colours, as pictures do.

## Books

An EPUB opens read-only, as a book (see `main.ts`, "Reading a book", and `reading.ts`). It is laid out like any document, so the mirror and the reading layer work as they do for one (`pageNodes`: its chapters are headings, its paragraphs paragraphs). What differs:

- **The caret still moves.** The worker refuses edits in a book but not `select` and `move` (`VIEW_COMMANDS`), so the textarea follows the caret as in a document, and Shift with the arrows selects to copy.
- **Keys:** in Screen Reader Mode the arrows move the caret (a screen reader reads by character and line with them) instead of turning pages; Page Down, Page Up, Space and Shift+Space still turn them (`viewKey`).
- **A page turn** (the keys, a swipe, or the reading layer's "Continue reading on page n") calls `readTurnedPage`: the caret goes to the start of the first line at the top of the view (`worker.textAt` at the page's left edge, then a `quiet` `select`, so the view stays), and the textarea then holds what is read next. `ScreenReaderSupport.pageTurned` says where the reader is as the status bar shows it: "Page 5 of 12, 40% read" in Print layout, "40% read" in Flow (`pageTurnMessage`). It waits for the caret to reach the page (half a second at most) so it is said together with what the caret finds there (a heading's style), and the caret's page is not said a second time.
- **Typing is refused out loud:** text typed, pasted, deleted or a new paragraph in a book goes nowhere (as without the mode), and in Screen Reader Mode `bookRefuses` says "This book can only be read. To change it, make a document from it with File › Convert To.", at most every three seconds (`ScreenReaderSupport.readOnly`). The textarea is never changed by the attempt (`ui/textInput.ts` prevents the browser's own input).
- **Touch:** the tap zones at the sides of a page (`bookTapTurn`) are off in Screen Reader Mode, so VoiceOver's and TalkBack's own taps (a double tap on what they have found lands on the canvas, under the reading layer) reach what is there. Swipes, which a screen reader keeps for itself while it runs, still turn pages for anyone using the mode without one.

## The viewer

The read-only viewer (`viewer/viewer.ts`: the site's page for "Can view" shares and public links, `viewer/share.ts`, and the embeddable `viewer.html`) is a page of its own without the app's menus, but it shares the layout worker, so it uses the same `ScreenReaderSupport` (`reader` in `mount`): the reading layer over its pages, the mirror in its focus textarea (`.wm-viewer-input`) and the announcements.

- **Screen Reader Mode** is the same setting, `golem.screenReader` (`ui/screenReader.ts`). The site's page shares the app's storage, so someone who turned it on in the app has it on here; a host can start it on (`screenReader: true` in the open message, `ViewerOptions.screenReader`); and it is turned on and off here with Mod+Alt+Z or a "Screen Reader Mode" button (`aria-pressed`), the first thing Tab reaches and shown only while it has the keyboard. In a sandboxed frame storage is refused, so the choice lasts while the frame does. It is a setting rather than always on, as in the app, because the reading layer asks the worker for every page that comes into view: nobody else should pay for that. While it is off the textarea carries the same hint as the app's.
- **While it is on**, the canvas is `aria-hidden` (the reading layer, named by the document, stands for it), and in a document with text (not a PDF's own pages, whose worker refuses moves) the arrows, Home and End move a caret (`viewerKey`'s `caret`, `editKey` for which way) that the textarea follows, with Shift selecting; the view follows the caret. Turning the mode on, and the document opening with it on, put the caret at the start of the text at the top of the view (`caretToView`). Typing is refused before it changes the textarea (`beforeinput`). Activating a heading or a piece of the reading layer puts the caret there.
- **Find:** where a match was found is said: with the words around it in Screen Reader Mode ("Found: …", as in the app), else its page ("Found on page 3 of 3", `viewer.foundOnPage`). "No matches" is the find bar's own `role="status"`.
- **Landmarks and names:** the controls are a `role="toolbar"` named "Viewer" (the arrow keys, Home and End move between its buttons, Enter and Space press one, Escape goes back to the document: `toolbarKeys` from `ui/focusRegions.ts`; unlike the app's toolbars its buttons stay in the Tab order, since Tab is not a tab character here), the find bar a `role="search"` named "Find", and the pages a `<main>` named by the document. The zoom button, whose text is only the zoom, is named "Actual Size (now 125%)". The page's `lang` is the viewer's language, and its title the document's name (the embeddable page; the site's page says "(view only)" after it). Names are written again once the viewer's language has loaded (`relabel`).
- **Colours:** Windows contrast themes draw the pages in the system's colours (`renderer.forced = forcedColors()` each frame, redrawn when the setting changes), and the bar takes them from the browser. High Contrast is the app's `golem.theme` read by the site's page (`highContrast` in `share.ts`; it does not load `ui/theme.ts`, which would restyle the page as the app), or `contrast: true` from a host.
- **Size:** `ScreenReaderSupport` and what it needs add about 17 kB minified (6 kB gzipped) to the viewer's chunk. That is under the 20 kB a chunk of its own needs (AGENTS.md), so it is loaded with the viewer; none of its DOM is built until the mode is on.

## How it looks

Tools › Options › Accessibility, and the theme menu:

- **High Contrast** colour scheme (`ui/theme.ts`, `ui.css` `[data-theme='contrast']` and its dark form): black and white with yellow focus rings. Its accent (the title bar's colour) is black in the dark form, so what marks a choice with the accent needs a rule of its own there: the format dialogs' chosen gallery tile and bordered sides use `--wm-hot-border` and `--wm-checked` with a thicker edge (`formatDialogs.css`). Under `forced-colors` they, and Customize Toolbars' picked rows, get a `Highlight` outline, since backgrounds and shadows are dropped.
- **Windows contrast themes** (`forced-colors`): the browser applies them to HTML but not to a canvas.
  - `forcedColors()` (`ui/accessibilityOptions.ts`) reads the system's `Canvas` and `CanvasText` colours through a probe element.
  - The page, text and rectangle shaders (`webgl/program.ts`, `setForcedUniforms`) map light colours to the page colour and everything else to the text colour.
  - It is re-read when the system's setting changes, and the page thumbnails are drawn again.
  - The reading layer keeps its transparent text (`forced-color-adjust: none` on `.wm-reading`): otherwise the theme would give it the system's text colour, over the pages.
  - The plain text view (`textEditor/glRenderer.ts`, `DrawState.forced`) and the page thumbnails use the same colours. `readPage` (`thumbnail.ts`) takes them as an argument, so a saved preview of a page is never drawn in them.
- **Caret:** thin, medium or thick (1, 2 or 3 pixels at 100%). It blinks unless turned off, and by default it does not blink when the system asks for reduced motion (`caretBlinks`).
- **Reduced motion:** transitions use `--wm-ease`, which is 0 then, and the saving pulse stops. The view never animates by itself (Go To, Find and the caret jump there); only a touch drag keeps gliding after the finger, which follows the person's own gesture.
- **Grammar marks** are dashed double lines, so they differ from spelling squiggles by shape and not only by colour (`dashRects`, `webgl/overlayColors.ts`).

## Alt text

Format › Alt Text…, or the picture's right-click menu, opens a small form over the document next to the picture (`ui/altTextPopover.ts`, modelled on `LinkPopover`). It sends the editor command `describePicture`, which sets or clears the drawing's `description` in one undoable step (`editor/src/links.ts`). The description is what the reading layer reads. Word files keep it as `descr`, and Markdown as the image's alt text.

## Tagged PDF export

A PDF made from a document (`formats/pdfExport.ts`) is a tagged PDF, so screen readers and reflowing viewers read it in order and know its headings, lists, tables and pictures.

- **Writing it** (`pdf/src/write/structure.ts`): `StructureTree.mark(page)` hands out marked-content ids, and `PageDrawing.marked(tag, mcid, fn)` wraps what `fn` draws in `BDC`/`EMC`. `PageDrawing.artifact(fn, kind)` wraps page furniture instead. `StructureTree.write` turns the `StructNode` tree into structure elements (an `MCR` for a mark on another page than the element's first), builds the parent tree, gives each annotation (popups aside) an `Annot` element and the page `/Tabs /S`, and sets `MarkInfo`, `Lang` and `DisplayDocTitle` (always: PDF/UA asks for it). Pages are matched by their object (`ref.key`), since the document makes new `PdfPage`s when its page tree changes.
- **What goes where** (`formats/pdfTags.ts`, `DocumentTags`): each paragraph's lines on a page are one marked sequence in its element, made the first time its text is drawn, so the tree is in reading order. Headings are `H1`–`H6` and other paragraphs `P` (`HeadingReader`, as for the reading layer). List items are `LI` > `LBody` in an `L` with `ListNumbering`: a deeper list goes in the item before it, and a numbered list after a bulleted one starts a new `L`. Table cells are `TD`, or `TH` with `Scope /Column` in a header row, in their `TR` and `Table`, nested tables included. A picture is a `Figure` in its paragraph's element, with the picture's description as `Alt` and its box as `BBox`.
- **Artifacts:** headers and footers (with `Subtype /Header` or `/Footer`, by which half of the page they are on), a table header row repeated on a later page (`DocumentTags.repeated`: text of a paragraph that was tagged already), pictures in headers and footers, and all shading, rules, borders and underlines.
- **Title and language:** the PDF's title is the document's, else its first heading's text, else the opening words of its first paragraph (`DocumentTags.fallbackTitle`). Its language is the declared one (`w:lang` in the default run properties), else the one its text is written in (`detectLanguage`, with Chinese, Japanese and Korean told apart by script), else the app's (`documentLanguageTag`).
- **XMP metadata** (`pdf/src/write/metadata.ts`, `setXmpMetadata`): the title, language and tools, which PDF/UA asks for. The PDF declares itself PDF/UA-1 (`pdfuaid:part`) only when it meets it: it has a title, every font is embedded (no standard-14 font was used) and every picture has a description.
- **Checked with** unit tests that read the tree back with the text of each element (`client/test/pdfTags.test.ts`, `pdf/test/structure.test.ts`), the round-trip e2e, and veraPDF: `pdfTags.test.ts` runs `verapdf -f ua1` on an export with headings, lists, a table, a header and a comment where veraPDF is installed (`brew install verapdf`), and skips it elsewhere. Poppler's `pdfinfo -struct-text` prints the tree too.

## Testing

- **Unit tests** (`client/test/a11y.test.ts`): `readableText`, `caretContext` (one paragraph, several, the window), `CaretMirror` with a fake textarea, `selectionMessages`, a book's `pageTurnMessage`, and the worker's context and `a11yPages` answers for a document with a heading, a link, a list and a table. The editor's `describePicture` is tested in `editor/test/editor.test.ts`. The viewer's caret keys and the host's `screenReader` and `contrast` are in `client/test/viewer.test.ts`. `client/test/sheetA11y.test.ts` has a workbook's messages and the charts' kinds.
- **e2e** (`e2e/accessibility/`): turning Screen Reader Mode on, the textarea following the caret, the reading layer's headings, jumps, F6 and the toolbar keys, the shared controls, shapes from the keyboard, dialogs giving the focus back, the dialogs and menus that take more than buttons (`dialog-controls.spec.ts`: tabs and galleries, drop-down lists, list boxes, the keyboard's right-click menu, the command palette, the notes, and the format dialogs' chosen states in High Contrast and forced colours), workbooks (`sheet.spec.ts`: what is said, F6 and the sheet tabs, charts, the filter card), books (`book.spec.ts`: the reading layer, what a page turn says and where it puts the caret, the arrows, refused typing, tap zones), the viewer (`viewer.spec.ts`: landmarks and names, the toolbar's keys, Find's result, its Screen Reader Mode and caret, a host starting it, the reading layer in forced colours), and forced colours (Chromium's `forcedColors` emulation). PDF form field names are in `e2e/pdf/fill.spec.ts`.
- **By hand, before a release that changes this:**

| Screen reader | Where |
| --- | --- |
| NVDA | Chrome and Firefox |
| JAWS | Windows |
| VoiceOver | macOS desktop app and iOS |
| TalkBack | Android |
| Narrator | Windows |

## Not done yet

- **Some tagged PDFs are not PDF/UA.** Text in a standard font (a face with no font file, such as the CJK pages, or a bold or italic that layout fakes) is not embedded, which PDF/UA requires; embedding the regular face and faking the style in the PDF would fix it. A picture with no description is a `Figure` with no `Alt`, for the author to fix with Alt Text. Such a PDF is still tagged, but does not declare PDF/UA. A list's bullet or number is not an `Lbl` of its own, and a paragraph in another language than the document's has no `Lang` of its own. Exported documents still carry no links, so there are no `Link` elements. Drawings exported as PDF (`vector/pdfOut.ts`) are not tagged.
- **Large text files** have no reading layer (the mirror reads them line by line).
- **Books:** a book's pages are announced and read as laid out, so footnotes and the book's own table of contents are read where they fall (its chapters are in the headings list). Reading on with a screen reader's own "say all" stops at the end of the pages built (the reading layer's "Continue reading" button turns the page); it does not turn pages by itself.
- **The viewer:** its PDFs' own pages have the reading layer but no caret, as Find is not available in them yet. Its view-only page has no setting of its own for High Contrast (it follows the app's), and the embeddable page's host decides it.
- **Drawings and pictures:** a shape's only name is its layer name, and shapes cannot be turned from the keyboard.
- **Spreadsheets:** a chart picked from the keyboard cannot be moved or resized from it (only from its menu's commands), and its data is not read out (Select Data shows its ranges). Conditional formatting, data bars, icons and sparklines are not described. In forced colours a cell's own fill becomes the page or text colour by its lightness, so a dark fill shows as a block of text colour, and the selected headers lose their tint. A watched workbook's changes from the session editing it are not announced.

## Risks

- **Input-method composition** breaks if the textarea is rewritten at the wrong moment (`CaretMirror` guards this; test with a real IME after changing it).
- **Shared documents** can flood a screen reader while someone else types. Other people's edits update the mirror without being announced, and only joins and leaves are announced.
- **The desktop shell:** WKWebView handles ARIA slightly differently from Chrome.
- **Mobile:** touch exploration depends on the reading layer lining up with the canvas. `ReadingLayer.position` must follow the camera exactly.
