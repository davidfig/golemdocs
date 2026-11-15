// What a whole-book read is likely to cost, to say before it starts (docs/afterward.md §12). A rough estimate on the
// writer's key: characters to tokens at about 3.5 to one, and the list price of the model the reads use.

/** Claude Opus 5.5, dollars per million tokens. */
const PRICE = { input: 4, output: 20 };
/** The rules and the task of every request, in tokens. */
const OVERHEAD = 1500;
/** A journal entry, in tokens (each later chapter is sent the ones before it). */
const ENTRY = 250;
/** What one chapter's entry costs to write, and the look back at the whole book. */
const ENTRY_OUT = 600;
const BOOK_OUT = 3000;

const tokens = (chars: number): number => Math.ceil(chars / 3.5);

/**
 * The requests a whole-book read makes, and about what they cost in dollars: one per chapter not remembered from the last
 * read (`reused` of them are, from the start), then one to look back at the whole book.
 */
export function estimateBook(chapterChars: readonly number[], reused = 0): { requests: number; dollars: number } {
  let input = 0;
  let output = 0;
  for (let i = reused; i < chapterChars.length; i++) {
    input += OVERHEAD + tokens(chapterChars[i]) + ENTRY * i;
    output += ENTRY_OUT;
  }
  input += OVERHEAD + ENTRY * chapterChars.length;
  output += BOOK_OUT;
  return { requests: chapterChars.length - reused + 1, dollars: (input * PRICE.input + output * PRICE.output) / 1_000_000 };
}
