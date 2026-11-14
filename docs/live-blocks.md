# Plan: live blocks

**Status (2026-11-11).** M1 is built on the `live-blocks` branch, except the M0 measurements, which need Word,
LibreOffice, Obsidian and the real web views. Done in M1: the block in the model and in Word, ODT, Markdown and HTML; the
spreadsheet, CSV, picture and drawing producers; the vault graph and rules 1 to 3; Copy as Live Link; read-only blocks in
the editor and their label (Update Now, Open Source); errors on the block's card and in the status bar (not drawn on the
page); cycles; the warning on Convert To a format that holds results only; the out-of-date-on-open log (anonymous daily
totals until April 2027, `server/src/liveChecks.ts`); the public link's note in File › Share. M2 so far: text documents as
sources (sections, bookmarks, tables by title) and front matter fields, with Copy as Live Link in documents; charts as
pictures; spreadsheets as hosts (a range under a hidden defined name whose comment holds the tag, rather than custom
properties: one place, which Excel keeps and shows in its Name Manager); references to other workbooks refreshed through
the graph; PDF form fields as sources and hosts (the tag kept with the document's fields, and written on the field's
widget in the PDF itself, `/GolemLive`, so a field stays live after another app saves the file). A PDF page as a picture (`#page:N`): the page drawn as a drawing scene from its own shapes,
pictures and font outlines (`formats/pdfPageScene.ts`), so it is an SVG with a PNG, like a chart, made in the live worker
with no viewer. Live text boxes and pictures in Edit PDF: a live link pasted into a PDF adds one (a picture for a picture,
chart or page source, else a text box), kept as an edit with a tag (`PdfEdit.live`); a text box can be moved but not
typed in. Built-in blocks: a folder list, a count and a timeline (§7), with
Insert › Live Block, and a table of any source filtered, sorted and cut down by options after `?`. M3 so far: drawings as
hosts (`live/drawingHost.ts`): a live link pasted into the drawing editor makes a group at the top left, filled at once; a
picture keeps the box it was given and text its place and style. Live PDF exports: File › Live PDF Copy saves a PDF beside
the document, whose stored file names its document (`extensions.pdf.export`, a live tag whose stamp is the document's
stored bytes), and the keeper writes it again from the layout worker's `exportCopy` when the document changes. It has no
annotations or filled-in fields of its own, since they would not fit the next export's pages. Scripts (§8): producers as
block sources, actions by hand (Tools › Run Script), from button blocks (`@run:Scripts/x.ts`, a block showing the action's
name whose card has Run), on `changed` and on `daily`/`weekly` schedules claimed through the account
(`/api/script-claims`), imports between scripts and `result()`, the stripper and linker, the sandbox (an opaque `srcdoc`
frame and a `data:` worker; tested in Chromium for `fetch`, the engine's own `fetch`, XHR, sockets, IndexedDB, cookies,
`parent`, a computed `import()`, the clock, an endless loop, a huge result and reads outside the grant), per-device grants
with Allow Once and Always Allow, Tools › Scripts (in the Tools menu rather than Settings: the app has no Settings window),
the run log, three failures pausing a script, Undo This Run, and `pnpm golem run`. The language and sandbox are the `@golemdocs/script`
package (`script/`), with the API's types for script writers; the vault's side is `client/src/scripts/`. Where it differs
from §8: a document that changed while an action ran is not rebased onto: the action runs once more on what is there
now (without asking again), and fails, writing nothing, if a document changed again; Undo This Run keeps the
before-bytes for as long as the page is open and puts back only files nothing has changed since (otherwise it points to
version history); a producer's failures show on its block but don't pause it; there are no `picture()` results from
scripts. M4 so far: network access for actions (§8, *Permissions and trust*). How it works: [formats](architecture/formats.md#live-blocks).

**Goal.** Parts of a document that are computed from other files in the vault and stay up to date, in every kind of
document Golem Docs edits. A spreadsheet's table in a Markdown note or a Word report, a Word document's table in a
spreadsheet, a total in the middle of a sentence. When a source changes, everything that depends on it is worked out again,
in order, and the dependents' files on disk change with it. Built-in blocks (a folder's notes, word counts, a timeline) and
scripts a person writes come from the same machinery.

It is meant for people who never use ai, and for people who do. Someone writing a novel builds a character list or a
word-count goal out of blocks in the app. Someone who uses Claude or Codex points it at the vault, and the agent reads real
numbers in the note and can add a live block by writing one line.

## Principles

1. **Everything works without ai.** Every block can be made, set up and updated from the app's menus. Ai uses the same
   files (see "AI is done outside the app" in [AGENTS.md](../AGENTS.md)); nothing here calls a model or depends on one.
2. **Code lives outside the document.** A document never carries code that runs. It names where a block comes from (a
   spreadsheet range, a built-in block, a script in the vault) and holds the last result. Sharing a document shares no
   code, which is the opposite of Office macros. A script is a collaborator acting on documents from outside, through the
   same operations a person's typing makes ([Document model](architecture/document-model.md)).
3. **The result is in the file.** A live block writes its last result into the document, so Obsidian, GitHub, Word and ai
   agents all see a normal table. This differs from note embeds on purpose (see *Decisions*).
4. **Updates are deterministic.** The same sources give the same bytes, and a file is written only when its bytes change.
   Any app may update any block at any time; two apps doing it at once agree, or the second writes nothing.
5. **Updates run where the edit happened.** The app that saved a source updates what depends on it, on the device (web,
   desktop or phone). The cloud is a later fallback, not the plan (see *Where updates run*).
6. **Lose nothing.** A block that cannot be updated (source missing, cycle, too large) keeps its last result and says why.
   Other apps' content is left as it was.
7. **No dependencies,** as AGENTS.md.

## 1. What a live block is

Three parts:

