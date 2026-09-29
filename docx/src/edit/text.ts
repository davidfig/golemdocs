// Text editing on the model.
//
// Positions are model offsets within a paragraph: every UTF-16 unit of text (w:t, w:delText,
// w:instrText) is one position and every other run item (tab, break, drawing, field char...)
// is exactly one. They depend only on the model, not on fonts, styles or layout, so the same
// operation means the same thing on every client and on a server. Layout maps them to what
// is visible (hidden text, field results) when it lays a paragraph out.

import type { Block, Inline, Paragraph, Run, RunContent, RunProperties, StyleSheet, Table } from '../model/types.ts';

/** One character standing for a non-text position in paragraphText(). */
export const OBJECT_CHAR = '￼';

export function itemLength(item: RunContent): number {
  return item.kind === 'text' || item.kind === 'delText' || item.kind === 'instrText' ? item.text.length : 1;
}

export function inlineLength(inline: Inline): number {
  switch (inline.kind) {
    case 'run': {
      let n = 0;
      for (const item of inline.content) n += itemLength(item);
      return n;
    }
    case 'hyperlink':
    case 'wrapper':
      return inlinesLength(inline.children);
    case 'raw':
      return 1;
  }
}

export function inlinesLength(inlines: readonly Inline[]): number {
  let n = 0;
  for (const inline of inlines) n += inlineLength(inline);
  return n;
}

export function paragraphLength(paragraph: Paragraph): number {
  return inlinesLength(paragraph.children);
}

/**
 * The paragraph's positions as a string: text as is, every other position as U+FFFC.
 * Indices are model offsets (for word boundaries, surrogate pairs, search).
 */
export function paragraphText(paragraph: Paragraph): string {
  const out: string[] = [];
  const walk = (inlines: readonly Inline[]) => {
    for (const inline of inlines) {
      if (inline.kind === 'run') {
        for (const item of inline.content) {
          if (item.kind === 'text' || item.kind === 'delText' || item.kind === 'instrText') out.push(item.text);
          else out.push(OBJECT_CHAR);
        }
      } else if (inline.kind === 'raw') out.push(OBJECT_CHAR);
      else walk(inline.children);
    }
  };
  walk(paragraph.children);
  return out.join('');
}

/**
 * Plain text of the positions [from, to), for the clipboard: text as is, tabs as \t, line
 * breaks as \n, deleted text and other items dropped.
 */
export function plainText(paragraph: Paragraph, from = 0, to = Infinity): string {
  const out: string[] = [];
  let pos = 0;
  const take = (text: string, length: number) => {
    const a = Math.max(from - pos, 0);
    const b = Math.min(to - pos, length);
    if (b > a) out.push(text.length === length ? text.slice(a, b) : text);
    pos += length;
  };
  const walk = (inlines: readonly Inline[]) => {
    for (const inline of inlines) {
      if (pos >= to) return;
      if (inline.kind === 'run') {
        for (const item of inline.content) {
          if (item.kind === 'text') take(item.text, item.text.length);
          else if (item.kind === 'tab') take('\t', 1);
          else if (item.kind === 'break' || item.kind === 'cr') take(item.kind === 'break' && item.type === 'page' ? '' : '\n', 1);
          else pos += itemLength(item);
        }
      } else if (inline.kind === 'raw') pos += 1;
      else if (inline.kind === 'wrapper' && (inline.shell.name === 'w:del' || inline.shell.name === 'w:moveFrom')) pos += inlineLength(inline);
      else walk(inline.children);
    }
  };
  walk(paragraph.children);
  return out.join('');
}

const clone = <T>(value: T): T => structuredClone(value);

/** Wrappers whose content isn't live text: typing never lands inside them. */
function isRemoved(inline: Inline): boolean {
  return inline.kind === 'wrapper' && (inline.shell.name === 'w:del' || inline.shell.name === 'w:moveFrom');
}

// --- Splitting ---------------------------------------------------------------------------

