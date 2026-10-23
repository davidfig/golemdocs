# Golem Docs documentation

Start with the [architecture overview](architecture.md): the goals, the packages, and how an edit travels from a keystroke to the screen and the server. Then read the detailed doc for the area you are working in. For setup, running locally and deploying, see the [root README](../README.md); for the rules every change follows, see [AGENTS.md](../AGENTS.md).

## Architecture

| Doc | Covers |
| --- | --- |
| [Overview and goals](architecture.md) | What the app is for, the package map, threads, life of an edit |
| [Rendering](architecture/rendering.md) | WebGL renderer, MSDF font atlases and font pages, camera, Page Grid, hit-testing |
| [Layout](architecture/layout.md) | Layout engine, incremental relayout, the layout worker and its messages |
| [Document model and editing](architecture/document-model.md) | Commands to operations, undo and redo, selection, clipboard, find and replace, the other editors |
| [Formats](architecture/formats.md) | `FormatHandler` registry, the `.wdoc` container, DOCX, ODT, PDF, Markdown, conversion loss, adding a format |
| [Storage and sync](architecture/storage-and-sync.md) | IndexedDB, local and cloud copies, ownership, the upload queue, offline behavior, settings sync |
| [Desktop app](architecture/desktop.md) | The Tauri shell, the vault folder and how it syncs with the account |
| [Releasing the desktop app](architecture/desktop-release.md) | Installer builds on a tag, Apple signing and notarization, what is not done yet |
| [Server](architecture/server.md) | Worker routing, sign-in, D1 and R2 layout, sharing, billing, search, environments |
| [Collaboration](architecture/collaboration.md) | Rooms, the central log, handoff and settle, one gateway and one transport |
| [UI](architecture/ui.md) | App shell, actions and commands, shared components, spelling, the home site |
| [Build and testing](architecture/build-and-testing.md) | Workspace, lazy chunks, unit and e2e tests, CI, deploy, release |

## Feature and subsystem docs

| Doc | Covers |
| --- | --- |
| [history.md](history.md) | Version history (this browser's and the account's), the shared retention rules, and the trash |
| [chunked-storage.md](chunked-storage.md) | Content-defined chunking and delta uploads for files of 2 MiB or more |
| [text-files.md](text-files.md) | The large text and log editor (50 MB files): design, status and measurements |
| [pdf-editing.md](pdf-editing.md) | Fill In and Edit PDF modes |
| [localization.md](localization.md) | Strings, languages, spelling dictionaries, adding a language |
| [../server/AUTH.md](../server/AUTH.md) | Sign-in provider setup |

## Package READMEs

[docx](../docx/README.md), [ops](../ops/README.md), [pdf](../pdf/README.md). `layout`, `editor` and `odt` have none yet; their architecture docs above stand in.

## Status and ongoing work

| Doc | What it tracks |
| --- | --- |
| [actions-status.md](actions-status.md) | Which menu and toolbar actions work, and what is still disabled |
| [open-source-readiness.md](open-source-readiness.md) | An audit of what would have to be true to open source (a record, not a decision) |
| [../CHANGELOG.md](../CHANGELOG.md) | Released and unreleased user-visible changes; the `Unreleased` heading is the current work log |

Known loose ends, as of 2026-10-05:

- Large text files: opening a filter's matches as a document is not done, and a Windows-1252 file is saved as UTF-8 ([text-files.md](text-files.md)).
- Shared PDFs, pictures and drawings resolve conflicts per object (last writer wins), and page moves in a shared PDF are not available.
- `.doc` (Word 97) imports but does not export.
- The subscription gate is built but off (`REQUIRE_SUBSCRIPTION` is `"false"` in `server/wrangler.jsonc`).
- `main.ts` (about 4,600 lines) and `layoutWorker.ts` (about 2,800 lines) are large and hold much of the app's wiring.

Docs that disagree with the code:

- `ops/README.md` still describes the removed dev-server and SharedWorker rooms.
- `client/src/ui/shareDialog.ts` builds a native `<select>`, which AGENTS.md forbids.
- The comment in `server/wrangler.jsonc` says cloud documents are off in the `local` environment; they work there.

## Keeping these docs current

Each architecture doc lists its key files, so a change that moves or renames one should update that table. When you finish a piece of work, update the matching status doc or the changelog rather than adding a new note.