- **The source:** what it shows, as a vault address (see §2): `Budget.xlsx#Expenses`, `Report.docx#Costs`,
  `Characters/#table`. Names are preferred over positions because inserting rows or paragraphs does not break them; the
  "Copy as Live Link" command offers a name when the selection has one.
- **The result:** the source's content, converted to what the host document can hold: a table, a run of text, a picture.
- **The stamp:** a short hash of the result, written next to it. A block is rewritten only when its stamp changes, so a
  change to the source that leaves the block's part alone writes nothing (principle 4).

A **producer** reads a source and gives a result in a neutral shape (a table of formatted cells, a value, a picture). Each
producer is a pure function from its inputs (file bytes, settings) to a result, which is what makes principle 4 hold. A
**host** is the document a block sits in; it turns the neutral result into its own content and saves it in its own format.
Any producer works with any host: a new source type works in every document, and a new host shows every source type.

### Who a block belongs to

A block reads its source from the vault of the document it is in. So a block someone else made would fill itself from
whatever file of yours has the same name: a form sent to you tagged `live:Taxes.xlsx#Summary`, filled with your numbers and
ready to send back. To stop that, a tag says who made it (`live:<source> by=<who> stamp=<hash>`), and only a person's own
blocks are updated. Someone else's keeps what it came with, and the app says so (problem `foreign`).

- **`by`** is 24 hex digits: a fresh random salt (8) and an HMAC-SHA256 of it under a secret (16), `live/owner.ts`. Each
  block gets its own salt, so two documents can't be told apart as one person's, and without the secret no one can make a
  `by` that passes as theirs.
- **The secrets** are kept in browser storage (`live/ownerStore.ts`): one per account, made by the server and handed out
  with `/api/live-marker` (`owner`, kept in the user database's `live_owner` table), so every device of the account signs
  and recognizes the same blocks; and one per browser, used when signed out. A device checks a `by` against every secret it
  holds, and signs new blocks with the account's (the browser's when signed out or before the account's has arrived).
- **A tag with no `by`** was typed by hand (a person or an agent writing a note): in a text file (Markdown, HTML, SVG, plain
  text) it counts as the person's and is signed the first time it is written. Word, OpenDocument, workbook and PDF files are
  written only by the app, which always signs, so an unsigned tag in one came from elsewhere and counts as someone else's.
- **Every block made here is signed when it is made:** pasted into a document (the layout worker is told the owner with its
  `liveOwner` command), a sheet's live range (`addLive`'s `by`), a drawing's group (`data-golem-by`), a PDF's text box,
  picture or form field, and a live PDF export. A pasted block that already has someone else's `by` stays theirs.
- **Make It Mine** (on the block's card, and asked once when a document with someone else's blocks is opened) re-signs the
  blocks, all of them or those showing one source, and updates them from this vault (`adopt` in `LiveOptions`).
- Without an owner (tests, `golem run`) every block counts as the person's.

## 2. Sources: what a block can show

| Source | Address | Result |
| --- | --- | --- |
| Spreadsheet (`.xlsx`, `.ods`, `.csv`) | `Budget.xlsx#Expenses` (table), `#Total` (defined name), `#Summary!A1:D10` (range), a single cell | table or value, with the sheet's number formats applied |
| Spreadsheet chart | `Budget.xlsx#chart:Spending` | picture (M2) |
| PDF | `Contract.pdf#page:3`, `Return.pdf#field:Total` | picture of a page, or a form field's value (M2) |
| A whole document, exported | `Report.docx` as the source of `Report.pdf` | the PDF (M3) |
| Drawing or picture (`.svg`, `.png`, `.jpg`, `.webp`) | `Diagram.svg` | picture: an SVG with a PNG beside it, or the image's bytes (M1) |
| Text document (`.docx`, `.odt`, `.md`, ...) | `Report.docx#Costs` (a bookmark, or a heading's section), `Report.docx#table:Costs` (a table by its title) | the blocks there, or a table |
| A note's front matter | `Chapter 3.md#field:status` | value |
| Built-in blocks | a folder list, a count, a timeline (§7) | table or value |
| Scripts | `Scripts/reading-list.ts` (§8) | table, value or blocks |

Addresses follow the wikilink rules (`wikiLinks.ts`), so renaming a source rewrites the addresses that name it. Showing a
section of another document *as it is now* is what note embeds (`![[Note#Heading]]`) already do; a live block copy of one
is for hosts that must carry the text with them (see *Decisions*).

## 3. Hosts: what a block can sit in

Every text format is read into the same model (`WordDocument`, [Formats](architecture/formats.md)), so there a block is
one thing: a content control (a Word "sdt") tagged `live:<source> by=<who> stamp=<hash>` (`by` per §1) holding the result, block-level for a
table or picture and inline for a value. Resolved note embeds are the same kind of node (`embedMarks.ts`). The editor shows
it read-only with a small label naming its source. Each format's writer decides how to keep it:

| Host | How the block is saved | Other apps see |
| --- | --- | --- |
| Word (`.docx`) | the content control, as is | the table or value; Word keeps it but does not update it |
| OpenDocument (`.odt`) | a named section (block) or a text field or span (inline), with the source and stamp in its name or a hidden attribute: M0 settles which survives LibreOffice | the content |
| Markdown | HTML comment markers around the result (§4) | a normal table or value |
| HTML | an element with `data-golem-live`, `data-golem-by` and `data-golem-stamp` attributes | the content |
| Spreadsheet (`.xlsx`, `.ods`) | a range filled from the source, anchored at its top-left cell; the address and stamp in a defined name and the workbook's custom properties (M2). A source that is another workbook uses Excel's own external reference instead (§5) | values in cells |
| Drawing (`.svg`) | a group with `data-golem-live`, `data-golem-by` and `data-golem-stamp` holding the result drawn as text (a line a row) or a picture (an `<image>`); moved and scaled like any group (M3) | the drawing |
| Plain text and the light markup formats (`.txt`, `.rst`, `.org`, ...) | the result only, with a comment marker where the format has comments; where it has none the block is lost on save, and the app says so as for any lossy conversion (`conversionIsLossy`) | the content |
| PDF | an entry in the document's list of edits ([PDF editing](pdf-editing.md)): a form field's value, an added text box (value), an added picture. Tables come later (see *PDFs* below). The vault's `.pdf` has the edits written in, and a field's source and stamp also go on its widget (`/GolemLive`), which other apps keep (M0) | the page as edited |

The neutral result is turned into each host's content by the host, not the producer: a table becomes a Word table, a
Markdown table, cells in a sheet; a value becomes a run or one cell; a picture becomes an inline drawing.

**An update replaces content, not the layout around it.** A picture's update swaps only its bytes: the size, wrapping,
position, crop, alt text and caption set in the host stay. When a picture's proportions change, the width set in the host
is kept and the height follows. A table keeps the host's table style and column widths where the column count is
unchanged. In Markdown, a drawing or picture stays an ordinary embed (`![[Diagram.svg]]`), since the note can point at the
file; a host that must carry the picture inside itself (Word, ODT, a sheet) makes it a live block.

### PDFs

A PDF's edits are a list kept with the document, and `applyEdits` always rebuilds a page from its original content, so the
same list gives the same page: principle 4 already holds. A live block in a PDF is one more edit in that list. When its
source changes, the edit's content is replaced, the pages are applied again, and the vault writes the new `.pdf`
([Desktop](architecture/desktop.md), *What a file is on disk*).

- **Form fields** (Fill In) take their value from a source: a worksheet's totals from `Budget.xlsx`, an address or a date
  from a note's front matter. The most useful PDF block.
- **Text boxes and pictures** added in Edit PDF can be live: a value, a drawing, a chart, another file's page. Position
  stays as placed; a picture keeps its width and top edge, its height following the picture, as in Word. *Built:* a text
  box shows a value, or a table's rows as lines.
- **Tables** have no element in a PDF and cannot push the page down, so a table would be drawn as text and lines in a box
  of fixed size, cut off or shrunk when it grows. Later; until then a table can be shown as a picture of it.
- **Changed on disk.** A `.pdf` changed outside the app becomes a new original and the account's edits are dropped (as for
  any edit today), which would drop its blocks. M0 found that Preview keeps extra keys only on annotations (not
  `/PieceInfo`, marked content or the document info), so a field's source and stamp are written on its widget
  (`/GolemLive`, `pdf/src/write/forms.ts`). A PDF kept as the file alone reads its fields' tags from it
  (`live/pdfFileTags.ts`, looked for only when the bytes name `/GolemLive`): the vault graph still links it, and the next
  update keeps its fields with the document again. A live text box or picture is drawn into the page, so once another app
  has saved the file it is ordinary content there: it keeps what it last showed and stops updating (nothing is lost).
  Keeping those live would mean drawing them as annotations, which nothing asks for yet.

