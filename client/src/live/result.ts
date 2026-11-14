// What a live block shows, in a shape that belongs to no format (docs/live-blocks.md §1), and how a document holds it.
// A producer (sources.ts) makes a result; the host turns it into its own content here: a table becomes a Word table, a value
// a run of text, a picture an inline drawing, part of a text document its own blocks (update.ts puts those in place). The Markdown, HTML and ODT writers then save those like any other content.

import { paragraphText, paragraphsIn } from '@golemdocs/docx';
import type { Block, Border, Inline, Paragraph, Table, TableCell, TableRow, WordDocument } from '@golemdocs/docx';
import { sniffImage } from '../formats/images.ts';

export type Align = 'left' | 'center' | 'right';

/** The most of a table a block shows: more is a sign the address is wrong, and too much for a document to hold. */
export const MAX_ROWS = 2000;
export const MAX_COLUMNS = 50;

export type LiveResult =
  /** Rows of cells as shown (number formats applied); the first row is a header when `header` is set. */
  | { kind: 'table'; rows: string[][]; header: boolean; align: Align[] }
  /** One value, as shown. */
  | { kind: 'value'; text: string }
  /** A picture: its bytes, and for a drawing its SVG beside them; its size in pixels. */
  | { kind: 'picture'; bytes: Uint8Array; svg?: string; width: number; height: number }
  /** Part of a text document: its blocks, the document they are from (for their styles and lists), and their pictures' bytes by part. */
  | { kind: 'blocks'; blocks: Block[]; from: WordDocument; pictures: Record<string, Uint8Array> }
  /** Why there is no result (the block keeps its last one and shows this, through `t('live.error.<code>')`). */
  | { kind: 'error'; code: LiveError; detail?: string };

/** Why a block could not be updated. */
export type LiveError = 'unreadable' | 'empty' | 'noTable' | 'notRange' | 'notFound' | 'notSheet' | 'missing' | 'cycle' | 'unsupported' | 'script' | 'notAllowed' | 'blocked' | 'foreign';

const HAIRLINE: Border = { val: 'single', sz: 4, space: 0, color: 'BFBFBF' };
const EMU_PER_PIXEL = 9525;
const TWIPS_PER_CHAR = 140;

const run = (text: string, bold: boolean): Inline => ({ kind: 'run', properties: bold ? { bold: true } : {}, content: [{ kind: 'text', text }], attrs: {} });

function cellParagraph(text: string, align: Align, bold: boolean): Paragraph {
  const children: Inline[] = [];
  text.split(/\r\n|\r|\n/).forEach((line, i) => {
    if (i > 0) children.push({ kind: 'run', properties: bold ? { bold: true } : {}, content: [{ kind: 'break' }], attrs: {} });
    if (line) children.push(run(line, bold));
  });
  return { kind: 'paragraph', properties: align === 'left' ? {} : { justification: align }, children, attrs: {} };
}

/** A table of the rows, sized to the text: hairline borders and a shaded header row, as Markdown's tables are read. */
export function tableOf(result: Extract<LiveResult, { kind: 'table' }>, textWidth = 9360): Table {
  const columns = result.rows.reduce((m, r) => Math.max(m, r.length), 0) || 1;
  const longest = Array.from({ length: columns }, (_, c) => result.rows.reduce((m, r) => Math.max(m, ...(r[c] ?? '').split('\n').map((l) => l.length)), 1));
  const wanted = longest.map((n) => Math.max(n * TWIPS_PER_CHAR + 360, 900)); // the cell's margins (108 twips a side) and a little room
  const total = wanted.reduce((a, b) => a + b, 0);
  const grid = total > textWidth ? wanted.map((w) => Math.max(300, Math.floor((w * textWidth) / total))) : wanted;
  const rows = (result.rows.length ? result.rows : [['']]).map((cells, r): TableRow => {
    const header = result.header && r === 0;
    const out: TableCell[] = [];
    for (let c = 0; c < columns; c++) {
      out.push({
        kind: 'cell',
        properties: { width: { w: String(grid[c]), type: 'dxa' }, ...(header && { shading: { val: 'clear', color: 'auto', fill: 'F2F2F2' } }) },
        children: [cellParagraph(cells[c] ?? '', result.align[c] ?? 'left', false)],
        attrs: {},
      });
    }
    return { kind: 'row', properties: header ? { header: true, cantSplit: true } : { cantSplit: true }, cells: out, attrs: {} };
  });
  return {
    kind: 'table',
    properties: {
      width: { w: '0', type: 'auto' },
      layout: 'fixed',
      borders: { top: HAIRLINE, left: HAIRLINE, bottom: HAIRLINE, right: HAIRLINE, insideH: HAIRLINE, insideV: HAIRLINE },
      cellMargins: { top: { w: '15', type: 'dxa' }, bottom: { w: '15', type: 'dxa' } },
    },
    grid,
    rows,
  };
}

