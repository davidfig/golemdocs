# Afterward: an editor in the margin

**Status (2026-11-15).** Built on the `afterward` branch: the margin editor (reading along, asking, cuts, moves and words
the writer accepts, pinning, dismissing), Reverse Outline, Find Quotes in My Notes, and reading a long piece a chapter at a
time. Not yet tried against the real API (the tests fake it). The review flow that came before it (question threads, a cast
of readers, attention dots, studies, a whole-book journal) was built, tried and retired; it is in the history at `a6a8c527`.

## 1. What it is, and how we got here

An editor beside the page for writers who have never had one. It reads along as you write, leaves a few quiet notes in the
margin where a reader would stop, and answers when you ask about a passage. It helps when you're stuck, offers words when you
ask, and points out awkward writing, the way an editor's pencil does.

How the design got here (2026-11-14 and 15), so the reasons aren't lost:

- **A review ritual didn't feel natural.** The first version read a finished piece and posted 3 to 5 comment threads, each
  asking the writer a question before revealing a reaction. It took a minute or more for a short post, the questions felt
  like homework, and a conversation scattered across comment cards was awkward.
- **A cast of readers was confusing.** Three personas (a stranger, an editor, a friend) gave the writer something else to
  think about without adding much. Afterward became one voice.
- **No questions to answer.** The writer is never asked anything. What the piece is for comes out of the writing and of what
  the writer says, never from a form.
- **The margin, not a chat window.** Two interfaces were mocked up: notes in the margin beside their paragraphs, and a docked
  panel that follows your place. The margin was chosen. What sets it apart from a chat app: it is organized by place, not
  time; it is never a blank box (it has already read along); its suggestions are actions on your words, not prose to copy;
  and you ask from the selection.

## 2. Principles

- **It never writes the piece.** No new sentences or passages, no rewritten lines, even when asked. It may suggest cutting or
  moving the writer's own words, and offer a few words to choose from when asked or when one word is the trouble. Nothing in
  the document changes until the writer clicks, and every change is the writer's own edit (Undo takes it back).
- **It speaks rarely.** Reading along leaves at most one note a paragraph and three a read, only where a reader would really
  stop. A margin full of notes gets ignored.
- **It never interrupts.** Nothing pops up. Notes appear in the margin at pauses, like a spell check's squiggles.
- **The notes aren't the document.** They are kept on the device, not in the file, so an export stays clean. Pinning a note
  makes it an ordinary comment.

## 3. The interface

