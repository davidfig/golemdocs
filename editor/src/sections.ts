// Sections: columns and page setup.
import { type Command } from './types.ts';

import { type Paragraph, type SectionProperties } from '@golemdocs/docx';
import { type Operation, type Pos } from '@golemdocs/ops';
import { EditorComments } from './comments.ts';

export abstract class EditorSections extends EditorComments {
  /** Twips between the margins of the document's page (Word's default 6.5in when it says nothing). */
  protected textWidth(section: SectionProperties = this.doc.section): number {
    const { pageSize, margins } = section ?? {};
    const width = (pageSize?.w ?? 12240) - (margins?.left ?? 1440) - (margins?.right ?? 1440) - (margins?.gutter ?? 0);
    return width > 720 ? width : 9360;
  }

  /** The paragraph that ends the section a paragraph is in, or null for the document's last section. */
  protected sectionEnd(paragraph: Paragraph): Paragraph | null {
    const list = this.paragraphs();
    for (let i = this.indexOf(paragraph); i >= 0 && i < list.length; i++) if (list[i].properties.section) return list[i];
    return null;
  }

  /** The columns of the section the caret is in, and the width of its text area (twips), for the Columns dialog. */
  sectionColumns(): { count: number; space: number; sep: boolean; width: number } {
    const end = this.sectionEnd(this.selection.focus.paragraph);
    const section = end?.properties.section ?? this.doc.section;
    return { count: section.columns?.num ?? 1, space: section.columns?.space ?? 720, sep: !!section.columns?.sep, width: this.textWidth(section) };
  }

  protected setColumnsOps(c: Extract<Command, { kind: 'setColumns' }>): [Operation[], Pos] | null {
    const count = Math.floor(c.count);
    if (!(count >= 1 && count <= 12) || !(c.space >= 0 && c.space <= 5760)) return null;
    // No columns element at all for one.
    return this.editSections(c.scope, 'continuous', (section) => {
      const next = structuredClone(section);
      if (count > 1) next.columns = { num: count, space: Math.round(c.space), equalWidth: true, ...(c.sep && { sep: true }) };
      else delete next.columns;
      return next;
    });
  }

  /** The page size and margins of the section the caret is in (twips), for the Page Setup dialog. */
  sectionPage(): { width: number; height: number; landscape: boolean; top: number; bottom: number; left: number; right: number; gutter: number; header: number; footer: number } {
    const end = this.sectionEnd(this.selection.focus.paragraph);
    const { pageSize, margins } = end?.properties.section ?? this.doc.section;
    return {
      width: pageSize?.w ?? 12240,
      height: pageSize?.h ?? 15840,
      landscape: pageSize?.orient === 'landscape',
      top: margins?.top ?? 1440,
      bottom: margins?.bottom ?? 1440,
      left: margins?.left ?? 1440,
      right: margins?.right ?? 1440,
      gutter: margins?.gutter ?? 0,
      header: margins?.header ?? 720,
      footer: margins?.footer ?? 720,
    };
  }

  protected setPageOps(c: Extract<Command, { kind: 'setPage' }>): [Operation[], Pos] | null {
    const whole = (n: number) => Number.isFinite(n) && Math.round(n) === n;
    const sizes = [c.width, c.height];
    const margins = [c.top, c.bottom, c.left, c.right, c.gutter, c.header, c.footer];
    // A page an inch or more each way, and margins that leave a text area (an inch each way) on it.
    if (!sizes.every((n) => whole(n) && n >= 1440 && n <= 31680) || !margins.every((n) => whole(n) && n >= 0 && n <= 31680)) return null;
    if (c.left + c.right + c.gutter > c.width - 1440 || c.top + c.bottom > c.height - 1440) return null;
    // A new page size can't start part way down a page: from the caret on, it starts a page.
    return this.editSections(c.scope, 'nextPage', (section) => {
      const next = structuredClone(section);
      next.pageSize = { ...next.pageSize, w: c.width, h: c.height, orient: c.landscape ? 'landscape' : 'portrait' };
      next.margins = { ...next.margins, top: c.top, bottom: c.bottom, left: c.left, right: c.right, gutter: c.gutter, header: c.header, footer: c.footer };
      return next;
    });
  }

  /**
   * Changes the section properties of the whole document, of the section the caret is in, or from
   * the caret on (the paragraph is split there, the first half ends a section as the old one was,
   * and the rest is the old section's end with the change, starting as a `type` section break).
   */
  protected editSections(scope: 'document' | 'section' | 'forward', type: 'continuous' | 'nextPage', change: (section: SectionProperties) => SectionProperties): [Operation[], Pos] | null {
    const ops: Operation[] = [];
    const [start] = this.ordered();
    const end = this.sectionEnd(start.paragraph);
    if (scope === 'document') {
      for (const p of this.paragraphs()) if (p.properties.section) ops.push(this.setProperties(p, { section: change(p.properties.section) }));
      ops.push({ type: 'setDocumentSection', properties: change(this.doc.section) });
    } else if (scope === 'section') {
      if (end) ops.push(this.setProperties(end, { section: change(end.properties.section!) }));
      else ops.push({ type: 'setDocumentSection', properties: change(this.doc.section) });
    } else {
      if (this.replica.engine.index.locate(start.paragraph)) return null;
      const old = structuredClone(end?.properties.section ?? this.doc.section);
      const [splitting, caret] = this.splitOps(start);
      const split = splitting.find((op): op is Extract<Operation, { type: 'split' }> => op.type === 'split')!;
      ops.push(...splitting, { type: 'setParagraphProperties', paragraph: this.replica.id(start.paragraph), properties: { ...structuredClone(start.paragraph.properties), section: structuredClone(old) } });
      const after = { ...change(old), type };
      if (end === start.paragraph) ops.push({ type: 'setParagraphProperties', paragraph: split.id, properties: { ...split.properties, section: after } });
      else if (end) ops.push(this.setProperties(end, { section: after }));
      else ops.push({ type: 'setDocumentSection', properties: after });
      return [ops, caret];
    }
    return [ops, this.selectionIds.focus];
  }
}
