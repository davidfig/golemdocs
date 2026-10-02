// Editing: a selection in model positions, commands that edit the model (and tell layout
// what changed), and caret/selection geometry from the laid-out lines.
//
// Everything is addressed in model offsets (see @golemdocs/docx edit/text.ts), not in laid-out
// text, so commands can be replayed on another client or a server and positions stay put
// when layout changes. Visible offsets only appear when talking to layout (stepping over
// hidden text, caret x positions).

//
// The editor is built up in layers, each a class extending the one before (a class can't span
// files): base (state, positions) > navigation (moving, geometry) > editing (edits, undo) >
// links > search > formatting > comments > sections > tables. This file adds `apply`, which
// dispatches a command to them.

import { commentRanges, inlinesLength, paragraphLength, type Inline, type Paragraph, type ParagraphProperties } from '@golemdocs/docx';
import { END, type Operation, type Pos } from '@golemdocs/ops';
import { type Command, type CommandResult, NO_CHANGE, combine } from './types.ts';
import { EditorTables } from './tables.ts';

export * from './types.ts';
export { withFormat } from './formatting.ts';

export class Editor extends EditorTables {
  /** The paragraph's id, which stays the same as it is edited. */
  paragraphId(paragraph: Paragraph): string {
    return this.replica.id(paragraph);
  }

  /** The paragraph with an id, if it is still in the document. */
  paragraphWithId(id: string): Paragraph | undefined {
    return this.replica.paragraph(id);
  }

  /**
   * Gives a paragraph other properties and content (as one edit, in place: the paragraph keeps its id
   * and its section), with the caret `caret` model offsets into it.
   */
  replaceParagraph(paragraph: Paragraph, properties: ParagraphProperties, content: Inline[], caret: number, define: Operation[] = []): CommandResult {
    const id = this.replica.id(paragraph);
    const next: ParagraphProperties = { ...structuredClone(properties) };
    if (paragraph.properties.section) next.section = paragraph.properties.section;
    else delete next.section;
    const ops: Operation[] = [...define, { type: 'delete', paragraph: id, from: 0, to: END }, { type: 'setParagraphProperties', paragraph: id, properties: next }];
    if (content.length) ops.push({ type: 'insertContent', paragraph: id, offset: 0, content: structuredClone(content) });
    return this.edit([ops, { paragraph: id, offset: Math.min(caret, inlinesLength(content)) }]);
  }

  // --- Commands --------------------------------------------------------------------------

