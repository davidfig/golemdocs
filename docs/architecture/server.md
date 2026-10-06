# Server

`server/` is one Cloudflare Worker that serves the API under `/api/*` (the built client is served as static assets, with the Worker run first only for `/api/*`) and hosts the collaboration Durable Object. It does sign-in, per-user cloud catalogues in D1, document files in R2, sharing, subscriptions, the assistant and admin pages. It never edits documents itself outside a room: it stores the `.wdoc` files the client uploads.

## How it works

```
 browser --/api/*--> worker.ts  (server/src/worker.ts)
   health, /api/auth/*, /api/webhooks/polar         (no session)
   authenticate (session cookie -> user id)  ->  same-origin check on writes
      /api/rooms/:id[/document|/media/:hash] -> sharing.resolveAccess -> roomGate -> Durable Object `Room`
      /api/subscription|checkout|portal      -> subscriptions.ts
      /api/assistant[/search]                -> assistant.ts, search.ts (Workers AI + Vectorize)
      /api/admin/*  (isAdmin, checked once for the prefix) -> billing, analytics, feedback
      /api/feedback, /api/preferences
      /api/folders, /api/documents, /api/shared -> folders.ts, documents.ts

 Storage
   D1  DIRECTORY (migrations/directory)  users->database_id, identities, sessions, document_owners, shares,
                                          subscriptions, feedback, assistant_usage, doc_index, catalogue_cache
   D1  one database per user (schema.ts)  documents, folders, preferences   (created via Cloudflare REST API)
   R2  FILES   <owner>/<doc>.docx | .thumb | .idx | .chunks/<sha256> | .media/<hash>
   DO  ROOMS   one per document: transaction log in its own SQLite
   Vectorize VECTORS (embeddings), AI (Workers AI)
```

Every route throws `HttpError(status, message, code?)` (`http.ts`); `worker.ts` turns it into `{ error, code }`. Cloudflare REST rate limits (`CloudflareError` 429) become a 429 with `retry-after` (max 300 s), which `client/src/cloud.ts` `send` waits out and retries.

## Accounts, sessions, providers

Hand-rolled OAuth/OIDC (no libraries); setup per provider in [server/AUTH.md](../../server/AUTH.md).

- `providers.ts`: Google, Microsoft, Apple (OpenID Connect) and GitHub (OAuth 2), authorization-code flow with PKCE where honoured. A provider is offered only when all its secrets are set.
- `authRoutes.ts`: `/api/auth/providers|start/:p|callback/:p|me|logout`. The flow state/nonce/verifier is kept in a short-lived cookie; the optional `?return=` path is the page to come back to. The `dev` provider (and `DEV_USER` shortcut in `auth.ts`) exist only when `ENVIRONMENT !== 'production'`.
- `accounts.ts`: `userForProfile` maps (provider, subject) to a user. A new provider identity joins an existing user only when both vouch for the same *verified* email. `isAdmin` checks `ADMIN_EMAILS` against verified emails.
- `session.ts`: the cookie holds a random token; D1 `sessions` holds only its SHA-256 (`SESSION_TTL_MS` 30 days). `__Host-` cookie prefix over HTTPS. Revoke by deleting the row.
- CSRF: non-GET requests must carry `Origin` equal to the request origin (checked once in `worker.ts`); WebSocket handshakes check it separately.

## Directory D1 vs per-user D1

- **Directory** (binding `DIRECTORY`, SQL in `server/migrations/directory/0001..0013`): applied with `wrangler d1 migrations apply` (`cf:migrate*` scripts). Never edit an applied file; add a numbered one.
- **Per-user databases** (`userDb.ts`, `schema.ts`): D1 bindings are fixed at deploy time, so each user's database (`golemdocs-user-<id>` in production, `golemdocs-dev-user-<id>` otherwise) is created and queried over `api.cloudflare.com` with `CF_API_TOKEN`; the `users` directory row records `database_id` and `schema_version`. `USER_MIGRATIONS` (an array of statement lists, append only) are applied at provisioning and when `schema_version` is behind on the user's next request. Each query is an HTTP round trip: keep it to catalogue-sized work. A database is made on the first *write* by a user with sync, not the first look (`ownStorage` in `documents.ts`).
- **Catalogue cache** (`catalogue_cache`, migrations 0009/0012): listing documents/folders reads a copy in the directory D1 (native, fast) instead of the REST API. Any write through `UserDb.run/runAll` bumps a change counter (row `kind = ''`); a cached list is used only if its `version` matches and it is under the TTL. The counter replaced timestamps because server clocks differ.
- **`ENVIRONMENT=local`**: no per-user databases. `LocalUserDb` runs the same SQL in the simulated directory D1 with table names prefixed `local_<userId>_`.

