// A Markdown document's text edited as Markdown (an agent editing the vault's `.md` file, or the Markdown Source view),
// put back into the document without losing what Markdown can't say.
//
// The document keeps more than its Markdown file can hold: fonts, colours, sizes, alignment, pictures it holds the bytes
// of, comments with their dates. Reading the edited file afresh would lose all of that, everywhere, for an edit to one
// line. So the file is read, and then compared with the document block by block, each block as the Markdown writer
// writes it on its own (`markdownReader`):
//  - a block whose Markdown is the same is the document's own block, untouched;
//  - a changed paragraph is paired with the old one it is most like: it keeps that one's paragraph settings while it is
//    still the same kind of block (a heading of that level, a list item, a quote...), and the formatting of every piece
//    of its text that is still there (compared as Markdown sees it: the characters, bold, italic, struck, code, link);
//    only what was typed anew takes its formatting from the Markdown;
//  - a table whose rows and columns are the same keeps its look, and its cells are merged as paragraphs;
//  - new blocks come from the file, and blocks that are gone go.
// What comes from the file is made to fit the document: its lists join the document's list they continue, the styles
// it uses are added if the document lacks them, and its comments are the document's own where they are the same.

import { normalizeInlines, paragraphsIn, splitInlines, inlineLength, isMathInline, readMathInline, toLatex, WordDocument } from '@golemdocs/docx';
import type { Block, Comment, Inline, Paragraph, RunProperties, Style, Table } from '@golemdocs/docx';

import { placeholderBody } from './embedMarks.ts';

/** The most cells compared one by one when matching blocks or text; a bigger change is taken as a whole. */
const MAX_CELLS = 4_000_000;
/** How alike (0 to 1) two paragraphs must be to count as one edited. */
const ALIKE = 0.4;

/** How the Markdown writer sees a document (`markdownReader` in markdown.ts, passed in so this module doesn't load the writer itself). */
export interface MarkdownReader {
  /** A block on its own, as Markdown. */
  source(block: Block): string;
  /** The marks Markdown keeps of a run's formatting. */
  marks(props: RunProperties): { bold: boolean; italic: boolean; strike: boolean; code: boolean };
}
type Reader = MarkdownReader;

/**
 * `previous` with `next`'s body (read from Markdown), keeping what of `previous` is still there (see above). `reader`
 * reads a document as the Markdown writer does. Changes `previous` and returns it (`mergeMarkdown` in markdown.ts reads
 * the file and calls this).
 */
export function mergeDocuments(previous: WordDocument, next: WordDocument, reader: (doc: WordDocument) => MarkdownReader): WordDocument {
  const old = reader(previous);
  const fresh = reader(next);
  const a = previous.body.map((b) => old.source(b));
  const b = next.body.map((x) => fresh.source(x));
  const merge = new Merge(previous, next, old, fresh);
  const body: Block[] = [];
  for (const s of matchBlocks(a, b)) {
    if (s.kind === 'equal') {
      merge.matched(previous.body[s.i], next.body[s.j]);
      body.push(previous.body[s.i]);
      continue;
    }
    const pairs = pairBlocks(previous.body.slice(s.i0, s.i1), next.body.slice(s.j0, s.j1));
    for (let j = s.j0; j < s.j1; j++) {
      const i = pairs.get(j - s.j0);
      body.push(i === undefined ? merge.adopt(next.body[j]) : merge.block(previous.body[s.i0 + i], next.body[j]));
    }
  }
  previous.body = body.length ? body : [{ kind: 'paragraph', properties: {}, children: [], attrs: {} }];
  merge.finish();
  return previous;
}

// --- Matching blocks ------------------------------------------------------------------------------

type Segment = { kind: 'equal'; i: number; j: number } | { kind: 'change'; i0: number; i1: number; j0: number; j1: number };

