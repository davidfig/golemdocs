// PowerPoint decks as documents, for what only a document does (Convert To, a paste into a document) and for search: a deck
// is edited in the slides editor (client/src/slides/, docs/slides.md), and this turns it into an outline (each slide's title a
// heading, its text below), or a document's outline into a deck (a slide per top-level heading). Its own chunk.

import type { FormatHandler } from '../convert.ts';
import { Deck } from '../../slides/deck.ts';
import { deckFromMarkdown, deckLines, deckMarkdown } from '../../slides/outline.ts';

/** The text of a deck's slides and notes, a line per paragraph, for the search index. */
export async function deckIndexed(bytes: Uint8Array): Promise<string[]> {
  return deckLines(await Deck.read(bytes));
}

const pptx: FormatHandler = {
  async read(bytes) {
    const { markdownToDocument } = await import('../markdown.ts');
    const deck = await Deck.read(bytes);
    return { document: await markdownToDocument(deckMarkdown(deck)), extensions: {} };
  },
  async write(document) {
    const { documentToMarkdown } = await import('../markdown.ts');
    return deckFromMarkdown(documentToMarkdown(document));
  },
};

export default pptx;
