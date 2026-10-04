// Marking up a PDF shown as its own pages: selecting its text, and adding, changing and removing
// markup annotations (highlight, underline, strikeout, sticky notes) over it. The page text never
// changes; the annotations are a layer kept with the document (the .wdoc's pdf extension) and
// written into the file only when it's exported (see @golemdocs/pdf applyAnnotations). Its form fields
// are a layer the same way, filled in and arranged by the page (see ../ui/formLayer.ts); one undo
// history covers both.

import { alignOf, cellsOf, isStandardName, nearestStandard, noteRect, quadBoxes, quadsFor, textOf, type Annotation, type AnnotationKind, type Box, type FormField, type ApplyResult, type PdfEdit, type Rgb, type ShapeEdit, type TextBlock, type TextEdit, type TextStyle } from '@golemdocs/pdf';
import { applyObjectOps, layersOf, type Keyed, type ObjectLayers, type ObjectOp } from '@golemdocs/ops';
import type { PdfCharacter, PdfView } from '../formats/pdfPages.ts';

/** A rectangle to show, on a page (by index), in page coordinates. */
export interface PageRect {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

type Unit = 'character' | 'word' | 'paragraph';

/** Highlight colors by the CSS color the toolbar sends; anything else is parsed. */
const DEFAULT_COLORS: Record<AnnotationKind, [number, number, number]> = {
  highlight: [1, 0.92, 0.23],
  underline: [0.1, 0.45, 0.9],
  strikeout: [0.9, 0.2, 0.2],
  note: [1, 0.82, 0.3],
};

const HISTORY_LIMIT = 200;


/** What undo and redo step between. */
interface Layers {
  annotations: readonly Annotation[];
  fields: readonly FormField[];
  edits: readonly PdfEdit[];
  /** The PDF file these are layers over (a page operation makes a new one). */
  original: Uint8Array | null;
}

/** How a picked piece of text looks, for editing it in place. Sizes in points. */
export interface PickedStyle {
  family: string;
  serif: boolean;
  mono: boolean;
  bold: boolean;
  italic: boolean;
  size: number;
  /** RGB, 0–1. */
  color: [number, number, number];
  /** Distance between baselines, and the first line's baseline below the top of `box`. */
  lineHeight: number;
  align: 'left' | 'center';
  /** Wraps at the box's width (a paragraph), rather than only at line breaks. */
  wrap: boolean;
  /** The font file the page draws this text's font from (a path under the font folder), so the editor can show the same font. */
  fontFile?: string;
}

/** A picture, shape or drawing on the page, selected to move, resize, restyle or delete (Edit PDF mode). */
export interface PickedObject {
  page: number;
  /** The edit that holds it: an object added to the page, or the change made to one that was in the file. Null: not changed yet. */
  editId: string | null;
  /** A file object's id (`PageObject.id`); null for an added one. */
  target: string | null;
  kind: 'image' | 'path' | 'form' | 'shape' | 'picture' | 'redact';
  /** Where it is (user space). */
  box: Box;
  /** An added shape's look. */
  shape?: Pick<ShapeEdit, 'shape' | 'stroke' | 'fill' | 'width'>;
}

/** The piece of page text being edited (Edit PDF mode). */
export interface PickedText {
  page: number;
  /** The edit that holds the change. */
  id: string;
  /** For text of the file: the runs of its block. Null for a text box. */
  runs: string[] | null;
  /** The text now, and as it was in the file. */
  text: string;
  original: string;
  /** Where it is, in user space (as of when it was picked). */
  box: Box;
  /** Where the baseline of its first line is (user space). */
  baseline: number;
  style: PickedStyle;
}

export class PdfAnnotator {
  /**
   * Selected text: a page and a range of its characters (anchor may be after focus). A click
   * without a drag is `collapsed`: nothing is selected, but a note goes there.
   */
  private text: { page: number; anchor: number; focus: number; collapsed: boolean } | null = null;
  /** The annotation selected by clicking on it. */
  private selectedId: string | null = null;
  private readonly undoStack: Layers[] = [];
  private readonly redoStack: Layers[] = [];
  private nextId = 1;
  /** The last field edit's merge key: a following edit with the same key joins its undo step. */
  private lastMerge: string | null = null;
  /** The edits to the page's content: what is kept and undone (the view shows them, less what is being edited). */
  private editList: readonly PdfEdit[];
  /** Text being edited (Edit PDF mode). The view shows it blank until it is put down, for the editor to draw. */
  picked: PickedText | null = null;
  /** The picked text has already been given its undo step. */
  private pickRemembered = false;
  /** An object selected to move, restyle or delete (Edit PDF mode); not with text picked. */
  pickedObject: PickedObject | null = null;

  /** Set when an undo or redo went back over a page operation: the file to open again, with the layers it had. */
  reopen: { original: Uint8Array; layers: Layers } | null = null;

  constructor(
    private view: PdfView,
    /** Credited on new annotations. */
    private readonly author?: string,
    /** The file `view` shows, so that page operations (which make a new file) can be undone. */
    private original: Uint8Array | null = null,
  ) {
    this.editList = view.edits;
  }

  /**
   * A page operation made a new file (with the layers baked into it): this is its view. What came before
   * stays in the history, so undo can go back to it.
   */
  replaceView(view: PdfView, original: Uint8Array): void {
    this.deselect();
    this.remember();
    this.lastMerge = null;
    this.view = view;
    this.original = original;
    this.editList = view.edits;
    this.selectedId = null;
    this.text = null;
  }

