// Hyperlinks, equations and pictures under the selection or a point.
import { NO_CHANGE, type CommandResult, type Position } from './types.ts';
import type { Command } from './types.ts';
import { paragraphLength, type Drawing } from '@golemdocs/docx';

import { inlineLength, inlinesLength, mathAt, plainText, readMathInline, runPropertiesAt, splitInlines, type MathEquation, type Hyperlink, type Inline, type Paragraph } from '@golemdocs/docx';
import { type Operation, type Pos } from '@golemdocs/ops';
import { toModel, type ImageItem, type PageLayout } from '@golemdocs/layout';
import { EditorEditing } from './editing.ts';
import { drawingAt, findDrawing, placedOnPage } from './drawings.ts';

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

  /** The character under a page point: its paragraph and offset (null when the point is not over a line). */
  charUnder(page: PageLayout, x: number, y: number): { paragraph: Paragraph; offset: number } | null {
    const line = page.lines.find((l) => y >= l.y && y <= l.y + l.height && x >= l.x && x <= l.x + l.width);
    if (!line) return null;
    // The character the point is over: the last caret stop at or before it (the final stop is the line's end, not a character).
    let k = 0;
    for (let i = 0; i < line.stops.length - 1; i++) if (line.column + line.stops[i] <= x) k = i;
    return { paragraph: line.paragraph, offset: toModel(line.spans, line.start + k) };
  }

  /** The address of the link whose text is under the page point (x, y), or null when the point is not over one. */
  linkUnder(page: PageLayout, x: number, y: number): string | null {
    const under = this.charUnder(page, x, y);
    const at = under && this.linkAt(under.paragraph, under.offset, false);
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

  /** Where a drawing is in the text, found by being that very drawing. */
  protected drawingPosition(drawing: Drawing): Position | null {
    for (const paragraph of this.paragraphs()) {
      const found = findDrawing(paragraph.children, (d) => d === drawing);
      if (found) return { paragraph, offset: found.offset };
    }
    return null;
  }

  /**
   * The position of the picture under a point on a page, if the point is over one. Pictures in front of the text come first
   * (the last drawn is on top), then those in line with it; a picture behind the text is only picked where there is no text.
   */
  pictureUnder(page: PageLayout, x: number, y: number): Position | null {
    const over = (i: ImageItem) => !!i.drawing?.image && x >= i.x && x <= i.x + i.width && y >= i.y && y <= i.y + i.height;
    const hits = page.images.filter(over);
    const inText = () => page.lines.some((l) => y >= l.y && y <= l.y + l.height && x >= l.x && x <= l.x + l.width);
    const picked = [...hits].reverse().find((i) => !i.behind) ?? (hits.length && !inText() ? hits[hits.length - 1] : undefined);
    return picked?.drawing ? this.drawingPosition(picked.drawing) : null;
  }

  /** The picture the selection is exactly (one selected position holding a picture), with where it is shown. */
  selectedPicture(): { drawing: Drawing; page: PageLayout; item: ImageItem } | null {
    if (this.collapsed) return null;
    const [start, end] = this.ordered();
    if (start.paragraph !== end.paragraph || end.offset - start.offset !== 1) return null;
    const drawing = drawingAt(start.paragraph.children, start.offset);
    if (!drawing?.image) return null;
    const shown = this.session.displayPages;
    const first = this.session.linesOf(start.paragraph, this.hint)[0];
    const from = Math.max(first ? shown.indexOf(first.page) : 0, 0);
    // A floating picture may sit on the page after its paragraph.
    for (let i = from; i < Math.min(from + 3, shown.length); i++) {
      const item = shown[i].images.find((image) => image.drawing === drawing);
      if (item) return { drawing, page: shown[i], item };
    }
    return null;
  }

  /** Selects the picture at a position, as the one thing selected. */
  protected selectPictureAt(at: Position): void {
    this.selection = { anchor: { ...at }, focus: { paragraph: at.paragraph, offset: at.offset + 1 } };
  }

  /** The selected picture put somewhere else: at a place on a page (a floating one), or in the text at a point. */
  moveDrawing(command: Extract<Command, { kind: 'moveDrawing' }>): CommandResult {
    const picture = this.selectedPicture();
    if (!picture) return NO_CHANGE;
    const target = this.hitTest(command.page, command.x, command.y);
    if (!target) return NO_CHANGE;
    const floating = !picture.drawing.inline;
    return this.relocatePicture(picture.drawing, target, floating ? placedOnPage(picture.drawing, command.x, command.y) : picture.drawing);
  }

  /** The selected picture moved to the end of a paragraph (by its number among the document's). */
  moveDrawingToParagraph(command: Extract<Command, { kind: 'moveDrawingToParagraph' }>): CommandResult {
    const picture = this.selectedPicture();
    const paragraph = this.paragraphs()[command.paragraph];
    if (!picture || !paragraph) return NO_CHANGE;
    return this.relocatePicture(picture.drawing, { paragraph, offset: paragraphLength(paragraph) }, picture.drawing);
  }

  /** Takes the selected picture out of where it is and puts `moved` (the picture, perhaps given a place) at `target`, as one step, keeping it selected. */
  private relocatePicture(drawing: Drawing, target: Position, moved: Drawing): CommandResult {
    const [from] = this.ordered();
    const source = this.replica.id(from.paragraph);
    const sameParagraph = target.paragraph === from.paragraph;
    // Dropped where it was: nothing to do.
    if (drawing.inline && sameParagraph && target.offset >= from.offset && target.offset <= from.offset + 1) return NO_CHANGE;
    // A floating picture dropped in its own paragraph stays where it is in the text.
    const offset = !drawing.inline && sameParagraph ? from.offset : sameParagraph && target.offset > from.offset ? target.offset - 1 : target.offset;
    const id = this.replica.id(target.paragraph);
    const ops: Operation[] = [{ type: 'delete', paragraph: source, from: from.offset, to: from.offset + 1 }, { type: 'insertItem', paragraph: id, offset, item: structuredClone(moved) }];
    const result = this.edit([ops, { paragraph: id, offset: offset + 1 }]);
    this.selectPictureAt({ paragraph: target.paragraph, offset });
    return result;
  }

  /** The selected picture shown as another image (it was edited). */
  replacePicture(command: Extract<Command, { kind: 'replacePicture' }>): CommandResult {
    const picture = this.selectedPicture();
    if (!picture) return NO_CHANGE;
    const [from] = this.ordered();
    const id = this.replica.id(from.paragraph);
    const { drawing } = picture;
    const replaced: Drawing = { ...drawing, image: command.image, ...(command.aspect > 0 && { height: Math.round(drawing.width * command.aspect) }) };
    // A vector drawing it was once is a picture now.
    delete replaced.svg;
    const ops: Operation[] = [{ type: 'delete', paragraph: id, from: from.offset, to: from.offset + 1 }, { type: 'insertItem', paragraph: id, offset: from.offset, item: structuredClone(replaced) }];
    const result = this.edit([ops, { paragraph: id, offset: from.offset + 1 }]);
    this.selectPictureAt(from);
    return result;
  }

  /** The selected picture given another size (points). */
  resizeDrawing(command: Extract<Command, { kind: 'resizeDrawing' }>): CommandResult {
    const picture = this.selectedPicture();
    if (!picture || !(command.width > 0) || !(command.height > 0)) return NO_CHANGE;
    const [from] = this.ordered();
    const id = this.replica.id(from.paragraph);
    const sized: Drawing = { ...picture.drawing, width: Math.round(command.width * 12700), height: Math.round(command.height * 12700) };
    const resized = !picture.drawing.inline && command.x !== undefined && command.y !== undefined ? placedOnPage(sized, command.x, command.y) : sized;
    const ops: Operation[] = [{ type: 'delete', paragraph: id, from: from.offset, to: from.offset + 1 }, { type: 'insertItem', paragraph: id, offset: from.offset, item: structuredClone(resized) }];
    const result = this.edit([ops, { paragraph: id, offset: from.offset + 1 }]);
    this.selectPictureAt(from);
    return result;
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
    // A click on a picture selects it, whole (a drag across it, or a click that goes on to a paragraph, is for the text).
    const picture = !command.extend && command.unit !== 'paragraph' ? this.pictureUnder(command.page, command.x, command.y) : null;
    if (picture) this.selectPictureAt(picture);
    else if (command.unit === 'word') {
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
