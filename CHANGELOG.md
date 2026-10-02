# What’s New in Golem Docs

## 0.6.0 - Unreleased

### Added
- Format as you type: typing `# `, `- `, `1. `, `> `, `[ ] ` at the start of a line makes a heading, list, quote or check box list; `**bold**`, `*italic*`, `` `code` ``, `~~strike~~` and `[text](url)` followed by a space become formatted text; `---` or three backticks then Enter make a line or a code block. Backspace right after takes it back. Turn it off under Tools › Autoformat as You Type.
- Markdown task lists (`- [ ]` and `- [x]`) show a check box in place of the bullet, and are saved back the same way. Click a box to check or uncheck it. Check box lists are on the toolbar and in the Insert menu.
- Each kind of file (Word, Markdown, PDF, HTML, spreadsheet, image and more) has its own small icon before its name on the Documents screen and in the Files Sidebar.
- Reopening a document puts you back where you left off: the same scroll position, zoom and caret, remembered on this computer.
- The Documents screen now opens in the folder of the document you have open, instead of at the top level.
- View › Files Sidebar pulls out a tree of your folders and documents beside the editor, so you can switch documents without the Documents screen. Click a folder to open or close it, and a document to open it; the one you are editing is marked. It stays closed until you choose it, and the choice is remembered.
- Both the Page Sidebar and the Files Sidebar can be resized by dragging their right edge (or with the arrow keys once it is focused; double-click resets it). The page thumbnails grow and shrink with the Page Sidebar. Widths are remembered.
- File › Import (or dropping a file on the window) accepts a ZIP: its documents go in the same folders as in the ZIP, making the folders that are missing and reusing the ones you already have. Nothing is overwritten; a document whose name is taken in its folder gets (2), (3) and so on. Imported from inside a folder on the Documents screen, the ZIP's contents go in that folder.
- Importing a ZIP shows its progress in a card at the bottom right, with a progress bar and a Cancel button. It doesn't block the window, and cancelling keeps what was already imported.
- The Documents screen has an icon-size slider at the top right. The document icons now start smaller, with less space between rows, and the size you choose is remembered. It now covers the whole window, so the menu bar and toolbars are hidden while it is open.
- The action buttons on files and folders in the Documents screen (Share, Move, Rename, Delete, Leave) are now icons; point at one to see its name.
- The Documents screen no longer shows your account name or the Sign in, Sign out and Subscribe buttons; they are in the menus.
- Clip can now organize your files: list your documents and folders, make and rename folders, move documents and folders, and delete them, many at a time in a single step.
- The Edit PDF and Fill In panel has a minimize button (a chevron) that rolls it up to just its drag handle and the button; click it again to open it. It stays the way you left it.
- The AI assistant can now look through all your other documents (the ones in your account, saved in this browser, or shared with you): it can find the ones about a topic, read them, and copy paragraphs from them into the document you are working on, with their headings and lists.
- The AI assistant can now look at pictures. Drop a picture on its bubble, paste one, or use the ＋ button to attach up to four, then ask about it. It can also look at a picture in the document you have open, or one saved in your library (“what is in the second picture?”). Pictures are scaled down before they are sent.
- The browser's Back and Forward buttons now move between the documents you opened and the Documents screen, instead of leaving the app.

### Changed
- Documents on the Documents screen that have no picture yet show the Golem face's page text in place of grey lines.
- Deleting, moving or renaming a document or folder on the Documents screen or in the Files Sidebar shows at once instead of after it is saved; if saving fails, it comes back with the reason.
- Moving or deleting many documents and folders at once is now one request to your account instead of one per item, so it is much faster.
- Opening a document from your account is faster, especially with many files: the server no longer looks the document up over the network on every open, a document starts downloading as soon as you rest the pointer on it, and the lists refresh after it appears instead of before.
- Your list of documents and folders in the account loads much faster: the server keeps a copy of it instead of querying your storage each time, and the document, shared and folder lists are now fetched together.
- Deleting a folder now deletes every file and folder inside it too, and a confirmation dialog lists everything that will be deleted, in a scrollable box. The same dialog now asks before any document or folder is deleted, on the Documents screen and in the Files Sidebar.
- Deleting the document you have open now switches to the Welcome document, instead of leaving the deleted one on screen.
- File › Download All keeps your folders: documents are zipped inside the same folder structure.

