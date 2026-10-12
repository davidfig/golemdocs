// Editor state: the selection, document order and positions as operations address them.
import { type Command, type CommandResult, type Position, type Selection } from './types.ts';
import type { Selection as OpSelection } from '@golemdocs/ops';

import { paragraphLength, paragraphsIn, type Paragraph, type WordDocument } from '@golemdocs/docx';
import { Replica, type Pos, type RunFormat } from '@golemdocs/ops';
import { type LayoutSession } from '@golemdocs/layout';

export abstract class EditorBase {
  /** Applies a command (see Editor). */
  abstract apply(command: Command): CommandResult;

  selection: Selection;
  /** x the caret tries to keep while moving up and down. */
  protected goalX: number | null = null;
  protected order: Map<Paragraph, number> | null = null;
  protected list: Paragraph[] = [];
  /** Display page index near the caret, to find lines quickly. */
  protected hint = 0;
  protected commands = 0;
  /** Formatting chosen at a caret, for the text typed next there. */
  pending: RunFormat | null = null;

  constructor(
    /** The document, edited through operations (undo, collaboration). */
    readonly replica: Replica,
    readonly session: LayoutSession,
  ) {
    const first = this.paragraphs()[0];
    this.selection = { anchor: { paragraph: first, offset: 0 }, focus: { paragraph: first, offset: 0 } };
  }

  get doc(): WordDocument {
    return this.replica.doc;
  }

  /** Body paragraphs in document order (including those in tables). */
  paragraphs(): Paragraph[] {
    if (!this.order) {
      this.list = paragraphsIn(this.doc.body);
      this.order = new Map(this.list.map((p, i) => [p, i]));
    }
    return this.list;
  }

  /** The selection as paragraph indexes (among `paragraphs()`) and offsets, or null when it is outside the body (a header, a text box). */
  selectionIndex(): { anchor: [number, number]; focus: [number, number] } | null {
    const anchor = this.indexOf(this.selection.anchor.paragraph);
    const focus = this.indexOf(this.selection.focus.paragraph);
    if (anchor < 0 || focus < 0) return null;
    return { anchor: [anchor, this.selection.anchor.offset], focus: [focus, this.selection.focus.offset] };
  }

  protected indexOf(p: Paragraph): number {
    this.paragraphs();
    return this.order!.get(p) ?? -1;
  }

  protected structureChanged(): void {
    this.order = null;
  }

  protected compare(a: Position, b: Position): number {
    const ia = this.indexOf(a.paragraph);
    const ib = this.indexOf(b.paragraph);
    return ia !== ib ? ia - ib : a.offset - b.offset;
  }

  get collapsed(): boolean {
    const { anchor, focus } = this.selection;
    return anchor.paragraph === focus.paragraph && anchor.offset === focus.offset;
  }

  /** Selection start and end in document order. */
  ordered(): [Position, Position] {
    const { anchor, focus } = this.selection;
    return this.compare(anchor, focus) <= 0 ? [anchor, focus] : [focus, anchor];
  }

  protected collapse(position: Position): void {
    this.selection = { anchor: { ...position }, focus: { ...position } };
  }

  protected pos(position: Position): Pos {
    // A paragraph that's gone (removed by someone else, say) can't be addressed: its start.
    if (!this.replica.engine.index.has(position.paragraph.attrs['w14:paraId'] ?? '') || this.replica.paragraph(position.paragraph.attrs['w14:paraId']) !== position.paragraph) {
      return { paragraph: this.replica.id(this.paragraphs()[0]), offset: 0 };
    }
    return { paragraph: this.replica.id(position.paragraph), offset: position.offset };
  }

  protected position(pos: Pos): Position | null {
    const paragraph = this.replica.paragraph(pos.paragraph);
    return paragraph ? { paragraph, offset: Math.min(pos.offset, paragraphLength(paragraph)) } : null;
  }

  /** The selection by paragraph ids (for undo history, collaboration). */
  get selectionIds(): OpSelection {
    return { anchor: this.pos(this.selection.anchor), focus: this.pos(this.selection.focus) };
  }

  /** Sets the selection by ids; positions whose paragraph is gone fall back to the document start. */
  setSelectionIds(selection: OpSelection): void {
    const first = { paragraph: this.paragraphs()[0], offset: 0 };
    const anchor = this.position(selection.anchor) ?? first;
    const focus = this.position(selection.focus) ?? anchor;
    this.selection = { anchor, focus };
  }
}
