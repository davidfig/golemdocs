// Tables, and pasting content (which may hold tables).
import { type TableEdit, type CommandResult, NO_CHANGE, combine } from './types.ts';

import { inlinesLength, paragraphLength, paragraphsIn, type Block, type Paragraph, type Table, type TableCell, type TableCellProperties, type TableRow } from '@golemdocs/docx';
import { blockKey, type Operation, type Pos } from '@golemdocs/ops';
import { mergeCells, splitCell } from './tableModel.ts';
import { EditorSections } from './sections.ts';

export abstract class EditorTables extends EditorSections {
  protected insertTableOps(rows: number, columns: number, define: Operation[]): [Operation[], Pos] | null {
    rows = Math.floor(rows);
    columns = Math.floor(columns);
    if (!(rows >= 1 && rows <= 500 && columns >= 1 && columns <= 63)) return null;
    const [start] = this.ordered();
    const paragraph = start.paragraph;
    const container = this.replica.engine.index.container(paragraph);
    // Tables go in the body (a table in a table cell is a step further).
    if (!container || container !== this.doc.body) return null;
    // Cell paragraphs need ids of their own, all different.
    const fresh = this.idMaker();
    const ops: Operation[] = [...define];
    const anchor = this.replica.id(paragraph);
    let needsTrailer = false;
    // At the start of a paragraph the table goes above it; the paragraph is the one after it.
    const above = start.offset === 0;
    if (above) {
      // (nothing to split, nothing to add after)
    } else if (start.offset < paragraphLength(paragraph)) {
      // In the middle of text: what follows the caret goes below the table.
      const [split] = this.splitOps(start);
      ops.push(...split);
    } else {
      // The table has to be followed by a paragraph.
      needsTrailer = container[container.indexOf(paragraph) + 1]?.kind !== 'paragraph';
    }
    const width = Math.floor(this.textWidth() / columns);
    const cellParagraph = (): Paragraph => ({ kind: 'paragraph', properties: {}, children: [], attrs: { 'w14:paraId': fresh() } });
    const table: Table = {
      kind: 'table',
      properties: { style: 'TableGrid', width: { w: '0', type: 'auto' }, look: { val: '0420', firstRow: true, noVBand: true } },
      grid: new Array<number>(columns).fill(width),
      rows: Array.from({ length: rows }, (): TableRow => ({
        kind: 'row',
        properties: {},
        cells: Array.from({ length: columns }, (): TableCell => ({ kind: 'cell', properties: { width: { w: String(width), type: 'dxa' } }, children: [cellParagraph()], attrs: {} })),
        attrs: {},
      })),
    };
    const first = paragraphsIn([table])[0].attrs['w14:paraId'];
    const blocks: Block[] = needsTrailer ? [table, cellParagraph()] : [table];
    ops.push({ type: 'insertBlocks', after: anchor, blocks, ...(above && { before: true }) });
    return [ops, { paragraph: first, offset: 0 }];
  }

