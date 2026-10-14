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
- **Permission.** `vault_check` (`vault::check_access`) reads the folder and writes then removes a hidden probe file. `VaultService.syncNow` calls it first on every sync: the first read of a protected folder (Documents, Desktop, iCloud Drive) is what makes macOS ask the person, and a refusal becomes the `access` state with the reason in `message`. An `access` folder is not retried every few seconds: Try Again (`retry`), or coming back to the window, asks again, and on a Mac `vault_open_privacy` opens System Settings › Files & Folders. A scan that fails in `look` now runs a sync, so the reason is reported instead of swallowed. The problem is shown once as a notice (`main.ts`), in the Vault Folder dialog and in the save indicator's panel.
- **Show in Finder.** `vault_reveal` opens the vault's root in the system file manager (`open`, `explorer`, `xdg-open`); the page names no path. The save indicator's panel (`ui/syncButton.ts`, through `ChromeHost.vaultFolder`) shows the folder with this link, or a link to the Vault Folder dialog while none is chosen.
- **`ui/vaultDialog.ts`** (File › Vault Folder, desktop only): choose or change the folder, stop, sync now, status, and the confirmation for a held-back mass delete.

## What a file is on disk

`vaultCodec.ts`. The account stores each document as a `.wdoc` (see [Formats](formats.md)); the vault holds it in the format its name asks for. Going out reads the container and calls `exportDocument` with the container's extensions (so Markdown front matter and the like come back exactly); coming in calls `importDocument` and wraps the result as a `.wdoc` with that format as its lens. Word files are kept byte for byte both ways.

The vault keeps Word, ODT, RTF, HTML, Markdown, plain text and source files, CSV/TSV, LaTeX and the other markup formats, DocBook/JATS/FB2/OPML, EML and notebooks. It does not keep PDFs, pictures, drawings, EPUB/MHTML or legacy `.doc`: they stay in the account and are neither downloaded nor deleted by a sync. A file renamed to another extension is saved again in the new format.

Conversion runs on another thread. `convertWorker.ts` (started through `convertWorkerEntry.ts`) runs `vaultCodec.ts`; `convertClient.ts` (`ConvertWorker`, the `VaultCodec` the sync uses) sends it bytes and gets bytes back. The worker starts with the first conversion and ends after 30 seconds with nothing to do, so a vault that is only watched holds no converters in memory; one that dies fails what it was doing and the next sync retries it. The page asks only `vaultFormats.ts` (names, no converters) which files the vault keeps. Like the layout worker, the build keeps the worker's code in a chunk of its own (`vaultCore`, see `worker` in `client/vite.config.ts`), because WebKit, which Tauri uses on macOS, runs a worker's entry script again when a lazy chunk imports it. The converters are only fetched in the desktop app; the sync code in the page is about 14 kB (5 kB gzipped), too small for a chunk of its own.

## Updates

