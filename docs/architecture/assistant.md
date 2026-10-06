# The AI assistant (Clip)

Clip is a paperclip in the corner of the app that reads and edits the open document, and the person's other documents and files, through tools. The model runs on the server (Workers AI), but **every tool runs in the browser**, against the same editor commands the menus use, so each change is an ordinary, undoable edit that collaborators see. The server keeps no conversation state: the page owns the history and posts it each turn. Subscribers only, with a monthly budget.

## How it works

```
 Assistant (assistant/index.ts)          converse() loop            server
 chat bubble, attachments  ──ask──►  conversation.ts  ──POST /api/assistant──►  assistant.ts
                                         ▲   │ tool_calls                         parseMessages, reserve budget,
                                         │   ▼                                    complete() in model.ts, settle
                              host.tool(name,args)  ◄── one model turn: { message, creditsLeft }
                                         │
                    appTools.run (assistant/appTools.ts, main thread)
                      ├─ own handlers: files, other documents, rename, convert, view,
                      │   text_file, drawings, picture layers, collaboration ...
                      └─ otherwise host.agent() ──► layout worker ──► runAgentTool (layout/agentTools.ts,
                                                                       agentPdfTools.ts) ──► editor commands
```

1. `Assistant.ask()` (`client/src/assistant/index.ts`) checks the gate (signed in, subscribed, credits), then calls `converse()` (`conversation.ts`) with two injected dependencies: `ask` (`api.ts: askServer`) and `tool` (`host.tool`). The loop is DOM-free and network-free so it is unit tested.
2. Each turn is one non-streaming request: `POST /api/assistant { messages }` returns `{ message: { content, tool_calls? }, creditsLeft }`. There is **no token streaming**; the UI shows a "thinking" note and a per-tool progress note (`toolNote`, i18n keys `assistant.tool.*`) while tools run.
3. If the reply has `tool_calls`, the page runs them, appends `tool` messages (results, plus any pictures a tool fetched), and asks again, up to `MAX_STEPS` (10) turns. History is trimmed to `MAX_HISTORY_CHARS` (45,000) and tool results to 9,000 characters; the server refuses over 60,000 (`MAX_CONVERSATION_CHARS`). Pictures are sent once, with the request they belong to (`withoutImages`).
4. The server describes some tools as **groups** with an `action` (`comments`, `files`, `text_file`, `pdf_edit`...) to keep the list the model reads short. `toolGroups.ts: expandTool` turns a group call into the single tool it stands for, so everything after it (progress notes, `EDITS`, implementations) only knows single tools. The group table must match `server/src/assistantTools.ts`.
5. `appTools.run` dispatches: its own handlers first, else the layout worker via `host.agent` (`main.ts` wires this to `worker.agent`, which calls `runAgentTool`). Tools never throw to the model: failures are returned as `Error: ...` text.

## Key files

| Path | Role |
| --- | --- |
| `client/src/assistant/index.ts` | `Assistant` UI: Clip bubble, input, picture attachments, gating, `EDITS` set, `toolNote` |
| `client/src/assistant/conversation.ts` | `converse()` loop, `Message`/`Reply`/`AssistantError` types, step and size limits |
| `client/src/assistant/api.ts` | `fetchStatus`, `askServer`, `searchServer` (the three endpoints) |
| `client/src/assistant/toolGroups.ts` | `TOOL_GROUPS`, `expandTool` |
| `client/src/assistant/appTools.ts` | `appTools(host)`: tools that act on the app (files, rename, convert, view, text file, pictures, collaboration, the document's version history: `list_versions`, `save_version`, `restore_version`); falls through to the worker |
| `client/src/assistant/fileTools.ts` | library tools: list/open/move/delete files and folders, and the trash (`list_trash`, `restore_from_trash`) |
| `client/src/assistant/libraryDocs.ts`, `otherDocs.ts` | "other documents": list, search, read, copy parts into the open one (`otherDocs.ts` is the pure part) |
| `client/src/assistant/drawingTools.ts`, `pictureLayerTools.ts` | vector drawing and picture-layer tools |
| `client/src/assistant/clipArt.ts`, `assistant.css` | the mascot SVG and styling |
| `client/src/layout/agentTools.ts`, `agentPdfTools.ts` | document and PDF tools, run in the layout worker (`runAgentTool`, `MAX_READ_CHARS`) |
| `client/src/layout/layoutWorker.ts` (`agent`) | pauses raw-source editing, runs the tool, waits for its commands to apply |
| `client/src/main.ts` (`assistantTools = appTools({...})`, `new Assistant(...)`) | supplies the host: current document, library, worker, drawing editor |
| `server/src/assistant.ts` | endpoint, message validation, budget hold/settle |
| `server/src/assistantTools.ts` | `SYSTEM_PROMPT` and `TOOLS` (descriptions and JSON schemas only) |
| `server/src/model.ts` | the only file that knows the model wire format: `MODEL`, `PRICE`, `complete`, `costMicro` |
| `server/src/search.ts`, `docIndex.ts` | semantic search (Vectorize) and the full-text index route |

## Tool parity rule

AGENTS.md: every user-visible feature needs an equivalent assistant tool, added in the same change. Concretely:

- Describe it in `server/src/assistantTools.ts` (names and arguments must match what the page runs; the server never executes tools).
- Implement it where the work happens: document edits in `layout/agentTools.ts` (worker), app-level tools in `assistant/appTools.ts` (the AGENTS.md text says `APP_TOOLS` in `main.ts`; today they live in `appTools()`, with `main.ts` only providing the host). Reuse the function the UI calls.
- If it changes the document, add its name to `EDITS` (`assistant/index.ts`) and add an `assistant.tool.*` progress note in every language.
- Update the system prompt's capability list, and test it.
- `client/test/assistantParity.test.ts` enforces the first half: every tool in `TOOLS` (and every action of every group) must be defined in the worker tables, `fileTools.ts` or `appTools.ts` (it reads the sources by regex). Also see `toolGroups.test.ts`, `agentTools.test.ts`, `agentPdfTools.test.ts`, `assistantDrawing.test.ts`, `assistantPictures.test.ts`, `assistantTextFile.test.ts`.

## Undo and `EDITS`

`EDITS` is **not** an undo-grouping mechanism. Tools change documents only through the normal editor commands, so each tool call is already its own undo step(s) in the editor's history (and in the room's per-user history when collaborating). `EDITS` only tells the UI that something changed, so it can append the "Undo takes it back" hint after the answer (`assistant.undoHint`); stopping a request keeps what already ran. The `undo`/`redo` tools are in `EDITS` too. A tool missing from `EDITS` still works, it just does not show the hint.

