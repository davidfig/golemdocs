// SPDX-License-Identifier: MIT
// Comments in the body: where each comment's range starts and ends, and the markers that make
// one. A comment's range is w:commentRangeStart … w:commentRangeEnd, followed by a run holding
// w:commentReference (where Word shows its balloon anchor); each marker is one model position.

import type { Inline, Paragraph, Raw, Run } from '../model/types.ts';
import { el } from '../xml/xml.ts';
import { inlineLength, itemLength } from './text.ts';

export interface CommentAnchor {
  paragraph: Paragraph;
  offset: number;
}

/** A comment's range: from after its start marker to its end marker. */
export interface CommentRange {
  id: string;
  start: CommentAnchor;
  end: CommentAnchor;
}

const START = 'w:commentRangeStart';
const END = 'w:commentRangeEnd';
const REFERENCE = 'w:commentReference';

export function commentStart(id: string): Raw {
  return { kind: 'raw', xml: el(START, { 'w:id': id }) };
}

export function commentEnd(id: string): Raw {
  return { kind: 'raw', xml: el(END, { 'w:id': id }) };
}

/** The run that anchors the comment's balloon (in the CommentReference character style). */
export function commentReference(id: string): Run {
  return { kind: 'run', properties: { style: 'CommentReference' }, content: [{ kind: 'raw', xml: el(REFERENCE, { 'w:id': id }) }], attrs: {} };
}

/**
 * Every comment's range in these paragraphs (in document order), by id. A range whose end is
 * missing ends where its start is; one whose start is missing starts at its end.
 */
export function commentRanges(paragraphs: readonly Paragraph[]): Map<string, CommentRange> {
  const starts = new Map<string, CommentAnchor>();
  const ends = new Map<string, CommentAnchor>();
  const references = new Map<string, CommentAnchor>();
  for (const paragraph of paragraphs) {
    let offset = 0;
    const visit = (inlines: readonly Inline[]) => {
      for (const inline of inlines) {
        if (inline.kind === 'raw') {
          const id = inline.xml.attrs['w:id'];
          if (id !== undefined && inline.xml.name === START) starts.set(id, { paragraph, offset: offset + 1 });
          else if (id !== undefined && inline.xml.name === END) ends.set(id, { paragraph, offset });
        } else if (inline.kind === 'run') {
          let at = offset;
          for (const item of inline.content) {
            if (item.kind === 'raw' && item.xml.name === REFERENCE && item.xml.attrs['w:id'] !== undefined) references.set(item.xml.attrs['w:id'], { paragraph, offset: at });
            at += itemLength(item);
          }
        } else {
          visit(inline.children);
          continue;
        }
        offset += inlineLength(inline);
      }
    };
    visit(paragraph.children);
  }
  const out = new Map<string, CommentRange>();
  for (const id of new Set([...starts.keys(), ...ends.keys(), ...references.keys()])) {
    const start = starts.get(id) ?? ends.get(id) ?? references.get(id)!;
    const end = ends.get(id) ?? references.get(id) ?? start;
    out.set(id, { id, start, end });
  }
  return out;
}

/** The model positions of a comment's markers in a paragraph (start, end, reference), highest first. */
export function commentMarkerOffsets(paragraph: Paragraph, id: string): number[] {
  const out: number[] = [];
  let offset = 0;
  const visit = (inlines: readonly Inline[]) => {
    for (const inline of inlines) {
      if (inline.kind === 'raw') {
        if ((inline.xml.name === START || inline.xml.name === END) && inline.xml.attrs['w:id'] === id) out.push(offset);
      } else if (inline.kind === 'run') {
        let at = offset;
        for (const item of inline.content) {
          if (item.kind === 'raw' && item.xml.name === REFERENCE && item.xml.attrs['w:id'] === id) out.push(at);
          at += itemLength(item);
        }
      } else {
        visit(inline.children);
        continue;
      }
      offset += inlineLength(inline);
    }
  };
  visit(paragraph.children);
  return out.sort((a, b) => b - a);
}
