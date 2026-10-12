# Desktop app

The desktop app is a [Tauri](https://tauri.app) shell around the website, plus a *vault*: one folder on the computer that holds a copy of the account's documents as real files, kept in sync both ways (like an Obsidian vault). The same shell is meant to carry the iOS and Android apps later (Tauri 2 targets them).

## How it works

```
 desktop/src-tauri (Rust)                       client/src/desktop (page)
 ------------------------                       -------------------------
 window --> loads https://golemdocs.com  <----  the web app, unchanged: same code, sign-in, account
            (dev: http://localhost:5173)
 vault.rs: choose / scan / read / write ----->  bridge.ts   typed calls on window.__TAURI__
           / remove inside ONE folder           vaultPlan.ts  what a sync does (pure, tested)
```

- **The window shows the website**, not a bundled copy. Cookies, OAuth redirects and `/api` stay same-origin, so sign-in and the server need no changes. `desktop/frontend/index.html` is only the launcher: it opens the site, or says it cannot be reached. (A bundled, offline-capable client needs token auth on the API and is a later step.)
- **The page reaches the native side only through the vault commands**, and only the origins listed in `desktop/src-tauri/capabilities/default.json` may call them. `build.rs` registers each command so it has its own permission.
- **The vault commands never take a folder from the page.** The person picks it in a native dialog (`vault_choose`); Rust keeps it (remembered in the app's config folder) and every command takes a path *inside* it. `vault::resolve` refuses `..`, absolute paths, backslashes, dot-names and anything that goes through a symbolic link. Dot-names are not documents (`scan` skips them); `.golemdocs/` holds the sync state and only `vault_read` and `vault_write` may touch it.
- **Writes are atomic**: a hidden temporary file in the same folder, then a rename.

## The sync rule: the local file wins

**First launch.** `connectVault` (`main.ts`) opens the Vault Folder dialog once, on a device where no folder is remembered (signed in or not). `word.vaultAsked` in localStorage records that it was shown (per device, not synced), so closing the dialog without choosing is final; File › Vault Folder stays available.

**Without an account.** The folder does not need one. `syncVault` talks to a `VaultCloud` and cannot tell what is behind it: signed in it is `accountCloud()` (`vaultHost.ts`), signed out it is `guestCloud()` (`vaultGuest.ts`), the documents with no owner saved in this browser (`storage/local.ts`) and the folders kept here. Replacing one keeps a version in the browser's history and a deleted file goes to the browser's trash, so the same rule holds. The vault's `state.json` records whose folder it is (`GUEST_ACCOUNT` or an account id): a signed-out folder is taken over by the account that signs in (no memory, so files are matched to documents by path and the file wins), but a folder linked to an account is never given to another account or used signed out (`wrongAccount`, shown as "sign in to that account"), because documents copied out of it would be uploaded again by the sign-in's adoption of guest documents. `VaultService` waits for the page's uploads (`hooks.settled`) before the first sync as an account, so adopted documents are already there to match; it calls `hooks.changed` after a sync that changed anything, so the page's library list refreshes. The dialog words signed-out text with the `*Local` strings.

**The open document.** `SyncReport.touched` lists the documents a sync replaced, renamed or deleted on the other side (ids as that side knows them). `vaultChanged` (`main.ts`) refreshes the library and, if the open document is one of them and has no unsaved edits and is not in a shared room, stores the account's new copy (`openFromCloud`) and opens it again from storage (`openLocal`), which keeps its caret and scroll. The file wins, so this replaces what the editor showed; edits not yet saved are left alone and the next sync decides.

Whatever is done to the folder is what the account becomes. That is safe because the account keeps history: replacing a document keeps its old bytes as a version first (`keepCloudVersion`), and deleting one moves it to the account's trash for 30 days ([Version history](../history.md)).

`planVault` (`client/src/desktop/vaultPlan.ts`) is a pure function of the files on disk, the manifest from the last sync and the account's catalogue. A sync is two steps: `needsHash` names the few files that must be hashed (those whose size or time moved, and possible renames), then `planVault` returns the actions.

| Situation | Action |
| --- | --- |
| New document in the account | `download` |
| Changed in the account, file untouched | `download` |
| File edited here (bytes differ, not just the time) | `upload`, even if the account changed too (then the account's bytes are kept as a version first) |
| New file | `create` |
| File deleted here | `deleteCloud` (account trash) |
| File moved or renamed here (same bytes, one candidate) | `renameCloud`; the document and its history stay one |
| Moved or renamed in the account, file untouched | `moveLocal` |
| Deleted in the account, file untouched | `deleteLocal` |
| Deleted in the account, file edited here | the edit is kept as a new document |
| Vault filled before it was linked | `upload` over the account copy (version kept) |
| Many files missing at once (10 or more, and half of those linked) | held back (`blocked`) until the person confirms: it is far more likely a drive that is not mounted |

Files are followed by their cloud id in the manifest (`.golemdocs/state.json`), never by path. `cloudPaths` turns the account's folders and names into vault paths: it replaces characters a disk refuses, and keeps two same-named documents apart with " (2)" by creation order so a path is stable from one sync to the next.

## The sync driver

`syncVault` (`client/src/desktop/vaultSync.ts`) runs one sync against a `VaultHost` (disk, account, converter, hashing), so it is tested entirely in memory (`client/test/vaultSync.test.ts`). It lists the account, scans the folder, hashes only what `needsHash` names, runs `planVault`, executes the actions, and writes `.golemdocs/state.json` (the manifest, plus the account id: a vault never takes another account in). One action failing is reported and the rest carry on; whatever failed still differs from the manifest, so the next sync retries it.

- **`vaultHost.ts`** is the real host: the native bridge, `cloud.ts` (a save without `base`, because the file wins; `saveCloudVersion` first when the account changed too; the trash for deletes) and folder creation by name.
- **`vaultService.ts`** keeps it running while the app is open: a stat-only scan every 4 seconds (no file-watcher dependency), the account every minute and when the window is shown or the connection returns. A sync's own writes are not counted as changes. Syncs never overlap. It is started from `connect()` in `main.ts`, so it follows sign-in and sign-out.
- **`ui/vaultDialog.ts`** (File › Vault Folder, desktop only): choose or change the folder, stop, sync now, status, and the confirmation for a held-back mass delete.

## What a file is on disk

`vaultCodec.ts`. The account stores each document as a `.wdoc` (see [Formats](formats.md)); the vault holds it in the format its name asks for. Going out reads the container and calls `exportDocument` with the container's extensions (so Markdown front matter and the like come back exactly); coming in calls `importDocument` and wraps the result as a `.wdoc` with that format as its lens. Word files are kept byte for byte both ways.

The vault keeps Word, ODT, RTF, HTML, Markdown, plain text and source files, CSV/TSV, LaTeX and the other markup formats, DocBook/JATS/FB2/OPML, EML and notebooks. It does not keep PDFs, pictures, drawings, EPUB/MHTML or legacy `.doc`: they stay in the account and are neither downloaded nor deleted by a sync. A file renamed to another extension is saved again in the new format.

Conversion runs on another thread. `convertWorker.ts` (started through `convertWorkerEntry.ts`) runs `vaultCodec.ts`; `convertClient.ts` (`ConvertWorker`, the `VaultCodec` the sync uses) sends it bytes and gets bytes back. The worker starts with the first conversion and ends after 30 seconds with nothing to do, so a vault that is only watched holds no converters in memory; one that dies fails what it was doing and the next sync retries it. The page asks only `vaultFormats.ts` (names, no converters) which files the vault keeps. Like the layout worker, the build keeps the worker's code in a chunk of its own (`vaultCore`, see `worker` in `client/vite.config.ts`), because WebKit, which Tauri uses on macOS, runs a worker's entry script again when a lazy chunk imports it. The converters are only fetched in the desktop app; the sync code in the page is about 14 kB (5 kB gzipped), too small for a chunk of its own.

## Not built yet

- A bundled client that works offline: it needs token auth on the API, because the page would no longer be same-origin with it. It is also the step the iOS and Android targets (`cargo tauri ios init` / `android init`) depend on.
- An assistant tool for the vault: choosing a folder needs the native dialog, which only the person can use, so the AI cannot do it. Syncing itself is automatic.
- An end-to-end test: Playwright drives Chromium, which has no native shell. The driver and codec are covered by `vaultSync.test.ts` and `vaultCodec.test.ts`, the folder rules by the Rust tests.

## Running it

The dev server must be running (`pnpm dev`, started by you, see AGENTS.md); then:

```bash
pnpm desktop:dev
```

`pnpm desktop:test` runs the Rust tests; the planner is tested with the rest of the client (`client/test/vaultPlan.test.ts`). `pnpm desktop:build` makes the installer. It needs Rust and `cargo-tauri` (`cargo install tauri-cli`); there is no npm dependency.

## Key files

| Path | Role |
| --- | --- |
| `desktop/src-tauri/src/vault.rs` | the vault folder and its commands, path rules, atomic writes (unit tests inside) |
| `desktop/src-tauri/src/lib.rs` | builds the app, registers the commands and the folder dialog |
| `desktop/src-tauri/capabilities/default.json` | which origins may call which commands |
| `desktop/src-tauri/tauri.conf.json` | window, dev URL, bundle |
| `desktop/frontend/index.html` | launcher page shown before the site loads |
| `client/src/desktop/bridge.ts` | typed `desktopBridge()` over `window.__TAURI__`; null in a browser |
| `client/src/desktop/vaultPlan.ts` | `needsHash`, `planVault`, `cloudPaths`, `safeName` |
| `client/src/desktop/vaultSync.ts` | `syncVault`: runs one sync against a `VaultHost`, keeps the manifest |
| `client/src/desktop/vaultHost.ts` | the real host (bridge, `cloud.ts`, folders) |
| `client/src/desktop/vaultCodec.ts` | stored document bytes to and from the vault's file formats (runs in the worker) |
| `client/src/desktop/convertWorker.ts`, `convertWorkerEntry.ts`, `convertClient.ts` | the worker that runs the codec, and the page's client for it |
| `client/src/desktop/vaultFormats.ts` | which file names the vault keeps (no converters) |
| `client/src/desktop/vaultGuest.ts` | the signed-out side: this browser's documents as a `VaultCloud` |
| `client/src/desktop/vaultService.ts` | the running sync: looks every few seconds, syncs on change |
| `client/src/ui/vaultDialog.ts` | File › Vault Folder |
