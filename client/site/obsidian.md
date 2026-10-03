# Import an Obsidian vault

An Obsidian vault is an ordinary folder of Markdown files, and Golem Docs opens those. Import the vault and your notes arrive in the same folders, ready to read and edit, with nothing uploaded and nothing to install.

## Import your vault

1. **Find the vault.** A vault is a normal folder on your computer, the one Obsidian opens. Obsidian keeps it wherever you chose when you made it, and the vault switcher at the bottom left of Obsidian shows where it is. Usually it is in your Documents folder, in a folder named after the vault. On a Mac that is Documents ▸ David's Vault (for a vault named "David's Vault"), or iCloud Drive ▸ Obsidian if you turned on iCloud for it. On Windows it is Documents\David's Vault under your user folder.
2. **Pick one way in.**
   - In Golem Docs, choose File ▸ Import Folder (or the Import folder button on the Documents screen) and choose the vault folder.
   - Or drag the vault folder onto the Golem Docs window or its Files sidebar.
   - Or compress the vault into a ZIP and choose File ▸ Import, or drop the ZIP on the window.
3. **Wait for the progress card.** A big vault takes a moment. The card shows a steady bar and the time left, and you can cancel and keep what has come in.
4. **Open the Files sidebar** (View ▸ Files Sidebar) to see your folders and notes.

Run it again whenever you like. Folders that already exist are reused, and a note whose name is taken is saved as "Note (2)" rather than replacing the one you have.

{{shot}}

## What carries over

- **Your folder structure.** Every folder and subfolder, and every note in its place.
- **The notes themselves.** Headings, lists, task lists, tables, bold and italic, links, code, and math are read and shown formatted.
- **Properties.** The YAML front matter at the top of a note is kept with it and written back when you save or download the note as Markdown.
- **Pictures and PDFs.** Images in the vault (PNG, JPEG, WebP, GIF, BMP, SVG) come in as pictures you can crop and annotate, and PDFs come in as PDFs.
- **Links between notes.** Your `[[Note]]`, `[[Note#Heading]]`, and `[[Note|label]]` links work: each one links to the imported note of that name, found by title the way Obsidian finds it (case and underscores ignored, folders not needed). Ctrl+click a link (Cmd+click on a Mac) to open the note.
- **Writing new links.** In a Markdown note, type `[[Note]]` and a space, and it becomes a link to that note. Saved or downloaded as Markdown, links are written back as `[[ ]]` links, so Obsidian reads them again.
- **Embedded pictures and notes.** `![[map.png]]` shows the picture right there, and `![[map.png|300]]` sets how wide (`|300x200` sets both). `![[Note]]` shows that note's text, set off with a line down its side, and `![[Note#Heading]]` shows only the part under that heading. They are looked up each time you open the note, so they show the other document as it is now. Saved or downloaded as Markdown, an embed is written back as `![[ ]]`, never as a copy of what it shows. Text you type inside an embedded note isn't kept: edit the note it comes from.
- **Names.** A note called `Meeting notes.md` becomes the document "Meeting notes".

## What doesn't

Golem Docs reads Markdown, not all of Obsidian's own extensions, so a few things stay as plain text or are left behind:

- **Some embeds stay links.** Pictures (PNG, JPEG, WebP, GIF, BMP) and notes are shown; an SVG, a PDF, a block (`![[Note#^block]]`), a note whose embed shares its line with other text, and anything not in Golem Docs yet show as a link to it instead. Import the missing file and open the note again.
- **Obsidian callouts, tags, and plugin blocks** (Dataview, for example) are kept as the text in the file, not as special elements.
- **Obsidian's own files are skipped.** The hidden `.obsidian` folder with your settings and plugins, canvases (`.canvas`), and other types Golem Docs can't open are left out, and the import tells you how many files it skipped.

## Keep a copy in both places

Importing copies your notes; your vault is untouched, so you can keep using Obsidian. To take notes back out, open a note and choose File ▸ Download to get it as Markdown, or File ▸ Download All (ZIP) to get everything at once, folders included.

Want more on getting files in? See [importing files, folders, and ZIP archives](/home/import).