  /** Applies a command. Edits invalidate the session; run it afterwards to update layout. */
  apply(command: Command): CommandResult {
    if (command.kind !== 'move' || (command.to !== 'up' && command.to !== 'down')) this.goalX = null;
    const pending = this.pending;
    if (command.kind !== 'formatText') this.pending = null;
    switch (command.kind) {
      case 'insertText':
      case 'insertParagraph':
      case 'insertLineBreak': {
        // Typing over a selection: delete it first (as its own step, undone together with
        // the insertion), then insert at the document as it now is.
        const group = this.collapsed ? undefined : `replace:${this.commands++}`;
        const removed = this.collapsed ? NO_CHANGE : this.edit(this.deleteSelection(), group);
        const at = this.selection.focus;
        let ops: Operation[];
        let after: Pos;
        if (command.kind === 'insertText') {
          [ops, after] = this.insertOps(at, command.text);
          if (pending) {
            for (const op of [...ops]) {
              if (op.type === 'insertText') ops.push({ type: 'formatText', paragraph: op.paragraph, from: op.offset, to: op.offset + op.text.length, format: pending });
            }
          }
        } else if (command.kind === 'insertParagraph') [ops, after] = this.splitOps(at);
        else {
          const item = command.type ? ({ kind: 'break', type: command.type } as const) : ({ kind: 'break' } as const);
          ops = [{ type: 'insertItem', paragraph: this.replica.id(at.paragraph), offset: at.offset, item }];
          after = { paragraph: this.replica.id(at.paragraph), offset: at.offset + 1 };
        }
        const typing = command.kind === 'insertText' && !command.text.includes('\n') ? 'typing' : undefined;
        return combine(removed, this.edit([ops, after], group ?? typing));
      }
      case 'delete':
        if (!this.collapsed) return this.edit(this.deleteSelection());
        return this.edit(command.direction === 'backward' ? this.deleteBackward(command.unit ?? 'character') : this.deleteForward(command.unit ?? 'character'), 'deleting');
      case 'move':
        this.move(command.to, command.extend ?? false);
        return NO_CHANGE;
      case 'pointer':
        this.pointer(command);
        return NO_CHANGE;
      case 'selectAll': {
        const list = this.paragraphs();
        const last = list[list.length - 1];
        this.selection = { anchor: { paragraph: list[0], offset: 0 }, focus: { paragraph: last, offset: paragraphLength(last) } };
        return NO_CHANGE;
      }
      case 'formatText':
        return this.formatText(command);
      case 'formatParagraphs': {
        const ops = [...(command.define ?? [])];
        this.selectedParagraphs().forEach((p, i) => {
          const change = command.change(p, i);
          if (change && Object.keys(change).length) ops.push(this.setProperties(p, change));
        });
        return this.editInPlace(ops);
      }
      case 'changeCase':
        return this.editInPlace(this.changeCaseOps(command.change));
      case 'addComment':
        return this.edit(this.addCommentOps(command));
      case 'editComment': {
        const comment = this.doc.comments.find((c) => c.id === command.id);
        if (!comment) return NO_CHANGE;
        const ops: Operation[] = [{ type: 'setComment', id: command.id, comment: { ...comment, paragraphs: command.text.split(/\r\n?|\n/) } }];
        return this.edit([ops, this.selectionIds.focus]);
      }
      case 'replyComment':
        return this.edit(this.replyCommentOps(command));
      case 'resolveComment': {
        const root = this.threadRoot(command.id);
        if (!root || !!root.resolved === command.resolved) return NO_CHANGE;
        const { resolved: _old, ...rest } = root;
        const ops: Operation[] = [{ type: 'setComment', id: root.id, comment: command.resolved ? { ...rest, resolved: true } : rest }];
        return this.edit([ops, this.selectionIds.focus]);
      }
      case 'deleteComment':
        return this.edit(this.deleteCommentOps(command.id));
      case 'selectComment': {
        const range = commentRanges(this.paragraphs()).get(command.id);
        if (range) this.selection = { anchor: { ...range.start }, focus: { ...range.end } };
        return NO_CHANGE;
      }
      case 'find':
        return { ...NO_CHANGE, found: this.find(command.text, command.matchCase ?? false, command.backward ?? false, command.wholeWord ?? false) };
      case 'replaceAll':
        return this.replaceAll(command.text, command.with, command.matchCase ?? false, command.wholeWord ?? false);
      case 'select': {
        const list = this.paragraphs();
        const paragraph = list[command.paragraph];
        if (paragraph) {
          const length = paragraphLength(paragraph);
          // Ending in another paragraph (`until`, at its start): the selection runs from here to there, across table cells too.
          const end = command.until === undefined ? undefined : list[command.until];
          this.selection = end
            ? { anchor: { paragraph, offset: Math.min(command.from, length) }, focus: { paragraph: end, offset: 0 } }
            : { anchor: { paragraph, offset: Math.min(command.from, length) }, focus: { paragraph, offset: Math.min(command.to, length) } };
        }
        return NO_CHANGE;
      }
      case 'insertContent': {
        const group = this.collapsed ? undefined : `replace:${this.commands++}`;
        const removed = this.collapsed ? NO_CHANGE : this.edit(this.deleteSelection(), group);
        const at = this.selection.focus;
        const id = this.replica.id(at.paragraph);
        const ops: Operation[] = [{ type: 'insertContent', paragraph: id, offset: at.offset, content: command.content }];
        return combine(removed, this.edit([ops, { paragraph: id, offset: at.offset + inlinesLength(command.content) }], group));
      }
      case 'setLink':
        return this.edit(this.setLinkOps(command.url, command.text));
      case 'removeLink':
        return this.edit(this.removeLinkOps());
      case 'insertTable':
        return this.edit(this.insertTableOps(command.rows, command.columns, command.define ?? []));
      case 'tableEdit':
        return this.tableEdit(command.edit);
      case 'setColumns':
        return this.edit(this.setColumnsOps(command));
      case 'setPage':
        return this.edit(this.setPageOps(command));
      case 'pasteContent':
        return this.pasteContent(command.blocks, command.define ?? []);
      case 'setProperties':
        return this.edit([[{ type: 'setDocumentProperties', properties: command.properties }], this.selectionIds.focus]);
      case 'tab':
        return this.tab(command.backward);
      case 'splitCells':
        return this.splitCells(command.columns, command.rows);
    }
  }
}
