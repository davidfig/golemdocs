# Plan: Afterward (readers in the comments)

**Decided 2026-11-14: Afterward is one voice.** The three readers (stranger, editor, friend) and readers of
the writer's own were dropped: a cast to choose and tell apart was more to think about than it gave. Afterward
now reads as one thoughtful reader from outside the writer's head, in the first person; it says how a
newcomer or an expert would differ only where they really would; and the writer may say who the piece
is for ("Who it's for", one line), which it then reads as. Every comment is signed Afterward, `@Afterward`
calls it into a comment, and attention is one dot a paragraph. Where the sections below speak of
"readers", read Afterward.

**Status (2026-11-14).** P0 to P4 are built on the `afterward` branch; P5 (through the server) is not.
Built: `addComments` in the editor (several comments at given places, one undo step); the worker's
`readerText` request; the comments panel's `CommentAgents` hook (reader authors with a drawn icon and
their own colours, a note under a thread with Stop or Try Again, more thread buttons, `@` suggestions
in a `listBox`, marks down the side); `client/src/afterward/` (readers, text and quote matching,
prompts and hand-checked answer shapes, the direct `fetch` client, the review record, the start
dialog, the controller); Tools › Afterward › Read It Afterward…, Read Again, Make Studies, Show
Reader Attention; English and the ten translations; unit tests (`client/test/afterward.test.ts`,
the editor's `addComments` tests) and an e2e spec with the API faked by `page.route`
(`e2e/collab/afterward.spec.ts`). Also built (2026-11-14): **Reverse Outline** (what each paragraph does as written, where the main point
arrives, what a reader notices; kept per piece, so it is asked for again only when the text changes) and
**Find Quotes in My Notes** (see §10). Not yet tried against the real API.

Where the build differs from the plan below:
- **No streaming.** Each answer is one structured-output call, so a reply shows as a note
  ("The editor reading…", with Stop) and then arrives whole. Streaming JSON into several comments
  wasn't worth it for replies of a few sentences.
- **The review record is in `localStorage`**, not IndexedDB: it is a few kilobytes per document.
- **Reader comments are signed "The editor · Afterward"**, and the questions "Afterward" (§9.3),
  so they read right in Word and Markdown and are recognized with no record at all.
- **Attention is a column of dots on the comments panel's left edge**, placed like the cards, not
  drawn on the page canvas. It needs no renderer change and moves with the cards.
- **The attention view syncs with the account** (a choice of view); the key never does.
- **One review at a time per thread**: a reply sent while the readers are still answering is in the
  document, and Ask Again answers it.

The prototype is the standalone app in `~/Programming/afterward` (React, about 1,000 lines). Its
readers (`src/readers.ts`) and its prompts (`src/claude.ts`, `BOARD_RULES` and the review, moment
and study tasks) carried over. Its UI did not.

## 1. What it is

A writer finishes a piece in Golem Docs and has it read by a few readers: the stranger, the editor,
the friend, or readers the writer describes. The readers work through the comments. Each moment worth
studying becomes a comment thread on the passage it is about. The thread opens with a question to the
writer. The readers' reactions come out only after the writer answers, and then the writer and the
readers talk it through in the thread. The writer revises the text, asks for a fresh read, and the
readers say whether it reads differently now.

It works the way a chess player uses an engine: you play the game alone, then review it afterward.
The writing stays the writer's.

### Principles

- **The readers never write the piece.** They react, point, measure and ask. They don't rewrite
  sentences or offer replacement wording, even when asked, and they say so. (Decided 2026-11-14.)
- **Reactions, not grades.** "I drifted here", not "this paragraph is weak".
- **Everything visible is an ordinary comment.** Threads are normal comments by authors named after
  the readers. They print, export to Word and Markdown (CriticMarkup), and other people in a shared
  document see them like any other comment. Nothing about a review depends on Golem Docs to be read.
- **Alone behaves like alone.** In a shared room only the session whose writer sent a message calls
  the model, so two sessions never answer the same reply.

## 2. The experience

1. **Start.** Review › Read It Afterward… opens a dialog: pick readers (the three built-in ones are
   ticked by default, and a custom reader can be added in a sentence or two), then Read. With no key
   set, the dialog asks for one first (§6).
2. **The read.** One structured call reads the document as each reader. A status-bar note shows
   progress ("The readers are reading…", with Stop). It returns 3 to 5 moments (at least one strength)
   and, per paragraph and reader, attention: leans in, holds, drifts, lost.
3. **Threads appear.** Each moment becomes a thread anchored to the exact quoted words. The first
   comment is the question, from "Afterward". The reactions are kept back.
4. **The writer answers** in the thread's reply box. Each reader then replies in turn, as its own
   comment under its own name and color, with its reaction adjusted honestly to what the writer said.
   The reply streams into a pending card ("The editor is reading your answer…") and becomes a real
   comment when it is done.
5. **Conversation.** Every later reply by the writer in an Afterward thread gets an answer. The writer
   can address one reader ("@friend, did that land for you?"). Otherwise the readers who have
   something to say answer, and the others keep quiet.
6. **"It's on purpose."** A button on the thread resolves it and records the choice. Later reads
   respect it and stop flagging it.
7. **Revise and read again.** The writer edits the text. Read Again rereads the changed paragraphs. In
   each open thread whose passage changed, the readers say what changed for them as readers ("I didn't
   drift this time"). That reply loop is how the writer improves the piece through the comments.
8. **Ask on any passage.** In any comment, even on a document never reviewed, "@editor" brings a reader
   into the thread with the same rules.

Later (§8): an attention strip in the margin, and studies (short revision exercises on the writer's
own lines, posted as threads, with the readers reacting to the writer's attempt).

## 3. What the comments already do

From reading the code:

- **Threads:** a first comment plus replies (`Comment.parentId`), resolve and reopen
  (`Comment.resolved`), edit and delete. These are the editor commands `addComment`, `replyComment`,
  `editComment`, `resolveComment`, `deleteComment` and `selectComment` (`editor/src/types.ts`,
  `editor/src/comments.ts`).
- **Anchors** are markers in the paragraph text (`commentRangeStart`, `commentRangeEnd`,
  `commentReference`), so they move with edits. A reply copies its root's range.
- **Formats:** Word keeps replies and resolved state in `commentsExtended.xml`
  (`docx/src/docx/comments.ts`). Markdown keeps whole threads as CriticMarkup, `{>>[↳ ][✓ ]@Author (date): text<<}`
  (`client/src/formats/markdown.ts`).
- **Panel:** cards beside their text, the active thread open with a reply box, drafts kept across
  redraws, a show-resolved toggle, initials and a color per author name (`client/src/ui/commentsPanel.ts`).
- **Text:** plain paragraphs only.

That covers the threads Afterward needs. What's missing is below.

## 4. Changes to comments

Most of these are useful without any AI. Each ships with unit tests and an e2e spec in `e2e/comments/`.

1. **Add a comment at a place, not at the selection.** A new command
   `addCommentAt { paragraph, start, end, text, author }`. The layout worker also needs to find a
   quote in a paragraph (`findQuote`: exact match first, then a match that ignores whitespace, curly
   quotes and Markdown emphasis; when there's no match, the whole paragraph). Several threads added
   at once are one undo step.
2. **Reader authors.** A card can show that its author is a reader and not a person: a small reader
   icon instead of initials, a fixed color per reader, and the reader's description on hover. A
   comment belongs to a reader when its id is in the document's review record (§5). If the record is
   missing, a fallback looks at the author name ("The editor · Afterward"), so the comment still reads
   right after export.
3. **Pending replies.** The panel can show a card that isn't a comment yet: the author, a "reading…"
   line, text streaming in, and Stop. It only becomes a `replyComment` operation when finished, so
   streaming never sends dozens of edits to the room or the undo history.
4. **Reply hooks.** `CommentsHost.reply` reports the new reply's id and thread, so a feature can act on
   it. Afterward uses this to answer.
5. **Mentions.** Typing `@` in a reply box suggests the document's readers, using the `listBox` popup.
   The text stays plain: `@editor` is only a word that Afterward reads.
6. **Thread actions from a feature.** A thread footer can carry extra buttons (It's on purpose, Ask
   Again) added by whatever owns the thread. Today the footer is fixed.
7. **Light formatting in comment text.** Paragraph breaks already work. Quoted lines from the piece
   (`> …`) should render set apart. Nothing else is needed.
8. **Check what happens to an anchor when its text is deleted.** `commentRanges` falls back to the
   start or reference marker. Make sure a thread whose passage was rewritten stays put and is still
   found by Read Again.

## 5. Where review state lives

**In the document, as comments:** the questions, the writer's answers and the readers' replies.
That's everything a person needs to read.

**Not in the document:** the readers chosen and their descriptions, which comment ids belong to
which reader, reactions not revealed yet, paragraph attention, the "on purpose" notes, and the API
history of each thread (thinking blocks have to go back unchanged).

This lives in a **review record** per document: a small JSON object keyed by the document's id. At
first it's kept in the device's IndexedDB with the document's other per-device data. If it's lost
(another device, cleared storage), the review still works. Reader comments are recognized by the
author fallback, the thread history is rebuilt from the comment text, and reactions not revealed yet
are generated again (the prompt asks for the reader's first reaction from before the answer). It
moves to the account later (§8), so another device continues with nothing generated again.

## 6. Calling the model

A new lazily loaded chunk, `client/src/afterward/`. It's well over 20 kB and most sessions never use
it.

- **One interface, two routes.** `ReaderModel` has `parse(schema, request)` and
  `stream(request, onText)`.
  - **Direct (build now):** the page calls `api.anthropic.com` with the writer's own key and the
    direct-browser-access header, as the prototype does.
  - **Through the server (later, §8):** a worker route `/api/readers/*` calls Anthropic for signed-in
    accounts, metered against the plan. Nothing above `ReaderModel` changes.
- **No SDK, no zod.** Per `AGENTS.md`, hand-write a small `fetch` client: messages, an SSE reader
  for streaming, structured output with a JSON schema, and a hand-written check of the parsed result.
  It's a few hundred lines and has nothing to ask approval for. Look up current model ids and API
  details with the claude-api skill when building it.
- **The key** is a per-device setting, **not** in `SYNCED_KEYS`: a secret must never go to the
  server. The desktop shell can move it to the OS keychain later through a new bridge command (old
  shells keep browser storage). It's set in the start dialog and in Tools › Readers…, with Remove.
- **Retries:** rate limits, overload, timeouts, the API's own errors and a dropped connection are tried
  again twice, after the wait the API asks for (`retry-after`) or a growing one (half a second, then
  one), as Anthropic's SDKs do; Stop ends the wait. The SDK itself was weighed (2026-11-14): 543 kB
  minified in the browser, against 26.6 kB for this whole chunk, so it is kept for the server route.
- **Errors in plain words,** ported from `explainError`. They show on the pending card, with Try
  Again.
- **Cost guard:** show a rough cost estimate before a read of a long document, and cache the piece
  in the prompt (prompt caching) across the replies in one session.

## 7. Rules this changes

- `AGENTS.md`, "AI is done outside the app": reword to *no AI that writes or edits the document.
  Readers that only read and comment are allowed, as the Afterward feature, and only through
  `client/src/afterward/`.* Update the matching architecture doc (`architecture/ui.md`, plus a line
  in `architecture.md`).
- The marketing site says there's no in-app AI (`/home/ai`). Update its copy in every language when
  this ships, not before.
- The usual requirements: every string through `t()` in every language, a changelog line,
  `docs/actions-status.md` for the new actions, `docs/README.md`.

## 8. Phases

**P0: check the comments (half a day).** Confirm the rest of §3 in the running app: replies and
resolved state round-trip through Markdown and Word, anchors survive heavy edits, the panel copes
with 5+ threads close together.

**P1: comments work (§4.1–4.6).** No AI. Each change is useful on its own.

**P2: first working version, with your key.**
1. Port the readers and prompts. The text a reader sees is the document's paragraphs numbered,
   headings marked, references cut (from `doc.ts`), built in the layout worker from the model.
2. `ReaderModel` direct route, key setting, start dialog, status-bar progress and Stop.
3. Read → threads (`addCommentAt`, one undo step) → answer → reader replies → conversation, It's on
   purpose. The review record in IndexedDB.
4. Tests: unit tests for quote finding, building the prompts, parsing replies (fixture responses) and
   the SSE reader. E2E with a fake `ReaderModel` (no real calls in tests): a read makes threads,
   answering brings replies, Stop, errors, undo.

**P3: the improvement loop.** Read Again on changed paragraphs, readers replying in open threads
whose passage changed, `@reader` in any comment (§4.5), Ask Again.

**P4: depth.** An attention strip in the margin (per paragraph and reader, drawn like the spelling
marks from paragraph geometry, toggled in View). Studies as threads, with the readers reacting to the
writer's attempt. Readers saved per account, to reuse across documents.

**P5: through the server, deferred.** The `/api/readers` route, metering, plan limits, and the review
record kept in the account. Billing decisions are yours, when you want them.

## 9. Open decisions

1. ~~**May a reader ever suggest wording?**~~ Decided 2026-11-14: **never**, not even when asked.
   Readers react, point, measure and ask; the writer makes every edit. No suggestion mode is built.
2. **The name in the app.** "Afterward" as the feature name and the questions' author, or something
   plainer ("Readers").
3. **The authors' names** in exported files: "The editor" alone, or "The editor · Afterward" so a
   Word user knows it wasn't a person.
4. **Shared documents:** can anyone in the room talk to the readers, or only the person who started
   the review (whose key pays)?

*Written 2026-11-14 from reading `editor/src/comments.ts`, `docx/src/edit/comments.ts`,
`docx/src/docx/comments.ts`, `client/src/ui/commentsPanel.ts`, the CriticMarkup notes in
`client/src/formats/markdown.ts`, and the Afterward prototype. Nothing was run.*

## 10. Quotes from the writer's own sources

Tools › Afterward › Find Quotes in My Notes, on the selection (or the paragraph at the caret):

1. The model gives one to three search queries for the passage (low effort).
2. The app searches the writer's own library with Search All Documents' index (`searchLibrary`), takes
   the best six documents other than the open one, and reads each whole through the search index's
   worker (`IndexWorker.text`, the same reading as the index, with no 400-character cut). Sources are
   cut to whole paragraphs, 15,000 characters each and 60,000 in all.
3. The model may only point at passages in that text: each answer names a source and a quote.
4. **Every quote is found again in its source** (`verifyQuote`: only case, quote marks, dashes and
   spacing may differ, never words; no "..." cuts; at least 12 characters), and the comment holds the
   **source's own words**, never the model's. A quote not found is dropped. That is what keeps a
   made-up quote out of a piece.
5. The quotes go in one thread on the passage, signed Afterward, each with its source and a line on
   how it bears on the passage. Nothing goes in the text; the writer copies what they use.

Reverse Outline describes and never prescribes: no suggested order and no wording. Outlining before
writing (a generated plan) was weighed and left out (it makes the structural choices the writing is).

## 11. Long pieces: a chapter at a time

A piece over 6,000 words (`LONG_WORDS`) is read a chapter at a time (built 2026-11-14). Its chapters are the
headings of the highest level that appears at least twice (a lone title above them doesn't count); prose before
the first is a chapter of its own (the opening). A long piece with no such headings is cut into parts of about
4,000 words, between paragraphs.

Every command reads the chapter the caret is in (a reply, the chapter its thread is in). The model gets the
rules, then the chapters before as what the reader has read, one block each and unnumbered, then the chapter
itself, numbered from 1, and nothing after it: a reader of chapter 12 knows 1 to 11 and not the ending. The
earlier chapters are the same text for every later chapter, so reading on reuses them from the prompt cache
(the API looks back over earlier block boundaries). What came before is cut to about 150,000 tokens, earliest
first. Attention is kept per paragraph as before, and reading one chapter leaves the others' alone; Reverse
Outline keeps an outline per chapter.

## 12. The whole book: a reader's journal

Tools › Afterward › Read the Whole Book (built 2026-11-14), for a long piece (a short one is read whole, as Read
It Afterward does):

1. **Asks first.** It counts the chapters and the words, and the requests it will make (one per chapter not
   remembered, one to look back), with a rough cost on the writer's key (`cost.ts`: about 3.5 characters a token,
   Claude Opus 5.5's list price). Nothing is sent until the writer says Read the Book.
2. **A journal, chapter by chapter, in order.** Each request sends the rules, the journal so far and the one
   chapter, not the chapters before it: the journal is the reader's memory, so a request stays the size of a
   chapter and the whole read costs about the book once, not the book squared. Each entry: attention, a
   one-sentence note, at most 120 words of what the reader waits for, expects, cares about, was confused by and
   nearly stopped at, and up to 6 marks (a thing set up or paid off, with exact words from the chapter).
3. **Kept as it goes.** Each entry is saved with its chapter's fingerprint, so Stop keeps what was read, and the
   next read starts at the first chapter that changed (the entries after it depend on it, so they are read again).
4. **The look back.** One request with the whole journal returns an overview (posted on the book's first words,
   as a thread) and 4 to 8 book-level moments (dropped threads, payoffs, a sag, repetition, structure, strength),
   each anchored in its chapter by the journal's quoted words, asking first like any moment.
5. **Chapter dots.** A larger dot on each chapter's heading for how the chapter held as a whole, beside the
   paragraph dots of chapters read one at a time.