  protected pasteContent(source: Block[], define: Operation[]): CommandResult {
    const blocks = structuredClone(source);
    const fresh = this.idMaker();
    for (const p of paragraphsIn(blocks)) p.attrs = { ...p.attrs, 'w14:paraId': fresh() };
    // Over a selection, typing over it: the two are one undo step.
    const group = this.collapsed ? undefined : `replace:${this.commands++}`;
    const removed = this.collapsed ? NO_CHANGE : this.edit(this.deleteSelection(), group);
    const at = this.selection.focus;
    const p = at.paragraph;
    // A table can't go in a table cell (yet).
    const list = blocks.filter((b) => b.kind === 'paragraph' || !this.replica.engine.index.locate(p));
    if (list.length === 0) return removed;
    const id = this.replica.id(p);
    const length = paragraphLength(p);
    const ops: Operation[] = [...define];

    const only = list.length === 1 && list[0].kind === 'paragraph' ? list[0] : null;
    if (only) {
      if (only.children.length === 0) return removed;
      ops.push({ type: 'insertContent', paragraph: id, offset: at.offset, content: only.children });
      return combine(removed, this.edit([ops, { paragraph: id, offset: at.offset + inlinesLength(only.children) }], group));
    }

    const remainder = at.offset < length;
    const head = list[0].kind === 'paragraph' ? list[0] : null;
    let tail = remainder && list[list.length - 1].kind === 'paragraph' && list.length > 1 ? (list[list.length - 1] as Paragraph) : null;
    const middle = list.slice(head ? 1 : 0, tail ? list.length - 1 : list.length);
    // Ending on a table needs a paragraph after it (with text after the caret, that is the split-off rest).
    if (!remainder && middle.length && middle[middle.length - 1].kind === 'table') middle.push({ kind: 'paragraph', properties: {}, children: [], attrs: { 'w14:paraId': fresh() } });
    let splitId: string | undefined;
    if (remainder) {
      const [splitting] = this.splitOps(at);
      splitId = (splitting.find((op) => op.type === 'split') as Extract<Operation, { type: 'split' }>).id;
      ops.push(...splitting);
    } else tail = null;
    if (head) {
      // An empty paragraph takes the look of what is pasted into it (a heading, a list item).
      if (length === 0 && !remainder) ops.push(this.setProperties(p, { ...structuredClone(head.properties), section: p.properties.section }));
      if (head.children.length) ops.push({ type: 'insertContent', paragraph: id, offset: at.offset, content: head.children });
    }
    if (middle.length) ops.push({ type: 'insertBlocks', after: id, blocks: middle });
    if (tail && splitId) ops.push({ type: 'insertContent', paragraph: splitId, offset: 0, content: tail.children });

    let after: Pos = { paragraph: id, offset: at.offset + (head ? inlinesLength(head.children) : 0) };
    const lastMiddle = middle.length ? paragraphsIn([middle[middle.length - 1]]).at(-1) : undefined;
    if (splitId && (tail || middle.at(-1)?.kind === 'table')) after = { paragraph: splitId, offset: tail ? inlinesLength(tail.children) : 0 };
    else if (lastMiddle) after = { paragraph: lastMiddle.attrs['w14:paraId'], offset: paragraphLength(lastMiddle) };
    return combine(removed, this.edit([ops, after], group));
  }

  /** Whether the selection is in a table cell (for the Table menu). */
  inTable(): boolean {
    return this.paragraphInTable(this.selection.focus.paragraph);
  }

  /** Whether a paragraph is in a table cell (a right click there offers the table's commands). */
  paragraphInTable(paragraph: Paragraph): boolean {
    return !!this.replica.engine.index.locate(paragraph);
  }

  /** Each real row of a table with its cells and the grid columns [from, to) each covers. */
  protected gridOf(table: Table): { row: TableRow; cells: { cell: TableCell; from: number; to: number }[] }[] {
    return table.rows
      .filter((r): r is TableRow => r.kind === 'row')
      .map((row) => {
        let at = row.properties.gridBefore ?? 0;
        const cells: { cell: TableCell; from: number; to: number }[] = [];
        for (const cell of row.cells) {
          if (cell.kind !== 'cell') continue;
          const span = Math.max(cell.properties.gridSpan ?? 1, 1);
          cells.push({ cell, from: at, to: at + span });
          at += span;
        }
        return { row, cells };
      });
  }

  /** The table the selection is in, with the rows and grid columns it touches: null outside a table. */
  protected tableSelection() {
    const [start, end] = this.ordered();
    const index = this.replica.engine.index;
    const a = index.locate(start.paragraph);
    if (!a) return null;
    const b = index.locate(end.paragraph);
    const grid = this.gridOf(a.table);
    const rowOf = (l: { row: TableRow }) => grid.findIndex((g) => g.row === l.row);
    const spanOf = (l: { row: TableRow; cell: TableCell }) => grid[rowOf(l)]?.cells.find((c) => c.cell === l.cell);
    const other = b && b.table === a.table ? b : a;
    const sa = spanOf(a);
    const sb = spanOf(other);
    if (!sa || !sb) return null;
    const ra = rowOf(a);
    const rb = rowOf(other);
    return { table: a.table, grid, first: Math.min(ra, rb), last: Math.max(ra, rb), from: Math.min(sa.from, sb.from), to: Math.max(sa.to, sb.to) };
  }

  protected firstParagraphId(cells: readonly (TableCell | { kind: string })[]): string | undefined {
    const p = paragraphsIn(cells.flatMap((c) => (c.kind === 'cell' ? (c as TableCell).children : [])))[0];
    return p && this.replica.id(p);
  }

