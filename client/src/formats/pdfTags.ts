// The structure of an exported PDF (tagged PDF, see docs/architecture/accessibility.md): which structure element
// each paragraph's text goes in. Headings become H1–H6, list items LI in an L (nested by level), table cells TH or
// TD in their TR and Table, everything else P, and pictures a Figure with their description as alternate text.
// Headers and footers, and a table's header row repeated on a later page, are artifacts that screen readers skip.
// Elements are made when their paragraph's text is first drawn, so the tree is in the order the pages read.

import type { Block, Drawing, Inline, Paragraph, Table, TableCell, TableRow, WordDocument } from '@golemdocs/docx';
import { N, type StructNode, type StructureTree } from '@golemdocs/pdf';
import { HeadingReader, readableText } from '../layout/a11y.ts';
import { detectLanguage, languageOfTag } from '../spelling/languages.ts';

/** Most characters of a title made from a document's opening words. */
const TITLE_LENGTH = 60;

/** A table cell a paragraph is in, outermost first for a nested table. */
interface CellPlace {
  table: Table;
  row: TableRow;
  cell: TableCell;
}

/** An open list in a container: its level and kind, its L element, and the body of its last item (where a deeper list goes). */
interface OpenList {
  level: number;
  ordered: boolean;
  list: StructNode;
  body?: StructNode;
}

export class DocumentTags {
  private readonly cells = new Map<Paragraph, CellPlace[]>();
  /** Paragraphs of headers and footers. */
  private readonly furniture = new Set<Paragraph>();
  /** The paragraph each picture is in. */
  private readonly drawings = new Map<Drawing, Paragraph>();
  private readonly elements = new Map<Paragraph | Table | TableRow | TableCell, StructNode>();
  private readonly lists = new Map<StructNode, OpenList[]>();
  /** How far into each paragraph's visible text has been tagged, to tell a repeated header row from new text. */
  private readonly reached = new Map<Paragraph, number>();
  private readonly headings: HeadingReader;

  constructor(
    readonly doc: WordDocument,
    readonly tree: StructureTree,
  ) {
    this.headings = new HeadingReader(doc);
    this.walk(doc.body, [], false);
    for (const hf of doc.headersFooters.values()) this.walk(hf.children, [], true);
  }

  private walk(blocks: readonly Block[], place: CellPlace[], furniture: boolean): void {
    for (const block of blocks) {
      if (block.kind === 'paragraph') {
        if (place.length) this.cells.set(block, place);
        if (furniture) this.furniture.add(block);
        this.walkInlines(block, block.children, furniture);
      } else if (block.kind === 'table') {
        for (const row of block.rows) {
          if (row.kind !== 'row') continue;
          for (const cell of row.cells) if (cell.kind === 'cell') this.walk(cell.children, [...place, { table: block, row, cell }], furniture);
        }
      } else if (block.kind === 'wrapper') this.walk(block.children, place, furniture);
    }
  }

  private walkInlines(paragraph: Paragraph, inlines: readonly Inline[], furniture: boolean): void {
    for (const inline of inlines) {
      if (inline.kind === 'run') {
        for (const item of inline.content) {
          if (item.kind !== 'drawing') continue;
          this.drawings.set(item, paragraph);
          // A text box's text reads where it is drawn, as paragraphs of its own.
          if (item.textBox) this.walk(item.textBox, [], furniture);
        }
      } else if (inline.kind !== 'raw') this.walkInlines(paragraph, inline.children, furniture);
    }
  }

  /** Whether a paragraph is a header's or footer's. */
  isFurniture(paragraph: Paragraph): boolean {
    return this.furniture.has(paragraph);
  }

  /**
   * Whether a paragraph's text from `start` to `end` (visible offsets) on a page has been tagged already, as a
   * table's header row is when it repeats at the top of a later page; records it as tagged otherwise.
   */
  repeated(paragraph: Paragraph, start: number, end: number): boolean {
    const reached = this.reached.get(paragraph);
    if (reached !== undefined && end <= reached && start < reached) return true;
    this.reached.set(paragraph, Math.max(reached ?? 0, end));
    return false;
  }

  /** The element a paragraph's text goes in, made (with the table, row, cell or list around it) the first time. */
  element(paragraph: Paragraph): StructNode {
    const known = this.elements.get(paragraph);
    if (known) return known;
    let container = this.tree.root;
    for (const { table, row, cell } of this.cells.get(paragraph) ?? []) {
      const t = this.child(container, table, () => ({ type: 'Table', children: [] }));
      const tr = this.child(t, row, () => ({ type: 'TR', children: [] }));
      container = this.child(tr, cell, () => (row.properties.header ? { type: 'TH', children: [], attributes: { Table: { Scope: N('Column') } } } : { type: 'TD', children: [] }));
    }
    const level = this.headings.level(paragraph);
    const list = level ? null : this.headings.list(paragraph);
    let element: StructNode;
    if (list) element = this.listItem(container, list.level, list.ordered);
    else this.append(container, (element = { type: level ? `H${level}` : 'P', children: [] }));
    this.elements.set(paragraph, element);
    return element;
  }

