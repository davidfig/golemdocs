# Plan: an edit journal, so a reload doesn't lose the last edits

Status: design, not built. The parked test it answers is `e2e/files/persistence.spec.ts` › "edits made right before a reload are not lost".

## The problem

Autosave waits for a 1 second pause in typing, and at most 10 seconds (`AUTOSAVE_DELAY_MS`, `AUTOSAVE_MAX_WAIT_MS` in `main.ts`). A reload or a closed tab in that window tries a last save on `pagehide`, but the document is in the layout worker: the page asks the worker for the bytes (`saveInBrowser`), and the page and the worker are gone before the answer comes back. Whatever was typed since the last save is lost, so continuous typing could lose up to 10 seconds (the test covers the 1 second case).

The page can't wait during unload. What it can do during unload, or at any moment, is write to `localStorage`, which is synchronous. So what is needed is for the page to already hold what has changed since the last save.

## The design in one paragraph

Every edit to a flowing document already passes through `Replica` as a list of serializable `Operation`s. The worker posts each transaction's operations to the page, which appends them to `localStorage` straight away. Each save records, in the same IndexedDB transaction as the bytes, how far through the journal those bytes reach. Opening a document replays whatever the journal holds past that point, through the normal edit path, and the normal autosave then writes the result. The journal is only ever a few seconds long: a save empties it.

```
 key --> page --postMessage--> worker: Replica.transaction(ops), seq n
                                  |
          page <--{journal, n, ops}--+
            | localStorage.setItem (synchronous)
            v
  golemdocs.journal.<docId>.<session> = { base, entries: [{ n, ops }...] }

 save:  worker takes seq at the moment the body is serialized --> saved { bytes, seq }
        page: saveSaved({ bytes, journal: { session, seq } })  (one IndexedDB transaction)
        then drops entries <= seq

 open:  getSaved(id) --> journal entries past info.journal.seq --> Replica.external(ops) --> documentEdited()
```

## What was checked (2026-11-04)

Throwaway experiments against `ops` and `docx`, plus reading the code. None of this has run in the app yet.

| Question | Answer |
| --- | --- |
| Do operations go through one place? | Yes. `Replica.transaction()` is called by `edit`, `external` and `replay` (undo and redo). Others' changes arrive through `receive`, which doesn't call it |
| Do paragraph ids survive a save and read? | Yes, for what the app stores. Ids are `w14:paraId` in the paragraph, and paragraphs without one get one deterministically on load. `save` in `layoutWorker.ts` always writes a `.wdoc` holding the model's lossless `document.docx`, so this holds for Markdown, HTML and the rest too, not just Word |
| Does replay reach the same document? | Yes. Insert, format, split, delete, merge, two undos and a redo, through JSON, onto a document read from the earlier save: same paragraphs, ids and text, and the same model after saving and reading both |
| Does undo need anything special? | Only that it is journaled. An experiment that left one out diverged. `replay` returns ordinary operations, so the hook in `transaction()` catches it |
| What does an operation on a missing paragraph do? | Nothing, and it doesn't throw |
| How big is it? | 683 bytes for those 8 edits, as JSON |
| Can a save and an edit overlap? | Yes, see the next section. This is the real risk |

## The rule that keeps replay safe: never apply an edit twice

`WordDocument.write()` is asynchronous, and `save` awaits `turn()` and `fetchMissingMedia()` before it. An edit arriving in between ends up in the bytes: in the experiment, an edit made in the same tick as the `write()` call was in the file, and one made a microtask later was not. So the sequence number can't be read before the save or after it. Replaying an edit the bytes already hold would duplicate text.

**The sequence number is taken in the same synchronous stretch as `writeBlocks(this.body, ...)`** (a small hook on `write()`), so it says exactly which edits the body holds. What is written after that point and can hold later edits (styles, numbering, comments, properties) changes through `setStyle`, `setList`, `setComment` and `setDocumentProperties`, which replace rather than add, so replaying them lands in the same place. `setDocumentSection` is written in the same stretch as the body.

**The marker goes in the same IndexedDB transaction as the bytes** (a new optional `journal` field on `WriteInput` and `SavedInfo`; no migration). Crashing between the save and the clean-up then does no harm: entries at or below the marker are simply ignored.

## Opening a document

`openLocal` and `openCloud` are where a stored copy becomes the open document; both consult the journal once `getSaved` or `openFromCloud` has answered. For each journal of this document:

1. **Its session is alive** (another tab): leave it alone. Each session holds a Web Lock named after it for its lifetime, and `navigator.locks.query()` tells the two apart. Where Web Locks are missing, nothing is journaled.
2. **The stored copy's marker names this session**: replay entries past its `seq`.
3. **No marker from this session, and `info.updatedAt` equals the journal's `base`**: nothing else has written; replay everything.
4. **Anything else** (another tab saved, the account's newer copy arrived, the vault file changed): replaying over a different base could put text in the wrong place, and without the base there is nothing to merge against. Following "nothing is ever overwritten" (`storage-and-sync.md`), the current copy opens untouched and the edits are replayed into a new `(conflicted copy)` (`conflictCopyName`), with a notice. This should be rare.

Replay is `replica.external(ops)`: Undo doesn't take recovered edits back, as after any reload. The worker sets `edited`, so a room's copy doesn't replace the document, and the page calls `documentEdited()`, so the normal save and upload follow. An entry that fails `isOperation` (a newer deploy's format, read by an older page) stops replay there, keeping what came before it, and says so.

