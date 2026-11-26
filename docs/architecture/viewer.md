# The embeddable viewer

A read-only viewer for one file, built from the editor's own layout worker and WebGL renderer. It has three hosts: another app that shows documents in it (the mail client satchel.email, for attachments), the site itself, for a document shared view-only, and the app, for a document in the trash. The viewer scrolls, zooms (Ctrl/⌘ + and −, the buttons, a pinch), moves between pages, finds text, and selects and copies. It does nothing else: no storage, rooms, spelling, autocorrect, library, sync or menus. It fetches nothing but its own code and the fonts under the host's `fontBase`. A link that is clicked is handed to the host and never followed.

It opens everything `sourceFromFile` recognises (`client/src/formats/source.ts`): Word (.docx, .doc), OpenDocument, Rich Text, HTML, MHTML, EML, EPUB, Markdown and the other markup formats, CSV/TSV, Jupyter notebooks, pictures, SVG, PDF and plain text. A file of any other kind is reported as an error.

## How it works

```
 host app                         viewer page (viewer.html, src/viewer/host.ts)           layout worker (layoutCore, as in the app)
 --------                         ---------------------------------------------          ----------------------------------------
 <iframe sandbox="allow-scripts">  'golemdocs:ready' ------------------------------->
 postMessage golemdocs:open ---->  mount(document.body, {bytes, name, fontBase})
                                    LayoutClient({ fontBase, startWorker })  -- open {readOnly: true} -->  OpenDocument.viewOnly
                                    AtlasLibrary(gl, fontBase)  <-- fonts/*.webp          fonts/manifest.json, *.json (FontSet)
                                    PageRenderer, SelectionLayer, Camera  <-- layout, selection ---------
 'golemdocs:opened' / 'error' <--
 'golemdocs:link' (a click) <----   worker.linkAt() -> linkForHost()
 'golemdocs:key' (unused key) <--   viewerKey() -> 'host'
```