## Documents, files, folders

- `documents.ts` (`handleDocuments`): `GET/POST /api/documents`, `/:id` (GET bytes, PUT replace, DELETE), `/:id/thumbnail`, `/:id/index`, `/:id/shares[/:userId]`, `POST /api/documents/batch`, `GET /api/shared`. A document is a catalogue row in its owner's database plus R2 objects named in `keys.ts` (`docxKey`, `thumbKey`, `indexKey`, `mediaKey`, `chunkKey`). The key ends in `.docx` for historical reasons but holds the client's `.wdoc` (`stored.ts` extracts or replaces the inner `document.docx` for the server-side readers). Reads need only owner id + doc id, so the common GET skips the user's database.
- **Concurrency**: `PUT ?base=<updatedAt>` is optimistic. A stale base gives 409 `changed elsewhere`; R2 `onlyIf etagMatches` and `UPDATE ... WHERE updated_at = ? RETURNING` close races between two saves from the same base; `updated_at` is `MAX(now, old + 1)` so versions strictly increase. 423 means a room is the writer (`roomAllowsSave`). 413 over 50 MiB; 402 without sync.
- **Chunked files** (`fileStore.ts`): documents of 2 MiB or more are stored as a JSON manifest at the usual key (R2 custom metadata `chunked=1`) plus chunks under `<owner>/<doc>.chunks/`. `Content-Type: application/vnd.golemdocs.delta` uploads send only changed chunks; reads reassemble through `documentResponse`. Chunks are per document, never shared, so no refcounting; deleting removes by prefix. See [Chunked storage](../chunked-storage.md).
- `folders.ts`: `/api/folders[/:id]`; PUT is create-or-update because clients make the ids (offline-made folders upload as they are); depth limited and moving a folder inside itself refused (`MAX_FOLDER_DEPTH`); `checkFolder` validates that a document's target folder exists.
- `preferences.ts`: `/api/preferences`, rows per (profile, key) with limits; the client decides what the keys mean.
- Deletes clean up in the background through `ctx.waitUntil` (`defer`): chunks, thumbnails, media, search index, owner/share rows, rooms (`endRooms`).

## Sharing

`sharing.ts` is the single place that decides who may open a document, for both the API and rooms. The owner always may; anyone else needs a `shares` row (`viewer` or `editor`) in the directory. `document_owners` maps doc id to owner so a share or room can find a document without knowing whose it is; documents from before sharing are claimed lazily on first listing (`users.owners_backfilled`). A share lasts only while the owner has sync (`hasSync(owner)`). Folders are the owner's private arrangement; shared documents show `folderId: null` to others. Changing or removing a share calls `rejoinRoom` / `kickFromRoom`.

## Subscriptions and billing

- `subscriptions.ts`: Polar (merchant of record). A signed webhook (`/api/webhooks/polar`, Standard Webhooks scheme, 5-minute tolerance) upserts the latest state per user into `subscriptions`; the user is linked by the `external_customer_id` set to our user id at checkout, never by email. `hasSync` is true for subscribers (trial counts), admins, everyone when `REQUIRE_SUBSCRIPTION !== 'true'` (the rollout switch, currently `false` in `wrangler.jsonc`), and always when `local`. `subscriptionRequired()` is the 402 refusal.
- `billing.ts`: admin-only read of Cloudflare's billable usage for the month.

## Assistant, search, analytics, feedback

