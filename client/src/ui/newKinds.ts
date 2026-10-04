// The types a new document can be made in from nothing, and which was used last: New makes the
// one used last, and the list beside it shows them most recently used first.

import type { DocumentSource } from '../layout/protocol.ts';
import { sourceFromFile } from '../formats/source.ts';
import type { DocumentKind } from './actions.ts';
import type { PopupItem } from './popupMenu.ts';
import { CONVERT_ORDER, FORMATS } from './formats.ts';

/** Every type a document can be converted to, so every one it can be made in; Word is the default of a browser that has never made another. */
export const NEW_KINDS: readonly DocumentKind[] = CONVERT_ORDER;

/** The types that open straight from an empty file; any other is made by converting a blank Word document. */
const EMPTY_TEXT = new Set<DocumentKind>(['md', 'txt', 'mediawiki', 'textile', 'tex', 'typst', 'adoc', 'rst', 'org', 'html']);

/** Kept in this browser and followed to the others (see settingsSync.ts). */
export const NEW_KINDS_KEY = 'golem.newKinds';

function stored(): DocumentKind[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(NEW_KINDS_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((k): k is DocumentKind => NEW_KINDS.includes(k)) : [];
  } catch {
    return [];
  }
}

/** Every type a new document can be, the ones used before first (last used first), then the rest as listed. */
export function newKindOrder(): DocumentKind[] {
  const used = stored();
  return [...used, ...NEW_KINDS.filter((k) => !used.includes(k))].filter((k, i, all) => all.indexOf(k) === i);
}

/** The type New makes: the one used last. */
export const lastNewKind = (): DocumentKind => newKindOrder()[0];

/** Notes that a document of this type was made or opened (other types, such as pictures, aren't offered). */
export function rememberNewKind(kind: DocumentKind): void {
  if (!NEW_KINDS.includes(kind) || stored()[0] === kind) return;
  try {
    localStorage.setItem(NEW_KINDS_KEY, JSON.stringify([kind, ...stored().filter((k) => k !== kind)]));
  } catch {
    // Not remembered: New makes the same as before.
  }
}

/** A new, empty document of this type, called `name` (without its extension): a blank Word document, or the empty text file; `converted` when it is a Word one that is to be converted to `kind` once open. */
export function blankSource(kind: DocumentKind, name: string): { source: DocumentSource; converted: boolean } {
  const text = EMPTY_TEXT.has(kind) ? sourceFromFile(`${name}${FORMATS[kind].extensions[0]}`, new ArrayBuffer(0)) : null;
  return text ? { source: text, converted: false } : { source: { kind: 'blank', name }, converted: kind !== 'docx' };
}

/** The label of a type in the lists of types: its name and extension. */
export const newKindLabel = (kind: DocumentKind): string => `${FORMATS[kind].label} (${FORMATS[kind].extensions[0]})`;

/** Context menu rows, one per type, last used first. */
export const newKindItems = (make: (kind: DocumentKind) => void): PopupItem[] => newKindOrder().map((kind) => ({ label: newKindLabel(kind), run: () => make(kind) }));