  /** Where a picture's Figure goes: in its paragraph's element, the document's when it isn't in one, or null for a header's or footer's picture (an artifact). */
  figureParent(drawing: Drawing | undefined): StructNode | null {
    const paragraph = drawing && this.drawings.get(drawing);
    if (!paragraph) return this.tree.root;
    return this.isFurniture(paragraph) ? null : this.element(paragraph);
  }

  /** The paragraph a picture is in. */
  paragraphOf(drawing: Drawing | undefined): Paragraph | undefined {
    return drawing && this.drawings.get(drawing);
  }

  private child(parent: StructNode, key: Table | TableRow | TableCell, make: () => StructNode): StructNode {
    let node = this.elements.get(key);
    if (!node) {
      this.append(parent, (node = make()));
      this.elements.set(key, node);
    }
    return node;
  }

  /** Adds an element to a container, which ends any list open in it. */
  private append(container: StructNode, node: StructNode): void {
    container.children.push(node);
    this.lists.delete(container);
  }

  /**
   * A new list item at `level` (1–9) in a container: in the open list of that level and kind, or a new one (inside
   * the item before it, when deeper; after the list before it, when a numbered list follows a bulleted one). Returns its body.
   */
  private listItem(container: StructNode, level: number, ordered: boolean): StructNode {
    let open = this.lists.get(container);
    if (!open) this.lists.set(container, (open = []));
    while (open.length && open[open.length - 1].level > level) open.pop();
    let top = open[open.length - 1];
    if (top && top.level === level && top.ordered !== ordered) {
      open.pop();
      top = open[open.length - 1];
    }
    if (!top || top.level < level) {
      const list: StructNode = { type: 'L', children: [], attributes: { List: { ListNumbering: N(ordered ? 'Decimal' : 'Disc') } } };
      (top?.body ?? container).children.push(list);
      open.push((top = { level, ordered, list }));
    }
    const body: StructNode = { type: 'LBody', children: [] };
    top.list.children.push({ type: 'LI', children: [body] });
    top.body = body;
    return body;
  }

  /**
   * A title for a PDF whose document has none: its first heading's text, else the opening words of its first
   * paragraph with text (at most `TITLE_LENGTH` characters, cut between words).
   */
  fallbackTitle(): string | undefined {
    let opening: string | undefined;
    const visit = (blocks: readonly Block[]): string | undefined => {
      for (const block of blocks) {
        if (block.kind === 'paragraph') {
          const text = readableText(block).text.replace(/￼/g, '').replace(/\s+/g, ' ').trim();
          if (!text) continue;
          if (this.headings.level(block)) return text;
          opening ??= text;
        } else if (block.kind === 'wrapper') {
          const found = visit(block.children);
          if (found) return found;
        }
      }
      return undefined;
    };
    const heading = visit(this.doc.body);
    if (heading || !opening) return heading;
    if (opening.length <= TITLE_LENGTH) return opening;
    const cut = opening.slice(0, TITLE_LENGTH + 1);
    const space = cut.lastIndexOf(' ');
    return (space > 0 ? cut.slice(0, space) : cut.slice(0, TITLE_LENGTH)).replace(/[\s,;:.\-–—]+$/, '');
  }
}

/**
 * The document's language as a BCP 47 tag: the one its default run properties declare, else the one its text is
 * written in (Chinese, Japanese and Korean told apart by their scripts), else the app's (`locale`).
 */
export function documentLanguageTag(doc: WordDocument, locale: string): string {
  const declared = doc.styles.defaultRunProperties?.lang?.val?.trim();
  if (declared && languageOfTag(declared) !== null) return declared.replace(/_/g, '-');
  let sample = '';
  const visit = (blocks: readonly Block[]) => {
    for (const block of blocks) {
      if (sample.length >= 4000) return;
      if (block.kind === 'paragraph') sample += `${readableText(block).text}\n`;
      else if (block.kind === 'table') {
        for (const row of block.rows) if (row.kind === 'row') for (const cell of row.cells) if (cell.kind === 'cell') visit(cell.children);
      } else if (block.kind === 'wrapper') visit(block.children);
    }
  };
  visit(doc.body);
  const detected = detectLanguage(sample);
  if (detected && detected !== 'none') return detected;
  if (detected === 'none') {
    if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(sample)) return 'ja';
    if (/\p{Script=Hangul}/u.test(sample)) return 'ko';
    if (/\p{Script=Han}/u.test(sample)) return 'zh';
  }
  return locale;
}