**PDFs as sources:** a page as a picture (`Contract.pdf#page:3`), a form field's value (`Return.pdf#field:Total`), and
the text the reader extracts.

**A PDF that is always another document's export.** `Report.pdf` can be a live export of `Report.docx`: the whole
document is the source, the PDF writer (`pdfExport.ts`) the producer, and it is written again when the report changes.

### Example: a drawing in a Word document

1. In `Report.docx`, Insert ▸ Picture ▸ `Diagram.svg` with "Keep up to date" on (or Copy as Live Link in the drawing editor,
   then paste).
2. The `.docx` holds an ordinary picture, the SVG with its PNG fallback as Word writes them (`svgBlip`, already read and
   written by `@golemdocs/docx`), inside a content control tagged `live:Diagram.svg stamp=…`. Word shows the picture.
3. `Diagram.svg` changes, in the drawing editor or by an agent editing the vault file. The graph finds `Report.docx`; the
   producer gives the SVG and a PNG of it (as `embeds.ts` does for a drawing today); the host swaps the picture's bytes and
   keeps everything else about it. The report's file on disk changes; Word, opened later, shows the new drawing.

## 4. In a Markdown file

```markdown
<!-- golem:live Budget.xlsx#Expenses stamp=3f9a2c1e -->

| Item | Amount |
| --- | ---: |
| Rent | 2,100.00 |
| Food | 640.00 |

<!-- /golem:live -->
```

An inline value: `So far we've spent <!-- golem:live Budget.xlsx#Total stamp=3f9a2c1e -->$4,210<!-- /golem:live -->.`

- The source is inside the comment, not written as `![[...]]`, so Obsidian does not also try to embed the `.xlsx`.
- **Typing `![[Budget.xlsx#Expenses]]` makes one.** When the app saves a note holding an embed whose address only a
  live block can show (a spreadsheet, or a `table:`, `chart:` or `field:` address), it writes it as a live block with its
  result. So a person or an ai agent can add a block by writing the plain embed, and the app fills it in on the next save
  or sync. `![[Note]]` and `![[Note#Heading]]` stay note embeds, as now.
- A range becomes a Markdown table. Its first row is the header (Markdown tables need one); a table's header row is used
  as is. Alignment follows the cells' horizontal alignment. Cells are text only: no colors, fonts or borders in Markdown.
- A marker the app wrote says who made it: `<!-- golem:live Budget.xlsx#Expenses by=… stamp=… -->` (§1). One typed by
  hand has no `by`; in a note it counts as the person's own and is signed on its first update.
- Read into the model, the markers become the content control of §3, so converting the note to Word or ODT keeps the block.
- An edit to the result made outside the app (by hand or by an agent) is replaced at the next update. Writing changes back
  into the spreadsheet is not planned before M4.

## 5. The vault graph

- **Index.** For each document, the live blocks it holds and their sources, collected when a document is saved, synced or
  read, alongside the search index (`docIndex.ts`). From it, the reverse map: source → documents depending on it. Kept on
  the device (IndexedDB in the browser, beside the vault on desktop) and rebuildable from the files, so it is a cache,
  never the truth.
