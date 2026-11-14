# Undo history kept on the device

Status: built for flowing documents (Word, Markdown, HTML and the rest). The other editors still keep their undo steps only while the document is open (see below). Tests: `ops/test/ops.test.ts` (a kept history walks back the same way on the reopened copy, with the recovered edits on top), `client/test/undoStore.test.ts` (the store) and `e2e/files/undo-history.spec.ts`.

## What it does

Undo and Redo keep working after a reload, a closed tab, a crash or the next day. Each document's undo and redo steps are kept in this browser's IndexedDB with its saved copy. They are never uploaded and don't follow the person to another device.

## How

The undo stack (`History` in `ops/src/history.ts`) already holds plain data: each step is the inverse operations of one or more transactions, plus the selection before and after. Paragraph ids survive a save and a read (see [edit-journal.md](edit-journal.md)), so the steps still fit the document when it is read again.

```
 save:  worker, as the body is written (the same synchronous stretch as the journal's seq):
          undo = history.saved()        JSON, oldest steps dropped to fit 2 MB; only when history.version changed
        page:  saveSaved({ bytes, journal, undo })     one IndexedDB transaction: meta, bytes, undo, undoData

 open:  getUndo(info)   only if it was written with this exact save (forUpdatedAt === info.updatedAt)
        worker.restoreUndo(undo) --> history.load()
        then the edit journal's kept edits, if any --> editor.external(ops, { undoable }) folded into one step
```

- **The steps always fit the bytes.** They are read in the same synchronous stretch as the body is written, so they describe exactly what the body holds, and they are written in the same transaction as the bytes. Edits made after that point are in the edit journal, and replaying them puts their steps on top.
- **Any other write drops them.** A save with no `undo` (a copy from the account, the vault file changed on disk, another tab's save with nothing to undo, a version put back, a merge) deletes them in its own transaction, and `getUndo` also checks `forUpdatedAt`. So an outside change ends the kept history, which is the simple choice: steps made for other bytes could put text in the wrong place.
- **While the document is open, nothing changes.** Changes from outside that arrive while it is open still move the steps (`History.map`), as before, and the next save keeps them.
- **Only changed steps cross from the worker.** The worker sends the JSON only when `History.version` has moved since the last save; `LayoutClient` keeps the last JSON for the open document (`saveMarked`) and hands it to every save.
- **Recovered edits undo as one step.** After a reload, the edits the [edit journal](edit-journal.md) brings back were this session's own, so Undo takes them back, all at once, as it would have before the reload.

## Limits

| What | Limit |
| --- | --- |
| A document's steps | the newest 500 (as in memory), and at most 2 MB of JSON (`HISTORY_SNAPSHOT_MAX`): the oldest go first |
| All documents together | 50 MB, or 20 MB on a phone (`undoBudget`); past it, the documents least recently saved or opened lose theirs (`trimUndo`, after each save that keeps steps) |

## Rules with the rest of the app

- **Rooms.** A room that is shared, or a document opened from a room's copy (someone else was already editing it), keeps no steps: the room's copy is the document, and the local one may differ. Alone in a room, it is as with no room.
- **Typing in progress.** The step being typed into is joined by the next keystrokes in memory. A kept one never is: typing after a reload starts a new step.
- **Privacy.** The steps hold deleted text. They stay in this browser, Clear Local Data deletes them with the rest of the database, and deleting a document deletes them.
- **The older shell.** Nothing here touches the shell.

## Not covered yet

| Editor | Today | Next |
| --- | --- | --- |
| Text files, large text | in-memory steps on the page | `TextOp`s are plain data too: the same store would do |
| Drawings, pictures | `layerSync` snapshots | steps can carry a lot of data: needs measuring |
| PDFs | `PdfAnnotator`'s lists of edits | whole lists, not steps; a redaction would have to drop the history so the text under it is really gone |
| Spreadsheets | their own engine | separate design |
| Script runs (Undo This Run) | the bytes before the run, for the page's lifetime | could become an ordinary undo step in each document they changed |
