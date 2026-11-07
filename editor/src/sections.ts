// SPDX-License-Identifier: MIT
// Sections: columns and page setup.
import { type Command } from './types.ts';

import { hasPageField, pageNumberParagraph, withoutPageFields, type Block, type HeaderFooter, type HeaderFooterReference, type Paragraph, type SectionProperties } from '@golemdocs/docx';
import { type Operation, type Pos } from '@golemdocs/ops';
import { EditorDocumentParts } from './documentParts.ts';

export abstract class EditorSections extends EditorDocumentParts {
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

  /** The first section: the one a document's headers and footers usually live on, for the others to inherit. */
  private firstSection(): { section: SectionProperties; end: Paragraph | null } {
    const end = this.paragraphs().find((p) => p.properties.section) ?? null;
    return { section: end?.properties.section ?? this.doc.section, end };
  }

  /** What the document's pages show for page numbers, for the Page Numbers dialog. */
  pageNumbers(): { position: 'top' | 'bottom' | null; align: 'left' | 'center' | 'right'; firstPage: boolean; format: string; start: number | null } {
    const { section } = this.firstSection();
    const numbered = (refs: HeaderFooterReference[], type: HeaderFooterReference['type']): Paragraph | undefined => {
      const part = refs.find((r) => r.type === type)?.part;
      const blocks = (part && this.doc.headersFooters.get(part)?.children) || [];
      return blocks.find((b): b is Paragraph => b.kind === 'paragraph' && hasPageField(b));
    };
    const footer = numbered(section.footers, 'default');
    const header = numbered(section.headers, 'default');
    const shown = footer ?? header;
    const align = shown?.properties.justification;
    const firstPage = !section.titlePage || !!(footer ? numbered(section.footers, 'first') : header ? numbered(section.headers, 'first') : true);
    return { position: footer ? 'bottom' : header ? 'top' : null, align: align === 'center' || align === 'right' ? align : shown ? 'left' : 'right', firstPage, format: section.pageNumbering?.fmt ?? 'decimal', start: section.pageNumbering?.start ?? null };
  }

  protected setPageNumbersOps(c: Extract<Command, { kind: 'setPageNumbers' }>): [Operation[], Pos] {
    const ops: Operation[] = [];
    const parts = new Map<string, HeaderFooter>();
    const current = (part: string) => parts.get(part) ?? this.doc.headersFooters.get(part);
    /** Takes the numbers out of a part; a paragraph left with nothing in it goes, but a part always keeps one. */
    const strip = (part: string): void => {
      const hf = current(part);
      if (!hf) return;
      let changed = false;
      const children: Block[] = [];
      for (const block of hf.children) {
        if (block.kind !== 'paragraph') {
          children.push(block);
          continue;
        }
        const { found, paragraph } = withoutPageFields(block);
        changed ||= found;
        const empty = !paragraph.children.some((inline) => inline.kind !== 'run' || inline.content.some((item) => item.kind !== 'text' || item.text.trim()));
        if (!found || !empty) children.push(paragraph);
      }
      if (!changed) return;
      if (!children.length) children.push({ kind: 'paragraph', properties: {}, children: [], attrs: {} });
      parts.set(part, { ...hf, children });
    };
    /** Numbers a part: its number moves to the new alignment, or goes in its first empty paragraph, or in a new one at its end. */
    const number = (part: string): void => {
      const hf = current(part)!;
      const children = [...hf.children];
      const has = children.findIndex((b) => b.kind === 'paragraph' && hasPageField(b));
      const empty = children.findIndex((b) => b.kind === 'paragraph' && !b.children.length);
      const fresh = pageNumberParagraph(c.align);
      if (has >= 0) {
        const old = children[has] as Paragraph;
        children[has] = { ...old, properties: { ...old.properties, justification: c.align } };
      } else if (empty >= 0) children[empty] = { ...(children[empty] as Paragraph), properties: { ...(children[empty] as Paragraph).properties, justification: c.align }, children: fresh.children };
      else children.push(fresh);
      parts.set(part, { ...hf, children });
    };
    const newPart = (kind: 'header' | 'footer'): string => {
      // Random, so two people numbering at once don't collide.
      let part: string;
      do part = `word/${kind}${1000 + Math.floor(Math.random() * 1_000_000)}.xml`;
      while (this.doc.headersFooters.has(part));
      parts.set(part, { kind, part, children: [{ kind: 'paragraph', properties: {}, children: [], attrs: {} }], rootAttrs: { ...this.anyPartAttrs() } });
      return part;
    };

    const sections = [...this.paragraphs().filter((p) => p.properties.section).map((p) => p.properties.section!), this.doc.section];
    const kindOf = (position: 'top' | 'bottom'): 'headers' | 'footers' => (position === 'top' ? 'headers' : 'footers');
    const first = this.firstSection().section;
    const next = structuredClone(first);
    // Every section's parts lose their numbers, then the ones wanted get them, so a move from top to bottom leaves nothing behind.
    for (const section of sections) for (const ref of [...section.headers, ...section.footers]) strip(ref.part);
    if (c.position) {
      const kind = kindOf(c.position);
      const refs = next[kind];
      const add = (type: HeaderFooterReference['type']): string => {
        let ref = refs.find((r) => r.type === type);
        if (!ref) refs.push((ref = { type, part: newPart(c.position === 'top' ? 'header' : 'footer') }));
        return ref.part;
      };
      number(add('default'));
      // Sections with a header or footer of their own number theirs too; the others inherit the first's.
      for (const section of sections) if (section !== first) for (const ref of section[kind]) if (ref.type === 'default') number(ref.part);
      if (!c.firstPage) next.titlePage = true;
      else if (next.titlePage) {
        // A different first page that only hid the number goes; one with its own header or footer stays, and shows the number too.
        if (next.headers.some((r) => r.type === 'first') || next.footers.some((r) => r.type === 'first')) number(add('first'));
        else delete next.titlePage;
      }
    }
    const numbering = (section: SectionProperties, start: number | null | undefined): SectionProperties => {
      const out = structuredClone(section);
      const { fmt: _fmt, start: _start, ...rest } = out.pageNumbering ?? {};
      const pageNumbering = { ...rest, ...(c.format !== 'decimal' && { fmt: c.format }), ...(start !== null && start !== undefined && { start }) };
      if (Object.keys(pageNumbering).length) out.pageNumbering = pageNumbering;
      else delete out.pageNumbering;
      return out;
    };
    for (const [part, value] of parts) ops.push({ type: 'setHeaderFooter', part, value });
    for (const p of this.paragraphs()) {
      const section = p.properties.section;
      if (!section) continue;
      const changed = section === first ? numbering(next, c.start) : numbering(section, section.pageNumbering?.start);
      ops.push(this.setProperties(p, { section: changed }));
    }
    ops.push({ type: 'setDocumentSection', properties: this.doc.section === first ? numbering(next, c.start) : numbering(this.doc.section, this.doc.section.pageNumbering?.start) });
    return [ops, this.selectionIds.focus];
  }

  /** The namespace declarations a new header or footer part is written with. */
  private anyPartAttrs(): Record<string, string> {
    for (const hf of this.doc.headersFooters.values()) return hf.rootAttrs;
    return { 'xmlns:w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'xmlns:r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships' };
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
