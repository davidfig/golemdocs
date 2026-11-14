// Screen Reader Mode: the hidden textarea the document keeps focus in holds the text around the caret, with its own
// selection where the document's is, so a screen reader reads characters, words and lines as the caret moves and reads
// a selection (the approach VS Code takes). Keys and typing are still the editor's (ui/textInput.ts prevents the
// textarea's own); this only describes. Never written while an input method is composing, which owns the textarea then.

import type { CaretContext } from '../layout/a11y.ts';

/** The textarea's part: what `CaretMirror` reads and writes (an HTMLTextAreaElement, or a stand-in in tests). */
export interface MirrorTarget {
  value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly selectionDirection: string | null;
  setSelectionRange(start: number, end: number, direction?: 'forward' | 'backward' | 'none'): void;
}

/**
 * The text around a selection in plain lines (the large text editor's): the caret's line, cut to `radius` characters each
 * side, or the lines a selection spans joined by newlines, up to twice that. Columns are indexes into each line's text.
 */
export function linesContext(lineText: (line: number) => string, anchor: { line: number; col: number }, focus: { line: number; col: number }, radius = 1000): CaretContext {
  if (anchor.line === focus.line) {
    const text = lineText(focus.line);
    const lo = Math.max(0, Math.min(anchor.col, focus.col) - radius);
    const hi = Math.min(text.length, Math.max(anchor.col, focus.col) + radius);
    return { text: text.slice(lo, hi), anchor: Math.min(anchor.col, text.length) - lo, focus: Math.min(focus.col, text.length) - lo };
  }
  const forward = anchor.line < focus.line;
  const [from, to] = forward ? [anchor, focus] : [focus, anchor];
  const limit = 2 * radius;
  let text = '';
  let start = 0;
  let end = -1;
  for (let line = from.line; line <= to.line && text.length < limit; line++) {
    const own = lineText(line);
    if (line > from.line) text += '\n';
    if (line === from.line) start = text.length + Math.min(from.col, own.length);
    if (line === to.line) end = text.length + Math.min(to.col, own.length);
    text += own;
  }
  text = text.slice(0, limit);
  end = end < 0 ? text.length : Math.min(end, text.length);
  start = Math.min(start, text.length);
  return forward ? { text, anchor: start, focus: end } : { text, anchor: end, focus: start };
}

export class CaretMirror {
  private composing = false;
  /** The last context, put in once composing ends. */
  private last: CaretContext | null = null;

  constructor(private readonly input: MirrorTarget & Partial<Pick<HTMLElement, 'addEventListener'>>) {
    input.addEventListener?.('compositionstart', () => (this.composing = true));
    input.addEventListener?.('compositionend', () => {
      this.composing = false;
      // ui/textInput.ts empties the textarea when a composition ends: put the text back once the insert has been sent.
      setTimeout(() => this.show(this.last));
    });
  }

  /** Puts `context` in the textarea (null or undefined: empties it). Only what changed is written, so a screen reader is not made to read it again. */
  show(context: CaretContext | null | undefined): void {
    this.last = context ?? null;
    if (this.composing) return;
    const { input } = this;
    const text = context?.text ?? '';
    const start = context ? Math.min(context.anchor, context.focus) : 0;
    const end = context ? Math.max(context.anchor, context.focus) : 0;
    const direction = context && context.focus < context.anchor ? 'backward' : 'forward';
    if (input.value !== text) input.value = text;
    if (input.selectionStart !== start || input.selectionEnd !== end || (start !== end && input.selectionDirection !== direction)) input.setSelectionRange(start, end, direction);
  }
}
