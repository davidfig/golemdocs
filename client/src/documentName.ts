// The name of the open document: what a typed or suggested name becomes, and what the title shows.

import { stem } from './formats/source.ts';
import { hasExtension } from './formats/textFiles.ts';

const MAX_LENGTH = 120;

/** A typed name made safe for a file: no path or reserved characters, tidy spaces, not too long. Empty when nothing is left. */
export function cleanDocumentName(input: string): string {
  // eslint-disable-next-line no-control-regex
  const name = input.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').trim();
  return name.slice(0, MAX_LENGTH).trim();
}

/** What the title shows: the name without its extension, except that a text file keeps the one it came with ("main.py"). */
export function displayDocumentName(name: string, kind: string): string {
  return kind === 'txt' && hasExtension(name) ? name : stem(name);
}
