# Architecture overview

Golem Docs is a Word-style editor for the browser that opens, edits and converts many kinds of document (Word, OpenDocument, PDF, Markdown, HTML, plain text, pictures, SVG drawings, large logs). This page is the map: what the app is for, how the pieces fit, and which doc to read for each piece. The [index](README.md) lists every doc.

## Goals

These are the goals the design serves. When a change pulls against one, that is worth a conversation.

1. **One editor for every document.** Every format is an edge: a handler reads bytes into one in-memory model and writes it back out. Adding a format should not touch the editor ([Formats](architecture/formats.md)).
2. **Works without an account, anywhere.** Free use needs no sign-in and saves to the browser; the editor core has no dependency on the server. Sign-in, sync, sharing and live editing are the paid, hosted layer on top ([Storage and sync](architecture/storage-and-sync.md), [Server](architecture/server.md)).
3. **Looks like it prints.** The page is drawn by the app's own layout engine and WebGL renderer, so what you see is how it paginates and prints, and zooming stays sharp ([Layout](architecture/layout.md), [Rendering](architecture/rendering.md)).
4. **Stays fast on large inputs.** Layout runs in a worker, relayout is incremental, fonts, formats and big panels load lazily, and large files are chunked and edited with a piece table instead of a full model ([Layout](architecture/layout.md), [Build and testing](architecture/build-and-testing.md), [chunked-storage.md](chunked-storage.md), [text-files.md](text-files.md)).
5. **Edit together, safely.** Every edit is an operation; a room serializes them through one log, and undo takes back only your own changes ([Document model](architecture/document-model.md), [Collaboration](architecture/collaboration.md)).
6. **Few dependencies, mostly hand-written.** The format, layout, editing and PDF libraries have no third-party runtime dependencies, and the client ships none from npm. New dependencies need approval ([AGENTS.md](../AGENTS.md)).
7. **Familiar and consistent.** Word 2003 menus and toolbars, one shared component per kind of control, every string localized in 11 languages ([UI](architecture/ui.md), [localization.md](localization.md)).

## The pieces

```
 ┌────────────────────────────── browser ────────────────────────────────┐
 │  main thread                                  layout worker           │
 │  ┌──────────────┐  commands   ┌──────────────────────────────────┐    │
 │  │ main.ts      │───────────► │ layoutWorker.ts                  │    │
 │  │  ui/ chrome  │             │  @golemdocs/docx   model         │    │
 │  │  webgl/ view │ ◄────────── │  @golemdocs/editor edits         │    │
 │  │  canvas+DOM  │ pages,sel.  │  @golemdocs/ops    undo, replica │    │
 │  └──────┬───────┘             │  @golemdocs/layout pagination    │    │
 │         │ IndexedDB           │  formats/ readers and writers    │    │
 │         ▼                     └───────────────┬──────────────────┘    │
 │   local copies, cache                         │ room websocket        │
 └──────────┬────────────────────────────────────┼───────────────────────┘
            │ /api/* (sync, sharing)             │
            ▼                                    ▼
 ┌──────────────────────── Cloudflare Worker (server/) ─────────────────┐
 │  auth, sessions, D1 (directory + per-user), R2 files,                │
 │  Polar billing, Durable Object `Room` per document                   │
 └──────────────────────────────────────────────────────────────────────┘
```

**Packages** (all at the repository root, in one pnpm workspace). Dependencies point one way: libraries never import `client` or `server`.

| Package | Role | Depends on |
| --- | --- | --- |
| `docx` | The document model (`WordDocument`) and a from-scratch DOCX reader and writer | none |
| `ops` | Operations, undo and redo, replica, central-log collaboration protocol | `docx` |
| `layout` | Pagination, line breaking, tables, floats | `docx` |
| `editor` | Selection, commands and `Editor.apply`, which turns commands into operations | `docx`, `layout`, `ops` |
| `odt` | OpenDocument reader and writer | `docx` |
| `pdf` | PDF reader, editor and writer | none |
| `client` | The app: UI, WebGL renderer, format handlers, storage | all of the libraries |
| `server` | The Worker: accounts, cloud documents, sharing, rooms, billing | `docx`, `ops` |

**Threads.** The main thread owns the canvas, the DOM chrome and storage. The document itself lives in the layout worker, which holds the model, applies edits, lays out, and runs the room client. The two talk by typed messages, so a heavy layout never blocks typing.

## Life of an edit

1. A key, menu item or toolbar button becomes a command sent to the worker.
2. `Editor.apply` turns it into `Operation`s, which go through the replica into the model and the undo history (and to the room, when others are editing).
3. The layout session invalidates from the changed block and relays out, restarting one page early, in 12 ms slices.
4. The worker posts changed pages and the selection back; the main thread uploads them as GPU pages and draws the next frame.
5. A debounced save writes the document locally and queues an upload when it belongs to an account.

Details: [Document model](architecture/document-model.md), [Layout](architecture/layout.md), [Rendering](architecture/rendering.md).

## Where things live

| I want to… | Start in |
| --- | --- |
| Change how text is drawn, zoomed or hit-tested | [Rendering](architecture/rendering.md) |
| Change pagination, tables, line breaking | [Layout](architecture/layout.md) |
| Add an editing command or change undo | [Document model](architecture/document-model.md) |
| Add or change a file format | [Formats](architecture/formats.md) |
| Change saving, sync or conflicts | [Storage and sync](architecture/storage-and-sync.md) |
| Work on the desktop app or the local vault folder | [Desktop app](architecture/desktop.md) |
| Change what is kept of earlier versions, or the trash | [Version history and the trash](history.md) |
| Change an API route, sharing or billing | [Server](architecture/server.md) |
| Change live editing | [Collaboration](architecture/collaboration.md) |
| Add a menu item, dialog or language | [UI](architecture/ui.md), [localization.md](localization.md) |
| Build, test, release | [Build and testing](architecture/build-and-testing.md) |

## Cross-cutting rules

These live in [AGENTS.md](../AGENTS.md) and bind every change: ask before adding a dependency; lazily load anything of about 20 kB minified that most sessions never use; reuse the shared UI components; route every user-visible string through `t()`; add no in-app AI (AI is done by external agents on the vault folder); add tests, and e2e specs for UI; add a changelog line for user-visible changes.