  /** Carries on with `view`, opened from `original` with `layers` (after undo or redo went across a page operation). */
  attach(view: PdfView, original: Uint8Array, layers: { edits: readonly PdfEdit[] }): void {
    this.view = view;
    this.original = original;
    this.editList = layers.edits;
    this.picked = null;
    this.pickedObject = null;
    this.selectedId = null;
    this.text = null;
    this.lastMerge = null;
    this.reopen = null;
  }

  get edits(): readonly PdfEdit[] {
    return this.editList;
  }

  /** What the last edits left under a redaction (pictures and shapes only partly inside it). */
  private partial: ApplyResult['partial'] = [];
  private notified = '0/0';
  private substituted = new Set<string>();
  private notifiedFonts = new Set<string>();

  private setView(edits: readonly PdfEdit[]): ApplyResult {
    const result = this.view.setEdits(edits);
    this.partial = result.partial;
    this.substituted = result.substituted;
    return result;
  }

  /** Set once when a redaction newly leaves something under it that it couldn't take out. */
  partialNotice(): boolean {
    const images = this.partial.reduce((n, p) => n + p.images + p.shapes, 0);
    const key = `${images}`;
    if (key === this.notified) return false;
    this.notified = key;
    return images > 0;
  }

  /** Fonts newly replaced by a standard one since the last call (the app has no file for them), or none. */
  fontNotice(): string[] {
    const fresh = [...this.substituted].filter((f) => !this.notifiedFonts.has(f));
    this.notifiedFonts = new Set(this.substituted);
    return fresh;
  }

  get annotations(): readonly Annotation[] {
    return this.view.annotations;
  }

  /** The three lists as they are, for editing together with others (see pdfRoom.ts). */
  get objects(): ObjectLayers {
    return layersOf<Keyed>({ annotations: this.annotations, fields: this.fields, edits: this.editList });
  }

  /**
   * Changes to the lists (made by others, or an undo of one's own while sharing): put in as they are, without a step in the undo history.
   * Returns the pages that changed.
   */
  applyObjects(ops: readonly ObjectOp[]): number[] {
    const { layers, changed } = applyObjectOps(this.objects, ops);
    const pages = new Set<number>();
    for (const { before, after } of changed) for (const object of [before, after] as ({ page?: number } | undefined)[]) if (typeof object?.page === 'number') pages.add(object.page);
    if (layers.annotations !== this.annotations) {
      this.view.setAnnotations(layers.annotations as readonly Annotation[]);
      if (this.selectedId && !layers.annotations.some((a) => a.id === this.selectedId)) this.selectedId = null;
    }
    if (layers.fields !== this.fields) this.view.setFields(layers.fields as readonly FormField[]);
    if (layers.edits !== this.editList) {
      this.editList = layers.edits as readonly PdfEdit[];
      this.setView(this.editList);
      // What is being edited here may have been changed or taken out by someone else: it is put down.
      if (this.picked && !layers.edits.some((e) => e.id === this.picked!.id)) this.picked = null;
    }
    return [...pages];
  }

  get fields(): readonly FormField[] {
    return this.view.fields;
  }

  /** The form fields are now these; with the last edit's `merge` key, it's undone with that edit. */
  setFields(fields: readonly FormField[], merge?: string): void {
    if (!merge || merge !== this.lastMerge) this.remember();
    this.lastMerge = merge ?? null;
    this.view.setFields(fields);
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** A click or drag at page coordinates. */
  pointer(page: number, x: number, y: number, extend: boolean, unit: Unit): void {
    if (!extend) {
      const hit = this.annotationAt(page, x, y);
      if (hit) {
        this.selectedId = hit.id;
        this.text = null;
        return;
      }
    }
    this.selectedId = null;
    const chars = this.view.characters(page);
    const index = nearest(chars, x, y);
    if (index < 0) {
      this.text = null;
      return;
    }
    if (extend && this.text?.page === page) {
      this.text.focus = index;
      this.text.collapsed = false;
      return;
    }
    if (unit === 'character') {
      this.text = { page, anchor: index, focus: index, collapsed: true };
      return;
    }
    const [start, end] = unit === 'word' ? expand(chars, index, (c) => /\s/.test(c.text)) : expand(chars, index, () => false);
    this.text = { page, anchor: start, focus: end, collapsed: false };
  }

  /** Selects characters `anchor` to `focus` of a page (by index), as dragging over them does. */
  selectChars(page: number, anchor: number, focus: number): void {
    this.selectedId = null;
    this.text = { page, anchor, focus, collapsed: false };
  }

  selectPage(): void {
    const page = this.text?.page ?? (this.selectedId ? this.annotations.find((a) => a.id === this.selectedId)?.page : undefined) ?? 0;
    const count = this.view.characters(page).length;
    this.selectedId = null;
    this.text = count ? { page, anchor: 0, focus: count - 1, collapsed: false } : null;
  }

  private range(): { page: number; chars: PdfCharacter[] } | null {
    if (!this.text || this.text.collapsed) return null;
    const { page, anchor, focus } = this.text;
    return { page, chars: this.view.characters(page).slice(Math.min(anchor, focus), Math.max(anchor, focus) + 1) };
  }

  /** What to highlight on screen: the selected text, or the selected annotation's areas. */
  rects(): PageRect[] {
    const selected = this.selected();
    if (selected) {
      const boxes = selected.kind === 'note' ? [selected.rect] : quadBoxes(selected.quads);
      return boxes.map(([x0, y0, x1, y1]) => this.pageRect(selected.page, x0, y0, x1, y1));
    }
    const range = this.range();
    if (!range) return [];
    return lineBoxes(range.chars).map((b) => ({ page: range.page, x: b.x0, y: b.top, width: b.x1 - b.x0, height: b.bottom - b.top }));
  }

  private pageRect(page: number, x0: number, y0: number, x1: number, y1: number): PageRect {
    const [ax, ay] = this.view.toPage(page, x0, y0);
    const [bx, by] = this.view.toPage(page, x1, y1);
    return { page, x: Math.min(ax, bx), y: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) };
  }

