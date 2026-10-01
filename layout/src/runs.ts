// Flattens a paragraph's inline content into text plus per-character styles: resolves run
// formatting, evaluates fields, drops deleted and hidden text, maps symbol fonts and collects
// inline and floating drawings.

import { formatNumber, inlineLength, inlinesLength, isMathInline, itemLength, readMathInline, type Drawing, type Inline, type MathEquation, type Run, type RunContent, type RunProperties } from '@golemdocs/docx';
import type { SourceSpan } from './offsets.ts';
import { cachedRunStyle, runStyle, type LayoutContext, type RunStyle } from './context.ts';

/** Control characters in collected text. */
export const TAB = '\t';
export const LINE_BREAK = '\n';
/** Page break: ends the line and the page. */
export const PAGE_BREAK = '\f';
/** Column break: ends the line and the column (a page, in a section with one column). */
export const COLUMN_BREAK = '\v';
/** Placeholder for an inline object (drawing). */
export const OBJECT = '￼';
export const SOFT_HYPHEN = '­';

export interface CollectedText {
  text: string;
  /** Style index (into `styles`) for each UTF-16 code unit of `text`. */
  styleOf: Uint16Array;
  styles: RunStyle[];
  /** Inline drawings by position in `text`. */
  objects: Map<number, Drawing>;
  /** Equations by position in `text` (each is one OBJECT placeholder). */
  maths: Map<number, MathEquation>;
  /** Anchored (floating) drawings in this paragraph. */
  floats: Drawing[];
  /** Absolute-position tabs (w:ptab) by position in `text`. */
  ptabs: Map<number, PositionalTab>;
  /** Where the visible text came from in the model (visible offsets exclude a list label). */
  spans: SourceSpan[];
}

/** w:ptab: a tab to a position relative to the margins or indents, not to tab stops. */
export interface PositionalTab {
  alignment: 'left' | 'center' | 'right';
  relativeTo: 'margin' | 'indent';
  leader?: string;
}

interface Field {
  instruction: string;
  phase: 'instruction' | 'result';
  /** The result is replaced by a computed value, so the cached result text is skipped. */
  replaced: boolean;
}

/**
 * Symbol fonts (Symbol, Wingdings) put glyphs at U+F0xx. We don't ship them, so common
 * bullet glyphs map to a bullet in the text font.
 */
function mapSymbol(code: number): string {
  const c = code >= 0xf000 ? code - 0xf000 : code;
  switch (c) {
    case 0xb7: // Symbol: bullet
    case 0xa7: // Wingdings: small square
    case 0x6c: // Wingdings: circle
    case 0x6e: // Wingdings: square
    case 0x76: // Wingdings: diamond
    case 0x71: // Wingdings: box
    case 0xd8: // Wingdings: arrowhead
    case 0xfc: // Wingdings: check
      return '•';
    case 0x2d:
      return '–';
    default:
      return c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '•';
  }
}

/** Equations read from their XML once per element (an edit replaces the element). */
const equations = new WeakMap<object, MathEquation>();
function equationOf(inline: Inline & { kind: 'raw' }): MathEquation {
  let equation = equations.get(inline.xml);
  if (!equation) equations.set(inline.xml, (equation = readMathInline(inline)));
  return equation;
}

export class TextCollector {
  private readonly chunks: string[] = [];
  private readonly chunkStyles: number[] = [];
  private length = 0;
  readonly styles: RunStyle[] = [];
  private readonly styleIndex = new Map<RunStyle, number>();
  readonly objects = new Map<number, Drawing>();
  readonly maths = new Map<number, MathEquation>();
  readonly floats: Drawing[] = [];
  readonly ptabs = new Map<number, PositionalTab>();
  private readonly fields: Field[] = [];
  readonly spans: SourceSpan[] = [];
  /** Model offset of the next content item (see @golemdocs/docx edit/text.ts). */
  private model = 0;

  constructor(
    private readonly ctx: LayoutContext,
    private readonly paragraphStyle: string | undefined,
  ) {}

  /** Index of a run's style, from its direct formatting (resolved through styles, cached). */
  style(direct: RunProperties): number {
    return this.indexOf(cachedRunStyle(this.ctx, this.paragraphStyle, direct));
  }

  /** Index of a style from already-resolved properties (paragraph mark, list label). */
  resolvedStyle(props: RunProperties): number {
    return this.indexOf(runStyle(this.ctx, props));
  }

  private indexOf(style: RunStyle): number {
    let index = this.styleIndex.get(style);
    if (index === undefined) {
      index = this.styles.length;
      this.styles.push(style);
      this.styleIndex.set(style, index);
    }
    return index;
  }

  append(text: string, style: number): void {
    if (!text) return;
    this.chunks.push(text);
    this.chunkStyles.push(style);
    this.length += text.length;
  }

  /** Appends text that stands for model positions [model, model + modelLength). */
  private emit(text: string, style: number, model: number, modelLength: number, isText: boolean): void {
    if (!text) return;
    this.spans.push({ visible: this.length, model, length: text.length, modelLength, text: isText });
    this.append(text, style);
  }

  get position(): number {
    return this.length;
  }

  private get showing(): boolean {
    for (const f of this.fields) if (f.phase === 'instruction' || f.replaced) return false;
    return true;
  }

  private fieldValue(instruction: string): string | undefined {
    const values = this.ctx.fields;
    if (!values) return undefined;
    const name = instruction.trim().split(/\s+/)[0]?.toUpperCase();
    if (name === 'PAGE') return formatNumber(values.page, values.format ?? 'decimal');
    if (name === 'NUMPAGES') return String(values.pages);
    return undefined;
  }

