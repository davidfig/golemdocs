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
- Find and Replace (a find bar: next/previous, match case, replace one, replace all; the search is in `@word/editor`)

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
- Alignment, Line Spacing, Bullets, Numbering, Indent/Outdent

**Insert**
- Line, Page and Column Break; text

## Still needs work

**Standard toolbar buttons that are disabled today**
- Spelling and Grammar (`dialog: spelling`)
- Format Painter
- Hyperlink (`insertLink`), Table (`insertTable`), Picture (`insertImage`)
- Columns (`dialog: columns`)
- Formatting Marks (`toggleFormattingMarks`)

**File**
- Page Setup, Properties dialogs
- Print is a PDF export: no page range or copies of our own, and it relies on the browser's PDF viewer

**Edit**
- Go To (dialog)
- Find/Replace: no whole-word or regex options, no match count, and it searches body text only (not headers, footers, footnotes)
- Paste Special; Paste doesn't take rich text or images

**View**
- Print/Normal/Web/Outline layouts (only Print is supported)
- Ruler

**Insert**
- Section Breaks (next page, continuous), Page Numbers, Footnote, Bookmark, Text Box
- Horizontal Line, Code Block
- Date and Time

**Format**
- Paragraph, Bullets and Numbering, Borders and Shading, Tabs, Styles dialogs
- Format Painter (see above)

**Table** (all of it)
- Insert rows/columns, delete, merge/split, select table, properties

**Tools**
- Track Changes, Word Count, Options

**Other**
- Copy/Cut/Paste use the plain-text clipboard only