  /** The selected text, or the selected note's text. */
  selectedText(limit: number): string {
    const selected = this.selected();
    if (selected) return selected.contents.slice(0, limit);
    const range = this.range();
    if (!range) return '';
    let out = '';
    let line = range.chars[0]?.line;
    for (const c of range.chars) {
      if (c.line !== line) {
        out += '\n';
        line = c.line;
      }
      out += c.text;
      if (out.length >= limit) break;
    }
    return out.slice(0, limit);
  }

  /** The page the selection is on (for scrolling it into view), if any. */
  get selectionPage(): number | null {
    return this.selected()?.page ?? this.text?.page ?? null;
  }

  private selected(): Annotation | undefined {
    return this.selectedId ? this.annotations.find((a) => a.id === this.selectedId) : undefined;
  }

  /**
   * Marks the selected text (highlight, underline, strikeout), or puts a note on it. With an
   * annotation selected: a highlight/underline/strikeout changes its kind and color, a note
   * changes its text. Returns the page that changed, or null if nothing did.
   */
  annotate(kind: AnnotationKind, options: { color?: string | null; text?: string } = {}): number | null {
    const selected = this.selected();
    // "No highlight" on a selected highlight removes it.
    if (selected && kind === 'highlight' && options.color === null && selected.kind === 'highlight') return this.deleteSelected();
    if (selected) {
      const changed: Annotation =
        kind === 'note'
          ? { ...selected, contents: options.text ?? selected.contents }
          : selected.kind === 'note'
            ? selected
            : { ...selected, kind, color: parseColor(options.color) ?? (kind === selected.kind ? selected.color : DEFAULT_COLORS[kind]) };
      if (changed === selected) return null;
      return this.replace(this.annotations.map((a) => (a.id === selected.id ? { ...changed, modified: undefined } : a)), selected.page);
    }
    const range = this.range();
    if (kind === 'note') {
      if (!range && !this.text) return null;
      const page = range?.page ?? this.text!.page;
      const chars = this.view.characters(page);
      const first = range?.chars[0] ?? chars[this.text!.anchor];
      if (!first) return null;
      // The icon sits in the margin, just left of the line the text starts on.
      const lineStart = chars.find((c) => c.line === first.line) ?? first;
      const ux0 = lineStart.user[0];
      const uy1 = first.user[3];
      const note: Annotation = { id: this.newId(), page, kind, rect: noteRect(Math.max(0, ux0 - 22), uy1), quads: [], color: DEFAULT_COLORS.note, contents: options.text ?? '', author: this.author };
      this.selectedId = note.id;
      this.text = null;
      return this.replace([...this.annotations, note], page);
    }
    if (!range) return null;
    const boxes = lineBoxes(range.chars).map((b) => b.user);
    const annotation: Annotation = { id: this.newId(), page: range.page, kind, ...quadsFor(boxes), color: parseColor(options.color) ?? DEFAULT_COLORS[kind], contents: '', author: this.author };
    return this.replace([...this.annotations, annotation], range.page);
  }

  /** Removes the selected annotation. Returns its page, or null if none was selected. */
  deleteSelected(): number | null {
    const selected = this.selected();
    if (!selected) return null;
    this.selectedId = null;
    return this.replace(
      this.annotations.filter((a) => a.id !== selected.id),
      selected.page,
    );
  }

  /** Returns the pages that changed. */
  undo(): number[] {
    return this.step(this.undoStack, this.redoStack);
  }

  redo(): number[] {
    return this.step(this.redoStack, this.undoStack);
  }

  private step(from: Layers[], to: Layers[]): number[] {
    const previous = from.pop();
    if (!previous) return [];
    if (previous.original !== this.original && previous.original) {
      // Back over (or forward over) a page operation: the other file is opened, and the worker attaches its view.
      this.putDown();
      to.push(this.layers());
      this.reopen = { original: previous.original, layers: previous };
      return [];
    }
    const pages = new Set<number>(this.putDown());
    if (this.pickedObject) {
      pages.add(this.pickedObject.page);
      this.pickedObject = null;
    }
    const current = this.layers();
    to.push(current);
    this.lastMerge = null;
    if (previous.fields !== current.fields) this.view.setFields(previous.fields);
    if (previous.edits !== current.edits) {
      this.editList = previous.edits;
      this.setView(previous.edits);
      for (const page of changedPages(current.edits, previous.edits)) pages.add(page);
    }
    if (previous.annotations !== current.annotations) {
      this.view.setAnnotations(previous.annotations);
      if (this.selectedId && !previous.annotations.some((a) => a.id === this.selectedId)) this.selectedId = null;
      for (const page of changedPages(current.annotations, previous.annotations)) pages.add(page);
    }
    return [...pages];
  }

  // --- editing the page's own text (Edit PDF mode) ------------------------------------------------