  /** Makes ids no paragraph has, all different (also from each other before they are added). */
  protected idMaker(): () => string {
    const taken = new Set<string>();
    return () => {
      let id: string;
      do id = this.replica.newId();
      while (taken.has(id));
      taken.add(id);
      return id;
    };
  }

  /** An empty cell like another: its width and look, one empty paragraph (in the same style). */
  protected blankCell(like: TableCell, fresh: () => string, properties: TableCellProperties = {}): TableCell {
    const { vMerge: _v, hMerge: _h, gridSpan: _g, ...kept } = structuredClone(like.properties);
    const source = paragraphsIn(like.children)[0];
    const { numbering: _n, section: _s, ...paragraphProperties } = structuredClone(source?.properties ?? {});
    return { kind: 'cell', properties: { ...kept, ...properties }, attrs: {}, children: [{ kind: 'paragraph', properties: paragraphProperties, children: [], attrs: { 'w14:paraId': fresh() } }] };
  }

  protected tableEdit(edit: TableEdit): CommandResult {
    const sel = this.tableSelection();
    if (!sel) return NO_CHANGE;
    if (edit === 'selectTable') {
      const ps = paragraphsIn([sel.table]);
      this.selection = { anchor: { paragraph: ps[0], offset: 0 }, focus: { paragraph: ps[ps.length - 1], offset: paragraphLength(ps[ps.length - 1]) } };
      return NO_CHANGE;
    }
    if (edit === 'mergeCells') {
      const merged = mergeCells(sel.table, { first: sel.first, last: sel.last, from: sel.from, to: sel.to }, this.idMaker());
      return this.edit(merged && this.replaceTable(sel.table, merged.table, merged.caret));
    }
    const plan =
      edit === 'insertRowAbove' || edit === 'insertRowBelow'
        ? this.insertRowsOps(sel, edit === 'insertRowAbove')
        : edit === 'insertColumnLeft' || edit === 'insertColumnRight'
          ? this.insertColumnsOps(sel, edit === 'insertColumnLeft')
          : edit === 'deleteRows'
            ? this.deleteRowsOps(sel)
            : edit === 'deleteColumns'
              ? this.deleteColumnsOps(sel)
              : this.deleteTableOps(sel.table);
    return this.edit(plan);
  }

  protected insertRowsOps(sel: NonNullable<ReturnType<EditorTables['tableSelection']>>, above: boolean): [Operation[], Pos] | null {
    const reference = sel.grid[above ? sel.first : sel.last].row;
    const anchor = this.firstParagraphId(reference.cells);
    if (!anchor) return null;
    const fresh = this.idMaker();
    // As many rows as are selected, each like the row beside them.
    const ops: Operation[] = [];
    for (let i = sel.first; i <= sel.last; i++) {
      const { header: _header, ...properties } = structuredClone(reference.properties);
      const cells = reference.cells.filter((c): c is TableCell => c.kind === 'cell').map((c) => this.blankCell(c, fresh, { gridSpan: c.properties.gridSpan }));
      ops.push({ type: 'insertRow', paragraph: anchor, after: !above, row: { kind: 'row', properties, cells, attrs: {} } });
    }
    return [ops, this.selectionIds.focus];
  }

  /** Width of the grid columns [from, to) in a grid, twips. */
  protected span(widths: number[], from: number, to: number): number {
    let sum = 0;
    for (let c = from; c < to; c++) sum += widths[c] ?? 0;
    return sum;
  }

  protected setWidth(properties: TableCellProperties, width: number, gridSpan?: number): TableCellProperties | null {
    const next: TableCellProperties = { ...properties };
    if (properties.width?.type === 'dxa') next.width = { ...properties.width, w: String(Math.round(width)) };
    if (gridSpan !== undefined) {
      if (gridSpan > 1) next.gridSpan = gridSpan;
      else delete next.gridSpan;
    }
    return JSON.stringify(next) === JSON.stringify(properties) ? null : next;
  }

