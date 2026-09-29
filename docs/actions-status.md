# Toolbar and file actions: status

What the menus and toolbars can do, and what is still to hook up. Actions are defined in
`client/src/ui/actions.ts`, commands in `ui/commands.ts` / `ui/chrome.ts`, and the app's side is
`client/src/chromeHost.ts` (`SUPPORTED`, `perform`). Unimplemented actions are disabled (shown in
dev builds, where they say "isn't available yet"). Update this list as actions are hooked up.

## Implemented

**File**
- Dashboard, New, Open (file picker), Open Sample, Open Recent
- Download (in the document's own format)
- Convert To (Word, ODT, HTML, PDF, Markdown, text)
- Print, Print Preview (exports a PDF: Print from a hidden frame, Preview in a new tab)
- Share, Collaborate, Sync Now
- Sign In, Sign Out, Clear Local Data

**Edit**
- Undo, Redo, Cut, Copy, Paste (plain text), Select All
- Insert Comment (also a note on a PDF)
- Find, Replace and Go To: one dialog with a tab for each, as in Word 2003 (`ui/findDialog.ts`)
  - Find/Replace: next/previous, match case, replace one, replace all; the search is in `@word/editor`
  - Go To: Page and Comment, by number or relative (`+3`, `-1`), with Previous and Next

**View**
- Zoom (box, In, Out, Actual Size, Page Width, Whole Page, All Pages)
- Page Grid
- Fill In Form / Edit Form (PDF)
- Toolbars on/off, Customize Toolbars, themes, Dark Mode, Full Screen, Debug (chrome only)
- Keyboard Shortcuts, About (chrome only)

**Format** (not on a PDF's own pages)
- Bold, Italic, Underline, Strikethrough, Superscript, Subscript, Code
- Font, Font Size, Grow/Shrink Font, Font Color, Highlight (also markup on a PDF)
- Change Case, Clear Formatting, Style
- Format Painter: copies the look of the selection (and its paragraph style, alignment, spacing and indent when a whole paragraph is selected), then paints the next selection made with the mouse. One use; Esc cancels. Paints as two undo steps (text, then paragraph)
- Alignment, Line Spacing, Bullets, Numbering, Indent/Outdent

**Insert**
- Line, Page and Column Break; text
- Hyperlink (Cmd/Ctrl+K): links the selection (keeping its formatting) or inserts a link, edits the link the caret is in, Remove Link. Cmd/Ctrl+click opens a link in a new tab. Addresses get `https://` or `mailto:` added; only http, https, mailto, tel and ftp are allowed

**Tools**
- Spelling and Grammar (F7 / the toolbar button): a dialog like Word 2003's that steps through problems from the caret on. Ignore Once / All (Rule, for grammar), Add to Dictionary (kept in this browser), Change, Change All, Check Again, and a Check grammar switch. Drag it by its title bar
  - Spelling: the SCOWL en_US dictionary (`client/public/dictionaries`, with its licence), expanded in the layout worker on first use. Ignores numbers, ALL-CAPS words and addresses
  - Grammar: hand-coded, conservative rules (`client/src/spelling/grammar.ts`): repeated words, a/an, sentence and pronoun "I" capitals, extra spaces, and common mix-ups (should of, your/you're, its/it's, their/there, then/than, subject–verb)

## Still needs work

**Standard toolbar buttons that are disabled today**
- Table (`insertTable`), Picture (`insertImage`)
- Columns (`dialog: columns`)
- Formatting Marks (`toggleFormattingMarks`)

**File**
- Page Setup, Properties dialogs
- Print is a PDF export: no page range or copies of our own, and it relies on the browser's PDF viewer

**Edit**
- Go To: only Page and Comment. Word's Section, Line, Bookmark, Footnote, Table, Graphic and Heading need the editor to know about them. Going to a page scrolls; it doesn't move the caret
- Find/Replace: no whole-word or regex options, no match count, and it searches body text only (not headers, footers, footnotes)
- Paste Special; Paste doesn't take rich text or images

**View**
- Print/Normal/Web/Outline layouts (only Print is supported)
- Ruler

**Insert**
- Hyperlink: a link can't span paragraphs; no "Place in this document" (bookmarks), e-mail or new-document targets; no tooltip or hover cursor
- Section Breaks (next page, continuous), Page Numbers, Footnote, Bookmark, Text Box
- Horizontal Line, Code Block
- Date and Time

**Format**
- Paragraph, Bullets and Numbering, Borders and Shading, Tabs, Styles dialogs
- Format Painter: no double-click to keep it on, and it paints only after a mouse selection (not shift+arrows)

**Table** (all of it)
- Insert rows/columns, delete, merge/split, select table, properties

**Tools**
- Track Changes, Word Count, Options

**Spelling and Grammar**
- No check-as-you-type (red and green underlines in the document) and no Spelling toolbar state; the check is only by the dialog
- English (U.S.) only: no other dictionaries, no language per paragraph, no UK/CA/AU variants (the release has them)
- Grammar covers a short list of mistakes; it doesn't understand sentence structure (agreement beyond pronouns, tense, commas, passive voice)
- Options (Ignore ALL CAPS words, Ignore addresses, custom dictionary editing) and AutoCorrect aren't there; Word's Undo button isn't either
- Only the body is checked (including tables), not headers, footers or footnotes

**Other**
- Copy/Cut/Paste use the plain-text clipboard only
