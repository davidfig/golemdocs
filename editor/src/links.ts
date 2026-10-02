// Hyperlinks and equations under the selection or a point.
import { type Position } from './types.ts';
import type { Command } from './types.ts';
import { paragraphLength } from '@golemdocs/docx';

import { inlineLength, inlinesLength, mathAt, plainText, readMathInline, runPropertiesAt, splitInlines, type MathEquation, type Hyperlink, type Inline, type Paragraph } from '@golemdocs/docx';
import { type Operation, type Pos } from '@golemdocs/ops';
import { toModel, type PageLayout } from '@golemdocs/layout';
import { EditorEditing } from './editing.ts';

export abstract class EditorLinks extends EditorEditing {
  /** The hyperlink at a position (a caret counts at either end of it), with its range. */
  linkAt(paragraph: Paragraph, offset: number, inclusive = true): { link: Hyperlink; from: number; to: number } | null {
    let pos = 0;
    let found: { link: Hyperlink; from: number; to: number } | null = null;
    const walk = (inlines: readonly Inline[]): void => {
      for (const inline of inlines) {
        const length = inlineLength(inline);
        if (found) return;
        if (inline.kind === 'hyperlink' && (inclusive ? offset >= pos && offset <= pos + length : offset >= pos && offset < pos + length)) {
          found = { link: inline, from: pos, to: pos + length };
          return;
        }
        if (inline.kind === 'wrapper' || inline.kind === 'hyperlink') {
          const start = pos;
          walk(inline.children);
          pos = start + length;
        } else pos += length;
      }
    };
    walk(paragraph.children);
    return found;
  }

  /** The address of the link whose text is under the page point (x, y), or null when the point is not over one. */
  linkUnder(page: PageLayout, x: number, y: number): string | null {
    const line = page.lines.find((l) => y >= l.y && y <= l.y + l.height && x >= l.x && x <= l.x + l.width);
    if (!line) return null;
    // The character the point is over: the last caret stop at or before it (the final stop is the line's end, not a character).
    let k = 0;
    for (let i = 0; i < line.stops.length - 1; i++) if (line.column + line.stops[i] <= x) k = i;
    const at = this.linkAt(line.paragraph, toModel(line.spans, line.start + k), false);
    return at ? (at.link.url ?? (at.link.anchor ? `#${at.link.anchor}` : '')) : null;
  }

  /** The paragraph of the task list item whose check box is under the page point (x, y), and whether it is checked. */
  checkboxUnder(page: PageLayout, x: number, y: number): { paragraph: Paragraph; checked: boolean } | null {
    const margin = 3;
    for (const line of page.lines) {
      const box = line.box;
      if (!box) continue;
      const left = line.column + box.x;
      if (x >= left - margin && x <= left + box.size + margin && y >= line.y + box.y - margin && y <= line.y + box.y + box.size + margin) return { paragraph: line.paragraph, checked: box.checked };
    }
    return null;
  }

  /** The equation the selection is exactly (one selected position holding one), for Insert Equation to edit. */
  selectedMath(): MathEquation | null {
    if (this.collapsed) return null;
    const [start, end] = this.ordered();
    if (start.paragraph !== end.paragraph || end.offset - start.offset !== 1) return null;
    const at = mathAt(start.paragraph, start.offset);
    if (!at) return null;
    return readMathInline(at);
  }

  /** The position of the equation under a point on a page, if the point is over one. */
  mathUnder(page: PageLayout, x: number, y: number): Position | null {
    const line = page.lines.find((l) => y >= l.y && y <= l.y + l.height && x >= l.x && x <= l.x + l.width);
    if (!line) return null;
    for (let i = 0; i < line.stops.length - 1; i++) {
      if (x < line.column + line.stops[i] || x >= line.column + line.stops[i + 1]) continue;
      const offset = toModel(line.spans, line.start + i);
      return mathAt(line.paragraph, offset) ? { paragraph: line.paragraph, offset } : null;
    }
    return null;
  }

  /** The link at the selection (its start, if it's a range), for the toolbar and the Insert Hyperlink dialog. */
  selectedLink(): { url: string; text: string } | null {
    const [start] = this.ordered();
    const at = this.linkAt(start.paragraph, start.offset, this.collapsed);
    if (!at) return null;
    return { url: at.link.url ?? (at.link.anchor ? `#${at.link.anchor}` : ''), text: plainText(start.paragraph, at.from, at.to) };
  }