### Fixed
- Right-clicking in the Files Sidebar and choosing New folder now leaves the new folder's name ready to type. It used to lose the name box straight away, as the list refreshed.
- Deleting several ticked folders or documents on the Documents screen now deletes them, instead of them coming back a moment later.
- A deleted folder or document no longer flashes back into the Files Sidebar for a moment before disappearing.

## 0.5.1 - 2026-10-01

### Fixed
- Deleting a folder that has no documents in it (only subfolders) no longer fails with "The number of keys in the request must be between 1 and 1000".
- The Files Sidebar now shows your saved folders and documents the moment the app opens, instead of only this browser's files until the account has answered.
- A document name that fits in the menu bar is no longer cut short with “…”.

## 0.5.0 - 2026-10-01

### Added
- View › Status Bar (off until you turn it on) shows a strip under the document with facts about it, which depend on the kind of document: the page and word count of a text document (and how many words are selected), the rows and columns of a CSV or TSV file, the page of a PDF, the size in pixels of a picture, and the zoom. The AI assistant can turn it on and off too.
- The Documents screen's New document, Import and New folder are now buttons in its header, and Esc closes it from anywhere.
- Select several documents and folders on the Documents screen (tick boxes, Ctrl/Cmd-click, Shift-click for a range, or Ctrl/Cmd+A) to move or delete them all at once.
- Folders: organize your documents in nested folders on the Documents screen. Make a folder, rename it, and move documents and folders into it by dragging or with Move…. Deleting a folder keeps what was in it. Folders sync with your account, and a document you start from inside a folder is saved there.
- A folder's icon now shows small thumbnails of the first documents inside it.
- The form and PDF editing tools panel can be dragged by its top edge to move it out of the way.
- Pressing Enter on an empty bullet or numbered item now ends the list instead of adding another empty item.
- Open, edit and save five more formats: Typst (.typ), DocBook (.dbk), JATS journal articles (.nxml), FictionBook e-books (.fb2) and OPML outlines (.opml). DocBook and JATS files saved as plain .xml are recognized too. FictionBook has no lists or code blocks, so on the way out those become paragraphs, and an OPML file opens as a nested list. The AI assistant can convert to them as well.

### Fixed
- Holding Cmd while a flick-scroll coasts into the edge of the document no longer starts zooming.
- Hovering over a toolbar button no longer makes its outline flicker.

## 0.4.0 - 2026-10-01

### Added
- Spell checking now works in German, Spanish, French, Italian, Portuguese and Russian as well as English. Each paragraph is checked in the language it is marked as, or else the one its words are in; text in Chinese, Japanese, Korean or another language without a dictionary isn't checked. Grammar checking is still English only.
- The welcome document no longer shows spelling errors under format names such as OpenDocument and LaTeX, or under key names such as Ctrl and Cmd.
- You can now rename a document: its name is shown in the middle of the menu bar, and clicking it lets you type a new one (Enter to keep it, Esc to cancel). File › Rename does the same. On a narrow window the name is shortened with “…”, or left out when there is no room. The AI assistant can rename the document too.
- View › Page Sidebar (Alt+P) pulls out a column of page thumbnails beside the document, which you can keep open while you edit. It opens by itself when the window is wide enough (not on a phone), until you close it. Click a page to go to it. On a PDF in Edit PDF mode you can also drag pages into a new order and delete them (the × on a page, or the Delete key); undo brings a deleted page back. Thumbnails fill in once the document's fonts and pictures have loaded, instead of staying blank.
- The Cloudflare Billing panel (admins) now lists the previous five months too, each expandable to its charges by service.
- Profile pictures: signing in with Google or GitHub now keeps your picture, shown on the account button, beside your name on your mouse pointer when you edit a document together with others, and next to the people a document is shared with. Microsoft and Apple don't provide one, so those show a plain initial where a picture would go. Sign in again to pick yours up.
- When other people are editing the same document, their pictures now appear beside the document's name in the menu bar (a plain initial for anyone without one, and “…” when there isn't room for them all). Hover them to see who is there.
- The Golem Docs home page is now available in all 11 languages (for example golemdocs.com/home/de). It opens in your language automatically, and there are language links in its footer.