  /**
   * Picks the text at a point of a page (page coordinates) to edit it: what was picked before is put
   * down. Returns the pages to lay out again. Nothing is picked where there is no text.
   */
  pickText(page: number, x: number, y: number): number[] {
    const pages = new Set<number>(this.putDown());
    if (this.pickedObject) pages.add(this.pickedObject.page);
    this.pickedObject = null;
    this.selectedId = null;
    this.text = null;
    const [ux, uy] = this.view.toUser(page, x, y);
    const inside = (b: Box, margin = 1.5) => ux >= b[0] - margin && ux <= b[2] + margin && uy >= b[1] - margin && uy <= b[3] + margin;
    // Something added over the page is what the click hit if it is drawn there.
    this.pickedObject = this.addedAt(page, ux, uy);
    if (this.pickedObject) return [...pages, page];
    const onPage = this.editList.filter((e): e is Extract<PdfEdit, { kind: 'text' | 'textbox' }> => e.page === page && (e.kind === 'text' || e.kind === 'textbox'));
    const boxOf = (e: PdfEdit): Box | undefined => this.view.editBoxes.get(e.id) ?? (e.kind === 'textbox' ? e.box : undefined);
    let edit = [...onPage].reverse().find((e) => {
      const box = boxOf(e);
      return box && inside(box);
    });
    let block: TextBlock | null = null;
    if (!edit) {
      // The smallest block of the file's text under the point.
      let best = Infinity;
      for (const b of this.view.original(page).blocks) {
        const area = (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]);
        if (inside(b.box) && area < best) (block = b), (best = area);
      }
      if (block) {
        const ids = new Set(block.runs.map((r) => r.id));
        edit = onPage.find((e) => e.kind === 'text' && e.runs.some((id) => ids.has(id)));
      }
    }
    if (edit?.kind === 'text') block = this.view.originalBlock(page, edit.runs);
    if (edit?.kind === 'textbox') {
      const size = edit.size;
      this.picked = {
        page,
        id: edit.id,
        runs: null,
        text: edit.text,
        original: '',
        box: this.view.editBoxes.get(edit.id) ?? edit.box,
        baseline: edit.box[3] - size * 0.8,
        style: this.textboxStyle(edit.font, edit.bold, edit.italic, size, edit.color),
      };
    } else if (block) {
      this.picked = this.pickedBlock(page, block, edit?.id ?? this.newId(), edit?.text, edit?.kind === 'text' ? edit.style : undefined, edit?.kind === 'text' ? edit.move : undefined);
    } else {
      this.pickedObject = this.fileObjectAt(page, ux, uy);
      return [...pages, ...(this.pickedObject ? [page] : [])];
    }
    this.pickRemembered = false;
    return [...pages, ...this.showEdits()];
  }

  /**
   * Picks what was added to the page at a point (a text box, a picture, a shape or mark), and nothing else: for Fill In mode,
   * where the page's own content isn't for editing. Returns whether something was picked, and the pages to lay out again.
   */
  pickAdded(page: number, x: number, y: number): { picked: boolean; pages: number[] } {
    const [ux, uy] = this.view.toUser(page, x, y);
    const boxes = this.editList.filter((e): e is Extract<PdfEdit, { kind: 'textbox' }> => e.page === page && e.kind === 'textbox');
    const over = this.addedAt(page, ux, uy);
    const text = [...boxes].reverse().find((e) => {
      const b = this.view.editBoxes.get(e.id) ?? e.box;
      return ux >= b[0] - 1.5 && ux <= b[2] + 1.5 && uy >= b[1] - 1.5 && uy <= b[3] + 1.5;
    });
    // An added shape drawn over a text box is what a click there hits; otherwise the text box.
    if (!over && !text) return { picked: false, pages: [] };
    if (text && (!over || this.editList.indexOf(text) > this.editList.findIndex((e) => e.id === over.editId))) {
      const pages = this.pickText(page, x, y);
      return { picked: this.picked !== null, pages };
    }
    return { picked: true, pages: this.pickText(page, x, y) };
  }

  /** Deletes the picked text box (text of the file can't be deleted, only changed). */
  deleteText(): number[] {
    const p = this.picked;
    if (!p || p.runs) return [];
    this.remember();
    this.lastMerge = null;
    this.picked = null;
    this.editList = this.editList.filter((e) => e.id !== p.id);
    this.setView(this.editList);
    return [p.page];
  }

  /** The topmost picture or shape added to the page that is drawn at a point (an outline only where it is drawn). */
  private addedAt(page: number, ux: number, uy: number): PickedObject | null {
    const margin = 3;
    // Later edits are drawn over earlier ones.
    for (const e of [...this.editList].reverse()) {
      if (e.page !== page || (e.kind !== 'shape' && e.kind !== 'image' && e.kind !== 'redact')) continue;
      const box = e.box;
      const inBox = ux >= box[0] - margin && ux <= box[2] + margin && uy >= box[1] - margin && uy <= box[3] + margin;
      if (!inBox) continue;
      if (e.kind === 'shape' && !hitsShape(e, ux, uy, margin)) continue;
      return { page, editId: e.id, target: null, kind: e.kind === 'image' ? 'picture' : e.kind === 'redact' ? 'redact' : 'shape', box, ...(e.kind === 'shape' && { shape: { shape: e.shape, stroke: e.stroke, fill: e.fill, width: e.width } }) };
    }
    return null;
  }

