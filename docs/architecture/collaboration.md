# Collaboration (multiplayer)

Cloud documents can be edited live by several people. Each document has one **room**, a Durable Object that orders everyone's edits into a single log and, while two or more people are editing, is the only writer of the document file. This doc covers the protocol and its modes, the client and server pieces, how saving interacts with rooms, and what happens on failure.

## How it works

The model is a central ordered log with optimistic clients (`ops/src/collab.ts`):

1. A client applies its own transaction immediately and submits it with the log `version` it was made against.
2. The room accepts a submission only if that `version` equals the log length, appends it, and broadcasts it to every synced client, including the sender (its own transaction ids are the acknowledgement). Anything else is ignored.
3. A client that receives others' transactions first knows it lost the race: it undoes its pending edits, applies the remote ones, replays its own mapped through them (`mapOperation`), and resubmits.

The room never interprets operations beyond validating their shape. Clients converge because every one applies the same log to the same starting file deterministically (see [Document model](document-model.md)).

### Who processes edits: modes

`ops/src/multiplayer.ts` defines the wire protocol. The room has three modes (`RoomMode`) so that a person editing alone never pays for the room:

```
solo      one person: they save the file themselves (autosave/upload as usual).
          The room only reports who else arrives (presence).
   │  a second person says hello
   ▼
handoff   room -> first client: {handoff, epoch}
          first client: serialize document, PUT /api/documents/:id, send {flushed}
          nobody edits through the room until then (clients freeze commands)
   │  flushed (or the flusher disconnects / 15 s deadline)
   ▼
shared    new epoch; log starts at version 0 on top of the file in the cloud.
          everyone sends {submit}; room orders, broadcasts, snapshots the file.
          clients no longer upload (the server refuses with 423).
   │  down to one person for 30 s (grace), room sends {settle}
   ▼
settle    last client answers {quiet} once nothing is unsent;
          room writes the final file, clears the log, epoch+1, sends {solo}.
```

Joining (`RoomClient.join`, `client/src/collab/roomClient.ts`): open the WebSocket, send `hello` (client id, name, colour, document `kind`), get `welcome`. Alone and solo: open your own copy (`RoomStart` kind `own`). Otherwise wait for `shared`, `GET /api/rooms/:id/document` (bytes plus `x-room-epoch`/`x-room-version`), open that, then `ready()` attaches the host and sends `sync {epoch, version}`; the room answers with the transactions after that version.

### Kinds of document

The first person into an empty room says what its changes are (`RoomKind`, stored in `RoomMeta.kind`), and the room validates and snapshots accordingly:

| Kind | Changes | Written by |
| --- | --- | --- |
| `doc` | `Operation`s on text | `Engine` in `snapshot.ts` (`applyAll`) |
| `text` | `TextOp` byte replacements (`ops/src/textOps.ts`, up to 16 MiB) | `applyTextOps` |
| `objects` / `layers` / `nodes` | `put`/`del` of keyed objects (`ops/src/objects.ts`): PDF markup, picture shapes, drawing nodes | `applyObjects` rewrites one `.wdoc` extension entry |

Presence (`presence` carets as `Selection` with paragraph ids, `pointer` mouse positions) is relayed and never logged. Carets are mapped through incoming changes in the worker (`Replica.mapSelection`).

## Alone in a room is the same as no room

A signed-in session joins its document's room, but another device of the same account is just a second session, so a person alone in a room must see exactly what a guest sees. Nothing may wait for the room, be refused, be set up differently or become read-only because a room exists, was asked for, or could not be reached. Only a room that is actually shared (`mode === 'shared'`) may change what a document does:

