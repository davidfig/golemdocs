// Comments: adding, replying, deleting and where they are shown.
import { type Command, type Rect, type CommentGeometry } from './types.ts';

import { type Comment, commentEnd, commentMarkerOffsets, commentRanges, commentReference, commentStart, type Paragraph } from '@golemdocs/docx';
import { type Operation, type Pos } from '@golemdocs/ops';
import { toVisible } from '@golemdocs/layout';
import { EditorFormatting } from './formatting.ts';

export abstract class EditorComments extends EditorFormatting {
  /** A comment id no comment or marker in the document has (decimal, as w:id is). */
  protected newCommentId(): string {
    // Random so that two people commenting at once don't collide.
    const taken = new Set([...this.doc.comments.map((c) => c.id), ...commentRanges(this.paragraphs()).keys()]);
    let id: string;
    do id = String(Math.floor(Math.random() * 0x7fffffff));
    while (taken.has(id));
    return id;
  }

  protected static now(): string {
    return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  }

  /** The comment that starts the thread this one is in. */
  protected threadRoot(id: string): Comment | undefined {
    let comment = this.doc.comments.find((c) => c.id === id);
    for (let hops = 0; comment?.parentId && hops < 100; hops++) {
      const parent = this.doc.comments.find((c) => c.id === comment!.parentId);
      if (!parent) break;
      comment = parent;
    }
    return comment;
  }

  /** The operations that put a comment's markers at a range: end first, so the start's offset still holds. */
  protected markerOps(id: string, start: Pos, end: Pos): Operation[] {
    return [
      { type: 'insertContent', paragraph: end.paragraph, offset: end.offset, content: [commentEnd(id), commentReference(id)] },
      { type: 'insertContent', paragraph: start.paragraph, offset: start.offset, content: [commentStart(id)] },
    ];
  }

  protected addCommentOps(command: Extract<Command, { kind: 'addComment' }>): [Operation[], Pos] {
    let [start, end] = this.ordered();
    if (this.collapsed) [start, end] = this.wordAt(start);
    const id = this.newCommentId();
    const startPos = this.pos(start);
    const endPos = this.pos(end);
    const ops: Operation[] = [
      { type: 'setComment', id, comment: { id, author: command.author, date: command.date ?? EditorComments.now(), paragraphs: command.text.split(/\r\n?|\n/) } },
      ...this.markerOps(id, startPos, endPos),
    ];
    const shift = start.paragraph === end.paragraph ? 1 : 0;
    return [ops, { paragraph: endPos.paragraph, offset: endPos.offset + shift + 2 }];
  }

  protected replyCommentOps(command: Extract<Command, { kind: 'replyComment' }>): [Operation[], Pos] | null {
    const root = this.threadRoot(command.id);
    const range = root && commentRanges(this.paragraphs()).get(root.id);
    if (!root || !range) return null;
    const id = this.newCommentId();
    const startPos = this.pos(range.start);
    const endPos = this.pos(range.end);
    const ops: Operation[] = [
      { type: 'setComment', id, comment: { id, author: command.author, date: command.date ?? EditorComments.now(), paragraphs: command.text.split(/\r\n?|\n/), parentId: root.id } },
      ...this.markerOps(id, startPos, endPos),
    ];
    const shift = range.start.paragraph === range.end.paragraph ? 1 : 0;
    return [ops, { paragraph: endPos.paragraph, offset: endPos.offset + shift + 2 }];
  }

  protected deleteCommentOps(id: string): [Operation[], Pos] | null {
    // A thread's first comment takes its replies with it.
    const ids = [id, ...this.doc.comments.filter((c) => c.parentId === id).map((c) => c.id)];
    const ops: Operation[] = [];
    for (const p of this.paragraphs()) {
      const offsets = ids.flatMap((i) => commentMarkerOffsets(p, i)).sort((a, b) => b - a);
      for (const offset of offsets) ops.push({ type: 'delete', paragraph: this.replica.id(p), from: offset, to: offset + 1 });
    }
    for (const i of ids) if (this.doc.comments.some((c) => c.id === i)) ops.push({ type: 'setComment', id: i, comment: null });
    if (!ops.length) return null;
    // Keep the caret where it is, moved back over any markers before it.
    const focus = this.selection.focus;
    const before = ids.reduce((n, i) => n + commentMarkerOffsets(focus.paragraph, i).filter((o) => o < focus.offset).length, 0);
    return [ops, { paragraph: this.replica.id(focus.paragraph), offset: focus.offset - before }];
  }

  /**
   * Rectangles over ranges of the text on the pages shown (spelling marks). `rangesOf` gives a
   * paragraph's ranges as model offsets, and is asked once per paragraph that has a line in view.
   */
  marks<K>(rangesOf: (paragraph: Paragraph) => { start: number; end: number; kind: K }[]): (Rect & { kind: K })[] {
    const cache = new Map<Paragraph, { start: number; end: number; kind: K }[]>();
    const marks: (Rect & { kind: K })[] = [];
    for (const page of this.session.displayPages) {
      for (const line of page.lines) {
        let ranges = cache.get(line.paragraph);
        if (!ranges) cache.set(line.paragraph, (ranges = rangesOf(line.paragraph)));
        for (const range of ranges) {
          const a = Math.max(toVisible(line.spans, range.start), line.start);
          const b = Math.min(toVisible(line.spans, range.end), line.end);
          if (a >= b) continue;
          const x1 = line.column + line.stops[a - line.start];
          const x2 = line.column + line.stops[b - line.start];
          if (x2 > x1) marks.push({ page, x: x1, y: line.y, width: x2 - x1, height: line.height, kind: range.kind });
        }
      }
    }
    return marks;
  }

  /** Every comment, with the highlight over its range. */
  comments(): CommentGeometry[] {
    if (!this.doc.comments.length) return [];
    const ranges = commentRanges(this.paragraphs());
    return this.doc.comments.map((c) => {
      const range = ranges.get(c.id);
      return {
        id: c.id,
        author: c.author,
        ...(c.initials && { initials: c.initials }),
        ...(c.date && { date: c.date }),
        ...(c.parentId && { parentId: c.parentId }),
        ...(c.resolved && { resolved: true }),
        text: c.paragraphs.join('\n'),
        rects: range ? this.rangeRects(range.start, range.end) : [],
      };
    });
  }

  /** The thread (its first comment's id) whose text the caret is in, if any. */
  activeComment(): string | null {
    if (!this.doc.comments.length) return null;
    const focus = this.selection.focus;
    let best: { id: string; size: number } | null = null;
    for (const [id, range] of commentRanges(this.paragraphs())) {
      const root = this.threadRoot(id);
      if (!root || root.id !== id) continue;
      if (this.compare(focus, range.start) < 0 || this.compare(focus, range.end) > 0) continue;
      // The innermost of nested ranges: the shortest, by the paragraphs and offsets it spans.
      const size = (this.indexOf(range.end.paragraph) - this.indexOf(range.start.paragraph)) * 1e6 + range.end.offset - range.start.offset;
      if (!best || size < best.size) best = { id, size };
    }
    return best?.id ?? null;
  }
}
