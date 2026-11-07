// SPDX-License-Identifier: MIT
// Parts of a document that aren't its text: bookmarks (markers in the text, with a name) and removing a style.
import { bookmarkEnd, bookmarkMarkerOffsets, bookmarkRanges, bookmarkStart, inlineLength, validBookmarkName, type Inline } from '@golemdocs/docx';
import { type Operation, type Pos } from '@golemdocs/ops';
import { EditorComments } from './comments.ts';

export abstract class EditorDocumentParts extends EditorComments {
  private newBookmarkId(): string {
    // Every marker counts, Word's hidden bookmarks too. Random, so two people adding one at once don't collide.
    const taken = new Set<string>();
    const walk = (inlines: readonly Inline[]) => {
      for (const inline of inlines) {
        if (inline.kind === 'raw' && inline.xml.name === 'w:bookmarkStart') taken.add(inline.xml.attrs['w:id'] ?? '');
        else if (inline.kind !== 'raw' && inline.kind !== 'run') walk(inline.children);
      }
    };
    for (const p of this.paragraphs()) walk(p.children);
    let id: string;
    do id = String(Math.floor(Math.random() * 0x7fffffff));
    while (taken.has(id));
    return id;
  }

  protected addBookmarkOps(name: string): [Operation[], Pos] | null {
    if (!validBookmarkName(name)) return null;
    const [start, end] = this.ordered();
    const old = bookmarkRanges(this.paragraphs()).find((b) => b.name.toLowerCase() === name.toLowerCase());
    const ops: Operation[] = [];
    // Word's bookmark names are one whether capitalised or not: an old one of this name moves, and its markers no longer count towards where the new ones go.
    const before = (paragraph: typeof start.paragraph, offset: number) => (old ? bookmarkMarkerOffsets(paragraph, old.id).filter((o) => o < offset).length : 0);
    const startAt = this.pos({ paragraph: start.paragraph, offset: start.offset - before(start.paragraph, start.offset) });
    const endAt = this.pos({ paragraph: end.paragraph, offset: end.offset - before(end.paragraph, end.offset) });
    if (old) ops.push(...(this.deleteBookmarkOps(old.name)?.[0] ?? []));
    const id = this.newBookmarkId();
    ops.push({ type: 'insertContent', paragraph: endAt.paragraph, offset: endAt.offset, content: [bookmarkEnd(id)] }, { type: 'insertContent', paragraph: startAt.paragraph, offset: startAt.offset, content: [bookmarkStart(id, name)] });
    return [ops, { paragraph: endAt.paragraph, offset: endAt.offset + (startAt.paragraph === endAt.paragraph ? 2 : 1) }];
  }

  protected deleteBookmarkOps(name: string): [Operation[], Pos] | null {
    const range = bookmarkRanges(this.paragraphs()).find((b) => b.name === name);
    if (!range) return null;
    const ops: Operation[] = [];
    const paragraphs = range.start.paragraph === range.end.paragraph ? [range.start.paragraph] : [range.start.paragraph, range.end.paragraph];
    for (const p of paragraphs) for (const offset of bookmarkMarkerOffsets(p, range.id)) ops.push({ type: 'delete', paragraph: this.replica.id(p), from: offset, to: offset + 1 });
    const focus = this.selection.focus;
    const moved = bookmarkMarkerOffsets(focus.paragraph, range.id).filter((o) => o < focus.offset).length;
    return [ops, { paragraph: this.replica.id(focus.paragraph), offset: focus.offset - moved }];
  }

  protected deleteStyleOps(id: string): [Operation[], Pos] | null {
    const sheet = this.doc.styles;
    const style = sheet.styles.find((s) => s.id === id);
    if (!style || style.isDefault) return null;
    const ops: Operation[] = [];
    for (const p of this.paragraphs()) {
      if (p.properties.style === id) ops.push(this.setProperties(p, { style: undefined }));
      let offset = 0;
      const walk = (inlines: readonly Inline[]) => {
        for (const inline of inlines) {
          if (inline.kind === 'run' || inline.kind === 'raw') {
            const length = inlineLength(inline);
            if (inline.kind === 'run' && inline.properties.style === id && length) ops.push({ type: 'formatText', paragraph: this.replica.id(p), from: offset, to: offset + length, format: { style: null } });
            offset += length;
          } else walk(inline.children);
        }
      };
      walk(p.children);
    }
    // Styles built on it are built on what it was built on; ones it followed or was linked to forget it.
    for (const other of sheet.styles) {
      if (other.id === id || (other.basedOn !== id && other.next !== id && other.link !== id)) continue;
      const next = structuredClone(other);
      if (next.basedOn === id) {
        if (style.basedOn) next.basedOn = style.basedOn;
        else delete next.basedOn;
      }
      if (next.next === id) delete next.next;
      if (next.link === id) delete next.link;
      ops.push({ type: 'setStyle', id: other.id, style: next });
    }
    ops.push({ type: 'setStyle', id, style: null });
    return [ops, this.selectionIds.focus];
  }
}