- **Renames** follow, as wikilinks do: renaming `Budget.xlsx` rewrites the sources that name it.
- **Chains.** A workbook's references to another workbook (`[Bank.xlsx]Sheet1!A1`) read the values it keeps in its
  external link parts (`sheet/externals.ts`). They are edges of the graph: the workbook's index lists the other
  workbook's title among its live sources (`workbookIndexed`), so a new bank export makes the keeper refresh the kept
  values (`refreshExternals` in `live/sheetHost.ts`: the cells kept before plus those the formulas read now), recalculate
  and write the budget, which updates the note. A missing workbook is reported and its values stay.
- **Order.** Dependents are updated in topological order, as a batch, so a chain settles in one pass.
- **Cycles.** A note embeds a sheet that reads back from the note: found by the graph, shown in each block on the cycle
  ("this block depends on itself through …"), and those blocks keep their last result.

## 6. Where updates run

Every Golem Docs app is a device: the web app runs the same code in a browser tab as the desktop and phone apps. Every
change to a document comes through one of them, including an ai agent's edit to a vault file, which the desktop app syncs.
So:

An update is written only over the copy it was made from: if the document was saved meanwhile (typing in it, autosaved;
a sync), the update is dropped and made again from that next time, so it never takes back what someone just typed. A
background update leaves the open document deferred, unless this session updates it for a shared room.

1. **The app that saves a source updates its dependents.** It already has the source loaded. To spare autosave (every
   second or two), it waits until editing pauses (about 30 seconds, to be tuned), or until the sheet is closed or the app is
   hidden.
2. **Every app checks on open.** Opening a document compares its blocks' stamps with their sources and updates the stale
   ones.
3. **The desktop app updates after a sync.** When a sync brings in a changed source (edited on the phone or the web), the
   desktop app updates its dependents in the vault, so an agent reading the folder sees current numbers without anyone
   opening the note.

4. **Any of the owner's devices catches up on what changed elsewhere** (*Updates in the background*, below).

### Updates in the background

Rules 1 to 3 miss a change made where no device of the owner's saw it: a person a source is shared with edits it, an agent
writes it, or the phone that saved it closed before its pause ended. The change is in the account, though, and any app
signed in to the owner's account can update what shows it, the web app included. It needs no vault folder: it downloads the
dependent and its sources, updates it, writes it back and lets go of it.