  /** The runs of `inlines` as link text (or, with `link` false, as plain text): the Hyperlink character style on or off. */
  protected restyled(inlines: readonly Inline[], link: boolean): Inline[] {
    const out: Inline[] = [];
    for (const inline of inlines) {
      if (inline.kind === 'hyperlink') out.push(...this.restyled(inline.children, link));
      else if (inline.kind === 'run') {
        const copy = structuredClone(inline);
        if (link) copy.properties.style = 'Hyperlink';
        else if (copy.properties.style === 'Hyperlink') delete copy.properties.style;
        out.push(copy);
      } else out.push(structuredClone(inline));
    }
    return out;
  }

  /** The style link text uses, when the document doesn't have it yet. */
  protected linkStyleOps(): Operation[] {
    if (this.doc.styles.styles.some((s) => s.id === 'Hyperlink')) return [];
    return [
      {
        type: 'setStyle',
        id: 'Hyperlink',
        style: {
          type: 'character',
          id: 'Hyperlink',
          name: 'Hyperlink',
          basedOn: 'DefaultParagraphFont',
          runProperties: { color: { val: '0563C1', themeColor: 'hyperlink' }, underline: { val: 'single' } },
          attrs: {},
        },
      },
    ];
  }

  protected setLinkOps(url: string, text: string): [Operation[], Pos] | null {
    const [start, end] = this.ordered();
    // A link lives in one paragraph.
    if (start.paragraph !== end.paragraph || !url) return null;
    const p = start.paragraph;
    const existing = this.linkAt(p, start.offset, this.collapsed);
    const from = existing ? Math.min(start.offset, existing.from) : start.offset;
    const to = existing ? Math.max(end.offset, existing.to) : end.offset;
    const [, rest] = splitInlines(p.children, from);
    const [middle] = splitInlines(rest, to - from);
    let children: Inline[];
    if (to > from && (!text || text === plainText(p, from, to))) children = this.restyled(middle, true);
    else {
      const properties = structuredClone(runPropertiesAt(p, from) ?? {});
      properties.style = 'Hyperlink';
      children = [{ kind: 'run', properties, content: [{ kind: 'text', text: text || url }], attrs: {} }];
    }
    const id = this.replica.id(p);
    const ops: Operation[] = [...this.linkStyleOps()];
    if (to > from) ops.push({ type: 'delete', paragraph: id, from, to });
    ops.push({ type: 'insertContent', paragraph: id, offset: from, content: [{ kind: 'hyperlink', url, children, attrs: {} }] });
    return [ops, { paragraph: id, offset: from + inlinesLength(children) }];
  }

  protected removeLinkOps(): [Operation[], Pos] | null {
    const [start] = this.ordered();
    const existing = this.linkAt(start.paragraph, start.offset, this.collapsed);
    if (!existing) return null;
    const children = this.restyled(existing.link.children, false);
    const id = this.replica.id(start.paragraph);
    const ops: Operation[] = [
      { type: 'delete', paragraph: id, from: existing.from, to: existing.to },
      { type: 'insertContent', paragraph: id, offset: existing.from, content: children },
    ];
    return [ops, { paragraph: id, offset: existing.from + inlinesLength(children) }];
  }

  protected pointer(command: Extract<Command, { kind: 'pointer' }>): void {
    const hit = this.hitTest(command.page, command.x, command.y);
    if (!hit) return;
    if (command.unit === 'word') {
      // A double click on an equation selects it, whole.
      const math = this.mathUnder(command.page, command.x, command.y);
      const [a, b] = math ? [math, { paragraph: math.paragraph, offset: math.offset + 1 }] : this.wordAt(hit);
      this.selection = { anchor: a, focus: b };
    } else if (command.unit === 'paragraph') {
      this.selection = { anchor: { paragraph: hit.paragraph, offset: 0 }, focus: { paragraph: hit.paragraph, offset: paragraphLength(hit.paragraph) } };
    } else if (command.extend) {
      this.selection = { anchor: this.selection.anchor, focus: hit };
    } else {
      this.collapse(hit);
    }
  }
}
