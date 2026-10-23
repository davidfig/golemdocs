# Marketing plan

Goal: get real people to open the app, and learn which message makes them stay. Budget: $0 and a few hours a week. Written 2026-10-08.

## What we have to sell

- **Strong, true hook:** one editor that opens Word, PDF, Markdown, SVG, ZIP and more, in the browser, free, no account, nothing uploaded.
- **A story:** a solo builder who lives in Obsidian and got tired of PDF tools (the home page's "Why I built this"), with most of the code written with Claude.
- **Real differentiators to lead with:** privacy (files never leave the browser), PDF text editing and true redaction, Word 2003 feel, 50 MB text files without freezing, Obsidian vault import.
- **Paid product:** $3 a month for sync, sharing and live editing. Free use is the funnel, so every channel below sells the free tool.

## Who to reach (in order)

1. **Obsidian and Markdown people.** Closest to the founder, easiest to talk to honestly. Hook: import your vault, convert notes to Word and PDF, edit PDFs next to your notes.
2. **People with a one-off PDF/Word chore** (redact a PDF, fill a form, PDF to Word, open a .docx with no Word). They arrive through search and don't want an account. Hook: nothing uploaded.
3. **Privacy-minded and "Word 2003 nostalgia" people** on Hacker News and Reddit. Hook: the ribbon-free editor, the WebGL text renderer.

## Channels

### 1. Search (built, compounding, free)

Each page targets one thing people type into Google. Already live: convert, PDF, pictures, vector, Obsidian, large files. Added in this change: PDF to Word, Markdown to Word, Redact a PDF, Open Word files online. All are in the sitemap with the large share card.

Next pages, one at a time, only for things the app really does: fill in a PDF form, edit an SVG, open an EPUB, open a .eml, view a CSV, open a Jupyter notebook, blur or pixelate part of a screenshot, merge/rearrange PDF pages.

**One-time setup for you (10 minutes, needs your accounts):**
- **Google Search Console is set up** (done). Still to do: add the site to **Bing Webmaster Tools** (it can import from Google Search Console in a minute) and resubmit `https://golemdocs.com/sitemap.xml` in Google, since the sitemap gained four pages. Search Console also shows which queries bring people.
- **No analytics code, on purpose.** "No analytics" is part of the pitch. Use Cloudflare's built-in edge analytics (request counts and top pages from its servers, no script and no cookies) and Search Console. Tag each launch post with `?ref=hn`, `?ref=reddit` and so on to compare channels.

### 2. One launch, done properly

Do the posts in `launch-posts.md` over a single week, answering every comment within the hour. A launch is a handful of conversations, not an ad.

| Day | Where | Why |
| --- | --- | --- |
| Tue | **Show HN** (post about 8-9am US Eastern) | Technical audience, loves the WebGL renderer and the "no upload" angle |
| Tue | **r/ObsidianMD** (check their self-promotion rules first) | Best-fit audience |
| Wed | **r/webdev** or **r/SideProject** | Build story; "Showoff Saturday" style threads are friendlier |
| Thu | **Product Hunt** | Lower intent, but gives a permanent listing and backlinks |
| Fri | **Lobsters** (needs an invite), **Indie Hackers** | Same story, different readers |

Rules: be the founder, say what is rough, never ask for upvotes, never use sockpuppets, and disclose that Claude wrote much of the code (it is already on the home page, and HN rewards it).

### 3. A short demo video (reusable everywhere)

`client/public/home/war-and-peace.webm` already shows the speed. Make 3 clips of 20-30 seconds with `pnpm record:home`-style scripts: (1) drop in a PDF, change a line, download; (2) redact a PDF and show the text can't be copied; (3) import an Obsidian vault. Post them natively on X, Bluesky, Mastodon, LinkedIn and as the Reddit/HN image. Video converts far better than a link.

### 4. Directories and lists (an afternoon, permanent links)

Submit to: AlternativeTo (as an alternative to Microsoft Word, Google Docs, Adobe Acrobat online, Smallpdf), Product Hunt, Hacker News "Show", Indie Hackers, BetaList, awesome-lists for Obsidian and for privacy tools, and `r/selfhosted` only if it can be self-hosted (it cannot, so skip).

### 5. Comparison pages (high intent)

Short, honest pages: "Golem Docs vs Smallpdf", "vs Google Docs", "vs LibreOffice Writer". People searching "X alternative" are ready to try something. Honest means saying what Golem Docs does not do yet.

### 6. Keep people

- The app already saves locally with no account. The only conversion event that matters first is **a second visit**. Without analytics, sign-ups and replies are the proxy.
- Add a gentle "what's new" and the changelog at Help › What's New (already built).
- Ask the first users for the files that did not open correctly. Fixing them gets a reply, a bug report and a believer.

## What we will measure

Weekly, in a note: Cloudflare requests by page and `?ref=` source, Search Console queries and clicks, sign-ups and subscribers (from the database), and what people say when asked how they found it. Decide after four weeks: double down on the channel that brought sign-ups, drop the rest.

## What I did not do

I did not post anywhere, create accounts or submit forms: those are public actions under your name and need your accounts. The drafts are ready in `launch-posts.md`; tell me when you want to go, and I can walk through each submission with you in the browser.
