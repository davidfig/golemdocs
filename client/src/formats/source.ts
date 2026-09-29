// Which document source a file becomes, by its extension.

import type { DocumentSource } from '../layout/protocol.ts';

const DOCX_FILE = /\.(docx|docm|dotx)$/i;
const PDF_FILE = /\.pdf$/i;
const MARKDOWN_FILE = /\.(md|markdown)$/i;
const TEXT_FILE = /\.(txt|text)$/i;

/** The source for a file's bytes, or null when the extension isn't one we open. */
export function sourceFromFile(name: string, bytes: ArrayBuffer): DocumentSource | null {
  if (DOCX_FILE.test(name)) return { kind: 'docx', name, bytes };
  if (PDF_FILE.test(name)) return { kind: 'pdf', name, bytes };
  if (MARKDOWN_FILE.test(name)) return { kind: 'md', name, bytes };
  if (TEXT_FILE.test(name)) return { kind: 'txt', name, bytes };
  return null;
}

/** Strips a known document extension from a file name. */
export function stem(name: string): string {
  return name.replace(/\.(docx|docm|dotx|doc|odt|rtf|html?|pdf|md|markdown|txt|text)$/i, '');
}
