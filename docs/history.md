# Version history and the trash

A document keeps its earlier versions, and a deleted document stays recoverable for 30 days. Two stores hold versions: this browser's IndexedDB (everyone, signed in or not) and the account's R2 (people with sync, which is the paid plan). Both follow the same rules, which live in one place, `ops/src/versionPolicy.ts`, so the two cannot drift.

**Restoring never overwrites anything.** Opening a version makes a *new document* from its bytes; the document the version came from is not touched. That is why anyone who can edit a shared document may restore from it (the new document is the restorer's own, in their account) and why restoring needs no care around editing together: a room is never asked to take an old file back.

## The rules (`ops/src/versionPolicy.ts`)

A **checkpoint** is the file as it was before a save replaced it. Nothing runs on a timer: a save decides, from the version it is replacing, whether to keep it (`shouldCheckpoint`):

- the document has no checkpoint yet (the first overwrite keeps the original), or
- the replaced version ended a burst of editing: `CHECKPOINT_GAP` (10 minutes) passed since it was saved, so this save starts a new burst, or
- a long burst has run `CHECKPOINT_GAP` since the last checkpoint, or
- the save makes the document less than half its size (an accidental select-all-delete is recoverable; documents under 2 KB are not judged by it).

Autosave saves every second or two, so a burst of editing costs one checkpoint, not hundreds. `versionsToDrop` thins what is kept: everything for the last hour, one per hour for a day, one per day for a month, one per week for three months, nothing older. The newest three unnamed versions are kept whatever their age (the state before the latest edits matters most after a long silence), and a **named** version (File › Version History › Save Version) is exempt from age and bytes. Caps: 50 unnamed and 100 named per document on the server (`CLOUD_LIMITS`), 20 and 50 in the browser (`LOCAL_LIMITS`); and a byte budget per document (`byteBudget`: eight times the document's size, at least 5 MiB). A document kept as chunks counts a tenth of its size per version, because most of it is shared with its neighbours.

## In the account (`server/src/versions.ts`, `trash.ts`)

- A checkpoint is an R2 object `<owner>/<doc>.history/<version>` (`version` is the replaced file's `updated_at`) and a row in the owner's `versions` table (user migration 5; `name` is set for named ones, `chunked` marks a manifest).
- History lives in the account's storage limit ([server.md](architecture/server.md), `storage.ts`): a checkpoint that would take the account past it first lets go of the account's oldest automatic versions, and is not taken when documents fill the account. Named versions count against the limit like documents and are never removed to make room.
- The checkpoint is taken in the save path **before** the bytes are overwritten, in `PUT /api/documents/:id` (`documents.ts`) and in a room's `CloudFiles.write` (`room.ts`). It never fails the save: a failure is logged and the save goes on. It is skipped if the file's etag is no longer the one the save saw. Pruning runs after the save, where it can wait for the response (`defer`).
- **Chunked documents** (2 MiB and over, see [Chunked storage](chunked-storage.md)) are checkpointed as their manifest alone. A save used to delete the chunks it dropped, and a room's whole-file write all of them; now `chunksToDelete` / `retainedChunks` leave every chunk a checkpoint still names, and `removeVersions` frees the ones only the removed checkpoints named. So a checkpoint of a 50 MB document costs only what changed.
- Only people with sync save to the cloud, so history needs no check of its own. Reading history needs only access to the document (viewers may look); saving a named version, renaming, deleting and restoring need edit access. Restoring is `POST /api/documents/:id/versions/:version/restore`, which makes a whole-file document in the **caller's** account (their sync is required, not the owner's).
- API: `GET/POST /api/documents/:id/versions`, `GET/PATCH/DELETE …/versions/:version`, `POST …/versions/:version/restore`.

### The trash

Deleting a document (`deleteDocuments` in `documents.ts`) moves its catalogue row to the owner's `trash` table in the same transaction that deletes it from `documents`; its files, history, pictures and chunks stay in R2. Its owner and share rows are forgotten at once, so nobody can open it meanwhile, and restoring makes it the owner's again, **unshared**, at the top level if its folder is gone. There is no scheduler: what has been in the trash 30 days (`TRASH_MS`) is purged whenever the owner lists their trash or deletes something. `DELETE /api/trash/:id` and `DELETE /api/trash` delete for good. API: `GET /api/trash`, `POST /api/trash/:id/restore`.

## In this browser (`client/src/storage/local.ts`, "History")

IndexedDB version 6 adds `history` (document id → its versions, newest first, small) and `historyData` (`<id>/<version>` → the bytes of a small version, or the manifest of a chunked one). A save keeps a version by the same rules (`versionDue`, before it, while the old copy can still be read):

- a small document's version is a copy of its bytes, stored **after** the save went through in its own transaction (`keepWhole`), so a full disk costs the version, never the save;
- a chunked document's version is a *hold* on its chunks: one more count in `chunkRefs` per chunk, taken in the save's own transaction before it lets go of the chunks it drops (`holdChunked`). Nothing is copied, so it costs only a few counters.

Deleting a document for good deletes its history (`forgetHistory`). `listVersions`, `getVersion`, `keepVersion`, `nameVersion`, `deleteVersion` are the API.

### The local trash

A document the person deletes is not deleted when no account's trash is keeping a copy (a guest's document, or an account's that has no cloud copy): `trashSaved` moves its catalogue record from `meta` to the `trash` store (IndexedDB version 7), so every list stops showing it, and leaves its bytes, chunks, history and thumbnail where they were. A document that has a cloud copy is deleted here for good, because the account's trash keeps it (`deleteEntries` in `main.ts`). `restoreTrashedSaved` moves the record back (a document made while signed out comes back as the signed-in person's and is uploaded, as adopting at sign-in does); `purgeTrashedSaved` and `deleteSaved` delete for good. What has been there 30 days (`TRASH_MS`, in `@golemdocs/ops` for both trashes) is deleted when the trash is next listed. Signing out deletes the account's trashed copies with its other copies (`deleteOwnedBy`); Clear Local Data deletes the whole database.

## The app (`client/src/history.ts`, `ui/versionHistoryDialog.ts`, `ui/trashDialog.ts`)

File › Version History lists this browser's and the account's versions of the open document together (each marked *On this device* or *In your account*, so one moment may appear twice). A source that cannot be reached (offline, no subscription) is reported and the other still shows. File › Trash and a Trash button on the Documents screen (the menu bar is behind it) open the trash, which lists this browser's and the account's deleted documents together (`client/src/trash.ts`: each marked *On this device* or *In your account*; the account's failing does not hide this browser's). Both are modal dialogs, so a confirmation asked from inside one (`confirmDelete(…, parent)`) is put inside it: everything outside a modal dialog is inert.

## Cost

R2 charges for writes and storage, not for reads out. A checkpoint is one read and one write per burst of editing, not per save; a document kept as chunks adds only its changed chunks; thinning bounds the count and the byte budget bounds the size. The guest (signed-out) history costs nothing: it is the person's own disk.

## Known limits

- A prune racing a delta upload of the *same* document by another tab could delete a chunk the upload counted on; the document then reads as damaged until saved again whole (`missing-chunks` makes the client send everything). It needs two tabs saving one big document while an old checkpoint is being thinned.
- A refused save (a corrupt delta, a stale base) may still have taken the checkpoint it checked first; it is a real version, and a second attempt finds it already kept.
- The trash is purged lazily, so an owner who never returns leaves their trashed files in R2 until they do (and a browser's trash is purged when it is next opened).
- Versions in the account and in this browser are not reconciled: they are made by different clocks, so they do not line up.
