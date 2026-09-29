# @word/ops

Edits as operations: undo and redo, and collaboration through a central server.

## Operations

`Operation` (src/types.ts) is plain JSON. It addresses paragraphs by id and positions by model offset:

- **Paragraph ids** are Word's `w14:paraId`, stored in the file. Paragraphs without one get one deterministically on load (`DocumentIndex`), so every client loading the same bytes agrees.
- **Model offsets** count each UTF-16 unit of text as one position, and every other run item (tab, break, drawing, field character) as exactly one. They depend only on the model, never on fonts or layout.

`Engine.apply(ops)` returns:

- each operation's inverse;
- a position map;
- the changed paragraphs, for re-layout.

Application is deterministic. Paragraphs are kept in canonical form (`normalizeInlines`), so identical content has identical structure however it was produced. An operation that no longer applies (its paragraph is gone) does nothing, and does so identically everywhere.

| Operation | Inverse |
| --- | --- |
| `insertText`, `insertItem`, `insertContent` | `delete` |
| `delete` | `insertContent` (the removed content) |
| `split` | `merge` |
| `merge` | `split` (with the second paragraph's properties) |
| `removeBetween` | `insertBlocks` |
| `insertBlocks` | `removeBlocks` (by block key) |
| `setParagraphProperties` | `setParagraphProperties` |

## Collaboration protocol

The server keeps an ordered log of transactions. Its version is the log's length.

```
client → server  { type: 'submit', version, transactions }   // made against `version`
server → all     { type: 'transactions', version, transactions }  // appended after `version`
```

1. A client applies its own transactions immediately and submits them with the version they were made against.
2. The server appends a submission only if its `version` is still current. It then broadcasts the transactions to every client, including the sender; for the sender, its own transaction ids are the acknowledgment. Any other submission is ignored.
3. A client that receives someone else's transactions first knows its submission was rejected. It undoes its pending transactions, applies the remote ones, reapplies its own mapped through them (`mapOperation`, with mirrored maps so positions inside its own text survive), and submits again.

The server never interprets operations. Clients converge because every one of them applies the same log to the same snapshot, and application is deterministic. `CollabServer` is the reference implementation (in memory).

A networked server adds the following:

- **Transport**: a WebSocket per client, with messages as above.
- **Joining**: send the snapshot (.docx bytes) and the log since it (`Welcome`).
- **Persistence**: append the log durably. Snapshots can be taken by applying the log with `Engine` and writing a .docx at version N; new clients then get that snapshot plus the log after N. Paragraph ids are in the file, so the log stays valid across snapshots.
- **Resubmissions**: the server skips transaction ids it has already logged, so a client that reconnects can safely resubmit its pending transactions.
- **Presence**: carets and names are relayed but not logged (see client/src/collab/messages.ts).

The networked server is `server/src/room.ts` (a Durable Object per cloud document) with its rules in `server/src/roomCore.ts`; the wire protocol is `src/multiplayer.ts`. Who processes edits depends on how many people are in the room: alone, a client saves the .docx itself; when a second person arrives the room takes over, ordering transactions and writing the .docx (see the header of `multiplayer.ts`). Access is checked by the Worker (`server/src/sharing.ts`) before a connection reaches the room.

`client/src/collab/devServer.ts` still runs `CollabServer` in a SharedWorker, so tabs of one browser can share a room without a server: open a document and choose **Collaborate**.

## Undo and redo

`History` keeps the inverses of each user's own transactions. Typing within 1.5 s, continuing where the last edit ended, forms one undo step. Undo applies the inverse as a new transaction, so in a shared document it's an ordinary edit.

When remote edits arrive, undo entries are moved through them. For the most recent entries this is exact; older entries are adjusted only approximately (see `History.map`).

## Tests

`test/ops.test.ts` covers:

- every operation's inverse restoring the document exactly;
- undo and redo across the whole history;
- concurrent clients converging: random edits, undo and redo, and random message delivery against the server, checking every client against a replay of the log.

Deeper runs: `STRESS=10`. A fixed seed with a check after every event: `SEED=n CHECK=1`.