/** Equal strings matched in order (a longest common subsequence), and the stretches between them. */
export function matchBlocks(a: readonly string[], b: readonly string[]): Segment[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const out: Segment[] = [];
  for (let k = 0; k < head; k++) out.push({ kind: 'equal', i: k, j: k });
  const i0 = head;
  const j0 = head;
  const n = a.length - tail - i0;
  const m = b.length - tail - j0;
  if (n > 0 || m > 0) {
    if (n === 0 || m === 0 || n * m > MAX_CELLS) out.push({ kind: 'change', i0, i1: i0 + n, j0, j1: j0 + m });
    else {
      const pairs = lcs(n, m, (i, j) => a[i0 + i] === b[j0 + j]);
      let fi = 0;
      let fj = 0;
      for (const [i, j] of [...pairs, [n, m] as const]) {
        if (i > fi || j > fj) out.push({ kind: 'change', i0: i0 + fi, i1: i0 + i, j0: j0 + fj, j1: j0 + j });
        if (i < n) out.push({ kind: 'equal', i: i0 + i, j: j0 + j });
        fi = i + 1;
        fj = j + 1;
      }
    }
  }
  for (let k = tail; k > 0; k--) out.push({ kind: 'equal', i: a.length - k, j: b.length - k });
  return out;
}

/** The pairs (i, j) of a longest common subsequence of two sequences of lengths n and m, in order. */
function lcs(n: number, m: number, same: (i: number, j: number) => boolean): [number, number][] {
  const w = m + 1;
  const table = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * w + j] = same(i, j) ? table[(i + 1) * w + j + 1] + 1 : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
    }
  }
  const out: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (same(i, j)) {
      out.push([i, j]);
      i++;
      j++;
    } else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) i++;
    else j++;
  }
  return out;
}

/**
 * In a stretch that changed, which old block (by index in `olds`) each new one (by index in `news`) is an edit of: the
 * pairing, in order, that makes the pairs most alike. Only paragraphs with paragraphs and tables with tables, and only
 * pairs alike enough.
 */
function pairBlocks(olds: readonly Block[], news: readonly Block[]): Map<number, number> {
  const pairs = new Map<number, number>();
  const n = olds.length;
  const m = news.length;
  if (!n || !m) return pairs;
  if (n * m > 10_000) {
    // Too big to weigh every pair: in order, as far as the kinds agree.
    for (let k = 0; k < Math.min(n, m); k++) if (olds[k].kind === news[k].kind && olds[k].kind !== 'wrapper') pairs.set(k, k);
    return pairs;
  }
  const oldText = olds.map(blockText);
  const newText = news.map(blockText);
  const score = (i: number, j: number): number => {
    if (olds[i].kind !== news[j].kind || olds[i].kind === 'wrapper') return 0;
    const s = alike(oldText[i], newText[j]);
    return s >= ALIKE ? s : 0;
  };
  // The best total likeness of pairs taken in order (an alignment).
  const w = m + 1;
  const best = new Float64Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const s = score(i, j);
      best[i * w + j] = Math.max(best[(i + 1) * w + j], best[i * w + j + 1], s > 0 ? best[(i + 1) * w + j + 1] + s : 0);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const s = score(i, j);
    if (s > 0 && best[i * w + j] === best[(i + 1) * w + j + 1] + s) {
      pairs.set(j, i);
      i++;
      j++;
    } else if (best[(i + 1) * w + j] >= best[i * w + j + 1]) i++;
    else j++;
  }
  return pairs;
}

