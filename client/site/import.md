# Import files, folders, and ZIP archives

Bring in what you already have. Golem Docs opens a single file, imports a whole folder with its subfolders, or unpacks a ZIP archive, and puts every document in the same folder it came from. Nothing is uploaded to do it: the files are read in your browser.

## One file, many files, or a whole folder

- **A single file** opens straight away. Choose File ▸ Import, or drop it on the window.
- **Several files** dropped together are imported as a batch, each saved as its own document.
- **A folder** keeps its shape. Choose File ▸ Import Folder, or use the Import folder button on the Documents screen, or drop the folder on the window or the Files sidebar. Every subfolder, however deep, becomes a folder in Golem Docs.

## ZIP archives

Import a ZIP and its documents land in the folders they were in inside the archive. Drop a ZIP next to other files and it gets a folder named after it, so its contents stay together. ZIPs that hold other documents of any supported type work the same way, and one damaged or password-protected file doesn't stop the rest.

To go the other way, File ▸ Download All (ZIP) gives you every saved document as one archive.

## Nothing gets overwritten

- **Folders are reused.** If a folder with the same name already exists, new documents go into it rather than making a second one.
- **Names are kept apart.** A document whose name is already taken in its folder is saved as "Report (2)", "Report (3)", and so on. Existing documents are never replaced.
- **Hidden and system files are left out.** Files and folders whose names start with a dot, and the `__MACOSX` folders a Mac adds to ZIPs, are not your documents and are skipped without comment.
- **Unsupported files are counted.** Files Golem Docs can't open, such as program files and formats it doesn't read, are skipped, and the result tells you how many.

## What gets imported

Any document type Golem Docs [can open](/home/convert): Word, OpenDocument, PDF, Markdown, HTML, EPUB, LaTeX, CSV, plain text and the many text-based files that look like it, and more. Pictures (PNG, JPEG, WebP, GIF, BMP, and SVG) come in as pictures you can [edit](/home/images); GIF, BMP, and SVG are kept as PNG.

## Big imports

A large folder or ZIP shows a progress card with a steady bar and an estimate of the time left. You can cancel at any time: what was already imported stays, and the rest is left out.

## Private by default

Signed out, imported documents are stored in your browser and never leave it. With a subscription they sync with your account like any other document. Either way, importing doesn't need an account.

Coming from Obsidian? See [how to import an Obsidian vault](/home/obsidian).