/** The drawing a picture result is, in `document` (its picture, and SVG, added as parts), at most `most` EMU wide. */
export function drawingOf(result: Extract<LiveResult, { kind: 'picture' }>, document: WordDocument, name: string, keep?: { width: number; height: number }): Inline | null {
  const image = sniffImage(result.bytes);
  if (!image) return null;
  const { pageSize, margins } = document.section;
  const most = ((pageSize?.w ?? 12240) - (margins?.left ?? 1440) - (margins?.right ?? 1440)) * 635;
  const w = Math.max(result.width || image.width, 1);
  const h = Math.max(result.height || image.height, 1);
  // A picture already placed keeps the width set in the document, and its height follows the new proportions.
  let width = keep?.width ?? w * EMU_PER_PIXEL;
  let height = Math.round((width * h) / w);
  if (!keep && most > 0 && width > most) {
    height = Math.round((height * most) / width);
    width = most;
  }
  const part = document.addImage(result.bytes, image.type);
  const svg = result.svg ? document.addImage(new TextEncoder().encode(result.svg), 'svg') : undefined;
  return { kind: 'run', properties: {}, content: [{ kind: 'drawing', inline: true, width, height, image: part, ...(svg && { svg }), name, description: name }], attrs: {} };
}

/** The text width of a document's page, in twips. */
export function textWidthOf(document: WordDocument): number {
  const { pageSize, margins } = document.section;
  return (pageSize?.w ?? 12240) - (margins?.left ?? 1440) - (margins?.right ?? 1440);
}

/** The blocks a result is as a block of its own (a table, a paragraph holding a value or a picture). */
export function resultBlocks(result: LiveResult, document: WordDocument, name: string, keep?: { width: number; height: number }): Block[] | null {
  switch (result.kind) {
    case 'table':
      return [tableOf(result, textWidthOf(document))];
    case 'value':
      return [{ kind: 'paragraph', properties: {}, children: [run(result.text, false)], attrs: {} }];
    case 'picture': {
      const drawing = drawingOf(result, document, name, keep);
      return drawing ? [{ kind: 'paragraph', properties: {}, children: [drawing], attrs: {} }] : null;
    }
    default:
      return null;
  }
}

/** The inlines a result is inside a paragraph: a value's text, a picture, or a table's cells run together. */
export function resultInlines(result: LiveResult, document: WordDocument, name: string, keep?: { width: number; height: number }): Inline[] | null {
  switch (result.kind) {
    case 'value':
      return [run(result.text, false)];
    case 'table':
      return [run(result.rows.map((r) => r.join(' ')).join('; '), false)];
    case 'blocks':
      return [run(paragraphsIn(result.blocks).map(paragraphText).filter((s) => s.trim()).join(' '), false)];
    case 'picture': {
      const drawing = drawingOf(result, document, name, keep);
      return drawing ? [drawing] : null;
    }
    default:
      return null;
  }
}
