# Storage and sync

Documents live in the browser's IndexedDB first. Signed out they never leave the device; signed in (with sync), the account's cloud copy is the home and the browser copy is a cache that is saved first and uploaded shortly after. This doc covers the client side of that: the IndexedDB layout, ownership of local copies, the library listing, the upload queue, reconciliation, offline behavior and settings sync. The server half is in [Server](server.md).

## How it works

```
 edit --> autosave --> storage/local.ts (IndexedDB "word")      <- always first, never waits on network
                            |  info.updatedAt raised
                            v
                  UploadQueue.schedule(id)  (2 s after editing pauses; one upload at a time)
                            |
                 library.ts uploadToCloud  --cloud.ts-->  /api/documents (PUT ?base=<cloudUpdatedAt>)
                            |                                  200 -> markSynced(cloudId, cloudUpdatedAt, ...)
                            |                                  409 -> merge with the cloud's (different paragraphs) and send again,
                            |                                         else save as "(conflicted copy)" (new cloud doc)
                            |                                  404 -> cloud copy deleted: start a new one
                            |                                  401 -> signedOut, wait; TypeError -> offline, retry
                            |                                  402 -> noSync(); 423 -> a room is the writer, skip
                            v
              LibraryStore (libraryStore.ts)  = mergeLibrary(local copies, cloud catalogue)  (sync.ts)
                            ^
        Documents screen, Files Sidebar, File > Open Recent all read this one copy
```

Nothing is ever overwritten. A copy that started from an older cloud version is merged with the cloud's when the two changed different things, and otherwise becomes a separate "(conflicted copy)" document (`conflictCopyName` in `client/src/library.ts`). Multi-person live editing is a different path (a room becomes the single writer; see [Collaboration](collaboration.md)).

## Merging a conflict

When an upload is refused (409) and the other tab's upload isn't the reason, `uploadToCloud` tries a three-way merge before keeping the two apart (`mergeWithCloud`):

- **The starting version** is kept beside each document in the `bases` store: the bytes of the last version this copy and the cloud agreed on, written when a copy is downloaded (`saveFromCloud`) or uploaded (`markSynced` with `base`), and stamped with that version's `cloudUpdatedAt`. Only for documents under `CHUNK_MIN_FILE` (larger ones keep the conflicted copy). A merge needs the base's stamp to equal the copy's `cloudUpdatedAt`.
- **The cloud's version** is read as its `updatedAt` from the list first, then its bytes: a save landing in between gives bytes newer than the stamp, which the next upload is refused over again (and merged again, at most `MERGES` times), never older ones it would be accepted over.
- **The merge** (`formats/merge.ts`, loaded only when needed) works on the `.wdoc`'s entries: `document.docx` by `mergeDocuments` (`ops/src/merge.ts`), every other entry whole from whichever side changed it, and a conflict when both did. A bare `.docx` (uploaded as it is, or written by another app) is a `.wdoc` with only its document, and leaves the other entries as they were. `mergeDocuments` diffs the base against each side (`diffDocuments`), refuses when both touched the same paragraph, removed or anchored on one the other changed, inserted at the same place, added a list, or changed a comment; takes styles, settings, the section and headers and footers from the side that changed them, and File › Properties field by field (the save dates every writer stamps, `modified` and `lastModifiedBy`, from whichever saved last); applies both sides' operations in both orders and keeps the result only if the two agree. Pictures, drawings and PDFs are never merged.
- **Writing it** (`rebaseSaved`): the copy here becomes the merge, based on the cloud's version, only if it hasn't been saved to since; what it replaces goes into this browser's history first, and the cloud's version into the account's history (`saveCloudVersion`), so either side can be got back. The upload then sends it like any save, and `markSynced` makes it the next base.
- **The open document** (`mergeHost` in `main.ts`): merged only if nothing is unsaved, and its own saves wait (`OpenDocument.merging`) until the merge is in the editor (`refreshFromStore`, in place). Anything typed meanwhile is merged in too (typing as "mine", the merge as "theirs"); if that can't be done, the typing becomes a "(conflicted copy)" of its own and the merged document is opened, so nothing is lost. The person is told either way (`app.mergedNotice`, `app.conflictNotice`).

