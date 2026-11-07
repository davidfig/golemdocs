// SPDX-License-Identifier: MIT
// Bookmarks in the body: a named range, w:bookmarkStart … w:bookmarkEnd (joined by w:id). Each marker is one
// model position, as a comment's markers are (see comments.ts). Word's own bookmarks (_Toc1, _GoBack) start
// with an underscore and aren't for people to see.

import type { Inline, Paragraph, Raw } from '../model/types.ts';
import { el } from '../xml/xml.ts';
import { inlineLength } from './text.ts';

export interface BookmarkAnchor {
  paragraph: Paragraph;
  offset: number;
}

/** A bookmark's range: from after its start marker to its end marker. */
export interface BookmarkRange {
  id: string;
  name: string;
  start: BookmarkAnchor;
  end: BookmarkAnchor;
}

const START = 'w:bookmarkStart';
const END = 'w:bookmarkEnd';

export const bookmarkStart = (id: string, name: string): Raw => ({ kind: 'raw', xml: el(START, { 'w:id': id, 'w:name': name }) });
export const bookmarkEnd = (id: string): Raw => ({ kind: 'raw', xml: el(END, { 'w:id': id }) });

/** Whether Word would take this as a bookmark's name: a letter first, then letters, digits and underscores, at most 40. */
export const validBookmarkName = (name: string): boolean => /^\p{L}[\p{L}\p{N}_]{0,39}$/u.test(name);

function visitMarkers(paragraph: Paragraph, marker: (raw: Raw, offset: number) => void): void {
  let offset = 0;
  const visit = (inlines: readonly Inline[]) => {
    for (const inline of inlines) {
      if (inline.kind === 'run' || inline.kind === 'raw') {
        if (inline.kind === 'raw') marker(inline, offset);
        offset += inlineLength(inline);
      } else visit(inline.children);
    }
  };
  visit(paragraph.children);
}

/** Every bookmark in these paragraphs that is for people to see, in document order, by id. A missing end ends where its start is. */
export function bookmarkRanges(paragraphs: readonly Paragraph[]): BookmarkRange[] {
  const out = new Map<string, BookmarkRange>();
  for (const paragraph of paragraphs) {
    visitMarkers(paragraph, (raw, offset) => {
      const id = raw.xml.attrs['w:id'];
      if (id === undefined) return;
      if (raw.xml.name === START) {
        const name = raw.xml.attrs['w:name'] ?? '';
        const at = { paragraph, offset: offset + 1 };
        if (name && !name.startsWith('_')) out.set(id, { id, name, start: at, end: at });
      } else if (raw.xml.name === END) {
        const range = out.get(id);
        if (range) range.end = { paragraph, offset };
      }
    });
  }
  return [...out.values()];
}

/** The model positions of a bookmark's markers in a paragraph, highest first. */
export function bookmarkMarkerOffsets(paragraph: Paragraph, id: string): number[] {
  const offsets: number[] = [];
  visitMarkers(paragraph, (raw, offset) => {
    if ((raw.xml.name === START || raw.xml.name === END) && raw.xml.attrs['w:id'] === id) offsets.push(offset);
  });
  return offsets.sort((a, b) => b - a);
}