/** How alike two texts are, 0 to 1: the share of their letter pairs they have in common (Dice's coefficient). */
export function alike(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const counts = new Map<string, number>();
  for (let k = 0; k < a.length - 1; k++) {
    const pair = a.slice(k, k + 2);
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  let shared = 0;
  for (let k = 0; k < b.length - 1; k++) {
    const pair = b.slice(k, k + 2);
    const c = counts.get(pair);
    if (c) {
      shared++;
      counts.set(pair, c - 1);
    }
  }
  return (2 * shared) / (a.length + b.length - 2);
}

// --- Text, piece by piece -------------------------------------------------------------------------

/** A piece of a paragraph as Markdown sees it (a character with its marks and link, a picture, an equation...) and the positions it covers. */
interface Piece {
  key: string;
  from: number;
  to: number;
}

const COMMENT_NAMES = new Set(['w:commentRangeStart', 'w:commentRangeEnd', 'w:commentReference']);

// --- The merge ------------------------------------------------------------------------------------

class Merge {
  /** The file's lists (numbering instance ids) and the document's each one continues. */
  private readonly lists = new Map<number, number>();
  /** The file's comments (by id) and the document's they are. */
  private readonly comments = new Map<string, string>();
  /** The styles that what is taken from the file uses, and the document's comments it has taken. */
  private readonly usedStyles = new Set<string>();
  private readonly commentsTaken = new Set<string>();
  /** Paragraphs taken from the file, whose lists are numbered once every list is known. */
  private readonly adopted: Paragraph[] = [];

  constructor(
    private readonly doc: WordDocument,
    private readonly next: WordDocument,
    private readonly old: Reader,
    private readonly fresh: Reader,
  ) {}

  /** Two blocks that are the same: the file's lists in it are the document's. */
  matched(a: Block, b: Block): void {
    const olds = paragraphsIn([a]);
    paragraphsIn([b]).forEach((p, k) => this.sameList(olds[k], p));
  }

  /** The file's list of `p` continues the document's list of `old`, if they look alike. */
  private sameList(old: Paragraph | undefined, p: Paragraph): void {
    const id = p.properties.numbering?.id;
    const was = old?.properties.numbering?.id;
    if (id === undefined || was === undefined || this.lists.has(id)) return;
    const level = p.properties.numbering?.level ?? 0;
    if (levelFormat(this.next, id, level) === levelFormat(this.doc, was, old?.properties.numbering?.level ?? 0)) this.lists.set(id, was);
  }

  /** A block the file has anew: made to fit the document. */
  adopt(block: Block): Block {
    const copy = structuredClone(block);
    this.take(copy);
    return copy;
  }

  /** What the file has in place of `old`: merged when they are the same kind of block, else the file's. */
  block(old: Block, block: Block): Block {
    if (old.kind === 'paragraph' && block.kind === 'paragraph') return this.paragraph(old, block);
    if (old.kind === 'table' && block.kind === 'table') return this.table(old, block) ?? this.adopt(block);
    return this.adopt(block);
  }

  /** A table with the same rows and columns keeps its look, and its cells' paragraphs are merged; otherwise null. */
  private table(old: Table, table: Table): Table | null {
    const shape = (t: Table) => t.rows.map((r) => (r.kind === 'row' ? r.cells.filter((c) => c.kind === 'cell').length : -1)).join(',');
    if (shape(old) !== shape(table)) return null;
    const merged = structuredClone(old);
    merged.rows.forEach((row, r) => {
      const other = table.rows[r];
      if (row.kind !== 'row' || other.kind !== 'row') return;
      const cells = other.cells.filter((c) => c.kind === 'cell');
      row.cells.filter((c) => c.kind === 'cell').forEach((cell, c) => {
        const theirs = cells[c];
        if (cell.kind !== 'cell' || theirs?.kind !== 'cell') return;
        const mine = cell.children.filter((x): x is Paragraph => x.kind === 'paragraph');
        const paras = theirs.children.filter((x): x is Paragraph => x.kind === 'paragraph');
        cell.children = paras.map((p, k) => (mine[k] ? this.paragraph(mine[k], p) : (this.adopt(p) as Paragraph)));
        if (!cell.children.length) cell.children = [{ kind: 'paragraph', properties: {}, children: [], attrs: {} }];
      });
    });
    return merged;
  }

  /**
   * The file's paragraph, with what is still the same of the old one kept: its paragraph settings while it is the same
   * kind of block, and the formatting of the text that is still there.
   */
  paragraph(old: Paragraph, p: Paragraph): Paragraph {
    this.sameList(old, p);
    const sameKind = this.old.source(shapeOf(old)) === this.fresh.source(shapeOf(p));
    let properties = old.properties;
    if (!sameKind) {
      const copy = structuredClone(p);
      this.take(copy);
      properties = copy.properties;
    }
    const a = this.pieces(this.doc, this.old, old.children);
    const b = this.pieces(this.next, this.fresh, p.children);
    const children: Inline[] = [];
    const keep = (from: number, to: number) => {
      if (to > from) children.push(...slice(old.children, from, to));
    };
    const add = (from: number, to: number) => {
      if (to <= from) return;
      const part = structuredClone(slice(p.children, from, to));
      this.collect(part);
      children.push(...part);
    };
    const pairs = a.length * b.length > MAX_CELLS ? [] : lcs(a.length, b.length, (i, j) => a[i].key === b[j].key);
    // Walked in runs of matched pieces: the old text of a run is kept, and what the file has between two runs is new.
    const startOf = (j: number) => (j < b.length ? b[j].from : end(b));
    let placed = 0;
    for (let k = 0; k < pairs.length; ) {
      const [i, j] = pairs[k];
      let run = 1;
      while (k + run < pairs.length && pairs[k + run][0] === i + run && pairs[k + run][1] === j + run) run++;
      add(startOf(placed), b[j].from);
      keep(a[i].from, a[i + run - 1].to);
      placed = j + run;
      k += run;
    }
    add(startOf(placed), end(b));
    return { ...old, properties, children: normalizeInlines(children) };
  }

  /** A paragraph's pieces, as Markdown sees them. */
  private pieces(doc: WordDocument, reader: Reader, inlines: readonly Inline[]): Piece[] {
    const out: Piece[] = [];
    let pos = 0;
    const comment = (id: string) => {
      const c = doc.comments.find((x) => x.id === id);
      return c ? `${c.author}|${c.date ?? ''}|${c.paragraphs.join('\n')}` : id;
    };
    const walk = (list: readonly Inline[], link: string) => {
      for (const inline of list) {
        const length = inlineLength(inline);
        switch (inline.kind) {
          case 'run': {
            const m = reader.marks(inline.properties);
            const marks = `${m.bold ? 'b' : ''}${m.italic ? 'i' : ''}${m.strike ? 's' : ''}${m.code ? 'c' : ''}${link}`;
            for (const item of inline.content) {
              if (item.kind === 'text') {
                for (let k = 0; k < item.text.length; k++) out.push({ key: `${marks}|${item.text[k]}`, from: pos + k, to: pos + k + 1 });
                pos += item.text.length;
                continue;
              }
              let key: string;
              if (item.kind === 'tab') key = `${marks}|\t`;
              else if (item.kind === 'noBreakHyphen') key = `${marks}|-`;
              else if (item.kind === 'break' || item.kind === 'cr') key = '\n';
              else if (item.kind === 'drawing') key = `img:${item.description || item.name || ''}|${item.image ? item.image.slice(item.image.lastIndexOf('/') + 1) : ''}`;
              else if (item.kind === 'raw' && COMMENT_NAMES.has(item.xml.name)) key = `cm:${item.xml.name}:${comment(item.xml.attrs['w:id'] ?? '')}`;
              else key = `obj:${item.kind}`;
              const len = item.kind === 'delText' || item.kind === 'instrText' ? item.text.length : 1;
              out.push({ key, from: pos, to: pos + len });
              pos += len;
            }
            break;
          }
          case 'hyperlink': {
            const embed = placeholderBody(inline);
            const image = imageAlt(inline);
            if (embed !== null || image !== null) {
              out.push({ key: embed !== null ? `embed:${embed}` : `img:${image}|${inline.url ?? ''}`, from: pos, to: pos + length });
              pos += length;
            } else walk(inline.children, inline.url !== undefined || inline.anchor !== undefined ? `>${inline.url ?? `#${inline.anchor}`}` : link);
            break;
          }
          case 'wrapper':
            walk(inline.children, link);
            break;
          case 'raw': {
            const key = COMMENT_NAMES.has(inline.xml.name) ? `cm:${inline.xml.name}:${comment(inline.xml.attrs['w:id'] ?? '')}` : isMathInline(inline) ? `math:${toLatex(readMathInline(inline))}` : 'obj:raw';
            out.push({ key, from: pos, to: pos + 1 });
            pos += 1;
            break;
          }
        }
      }
    };
    walk(inlines, '');
    return out;
  }

  /** Content from the file, made to fit the document: its lists, styles and comments (lists are numbered in `finish`). */
  private take(block: Block): void {
    this.adopted.push(...paragraphsIn([block]));
    this.collect(block);
  }

  /** Notes the styles and comments some content from the file uses. */
  private collect(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const v of value) this.collect(v);
      return;
    }
    const record = value as Record<string, unknown>;
    if (record.kind === 'raw' && typeof record.xml === 'object' && record.xml) {
      const xml = record.xml as { name: string; attrs: Record<string, string> };
      if (COMMENT_NAMES.has(xml.name) && xml.attrs['w:id'] !== undefined) xml.attrs['w:id'] = this.comment(xml.attrs['w:id']);
    }
    if (typeof record.style === 'string') this.usedStyles.add(record.style);
    for (const [k, v] of Object.entries(record)) if (k !== 'xml') this.collect(v);
  }

  /** The document's id for the file's comment `id`: the same comment if the document has it, else the file's, added. */
  private comment(id: string): string {
    const known = this.comments.get(id);
    if (known !== undefined) return known;
    const c = this.next.comments.find((x) => x.id === id);
    let mine: string;
    if (!c) mine = id;
    else {
      const same = this.doc.comments.find((x) => !this.commentsTaken.has(x.id) && x.author === c.author && (x.date ?? '') === (c.date ?? '') && x.paragraphs.join('\n') === c.paragraphs.join('\n'));
      if (same) mine = same.id;
      else {
        mine = String(Math.max(-1, ...this.doc.comments.map((x) => Number(x.id)).filter(Number.isFinite)) + 1);
        const added: Comment = { ...structuredClone(c), id: mine };
        // A reply's parent is the document's too.
        if (c.parentId !== undefined) added.parentId = this.comment(c.parentId);
        this.doc.comments.push(added);
      }
    }
    this.commentsTaken.add(mine);
    this.comments.set(id, mine);
    // A thread's replies come with it.
    for (const reply of this.next.comments) if (reply.parentId === id) this.comment(reply.id);
    return mine;
  }

  /** Once the body is whole: the file's lists are the document's, the styles it uses are there, comments no longer in it go. */
  finish(): void {
    let instanceId = Math.max(0, ...this.doc.numbering.instances.map((x) => x.id)) + 1;
    let abstractId = Math.max(-1, ...this.doc.numbering.abstracts.map((x) => x.id)) + 1;
    for (const p of this.adopted) {
      const n = p.properties.numbering;
      if (n?.id === undefined) continue;
      let id = this.lists.get(n.id);
      if (id === undefined) {
        const instance = this.next.numbering.instances.find((x) => x.id === n.id);
        const abstract = instance && this.next.numbering.abstracts.find((x) => x.id === instance.abstractId);
        if (!instance || !abstract) continue;
        this.doc.numbering.abstracts.push({ ...structuredClone(abstract), id: abstractId });
        this.doc.numbering.instances.push({ ...structuredClone(instance), id: instanceId, abstractId });
        abstractId++;
        id = instanceId++;
        this.lists.set(n.id, id);
      }
      p.properties.numbering = { ...n, id };
    }
    this.addStyles();
    this.dropComments();
  }

  /** The styles the file's content uses that the document lacks (with what they are based on). */
  private addStyles(): void {
    const have = new Set(this.doc.styles.styles.map((s) => s.id));
    const added: Style[] = [];
    const add = (id: string | undefined) => {
      if (!id || have.has(id)) return;
      const style = this.next.styles.styles.find((s) => s.id === id);
      if (!style) return;
      have.add(id);
      added.push(structuredClone(style));
      add(style.basedOn);
      add(style.next);
      add(style.link);
    };
    for (const id of this.usedStyles) add(id);
    if (added.length) this.doc.styles = { ...this.doc.styles, styles: [...this.doc.styles.styles, ...added] };
  }

  /** Comments whose range is no longer in the body go, with their replies. */
  private dropComments(): void {
    const marked = new Set<string>();
    const walk = (v: unknown) => {
      if (!v || typeof v !== 'object') return;
      if (Array.isArray(v)) return v.forEach(walk);
      const r = v as Record<string, unknown>;
      if (r.kind === 'raw' && r.xml && typeof r.xml === 'object') {
        const xml = r.xml as { name: string; attrs: Record<string, string> };
        if (COMMENT_NAMES.has(xml.name) && xml.attrs['w:id'] !== undefined) marked.add(xml.attrs['w:id']);
      }
      for (const [k, x] of Object.entries(r)) if (k !== 'xml') walk(x);
    };
    walk(this.doc.body);
    const byId = new Map(this.doc.comments.map((c) => [c.id, c]));
    const kept = (c: Comment, seen = new Set<string>()): boolean => {
      if (marked.has(c.id)) return true;
      if (c.parentId === undefined || seen.has(c.id)) return false;
      seen.add(c.id);
      const parent = byId.get(c.parentId);
      return !!parent && kept(parent, seen);
    };
    const comments = this.doc.comments.filter((c) => kept(c));
    if (comments.length !== this.doc.comments.length) this.doc.comments = comments;
  }
}