  /** The smallest picture, shape or drawing of the file at a point. */
  private fileObjectAt(page: number, ux: number, uy: number): PickedObject | null {
    const margin = 3;
    const inside = (b: Box) => ux >= b[0] - margin && ux <= b[2] + margin && uy >= b[1] - margin && uy <= b[3] + margin;
    const media = this.view.mediaBox(page);
    const pageArea = (media[2] - media[0]) * (media[3] - media[1]);
    const moved = new Map<string, PdfEdit>();
    for (const e of this.editList) if (e.kind === 'object' && e.page === page) moved.set(e.target, e);
    let best: PickedObject | null = null;
    let bestArea = Infinity;
    for (const o of this.view.original(page).objects) {
      const edit = moved.get(o.id);
      if (edit?.kind === 'object' && edit.deleted) continue;
      const box = (edit && this.view.editBoxes.get(edit.id)) || o.box;
      const area = Math.max(box[2] - box[0], 1) * Math.max(box[3] - box[1], 1);
      // A page-sized background isn't something to pick: clicking it is clicking the page.
      if (area > 0.8 * pageArea || !inside(box) || area >= bestArea) continue;
      best = { page, editId: edit?.id ?? null, target: o.id, kind: o.kind, box };
      bestArea = area;
    }
    return best;
  }

  /** How an added text box looks, for the editor. */
  private textboxStyle(font: string, bold: boolean | undefined, italic: boolean | undefined, size: number, color: [number, number, number]): PickedStyle {
    const look = fontLook(font, bold, italic);
    const fontFile = this.view.faceFile(look.family === 'Times' || look.family === 'Courier' || look.family === 'Helvetica' ? undefined : look.family, { bold: look.bold, italic: look.italic });
    return { family: look.family, serif: look.serif, mono: look.mono, bold: look.bold, italic: look.italic, size, color, lineHeight: size * 1.2, align: 'left', wrap: true, ...(fontFile && { fontFile }) };
  }

  private pickedBlock(page: number, block: TextBlock, id: string, text?: string, look?: TextStyle, move?: [number, number]): PickedText {
    const original = textOf(cellsOf(block));
    // The style of the run with the most text in it.
    const run = block.runs.reduce((a, b) => (b.glyphs.length > a.glyphs.length ? b : a));
    const s = run.font.style;
    return {
      page,
      id,
      runs: block.runs.map((r) => r.id),
      text: text ?? original,
      original,
      box: this.view.editBoxes.get(id) ?? block.box,
      // The block as it was in the file; if it has been moved, so has its baseline (its box already has, from where it was put).
      baseline: block.lines[0].shown + (move?.[1] ?? 0),
      style: (() => {
        const chosen = look?.font ? fontLook(look.font, look.bold, look.italic) : undefined;
        const bold = chosen?.bold ?? s.bold;
        const italic = chosen?.italic ?? s.italic;
        const fontFile = this.view.faceFile(chosen && !STANDARD_FAMILIES[chosen.family] ? chosen.family : undefined, { bold, italic, style: chosen ? undefined : s });
        return {
          family: chosen?.family ?? s.family,
          serif: chosen?.serif ?? s.serif,
          mono: chosen?.mono ?? s.mono,
          bold,
          italic,
          size: look?.size ?? run.size,
          color: look?.color ?? run.color,
          lineHeight: block.pitch * ((look?.size ?? run.size) / run.size),
          align: alignOf(block, this.view.mediaBox(page)),
          wrap: block.paragraph,
          ...(fontFile && { fontFile }),
        };
      })(),
    };
  }

  /** Selects nothing (text or object). Returns the pages to lay out again. */
  deselect(): number[] {
    const pages = new Set<number>(this.putDown());
    if (this.pickedObject) pages.add(this.pickedObject.page);
    this.pickedObject = null;
    return [...pages];
  }

  /** The selected object is now at `box` (user space). Returns the pages to lay out again. */
  moveObject(box: Box): number[] {
    const o = this.pickedObject;
    if (!o) return [];
    const to: Box = [Math.min(box[0], box[2]), Math.min(box[1], box[3]), Math.max(box[0], box[2]), Math.max(box[1], box[3])];
    this.remember();
    this.lastMerge = null;
    if (o.editId) this.editList = this.editList.map((e) => (e.id === o.editId ? withBox(e, to) : e));
    else {
      o.editId = this.newId();
      this.editList = [...this.editList, { id: o.editId, page: o.page, kind: 'object', target: o.target!, box: to }];
    }
    o.box = to;
    return this.showObject();
  }

  /** Deletes the selected object (an added one is gone; one from the file is left out of the page). */
  deleteObject(): number[] {
    const o = this.pickedObject;
    if (!o) return [];
    this.remember();
    this.lastMerge = null;
    this.pickedObject = null;
    if (o.target === null) this.editList = this.editList.filter((e) => e.id !== o.editId);
    else if (o.editId) this.editList = this.editList.map((e) => (e.id === o.editId && e.kind === 'object' ? { ...e, deleted: true } : e));
    else this.editList = [...this.editList, { id: this.newId(), page: o.page, kind: 'object', target: o.target, deleted: true }];
    this.setView(this.editList);
    return [o.page];
  }

  /** Changes the look of the selected shape. */
  setShapeStyle(style: Partial<Pick<ShapeEdit, 'stroke' | 'fill' | 'width'>>): number[] {
    const o = this.pickedObject;
    if (!o?.shape || !o.editId) return [];
    this.remember();
    this.lastMerge = null;
    this.editList = this.editList.map((e) => (e.id === o.editId && e.kind === 'shape' ? { ...e, ...style } : e));
    o.shape = { ...o.shape, ...style };
    return this.showObject();
  }

