// A live block is read-only in the editor (docs/live-blocks.md §9): its result is replaced at the next update, so an edit
// inside it would be lost. The layout worker asks this before an editing command: an edit that would change part of a block
// (typing in it, deleting some of its text, a selection that starts or ends in it) is refused; one that takes a whole block
// away (a selection from before it to after it) is not. Pure, so it is tested without a browser.

import { inlineLength, paragraphLength, paragraphsIn } from '@golemdocs/docx';
import type { Block, Inline, Paragraph } from '@golemdocs/docx';
import { liveTag } from './liveMarks.ts';
import type { LiveTag } from './liveMarks.ts';

export interface Spot {
  paragraph: Paragraph;
  offset: number;
}

/** The paragraphs inside block-level live blocks, with their block's tag. */
function blockLive(body: Block[]): Map<Paragraph, LiveTag> {
  const out = new Map<Paragraph, LiveTag>();
  const walk = (list: Block[]): void => {
    for (const block of list) {
      if (block.kind === 'wrapper') {
        const tag = liveTag(block);
        if (tag) for (const p of paragraphsIn(block.children)) out.set(p, tag);
        else walk(block.children);
      } else if (block.kind === 'table') {
        for (const row of block.rows) if (row.kind === 'row') for (const cell of row.cells) if (cell.kind === 'cell') walk(cell.children);
      }
    }
  };
  walk(body);
  return out;
}

/** Where a paragraph's inline live blocks are, as offsets from its start. */
function inlineLive(paragraph: Paragraph): { from: number; to: number; tag: LiveTag }[] {
  const out: { from: number; to: number; tag: LiveTag }[] = [];
  const walk = (list: readonly Inline[], at: number): void => {
    for (const inline of list) {
      const length = inlineLength(inline);
      const tag = inline.kind === 'wrapper' ? liveTag(inline) : null;
      if (tag) out.push({ from: at, to: at + length, tag });
      else if (inline.kind === 'wrapper' || inline.kind === 'hyperlink') walk(inline.children, at);
      at += length;
    }
  };
  walk(paragraph.children, 0);
  return out;
}

/** The inline block that changing `from..to` of a paragraph would change only part of (or type into, when they are equal). */
function partOfInline(paragraph: Paragraph, from: number, to: number): LiveTag | null {
  for (const block of inlineLive(paragraph)) {
    if (from === to ? block.from < from && from < block.to : from < block.to && to > block.from && !(from <= block.from && to >= block.to)) return block.tag;
  }
  return null;
}

/**
 * The live block an edit from `start` to `end` (in document order; equal for typing at a caret) would change only part of,
 * or null when the edit may go ahead.
 */
export function livePartIn(body: Block[], start: Spot, end: Spot): LiveTag | null {
  const blocks = blockLive(body);
  const at = blocks.get(start.paragraph) ?? blocks.get(end.paragraph);
  if (at) return at;
  if (start.paragraph === end.paragraph) return partOfInline(start.paragraph, start.offset, end.offset);
  return partOfInline(start.paragraph, start.offset, paragraphLength(start.paragraph)) ?? partOfInline(end.paragraph, 0, end.offset);
}

/**
 * The range a Backspace or Delete at a caret takes away: the character before or after it, or the paragraph break, which
 * joins the paragraph before or after (null at the start or end of the document).
 */
export function deletedAround(paragraphs: readonly Paragraph[], caret: Spot, direction: 'backward' | 'forward'): { start: Spot; end: Spot } | null {
  const { paragraph, offset } = caret;
  const index = paragraphs.indexOf(paragraph);
  if (direction === 'backward') {
    if (offset > 0) return { start: { paragraph, offset: offset - 1 }, end: caret };
    const before = paragraphs[index - 1];
    return before ? { start: { paragraph: before, offset: paragraphLength(before) }, end: caret } : null;
  }
  if (offset < paragraphLength(paragraph)) return { start: caret, end: { paragraph, offset: offset + 1 } };
  const after = paragraphs[index + 1];
  return after ? { start: caret, end: { paragraph: after, offset: 0 } } : null;
}