/** A block's visible text, for telling how alike two blocks are. */
function blockText(block: Block): string {
  return paragraphsIn([block]).map(paragraphPlain).join('\n');
}

function paragraphPlain(p: Paragraph): string {
  let out = '';
  const walk = (list: readonly Inline[]) => {
    for (const inline of list) {
      if (inline.kind === 'run') for (const item of inline.content) out += item.kind === 'text' ? item.text : item.kind === 'tab' ? '\t' : '';
      else if (inline.kind !== 'raw') walk(inline.children);
    }
  };
  walk(p.children);
  return out;
}

/** The kind of block a paragraph is, as Markdown writes it: the paragraph with its text replaced by one letter. */
function shapeOf(p: Paragraph): Paragraph {
  return { ...p, children: [{ kind: 'run', properties: {}, content: [{ kind: 'text', text: 'x' }], attrs: {} }] };
}

/** The alt text of a link that stands for a picture (`![alt](url)` read without its bytes), or null. */
function imageAlt(h: Extract<Inline, { kind: 'hyperlink' }>): string | null {
  if (h.url === undefined || !h.children.length) return null;
  let text = '';
  for (const c of h.children) {
    if (c.kind !== 'run' || c.properties.style !== 'ImagePlaceholder') return null;
    for (const item of c.content) if (item.kind === 'text') text += item.text;
  }
  const m = /^\[Image(?:: ([\s\S]*))?\]$/.exec(text);
  return m ? (m[1] ?? '') : null;
}

/** How a list's level is numbered (bullet, decimal...) and where it starts, for telling whether two lists are one. */
function levelFormat(doc: WordDocument, id: number, level: number): string {
  const instance = doc.numbering.instances.find((x) => x.id === id);
  const abstract = instance && doc.numbering.abstracts.find((x) => x.id === instance.abstractId);
  const override = instance?.overrides.find((o) => o.level === level);
  const def = override?.definition ?? abstract?.levels.find((l) => l.level === level);
  return def ? `${def.format ?? ''}|${def.text ?? ''}|${override?.startOverride ?? def.start ?? 1}` : '';
}

/** Positions [from, to) of some inlines. */
function slice(inlines: readonly Inline[], from: number, to: number): Inline[] {
  return splitInlines(splitInlines(inlines, from)[1], to - from)[0];
}

const end = (pieces: readonly Piece[]): number => pieces.at(-1)?.to ?? 0;

