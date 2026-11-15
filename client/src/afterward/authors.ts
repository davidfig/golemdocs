// Who wrote a comment: a person, or Afterward (docs/afterward.md). Small and loaded with the comments panel, so a document
// reviewed earlier shows its readers' comments as readers before the rest of Afterward is loaded. A reader's comments are
// signed "<reader> · Afterward", and the questions plain "Afterward", so they read right in Word or Markdown too.

/** The author of the questions Afterward asks. Not translated: it names the feature, in every file and language. */
export const BOARD = 'Afterward';
const SUFFIX = ` · ${BOARD}`;

/** The author name a reader's comments are signed with. */
export function readerAuthor(name: string): string {
  return `${name}${SUFFIX}`;
}

/** Afterward or one of its readers, from a comment's author; null for a person. */
export function agentOf(author: string): { name: string; board: boolean } | null {
  if (author === BOARD) return { name: BOARD, board: true };
  if (author.endsWith(SUFFIX) && author.length > SUFFIX.length) return { name: author.slice(0, -SUFFIX.length), board: false };
  return null;
}

/** A reader's colour: the same for a name every time, and set apart from the people's (which are lighter and more saturated). */
export function agentColor(name: string, board: boolean): string {
  if (board) return 'hsl(222 18% 34%)';
  let hash = 7;
  for (const ch of name) hash = (Math.imul(hash, 33) + ch.codePointAt(0)!) | 0;
  return `hsl(${Math.abs(hash) % 360} 30% 36%)`;
}
