# Remote MCP server (not pursued)

**Decided against (2026-10-26).** Phases 1 and 2 below were built and then taken out before release: the vault folder stays the only way an ai app reaches documents (see "AI is done outside the app" in AGENTS.md). The reasons: one way in keeps the privacy promise simple (an ai only sees files on the person's computer), an agent working on files has every tool it knows where MCP offers eight and a Markdown view of a Word file, and a hand-written OAuth server and MCP endpoint are a security surface and a moving protocol to keep up with, for phones and the web only. The build is kept as a patch outside the repository (`.git/mcp-endpoint-2026-10-26.patch` in the checkout it was made in), should this be revisited. Two things it led to were kept: an open document picks up a save made elsewhere, and a conflict is merged when the two sides changed different paragraphs (see [Storage and sync](architecture/storage-and-sync.md)).

The original sketch: It gives subscribers' external ai apps (claude.ai, ChatGPT, Claude Desktop, on the web and on a phone) a way into their account's documents without a local folder. The [vault](architecture/desktop.md) stays the way in on a computer; this is the same idea where no folder exists.

## What it is

`https://golemdocs.com/mcp`, served by the same Worker as `/api/*` ([Server](architecture/server.md)). A person adds it once as a connector in their ai app.

- **Transport:** Streamable HTTP, stateless: `POST /mcp` carries JSON-RPC (`initialize`, `tools/list`, `tools/call`) and answers JSON. No SSE or session state, because the server never sends anything on its own. Hand-rolled (a few hundred lines); no `@modelcontextprotocol/sdk` dependency.
- **Who:** whoever `hasSync` lets through, the same gate as sync and sharing. It follows the `REQUIRE_SUBSCRIPTION` rollout switch, so while that is `"false"` everyone has it.

## Tools

Over the caller's own documents and the ones shared with them, always through `resolveAccess` (`editor` needed to change a shared one).

| Tool | Does | Notes |
| --- | --- | --- |
| `list_documents(folder?)` | id, name, format, folder path, `updatedAt`, size | reads the catalogue cache, so it is fast |
| `search(query)` | names, then content | the existing per-document `.idx` (`docIndex.ts`), stopped after N documents to bound the cost |
| `read_document(id)` | Word, ODT and text formats as Markdown; PDFs as extracted text (`@golemdocs/pdf`); pictures as image content | returns `version` (= `updatedAt`) |
| `edit_document(id, version, edits[{old, new}])` | find and replace inside the model | **the main write tool**: it keeps a Word document's formatting, which a whole Markdown round trip would flatten |
| `write_document(id, version, text)` | replaces the whole document | only documents edited as text (md, txt, csv...); Word documents use `edit_document` |
| `create_document(name, folder?, markdown, format?)` | new document | subject to the storage limit (`requireRoom`) |
| `move_document` / `delete_document` | rename or move; delete to the trash | never permanent: the trash keeps it 30 days |

Every write takes the same path as `PUT /api/documents/:id`: optimistic `?base=` (a stale `version` gives 409 and the ai reads again), `checkpoint` before the bytes are replaced (so every ai edit can be undone from version history), and `roomAllowsSave` / `roomSaved`. A desktop vault then downloads the change like any other change in the account.

## Sign-in: OAuth 2.1, per the MCP authorization spec

The Worker becomes the authorization server as well as the resource server. Hand-rolled like the existing sign-in (`providers.ts`), with no dependency:

- `/.well-known/oauth-protected-resource` (RFC 9728) and `/.well-known/oauth-authorization-server` (RFC 8414).
- `/oauth/register`: dynamic client registration (RFC 7591), which claude.ai uses; accept Client ID Metadata Documents too, which the newer spec prefers.
- `/oauth/authorize`: uses the session cookie (or the usual provider sign-in first), then a consent page ("Claude wants to read and edit your documents") built from `.wm-dialog` parts and `t()` strings. PKCE S256 required.
- `/oauth/token`: access tokens of about an hour and rotating refresh tokens. Only their SHA-256 is stored, as `session.ts` does for sessions, in a new directory migration (`oauth_clients`, `oauth_codes`, `oauth_tokens`).
- **Scopes:** `documents.read` and `documents.write`; a read-only connection is worth offering.
- **Bearer tokens work only on `/mcp`**, never on `/api/*`. Cookie auth and the origin check stay as they are, so a leaked token cannot reach billing or admin, and it dies when revoked.
- **Connected Apps** in the account panel: each client, when it was last used, and Revoke.

Cloudflare's `workers-oauth-provider` would do much of this, but it is a dependency, and the surface is small and close to what the server already does.

## What else has to change

- **Converters on the server.** The Worker has `@golemdocs/docx` and `@golemdocs/ops`, but the Markdown reader and writer (`client/src/formats/markdown.ts`, about 88 kB, with `markdownStyles.ts` and `plainText.ts`) live in the client. They move into a shared workspace package (moving between `@golemdocs/*` packages needs no approval). The client's chunks must not change: Markdown stays one lazy chunk.
- **Limits.** Conversion is capped (about 5 to 10 MB) to stay inside the Worker's CPU limit; a larger file gets a clear error that points to the vault.

## How it fits AGENTS.md

- **ai is done outside the app.** The server never calls a model; MCP is another way for an outside agent to reach the files, like the vault. Add a line to that section saying a remote MCP endpoint is allowed and never calls a model. Don't reuse the `assistant_usage` and `doc_index` tables left from the removed assistant.
- **Dependencies:** none.
- **Multiplayer:** an MCP call is just another session.
  - No room, or a room where someone is alone: it saves through the file as usual. An open editor sees "changed elsewhere", as it does after a vault sync.
  - A shared room is the only writer, so `PUT` gets 423. Phase 1 refuses with "being edited live, try again shortly"; phase 3 sends `edit_document` into the room as a transaction (which it maps onto well) instead.
  - Watch kinds (PDFs, pictures): read only over MCP.
- **Localization:** the consent page, Connected Apps and every error a person sees go through `t()` in every language. Tool names and descriptions are written for the model and stay English.
- **Consistent UI:** both new screens are built from the shared dialog parts.
- **Older shell:** no shell command changes.
- **Settings:** nothing new to sync; connected apps belong to the account, not to browser storage.
- **Phone apps:** nothing is bought or pointed to in our iOS app; a person connects from Claude's or ChatGPT's app.
- **Docs, changelog, marketing:** a new `docs/architecture/mcp.md` and updates to `server.md` and the Server row of this folder's README; a changelog line; a section on the ai page about connecting Claude or ChatGPT on the web or a phone, in every `client/home/locales/*.json`; a mention on the pricing page.
- **Tests:** `server/test` for the OAuth flow, refresh rotation and revocation, the scope gate and MCP dispatch against the harness; unit tests for `edit_document` matching; e2e specs for the consent page and Connected Apps.

## Phases

1. **Read only:** OAuth, Connected Apps, `list_documents`, `search`, `read_document`; the converters move to the shared package.
2. **Writes:** `create_document`, `edit_document`, `write_document` (text documents only), `move_document`, `delete_document`.
3. **Shared rooms:** edits to a document being shared live go through its room. Perhaps version tools (list and restore).

## Open questions

- **Account-wide search cost.** The per-user D1 is reached over the REST API and the index is per document. Is an account-level index needed, or is a bounded scan enough to start?
- **Prompt injection from shared documents.** Someone else's document can carry instructions for the reader's ai. Should shared documents be read only over MCP by default?
- **Matches across runs.** How does `edit_document` treat a match that spans runs with different formatting: refuse it, or take the first run's formatting?
