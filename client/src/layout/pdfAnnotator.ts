// Marking up a PDF shown as its own pages: selecting its text, and adding, changing and removing
// markup annotations (highlight, underline, strikeout, sticky notes) over it. The page text never
// changes; the annotations are a layer kept with the document (the .wdoc's pdf extension) and
// written into the file only when it's exported (see @word/pdf applyAnnotations). Its form fields
// are a layer the same way, filled in and arranged by the page (see ../ui/formLayer.ts); one undo
// history covers both.

import { noteRect, quadBoxes, quadsFor, type Annotation, type AnnotationKind, type FormField } from '@word/pdf';
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

  constructor(
    private readonly view: PdfView,
    /** Credited on new annotations. */
    private readonly author?: string,
  ) {}

  get annotations(): readonly Annotation[] {
    return this.view.annotations;
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
    const current = this.layers();
    to.push(current);
    this.lastMerge = null;
    if (previous.fields !== current.fields) this.view.setFields(previous.fields);
    if (previous.annotations === current.annotations) return [];
    this.view.setAnnotations(previous.annotations);
    if (this.selectedId && !previous.annotations.some((a) => a.id === this.selectedId)) this.selectedId = null;
    return changedPages(current.annotations, previous.annotations);
  }

  private layers(): Layers {
    return { annotations: this.annotations, fields: this.fields };
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

function changedPages(a: readonly Annotation[], b: readonly Annotation[]): number[] {
  const key = (x: Annotation) => JSON.stringify(x);
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