  /** Adds a shape (its box in user space) and selects it. */
  addShape(page: number, shape: ShapeEdit['shape'], box: Box, look: { stroke: Rgb | null; fill: Rgb | null; width: number; flip?: boolean }): number[] {
    const pages = new Set<number>(this.deselect());
    this.remember();
    this.lastMerge = null;
    const edit: ShapeEdit = { id: this.newId(), page, kind: 'shape', shape, box, ...look };
    this.editList = [...this.editList, edit];
    this.pickedObject = { page, editId: edit.id, target: null, kind: 'shape', box, shape: { shape, stroke: look.stroke, fill: look.fill, width: look.width } };
    for (const p of this.showObject()) pages.add(p);
    return [...pages];
  }

  /** Adds a redaction (its box in user space) and selects it: what is under it is taken out of the page. */
  addRedaction(page: number, box: Box): number[] {
    const pages = new Set<number>(this.deselect());
    this.remember();
    this.lastMerge = null;
    const edit: PdfEdit = { id: this.newId(), page, kind: 'redact', box };
    this.editList = [...this.editList, edit];
    this.pickedObject = { page, editId: edit.id, target: null, kind: 'redact', box };
    for (const p of this.showObject()) pages.add(p);
    return [...pages];
  }

  /** Adds a picture (a PNG or JPEG file, base64) and selects it. */
  addImage(page: number, box: Box, data: string): number[] {
    const pages = new Set<number>(this.deselect());
    this.remember();
    this.lastMerge = null;
    const edit: PdfEdit = { id: this.newId(), page, kind: 'image', box, data };
    this.editList = [...this.editList, edit];
    this.pickedObject = { page, editId: edit.id, target: null, kind: 'picture', box };
    for (const p of this.showObject()) pages.add(p);
    return [...pages];
  }

  /** Adds an empty text box at a point (user space) and picks it to type in. */
  addTextBox(page: number, x: number, y: number, text = ''): number[] {
    const pages = new Set<number>(this.deselect());
    this.remember();
    this.pickRemembered = true;
    this.lastMerge = null;
    const size = 14;
    const media = this.view.mediaBox(page);
    const width = Math.min(240, media[2] - x - 12);
    const box: Box = [x, y - size * 1.2, x + Math.max(width, 60), y];
    const edit: PdfEdit = { id: this.newId(), page, kind: 'textbox', box, text, font: 'Helvetica', size, color: [0, 0, 0] };
    this.editList = [...this.editList, edit];
    this.picked = {
      page,
      id: edit.id,
      runs: null,
      text,
      original: '',
      box,
      baseline: y - size * 0.8,
      style: this.textboxStyle('Helvetica', false, false, size, [0, 0, 0]),
    };
    for (const p of this.showEdits()) pages.add(p);
    return [...pages];
  }

  /** Moves the picked text by (dx, dy) in user space: a text box moves, a block of the file is shown again where it now is. */
  moveText(dx: number, dy: number): number[] {
    const p = this.picked;
    if (!p || (!dx && !dy)) return [];
    if (!this.pickRemembered) {
      this.remember();
      this.pickRemembered = true;
    }
    this.lastMerge = null;
    const rest = this.editList.filter((e) => e.id !== p.id);
    const was = this.editList.find((e) => e.id === p.id);
    if (p.runs) {
      const before = was?.kind === 'text' && was.move ? was.move : [0, 0];
      const next: TextEdit = { ...(was?.kind === 'text' ? was : { id: p.id, page: p.page, kind: 'text' as const, runs: p.runs, text: p.text }), move: [before[0] + dx, before[1] + dy] };
      this.editList = [...rest, next];
    } else if (was?.kind === 'textbox') {
      const [x0, y0, x1, y1] = was.box;
      this.editList = [...rest, { ...was, box: [x0 + dx, y0 + dy, x1 + dx, y1 + dy] }];
    }
    p.box = [p.box[0] + dx, p.box[1] + dy, p.box[2] + dx, p.box[3] + dy];
    p.baseline += dy;
    return [p.page, ...this.showEdits()];
  }

  /**
   * Gives the picked text a different look (all of it): a standard font by family and style, a size, a color.
   * Text from the file is then set again in that font.
   */
  setTextStyle(look: { font?: string; bold?: boolean; italic?: boolean; size?: number; color?: Rgb }): number[] {
    const p = this.picked;
    if (!p) return [];
    const now = p.style;
    const family = look.font ?? now.family;
    const bold = look.bold ?? now.bold;
    const italic = look.italic ?? now.italic;
    const standard = STANDARD_FAMILIES[family];
    // A standard family is a font by name; any other is a family the app has (its file is embedded) with its style as flags.
    const font = standard ? standardName(standard, bold, italic) : family;
    const size = look.size ?? now.size;
    const color = look.color ?? now.color;
    if (!this.pickRemembered) {
      this.remember();
      this.pickRemembered = true;
    }
    this.lastMerge = null;
    const rest = this.editList.filter((e) => e.id !== p.id);
    const was = this.editList.find((e) => e.id === p.id);
    const flags = standard ? {} : { bold, italic };
    if (p.runs) {
      this.editList = [...rest, { id: p.id, page: p.page, kind: 'text', runs: p.runs, text: p.text, ...(was?.kind === 'text' && was.move && { move: was.move }), style: { font, ...flags, size, color } }];
    } else if (was?.kind === 'textbox') this.editList = [...rest, { ...was, font, ...flags, size, color }];
    const kind = fontLook(font, bold, italic);
    const fontFile = this.view.faceFile(standard ? undefined : family, { bold, italic });
    const { fontFile: _old, ...others } = now;
    p.style = { ...others, family: kind.family, serif: kind.serif, mono: kind.mono, bold, italic, size, color, lineHeight: p.runs ? now.lineHeight * (size / now.size) : size * 1.2, ...(fontFile && { fontFile }) };
    return [p.page, ...this.showEdits()];
  }