## IndexedDB layout (`client/src/storage/local.ts`)

Database `word`, version 8. Object stores:

| Store | Key -> value |
| --- | --- |
| `meta` | document id -> `SavedInfo` (name, size, `updatedAt`, `owner`, `cloudId`, `cloudSyncedAt`, `cloudUpdatedAt`, `folderId`, `releasedFrom`) |
| `bytes` | id -> the whole file (documents under 2 MiB: `CHUNK_MIN_FILE` in `chunker.ts`) |
| `manifests`, `chunks`, `chunkRefs` | for documents of 2 MiB or more: id -> `StoredManifest` (chunk hashes, lengths, `syncedHashes`), hash -> bytes, hash -> reference count (a chunk is deleted when the last document lets go). Details in [Chunked storage](../chunked-storage.md) |
| `history`, `historyData` | a document's earlier versions: id -> its versions' details (small), `<id>/<version>` -> a small version's bytes or a chunked one's manifest (a hold on its chunks through `chunkRefs`). See [Version history](../history.md) |
| `trash` | document id -> `{ info, deletedAt }`: the catalogue record of a document the person deleted, moved out of `meta` so every list stops showing it; its bytes, chunks, history and thumbnail stay. Restored or deleted for good by the trash dialog, or after 30 days. See [Version history](../history.md) |
| `thumbs` | id -> `{ blob, forUpdatedAt }`, the first-page thumbnail rendered by `thumbnail.ts` on every save (drawn after 3 s without edits, when the document is left, or when the dashboard opens) |
| `bases` | id -> `{ cloudUpdatedAt, bytes }`: the last version this copy and its cloud copy agreed on, for merging a conflict (documents under 2 MiB only; see "Merging a conflict") |
| `folders` | the guest (signed-out) folder hierarchy |
| `search` | per-document full-text index cache (`search/searchLibrary.ts`) |