- **Read-only from the start.** `LayoutClient.openReadOnly` sends `open` with `readOnly: true`. The worker sets `OpenDocument.viewOnly`, which makes its `readOnly` true with no room: every edit, paste, format, undo, check box, picture or PDF markup is refused (the same gate a room's viewer goes through), no room is joined, and no squiggles are drawn, so no dictionary is fetched. Selecting, select-all, find and copy work as in the app. Tested in `client/test/layoutWorker.readOnly.test.ts`.
- **Fonts from the host.** The worker reads where its fonts are from its name, before any message arrives (`layoutWorkerName` / `fontBaseOf` in `layout/protocol.ts`; `loadAppFonts(base)` in `formats/appFonts.ts`). The app's worker keeps its usual name and the site's `/fonts/`.
- **The page** (`src/viewer/viewer.ts`) is the editor's render loop without its chrome: `GpuPage`s from layout updates, `arrangePages` in one column (or as many as fill the window in the page grid), a `Camera` placed as the editor places it (the first page at 100%, or zoomed out to fit its width; a picture fitted whole; the grid fitted whole; Flow from the top), and `PageRenderer.render` on demand. `PageRenderer` takes its desk colour as a function, so the viewer doesn't load the app's colour-scheme module (which reads browser storage).
- **Input.** A hidden textarea holds the focus (`inputmode="none"`, so no on-screen keyboard), for copy and the keys; whatever is typed in it is dropped. A press sends `pointer` commands (a double click a word, a triple a paragraph, a drag extends), a click that didn't move asks `linkAt`, and a link that passes `linkForHost` (http, https, mailto, tel, ftp) goes to `onLink`. Wheel scrolls, Ctrl/⌘ + wheel or a pinch zooms. Copy (and cut, which only copies) puts the selection's text and HTML on the clipboard.
- **Keys, and which are the host's.** `viewerKey` (`protocol.ts`, unit-tested in `viewer.test.ts`) decides each key press, and the handler does what it says. The viewer's own: Ctrl/⌘ + − 0 zoom; Ctrl/⌘ F opens the find bar, F3 or Ctrl/⌘ G finds again (Shift: back), Escape closes the find bar while it is open; Ctrl/⌘ A selects all; ↑ ↓ Page Up/Down Space (Shift+Space back) Home End move through the document, and ← → too, but only when there is room to scroll sideways. That is the camera's own room (`Camera.sideRoom`, the same math as its clamp, over 2 px to allow for rounding; `canScrollSideways` in `protocol.ts`). Sideways the view may run only half the fit-to-width margin past the pages (`SIDE_PADDING_X`, 8 px), so a page opened zoomed to fit a narrow frame (a mail client's reading pane) has none, and ← → go to the host. The browser's: Ctrl/⌘ C X V, Tab, everything typed in the find or page field, Enter and Space on a focused button, an input method's composing, and keys that only modify others. Every other key goes to the host (`onKey`, or the `golemdocs:key` message), so the page around the viewer can act on it while the focus is in the frame: Escape with the find bar closed, letters (Satchel's `f`), ← → over pages that fit, and combinations the viewer doesn't use. Its default isn't stopped.
- **Screen readers.** The viewer uses the app's Screen Reader Mode (`ScreenReaderSupport`, the same setting `golem.screenReader`): the reading layer over the pages, the textarea mirroring a caret the arrows move, and announcements, built only while the mode is on. It is turned on by the setting, a host's `screenReader`, Mod+Alt+Z, or a button that is the first thing Tab reaches. The bar is a named toolbar with arrow keys, the find bar a named search region, the pages a `<main>` named by the document; Find says where it found the text; Windows contrast themes draw the pages in the system's colours. See [Accessibility](accessibility.md#the-viewer).
- **Loading.** While a file opens, the editor's loading screen (`ui/loadingScreen.ts`) covers the document, saying which file and how far along it is (laying out); it goes when the first pages arrive. Its box shows only after a moment, so a quick load just looks like the document arriving. The site's pages show the same screen while they download the file (`downloading` in `page.ts`) and pass `waited` when it was already showing, so the viewer's carries on without a gap. A `reload` keeps the old pages until the new ones come instead.
- **The status bar and the views** (`statusBar`, on for the site's pages, off by default for other hosts so a small pane stays compact). It is the editor's own (`Footer`, `ui/footer.ts`, styled by `.wm-footer` in `ui.css`): the page (a button that goes to the bar's page field, as the editor's opens Go To), the word count and the selection's (`countWords` with `footer`, asked for once the document is open and after the selection settles; a PDF's own pages and pictures have none; a picture shows its size in pixels), the zoom (the editor's list of sizes, `ui/zoomList.ts`), and Print Layout, Flow and Page Grid. Flow sends the worker the width to reflow to (`setReflow`, as the editor's `syncReflow`), draws without page edges (`PageRenderer.flat`) and hides the page buttons, field and count, which mean nothing there; it can't be chosen for a PDF's own pages or a picture. With a status bar the zoom shows there, not in the top bar. The site's pages start in the view the person chose in the editor (`savedViewMode`, `ui/viewMode.ts`, read but never written here), and a page of a folder keeps a view picked there for the next file (`onView`), except the page grid, which is left when another file opens, as in the editor.
- **The bar** is the app's toolbars: groups of buttons (`.wm-toolbar` with `.wm-tbutton`, `.wm-input`, `.wm-find-message`, the `--wm-*` colours), the page buttons, field and count in one, Zoom Out, Zoom In, Find and Full Screen (`fullScreen`) in the next, then Print (`onPrint`) and Download (`onDownload`) when the host asks for them, and anything the host adds at the end (`barEnd`). The icons are the app's own toolbar icons, from `ui/iconKit.ts`: the few the viewer shows are kept there with the kit every icon is drawn with, apart from the rest of `ui/icons.ts` (about 28 kB the viewer would otherwise carry), and `icons.ts` takes them into `ICONS`, so the two can't drift. Its words go through `t('viewer.*')` (with `dialogs.find.*` reused). The UI font is the system's in the viewer other apps host: the app's Atkinson Hyperlegible is a web font of the site's, so that build strips its `@font-face` rules (`noUiFont` in `vite.viewer.config.ts`). The site's own page keeps it (its `site` build doesn't strip it, and `view/index.html` is `wm-app-font`, which `viewer.css` leaves alone).

## The trash: the app's own host

A document in the trash opens read-only in the app (`ui/trashPreview.ts`, see [Version history and the trash](../history.md)): a dialog with a frame of `/view?frame`, the site's viewer page (`share.ts`) in the embeddable viewer's frame mode (`hostViewer` in `src/viewer/host.ts`, which `viewer.html` runs too). It is the same page as the shared view-only one, so the site serves it already and it needs no build of its own; a separate `viewer.html` on the site would cost a redirect (Cloudflare drops `.html`). The frame is the app's own origin and not sandboxed: the app sends it the bytes it read itself (this browser's trash or `GET /api/trash/:id/file`), the site's `/fonts/`, the person's locale, Dark Pages, High Contrast, Screen Reader Mode and view, and the status bar. It reads the viewer's answers with `readFromViewer` (`protocol.ts`, tested in `viewer.test.ts`): it hides its loading line on `opened`, shows an `error`, opens a `link` in a new tab and closes on an `Escape` `key`.