## What can't go in the journal: barriers

Some changes to a flowing document aren't operations, or aren't small:

- a picture added (`document.addImage`: its bytes are in the package, not in the operation);
- a change of format, or of an extension (`.wdoc`'s `extensions/`);
- a transaction over 64 kB as JSON (a large paste), or a journal over 512 kB, or `setItem` throwing because storage is full.

Each writes a barrier and asks for an immediate save. Replay stops at a barrier, so what comes back is always a consistent earlier state: never later edits without the ones they build on. That is no worse than today.

## Rules with the rest of the app

- **Multiplayer:** journaling depends only on `sharedLive()`-style sharing. Alone in a room it behaves as with no room, as `AGENTS.md` requires. A room that becomes shared stops the journal and clears it, because the room holds the edits from then on. A document shared by someone else (`current.shared`, no copy in this browser) has no journal in the first version.
- **The older shell:** nothing here touches the shell.
- **Privacy:** the journal is document text in `localStorage`, next to the IndexedDB copy on the same origin. `clearLocalData` already calls `localStorage.clear()`. Deleting a document removes its journals. `settingsSync.ts` only syncs `SYNCED_KEYS`, so none of this leaves the browser.
- **Other pages' sweep:** at startup, journals of documents that no longer exist are removed. See the open questions for the ones that do.

## Limits, stated plainly

- **The last few milliseconds.** A key is in flight to the worker and back. If the page dies inside that round trip, or the worker is busy, that key is lost. The window shrinks from seconds to (usually) milliseconds; it doesn't reach zero. The parked test may need to wait for the journal message before reloading, which would be a truthful statement of this limit.
- **A browser or machine crash.** `localStorage` survives a reload and a tab or renderer crash. Browsers flush it to disk on their own schedule, so power loss can still lose recent edits.
- **Edits not yet on other devices.** Journaled edits stay in this browser until the document is next opened here.

## Other editors

The journal is built for flowing documents first. Each other editor has its own edit model, so each would need its own entries. Whether and how much each loses today has not been measured: step one of each is a test.

| Kind | Where edits live | Fit |
| --- | --- | --- |
| Flowing (Word, Markdown, HTML, ODT, RTF...) | Worker, `Replica` | This design |
| Text files | Page, `TextDocument`; `TextOp` with a pure `applyTextOps(base, ops)` exists | Easy: no worker round trip, so no gap at all |
| PDF | Worker, `PdfAnnotator`'s lists of edits | Medium: state is whole lists, not steps |
| Drawings, pictures | Worker, layers and `layerSync` | Medium: strokes can carry a lot of data |
| Spreadsheets | Their own worker and engine | Separate design |

## Alternatives

- **Warn on leaving (`beforeunload`).** Small, but it interrupts people for a save that usually would have finished, saves nothing by itself, and its behavior in the desktop and iOS shells is unknown.
- **Save more often.** Narrows the window without closing it, and serializes the whole document each time, which large documents can't afford.
- **Journal the commands the page sends** instead of operations. The page has them with no round trip, which would close the millisecond gap, but they depend on the selection and on page ids, so replay can't be trusted.
- **Have the worker write to IndexedDB on `pagehide`.** Workers die with the page, and a transaction in flight may die with them.

## The change

| Where | What |
| --- | --- |
| `ops/src/replica.ts` | An `onTransaction` listener, called from `transaction()` |
| `docx/src/docx/document.ts` | `write()` reports when the body is serialized |
| `client/src/layout/layoutWorker.ts`, `protocol.ts` | Post `journal` messages and barriers; `saved` carries `seq`; replay on open |
| `client/src/storage/editJournal.ts` (new) | Keys, append, prune, the open decision above as a pure function, startup sweep |
| `client/src/storage/local.ts` | `journal` on `WriteInput` and `SavedInfo` |
| `client/src/main.ts` | Session and its Web Lock; wiring in `saveInBrowser`, `openLocal`, `openCloud`, delete |
| `docs/architecture/storage-and-sync.md` | The journal and its rules, once built |

Probably 300 to 400 lines plus tests. It stays out of the lazy-loading question: it is always needed and small.

## Tests

**Unit:**
- A randomized edit, undo and save sequence: replay onto the last save always equals the live document, with edits landing during `write()`.
- Every branch of the open decision.
- Barriers, quota errors and unknown operations.

**e2e (`e2e/files/persistence.spec.ts`):**
- Un-park the test.
- Undo before the reload.
- Enter, formatting and a table before the reload.
- A picture then typing: comes back up to the barrier, no broken picture.
- Reload twice in a row: nothing doubled.
- Two tabs on one document: the second doesn't take the first's journal.
- A copy changed underneath: a conflicted copy appears and the original is untouched.

**Measure before shipping:** the time added per keystroke in a long document (JSON plus `setItem`); budget under 1 ms.

## Build order

1. The journal and replay for flowing documents, behind no flag once the tests pass. Includes the `write()` hook and the IndexedDB marker, which are what make it safe.
2. Text files, which are cheap once the module exists.
3. Measure what the other editors lose, then decide.

## Open questions

1. **Recover at startup, or only when the document is next opened?** Next open is simplest. The catch: close a tab mid-edit, then edit that document on another device, and the conflict copy appears much later. Recovering at startup means opening documents in the background; I'd start with next open, plus the last open document, which a reload reopens anyway.
2. **Does recovery say anything?** A quiet recovery is what people expect of a reload; a notice only for a conflicted copy or an incomplete replay.