Also in `localStorage` (not IndexedDB): `wm.catalogue` (the account's document/shared/folder lists as last listed, for an instant dashboard; `sync.ts`), `golem.account` (last signed-in user, so offline still shows their documents; `auth.ts`), `golem.settingsSync` (settings baseline), `golemdocs.views` (per-document scroll, zoom, caret and selection, `viewMemory.ts`, capped at 200).

## Ownership rules for local copies

- `SavedInfo.owner` absent = made while signed out ("guest"). `ownedBy(docs, owner)` is the only filter the UI uses to decide what is in view.
- **Sign in with sync**: `adoptGuestFolders()` (`folderOps.ts`) sends guest folders first, then `adoptGuestDocuments(userId)` stamps every guest copy with the account and the upload queue sends them. A guest copy that was `releasedFrom` a *different* account loses its cloud link and folder and becomes a new document for this one (else it would look "deleted elsewhere").
- **Signed in without sync** (subscription ended): `releaseToGuest(userId)` makes the account's copies guest copies again, remembering `releasedFrom`; cloud copies are untouched, subscribing again re-adopts them.
- **Sign out**: `deleteOwnedBy(userId)` removes that account's copies, `forgetCatalogue()` clears `wm.catalogue`, and `wm.signedOut` in localStorage tells other tabs (`main.ts`, near the sign-out function). Guest copies stay. The cloud keeps everything.
- **Deleting**: a document with a copy in the account is deleted from the account (which moves it to the account's trash for 30 days) and for good here; one with none (a guest's, or an account's without sync) is moved to this browser's trash (`trashSaved`). Sign out and Clear Local Data delete for good, trash included (`deleteOwnedBy`, `clearAllSaved`).
- **Deleted elsewhere**: `loadLibrary` deletes a linked local copy no longer in the account's list *only if* it has no unsent changes (`deletedElsewhere`, `deleteSavedIfUnchanged`); an edited copy is uploaded again instead, so no work is lost.

## Key files

| Path | Role |
| --- | --- |
| `client/src/storage/local.ts` | IndexedDB access: save/get/list/delete, chunk assembly, thumbnails, folders, ownership transitions, `markSynced`, `saveFromCloud` |
| `client/src/history.ts`, `client/src/trash.ts` | the one list of kept versions (this browser's and the account's) and the one list of deleted documents, with restore; `ui/versionHistoryDialog.ts` and `ui/trashDialog.ts` show them |
| `client/src/storage/chunker.ts` | content-defined chunking (`cdc1`), `CHUNK_MIN_FILE`, `assemble` |
| `client/src/storage/archive.ts`, `zipImport.ts`, `droppedFiles.ts`, `uniqueName.ts` | Download All as ZIP, ZIP/folder import into folders, name de-duplication |
| `client/src/library.ts` | `uploadToCloud` (with `mergeWithCloud` and the `MergeHost` the page gives it), `uploadNewToCloud` (batches), `openFromCloud`, `prefetchFromCloud`, `conflictCopyName` |
| `client/src/formats/merge.ts`, `ops/src/merge.ts` | `mergeStored` (a stored file's entries) and `mergeDocuments` (the document, by paragraphs): the three-way merge of a conflict |
| `client/src/libraryStore.ts` | `LibraryStore`: the one observable copy of entries, folders, shared documents; `refresh`, `refreshSoon` (3 s debounce), `putLocal`, `putCloud`, `reset` |
| `client/src/sync.ts` | `SyncState`, `classify`, `mergeLibrary`, `loadLibrary`, `loadLocalLibrary`, the `wm.catalogue` cache and its patch helpers |
| `client/src/cloud.ts` | typed fetch client for `/api/documents`, `/api/folders`, shares; `CloudError`, 429 retry in `send`, delta (chunk) upload, session-local `deleted` set |
| `client/src/uploadQueue.ts` | `UploadQueue` (dirty set, 2 s delay, offline retry every 30 s, batch coordination) with a `UploadHost` callback interface |
| `client/src/folders.ts`, `folderOps.ts` | pure folder rules (`childFolders`, `Placed`) and the create/rename/move/delete operations, cloud-first when signed in; documents are moved (`moveEntries`) and renamed (`renameEntry`: name only, the account's copy first; the open document is renamed through the editor instead) here too |
| `client/src/auth.ts` | `currentUser` (falls back to `remembered()` offline), `availableProviders`, `signInUrl`, `signOut` |
| `client/src/subscription.ts` | `fetchSubscription`, checkout/portal URLs; `sync: false` switches the app to guest mode |
| `client/src/settingsSync.ts` | `SYNCED_KEYS`, `planSync`, `syncSettings`, per-profile (`desktop`/`mobile`) |
| `client/src/thumbnail.ts` | first-page thumbnail drawn with the editor's renderer into an offscreen framebuffer (max about 2x card size) |
| `client/src/main.ts` | wires it all: `LibraryStore` host, `connect()`, `UploadQueue` host, autosave, sign-out |

## Key data types

- `SavedInfo` (browser copy) and `CloudDocument` (`cloud.ts`: `id, name, size, createdAt, updatedAt, thumbAt, folderId, role, owner`).
- `LibraryEntry` (`sync.ts`): `{ key, name, size, updatedAt, local, cloud, state, folderId }`. `key` is the browser id, else the cloud id.
- `SyncState`: `local-only | cloud-only | synced | local-ahead | cloud-ahead | conflict | unknown`. `classify` compares `hasUnsentChanges(local)` (never uploaded, or `updatedAt > cloudSyncedAt`) with whether the cloud's `updatedAt` differs from the recorded `cloudUpdatedAt`; both true is `conflict`. The server's clock is used for cloud versions, the browser's for local, which is why they are stored separately.
- `Folder { id, name, parentId, createdAt, updatedAt }`. Folder placement comes from the cloud record when it exists, else the local one; shared documents ignore the viewer's folders.

## Reconciliation and offline behavior

- **Lazy sync.** A new computer only fetches the catalogue (names, sizes, dates, thumbnail links). Bytes come on open: `openFromCloud` uses the local copy if it has unsent changes, skips the download if `cloudUpdatedAt` already matches, and falls back to the local copy if the download fails with a network error. `prefetchFromCloud` starts a download on hover (30 s, 3 entries). Opening from the account passes `early`: the bytes are opened the moment they arrive and the browser copy is chunked and written behind them (`OpenedFromCloud.stored`); `main.ts` chains that write into `saving`, so no later save can be overwritten by it. `downloadDocument` can report the share received as the body arrives (shown in the status bar), and the page sends the worker `warm` so the default fonts load during the download.
- **Cloud-first folders.** Signed in with sync, folder and move operations are made on the account first and only happen if they save; guest folders live in the `folders` store. `forgetInCatalogue` / `patchCatalogue` keep the cached catalogue matching what was just done, and `isDeleted` (`cloud.ts`) hides items deleted this session from stale listings.
- **Offline.** There is no service worker; the app shell loads from the browser cache. Saves always succeed locally. `currentUser` returns the remembered account on a network error or 5xx, `LibraryStore.refresh` shows local copies plus the last cached catalogue before the network answers, and keeps the last-known account list if the listing fails (`cloudProblem`). A `TypeError` from `fetch` marks the queue offline: uploads wait, retry every 30 s and on the `online` event (`backOnline` in `main.ts`). A 401 sets `signedOut` and waits for sign-in.
- **Delta uploads.** Documents kept as chunks upload only chunks not in `syncedHashes`; if the server answers `missing-chunks` (a room rewrote the file whole), everything is sent once (`sendChunked`). Limits: 50 MiB per document (`MAX_DOCUMENT_BYTES`), 25 GB per account, history included (`ACCOUNT_STORAGE_BYTES`; a refusal's `storage-full` code becomes a translated message in `cloud.ts`, shown as the upload's failure), batches of 200 documents / 24 MiB for ZIP imports. During a batch the ordinary queue skips those ids (`batching`).
- **Settings sync.** Only keys in `SYNCED_KEYS` (preferences: theme, locale, shortcuts, spelling, view options) follow the account; layout, sizes, per-document view and dismissed notices do not. `planSync` three-way compares local, last-synced baseline and cloud; applying cloud values reloads the page once. Changes are polled every 2 s and sent as they happen. Stored per profile on the server (`/api/preferences`).

## Invariants and gotchas

- A save's thumbnail is not drawn with the save: it waits for 3 s without edits and an idle moment (`QuietRunner`, `client/src/quietRunner.ts`), because `readPage` stalls the GPU on the main thread. `saveIfEdited` flushes it first, so leaving a document still draws it; a document gone by then gets its thumbnail at the next open (`backfillThumbnail`). `chunkBytes`, the thumbnails and the pages panel's draws are timed as `golem:*` User Timing spans (`traced`), visible in a DevTools Performance recording.
- Save locally first, always. No code path may make a local save wait for the network. A version kept by a save is stored after the save (a small one) or inside its transaction as counters only (a chunked one), so history can cost a version but never a save.
- `getSaved` returns `null` for a chunked copy with a missing chunk: a damaged copy reads as no copy.
- `uploadToCloud` re-reads `cloudUpdatedAt` on a 409 and retries once before merging or making a conflicted copy, because another tab may have just uploaded.
- A merge is only ever written over a copy that hasn't changed since it was read (`rebaseSaved`), and the open document's saves wait for it: an editor save of what is on screen (without the cloud's changes) over the merge would quietly send the cloud's changes away.
- A conflicted copy keeps the browser's id linked to the *new* cloud document (`markSynced` with the new name).
- A new setting must be classified (synced or per device) when added; see `AGENTS.md`.
- Several tabs share one IndexedDB: `onversionchange` closes the connection so upgrades are not blocked.
- Thumbnails are uploaded only if `forUpdatedAt` equals the version just uploaded; failure to upload one never fails the save.

## Related docs

[Version history and the trash](../history.md) · [Formats](formats.md) (what is inside a stored `.wdoc`) · [Server](server.md) · [Collaboration](collaboration.md) · [Chunked storage](../chunked-storage.md) · [Text files](../text-files.md) · [Rendering](rendering.md) · [UI](ui.md)