- **Tools › Afterward › Read Along** (a switch, synced with the account; off until turned on, since it spends from the key).
  At a pause in typing (3.5 s), the fast model reads the paragraphs that changed since it last read them (only those with at
  least 6 words), with the rest of the piece (a long one: the chapter at the caret, §6) for context. It returns a one-line
  reading of the piece ("Reads as: …", under the comments panel's title) and up to three notes.
- **A note** is a card in the margin beside its paragraph, with a dotted amber line under its words in the text. Clicking it
  opens it (the whole note shows, open or closed): any suggestion as one button that does it (a cut shown struck through in
  the text, a move shown dashed) beside a quiet Keep, words as chips, a box to ask about it with a send arrow, and Pin as
  Comment and Dismiss as icons in its header. A note fades when its words are edited away, unless the writer talked with it.
  A dismissed note is remembered and not raised again.
- **Tools › Afterward › Ask the Editor** (Mod+Alt+E): a card with a box opens in the margin beside the selection (or the
  paragraph at the caret). The answer streams in from the deep model: a few sentences, "Show me" buttons for the passages it
  points at, and at most one cut, move or set of words. The conversation goes on in the card; once it is long, the card shows
  the last two turns and "Show all".
- **Reverse Outline** and **Find Quotes in My Notes** (§7, §8) stay in the menu.

Where the code is: `client/src/afterward/afterward.ts` (the controller), `prompts.ts`, `model.ts`, `text.ts`, `record.ts`,
`dialog.ts` (the key), `outline.ts`; `marks.ts` (the Read Along switch) and `authors.ts` load with the app. The margin is the
comments panel (`ui/commentsPanel.ts`: `CommentAgents.cards()` and `subtitle()`, placed with the comments); the marks on the
text go through the layout worker with the spelling squiggles (`editorMarks`; kinds 2 to 5 in `webgl/overlayColors.ts`).
Accepting a suggestion is a selection and an `insertText` or `delete`, as if typed.

## 4. Models and speed

- **Reading along: Claude Haiku 5.5** (`FAST_MODEL`), low effort, non-streaming: it must come back in a few seconds and cost
  next to nothing, and its notes are meant to be few and simple.
- **Asking, outlines, quotes: Claude Opus 5.5**, streamed for asking (the reply starts within a second or two;
  `partialField` reads the reply out of the structured answer as it arrives).
- Every request goes through `ReaderModel` (`model.ts`), so another provider (an open model, the golemdocs server for
  subscribers) is another implementation of it. The direct route uses the writer's own key, kept on the device and never
  synced, with retries on failures that may pass. No SDK: weighed on 2026-11-14 at 543 kB minified in the browser against
  about 27 kB for this whole chunk; it belongs on a server route.

- **What it costs.** Admin › Debug › Token use shows, under the reading line, the calls since the page loaded, tokens in
  (cached, written to the cache), tokens out and about what they cost at list price (`costOf` in `model.ts`; Haiku's
  price above 100K-token prompts isn't counted), and the last call with its model and time. Every call is also logged to
  the console as `[afterward]`. Use it to tune how often reading along speaks and how much of the piece it sends.

## 5. What is kept, and where

Per document, in this browser's storage (`record.ts`, v3): the reading line, the fingerprints of paragraphs already read, the
notes (with their conversations and suggestions), the dismissed notes, and outlines. Not synced: losing it loses the margin,
never the document. Older records (v1, v2: the retired review) are ignored.

## 6. Long pieces: a chapter at a time

A piece over 6,000 words (`LONG_WORDS`) is read a chapter at a time. Its chapters are the headings of the highest level that
appears at least twice (a lone title above them doesn't count); prose before the first is a chapter of its own (the opening).
A long piece with no such headings is cut into parts of about 4,000 words, between paragraphs. The model gets the rules, then
the chapters before as what the reader has read (one block each, unnumbered), then the chapter itself, numbered, and nothing
after it. The earlier chapters are the same text for every later chapter, so reading on reuses them from the prompt cache.
What came before is cut to about 150,000 tokens, earliest first.

## 7. Reverse Outline

What each paragraph does for the reader as written, where the main point arrives, and up to four things a reader notices
about the structure, in a dialog; a line goes to its paragraph. It describes, never prescribes. Kept per piece (or chapter),
so it is asked for again only when the text changes.

## 8. Quotes from the writer's own sources

Find Quotes in My Notes, on the selection: the model gives search queries; the library is searched with Search All
Documents' index and the best six documents (not the open one) are read whole by the search index's worker
(`IndexWorker.text`); the model may only point at passages in them; **every quote is found again in its source**
(`verifyQuote`: only case, quote marks, dashes and spacing may differ; no "..." cuts) and the note holds the source's own
words, never the model's. They arrive as a note in the margin, pinnable as a comment.

## 9. Rules this changes

`AGENTS.md`: no AI writes in the app; Afterward is the one exception, as it never writes the piece (it suggests cuts and
moves of the writer's words, and words to choose from, all accepted by the writer). The marketing site still says the app has
no AI; change it in every language when this ships.

## 10. Next

- Try it on real writing with a real key, and tune the read-along prompt: how often it speaks, and whether its notes are
  worth reading.
- A small **Ask** button beside a selection, so asking doesn't need the menu or the shortcut.
- Narrow windows: notes as dots beside the paragraphs, opened over the page.
- An open model for reading along, behind `ReaderModel`.
- "Since yesterday…": what changed for the editor in a paragraph the writer revised.