/** Splits one inline at 0 < offset < inlineLength(inline) into two of the same kind. */
function splitInline(inline: Inline, offset: number): [Inline, Inline] {
  switch (inline.kind) {
    case 'run': {
      const left: RunContent[] = [];
      const right: RunContent[] = [];
      let pos = 0;
      for (const item of inline.content) {
        const len = itemLength(item);
        if (pos + len <= offset) left.push(item);
        else if (pos >= offset) right.push(item);
        else if (item.kind === 'text' || item.kind === 'delText' || item.kind === 'instrText') {
          left.push({ ...item, text: item.text.slice(0, offset - pos) });
          right.push({ ...item, text: item.text.slice(offset - pos) });
        }
        pos += len;
      }
      return [
        { ...inline, content: left },
        { kind: 'run', properties: clone(inline.properties), content: right, attrs: { ...inline.attrs } },
      ];
    }
    case 'hyperlink': {
      const [a, b] = splitInlines(inline.children, offset);
      return [
        { ...inline, children: a },
        { ...inline, children: b, attrs: { ...inline.attrs } },
      ];
    }
    case 'wrapper': {
      const [a, b] = splitInlines(inline.children, offset);
      return [
        { ...inline, children: a },
        { ...inline, shell: clone(inline.shell), children: b },
      ];
    }
    case 'raw':
      throw new Error('a raw inline has one position and cannot be split');
  }
}

/**
 * Splits inline content at a model offset. Zero-length content exactly at the offset (an
 * empty content control, say) goes left, or right with `zeroRight`.
 */
export function splitInlines(inlines: readonly Inline[], offset: number, zeroRight = false): [Inline[], Inline[]] {
  const left: Inline[] = [];
  const right: Inline[] = [];
  let pos = 0;
  for (const inline of inlines) {
    const len = inlineLength(inline);
    if (pos + len < offset || (pos + len === offset && !(zeroRight && len === 0 && pos === offset))) left.push(inline);
    else if (pos >= offset) right.push(inline);
    else {
      const [a, b] = splitInline(inline, offset - pos);
      left.push(a);
      right.push(b);
    }
    pos += len;
  }
  return [left, right];
}

// --- Normalizing -------------------------------------------------------------------------

function firstRun(inlines: readonly Inline[]): Run | undefined {
  for (const inline of inlines) {
    if (inline.kind === 'run') return inline;
    if ((inline.kind === 'hyperlink' || inline.kind === 'wrapper') && !isRemoved(inline)) {
      const run = firstRun(inline.children);
      if (run) return run;
    }
  }
  return undefined;
}

function lastRun(inlines: readonly Inline[]): Run | undefined {
  for (let i = inlines.length - 1; i >= 0; i--) {
    const inline = inlines[i];
    if (inline.kind === 'run') return inline;
    if ((inline.kind === 'hyperlink' || inline.kind === 'wrapper') && !isRemoved(inline)) {
      const run = lastRun(inline.children);
      if (run) return run;
    }
  }
  return undefined;
}

const emptyRun = (properties: RunProperties | undefined): Run => ({
  kind: 'run',
  properties: clone(properties ?? {}),
  content: [],
  attrs: {},
});

/** Hyperlinks or wrappers that are the same element (apart from their content). */
function sameContainer(a: Inline, b: Inline): boolean {
  const { children: _a, ...restA } = a as { children: unknown };
  const { children: _b, ...restB } = b as { children: unknown };
  return JSON.stringify(restA) === JSON.stringify(restB);
}

const sameFormat = (a: Run, b: Run) =>
  JSON.stringify(a.properties) === JSON.stringify(b.properties) && JSON.stringify(a.attrs) === JSON.stringify(b.attrs);

/**
 * Puts inline content in canonical form: neighboring runs with the same formatting become one,
 * neighboring text items too, pieces of one hyperlink or content control join up, and empty
 * runs go. Content that's the same is then structured the same, however edits produced it
 * (collaborating clients rely on this to end up with identical documents).
 */
export function normalizeInlines(inlines: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const inline of inlines) {
    if (inline.kind === 'hyperlink' || inline.kind === 'wrapper') {
      // Pieces of one hyperlink or content control (split by an edit) join up again.
      const previous = out.at(-1);
      if (previous && previous.kind === inline.kind && sameContainer(previous, inline)) {
        previous.children = normalizeInlines([...previous.children, ...inline.children]);
      } else {
        inline.children = normalizeInlines(inline.children);
        out.push(inline);
      }
      continue;
    }
    if (inline.kind !== 'run') {
      out.push(inline);
      continue;
    }
    if (inline.content.every((item) => item.kind === 'text' && item.text === '')) continue;
    const previous = out.at(-1);
    if (previous?.kind === 'run' && sameFormat(previous, inline)) {
      previous.content.push(...inline.content);
    } else {
      out.push(inline);
    }
    // Neighboring text items in the (possibly merged) run.
    const run = out.at(-1) as Run;
    const merged: RunContent[] = [];
    for (const item of run.content) {
      if (item.kind === 'text' && item.text === '') continue;
      const last = merged.at(-1);
      if (item.kind === 'text' && last?.kind === 'text') merged[merged.length - 1] = { ...last, text: last.text + item.text };
      else merged.push(item);
    }
    run.content = merged;
  }
  return out;
}