## Shared view-only: the site's own host

A document shared with someone as "Can view" (File › Share; `viewer` in `shares`) opens for them in the viewer, not the editor. `openShared` in `main.ts` sends them to `/view?s=<token>` (replacing the app's page in the history). The token is the share's own random address (`shares.view_token`, see [Server](server.md#sharing)), never the document's id: nothing on the page, in its address or in what the server sends it names the document. That page is `client/view/index.html` and `src/viewer/share.ts`: it reads `/api/view/<token>` for the document's name, fetches `/api/view/<token>/file` with the person's own session (the server answers only the person it was shared with), and calls `mount` with the site's `/fonts/`, the person's own colours (`siteTheme` in `page.ts`, below) and the title "<name> (view only)" for the tab and the pages' region. A link opens in a new tab. Someone signed out is shown the sign-in buttons (`mountSignIn`), which return them to the same address. An unknown token, one that died (unshared, or made an editor, which opens in the app instead) and one that is someone else's all show that the document is no longer shared.

- **Golem Docs' header** (`PageHeader`, `src/viewer/pageHeader.ts`) is the page's banner, in the row the app's menu bar takes, so the page looks like the app and says whose it is. It holds Golem Docs' mark and name (a link to `/home`, or to `/` for someone signed in, as `/api/auth/me` says); the file in the middle (its icon, its name with the extension greyed as in the Files panel, a shared folder's name, and a "View only" pill where the app shows its save state) as the page's `h1`; a note for the person (a `role="status"`, for Download All's progress, a link that goes outside the folder, and Print's outcome); who shared it; and either the signed-in person's picture, back to their documents, or *Try Golem Docs*. Who shared it comes from the server as `owner` (`{ name, picture }`, `sharer` in `server/src/sharing.ts`) on a person's share only: a public link's page names nobody, since it may end up anywhere. On a phone the header keeps the mark, the file and the way in. Every message in place of the whole page (`say` in `page.ts`: a link that no longer works, a folder no longer shared, sign in, a failure) has the header too, and a button to Golem Docs unless it is the sign-in.
- **The person's own colours.** The page shares the app's storage, so it loads the app's `ui/theme.ts`, which puts the person's scheme, light or dark and High Contrast on the root element as in the app, and passes `hostTheme` to `mount`, which keeps them; the pages are dark only with the app's Dark Pages (`siteTheme`).
- **Print.** The bar's Print makes the document a PDF with the viewer's own worker (`Viewer.pdf`, the layout worker's `convert('pdf')`, the same export as the editor's File › Print) and prints it as the app does (`printPdf` in `ui/printPdf.ts`, which `main.ts` uses too): a hidden frame in a browser, the share sheet on a phone or tablet, Preview in the Mac app (`printShown` in `page.ts`). An embedded page has no Print: the browser's dialog would cover someone else's page.
- **Each save, as it goes in.** The page keeps a live line open (`followSaves` in `src/viewer/live.ts`): a WebSocket to `/api/view/<token>/live`, which the server hands to the document's room as a *listener* (see [Collaboration](collaboration.md#sharing-permissions-and-rooms)). The room sends it `saved` for every save of the file: an upload (`roomSaved`, which every `PUT` of the file calls) or the room's own snapshot while people edit together (`CloudFiles.write`). The page then asks for `/api/view/<token>/file` with `If-None-Match` (304 while unchanged, so a check costs no download) and shows the newer file in place (`Viewer.reload`: the old pages stay until the new ones arrive, the view keeps its place and zoom, and the pictures are drawn again from the new file, since a picture keeps its name from one version to the next). While someone edits, the file is saved within seconds (an editor's autosave and upload, about 3 s after an edit, or a shared room's snapshot, about 5 s), so the viewer follows the edits a few seconds behind. The line carries no part of the document, only that it changed, so the viewer needs no room client, remote-edit rendering or handoff, works the same for every room kind, and stays one embeddable component. When the line drops it checks at once (access may have ended) and opens it again after a pause that doubles up to a minute. The page also still checks every 30 s and when the tab is looked at again: that is how it keeps up on a server without rooms (which refuses the line) and how it hears of access that ends without the room being told (the owner's plan ending).
- **Access that ends takes the document away.** The same check decides (`checkOutcome` in `protocol.ts`, tested in `viewer.test.ts`): a 404 (unshared, left from the dashboard, made an editor) or a 403 (the owner's plan ended) destroys the viewer, so its pages, text and worker are gone and not just hidden. The page title goes back to the plain one, the page says the document is no longer shared, and checking stops. A 401 (signed out) does the same but shows the sign-in buttons. Offline, a dropped download or a server error keeps what is shown and tries again on the next check. A tab in the background checks as soon as it is looked at again, so a revoked tab clears when it is seen. The e2e spec covers both the owner removing the person in the Share dialog and the person leaving it from their dashboard, with the open tab and a reload.
- **The server enforces it, not the page.** A viewer share can't save, upload, rename, move, change history, add room pictures, share or delete: see [Server](server.md#sharing). The page never tries; if it did, it would be refused.
- **Built with the site.** The client's `build` runs the viewer config a second time in `site` mode (`vite.viewer.config.ts`), which writes `view/index.html` and its chunks into the site's `dist/` beside the app, without touching the app's chunks or its `build.json`. In development Vite serves it at `/view/`. Its address has no slash after `view` (`/view?s=…`, `/view?p=…`): Cloudflare serves a folder's `index.html` there and redirects `/view/` to it, so a link with the slash costs a redirect; the dev server is handed `/view/` for it (`viewerAddress` in `vite.config.ts`).
- **Who may share view-only** is who may share at all: the owner, while they have sync. The one schema change is the share's viewer address (`shares.view_token`).

## Public links and embedding

A document may also have one **public link** (File › Share, *Public link*): `/view?p=<token>`, the same page, for anyone, signed in or not. The token is `public_links.token` ([Server](server.md#sharing)), random and naming nothing, and the page reads `/api/public/<token>` and `/api/public/<token>/file`, which need no session. What differs from a person's view-only share (`src/viewer/share.ts`):

- **No sign-in.** A 404 (link turned off, reset, the document deleted, or the owner's sync ended: the server doesn't say which) shows that the link no longer works.
- **Download.** The bar has a Download button (`onDownload` in `mount`), for a person's view-only share as for a public link: they can read the document anyway, so withholding it protects nothing. The account keeps the document as a `.wdoc`, so the page keeps a copy of the stored bytes and turns them into the file its name says with `toVaultFile` (the same conversion the desktop vault writes, `desktop/vaultCodec.ts`), in the vault's convert worker, started on the first click (its page-side code is a few kB, so it is part of the page).
- **Embedding.** `/view?p=<token>&embed` is the same page without the header, with the document's name in the bar and, at its end, a small Golem Docs mark that opens the document's own page in a new tab. The Share dialog's Copy Embed Code gives an `<iframe>` of it (`embedCode` in `ui/shareDialog.ts`). The site sends no `X-Frame-Options` or `frame-ancestors`, so any site may frame it. A host that sandboxes the frame must allow `allow-scripts allow-same-origin` (the page reads the API on its own origin), and `allow-downloads` for Download, `allow-popups` for links.
- **Cost.** Every visitor loads the viewer and the fonts the document uses (static files, cached), and the file once, and again after each save it hears of over its live line (a hibernated WebSocket in the document's room, which costs nothing while quiet; a room takes at most `MAX_LISTENERS`, 1000, and past that a page only checks). A public page checks for a newer save every 2 minutes instead of 30 s, and only while it is in view; resetting or turning off the link closes the lines opened through it (`dropPublicListeners`), so their pages find out at once; the server lets browsers keep its answers for a minute, which is also how long a link turned off can still show to someone who already had it open.
- **Live blocks.** The viewer shows a live block's last result, as stored; it computes nothing. The block is brought up to date by the owner's apps (`LiveKeeper`), and the change reaches visitors with the next upload. The Share dialog says so when the document has live blocks from spreadsheets or CSV files (`liveSources` in `ShareTarget`, from `LiveKeeper.tableSources`).

## Shared folders

A folder shared view-only, or by its public link ([Folder sharing](../folder-sharing.md)), opens on the same page: `/view?f=<token>` for a person (`folder_shares.view_token`, read with their session) and `/view?pf=<token>` for anyone (`folder_links.token`). `share.ts` hands both to `folderPage.ts`, which reads `/api/folder-view|folder-public/<token>` for the folder's name and its files as paths inside it (never an id) and `…/file?path=<path>` for a file.

- **One file at a time, each with its own address.** `&path=` names the file shown and `#` a heading in it (`heading` in `mount`, sent to the layout worker as `goToPlace` once the file is laid out). With no path the page shows a README or index at the top, else the first file, and writes the path into the address. A file opened from the tree or a link pushes a history entry, so Back goes back; Ctrl- or Cmd-click opens it in a new tab as any link does.
- **The tree** is the app's Files panel (`.wm-files`, with the rows' look in `ui/fileRows.css`, which the sidebar uses too): headed by the folder's name (an `h2`) with a Close button, holding a `nav` named Files of nested lists: `<details>` for folders (the drawn chevron, `chevronIcon`), links for files (their icons, `fileIcon`), indented as the sidebar indents them, the one shown `aria-current` and highlighted as the sidebar's current row. It is beside the document, or laid over it on a phone (the Files button in the header opens and closes it, with `aria-expanded`). F6 moves between it (with the header) and the document.
- **Links stay inside the folder.** `mount`'s `onDocLink` gets every `doc:` link; the page resolves it against the folder's files alone (`resolveFolderLink` in `folderLinks.ts`, tested in `client/test/folderView.test.ts`), so a link to anything outside it goes nowhere and the header's note says so.
- **Download and Download All** work on both pages (a person's share and the public link): Download saves the file shown, and Download All in the header fetches every file of the tree one at a time (`…/file?path=`), saying how far along it is in the header's note, and saves them as `<folder>.zip` in their folders, each converted by the page's convert worker (`toFile` in `page.ts`) through `storage/archive.ts`, as File › Download All does in the app. A file that went meanwhile is left out; a 401 ends the page as a check would.
- **Checks and the end of access** work as for a document, with the tree read again at each check. A file that left the folder clears on its own; a folder no longer shared clears the whole page.

## API

`mount(el, options) → { destroy() }` (`client/src/viewer/viewer.ts`). It sets the colour scheme on the root element, so it is meant to own its document: the viewer page, or a frame of its own.

| Option | |
| --- | --- |
| `bytes` | The file (`ArrayBuffer`, transferred to the worker and so emptied, or `Uint8Array`, copied). |
| `name` | Its file name; the extension says what it is. |
| `fontBase` | The folder holding `manifest.json`, absolute or relative to the page. |
| `dark` | Dark colours around the pages, and dark pages with light letters (with `hostTheme`, only the pages). |
| `hostTheme` | The host has put the person's colours on the root element (`data-theme`, `data-scheme`): the viewer keeps them instead of choosing from `dark` and `contrast`. |
| `locale` | The language of the viewer's own words (default `en`; the 11 the app has). |
| `onOpened({ name, format, pages })` | The file is open and laid out; `format` is what it was read as (`docx`, `md`, `pdf`...). |
| `onError(message)` | It can't be shown (an unknown kind, a damaged file, no WebGL 2). |
| `onLink(url)` | A link was clicked. |
| `onKey(key)` | A key the viewer has no use for was pressed while it had the focus: `{ key, code, shiftKey, ctrlKey, altKey, metaKey, repeat }`, as `KeyboardEvent` has them (see Keys above). |
| `title` | Shown in the bar before the page buttons, and the name of the pages' region. |
| `barTitle` | Show `title` in the bar (the default); a host whose own header shows the name turns it off. |
| `barEnd` | More controls at the end of the bar. |
| `onDownload()`, `onPrint()` | Show Download and Print in the bar, which call these. |
| `fullScreen` | Show Full Screen in the bar: the app's own (`ui/fullScreen.ts`), with everything but the document hidden (`body.wm-fullscreen` in `viewer.css`: the site's header, the bar, a folder's files, the status bar), the view kept as it is, and Esc to leave. Where the browser refuses (a frame not allowed, the browser pane) or has none (a phone) the page hides its chrome alone and shows a button in the corner to leave. On for the site's pages, embedded ones included (the embed code's frame has `allowfullscreen`). |
| `screenReader` | Screen Reader Mode starts on (otherwise it follows `golem.screenReader`, where the page can read storage). |
| `contrast` | The High Contrast colours around the pages. |
| `statusBar` | The editor's status bar under the document, and the three views (see above). Off unless asked for. |
| `view` | The view to start in: `print` (the default), `flow` or `grid`. |
| `onView(view)` | The person picked another view in the status bar. |
| `waited` | The host already showed a loading screen while it fetched the file: the viewer's shows at once. |

`destroy()` stops the worker, frees the GPU (`WEBGL_lose_context`) and removes what it added. `reload(bytes)` shows a newer version of the same file in place, keeping the view where it was. `pdf()` gives the document as a PDF, as the editor's File › Print makes it.

## The viewer page and its messages

`viewer.html` runs `src/viewer/main.ts`: `mount(document.body, ...)` for each file it is sent, and the callbacks as messages. It reads only messages whose `source` is `window.parent`. It answers with `postMessage(..., '*')`, since a sandboxed frame has no origin of its own to name, so the host checks `event.source === iframe.contentWindow`. The types are in `src/viewer/protocol.ts`.

| Direction | Message |
| --- | --- |
| host → viewer | `{ type: 'golemdocs:open', bytes: ArrayBuffer, name, fontBase?, dark?, locale?, screenReader?, contrast?, statusBar?, view? }` (`view`: `print` or `flow`). Transfer `bytes`. The page's title becomes the file's name. A second `open` replaces the file. `fontBase` defaults to `?fonts=` in the page's address, else `fonts/` beside the page. |
| viewer → host | `{ type: 'golemdocs:ready' }` once loaded; `{ type: 'golemdocs:opened', name, format, pages }`; `{ type: 'golemdocs:error', message }`; `{ type: 'golemdocs:link', url }`; `{ type: 'golemdocs:key', key, code, shiftKey, ctrlKey, altKey, metaKey, repeat }` for a key the viewer has no use for (see Keys above). |

## Building it

`pnpm --filter @golemdocs/client build:viewer` (`client/vite.viewer.config.ts`) writes `client/dist-viewer/`: `viewer.html`, `assets/` and `fonts/`, with relative paths (`base: './'`), so the folder works wherever a host puts it. The app's build (`vite.config.ts`) is unchanged by it, and none of the site's `public/` files are copied. (The site's own copy, the shared-document page, is built by the same config in `site` mode; see above.) The build reuses the app's config, so the layout worker is the same `layoutCore` chunk.

What a session loads (sizes minified; gzip in brackets):

| | |
| --- | --- |
| Page entry `viewer-*.js` | 119 kB (41.5 kB): the renderer, layout client, file kinds, i18n, Screen Reader Mode, the status bar, the bar and its icons |
| `viewer-*.css` | 59.4 kB (12.0 kB): `ui.css` without its web font, and `viewer.css` |
| English words (`index-*.js`, the app's catalog) | 121 kB (28 kB), loaded once by the page and once by the worker; another language adds its own catalog |
| Layout worker `layoutCore-*.js` | 783 kB, the same code as the app's worker |
| Per format, as needed | the app's lazy format chunks: Markdown 36 kB, RTF 33 kB, ODT 90 kB, PDF 84 kB + 190 kB, markup 71 kB... |

The worker includes the app's spelling (about 16 kB of it), collaboration client (about 8 kB) and autocorrect and autoformat (about 11 kB), none of which the viewer runs. Splitting them out was not worth it: each is under the ~20 kB a lazy chunk needs to pay for its request, and every app session needs them at once.

### The font set

`VIEWER_FONTS` in `src/viewer/fonts.ts`: Calibri, Cambria, Arial, Times New Roman and Courier New, their core atlases only (Latin, Greek and Cyrillic), **33.2 MB in 45 files** (atlas `.webp`, layout `.json`, license). Calibri is Word's default and what every font the set lacks falls back to (Aptos is drawn in it); the others cover headings, the other common faces, and monospaced text. A font a document names that isn't in the set is drawn in its stand-in (`FALLBACK_BY_NAME` in `layout/src/fonts/fontSet.ts`: Georgia in Times New Roman, Segoe UI in Arial, JetBrains Mono and Consolas in Courier New), or in Calibri when the stand-in is missing too.

| Family | Size | | Family | Size |
| --- | --- | --- | --- | --- |
| Calibri | 7.1 MB | | Georgia | 4.6 MB |
| Cambria | 2.4 MB | | Segoe UI | 2.1 MB |
| Arial | 7.9 MB | | Comic Sans MS | 1.4 MB |
| Times New Roman | 8.3 MB | | JetBrains Mono | 4.6 MB |
| Courier New | 7.5 MB | | Libertinus Math (equations) | 2.3 MB |

The smallest set that still shows everything is Calibri alone (7.1 MB), with every other font drawn in it. `VIEWER_FONTS=<ids>` changes the set: `extras` adds the chosen families' extra pages (accents and symbols beyond the core atlases; with the default set, 48.0 MB in all), `libertinus-math` the math font (35.5 MB), `cjk` the Chinese, Japanese and Korean pages (another 109 MB), `all` everything (174 MB). Characters a bundled atlas lacks are drawn as missing. The `.ttf` programs are left out (`VIEWER_FONT_FILES=1` adds them, 40.3 MB with the default set): only writing a PDF needs them, and a PDF's own pages draw from the atlases and the fonts the PDF embeds.

## Running it sandboxed

Tested in `e2e/viewer/sandbox.spec.ts`: the built viewer in `<iframe sandbox="allow-scripts">` (no `allow-same-origin`: an opaque origin, so the file's parser can't reach the host's DOM, storage or IPC), with a strict policy on the host and on the viewer, served by a plain static server, in Chromium 153 and WebKit 26.6 (Playwright's; the engine of macOS's WKWebView). In both, the module worker starts, WebGL 2 draws, fonts load, and Word, Markdown, HTML, EPUB and PDF files open; the zoom keys, find and link clicks work; nothing is fetched from elsewhere and nothing it asks for is missing.

What the host must do:

- **Send `Access-Control-Allow-Origin: *`** (or `null`) on every file of the viewer but `viewer.html`. A sandboxed frame's requests come from origin `null`, and its module scripts, stylesheet, worker and fonts are all CORS requests. Without the header nothing loads, in either engine.
- **Name its own origin in the viewer's Content-Security-Policy, not `'self'`.** In a frame with an opaque origin, WebKit matches `'self'` to nothing (Chromium to the frame's address). This works in both, with `ORIGIN` the scheme and host the viewer is served from (for example `tauri://localhost`, or a custom scheme):

  ```
  default-src 'none'; script-src ORIGIN 'wasm-unsafe-eval'; worker-src ORIGIN data:; connect-src ORIGIN; style-src ORIGIN;
  img-src ORIGIN blob: data:; font-src ORIGIN; base-uri 'none'; form-action 'none'
  ```

- **`'wasm-unsafe-eval'`** lets WebAssembly compile (and nothing else; `eval` stays refused). Only HEIC photos need it, where the browser can't decode HEIC itself (Chromium), since libheif decodes them there. Leave it out and HEIC files show an error in such a browser; WebKit decodes them itself.
- **Allow `data:` workers** (`worker-src ... data:`). From an opaque origin no worker can be started from a URL: Chromium refuses ("cannot be accessed from origin 'null'"), WebKit fails without a word. So in a frame whose `origin` is `"null"` the viewer starts its worker from a `data:` module that imports the real one by its address (`startLayoutWorker` in `viewer.ts`). A `blob:` module worker works in WebKit but not in Chromium. The worker gets an opaque origin and the frame's policy; its imports and font fetches are CORS requests like the page's. Outside a sandbox the worker is started from its URL as usual.
- Serve the files with their types (`text/javascript`, `text/css`, `application/json`, `image/webp`).

Found on the way, and fixed: WebKit reads a `Blob`'s `stream()` through a `blob:` address, which a worker with an opaque origin may not load, so every ZIP-based file (Word, ODT, EPUB) failed to inflate there. `@golemdocs/docx`'s inflate and `@golemdocs/pdf`'s Flate encoder now make the stream directly (`bytesStream` in `docx/src/zip/deflate.ts`).

In fact WebKit can't read a `Blob` there at all, by any means: `arrayBuffer()`, `new Response(blob)`, `FileReaderSync`, `stream()` and `createImageBitmap(blob)` all fail in such a worker (the page itself reads them). So the worker takes no path that needs one:

- **Writing a PNG** (a drawing's picture, made in the worker when an SVG or SVGZ opens): `encodeCanvas` (`formats/imageCodec.ts`) reads the canvas's Blob as before, and where it can't, writes the PNG from the canvas's pixels itself (`formats/pngEncode.ts`: zlib through `CompressionStream`, fed by a writer). A JPEG or WebP can't be written there; a HEIC photo, which is kept as a JPEG elsewhere, is kept as a PNG instead (`toPng`).
- **Decoding a picture** (one inside a drawing, a HEIC photo): `decodeImage` tries `createImageBitmap(blob)` and, where it fails, the browser's `ImageDecoder` (WebCodecs), which takes the bytes themselves; then libheif for HEIC.
- Pictures shown on a page (PNG, JPEG, WebP, GIF, BMP, and those in Word, HTML and EPUB) are decoded by the page, where Blobs work, and need neither.

The sandbox spec opens SVG, SVGZ, PNG, JPEG, WebP, GIF, BMP and HEIC files, and Word, HTML and EPUB files with pictures, in both engines, and checks each shows its red. WebKit also logs "Refused to apply a stylesheet" (`style-src`) once in that run, which blocks nothing: its source wasn't found (the viewer sets no inline style, and a run with a single file doesn't show it).

Not checked: the real WKWebView inside Tauri (Playwright's WebKit is the same engine, not the same embedding), and copying to the clipboard from a sandboxed frame (the copy event is a page-level event and needs no permission, but the sandbox spec doesn't read the clipboard back).

## Not done yet

- Find in a PDF's own pages (the worker's PDF view has no search; the find bar says so).
- Selecting text by touch (a finger scrolls, two pinch).
- The page and the worker each load the whole English catalog (121 kB) for a few dozen strings.

## Key files

| File | |
| --- | --- |
| `client/viewer.html`, `client/src/viewer/main.ts` | The viewer page and its messages |
| `client/view/index.html`, `client/src/viewer/share.ts` | The site's page for a document shared view-only (`/view?s=<token>`) or by its public link (`?p=`) |
| `client/src/viewer/folderPage.ts`, `folderLinks.ts`, `page.ts` | A shared folder on that page (`?f=`, `?pf=`): its tree, links between its files (pure; `client/test/folderView.test.ts`), and what the two pages share (messages, colours, Print, Download) |
| `client/src/viewer/pageHeader.ts` | Golem Docs' header over both pages and their messages |
| `client/src/ui/printPdf.ts` | Printing a PDF on each kind of device, for the app's File › Print and the pages' Print |
| `client/src/ui/iconKit.ts`, `fileRows.css` | The icons the bar shows and the kit they are drawn with; the Files panel's rows, for the folder's tree |
| `client/src/viewer/viewer.ts` | `mount`: rendering, input, the bar, the views and status bar, `startLayoutWorker` |
| `client/src/ui/footer.ts`, `loadingScreen.ts`, `zoomList.ts`, `viewMode.ts` | The editor's status bar, loading screen, list of zoom sizes and saved view, which the viewer uses as they are |
| `client/src/viewer/protocol.ts` | Message types, `linkForHost`, zoom steps, page numbers (pure; `client/test/viewer.test.ts`) |
| `client/src/viewer/fonts.ts` | The font set the build bundles (pure; tested there too) |
| `client/src/viewer/viewer.css` | The bar, the view, and the site pages' header and Files panel |
| `client/vite.viewer.config.ts` | The viewer's build |
| `client/src/layout/layoutClient.ts` | `openReadOnly`, `terminate`, the `fontBase` and `startWorker` options |
| `e2e/accessibility/viewer.spec.ts` | Landmarks, names and keys, Find's announcement, Screen Reader Mode and its caret, forced colours |
| `e2e/viewer/viewer.spec.ts`, `e2e/viewer/sandbox.spec.ts` | The viewer page in the dev server; the built viewer sandboxed, in Chromium and WebKit |
| `e2e/collab/share-folder.spec.ts`, `e2e/accessibility/folder-viewer.spec.ts` | A shared folder's public link and a person's share: the tree, links in and out of the folder, Back, the end of access; the tree from the keyboard and F6 |
| `e2e/viewer/status-bar.spec.ts`, `e2e/accessibility/viewer-status-bar.spec.ts` | The site page's status bar, views, zoom list and loading screen; none in another site's frame; the status bar from the keyboard |
| `e2e/collab/share-view-only.spec.ts` | Sharing as Can view, opening it in the viewer under its token (no response names the document), catching up with a save, refused writes, a dead token |

## Related docs

- [Layout](layout.md): the worker and its messages, including `open`'s `readOnly`.
- [Rendering](rendering.md): the renderer, atlases and font pages the viewer reuses.
- [Build and testing](build-and-testing.md): builds, lazy chunks and the e2e specs.