  /** The view shows the edits (and text being edited blank); returns the object's page. */
  private showObject(): number[] {
    return [...this.showEdits(), ...(this.pickedObject ? [this.pickedObject.page] : [])];
  }

  /** Puts down the picked text (its edit stays, as far as it was changed). Returns the pages to lay out again. */
  putDown(): number[] {
    if (!this.picked) return [];
    const page = this.picked.page;
    this.picked = null;
    this.setView(this.editList);
    return [page];
  }

  /** The picked text is now `text`. One undo step covers all the changes made while it is picked. */
  setPickedText(text: string): number[] {
    const p = this.picked;
    if (!p || text === p.text) return [];
    p.text = text;
    if (!this.pickRemembered) {
      this.remember();
      this.pickRemembered = true;
    }
    this.lastMerge = null;
    const rest = this.editList.filter((e) => e.id !== p.id);
    const was = this.editList.find((e) => e.id === p.id);
    if (p.runs) {
      // What was done to the block before (its look, where it was moved) is kept; put back exactly as it was, there is no edit.
      const next: TextEdit = { ...(was?.kind === 'text' ? was : { id: p.id, page: p.page, kind: 'text' as const, runs: p.runs }), text };
      this.editList = text === p.original && !next.style && !next.move ? rest : [...rest, next];
    } else if (was?.kind === 'textbox') this.editList = [...rest, { ...was, text }];
    return [p.page, ...this.showEdits()];
  }

  /** The view shows the edits, and the picked text blank (the editor draws it). */
  private showEdits(): number[] {
    const p = this.picked;
    if (!p) {
      this.setView(this.editList);
      return [];
    }
    const blank: PdfEdit[] = this.editList.map((e) => (e.id === p.id && (e.kind === 'text' || e.kind === 'textbox') ? { ...e, text: '' } : e));
    if (!blank.some((e) => e.id === p.id) && p.runs) blank.push({ id: p.id, page: p.page, kind: 'text', runs: p.runs, text: '' });
    this.setView(blank);
    return [p.page];
  }

  private layers(): Layers {
    return { annotations: this.annotations, fields: this.fields, edits: this.editList, original: this.original };
  }