- View › AI Assistant shows or hides the AI assistant (it used to be under Help). Once you hide it with its × button, it stays hidden until you bring it back.
- The AI assistant can merge table cells too.
- The AI assistant can now do nearly everything you can: change fonts, sizes, colors and highlights, set alignment, spacing, bullets and indents, add links, equations, page breaks, tables and columns, set page size, orientation and margins, work with comments and document properties, edit pictures, change the view, download or print, and convert the document to another format (Word, PDF, Markdown and so on). On a PDF it can read pages, highlight and add notes, edit and add text and shapes, change pages and fill in forms.

### Fixed
- Characters that Calibri, Cambria, Arial, Times New Roman, Courier New and Georgia have but the app did not draw (more Latin, Greek and Cyrillic letters, symbols and arrows) now show. They download only for documents that use them.

## 0.3.1 - 2026-10-01

### Changed
- The assistant no longer has a name: it is now just “AI” everywhere, including Help › AI Assistant.

### Fixed
- Subscribing now unlocks syncing, sharing and the AI assistant. Payment notices from Polar were being refused, so a new subscription was never recorded.
- The AI assistant's picture is now even: the left side of the clip no longer sits farther from the ring than the right.

## 0.3.0 - 2026-10-01

### Changed
- The save indicator (a coloured dot, and when the document was last saved) is now its own button, and signing in, your subscription and signing out moved to a new person icon beside it. Signed out, the indicator explains that documents are saved in this browser on this computer only. The offer of a free first month is gone.
- Comments in OpenDocument files now stay on the right text when you edit around them, and show in the comments panel where you can edit them.
- Syncing documents to your account, sharing them and editing together now need a subscription. Golem Docs works fully without one, saving your documents in this browser, and you can still open documents that a subscriber shares with you. If a subscription ends, your documents stay in this browser.
- The website and the welcome document now say clearly that syncing, sharing and the AI assistant need a subscription, and list the price.
- The Terms of Service and Privacy Policy now cover the subscription: what it includes and its limits, that Polar sells and bills it, how the AI assistant handles your text, and what happens when you cancel.

### Added
- Comments now have replies and a Resolve button. Each comment sits beside its text, the open one shows its whole thread and a box to reply in, and there are Previous and Next buttons and a Show resolved switch. Writing or changing a comment happens in the panel instead of a pop-up box.
- Comments are kept in more formats: OpenDocument (.odt), RTF and PDF (as notes) can now be opened and saved with their comments, old Word (.doc) files show their comments when opened, and Markdown (as CriticMarkup), HTML, EPUB and web archives keep them too. Comments carry over when you convert between formats.
- File › Subscribe… takes you to checkout to pay for sync, signing you in first if you are not. Once you subscribe, File › Manage Subscription… opens the page where you change your card, see invoices or cancel. The same buttons are in the panel behind the Saved button at the top right.