  inlines(inlines: Inline[]): void {
    for (const inline of inlines) {
      switch (inline.kind) {
        case 'run':
          this.run(inline);
          break;
        case 'hyperlink':
          this.inlines(inline.children);
          break;
        case 'wrapper': {
          const name = inline.shell.name;
          // Tracked deletions and moved-away text aren't shown (final view).
          if (name === 'w:del' || name === 'w:moveFrom') {
            this.model += inlineLength(inline);
            break;
          }
          if (name === 'w:fldSimple') {
            const value = this.fieldValue(inline.shell.attrs['w:instr'] ?? '');
            if (value !== undefined) {
              const first = inline.children.find((c) => c.kind === 'run');
              const length = inlinesLength(inline.children);
              this.emit(value, this.style(first?.kind === 'run' ? first.properties : {}), this.model, length, false);
              this.model += length;
              break;
            }
          }
          this.inlines(inline.children);
          break;
        }
        case 'raw':
          if (isMathInline(inline)) {
            this.maths.set(this.position, equationOf(inline));
            this.emit(OBJECT, this.style({}), this.model, 1, false);
          }
          this.model += 1;
          break;
      }
    }
  }

  private run(run: Run): void {
    const style = this.style(run.properties);
    const runStyle = this.styles[style];
    for (const c of run.content) {
      const model = this.model;
      this.model += itemLength(c);
      switch (c.kind) {
        case 'fieldChar':
          if (c.type === 'begin') this.fields.push({ instruction: '', phase: 'instruction', replaced: false });
          else if (c.type === 'separate') {
            const field = this.fields.at(-1);
            if (field && field.phase === 'instruction') {
              field.phase = 'result';
              const value = this.fieldValue(field.instruction);
              if (value !== undefined && this.showing) {
                this.emit(value, style, model, 1, false);
                field.replaced = true;
              }
            }
          } else {
            const field = this.fields.pop();
            // A field with no cached result (no separator) still shows computed values.
            if (field?.phase === 'instruction') {
              const value = this.fieldValue(field.instruction);
              if (value !== undefined && this.showing) this.emit(value, style, model, 1, false);
            }
          }
          break;
        case 'instrText': {
          const field = this.fields.at(-1);
          if (field?.phase === 'instruction') field.instruction += c.text;
          break;
        }
        default:
          if (!this.showing || runStyle.hidden) break;
          this.content(c, style, runStyle, model);
      }
    }
  }

  private content(c: RunContent, style: number, runStyle: RunStyle, model: number): void {
    const one = (text: string) => this.emit(text, style, model, 1, false);
    switch (c.kind) {
      case 'text': {
        let text = c.text;
        if (runStyle.symbol) text = Array.from(text, (ch) => mapSymbol(ch.codePointAt(0)!)).join('');
        // Small caps are sized per character during line layout. Uppercasing keeps lengths
        // (ß stays ß) so visible offsets line up with model offsets.
        if (runStyle.caps) text = Array.from(text, (ch) => { const u = ch.toUpperCase(); return u.length === ch.length ? u : ch; }).join('');
        this.emit(text, style, model, c.text.length, true);
        break;
      }
      case 'tab':
        one(TAB);
        break;
      case 'break':
        one(c.type === 'page' ? PAGE_BREAK : c.type === 'column' ? COLUMN_BREAK : LINE_BREAK);
        break;
      case 'cr':
        one(LINE_BREAK);
        break;
      case 'noBreakHyphen':
        one('‑');
        break;
      case 'softHyphen':
        one(SOFT_HYPHEN);
        break;
      case 'symbol':
        one(mapSymbol(parseInt(c.char ?? 'B7', 16)));
        break;
      case 'drawing':
        if (c.inline) {
          this.objects.set(this.position, c);
          one(OBJECT);
        } else {
          this.floats.push(c);
        }
        break;
      case 'raw':
        if (c.xml.name === 'w:ptab') {
          const a = c.xml.attrs;
          this.ptabs.set(this.position, {
            alignment: (a['w:alignment'] as PositionalTab['alignment']) ?? 'left',
            relativeTo: a['w:relativeTo'] === 'indent' ? 'indent' : 'margin',
            leader: a['w:leader'],
          });
          one(TAB);
        }
        // Other raw content (footnote references, VML, ...) isn't laid out yet.
        break;
      default:
        // Deleted text isn't shown.
        break;
    }
  }

  /** Prepends a list label (text in its own style) before everything collected so far. */
  prepend(text: string, style: number): void {
    if (!text) return;
    this.chunks.unshift(text);
    this.chunkStyles.unshift(style);
    this.length += text.length;
    const shifted = new Map<number, Drawing>();
    for (const [pos, d] of this.objects) shifted.set(pos + text.length, d);
    this.objects.clear();
    for (const [pos, d] of shifted) this.objects.set(pos, d);
    const tabs = [...this.ptabs];
    this.ptabs.clear();
    for (const [pos, t] of tabs) this.ptabs.set(pos + text.length, t);
    const maths = [...this.maths];
    this.maths.clear();
    for (const [pos, m] of maths) this.maths.set(pos + text.length, m);
  }

  finish(): CollectedText {
    const text = this.chunks.join('');
    const styleOf = new Uint16Array(text.length);
    let p = 0;
    for (let i = 0; i < this.chunks.length; i++) {
      styleOf.fill(this.chunkStyles[i], p, p + this.chunks[i].length);
      p += this.chunks[i].length;
    }
    return { text, styleOf, styles: this.styles, objects: this.objects, maths: this.maths, floats: this.floats, ptabs: this.ptabs, spans: this.spans };
  }

  /** Label text in a symbol font maps to Unicode stand-ins, like run text does. */
  static labelText(text: string, style: RunStyle): string {
    return style.symbol ? Array.from(text, (ch) => mapSymbol(ch.codePointAt(0)!)).join('') : text;
  }
}