- The page asks `sharedLive()` (`client/src/main.ts`: `current.room?.mode === 'shared'`) and the layout worker uses `shared`; features that cannot work while others edit (picture pixel edits, embedding a drawing in a shared Markdown note, PDF page moves) check these, never the mere existence of a room.
- In `solo` the client saves as usual, and the server's save guard (`roomAllowsSave`) only refuses in `shared` mode.
- A room that cannot be reached while alone is let go, not treated as an outage: `RoomClient.alone()` is `mode === 'solo' && !attached && !handoff`, and when reconnects run out it calls `lose()`, which calls `RoomHost.lost()`. The layout worker's `lostRoom()` leaves the network, clears the people and posts `roomGone`, and the document goes on as if it had no room. The next save joins again. The text editor does the same through `textSync.ts`.
- A room that cannot be rejoined while shared or mid-handover, or whose state changed while away, goes to `offline` (see Failure and reconnect behavior).

## The "one room gateway, one transport" design

Commit `a6d62c7a` ("Contain multiplayer") removed every second way to reach a room:

- **Server:** `server/src/roomGate.ts` is the *only* module that talks to the room Durable Object. Routes call `joinRoom`, `roomAllowsSave`, `endRooms`, `kickFromRoom`, `rejoinRoom`; none of them builds a room request, knows room paths, or checks whether `env.ROOMS` exists (a server without rooms answers as if nobody were editing). `roomHeaders` is the single place the trusted `x-user`, `x-role`, `x-owner`, `x-doc`, `x-picture` headers are set, replacing whatever the client sent.
- **Client:** `client/src/collab/cloudRoom.ts` (`cloudRoomTransport`) is the single WebSocket + document-fetch transport, used by the layout worker (`joinNetwork`) and the text editor (`textEditor/textSync.ts`). The old SharedWorker "dev rooms" (`devServer.ts`, Share > Get Link, `?room=` links) are gone. Local development gets rooms from the simulated Durable Object in `wrangler dev --local`.
- **Client hosts:** `RoomClient` knows nothing about documents; it needs a `RoomHost`. The layout worker builds three hosts that share one `presenceHost()`: `roomHost()` (text documents, via `Replica`), `layersRoomHost()` (pictures and drawings, via `ObjectSync`), `pdfRoomHost()` (PDF markup). The text editor has its own host in `textSync.ts`.
- `CollabServer` (`ops/src/collab.ts`) remains only as the in-memory reference server for tests (`ops/test`, `editor/test/fuzz.test.ts`, some `client/test` specs).

## Key files

| Path | Role |
| --- | --- |
| `ops/src/collab.ts` | `CollabClient` (pending/rebase), `CollabServer` (test reference), `ClientMessage`/`ServerMessage` |
| `ops/src/multiplayer.ts` | Wire protocol: `MultiplayerClientMessage/ServerMessage`, `RoomMode`, `RoomRole`, `Person`, `ROOM_CLOSE` codes |
| `ops/src/objects.ts`, `textOps.ts` | Object-list and plain-text change kinds, `ObjectReplica`, `TextReplica` |
| `ops/src/replica.ts` | `Replica.connect/receive/resubmit/sync` |
| `client/src/collab/roomClient.ts` | `RoomClient` state machine, `RoomHost`, reconnect, handoff |
| `client/src/collab/cloudRoom.ts` | `cloudRoomTransport`: WebSocket URL and `fetchDocument` |
| `client/src/collab/roomMedia.ts` | `networkMedia`: picture bytes by hash (`/api/rooms/:id/media/:hash`) |
| `client/src/layout/layoutWorker.ts` | `joinNetwork`, `joinLate`, room hosts, read-only rule, picture sharing (`addMedia`) |
| `client/src/layout/objectSync.ts` | Client side of object-list rooms |
| `client/src/main.ts` | `roomStateChanged`, `networkRoom`, `joinTextRoom`, `sharedEdited`/`uploadShared`, `resumeAfterRoom`, `rejoinWhenBack` |
| `client/src/ui/shareDialog.ts` | Owner shares by email as editor or viewer |
| `server/src/worker.ts` | Routes `/api/rooms/:id` (WebSocket), `/document`, `/media/:hash`; auth, origin check, access, owner sync |
| `server/src/roomGate.ts` | The only door to the room |
| `server/src/room.ts` | Durable Object `Room`: sockets, SQLite `log` and `kv` tables, `CloudFiles` |
| `server/src/roomCore.ts` | `RoomCore`: all rules, no Cloudflare (testable in Node) |
| `server/src/snapshot.ts` | `applyLog`: base file + transactions -> new file |
| `server/src/roomMedia.ts` | Picture bytes in R2, named by SHA-256 |
| `server/src/sharing.ts` | `accessFor`, `Role`: who may open a document |
| `server/src/documents.ts` | Share/unshare routes (kick/rejoin), `PUT` guarded by `roomAllowsSave` |