### Fixed
- Changing someone's access to a shared document (viewer or editor) now takes effect right away, even if they have it open.
- A new subscription is no longer ended by news that an older one of yours has ended.
- Capitalizing each word with Change Case now works on the words after an emoji.
- In large text files with Windows line endings, a regular-expression search ending in `$` now finds the lines it should.
- A large text file opened after searching another no longer shows the old search's highlights.
- The AI assistant no longer fails partway through a request that reads a lot of a long document, and after saying it is unavailable, it offers the chat box again once it is back.
- Editing together recovers from a patchy connection instead of going offline for good, and on a Wi-Fi network that asks you to log in first you stay signed in.
- Opening a file that can't be read now says so instead of leaving the loading screen up, and new documents are named in your language.
- LaTeX, AsciiDoc, Org, Textile and MediaWiki files keep more of their text when opened and saved: LaTeX comment lines no longer split paragraphs and double hyphens stay hyphens; line breaks in list items and numbered lists that start past 1 are kept; tables without a header row stay without one; and text that only looks like markup (plus signs, "Mr." in a table cell, a line like ":note:") is no longer changed or lost.
- CSV files with an unclosed quote, pictures in web pages given as plain (not base64) data, and emails with damaged attachments now open, and text that starts with "BM" is no longer taken for a bitmap picture.
- PDFs whose drawings repeat themselves over and over (or are built to) no longer freeze the page when opened.
- Redacting PDF text shown in a damaged or missing font now takes that text out of the file instead of only covering it. Since which of its letters are under the black box can't be told, the whole line of that text is removed.
- Password-protected PDFs that keep their contents in compressed object streams, and PDFs with a very large number of objects, now open; damaged or hostile PDFs that expand to huge sizes or nest too deeply are read as far as they go instead of freezing or crashing the page.
- Pasting text and a table into the middle of a line no longer leaves an empty paragraph after the table, and deleting table columns next to merged cells keeps those cells the right width.
- Japanese and Chinese RTF files now show their text instead of garbled characters. Web pages, Markdown, RTF and old Word (.doc) files built to be slow or huge (unfinished tags, unclosed comment marks, deep nesting, damaged sector tables) now open quickly or are refused instead of freezing the page. In Markdown tables, links and pictures whose address has a "|" no longer break the table, and email attachments with a quote in their name keep their whole name.
- OpenDocument (.odt) files with tables that repeat rows and columns huge numbers of times, or deeply nested comments, now open instead of freezing the page; languages written with a script (such as Serbian in Latin letters) keep it when saved as .odt; and .odt files are saved valid even when two paragraphs share an id.
- Word documents saved with pasted control characters, or with new properties added to a file from another app, now open in Word; tabs and line breaks in an edited comment are kept; and damaged or oversized .docx files are refused instead of freezing the page.
- Typing in a comment box, a form field of several lines or the Share and Sign In dialogs no longer also acts on the document behind (Backspace deleting its text, Ctrl+Z undoing it, Enter or Esc finishing a crop or drawing); menus no longer open behind a dialog with Alt or F10; a comment with a damaged date no longer says "Invalid Date"; and the email, large-text and picture format names are translated.
- Deleting the open document from the dashboard no longer brings it back at the next autosave, and a half-written comment no longer carries over into the next document you open.
- With formatting marks shown, the dots for spaces now sit on the right characters next to hidden text and page number fields; changing a table style now updates its tables right away; bold italic Greek symbol variants (such as ϵ and ϖ) in equations are drawn bold italic; and undoing a new table row or cell that starts with a nested table removes the right one.

## 0.2.0 - 2026-09-30

### Added
- Clip, a big black binder clip with a face in the bottom right corner, is an assistant for subscribers. Ask it in the speech bubble to read your document, rewrite or add paragraphs, replace text, change styles, format text or leave comments, and Undo takes its changes back. Help › Clip Assistant shows or hides it.
- A command palette button at the top right lists every command, with the ones you used recently first, and lets you search and run them. Press Ctrl+Shift+P (⌘⇧P on Mac) to open it.
- The welcome document now links to the Golem Docs website.

### Changed
- The first-visit welcome box is gone; the Golem Docs website now introduces the app.

### Fixed
- Bulleted and numbered lists in PDFs now keep the PDF's own spacing between the marker and the text, and how far each item is indented, instead of fixed steps.
- Editing a PDF line that starts with a bullet or number no longer squeezes the space between the marker and the text.
- Fixed the welcome page showing a gray box instead of the Golem Docs icon in Safari, including on iPhone and iPad.
- Flicking the page with one finger on a touch screen now keeps scrolling and slows to a stop, instead of halting the moment you lift your finger.
- The can edit / can view dropdown in the Share dialog now looks like the other dropdown menus in the app.

## 0.1.0 - 2026-09-30

### Added
- golemdocs.com/home is a new home page that shows what Golem Docs does, with pages that explain converting formats, editing PDFs and pictures, Word documents, working together, themes, and large text files.
- The plain Privacy Policy and Terms of Service pages are now at golemdocs.com/home/privacy and golemdocs.com/home/terms, and the old addresses redirect there.
- Help › Golem Docs Website opens the new home page.
- Help › What’s New shows this changelog.
- File › Download All (ZIP) downloads every saved document as one ZIP file.
- The home page now says you can download all your saved documents as one ZIP.

### Changed
- File › Convert To now lists formats under the same group headings, in the same order, as the format box.
- On phones and other narrow screens, documents now open in Normal view instead of Print layout, unless you have chosen a view before.