// --- Operations --------------------------------------------------------------------------

/** Inserts text into a run at an offset within it; false if the offset isn't in this run. */
function insertIntoRun(run: Run, offset: number, text: string): boolean {
  let pos = 0;
  for (let i = 0; i < run.content.length; i++) {
    const item = run.content[i];
    const len = itemLength(item);
    if (item.kind === 'text' && offset >= pos && offset <= pos + len) {
      run.content[i] = { ...item, text: item.text.slice(0, offset - pos) + text + item.text.slice(offset - pos) };
      return true;
    }
    if (offset === pos) {
      run.content.splice(i, 0, { kind: 'text', text });
      return true;
    }
    pos += len;
  }
  if (offset === pos) {
    run.content.push({ kind: 'text', text });
    return true;
  }
  return false;
}

/** Inserts into the first run that reaches the offset (so text takes the formatting before it). */
function insertInto(inlines: Inline[], offset: number, text: string): boolean {
  let pos = 0;
  for (const inline of inlines) {
    const len = inlineLength(inline);
    if (offset <= pos + len && !isRemoved(inline)) {
      if (inline.kind === 'run' && insertIntoRun(inline, offset - pos, text)) return true;
      if ((inline.kind === 'hyperlink' || inline.kind === 'wrapper') && insertInto(inline.children, offset - pos, text)) return true;
    }
    pos += len;
    if (pos > offset) break;
  }
  return false;
}

/**
 * Inserts text at a model offset. It takes the formatting of the text before it (or after it
 * at the start of a paragraph); a paragraph without runs gets one in its mark's formatting.
 */
export function insertText(paragraph: Paragraph, offset: number, text: string): void {
  if (!text) return;
  if (!insertInto(paragraph.children, offset, text)) {
    const run = emptyRun(paragraph.properties.runProperties);
    run.content.push({ kind: 'text', text });
    const [a, b] = splitInlines(paragraph.children, offset);
    paragraph.children = [...a, run, ...b];
  }
}

/** Inserts a non-text item (tab, line break) at a model offset, formatted like text there. */
export function insertItem(paragraph: Paragraph, offset: number, item: RunContent): void {
  // Insert a placeholder character, then swap it for the item.
  const marker = '\u0000';
  insertText(paragraph, offset, marker);
  const swap = (inlines: Inline[]): boolean => {
    for (const inline of inlines) {
      if (inline.kind === 'run') {
        for (let i = 0; i < inline.content.length; i++) {
          const c = inline.content[i];
          const at = c.kind === 'text' ? c.text.indexOf(marker) : -1;
          if (c.kind !== 'text' || at < 0) continue;
          const parts: RunContent[] = [];
          if (at > 0) parts.push({ ...c, text: c.text.slice(0, at) });
          parts.push(item);
          if (at + 1 < c.text.length) parts.push({ ...c, text: c.text.slice(at + 1) });
          inline.content.splice(i, 1, ...parts);
          return true;
        }
      } else if (inline.kind !== 'raw' && swap(inline.children)) return true;
    }
    return false;
  };
  swap(paragraph.children);
}

/** Deletes the positions [from, to) of a paragraph; returns what was removed. */
export function deleteText(paragraph: Paragraph, from: number, to: number): Inline[] {
  if (to <= from) return [];
  const [before, rest] = splitInlines(paragraph.children, from);
  // Zero-length content at either end stays (only what's strictly inside goes).
  const [removed, after] = splitInlines(rest, to - from, true);
  // Nothing keeps the deleted text's formatting when everything goes: deletes stay exactly
  // invertible. (An editor carries it over in the paragraph mark's formatting, as Word does.)
  paragraph.children = normalizeInlines([...before, ...after]);
  return removed;
}

/** Inserts inline content (runs, hyperlinks...) at a model offset. */
export function insertInlines(paragraph: Paragraph, offset: number, content: Inline[]): void {
  const [a, b] = splitInlines(paragraph.children, offset);
  paragraph.children = normalizeInlines([...a, ...content, ...b]);
}

/**
 * Splits a paragraph's content at a model offset: the paragraph keeps the first part and the
 * rest is returned.
 */
export function splitContent(paragraph: Paragraph, offset: number): Inline[] {
  const [a, b] = splitInlines(paragraph.children, offset);
  paragraph.children = normalizeInlines(a);
  return normalizeInlines(b);
}