## Key data types

- `Transaction {id, client, ops}`; the room's log is an ordered list, version = length. Ids are unique, so resubmission after reconnect is idempotent.
- `RoomMeta` (`roomCore.ts`): `epoch`, `mode`, `snapshotVersion`, `handoffDeadline`, `flusher`, `settleAt`, `snapshotDue`, `kind`; stored in the `kv` table.
- `PeerState`: `userId`, `role`, `client`, `name`, `picture` (from the account, never from the client), `color`, `selection`, `pointer`, `synced`. Persisted as a WebSocket attachment so it survives object eviction.
- Roles: `owner | editor | viewer` (`RoomRole`, `sharing.ts` `Role`).
- Epoch: each shared stretch is an epoch; every message carries it and messages from an old one are ignored. `solo` and `end()` bump it.
- Timings (`DEFAULT_TIMINGS`): handoff 15 s, snapshot 5 s after the first unsaved edit (3x for `text`), grace 30 s before winding down.

## How saves interact with rooms

- **Solo:** the client saves as usual (`documentEdited` -> browser autosave; `sharedEdited` -> `uploadShared` for a document opened from someone else's account, 2 s after an edit; `uploadQueue.ts` for the account's own copies).
- **Shared:** the room is the single writer. `RoomCore.snapshot()` reads the file, `applyLog` applies `store.slice(snapshotVersion)`, and `CloudFiles.write` stores the bytes in R2 (clearing any chunked form) and bumps `documents.updated_at` strictly upward. Snapshots and `document()` reads are serialized on one queue so a read never sees a half-written pair.
- **History:** a room's snapshot (`CloudFiles.write`) gives the file it replaces to `checkpoint` first and keeps the chunks a checkpoint names, like a `PUT`. Restoring a version never goes through a room: it makes a new document, so it needs no handoff.
- **Guard:** `PUT /api/documents/:id` calls `roomAllowsSave` (`roomGate.ts` -> `GET /state` -> `maySave`, false only in `shared` mode) and answers **423**. The client treats 423 as "the server has it": `uploadShared` and `uploadQueue.ts` drop the upload, and `roomStateChanged` calls `uploads.forget` when a room goes shared. 409 is a different thing (changed elsewhere, answered with a conflict copy).
- **Back to solo:** when the room sends `solo`, `resumeAfterRoom` makes the server's last version the base the local copy continues from.
- **Pictures:** a picture added while shared is stored by hash through `/api/rooms/:id/media/:hash` (PUT checks the SHA-256, 25 MB cap, editors only), the transaction names only the hash, and the snapshot writes the bytes into the `.docx` (`applyAll`); the room clears the media when the epoch ends.
- **Snapshot failure** keeps the log and retries (3x the interval); `applyLog` falls back to applying transactions one at a time and drops any that fail, so one hostile transaction cannot block the room forever.

## Sharing permissions and rooms

- The Worker authenticates, checks `Origin` on the WebSocket handshake (cookies ride on cross-site handshakes), calls `resolveAccess`, and requires the **owner** to have sync (`requireOwnerSync`) because the room writes into the owner's storage, whoever joins.
- The role travels to the room as `x-role`; the room never trusts the client. Viewers are accepted into the room but a viewer `submit` closes the connection (`badMessage`); in the worker `readOnly` also blocks local edits.
- Changing a role calls `rejoinRoom` (closes with `stale`, client reconnects with the new role). Removing someone calls `kickFromRoom` (closes with `revoked`). Deleting a document calls `endRooms` (revoked, then `store.wipe()`).
- Presence `picture` comes from `pictureOf(env, userId)`, only on the WebSocket join.