- `assistant.ts`, `model.ts`, `assistantTools.ts`: `POST /api/assistant` is one model turn on Workers AI; tools run in the page. Monthly budget per user (`MONTHLY_BUDGET_MICRO`), reserved before the call and settled after (`assistant_usage`). `assistantTools.ts` only *describes* tools; see [Assistant](assistant.md).
- `search.ts`: assistant search over a user's own documents. Text is chunked (`MAX_CHUNK_CHARS` 1200), embedded with `@cf/baai/bge-m3` (1024 dims) and stored in Vectorize under namespace = owner id; documents are indexed lazily on search (a few per request), never on save. `doc_index` records which version is indexed.
- `docIndex.ts`: `GET /api/documents/:id/index`, the full-text index from `@golemdocs/docx` search, built lazily and cached at `<owner>/<doc>.idx`, valid while the index version and the row's `updated_at` match.
- `analytics.ts` (admin, from `identities`/`sessions`), `feedback.ts` (`/api/feedback` for users, `/api/admin/feedback` to read/resolve/delete).

## Wrangler environments

`wrangler.jsonc` top level is production (custom domain golemdocs.com). `env.dev` (real dev D1/R2/Vectorize, `remote: true`, no routes) and `env.local` (everything simulated) list their own bindings because bindings are not inherited. `scripts/wrangler-config.ts` merges `server/wrangler.local.json` (git-ignored: database ids, account id) into `wrangler.generated.jsonc`, which the scripts pass to wrangler. `pnpm dev` uses `dev` once set up, else `local`; see the root [README](../../README.md) for setup, secrets (`CF_API_TOKEN`, `ADMIN_EMAILS`, `POLAR_*`, provider keys) and deploy steps. `.dev.vars` `DEV_USER` signs you in locally.

## Rooms (Durable Objects)

`room.ts` (the Durable Object, one per document id, SQLite log) and `roomCore.ts` (the protocol, testable in Node) are described in [Collaboration](collaboration.md). The rest of the server reaches a room only through `roomGate.ts`: `joinRoom`, `roomHeaders` (the identity headers `x-user/x-role/x-owner/x-doc` are set there and nowhere else), `roomAllowsSave`, `endRooms`, `kickFromRoom`, `rejoinRoom`. `snapshot.ts` turns a base document plus logged transactions into the new file; `roomMedia.ts` stores pictures added during editing. While a room is shared it is the only writer of the file.

## Key files

| Path | Role |
| --- | --- |
| `server/src/worker.ts` | router, auth gate, origin check, error mapping, exports `Room` |
| `server/src/documents.ts`, `fileStore.ts`, `keys.ts`, `stored.ts` | document API, R2 file/chunk store, key names, `.wdoc` inner-docx access |
| `server/src/userDb.ts`, `schema.ts`, `folders.ts`, `preferences.ts` | per-user D1, migrations, folders, settings |
| `server/src/authRoutes.ts`, `providers.ts`, `accounts.ts`, `session.ts`, `auth.ts`, `crypto.ts` | sign-in |
| `server/src/sharing.ts`, `roomGate.ts`, `room.ts`, `roomCore.ts`, `roomMedia.ts`, `snapshot.ts` | access rules and rooms |
| `server/src/subscriptions.ts`, `billing.ts`, `analytics.ts`, `feedback.ts` | payments and admin |
| `server/src/assistant.ts`, `assistantTools.ts`, `model.ts`, `search.ts`, `docIndex.ts` | AI and search |
| `server/src/cf.ts`, `http.ts` | hand-declared Cloudflare types (no `@cloudflare/workers-types`), `HttpError`, id/name validators |
| `server/migrations/directory/`, `server/wrangler.jsonc`, `server/test/` | schema, bindings, tests (`harness.ts` fakes the bindings; run `pnpm --filter @golemdocs/server test`) |

## Invariants and gotchas

- Access checks go through `resolveAccess`/`accessFor`; never read another user's R2 key without them.
- Anything that writes a document's file must first ask `roomAllowsSave`.
- Append-only: `USER_MIGRATIONS` entries and directory migrations. A migration that fails midway must be safe to rerun (`migrate` records the version in the same batch).
- Local mode differs: no Vectorize/AI (search runs in the browser), no subscription checks, table-prefix user DB.
- The comment above the `local` env in `wrangler.jsonc` ("cloud documents are switched off") is out of date; the README and `LocalUserDb` say they work locally.
- New user-visible features need an assistant tool in `assistantTools.ts` (see `AGENTS.md`).

## Related docs

[Storage and sync](storage-and-sync.md) · [Formats](formats.md) · [Collaboration](collaboration.md) · [Assistant](assistant.md) · [Chunked storage](../chunked-storage.md) · [server/AUTH.md](../../server/AUTH.md) · [README](../../README.md)
