# Toolbar and file actions: status

What the menus and toolbars can do, and what is still to hook up. Actions are defined in
`client/src/ui/actions.ts`, commands in `ui/commands.ts` / `ui/chrome.ts`, and the app's side is
`client/src/chromeHost.ts` (`SUPPORTED`, `perform`). Unimplemented actions are disabled (shown in
dev builds, where they say "isn't available yet"). Update this list as actions are hooked up.

## Implemented

**File**
- Open (the documents dashboard), New, Import (file picker), Open Sample, Open Recent
- Download (in the document's own format)
- Rename (File ▸ Rename, or click the name centred in the menu bar; also an AI tool, `rename_document`). Not for built-in pages or documents shared by someone else
- Convert To (Word, ODT, HTML, PDF, Markdown, text)
- Print, Print Preview (exports a PDF: Print from a hidden frame, Preview in a new tab)
- Share: a link to a live room (no account needed) and, for cloud documents, sharing with people by email; Sync Now
- Sign In, Sign Out, Clear Local Data

**Edit**
- Undo, Redo, Cut, Copy, Paste (formatted HTML, or plain text for formats without marks), Paste Special (HTML or text, with preview), Select All
- Insert Comment (also a note on a PDF): written and edited in the comments panel (`ui/commentsPanel.ts`), with replies and Resolve. Comments are in the document model (`WordDocument.comments` plus range markers) and carried by DOCX (incl. `commentsExtended`), ODT, RTF, PDF export/import, legacy DOC (read only), Markdown (CriticMarkup) and HTML/EPUB/MHTML; not LaTeX, Org, MediaWiki, AsciiDoc, RST or Textile
- Find, Replace and Go To: one dialog with a tab for each, as in Word 2003 (`ui/findDialog.ts`)
  - Find/Replace: next/previous, match case, replace one, replace all; the search is in `@golemdocs/editor`
  - Go To: Page and Comment, by number or relative (`+3`, `-1`), with Previous and Next

**View**
- Zoom (box, In, Out, Actual Size, Page Width, Whole Page, All Pages)
- Page Sidebar (Alt+P; open by default in a window at least 900px wide until the user chooses): thumbnails of every page left of the document, drawn lazily with the editor's own renderer, the page in view marked. A click goes to the page. For a PDF's pages (in Fill In and Edit PDF alike) they can also be dragged into order and deleted (the same page operations as the Edit PDF palette, as `pdfPageOp`, with `move` to an index). Reflowed documents (Word and the rest) are view-and-navigate only: a page there is only where the layout breaks, so there is nothing sound to delete or reorder. Hidden in Flow view and for large text files
- Formatting Marks (¶ button, Cmd/Ctrl+Shift+8): a ¶ at each paragraph end (also in table cells and headers/footers), a dot for each space, an arrow for each tab and a ¬ for each line break, drawn in the text's font in a blue-gray. Nothing moves; the choice is kept in this browser. Turning it on or off lays the pages out again
- Views, one of three (View menu, or the buttons at the right of the status bar): Print Layout, Flow and Page Grid. Flow (Word's Web Layout) lays the text out to the window's width (and zoom) with slim margins, no headers or footers, one column, and no page edges, and reflows as the window or zoom changes; not for a PDF's own pages or a picture. Print Layout or Flow is kept in this browser. Page Grid (Alt+G, which toggles back to the view before it) lays every page side by side to fill the window, for any document; it lasts until another document opens. There is no Outline or separate Web view
- Fill In Form / Edit Form (PDF)
- Toolbars on/off, Customize Toolbars, themes, Dark Mode, Full Screen, Debug (chrome only)
- Keyboard Shortcuts, About (chrome only)

**Format** (not on a PDF's own pages)
- Format ▸ Paragraph: two tabs like Word 2003. Indents and Spacing (alignment, left/right indent, first line or hanging, space before/after in points, line spacing single/1.5/double/at least/exactly/multiple) and Line and Page Breaks (widow/orphan, keep with next, keep lines together, page break before). Shows what the selected paragraphs share (a blank field where they differ, left as it is); one undo step. Inches, centimetres outside English
- Bold, Italic, Underline, Strikethrough, Superscript, Subscript, Code
- Font, Font Size, Grow/Shrink Font, Font Color, Highlight (also markup on a PDF)
- Change Case, Clear Formatting, Style
- Format Painter: copies the look of the selection (and its paragraph style, alignment, spacing and indent when a whole paragraph is selected), then paints the next selection made with the mouse. One use; Esc cancels. Paints as two undo steps (text, then paragraph)
- Alignment, Line Spacing, Bullets, Numbering, Indent/Outdent
- Columns (Format ▸ Columns… and the toolbar button): a dialog with One/Two/Three presets, number of columns, spacing, a line between, and Apply to (this section, the whole document, or this point forward, which puts a continuous section break at the caret). Text flows down each column and on to the next, then the next page; Column Break (Insert ▸ Break) moves to the next column; autofit tables narrow to the column. Clicking and Up/Down work across columns

**Insert**
- Line, Page and Column Break; text
- Hyperlink (Cmd/Ctrl+K): links the selection (keeping its formatting) or inserts a link, edits the link the caret is in, Remove Link. Cmd/Ctrl+click opens a link in a new tab. Addresses get `https://` or `mailto:` added; only http, https, mailto, tel and ftp are allowed
- Table: the toolbar's grid picker, or Insert ▸ Table… (number of columns and rows). It goes after the paragraph with the caret (splitting it if the caret is mid-text; above it if the caret is at its start), with a paragraph after it where one is needed, and the caret lands in the first cell. Undoes in one step
- Table menu (enabled with the caret in a table): Insert Rows Above/Below and Columns Left/Right (as many as are selected; a column that would push the table past the margins narrows them all), Delete Rows/Columns/Table (deleting every row or column deletes the table), Select Table. Each undoes in one step
- Merge Cells (over the selected cells, growing to whole cells; their text is kept, one cell's paragraphs after another's) and Split Cells (a dialog for the number of columns and rows: a merged cell splits back along its merges, a plain cell makes room by adding grid columns and rows). Done by swapping in a rebuilt table, so each is one undo step
- Tab / Shift+Tab move between cells (selecting each cell's text); Tab in the last cell adds a row. Outside a table Tab types a tab

**Tools**
- Properties (File menu): Summary (Title, Subject, Author, Manager, Company, Category, Keywords, Comments) and Statistics (created, modified, last saved by, and the document's counts). Kept in the document's `docProps` (core and app parts, changed only when edited), undoable, and saved with the document; a new document records when it was created, and one changed since opening records when it was modified
- Page Setup (File menu): margins (top, bottom, left, right, gutter), header and footer distances, orientation, paper size (Letter, Legal, Executive, A3, A4, A5 or custom), and Apply to (this section, the whole document, or this point forward, which starts a new page). Sizes are in inches in English and centimetres in other languages
- Word Count: Pages, Words, Characters (with and without spaces), Paragraphs and Lines, of the selected text if there is a selection (with a note saying so), else of the whole document
- Spelling and Grammar (F7 / the toolbar button): a dialog like Word 2003's that steps through problems from the caret on. Ignore Once / All (Rule, for grammar), Add to Dictionary (kept in this browser), Change, Change All, Check Again, and a Check grammar switch. Drag it by its title bar
  - Spelling: Hunspell dictionaries for English (SCOWL en_US), German, Spanish, French, Italian, Portuguese (Brazil) and Russian (`client/public/dictionaries`, with their licences), read in the layout worker the first time a paragraph in that language is checked. Each paragraph is checked in its own language: the one it declares, else guessed from its words (`client/src/spelling/languages.ts`). Chinese, Japanese and Korean are not checked. Ignores numbers, ALL-CAPS words and addresses
  - Grammar: hand-coded, conservative rules (`client/src/spelling/grammar.ts`): repeated words, a/an, sentence and pronoun "I" capitals, extra spaces, and common mix-ups (should of, your/you're, its/it's, their/there, then/than, subject–verb)

## Still needs work

**Standard toolbar buttons that are disabled today**
- Picture (`insertImage`)

**File**
- Print is a PDF export: no page range or copies of our own, and it relies on the browser's PDF viewer

**Edit**
- Go To: only Page and Comment. Word's Section, Line, Bookmark, Footnote, Table, Graphic and Heading need the editor to know about them. Going to a page scrolls; it doesn't move the caret
- Find/Replace: no whole-word or regex options, no match count, and it searches body text only (not headers, footers, footnotes)
- Paste: only the HTML clipboard form (no RTF, no images); tables pasted into a cell are dropped

**View**
- Formatting Marks: no page-break or section-break line ("Page Break" between dots), no hidden-text or object-anchor marks, and no separate choice per kind (Word's Options ▸ View)
- Flow view: explicit page breaks still start a new piece; headers, footers, columns and page numbers are hidden rather than shown as Word's draft view would
- Ruler

**Insert**
- Hyperlink: a link can't span paragraphs; no "Place in this document" (bookmarks), e-mail or new-document targets; no tooltip or hover cursor
- Section Breaks (next page, continuous), Page Numbers, Footnote, Bookmark, Text Box
- Horizontal Line, Code Block
- Date and Time

**Properties**
- Only Word documents (and the app's own saved copy) carry them: Download as ODT, HTML, Markdown, PDF or RTF leaves them out, and opening those doesn't read theirs
- No General or Contents tabs, no custom properties, and "Last saved by" isn't filled in yet

**Page Setup**
- No Layout tab (vertical alignment, different first page or odd/even headers, line numbers), no mirror margins or book fold, and no printer paper source or custom paper names

**Columns**
- Equal widths only (no Left/Right presets, no different widths or spacing per column)
- No balancing: a two-column section that ends part way down a page (before a continuous section) fills its first column to the bottom first, where Word evens the columns out
- Inserting a table always gives it the full page width; it narrows to fit a column when laid out, but its saved widths stay those of the page
- "Selected text" isn't an Apply to choice; "This point forward" is

**Format**
- Bullets and Numbering, Borders and Shading, Tabs, Styles dialogs
- Paragraph: no outline level, no tab stops button, no preview pane; the four Word "line and page breaks" extras (suppress line numbers, don't hyphenate) are missing
- Format Painter: no double-click to keep it on, and it paints only after a mouse selection (not shift+arrows)

**Table**
- Table Properties (disabled)
- Selecting cells by dragging highlights the text between them, not a rectangle of cells (Merge, and the row/column commands, still use the rectangle)
- Insert and delete rows/columns don't yet adjust vertically merged cells; Merge/Split refuse a table with no column grid or with rows that don't add up to it, and a column can't be inserted in a table that has no column grid
- Insert Table: not inside a table (it does nothing there, without saying why); no AutoFit options or header-row choice

**Tools**
- Track Changes, Options

**Spelling and Grammar**
- Check-as-you-type: red squiggles under misspelled words and green under grammar mistakes on the pages shown (the word being typed is marked once the caret leaves it). Right click a mark for suggestions, Ignore All / Ignore Rule and Add to Dictionary. "Check spelling as you type" and "Check grammar" in the dialog turn it off (kept in this browser). Not there: a status-bar spelling indicator, and marks in a PDF shown as pages
- No UK/CA/AU English variants, and no way to set a document's or selection's language by hand (the release has both); Korean has a dictionary but it is too heavily inflected to read here. Grammar is English only
- Grammar covers a short list of mistakes; it doesn't understand sentence structure (agreement beyond pronouns, tense, commas, passive voice)
- Options (Ignore ALL CAPS words, Ignore addresses, custom dictionary editing) and AutoCorrect aren't there; Word's Undo button isn't either
- Only the body is checked (including tables), not headers, footers or footnotes

**Other**
- Copy/Cut write the plain-text clipboard only, so copying inside the app loses formatting
