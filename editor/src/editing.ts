// Applying planned operations as edits; undo, redo, remote changes; inserting and deleting text.
import { type Position, type ParagraphFormat, type CommandResult, NO_CHANGE } from './types.ts';
import type { Selection as OpSelection } from '@golemdocs/ops';

import { newParagraphProperties, paragraphLength, runPropertiesAt, type Paragraph, type ParagraphProperties } from '@golemdocs/docx';
import { END, Replica, type Applied, type HistoryMark, type Operation, type Pos, type RemoteChange, type ServerMessage } from '@golemdocs/ops';
import { EditorNavigation } from './navigation.ts';

export abstract class EditorEditing extends EditorNavigation {
  /** Applies planned operations as one local edit and moves the selection. */
  protected edit(plan: [Operation[], Pos] | null, group?: string): CommandResult {
    if (!plan || plan[0].length === 0) return NO_CHANGE;
    const [ops, after] = plan;
    const change = this.replica.edit(ops, { before: this.selectionIds, after: { anchor: after, focus: after }, group });
    return this.changed(change.applied, { anchor: after, focus: after });
  }

  /** After the document changed: lay out again, put the selection where it belongs. */
  protected changed(applied: Applied, selection: OpSelection | null): CommandResult {
    this.structureChanged();
    if (applied.styles) this.session.invalidateStyles();
    this.session.invalidate(applied.changed, { structural: applied.structural });
    if (selection) this.setSelectionIds(selection);
    else this.setSelectionIds(this.selectionIds);
    return { edited: true, changed: applied.changed, structural: applied.structural, styles: applied.styles };
  }

  /** The undo history as it is now (see `foldHistory`, `restoreHistory`). */
  historyMark(): HistoryMark {
    return this.replica.history.mark();
  }

  /** Makes the edits since `mark` one undo step. */
  foldHistory(mark: HistoryMark): void {
    this.replica.history.fold(mark);
  }

  /** Forgets the edits since `mark` in the undo history (the document keeps them). */
  restoreHistory(mark: HistoryMark): void {
    this.replica.history.restore(mark);
  }

  /** How many undo steps there are. */
  get undoDepth(): number {
    return this.replica.history.mark().undo.length;
  }

  undo(): CommandResult {
    const current = this.selectionIds;
    const change = this.replica.undo();
    return change ? this.changed(change.applied, change.selection ?? current) : NO_CHANGE;
  }

  redo(): CommandResult {
    const current = this.selectionIds;
    const change = this.replica.redo();
    return change ? this.changed(change.applied, change.selection ?? current) : NO_CHANGE;
  }

  /**
   * A message from the collaboration server: applies others' edits (rebasing ours), lays out
   * again and keeps the selection where it was in the text. Returns the change, if any.
   */
  receive(message: ServerMessage): { result: CommandResult; change: RemoteChange | null } {
    // By id, before paragraphs it's in can go away.
    const before = this.selectionIds;
    const change = this.replica.receive(message);
    if (!change) return { result: NO_CHANGE, change: null };
    const selection = Replica.mapSelection(before, change.mapping);
    this.structureChanged();
    if (change.styles) this.session.invalidateStyles();
    this.session.invalidate(change.changed, { structural: change.structural });
    this.setSelectionIds(selection);
    return { result: { edited: true, changed: change.changed, structural: change.structural, styles: change.styles }, change };
  }

  /** Text (with tabs and line breaks as new paragraphs) at a position. */
  protected insertOps(at: Position, text: string): [Operation[], Pos] {
    const ops: Operation[] = [];
    let pos = this.pos(at);
    const runProperties = runPropertiesAt(at.paragraph, at.offset);
    text.replace(/\r\n?/g, '\n').split('\n').forEach((line, i) => {
      if (i > 0) {
        const id = this.replica.newId();
        const properties = newParagraphProperties(at.paragraph.properties, false, this.doc.styles, runProperties);
        ops.push({ type: 'split', paragraph: pos.paragraph, offset: pos.offset, id, properties });
        pos = { paragraph: id, offset: 0 };
      }
      line.split('\t').forEach((part, j) => {
        if (j > 0) {
          ops.push({ type: 'insertItem', paragraph: pos.paragraph, offset: pos.offset, item: { kind: 'tab' } });
          pos = { paragraph: pos.paragraph, offset: pos.offset + 1 };
        }
        if (part) {
          ops.push({ type: 'insertText', paragraph: pos.paragraph, offset: pos.offset, text: part });
          pos = { paragraph: pos.paragraph, offset: pos.offset + part.length };
        }
      });
    });
    return [ops, pos];
  }