The shell updates itself through `tauri-plugin-updater`: `UpdateService` (`client/src/desktop/updateService.ts`) asks the shell shortly after start and every 6 hours whether a newer signed version exists (`update_check`, `desktop/src-tauri/src/update.rs`), the Software Update dialog (`ui/updateDialog.ts`, also Help › Check for Updates) offers it, and `update_install` replaces the app and restarts it. "Later" holds an offer back for a day per version (`word.updateSnooze`, per device). How releases are signed and published is in [Releasing the desktop app](desktop-release.md#updating-the-shell).

## The Mac menu bar

On a Mac the desktop app shows the menus in the system's menu bar and hides the ones above the document (`MenuBar.setNative`); other systems keep the in-page menus. There is still one list of menus (`Chrome.menus()` in `ui/chrome.ts`) and one set of commands, so nothing is defined twice:

```
 Chrome.refresh() --> NativeMenuSync.schedule()  (150 ms, then only if the menus differ)
                          snapshotMenus(): labels without mnemonics, accelerators, enabled/checked, ids
                          --> invoke set_native_menu --> menu.rs builds the Menu --> app.set_menu
 click or shortcut --> menu.rs emits "native-menu" (item id) --> NativeMenuSync.run(id) --> the command
```

- **Snapshot** (`client/src/desktop/nativeMenu.ts`): the same filtering as the page (`visibleItems`, `hasAvailable`); submenus built on open (Open Recent, samples) are read when the snapshot is made; a heading becomes a row that cannot be chosen. Ids belong to one snapshot; the actions are kept beside it.
- **Native side** (`desktop/src-tauri/src/menu.rs`): adds the app menu (About, Services, Hide, Quit) and a Window menu around the page's menus. An accelerator the system cannot parse drops only the shortcut, not the item.
- **Shortcuts are bound by the menu**: the system takes a key that matches a menu item before the page sees it, so every command with a shortcut in a menu runs from the menu event. Not bound: Cut, Copy and Paste (system items, so the editor receives real clipboard events); shortcuts without ⌘ or ⌃ (Shift+Enter must stay a key press); the drawing tools' bare keys.
- **Guard** (`NativeMenuSync.run`): nothing runs while a dialog is open, and an item that has a shortcut does not run while a text field has the keyboard, as the page's own shortcuts behave. A click cannot be told from a shortcut, so a click on such an item while typing in a field is ignored too.
- **Title bar**: the window uses `titleBarStyle: Overlay` with a hidden title (`tauri.conf.json`, macOS only), so the page draws under the system's title bar and the menu bar's row becomes it (`MenuBar.setTitleBar`): the document name and the controls on the right sit in that row, a 78 px inset keeps clear of the close, minimize and zoom buttons, and `data-tauri-drag-region` makes the row drag the window (double-click zooms; both need the `core:window` permissions in the capability file). In full screen the buttons go and the inset stays.
- **Text fields**: the menu takes ⌘A, ⌘Z and ⇧⌘Z from a focused field (the document title, a dialog's box), so `NativeMenuSync` does them in the field (`document.execCommand`) instead of running the document's command. Other menu shortcuts are ignored there. Clicking the document title selects all of it: WebKit drops the selection a focus makes when the mouse button is released, so `DocumentTitle` selects again on that release.

## The phone apps

The iOS app (Android is not started) is the same crate and the same launcher page (`desktop/frontend`) as the desktop app, so the phone shows the live website. Its bundle id is `com.golemdocs.mobile`, signed by the paid team YOPEY YOPEY LLC (`C57E343UU5`, in `tauri.ios.conf.json`; the same team as the Mac Developer ID certificate). `com.golemdocs.app` is taken by a free personal team that built it first: don't use it.

- **What is desktop only**: the native menu bar and the updater. `src/lib.rs` compiles them under `#[cfg(desktop)]`, `tauri-plugin-dialog` and `tauri-plugin-updater` are desktop-only dependencies in `Cargo.toml` (the stores update the phone app). The vault is on iOS too, with a fixed folder (below). The page must not offer them there: `bridge.ts` returns null from `desktopBridge()`, `desktopUpdater()`, `desktopMenu()` and `isDesktopApp()` on a touch device (`isTouchDevice`: iPhone, iPad, Android, or an iPad that calls itself a Mac), and `isMobileApp()` says it is the phone shell.
- **Config**: `src-tauri/tauri.ios.conf.json` overrides the identifier, sets the team and the minimum iOS (15). The Xcode project in `src-tauri/gen/apple` is committed (it holds the iCloud entitlements, `NSUbiquitousContainers` in `project.yml` and `ICloud.swift`; only `gen/schemas`, `build/` and `Externals/` are ignored). After editing `project.yml` run `xcodegen generate` in `gen/apple`. It was made with `cargo tauri ios init` (not through `npx`, or the generated build script calls `npm run tauri`, which does not exist here); don't re-run init over it. A device needs registering in the team's Devices list at developer.apple.com first.
- **Safe areas**: the page is drawn under the status bar and home indicator (`viewport-fit=cover`), so `body` pads itself with `env(safe-area-inset-*)` (`style.css`); nothing else in the flow should pad for them again (the title and format controls in the menu bar are absolutely positioned and would drift out of line). While the keyboard is up `fitVisual` (`main.ts`) sets `--safe-bottom: 0px`, because the home indicator is under it. Fixed-position pieces (the menu drawer, bottom sheets) pad themselves. The insets are 0 in a desktop browser.
- **Testing page changes in the simulator**: with your `pnpm dev` running, build with `--config '{"build":{"frontendDist":"http://localhost:5173"}}'` so the app loads the dev page instead of golemdocs.com (`cargo tauri ios dev` does not find the simulator by name).
- **Try it in the simulator**: `cd desktop && cargo tauri ios build --debug --target aarch64-sim --ci`, then install `src-tauri/gen/apple/build/arm64-sim/GolemDocs.app` (`xcrun simctl install booted <app>`; `xcrun simctl launch booted com.golemdocs.app`). It needs the Rust targets `aarch64-apple-ios-sim` and `aarch64-apple-ios`, Xcode, `xcodegen` and CocoaPods. A device or App Store build needs `bundle > iOS > developmentTeam` (or `APPLE_DEVELOPMENT_TEAM`), not set yet.
- **Getting files out**: `ui/saveFile.ts` (`saveFile`) is the one way the page hands a file over. On a touch device whose web view can share files (`navigator.canShare`) it opens the system share sheet (Save to Files, AirDrop, Mail), otherwise it downloads through a link; it is used by File › Download and Download All. A web view has no download list, so a link there goes nowhere. The sheet needs a tap just before it: if the browser refuses (the export took too long) `saveFile` falls back to the link.
- **The vault on a phone is iCloud Drive › GolemDocs** (`src/icloud.rs`, `gen/apple/Sources/golemdocs-desktop/ICloud.swift`): the app's iCloud container, shown in the Files app and on every Apple device. Nothing is chosen (`DesktopBridge.fixed`, no Choose or Stop in the dialog). The Mac vault can be pointed at the same folder (`~/Library/Mobile Documents/iCloud~com~golemdocs~mobile/Documents`). The sync state (`.golemdocs/`) is kept in the app's local data folder on the phone (`Vault.state_home`), not in the shared folder, so the phone and the Mac never overwrite each other's. iOS cannot sync in the background: `VaultService` runs while the app is in front and when it comes back (`visibilitychange`). A file iCloud has not downloaded is a hidden `.name.icloud` placeholder; the scan would skip it and the sync would delete the document from the account, so `vault_scan` instead asks iCloud to download every placeholder and answers `icloud-downloading` (`ICLOUD_DOWNLOADING`), and the service waits and looks again. Needs the iCloud entitlements on a paid team. The Swift functions are defined by the app, not the Rust library, so `build.rs` lets the Rust dylib (which Cargo also links, and iOS never uses) leave them undefined (`-undefined dynamic_lookup`); without that the build fails at the dylib link.
- **Getting the phone to see page changes**: the shell shows golemdocs.com, so page changes need a deploy, or a build with `frontendDist` set to a dev server the phone can reach.
- **Android** (`src-tauri/tauri.android.conf.json`, `src-tauri/gen/android`, committed): the same shell, package `com.golemdocs.mobile`, with no vault yet (`lib.rs` gives it an empty handler). Needs a JDK 17, the Android SDK (platform 35+, build-tools, NDK 27) and the four Android Rust targets; set `JAVA_HOME`, `ANDROID_HOME` and `NDK_HOME`, then `cargo tauri android build --debug --target aarch64 --apk` (the APK is under `gen/android/app/build/outputs/apk/universal/debug`) and `adb install -r` it; an `arm64-v8a` Android 15 emulator image runs it on Apple silicon. The web view gives the page no dependable `env(safe-area-inset-*)`, so `MainActivity.kt` pads the window by the system bars, the cut-out and the keyboard and consumes those insets (the page's own safe-area padding is then 0). Tapping a document opens the keyboard on the first tap, and the assistant opens on a tap, as on iOS. `navigator.share` doesn't exist in Android's web view, so File › Download needs a native bridge to the share sheet (not built).
- **Not done**: the phone layout is the website's `mobile` profile as it is (menus and toolbars are the desktop's), no document or share extensions, no App Store signing, and billing (Apple requires its own in-app purchase for digital subscriptions).

## Not built yet

- A bundled client that works offline: it needs token auth on the API, because the page would no longer be same-origin with it. The phone apps show the website too, so they need a connection until this exists.
- An assistant tool for the vault: choosing a folder needs the native dialog, which only the person can use, so the AI cannot do it. Syncing itself is automatic.
- An end-to-end test: Playwright drives Chromium, which has no native shell. The driver and codec are covered by `vaultSync.test.ts` and `vaultCodec.test.ts`, the folder rules by the Rust tests.

## Running it

The dev server must be running (`pnpm dev`, started by you, see AGENTS.md); then:

```bash
pnpm desktop:dev
```

`pnpm desktop:test` runs the Rust tests; the planner is tested with the rest of the client (`client/test/vaultPlan.test.ts`). `pnpm desktop:build` makes the installer for this machine (unsigned); the signed installers for a release are built by CI, see [Releasing the desktop app](desktop-release.md). It needs Rust and `cargo-tauri` (`cargo install tauri-cli`); there is no npm dependency.

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
| `desktop/src-tauri/src/update.rs` | `update_check` and `update_install` over the updater plugin |
| `client/src/desktop/updateService.ts`, `client/src/ui/updateDialog.ts` | when to look for an update, and the dialog that offers it |
| `client/src/desktop/vaultGuest.ts` | the signed-out side: this browser's documents as a `VaultCloud` |
| `client/src/desktop/vaultService.ts` | the running sync: looks every few seconds, syncs on change |
| `client/src/ui/vaultDialog.ts` | File › Vault Folder |
| `client/src/desktop/nativeMenu.ts` | the menus as a snapshot for the Mac menu bar; `NativeMenuSync` |
| `desktop/src-tauri/src/menu.rs` | builds the native menu bar from the snapshot; sends clicks back |