- **A marker per account** (`/api/live-marker`, in the person's own database): the server time up to which every changed
  source's dependents have been updated, by whichever device. An app that starts, or whose library listing changes, takes the
  documents changed since the marker, oldest first, updates what shows each and moves the marker on. Two devices doing the
  same work is harmless (an unchanged result writes nothing), and the marker mostly prevents it. A dependent it writes is a
  changed source at the next look, so chains follow and stop when nothing changes. The first device to start sets the
  marker to now; what changed before is checked when opened, as always.
- **Only the owner's devices.** A person a document is shared with can't see the rest of the owner's vault that its
  blocks read, and can't write the owner's notes that show it. Their save reaches the owner's account like any other
  change, so the owner's next session picks it up. In a document shared with them, a block's card says the owner's devices
  keep it up to date, and offers no Update Now.
- **When the person isn't busy.** One document at a time, each after 5 seconds without a key press or click. The open
  document is left to rules 1 and 2. A quiet status line counts what is left; nothing is said when it ends well.
- **Memory first, iOS above all** (it reloads a web view that grows too large). One dependent in memory at a time; one
  whose size with its sources' is over the device's limit (Tools › Options › Live Blocks: 20 MB on a phone and 100 MB on a
  computer by default, or never) goes on the marker's `deferred` list for a device with room, or waits until it is opened.
  On a phone, nothing runs while the open document is over half the limit.
- **No account sync, no marker:** there is only the one device, and rule 1 covers it.

### Where an update runs

Every update, in the background or not, runs in the **live worker** (`live/liveWorker.ts`, its page side `liveClient.ts`).
A worker does not give iOS more memory: a page and its workers share one process and one limit, which is why the size
limits above stay. What it gives is memory handed back for certain, and a page that never stutters:

- The keeper stays on the page with the vault graph (what shows what, cycles). It hands the worker the document's stored
  bytes, and each source's when the worker asks, moved rather than copied. The worker reads the document, turns its sources
  into results (drawings and charts are drawn on an OffscreenCanvas there), and hands back only the new bytes. Parsed
  documents, several times the size of their bytes, exist only in the worker.
- The worker starts with the first update and ends after 30 seconds with nothing to do, or at once after an update that
  handed it more than 4 MB. Ending a worker gives all its memory back at once; a page's waits for the collector and for every
  reference to let go.
- What must stay on the page is asked of it: a script's result or a button's label (the sandbox is a frame of the page's;
  a script's Markdown result crosses as Word bytes) and a live export's PDF (the layout worker's).
- A browser where the worker can't start, or without an OffscreenCanvas (iOS before 16.4), updates on the page, as before.
  A job taking over 2 minutes fails, and the next check tries again.

**The cloud (M4, only if needed).** M1 logs how often a block was out of date when opened. If it is often, the server does
rule 1 for edits whose app went away. Rough cost from [Cloudflare's prices](https://developers.cloudflare.com/workers/platform/pricing/):
about 50 ms of CPU and one R2 write per update (an estimate, not measured), so a thousand updates are well under a cent.
Limits: a Worker has about 128 MB of memory, so large workbooks update only on devices; scripts never run in the cloud
(running people's code on the server is a security problem first).

**A document open while it updates.** The update is a change to the file like any other, so the rules in
[Desktop](architecture/desktop.md) apply: an open document takes it as an outside edit (`diffDocuments`, `Editor.external`).
If the dependent is open in this app, the update is applied to it directly as an outside edit.

**A document open in a shared room.** Only the owner's devices update its blocks (the others can't see the owner's
vault), and only one of them: the owner's session that joined the room first (the server marks the owner's sessions in the
people list, and the layout worker's room state says whether this one is `liveUpdater`). That session updates from a
snapshot of the room's document (`LayoutClient.snapshot()`, its bytes and the worker's count of changes) and applies the
result as an outside edit, which goes to the room like any other edit. If anyone changed the document after the snapshot,
the worker refuses the result (`typed`) and the update is tried again from a new snapshot, up to 5 times, waiting a little
longer each time. In the background, a document open in a room that this session doesn't update, or that changed
meanwhile, is put on the marker's `deferred` list, so the marker can move on and the document is tried at the next look.

**Public links and embeds.** A document with a public link, or embedded on another site with Copy Embed Code
([Viewer](architecture/viewer.md), *Public links and embedding*), shows its blocks with no extra work: the result is in the
file, and the public page already checks for a newer save every 2 minutes while it is in view. When `Budget.xlsx` changes,
the device that saved it updates the note, the note syncs to the account, and every page showing the note picks it up.
Two things follow:

- **A public page is only as fresh as the last update on a device.** If the sheet changed on a phone that closed before
  updating, visitors see the old result until any of the owner's devices is next open (rule 4). M1's out-of-date log
  counts this case too; if the gap is often long, it is the strongest reason for the cloud fallback.
- **Publishing a block publishes its source's data,** and the marker names the source's path (`Budget.xlsx#Expenses`),
  which a downloaded copy shows. Turning on a public link for a document with live blocks says so and lists their
  sources; so does adding a block to a document that already has one. The viewer shows the block's label without
  Open Source or Update Now.
- **Scripts' blocks show their last result; the page runs no code.** A visitor's browser has no vault, no grant and no
  device of the owner's, so a producer's or an action's output reaches a public page only as the file the owner's device
  wrote. Button blocks are shown disabled.

## 7. Built-in blocks (M2)

More producers, inserted from Insert ▸ Live Block and set up in a dialog, no code:

- **Folder list:** the notes in a folder (and its subfolders), with chosen front matter fields as columns, sorted and
  filtered. A character list, a reading list.
- **Count:** words, notes or rows, of a document, a folder or a table; with an optional goal ("41,200 of 50,000 words").
- **Table from a CSV or sheet with a filter:** "rows of `Meal plan.csv` for this week".
- **Timeline:** dated entries from notes' front matter or a table, in order.

**Addresses** (`live/builtinAddress.ts`): `@list:Characters?columns=role,status&sort=-status&where=status:alive`,
`@count:Novel?of=words&goal=50000` (or `of=notes`), `@timeline:History?date=born&columns=place&order=desc`. The folder is
found as a link's title is: inside the note's own folder first, then from the top. Results depend only on the files, never on
the device's language: headings are the folder's name and the field names, numbers are written `41,200`, and sorting
compares the same way everywhere. A block never lists or counts the note it is in, nor a note that shows that note, so it
cannot feed on itself. In the graph a built-in block depends on every document in its folder (`KeeperDeps.folder`).

**A table with a filter** is any address that gives a table, with options after `?` (`live/tableQuery.ts`):
`Meals.csv?where=Calories>2000;Day!=Sun&sort=-Calories&columns=Day,Meal&limit=5`. Conditions compare as numbers when both
sides are (currency and thousands separators ignored), else as text; columns are named by heading, or by letter in a table
without one. A title never includes the options (`sourceTitle` in docx `search/links.ts`), so the graph and renames see the
file. Filters relative to today ("this week") are left out on purpose: a result must depend only on the files.

The list grows from what people actually track; M0 starts it by asking (a writer, a family, a heavy vault user).

## 8. Scripts (M3)

A script is a TypeScript file in the vault (`Scripts/`) that a person or an ai agent writes. The app runs it in a sandbox
that can see nothing of the app, the vault or the network. The script asks the app for what it needs, and the app hands
back only what the script was allowed. The script returns a result or a list of edits, and the app checks and applies
them itself. Nothing a script does reaches a file except through the app.

### Two kinds

**Producers** give a live block its result (`Scripts/reading-list.ts` as a block's source, §2). A producer reads and
returns; it cannot edit.

```ts
// Scripts/reading-list.ts
export const meta = { name: 'Reading list', reads: ['Books/'] };

export default async function ({ notes, table }) {
  const books = await notes('Books/');
  return table(
    ['Title', 'Author', 'Finished'],
    books
      .filter((n) => n.fields.status === 'read')
      .sort((a, b) => b.fields.finished.localeCompare(a.fields.finished))
      .map((n) => [n.title, n.fields.author, n.fields.finished]),
  );
}
```

**Actions** change documents. They run on a trigger or by hand.

```ts
// Scripts/daily-note.ts
export const meta = { name: 'Daily note', writes: ['Diary/'], trigger: { daily: '06:00' } };

export default async function ({ today, open }) {
  const doc = await open(`Diary/${today.year}/${today.iso}.md`, { create: true });
  if (doc.isEmpty) doc.append(`# ${today.long}\n\n`);
}
```

`open` gives a copy of the document as plain data (the model, as JSON). The package's editing helpers (find a heading,
append to a section, fill a table, set a field) run inside the sandbox and turn changes into operations. Nothing is
written while the script runs. When it ends, the app checks every operation against the script's grant and applies them
together, as one change credited to the script ("by Daily note"). A document that changed while the script ran has the
operations rebased onto it, as in a shared room; if they no longer fit, the run fails and writes nothing. *Built
instead:* the action runs once more on the changed document, and the run fails only if one changes again.

Triggers:

- **By hand:** the command palette, a script's own menu, or a **button block** in a note. A button is a block naming an
  action (the note holds no code, principle 2), and clicking it always asks first ("Run Daily note? It can change files
  in Diary/"), with **Always allow** for that script on this device. Asking for more in `meta` asks again. A button naming
  a script the vault does not have shows as missing and runs nothing.
- **When a file changes** in a folder the script reads (`trigger: { changed: 'Inbox/' }`). Runs in the app that saved the
  file, like rule 1 of §6.
- **On a schedule** (`daily`, `weekly`, a time). A schedule has one source that hands out each run once, as Claude's
  scheduled tasks live in the account rather than on any one computer. The source is the account: each run has an id (the
  script's path and the time it is due), and a device must claim it from the server before running it (a row in D1,
  added only if absent). The first device to claim it runs it and marks it done; every other device skips it. A claim not
  marked done within a time limit (say 15 minutes) is released for another device to take. The server only keeps the
  claims; the script still runs on a device (§6). The desktop app is the one awake on its own, so it usually takes the
  run; a phone or the web takes a missed run when next opened. A vault with no account is on one computer, so that
  computer runs its schedules with no claim.

An action's edits can change files other actions watch. That is allowed, as a chain in the graph, with the same cycle
check as blocks; an action is never triggered by its own edits, and a chain stops after a fixed depth (say 10) with an
error.

### Scripts build on scripts

- **Imports.** A script imports another by relative path (`import { byAuthor } from './lib/books.ts'`), only from
  `Scripts/`: no packages, no URLs. The app links the modules into one program itself (a small module wrapper, so the
  sandbox loads nothing), and imported code runs with the importing script's grant, never its own.
- **Results.** A script can read another producer's result (`await result('Scripts/reading-list.ts')`). It is an edge in
  the graph like any other source.
- **Dependencies are what was read.** The graph records the files and results a run actually asked for, plus the script
  and everything it imports. A change to any of them updates the block or fires the trigger. (Like `INDIRECT` in a sheet,
  dependencies are found by running, not by reading the code.)

### The sandbox

Golem Docs runs in a web view everywhere (the browser, Tauri's WebView on desktop, the phone apps), so one sandbox serves
every platform, with no dependencies:

1. **An iframe with `sandbox="allow-scripts"`** and no `allow-same-origin`. The browser gives it an opaque origin: no
   IndexedDB, cookies, local storage or account, and no access to the app's window. A Web Worker on its own is not enough;
   it shares the app's origin and could read the documents in IndexedDB and call the server as the user.
2. **A Content-Security-Policy** on the iframe's page with `default-src 'none'` and only the script itself allowed: no
   `fetch`, no WebSocket, no images or fonts loaded from anywhere.
3. **The script runs in a worker inside that iframe,** so a loop cannot freeze the page. Its only way out is `postMessage`
   to the app: requests ("read `Books/`"), then a result or a list of operations.
4. **Every request is checked by the app** against the grant. A read outside it fails in the script as an error. The
   script's own code runs in the same worker as the runtime and can post messages itself, so the host (`host.ts`) answers
   nothing and takes no result until the run has been allowed, and takes one `meta` per run (a second could widen it). A
   path with `.`, `..` or empty parts is inside no folder.
5. **Limits.** A time limit (a few seconds for a producer, longer for an action, then the worker is ended; the time a
   person takes to answer the prompt does not count); a size limit on what comes back; requests answered a few at a time
   (`MAX_REQUESTS_IN_FLIGHT`), the rest waiting, and a run that asks for too many at once ended.
6. **Determinism for producers.** Before its module loads, the sandbox removes `Date.now`, `new Date()` without arguments
   (the real `Date` cannot be reached through the prototype chain), formatting a date without one, `performance.now` and
   `timeOrigin`, `crypto.randomUUID`, seeds `Math.random` and `crypto.getRandomValues`, and takes away timers that measure time. A producer that needs the date gets `today` from the app; its block is
   then marked as depending on the date and updated on the first open of each day. Actions get `now` and may use the clock.

**Already proven by the viewer.** The embeddable viewer runs in exactly this kind of frame
([Viewer](architecture/viewer.md), *Running it sandboxed*), tested in Chromium and WebKit: an opaque origin with a strict
policy, and a worker started from a `data:` module (from an opaque origin a worker cannot start from a URL, and a `blob:`
worker fails in Chromium). The script sandbox reuses that code and its e2e spec. M0 adds what the viewer did not check:
the real web views (WKWebView inside Tauri, WebView2, WebKitGTK, Android), and that the frame cannot reach Tauri's IPC
(the desktop app sets no CSP of its own, `tauri.conf.json`).

**Memory has no limit.** A worker cannot be capped; a script that allocates without end can crash the tab or the app. The
risk is accepted for M3: the edit journal ([edit-journal.md](edit-journal.md)) keeps unsaved work through a crash, and a
script that crashes the app is paused on the next start. If that proves not enough, or the sandbox leaks, the fallback is
a JavaScript interpreter compiled to WebAssembly (QuickJS-style): real memory limits and stronger isolation, at the cost
of a dependency (about 500 KB, to be approved) and slower scripts.

**TypeScript** is turned into JavaScript by deleting the types: the subset TypeScript calls erasable, which Node runs as
is. The app writes its own small stripper (types, interfaces, `type` imports, `as`, `satisfies`, generics). Syntax that
generates code (enums, namespaces, parameter properties, decorators) is reported as an error with its line. The package
ships the types for the API, so VS Code and ai agents get completion and checks.

### Permissions and trust

- **A script declares what it needs** in `meta`: folders it reads, folders it writes, its trigger. A producer cannot ask
  to write.
- **The first run asks,** as a phone app does: "Daily note wants to change files in Diary/ every day at 6:00." The answer
  is kept per device (beside the graph), so a script synced from another device asks again. Changing the code does not ask
  again; asking for more in `meta` does. A trigger that fires on a device with no answer yet does not run there; the app
  shows the request the next time it is open, and the scheduled run is left for a device that has a grant.
- **Settings ▸ Scripts** lists every script, its grant, its last runs and errors, and turns any of them off. A script that
  fails three times in a row is paused and says so.
- **Every run is in a log,** with the operations it applied. "Undo this run" applies their inverses, rebased over any
  edits made since, so later work is kept; where they no longer apply, the log offers the files' versions from before the
  run ([history.md](history.md)). The worst a script can do is harm files it was allowed to write, and that can be undone.
- **Where the risk is.** A person's own scripts, or an agent's, add little risk: an agent with folder access can change the
  files anyway. The risk is a script that arrives in someone else's template or folder; the prompt, the folder grants and
  the sandbox are for that one. Documents never carry scripts (principle 2), so opening a shared document runs nothing.
- **No network** in M3. Fetching from the web breaks determinism and opens a way out. If it comes later, it is a grant per
  site, for actions only. *Built (M4):* an action lists sites in `meta.network` (`['api.example.com']`) and calls
  `fetch(url, { method, headers, body })`; the app makes the request itself, https only, to those hosts only, with no
  cookies and no redirects, and hands back the status, headers and text. The prompt names each site, a grant covers only
  the sites it was given, and a producer that asks for the network is refused. In the browser a site must allow requests
  from other pages (CORS).
- **No cloud.** Scripts never run on the server (§6).

### The package and the command line

`@golemdocs/script` (MIT, like the format packages) is the API scripts see (`notes`, `read`, `sheet`, `open`, `result`,
`table`, `value`, `picture`, the editing helpers), its types, and the code that runs inside the sandbox. It is built on
`docx`, `ops` and `layout`, so an edit keeps formatting, which the libraries agents use on `.docx` today do not.

A command-line tool (`golem run Scripts/daily-note.ts`) runs a script in Node against a vault folder. That is not
sandboxed, like any program a person starts in a terminal, and it says so. It is for testing scripts and for agents.

Scripts are for people who write code and for ai agents. No one needs one to use the app, and every built-in block (§7)
works without them.

## 9. The app

- **Copy as Live Link** (Edit menu, and the context menu) wherever a source can be selected: cells or a table in a sheet,
  a table or bookmark in a document, a chart. Pasted into any host, it becomes a live block.
- **Documents:** Insert ▸ Live Block (built-in blocks, M2). A block's label: its source, when it was last updated, Update Now,
  Open Source. A block with an error shows the error over its last result.
- **Stop Updating** turns a block into ordinary content holding what it last showed, for someone who wants to change it
  here rather than in its source. It is on the block's card and in the right-click menu (a long press on a phone) in a
  document, in a cell's menu on a live range of a sheet, in the layers' menu on a drawing's live group, and in a PDF
  form field's menu. It is one edit, so Edit › Undo makes the block live again. In a document, the layout worker works the
  change out on a copy (the block's content control taken away, `unwrapLive`) and applies the difference
  (`Editor.applyOps`), so a room sees it as an ordinary edit; a sheet drops the range's hidden name; a drawing drops the
  group's `data-golem-live` and `data-golem-stamp`.
- Strings through `t()` in every language; dialogs from the shared parts ([UI](architecture/ui.md)).
- **Bundle:** the graph, the model node and each host's marker code are small and static. Producers load lazily: updating a block from a
  sheet uses the sheet engine's chunk and its memory image ([spreadsheets.md](spreadsheets.md) §2), which is what makes
  updating a note from a large workbook affordable. M0 measures it.

## Milestones

- **M0. Decisions and measurements.** Settle the open questions below. Measure: loading a typical and a large workbook from
  its memory image to read one range; how Obsidian, GitHub and VS Code show the comment markers; whether Word keeps a
  content control's table untouched; which ODT form (named section, field, hidden attribute) LibreOffice keeps through
  open and save; the same for a defined name and custom properties in Excel and LibreOffice Calc; whether a block's source
  and stamp kept in a PDF (`/PieceInfo` or marked content) survive Acrobat, Preview and other editors; the viewer's
  sandbox in each real web view, and that it cannot reach Tauri's IPC, storage or the network (§8). Collect the first list of built-in blocks from real users.
- **M1. Spreadsheet, drawing and picture sources in every text document.** The block in the model (and in the viewer,
  so public links and embeds show it, with the warning when a link is turned on), and how each text host saves it: Word,
  ODT, Markdown, HTML, and the result-only fallback with its lossy-conversion warning. The spreadsheet producer (ranges,
  tables, names, single cells), the drawing and picture producer, the vault graph, rules 1 to 3 of *Where updates run*, Copy as Live Link, the read-only
  block in the editor, cycles and errors, the out-of-date-on-open log. Web and desktop; phones as they come.
- **M2. More sources, and sheets as hosts.** Text-document sources (bookmarks, sections, tables by title), front matter
  fields, charts as pictures, spreadsheets as hosts, PDFs as hosts (form fields, text boxes, pictures) and as sources
  (pages, fields), references between workbooks refreshed through the graph, the first
  built-in blocks.
- **M3. Scripts and drawings.** The script package and its sandbox on every platform, producers and actions, imports and
  results between scripts, triggers, button blocks, scheduled runs claimed through the account, permissions, the run log and Undo this run, the TypeScript stripper, the command-line
  tool; drawings as hosts; live PDF exports.
- **M4. Later.** The cloud fallback (if M1's log asks for it), documents shared by others, writing back into the source,
  network access for scripts, shared rooms.

### M0 results so far (2026-11-14)

Test files (made by the app's own writers: a Word, ODT, HTML and Markdown report with a live table and a live value, a
workbook host, and a PDF with a filled field and every candidate place for a tag) are in the vault, in `Golem Docs/Live
Blocks M0 Tests/`, with a checklist for the checks done by hand (Word, Excel, VS Code), and its results.

- **GitHub** (its Markdown API, GitHub-flavored): the `<!-- golem:live … -->` markers are hidden; the table and the
  value show as ordinary content.
- **PDFs through Apple's PDFKit** (what Preview uses to save), opened and saved, with a note added, and with the field
  typed into: PDFKit redraws every page's content and keeps only the keys it knows on the catalog, the pages and the
  document info. It drops `/PieceInfo` (catalog and page), marked content (`/GolemLive <<…>> BDC … EMC`, even around
  something drawn), and extra keys on the catalog, the page and `/Info`. It keeps extra keys on annotations: on a form
  field's widget, and on a hidden annotation (`/F 2`), whether a standard kind (`/Square`) or one of our own. So a block's
  source and stamp go on annotations: a field's on its widget, a text box's or picture's on a hidden annotation over it.
  It also writes each field twice (the page's widget and an identical copy in the form's field list), which our reader
  did not follow, so a form saved in Preview showed no fields. Fixed in `pdf/src/write/forms.ts` (`Entry.stray`).
- **Word** (16.115) and **Excel**, each file edited and saved by Word or Excel: both survive. Word keeps both tags with
  their stamps, the control around the whole table and the lock. Excel keeps the hidden defined name with its comment and
  range, and a source's names. Not seen on screen: how Word shows the controls, and Excel's Name Manager.
- **LibreOffice** (26.8, each file opened and written again through its own filters): ODT keeps both blocks, tags and
  stamps. A `.docx` keeps both tags, but Writer has no content control around a table: it moves the table's tag into the
  first cell, as a plain-text control around the cell's text, which would have made the next update put the whole table
  in that cell. The Word reader puts such a tag back around the table (`docx/src/docx/liveRepair.ts`). Calc keeps the
  hidden defined name of a workbook's live range but drops its comment, where the tag is, so the range stops being live:
  the tag needs a place Calc keeps.
- **The script sandbox in WebKit** (Safari's engine, which the macOS and iOS shells use): every test in
  `e2e/live/scripts.spec.ts` passes, including the escapes. The spec now also tries the shells' bridges
  (`__TAURI_INTERNALS__`, `webkit.messageHandlers`, `ipc://`), blocked in the browser; it has not yet been run inside a
  real shell, which needs a desktop build pointed at a local dev server.
- **Still to do:** a look at VS Code's preview and Obsidian (which need someone at the screen), a place for a workbook's
  tag that Calc keeps (not urgent, since Excel keeps it and nothing is lost), Preview itself (not only PDFKit; Preview stands in for Acrobat, which is not checked), the real desktop
  and iOS shells, and loading a large workbook on a phone.

## Tests

- Unit: for each host, the block's reader and writer (round trip, an edited result, a damaged marker, conversion between
  hosts keeping the block), stamps, the producer's output for each
  kind of source and number format, the graph (order, chains, cycles, renames), determinism (the same sources give the same
  bytes; an unchanged result writes nothing).
- e2e (`e2e/live/`): copy a range as a live link, paste it into a note and into a Word document, change the sheet, see
  both update; a live drawing in a Word document, resized and wrapped there, keeps its size and wrapping when the drawing
  changes; a stale note
  updated on open; a cycle shown in its blocks; a PDF form field filled from a sheet, updated when the sheet changes; a
  script's block updated when a note it read changes; an action run from the palette, then undone.
- Sandbox (unit and e2e): a script that tries IndexedDB, `fetch`, `parent`, cookies, an endless loop, a huge result, a
  read or write outside its grant, and the clock in a producer, each failing as it should.

## Decisions

- **One block for every format.** A block is one node in the model and works in every host; a source is read by one
  producer and shown in every host. Nothing is built for a single format pair.

- **The result is written into the file, unlike note embeds.** A note embed (`![[Note]]`) is never copied into the document
  that embeds it, because the note can be read on its own. A live block's values exist only once computed, and the people and
  agents reading the vault outside Golem Docs need them, so the result is kept in the file. The costs: a source change
  rewrites its dependents (more sync and history), and edits to the result outside the app are overwritten.
- **Code is never stored in a document.** A document names a producer; scripts live in the vault as files of their own.
- **Scripts run in a sandboxed iframe and worker, not an interpreter,** until M0 shows that is not safe enough. No
  dependency; QuickJS-style WebAssembly is the fallback.
- **Scripts can edit (actions) from the first version,** not only produce blocks. Edits go through the app as operations,
  are checked against the grant, and can be undone run by run.
- **Scripts import scripts,** from `Scripts/` only; imported code runs with the importer's grant.
- **TypeScript by deleting types,** with the app's own stripper; no compiler.
- **Button blocks ask before running,** with Always allow per script and device.
- **Each scheduled run is claimed once through the account,** so two devices on one vault never both run it. The server
  keeps claims, not code.
- **Updates run on devices first.** The cloud comes only if the out-of-date log shows it is needed.
- **Documents shared by other people come later** (M4). Until then a block made by someone else is never filled from this
  vault unless the person makes it theirs (§1, *Who a block belongs to*).
- **Everything works without ai.** No feature may need an agent to make or use it.

## Open questions

- **The marker syntax.** HTML comments as above, or something else that Obsidian and GitHub hide. M0 checks how each app
  shows them.
- **How long to wait before updating dependents** (30 seconds is a guess), and whether closing the sheet should update at
  once.
- **Who an update is "by"** in version history and in a room: the person whose app did it, or the block itself.
- **Large workbooks.** If loading a workbook to update one small block is too slow on a phone, should phones leave such
  blocks to the desktop and to the check on open?
- **A public link to one block.** A link or embed for just a block (a chart from `Budget.xlsx` on a blog), not a whole
  document: a new kind of public link that names a source, served by the viewer as a one-block document. Wanted, and when?
- **Interactive embeds.** Code that runs in the visitor's browser (a calculator, a filter on a table) would need scripts
  served with the page and run in the viewer's sandbox, against only the data in the document. Not planned; worth it?
- **History noise.** Should a block's update be kept out of a document's version checkpoints, or counted like any edit?
