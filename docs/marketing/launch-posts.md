# Launch posts

Drafts in the founder's voice. Edit freely; the true parts are the strongest. Replace `[LINK]` with `https://golemdocs.com` (add `?ref=hn`, `?ref=reddit` and so on if you want to see sources before analytics exists: it only changes the address, nothing is collected by it).

## Show HN

**Title:** Show HN: Golem Docs, a Word-style editor in the browser for docx, PDF, Markdown and more

**Text:**

I wanted one editor for everything. Obsidian runs my life, but PDFs kept getting in the way, and I was always hunting for a tool to convert or edit one. So I built an editor that opens whatever I throw at it: Word, OpenDocument, PDF, Markdown, HTML, EPUB, CSV, SVG, images, ZIP archives.

How it works: the text is drawn with WebGL from signed-distance-field glyph atlases (MSDF), so zooming stays sharp and a 50 MB log or War and Peace in Page Grid stays fast. Nothing is uploaded when you open, edit, convert or download a file; the account-free version keeps documents in the browser. Editing a PDF changes the text where it sits, and Redact removes the text under the box from the file.

It looks like Word 2003 on purpose: menus and toolbars, no ribbon.

It is free with no account. $5 a month adds sync, sharing and live editing, and an AI assistant (the part that costs me money per request).

Much of the code was written with Claude with me steering. It is still growing, so if a file does not open the way it should, tell me and it goes on the list.

[LINK]

**Be ready for:** "why not LibreOffice/OnlyOffice" (answer: nothing to install, runs on a locked-down machine and a phone), "is it open source" (answer honestly), "how do you make money" (the subscription), "how is PDF editing done" (edits are a list kept next to the PDF and written on download).

## r/ObsidianMD

**Title:** I built a browser editor that imports your vault and also edits the PDFs that keep getting in the way

I live in Obsidian, but I kept needing to edit a PDF or turn a note into a Word file and ended up in a pile of random tools. Golem Docs imports a vault (folder or ZIP), keeps your folders, properties, `[[links]]` and `![[embeds]]`, and writes Markdown back that Obsidian reads again. Your vault is not touched and nothing is uploaded. It also converts notes to Word/HTML/PDF and edits PDFs in place.

Free, no account. Not a replacement for Obsidian, a companion for the file types it does not handle. Honest gaps: callouts, tags and plugin blocks (Dataview) stay as plain text. I would love to hear what breaks in a real vault.

[LINK]/home/obsidian

## r/webdev / r/SideProject

**Title:** I built a Word-style editor that draws its text with WebGL (MSDF), here is what I learned

Short story of the build: the layout engine, the MSDF atlases and why fonts are lazy-loaded in pages (core atlas plus extra pages, CJK on demand), DOCX/PDF handling with no third-party runtime dependencies, and a Cloudflare Worker with Durable Objects for the multiplayer rooms. Link to the app and the clip of War and Peace zooming. Ask a real question at the end (for example "what would you want from a browser PDF editor?") so it is a conversation.

## Product Hunt

**Tagline (60 characters):** One editor for Word, PDF, Markdown and more, in your browser

**Description:** Open, edit and convert Word, PDF, Markdown, HTML, SVG, images and ZIPs in a Word 2003-style editor. Free with no account and nothing uploaded; $5 a month adds sync, sharing, live editing and an AI assistant.

**First comment (from the maker):** the story paragraph from the Show HN post, plus "what file would you like to see open?"

## Short social posts (X, Bluesky, Mastodon, LinkedIn)

1. "Redact a PDF in your browser and the text under the box is actually gone from the file. Nothing uploaded. [video] [LINK]/home/redact-pdf"
2. "I made a Word 2003-style editor that opens docx, PDF, Markdown, SVG and ZIP files. No ribbon. Free. [LINK]"
3. "Obsidian vault in, Word or PDF out, nothing uploaded. [LINK]/home/obsidian"
4. "PDF to Word without uploading your PDF anywhere: [LINK]/home/pdf-to-word"

## Directory listings (AlternativeTo, BetaList and the like)

- **Name:** Golem Docs
- **Short description:** A browser document editor for Word, PDF, Markdown and more. Free, no account, nothing uploaded.
- **Alternative to:** Microsoft Word, Google Docs, Adobe Acrobat (editing), Smallpdf, LibreOffice Writer
- **Tags:** document editor, PDF editor, Markdown, Word, privacy, WebGL, Obsidian