  protected insertColumnsOps(sel: NonNullable<ReturnType<EditorTables['tableSelection']>>, left: boolean): [Operation[], Pos] | null {
    const { table, grid } = sel;
    // Without a grid there are no columns to add to.
    if (table.grid.length === 0) return null;
    const g = left ? sel.from : sel.to;
    const width = table.grid[left ? sel.from : sel.to - 1] ?? 1440;
    let widths = [...table.grid];
    widths.splice(g, 0, width);
    // Wider than the page: every column narrows to fit.
    const total = widths.reduce((a, b) => a + b, 0);
    const limit = this.textWidth();
    if (total > limit) widths = widths.map((w) => Math.max(Math.floor((w * limit) / total), 1));
    const firstRow = grid[0]?.row;
    const anchor = firstRow && this.firstParagraphId(firstRow.cells);
    if (!anchor) return null;
    const fresh = this.idMaker();
    const ops: Operation[] = [{ type: 'setTableGrid', paragraph: anchor, grid: widths }];
    for (const { cells } of grid) {
      const reference = cells.find((c) => c.from <= g && g < c.to) ?? cells[cells.length - 1];
      if (!reference) continue;
      for (const c of cells) {
        const id = this.firstParagraphId([c.cell]);
        if (!id) continue;
        // A cell across the new column gets wider; ones after it move over; the rest keep their place.
        const crossing = c.from < g && g < c.to;
        const from = c.from >= g ? c.from + 1 : c.from;
        const to = c.to > g || crossing ? c.to + 1 : c.to;
        const next = this.setWidth(c.cell.properties, this.span(widths, from, to), crossing ? c.to - c.from + 1 : undefined);
        if (next) ops.push({ type: 'setCellProperties', paragraph: id, properties: next });
      }
      // A row whose cells cross the new column has nothing to add; the others get a cell.
      if (cells.some((c) => c.from < g && g < c.to)) continue;
      const before = cells.find((c) => c.from >= g);
      const target = before ?? cells[cells.length - 1];
      const id = this.firstParagraphId([target.cell]);
      if (id) ops.push({ type: 'insertCell', paragraph: id, after: !before, cell: this.blankCell(reference.cell, fresh, { width: reference.cell.properties.width?.type === 'dxa' ? { w: String(widths[g]), type: 'dxa' } : reference.cell.properties.width }) });
    }
    return [ops, this.selectionIds.focus];
  }

  protected deleteRowsOps(sel: NonNullable<ReturnType<EditorTables['tableSelection']>>): [Operation[], Pos] | null {
    if (sel.first === 0 && sel.last === sel.grid.length - 1) return this.deleteTableOps(sel.table);
    const ops: Operation[] = [];
    for (let i = sel.first; i <= sel.last; i++) {
      const id = this.firstParagraphId(sel.grid[i].row.cells);
      if (id) ops.push({ type: 'removeRow', paragraph: id });
    }
    // The caret goes to the row that takes their place (or the one before, at the end of the table).
    const survivor = sel.grid[sel.last + 1] ?? sel.grid[sel.first - 1];
    const id = survivor && this.firstParagraphId(survivor.row.cells);
    return id ? [ops, { paragraph: id, offset: 0 }] : null;
  }

  protected deleteColumnsOps(sel: NonNullable<ReturnType<EditorTables['tableSelection']>>): [Operation[], Pos] | null {
    const { table, grid } = sel;
    const columns = Math.max(table.grid.length, ...grid.map((g) => g.cells[g.cells.length - 1]?.to ?? 0));
    if (sel.from <= 0 && sel.to >= columns) return this.deleteTableOps(table);
    const removed = sel.to - sel.from;
    const widths = [...table.grid];
    widths.splice(sel.from, removed);
    const firstRow = grid[0]?.row;
    const anchor = firstRow && this.firstParagraphId(firstRow.cells);
    if (!anchor) return null;
    const ops: Operation[] = widths.length ? [{ type: 'setTableGrid', paragraph: anchor, grid: widths }] : [];
    let caret: Pos | null = null;
    for (const { cells } of grid) {
      for (const c of cells) {
        const id = this.firstParagraphId([c.cell]);
        if (!id) continue;
        const overlap = Math.min(c.to, sel.to) - Math.max(c.from, sel.from);
        if (overlap >= c.to - c.from) {
          ops.push({ type: 'removeCell', paragraph: id });
          continue;
        }
        // Each edge moves left by the deleted columns before it: left of them a cell stays, right of them it moves, across them it narrows.
        const shift = (x: number) => x - Math.min(Math.max(x - sel.from, 0), removed);
        const from = shift(c.from);
        const to = shift(c.to);
        const next = this.setWidth(c.cell.properties, this.span(widths, from, to), overlap > 0 ? c.to - c.from - overlap : undefined);
        if (next) ops.push({ type: 'setCellProperties', paragraph: id, properties: next });
        if (!caret && c === cells.find((x) => x.from >= sel.to)) caret = { paragraph: id, offset: 0 };
      }
    }
    return [ops, caret ?? { paragraph: anchor, offset: 0 }];
  }