  /** Enter: the new paragraph continues the formatting at the caret (and takes the next style at an end). */
  protected splitOps(at: Position): [Operation[], Pos] {
    const p = at.paragraph;
    const id = this.replica.newId();
    const atEnd = at.offset >= paragraphLength(p);
    const properties = newParagraphProperties(p.properties, atEnd, this.doc.styles, runPropertiesAt(p, at.offset));
    const ops: Operation[] = [{ type: 'split', paragraph: this.replica.id(p), offset: at.offset, id, properties }];
    // A section break belongs to the paragraph mark, which is now the new paragraph's.
    if (p.properties.section) ops.push(this.setProperties(p, { section: undefined }));
    return [ops, { paragraph: id, offset: 0 }];
  }

  protected setProperties(p: Paragraph, changes: ParagraphFormat): Operation {
    const properties: ParagraphProperties = { ...structuredClone(p.properties), ...structuredClone(changes) };
    for (const key of Object.keys(changes) as (keyof ParagraphProperties)[]) if (changes[key] === undefined) delete properties[key];
    return { type: 'setParagraphProperties', paragraph: this.replica.id(p), properties };
  }

  /** Deletes the selection; the caret goes to its start. */
  protected deleteSelection(): [Operation[], Pos] | null {
    if (this.collapsed) return null;
    const [start, end] = this.ordered();
    const a = start.paragraph;
    const b = end.paragraph;
    const ida = this.replica.id(a);
    const ops: Operation[] = [];
    if (a === b) {
      ops.push({ type: 'delete', paragraph: ida, from: start.offset, to: end.offset });
      // Emptying a paragraph: its mark keeps the deleted text's formatting for what's typed next.
      if (start.offset === 0 && end.offset >= paragraphLength(a)) {
        const carried = runPropertiesAt(a, 0);
        if (carried && JSON.stringify(carried) !== JSON.stringify(a.properties.runProperties ?? {})) ops.push(this.setProperties(a, { runProperties: carried }));
      }
      return [ops, this.pos(start)];
    }
    ops.push({ type: 'delete', paragraph: ida, from: start.offset, to: END });
    ops.push({ type: 'delete', paragraph: this.replica.id(b), from: 0, to: end.offset });
    const index = this.replica.engine.index;
    const container = index.container(a);
    if (container && container === index.container(b)) {
      // Blocks in between go; the end paragraph's rest joins the start paragraph.
      if (container.indexOf(b) > container.indexOf(a) + 1) ops.push({ type: 'removeBetween', after: ida, before: this.replica.id(b) });
      if (b.properties.section) ops.push(this.setProperties(a, { section: b.properties.section }));
      ops.push({ type: 'merge', paragraph: ida, next: this.replica.id(b) });
    } else {
      // Across containers (into or out of a table): empty the paragraphs in between.
      const list = this.paragraphs();
      for (let k = this.indexOf(a) + 1; k < this.indexOf(b); k++) ops.push({ type: 'delete', paragraph: this.replica.id(list[k]), from: 0, to: END });
    }
    return [ops, this.pos(start)];
  }

  /** Merges `second` into the paragraph before it (keeping a section break it ends). */
  protected mergeOps(first: Paragraph, second: Paragraph): Operation[] {
    const container = this.replica.engine.index.container(second);
    if (!container || container[container.indexOf(second) - 1] !== first) return [];
    const ops: Operation[] = [];
    if (second.properties.section) ops.push(this.setProperties(first, { section: second.properties.section }));
    ops.push({ type: 'merge', paragraph: this.replica.id(first), next: this.replica.id(second) });
    return ops;
  }

  protected deleteBackward(unit: 'character' | 'word'): [Operation[], Pos] | null {
    const pos = this.selection.focus;
    const p = pos.paragraph;
    let from: number | undefined;
    if (unit === 'word') {
      const word = this.wordLeft(pos);
      from = word.paragraph === p ? word.offset : undefined;
    } else from = this.charBefore(pos)?.[0];
    if (from === undefined || from === pos.offset) {
      // At the start: a list item loses its numbering first, then paragraphs merge.
      if (p.properties.numbering) return [[this.setProperties(p, { numbering: undefined })], this.pos(pos)];
      const previous = this.paragraphs()[this.indexOf(p) - 1];
      if (!previous) return null;
      const at = { paragraph: this.replica.id(previous), offset: paragraphLength(previous) };
      return [this.mergeOps(previous, p), at];
    }
    return [[{ type: 'delete', paragraph: this.replica.id(p), from, to: pos.offset }], { paragraph: this.replica.id(p), offset: from }];
  }

  protected deleteForward(unit: 'character' | 'word'): [Operation[], Pos] | null {
    const pos = this.selection.focus;
    const p = pos.paragraph;
    const to = unit === 'word' ? this.wordRight(pos).offset : this.charAfter(pos)?.[1];
    if (to === undefined || to === pos.offset || (unit === 'word' && this.wordRight(pos).paragraph !== p)) {
      const next = this.paragraphs()[this.indexOf(p) + 1];
      return next ? [this.mergeOps(p, next), this.pos(pos)] : null;
    }
    return [[{ type: 'delete', paragraph: this.replica.id(p), from: pos.offset, to }], this.pos(pos)];
  }
}