## Failure and reconnect behavior

- `RoomClient.onClose`: codes `revoked` (4003) and `badMessage` (4004) are final (`giveUp()`); otherwise it retries after 0.5, 1, 2, 4, 8 s. When the retries run out it calls `lose()` if the client is alone (the document continues as if it had no room, see above) and `giveUp()` otherwise. `stale` (4002, used for a role change or an out-of-date `sync`) is retried: a role change then rejoins at the same epoch and continues with the new role.
- On reconnect it only continues if the room is where it left it (shared and same epoch if it was attached; solo and alone if not). It then sends `sync` with its version, and on the next `transactions` message calls `host.resubmit()`. "Alone" does not count its own client id: after a sleep the room may still list the old connection. If it was alone and someone else is there now, it calls `lose()` (the document stays editable; the next save joins and hands over) rather than going read-only. Otherwise `giveUp()`: mode `offline`, host detached, editing disabled (`canEdit` false) but the screen is kept; `rejoinWhenBack` in `main.ts` retries later.
- The server lets go of a ghost: a `hello` from a client id (and account) already in the room closes the older connection with `ROOM_CLOSE.replaced` and drops it without a departure, so a session coming back from a sleep is never counted twice. The client ignores a `replaced` close.
- `handoffFailed` (4001): the flusher did not upload in 15 s; the room closes it and carries on without its edits. The flusher's local document is not lost but is only merged later as a separate copy.
- Joining times out after 20 s (`joinMs`); `joinNetwork` then returns null and the document is edited as a plain one.
- A disconnect from a shared room with fewer than two people left starts a 30 s grace period (`settleAt`) so a dropped connection can come back before the epoch ends.
- Durable Object eviction: the log and meta are in SQLite, peer state in WebSocket attachments, `Room`'s constructor re-adds open sockets, and an alarm drives snapshot, handoff deadline and settle.

## Invariants and gotchas

- **Only `roomGate.ts` may call `env.ROOMS`.** New routes that need room behavior add a function there.
- **Alone must behave like no room.** Gate behavior on `mode === 'shared'` (`sharedLive()`, `shared`), never on whether a room exists or connected.
- **Every route that writes a document's file must ask `roomAllowsSave` first.**
- **Everything the room receives is untrusted.** `submit` validates transaction count (500), ops per transaction (5000), op shape (`isOperation`/`isTextOp`/`isObjectOp`), message size (4 MB) and, for text, 1 MB per transaction. New operation types must be added to the validators or the room will close the sender.
- **Apply must be deterministic and total.** If a new operation reads anything but the document and its own fields, rooms will diverge.
- `RoomCore` must stay free of Cloudflare types (it is tested in Node: `server/test/roomCore.test.ts`, `room.test.ts`, `multiplayer*.test.ts`, `roomText.test.ts`; client: `client/test/roomClient.test.ts`).
- A room starts each epoch from the file in R2 at that instant, so a client must upload (handoff) *before* the room goes shared, and nothing but the room may write while shared.
- Messages for the wrong epoch are dropped silently on both sides; always carry the epoch.
- Undo is per user (`History`/`TextReplica`/`ObjectSync`) and applied as a new transaction, so it never undoes someone else's work.
- PDF, picture and drawing rooms merge by object id (last writer wins per object); there is no operational transform for them.

## Related docs

- [Document model and editing](document-model.md)
- [Large text files](../text-files.md) ("Editing together")
- [PDF editing](../pdf-editing.md)
- [Chunked storage](../chunked-storage.md)
- [Formats](formats.md)
- [`ops/README.md`](../../ops/README.md) (protocol summary; its mention of `client/src/collab/devServer.ts` is stale)