## Document search

The `search_documents` tool (`libraryDocs.ts: search`) has two layers:

- **Server, by meaning:** `GET /api/assistant/search?q=` (`server/src/search.ts`). Documents are cut into chunks (`chunkSegments`, headings and `MAX_CHUNK_CHARS`=1200), embedded with `@cf/baai/bge-m3` (1024 dims) into the Vectorize index (`VECTORS` binding, one namespace per owner, so a query only reaches that person's documents). Indexing is lazy: up to `MAX_INDEXED_PER_SEARCH`=6 stale documents per search, never on save; `pending` reports the rest. Which documents are indexed is tracked in D1 (`migrations/directory/0010_doc_index.sql`). Shared-with-me documents are not in the index.
- **Client fallback:** `searchServer` returns `null` when the index is not set up (`pnpm dev --local` has no Vectorize) or offline; the page then scores documents by words itself (`otherDocs.ts: termsOf/scoreDocument`, newest `MAX_SCANNED`=80 documents, fetched lazily and cached for the session) and the person's own full-text search (`searchLibrary` in `main.ts`, the same indexes File search uses) handles exact words and tags. Shared documents are always searched this way.
- `server/src/docIndex.ts` is a different thing: `GET /api/documents/:id/index` serves the **full-text** index (`@golemdocs/docx` `buildIndex`) from R2 so a second computer skips parsing the .docx. Both lazily build on first request and are stamped against the catalogue row's `updated_at`.

## System prompt, billing and limits

- `SYSTEM_PROMPT` (`assistantTools.ts`) starts "You are Clip..." and lists what the assistant can do. Update the list when adding a capability.
- Access: `subscriptionFor(env, userId)?.active` else HTTP 402 `code: 'subscription'`. No `env.AI` binding: 503 (the client shows "unavailable").
- Budget: `MONTHLY_BUDGET_MICRO` = $1.25 per user per UTC month, in `assistant_usage` (D1 directory). A request **holds** its worst case (`reserve`: prompt chars/3 as tokens, plus `IMAGE_TOKENS` per picture, plus `MAX_OUTPUT_TOKENS`) atomically before the model runs, and `settle`s to the real cost after (the worst case if usage is not reported; nothing on failure). Holds older than 15 minutes (`HOLD_LIFETIME_MS`) are ignored, so a crashed request cannot lock a user out. Out of budget: 402 `code: 'credits'`. The page only ever sees a percentage (`creditsLeft`).
- Input limits (`parseMessages`): 80 messages, 60,000 characters, 4 pictures per message and 6 in total (PNG/JPEG/WebP/GIF data URIs up to 1.4M characters), tool names must be in `TOOLS`, and the last message must be from the user or a tool.
- The model and prices live in `model.ts` only; keep `PRICE` in step with Cloudflare's price list.

## Invariants and gotchas

- Tool names/arguments are a contract between `assistantTools.ts` and the page; the server does not validate arguments.
- `appTools.begin(request)` records the document open when a request starts. `run` refuses document tools if another document was opened since (`ELSEWHERE_TOOLS` and file tools are exempt; `OPENING_TOOLS` re-anchor the request). This stops a request from editing a document the person never meant.
- While a large text file is open (`host.textEditor()`), paragraph tools are refused; only `text_file` works.
- Paragraphs are numbered from 0 in `Editor.paragraphs()` order everywhere, including other documents, so numbers mean the same thing across tools.
- The marketing site's "Clip" (`client/site/clip.js`, `seo.ts: withClip`) is a scripted, no-AI demo; it shares only the art and CSS.
- The Playwright config says the assistant is not covered, but `e2e/shell/ai-assistant.spec.ts` (visibility) and `e2e/layout/assistant-drawings.spec.ts` exist; the model itself is never called in e2e.

## Related docs

[Server](server.md), [Layout](layout.md) (the worker the document tools run in), [Document model](document-model.md), [Collaboration](collaboration.md) (tool edits in rooms), [UI](ui.md), [Build and testing](build-and-testing.md); [Toolbar and file actions status](../actions-status.md).
