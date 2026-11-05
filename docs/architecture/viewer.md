# The embeddable viewer

A read-only viewer for one file, built from the editor's own layout worker and WebGL renderer. It has two hosts: another app that shows documents in it (the mail client satchel.email, for attachments), and the site itself, for a document shared view-only. The viewer scrolls, zooms (Ctrl/⌘ + and −, the buttons, a pinch), moves between pages, finds text, and selects and copies. It does nothing else: no storage, rooms, spelling, autocorrect, library, sync or menus. It fetches nothing but its own code and the fonts under the host's `fontBase`. A link that is clicked is handed to the host and never followed.

It opens everything `sourceFromFile` recognises (`client/src/formats/source.ts`): Word (.docx, .doc), OpenDocument, Rich Text, HTML, MHTML, EML, EPUB, Markdown and the other markup formats, CSV/TSV, Jupyter notebooks, pictures, SVG, PDF and plain text. A file of any other kind is reported as an error.

## How it works

```
 host app                         viewer page (viewer.html, src/viewer/main.ts)          layout worker (layoutCore, as in the app)
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
- **The page** (`src/viewer/viewer.ts`) is the editor's render loop without its chrome: `GpuPage`s from layout updates, `arrangePages` in one column, a `Camera` placed as the editor places it (the first page at 100%, or zoomed out to fit its width; a picture fitted whole), and `PageRenderer.render` on demand. `PageRenderer` takes its desk colour as a function, so the viewer doesn't load the app's colour-scheme module (which reads browser storage).
- **Input.** A hidden textarea holds the focus (`inputmode="none"`, so no on-screen keyboard), for copy and the keys; whatever is typed in it is dropped. A press sends `pointer` commands (a double click a word, a triple a paragraph, a drag extends), a click that didn't move asks `linkAt`, and a link that passes `linkForHost` (http, https, mailto, tel, ftp) goes to `onLink`. Wheel scrolls, Ctrl/⌘ + wheel or a pinch zooms. Copy (and cut, which only copies) puts the selection's text and HTML on the clipboard.
- **Keys, and which are the host's.** `viewerKey` (`protocol.ts`, unit-tested in `viewer.test.ts`) decides each key press, and the handler does what it says. The viewer's own: Ctrl/⌘ + − 0 zoom; Ctrl/⌘ F opens the find bar, F3 or Ctrl/⌘ G finds again (Shift: back), Escape closes the find bar while it is open; Ctrl/⌘ A selects all; ↑ ↓ Page Up/Down Space (Shift+Space back) Home End move through the document, and ← → too, but only when there is room to scroll sideways. That is the camera's own room (`Camera.sideRoom`, the same math as its clamp, over 2 px to allow for rounding; `canScrollSideways` in `protocol.ts`). Sideways the view may run only half the fit-to-width margin past the pages (`SIDE_PADDING_X`, 8 px), so a page opened zoomed to fit a narrow frame (a mail client's reading pane) has none, and ← → go to the host. The browser's: Ctrl/⌘ C X V, Tab, everything typed in the find or page field, Enter and Space on a focused button, an input method's composing, and keys that only modify others. Every other key goes to the host (`onKey`, or the `golemdocs:key` message), so the page around the viewer can act on it while the focus is in the frame: Escape with the find bar closed, letters (Satchel's `f`), ← → over pages that fit, and combinations the viewer doesn't use. Its default isn't stopped.
- **The bar** is built from the shared parts (`iconButton` with `.wm-tbutton`, `.wm-input`, `.wm-find-message`, the `--wm-*` colours) and its words go through `t('viewer.*')` (with `dialogs.find.*` reused). The UI font is the system's: the app's Atkinson Hyperlegible is a web font of the site's, so the viewer's build strips its `@font-face` rules (`noUiFont` in `vite.viewer.config.ts`).

## Shared view-only: the site's own host

A document shared with someone as "Can view" (File › Share; `viewer` in `shares`) opens for them in the viewer, not the editor. `openShared` in `main.ts` sends them to `/view?s=<token>` (replacing the app's page in the history). The token is the share's own random address (`shares.view_token`, see [Server](server.md#sharing)), never the document's id: nothing on the page, in its address or in what the server sends it names the document. That page is `client/view/index.html` and `src/viewer/share.ts`: it reads `/api/view/<token>` for the document's name, fetches `/api/view/<token>/file` with the person's own session (the server answers only the person it was shared with), and calls `mount` with the site's `/fonts/`, the system's light or dark appearance, and the title "<name> (view only)" in the bar. A link opens in a new tab. Someone signed out is shown the sign-in buttons (`mountSignIn`), which return them to the same address. An unknown token, one that died (unshared, or made an editor, which opens in the app instead) and one that is someone else's all show that the document is no longer shared.

- **Snapshot, refreshed on save, not live.** The page asks for `/api/view/<token>/file` again every 30 s and when the tab is looked at again, with `If-None-Match`; the server answers 304 while it is unchanged, so a check costs no download. A newer file is shown in place (`Viewer.reload`: the old pages stay until the new ones arrive, and the view keeps its place and zoom). While someone edits, the file is saved within seconds (an editor's autosave, or a shared room's snapshot about 5 s after an edit), so the viewer is at most about half a minute behind. A live view through the room (which has a `viewer` role) would need the room client, remote-edit rendering and handoff on the viewer's side, would differ by room kind, and would stop the viewer being one embeddable component. A snapshot that catches up is enough for reading.
- **Access that ends takes the document away.** The same check decides (`checkOutcome` in `protocol.ts`, tested in `viewer.test.ts`): a 404 (unshared, left from the dashboard, made an editor) or a 403 (the owner's plan ended) destroys the viewer, so its pages, text and worker are gone and not just hidden. The page title goes back to the plain one, the page says the document is no longer shared, and checking stops. A 401 (signed out) does the same but shows the sign-in buttons. Offline, a dropped download or a server error keeps what is shown and tries again on the next check. A tab in the background checks as soon as it is looked at again, so a revoked tab clears when it is seen. The e2e spec covers both the owner removing the person in the Share dialog and the person leaving it from their dashboard, with the open tab and a reload.
- **The server enforces it, not the page.** A viewer share can't save, upload, rename, move, change history, add room pictures, share or delete: see [Server](server.md#sharing). The page never tries; if it did, it would be refused.
- **Built with the site.** The client's `build` runs the viewer config a second time in `site` mode (`vite.viewer.config.ts`), which writes `view/index.html` and its chunks into the site's `dist/` beside the app, without touching the app's chunks or its `build.json`. In development Vite serves it at `/view/`. Its address has no slash after `view` (`/view?s=…`, `/view?p=…`): Cloudflare serves a folder's `index.html` there and redirects `/view/` to it, so a link with the slash costs a redirect; the dev server is handed `/view/` for it (`viewerAddress` in `vite.config.ts`).
- **Who may share view-only** is who may share at all: the owner, while they have sync. The one schema change is the share's viewer address (`shares.view_token`).

## Public links and embedding

A document may also have one **public link** (File › Share, *Public link*): `/view?p=<token>`, the same page, for anyone, signed in or not. The token is `public_links.token` ([Server](server.md#sharing)), random and naming nothing, and the page reads `/api/public/<token>` and `/api/public/<token>/file`, which need no session. What differs from a person's view-only share (`src/viewer/share.ts`):

- **No sign-in.** A 404 (link turned off, reset, the document deleted, or the owner's sync ended: the server doesn't say which) shows that the link no longer works.
- **Download.** The bar has a Download button (`onDownload` in `mount`). The account keeps the document as a `.wdoc`, so the page keeps a copy of the stored bytes and turns them into the file its name says with `toVaultFile` (the same conversion the desktop vault writes, `desktop/vaultCodec.ts`), in the vault's convert worker, started on the first click (its page-side code is a few kB, so it is part of the page).
- **Embedding.** `/view?p=<token>&embed` is the same page with only the document's name in the bar. The Share dialog's Copy Embed Code gives an `<iframe>` of it (`embedCode` in `ui/shareDialog.ts`). The site sends no `X-Frame-Options` or `frame-ancestors`, so any site may frame it. A host that sandboxes the frame must allow `allow-scripts allow-same-origin` (the page reads the API on its own origin), and `allow-downloads` for Download, `allow-popups` for links.
- **Cost.** Every visitor loads the viewer and the fonts the document uses (static files, cached), and the file once. A public page checks for a newer save every 2 minutes instead of 30 s, and only while it is in view; the server lets browsers keep its answers for a minute, which is also how long a link turned off can still show to someone who already had it open.

## API

`mount(el, options) → { destroy() }` (`client/src/viewer/viewer.ts`). It sets the colour scheme on the root element, so it is meant to own its document: the viewer page, or a frame of its own.

| Option | |
| --- | --- |
| `bytes` | The file (`ArrayBuffer`, transferred to the worker and so emptied, or `Uint8Array`, copied). |
| `name` | Its file name; the extension says what it is. |
| `fontBase` | The folder holding `manifest.json`, absolute or relative to the page. |
| `dark` | Dark colours around the pages, and dark pages with light letters. |
| `locale` | The language of the viewer's own words (default `en`; the 11 the app has). |
| `onOpened({ name, format, pages })` | The file is open and laid out; `format` is what it was read as (`docx`, `md`, `pdf`...). |
| `onError(message)` | It can't be shown (an unknown kind, a damaged file, no WebGL 2). |
| `onLink(url)` | A link was clicked. |
| `onKey(key)` | A key the viewer has no use for was pressed while it had the focus: `{ key, code, shiftKey, ctrlKey, altKey, metaKey, repeat }`, as `KeyboardEvent` has them (see Keys above). |
| `title` | Shown in the bar beside the page number. |

`destroy()` stops the worker, frees the GPU (`WEBGL_lose_context`) and removes what it added. `reload(bytes)` shows a newer version of the same file in place, keeping the view where it was.

## The viewer page and its messages

`viewer.html` runs `src/viewer/main.ts`: `mount(document.body, ...)` for each file it is sent, and the callbacks as messages. It reads only messages whose `source` is `window.parent`. It answers with `postMessage(..., '*')`, since a sandboxed frame has no origin of its own to name, so the host checks `event.source === iframe.contentWindow`. The types are in `src/viewer/protocol.ts`.

| Direction | Message |
| --- | --- |
| host → viewer | `{ type: 'golemdocs:open', bytes: ArrayBuffer, name, fontBase?, dark?, locale? }`. Transfer `bytes`. A second `open` replaces the file. `fontBase` defaults to `?fonts=` in the page's address, else `fonts/` beside the page. |
| viewer → host | `{ type: 'golemdocs:ready' }` once loaded; `{ type: 'golemdocs:opened', name, format, pages }`; `{ type: 'golemdocs:error', message }`; `{ type: 'golemdocs:link', url }`; `{ type: 'golemdocs:key', key, code, shiftKey, ctrlKey, altKey, metaKey, repeat }` for a key the viewer has no use for (see Keys above). |

## Building it

`pnpm --filter @golemdocs/client build:viewer` (`client/vite.viewer.config.ts`) writes `client/dist-viewer/`: `viewer.html`, `assets/` and `fonts/`, with relative paths (`base: './'`), so the folder works wherever a host puts it. The app's build (`vite.config.ts`) is unchanged by it, and none of the site's `public/` files are copied. (The site's own copy, the shared-document page, is built by the same config in `site` mode; see above.) The build reuses the app's config, so the layout worker is the same `layoutCore` chunk.

What a session loads (sizes minified; gzip in brackets):

| | |
| --- | --- |
| Page entry `viewer-*.js` | 62.7 kB (22.4 kB): the renderer, layout client, file kinds, i18n, the bar |
| `viewer-*.css` | 44.1 kB (9.2 kB): `ui.css` without its web font, and `viewer.css` |
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
| `client/view/index.html`, `client/src/viewer/share.ts` | The site's page for a document shared view-only (`/view?s=<token>`) |
| `client/src/viewer/viewer.ts` | `mount`: rendering, input, the bar, `startLayoutWorker` |
| `client/src/viewer/protocol.ts` | Message types, `linkForHost`, zoom steps, page numbers (pure; `client/test/viewer.test.ts`) |
| `client/src/viewer/fonts.ts` | The font set the build bundles (pure; tested there too) |
| `client/src/viewer/viewer.css` | The bar and the view |
| `client/vite.viewer.config.ts` | The viewer's build |
| `client/src/layout/layoutClient.ts` | `openReadOnly`, `terminate`, the `fontBase` and `startWorker` options |
| `e2e/viewer/viewer.spec.ts`, `e2e/viewer/sandbox.spec.ts` | The viewer page in the dev server; the built viewer sandboxed, in Chromium and WebKit |
| `e2e/collab/share-view-only.spec.ts` | Sharing as Can view, opening it in the viewer under its token (no response names the document), catching up with a save, refused writes, a dead token |

## Related docs

- [Layout](layout.md): the worker and its messages, including `open`'s `readOnly`.
- [Rendering](rendering.md): the renderer, atlases and font pages the viewer reuses.
- [Build and testing](build-and-testing.md): builds, lazy chunks and the e2e specs.