  /** Puts the layers as they are now on the undo stack, before a change. */
  private remember(): void {
    this.undoStack.push(this.layers());
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  private replace(next: readonly Annotation[], page: number): number {
    this.remember();
    this.lastMerge = null;
    this.view.setAnnotations(next);
    return page;
  }

  private newId(): string {
    const taken = new Set(this.annotations.map((a) => a.id));
    let id: string;
    do id = `new-${Date.now().toString(36)}-${this.nextId++}`;
    while (taken.has(id));
    return id;
  }

  /** The topmost annotation under a point (notes first: they sit over text markup). */
  private annotationAt(page: number, x: number, y: number): Annotation | undefined {
    const [ux, uy] = this.view.toUser(page, x, y);
    const inside = ([x0, y0, x1, y1]: readonly number[]) => ux >= x0 && ux <= x1 && uy >= y0 && uy <= y1;
    // Later annotations are drawn over earlier ones.
    const onPage = this.annotations.filter((a) => a.page === page).reverse();
    const note = onPage.find((a) => a.kind === 'note' && inside(a.rect));
    if (note) return note;
    // Lines of marked text can touch: take the one whose middle is nearest.
    let best: Annotation | undefined;
    let bestDistance = Infinity;
    for (const a of onPage) {
      if (a.kind === 'note') continue;
      for (const box of quadBoxes(a.quads)) {
        const distance = Math.abs((box[1] + box[3]) / 2 - uy);
        if (inside(box) && distance < bestDistance) {
          best = a;
          bestDistance = distance;
        }
      }
    }
    return best;
  }
}

/** The character nearest a point: on its line if the point is within one, else the closest. */
function nearest(chars: PdfCharacter[], x: number, y: number): number {
  let best = -1;
  let bestDistance = Infinity;
  chars.forEach((c, i) => {
    const dy = y < c.top ? c.top - y : y > c.bottom ? y - c.bottom : 0;
    const dx = x < c.x0 ? c.x0 - x : x > c.x1 ? x - c.x1 : 0;
    // Being on the line matters more than being near horizontally.
    const distance = dy * 4 + dx;
    if (distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  });
  return best;
}

/** The characters around `index` on its line, up to (not including) ones where `stop` says so. */
function expand(chars: PdfCharacter[], index: number, stop: (c: PdfCharacter) => boolean): [number, number] {
  let start = index;
  let end = index;
  while (start > 0 && !stop(chars[start - 1]) && chars[start - 1].line === chars[index].line) start--;
  while (end < chars.length - 1 && !stop(chars[end + 1]) && chars[end + 1].line === chars[index].line) end++;
  return [start, end];
}

/** One box per line of the characters, in page and in user coordinates. */
function lineBoxes(chars: PdfCharacter[]): { x0: number; x1: number; top: number; bottom: number; user: [number, number, number, number] }[] {
  const out: ReturnType<typeof lineBoxes> = [];
  let current: ReturnType<typeof lineBoxes>[number] | null = null;
  let line = NaN;
  for (const c of chars) {
    if (current && c.line === line) {
      current.x0 = Math.min(current.x0, c.x0);
      current.x1 = Math.max(current.x1, c.x1);
      current.top = Math.min(current.top, c.top);
      current.bottom = Math.max(current.bottom, c.bottom);
      const u = current.user;
      current.user = [Math.min(u[0], c.user[0]), Math.min(u[1], c.user[1]), Math.max(u[2], c.user[2]), Math.max(u[3], c.user[3])];
    } else {
      current = { x0: c.x0, x1: c.x1, top: c.top, bottom: c.bottom, user: [...c.user] };
      out.push(current);
      line = c.line;
    }
  }
  return out;
}

function changedPages<T extends { id: string; page: number }>(a: readonly T[], b: readonly T[]): number[] {
  const key = (x: T) => JSON.stringify(x);
  const pages = new Set<number>();
  const before = new Map(a.map((x) => [x.id, x]));
  const after = new Map(b.map((x) => [x.id, x]));
  for (const [id, x] of before) if (!after.has(id) || key(after.get(id)!) !== key(x)) pages.add(x.page);
  for (const [id, x] of after) if (!before.has(id) || key(before.get(id)!) !== key(x)) pages.add(x.page);
  return [...pages];
}

/** #rrggbb to RGB 0–1; null or anything else to undefined. */
function parseColor(css: string | null | undefined): [number, number, number] | undefined {
  const m = css ? /^#?([0-9a-f]{6})$/i.exec(css) : null;
  if (!m) return undefined;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** An edit with a new box (for the kinds that have one). */
function withBox(e: PdfEdit, box: Box): PdfEdit {
  return e.kind === 'object' || e.kind === 'shape' || e.kind === 'image' || e.kind === 'textbox' || e.kind === 'redact' ? { ...e, box } : e;
}

const STANDARD_NAMES = {
  sans: ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique'],
  serif: ['Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic'],
  mono: ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique'],
} as const;

/** The standard font for a family and style. */
function standardName(family: 'sans' | 'serif' | 'mono', bold: boolean, italic: boolean): string {
  return STANDARD_NAMES[family][(bold ? 1 : 0) + (italic ? 2 : 0)];
}

/** Whether a click at (x, y) touches a shape as drawn: inside a filled one, near the line of an outline. */
function hitsShape(e: ShapeEdit, x: number, y: number, margin: number): boolean {
  const [x0, y0, x1, y1] = e.box;
  // A mark is small: anywhere in its box.
  if (e.shape === 'check' || e.shape === 'cross') return true;
  if (e.shape === 'line') {
    const [ay, by] = e.flip ? [y1, y0] : [y0, y1];
    const dx = x1 - x0;
    const dy = by - ay;
    const length = dx * dx + dy * dy;
    const t = length ? Math.max(0, Math.min(1, ((x - x0) * dx + (y - ay) * dy) / length)) : 0;
    return Math.hypot(x - (x0 + t * dx), y - (ay + t * dy)) <= margin + e.width / 2;
  }
  const inner = e.shape === 'ellipse' ? ((x - (x0 + x1) / 2) / ((x1 - x0) / 2 || 1)) ** 2 + ((y - (y0 + y1) / 2) / ((y1 - y0) / 2 || 1)) ** 2 <= 1 : x >= x0 && x <= x1 && y >= y0 && y <= y1;
  if (e.fill) return inner || margin > 0 && nearOutline(e, x, y, margin);
  return nearOutline(e, x, y, margin);
}

/** Within `margin` of the edge of a rectangle or ellipse. */
function nearOutline(e: ShapeEdit, x: number, y: number, margin: number): boolean {
  const [x0, y0, x1, y1] = e.box;
  const m = margin + e.width / 2;
  if (e.shape === 'ellipse') {
    const rx = (x1 - x0) / 2 || 1;
    const ry = (y1 - y0) / 2 || 1;
    const d = Math.hypot((x - (x0 + x1) / 2) / rx, (y - (y0 + y1) / 2) / ry);
    return Math.abs(d - 1) * Math.min(rx, ry) <= m;
  }
  const inOuter = x >= x0 - m && x <= x1 + m && y >= y0 - m && y <= y1 + m;
  const inInner = x > x0 + m && x < x1 - m && y > y0 + m && y < y1 - m;
  return inOuter && !inInner;
}

/** How a font name in an edit reads: the family the picker shows, and the style (a standard name says it itself; a family has flags). */
function fontLook(font: string, bold = false, italic = false): { family: string; bold: boolean; italic: boolean; serif: boolean; mono: boolean } {
  const standard = isStandardName(font);
  const family = standard ? font.replace(/-.*$/, '') : font;
  const b = standard ? /Bold/.test(font) : bold;
  const i = standard ? /Italic|Oblique/.test(font) : italic;
  const kind = nearestStandard(family, false, false);
  return { family, bold: b, italic: i, serif: kind.startsWith('Times'), mono: kind.startsWith('Courier') };
}

/** The picker's standard families and the fonts they are. */
const STANDARD_FAMILIES: Record<string, 'sans' | 'serif' | 'mono'> = { Helvetica: 'sans', Times: 'serif', Courier: 'mono' };
