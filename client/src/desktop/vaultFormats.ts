// Which files the vault keeps. Names only, so the page can ask without loading any converter (those are in the
// worker, see convertWorker.ts).

import type { Format } from '../formats/convert.ts';
import { sourceFromFile } from '../formats/source.ts';

const IN_THE_VAULT: ReadonlySet<string> = new Set<Format>(['docx', 'odt', 'rtf', 'html', 'md', 'txt', 'csv', 'tsv', 'tex', 'adoc', 'rst', 'org', 'mediawiki', 'textile', 'typst', 'docbook', 'jats', 'fb2', 'opml', 'eml', 'ipynb']);

/** The format a file name stands for, or null when the vault does not keep such files. */
export function vaultFormat(name: string): Format | null {
  // By name alone: nothing here reads the bytes, so `.xml` (which needs them to tell DocBook from JATS) is a text file.
  const kind = sourceFromFile(name, new ArrayBuffer(0))?.kind;
  return kind && IN_THE_VAULT.has(kind) ? (kind as Format) : null;
}
