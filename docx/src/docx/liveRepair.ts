// SPDX-License-Identifier: MIT
// A live block around a table, as LibreOffice gives it back (docs/live-blocks.md, M0). Writer has no content control around a
// table: saving a .docx, it moves the control's tag into the table's first cell, as a plain-text control (`<w:text/>`) around
// that cell's text. Read as it is, the block would be a value in a cell, and its next update would put the whole table there.
// So a live tag found that way (the first thing in the first cell, plain text) goes back around the table.

import { LIVE_PREFIX, sdtTag } from '../search/links.ts';
import type { Block, Inline, Paragraph, Table, Wrapper } from '../model/types.ts';
import type { XmlElement } from '../xml/xml.ts';

const isPlainText = (shell: XmlElement): boolean =>
  shell.children.some((c) => typeof c !== 'string' && c.name === 'w:sdtPr' && c.children.some((p) => typeof p !== 'string' && p.name === 'w:text'));

/** An inline that shows nothing (an empty run, as LibreOffice writes at the start of a control). */
const empty = (inline: Inline): boolean => inline.kind === 'run' && inline.content.length === 0;

/** The live control a table's first cell starts with, if it is one LibreOffice moved there; and the paragraph it is in. */
function movedTag(table: Table): { paragraph: Paragraph; wrapper: Wrapper<Inline> } | null {
  const row = table.rows[0];
  const cell = row?.kind === 'row' ? row.cells[0] : undefined;
  const paragraph = cell?.kind === 'cell' ? cell.children[0] : undefined;
  if (paragraph?.kind !== 'paragraph') return null;
  const first = paragraph.children.find((i) => !empty(i));
  if (first?.kind !== 'wrapper' || !sdtTag(first.shell)?.startsWith(LIVE_PREFIX) || !isPlainText(first.shell)) return null;
  return { paragraph, wrapper: first };
}

/** Puts live tags LibreOffice moved into tables back around them, at any depth. */
export function liftMovedLiveTags(list: Block[]): void {
  list.forEach((block, index) => {
    if (block.kind === 'wrapper') return liftMovedLiveTags(block.children);
    if (block.kind !== 'table') return;
    for (const row of block.rows) if (row.kind === 'row') for (const cell of row.cells) if (cell.kind === 'cell') liftMovedLiveTags(cell.children);
    const moved = movedTag(block);
    if (!moved) return;
    const at = moved.paragraph.children.indexOf(moved.wrapper);
    moved.paragraph.children.splice(at, 1, ...moved.wrapper.children);
    const shell = structuredClone(moved.wrapper.shell);
    for (const c of shell.children) if (typeof c !== 'string' && c.name === 'w:sdtPr') c.children = c.children.filter((p) => typeof p === 'string' || p.name !== 'w:text');
    list[index] = { kind: 'wrapper', shell, contentElement: 'w:sdtContent', children: [block] };
  });
}