  protected deleteTableOps(table: Table): [Operation[], Pos] | null {
    const container = this.replica.engine.index.container(table);
    if (!container) return null;
    const i = container.indexOf(table);
    const previous = container[i - 1];
    const next = container[i + 1];
    const key = blockKey(table);
    // Removed from beside a paragraph: the one before it, or (a table at the start) the one after.
    if (previous?.kind === 'paragraph') {
      const id = this.replica.id(previous);
      return [[{ type: 'removeBlocks', after: id, keys: [key] }], { paragraph: id, offset: paragraphLength(previous) }];
    }
    if (next?.kind === 'paragraph') {
      const id = this.replica.id(next);
      return [[{ type: 'removeBlocks', after: id, keys: [key], before: true }], { paragraph: id, offset: 0 }];
    }
    return null;
  }

  /** Puts `next` in the place of a table, as one edit (and one undo step): the old one goes, the new one comes. */
  protected replaceTable(old: Table, next: Table, caret: Paragraph): [Operation[], Pos] | null {
    const container = this.replica.engine.index.container(old);
    if (!container) return null;
    const i = container.indexOf(old);
    const previous = container[i - 1];
    const following = container[i + 1];
    // Beside a paragraph: the one before it, or (a table first in its container) the one after.
    const before = previous?.kind !== 'paragraph';
    const anchor = previous?.kind === 'paragraph' ? previous : following?.kind === 'paragraph' ? following : null;
    if (!anchor) return null;
    const id = this.replica.id(anchor);
    const side = before ? { before: true } : {};
    return [[{ type: 'removeBlocks', after: id, keys: [blockKey(old)], ...side }, { type: 'insertBlocks', after: id, blocks: [next], ...side }], { paragraph: caret.attrs['w14:paraId'], offset: 0 }];
  }

  protected splitCells(columns: number, rows: number): CommandResult {
    const sel = this.tableSelection();
    const [start] = this.ordered();
    const at = sel && this.replica.engine.index.locate(start.paragraph);
    if (!sel || !at) return NO_CHANGE;
    const row = sel.grid.findIndex((g) => g.row === at.row);
    const span = sel.grid[row]?.cells.find((c) => c.cell === at.cell);
    if (!span) return NO_CHANGE;
    const split = splitCell(sel.table, row, span.from, Math.floor(columns), Math.floor(rows), this.idMaker());
    return this.edit(split && this.replaceTable(sel.table, split.table, split.caret));
  }

  protected selectCell(cell: TableCell): void {
    const ps = paragraphsIn(cell.children);
    if (ps.length === 0) return;
    this.selection = { anchor: { paragraph: ps[0], offset: 0 }, focus: { paragraph: ps[ps.length - 1], offset: paragraphLength(ps[ps.length - 1]) } };
  }

  protected tab(backward: boolean): CommandResult {
    const [, end] = this.ordered();
    const at = this.replica.engine.index.locate(end.paragraph);
    if (!at) return backward ? NO_CHANGE : this.apply({ kind: 'insertText', text: '\t' });
    const cells = this.gridOf(at.table).flatMap((g) => g.cells.map((c) => c.cell));
    const here = cells.indexOf(at.cell);
    const target = cells[here + (backward ? -1 : 1)];
    if (target) {
      this.selectCell(target);
      return NO_CHANGE;
    }
    if (backward) return NO_CHANGE;
    // Tab in the last cell adds a row and goes to its first cell.
    const sel = this.tableSelection();
    if (!sel) return NO_CHANGE;
    const [ops] = this.insertRowsOps({ ...sel, first: sel.grid.length - 1, last: sel.grid.length - 1 }, false) ?? [[]];
    const first = ops[0]?.type === 'insertRow' ? this.firstPara(ops[0].row) : undefined;
    return this.edit(ops.length && first ? [ops, { paragraph: first, offset: 0 }] : null);
  }

  protected firstPara(row: TableRow): string | undefined {
    return paragraphsIn(row.cells.flatMap((c) => (c.kind === 'cell' ? c.children : [])))[0]?.attrs['w14:paraId'];
  }
}
