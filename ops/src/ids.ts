// SPDX-License-Identifier: MIT
// Paragraph ids and where every block lives.
//
// Ids are Word's own paragraph ids (w14:paraId: 8 hex digits below 0x80000000), stored in the
// paragraph so they survive saving. Paragraphs without one (or with a duplicate) get one on
// load, deterministically, so every client loading the same file assigns the same ids.

import { paragraphsIn, type Block, type Paragraph, type Table, type TableCell, type TableRow, type WordDocument } from '@golemdocs/docx';

const ID_ATTR = 'w14:paraId';
const MAX_ID = 0x80000000;

export function isParagraphId(value: string | undefined): value is string {
  return !!value && /^[0-9A-F]{8}$/.test(value) && parseInt(value, 16) < MAX_ID;
}

export const formatId = (n: number) => n.toString(16).toUpperCase().padStart(8, '0');

/**
 * Identifies a block among its siblings: a paragraph by its id, a table or content control by
 * the id of the first paragraph in it, anything else by its XML.
 */
export function blockKey(block: Block): string {
  switch (block.kind) {
    case 'paragraph':
      return block.attrs[ID_ATTR] ?? '';
    case 'table':
      return `table:${paragraphsIn([block])[0]?.attrs[ID_ATTR] ?? ''}`;
    case 'wrapper':
      return `wrapper:${paragraphsIn([block])[0]?.attrs[ID_ATTR] ?? JSON.stringify(block.shell)}`;
    case 'raw':
      return `raw:${JSON.stringify(block.xml)}`;
  }
}

export class DocumentIndex {
  private readonly byId = new Map<string, Paragraph>();
  /** The block list each block is in (body, table cell, content control). */
  private readonly parents = new Map<Block, Block[]>();
  /** The cell a list of blocks is the content of, and the row and table a cell is in. */
  private readonly cellOfContent = new WeakMap<Block[], TableCell>();
  private readonly rowOfCell = new WeakMap<TableCell, TableRow>();
  private readonly tableOfRow = new WeakMap<TableRow, Table>();

  constructor(readonly doc: WordDocument) {
    // Existing ids first (so generated ones never take an id a later paragraph has).
    const paragraphs = paragraphsIn(doc.body);
    const needsId: Paragraph[] = [];
    for (const p of paragraphs) {
      const id = p.attrs[ID_ATTR]?.toUpperCase();
      if (isParagraphId(id) && !this.byId.has(id)) {
        p.attrs[ID_ATTR] = id;
        this.byId.set(id, p);
      } else needsId.push(p);
    }
    let next = 1;
    for (const p of needsId) {
      while (this.byId.has(formatId(next))) next++;
      const id = formatId(next++);
      p.attrs[ID_ATTR] = id;
      this.byId.set(id, p);
    }
    this.addParents(doc.body);
  }

  private addParents(blocks: Block[]): void {
    for (const block of blocks) {
      this.parents.set(block, blocks);
      this.addChildren(block);
    }
  }

  /** Records the containers inside a block (content control content, table cells). */
  private addChildren(block: Block): void {
    if (block.kind === 'wrapper') this.addParents(block.children);
    else if (block.kind === 'table') {
      for (const row of block.rows) if (row.kind === 'row') this.addRow(block, row);
    }
  }

  private addRow(table: Table, row: TableRow): void {
    this.tableOfRow.set(row, table);
    for (const cell of row.cells) if (cell.kind === 'cell') this.addCell(row, cell);
  }

  private addCell(row: TableRow, cell: TableCell): void {
    this.rowOfCell.set(cell, row);
    this.cellOfContent.set(cell.children, cell);
    this.addParents(cell.children);
  }

  /** The table, row and cell a paragraph is directly in, or undefined if it isn't in a table cell. */
  locate(paragraph: Paragraph): { table: Table; row: TableRow; cell: TableCell } | undefined {
    const content = this.parents.get(paragraph);
    const cell = content && this.cellOfContent.get(content);
    const row = cell && this.rowOfCell.get(cell);
    const table = row && this.tableOfRow.get(row);
    return cell && row && table ? { table, row, cell } : undefined;
  }

  /** Records a row put into a table (its paragraphs must carry unused ids). */
  addedRow(table: Table, row: TableRow): void {
    for (const p of paragraphsIn(row.cells.flatMap((c) => (c.kind === 'cell' ? c.children : [])))) this.byId.set(p.attrs[ID_ATTR], p);
    this.addRow(table, row);
  }

  /** Records a cell put into a row. */
  addedCell(row: TableRow, cell: TableCell): void {
    for (const p of paragraphsIn(cell.children)) this.byId.set(p.attrs[ID_ATTR], p);
    this.addCell(row, cell);
  }

  id(paragraph: Paragraph): string {
    const id = paragraph.attrs[ID_ATTR];
    if (!id || this.byId.get(id) !== paragraph) throw new Error('paragraph is not in the document');
    return id;
  }

  paragraph(id: string): Paragraph | undefined {
    return this.byId.get(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  container(block: Block): Block[] | undefined {
    return this.parents.get(block);
  }

  /** An id no paragraph has, from a random source in [0, 1). */
  newId(random: () => number = Math.random): string {
    for (;;) {
      const id = formatId(Math.floor(random() * (MAX_ID - 1)) + 1);
      if (!this.byId.has(id)) return id;
    }
  }

  /** Records blocks inserted into `container` (their paragraphs must carry unused ids). */
  added(blocks: Block[], container: Block[]): void {
    for (const p of paragraphsIn(blocks)) this.byId.set(p.attrs[ID_ATTR], p);
    for (const block of blocks) {
      this.parents.set(block, container);
      this.addChildren(block);
    }
  }

  /** Forgets removed blocks and everything in them. */
  removed(blocks: Block[]): void {
    for (const p of paragraphsIn(blocks)) {
      if (this.byId.get(p.attrs[ID_ATTR]) === p) this.byId.delete(p.attrs[ID_ATTR]);
    }
    const forget = (list: Block[]) => {
      for (const block of list) {
        this.parents.delete(block);
        if (block.kind === 'wrapper') forget(block.children);
        else if (block.kind === 'table') {
          for (const row of block.rows) {
            if (row.kind !== 'row') continue;
            for (const cell of row.cells) if (cell.kind === 'cell') forget(cell.children);
          }
        }
      }
    };
    forget(blocks);
  }

  /** Forgets the content of removed table cells. */
  removedCells(cells: TableCell[]): void {
    for (const cell of cells) this.removed(cell.children);
  }

  /** Whether blocks can't be added: a paragraph without a valid id, or one already in use. */
  conflicts(blocks: Block[]): boolean {
    const seen = new Set<string>();
    for (const p of paragraphsIn(blocks)) {
      const id = p.attrs[ID_ATTR];
      if (!isParagraphId(id) || this.byId.has(id) || seen.has(id)) return true;
      seen.add(id);
    }
    return false;
  }
}