/** Formatting of the text at a model offset: the run before it, or else the one after it. */
export function runPropertiesAt(paragraph: Paragraph, offset: number): RunProperties | undefined {
  const [a, b] = splitInlines(paragraph.children, offset);
  return (lastRun(a) ?? firstRun(b))?.properties;
}

/**
 * Properties for a paragraph started by Enter: a copy of the current one's, with the style's
 * next style at the end of a paragraph (Heading 1 -> Normal).
 */
export function newParagraphProperties(
  properties: import('../model/types.ts').ParagraphProperties,
  atEnd: boolean,
  styles?: Pick<StyleSheet, 'styles'>,
  /** Formatting at the split: the new paragraph's mark takes it, so typing there continues it. */
  runProperties?: RunProperties,
): import('../model/types.ts').ParagraphProperties {
  const out = clone(properties);
  if (runProperties) out.runProperties = clone(runProperties);
  if (atEnd && styles && out.style) {
    const next = styles.styles.find((s) => s.type === 'paragraph' && s.id === out.style)?.next;
    if (next && next !== out.style) {
      out.style = next;
      // A heading's direct keep settings don't carry into body text.
      delete out.keepNext;
    }
  }
  return out;
}

/** Attributes that must stay unique per paragraph (Word's paragraph ids). */
const UNIQUE_ATTRS = ['w14:paraId', 'w14:textId'];

/**
 * Splits a paragraph at a model offset (Enter). The paragraph keeps the first part; the new
 * paragraph returned gets the rest and a copy of the paragraph's properties. The caller puts
 * it after the original (see insertBlockAfter). At the end of a paragraph whose style names
 * a next style (Heading 1 -> Normal), the new paragraph takes it.
 */
export function splitParagraph(paragraph: Paragraph, offset: number, styles?: Pick<StyleSheet, 'styles'>): Paragraph {
  const atEnd = offset >= paragraphLength(paragraph);
  const properties = newParagraphProperties(paragraph.properties, atEnd, styles, runPropertiesAt(paragraph, offset));
  const children = splitContent(paragraph, offset);
  // The section break belongs to the paragraph mark, which ends the second paragraph.
  delete paragraph.properties.section;
  const attrs = { ...paragraph.attrs };
  for (const name of UNIQUE_ATTRS) delete attrs[name];
  return { kind: 'paragraph', properties, children, attrs };
}

/**
 * Appends `second`'s content to `first` (Backspace at the start of `second`). The merged
 * paragraph keeps `first`'s formatting, and `second`'s section break if it had one. The
 * caller removes `second` from its container.
 */
export function mergeParagraphs(first: Paragraph, second: Paragraph): void {
  first.children = normalizeInlines([...first.children, ...second.children]);
  if (second.properties.section) first.properties.section = second.properties.section;
}

// --- Containers --------------------------------------------------------------------------

/** The block list directly containing a block (body, table cell, content control), if any. */
export function findContainer(blocks: Block[], target: Block): Block[] | undefined {
  for (const block of blocks) {
    if (block === target) return blocks;
    if (block.kind === 'wrapper') {
      const found = findContainer(block.children, target);
      if (found) return found;
    } else if (block.kind === 'table') {
      const found = findInTable(block, target);
      if (found) return found;
    }
  }
  return undefined;
}

function findInTable(table: Table, target: Block): Block[] | undefined {
  for (const row of table.rows) {
    if (row.kind !== 'row') continue;
    for (const cell of row.cells) {
      if (cell.kind !== 'cell') continue;
      const found = findContainer(cell.children, target);
      if (found) return found;
    }
  }
  return undefined;
}

export function insertBlockAfter(container: Block[], after: Block, block: Block): void {
  const index = container.indexOf(after);
  if (index < 0) throw new Error('block is not in this container');
  container.splice(index + 1, 0, block);
}

export function removeBlock(container: Block[], block: Block): void {
  const index = container.indexOf(block);
  if (index >= 0) container.splice(index, 1);
}

/** Every paragraph in document order, including those in tables and content controls. */
export function paragraphsIn(blocks: readonly Block[], out: Paragraph[] = []): Paragraph[] {
  for (const block of blocks) {
    if (block.kind === 'paragraph') out.push(block);
    else if (block.kind === 'wrapper') paragraphsIn(block.children, out);
    else if (block.kind === 'table') {
      for (const row of block.rows) {
        if (row.kind !== 'row') continue;
        for (const cell of row.cells) if (cell.kind === 'cell') paragraphsIn(cell.children, out);
      }
    }
  }
  return out;
}
