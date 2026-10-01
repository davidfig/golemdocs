// The formatting at the selection, for toolbar state (bold pressed, font name, alignment…).
//
// A collapsed caret reports the character before it, as Word does (the one after it at the
// start of a paragraph, the paragraph mark in an empty one). A selection reports a mark as on
// only when every run in it has it; alignment, style and list only when every paragraph
// agrees. Font and size are never left blank: when the selection mixes them, the start of the
// selection wins.

import { FALLBACK_FAMILY } from '@golemdocs/layout';
import { inlineLength, paragraphLength, StyleResolver, type Inline, type Paragraph, type Run, type RunProperties, type WordDocument } from '@golemdocs/docx';
import { withFormat, type Position } from '@golemdocs/editor';
import type { RunFormat } from '@golemdocs/ops';
import { isCode } from './formatting.ts';
import type { Alignment, FormatState, ListKind, Mark, ParagraphChoice } from '../ui/actions.ts';

/** Most runs examined for one selection, so Select All in a huge document stays fast (a few ms).
 * Past it, marks reflect the runs examined. */
const RUN_BUDGET = 5_000;
/** Word's size when nothing sets one: 10pt. */
const DEFAULT_HALF_POINTS = 20;

/** Most runs examined for the document's colors, and how long the answer is kept. */
const COLOR_BUDGET = 20_000;
const COLOR_TTL_MS = 500;
/** Most colors offered. */
const MAX_DOCUMENT_COLORS = 16;

const MARKS: Mark[] = ['bold', 'italic', 'underline', 'strikethrough', 'superscript', 'subscript', 'code'];

/** Style resolution for a document, rebuilt when its style sheet is replaced. */
export class FormatReader {
  private resolver: StyleResolver | null = null;
  private sheet: unknown = null;
  private numbering: unknown = null;
  private colors: string[] = [];
  private colorsAt = -Infinity;

  constructor(private readonly doc: WordDocument) {}

  private styles(): StyleResolver {
    const { doc } = this;
    if (!this.resolver || this.sheet !== doc.styles || this.numbering !== doc.numbering) {
      this.resolver = new StyleResolver(doc.styles, doc.theme, doc.numbering);
      this.sheet = doc.styles;
      this.numbering = doc.numbering;
    }
    return this.resolver;
  }

  /**
   * Formatting between two positions in document order (equal for a caret). `pending` is
   * formatting chosen at a caret for what's typed next.
   */
  read(start: Position, end: Position, paragraphs: readonly Paragraph[], pending?: RunFormat | null): FormatState {
    const styles = this.styles();
    const acc = new Accumulator(styles);
    const collapsed = start.paragraph === end.paragraph && start.offset === end.offset;

    if (!collapsed) {
      let budget = RUN_BUDGET;
      const first = paragraphs.indexOf(start.paragraph);
      const last = paragraphs.indexOf(end.paragraph);
      for (let i = Math.max(first, 0); i <= last && budget > 0; i++) {
        const paragraph = paragraphs[i];
        const from = paragraph === start.paragraph ? start.offset : 0;
        const to = paragraph === end.paragraph ? end.offset : Infinity;
        // A paragraph the selection only touches at its end (the mark) doesn't count.
        if (paragraph !== start.paragraph && to === 0) continue;
        const props = styles.paragraph(paragraph.properties);
        let any = false;
        forEachRun(paragraph.children, from, to, (run) => {
          acc.run(styles.run(props.style, run.properties));
          any = true;
          return --budget > 0;
        });
        if (any || paragraphLength(paragraph) === 0) acc.paragraph(paragraph);
      }
    }
    // A caret, or a selection with no text in it (empty paragraphs).
    if (!acc.runs) {
      const { paragraph, offset } = start;
      acc.paragraph(paragraph);
      acc.run(caretRunProperties(paragraph, offset, styles, pending));
    }
    return { ...acc.result(), documentColors: this.documentColors(paragraphs, styles) };
  }

  /** The text colors in use, most used first. Rescanned at most every COLOR_TTL_MS. */
  private documentColors(paragraphs: readonly Paragraph[], styles: StyleResolver): string[] {
    const now = performance.now();
    if (now - this.colorsAt < COLOR_TTL_MS) return this.colors;
    this.colorsAt = now;
    const counts = new Map<string, number>();
    let budget = COLOR_BUDGET;
    for (const paragraph of paragraphs) {
      if (budget <= 0) break;
      const style = styles.paragraph(paragraph.properties).style;
      forEachRun(paragraph.children, 0, Infinity, (run) => {
        const color = styles.run(style, run.properties).color?.val;
        if (color && color !== 'auto') {
          const key = `#${color.toUpperCase()}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        return --budget > 0;
      });
    }
    this.colors = [...counts].sort((a, b) => b[1] - a[1]).slice(0, MAX_DOCUMENT_COLORS).map(([color]) => color);
    return this.colors;
  }
}

/** Calls `fn` for each run with text overlapping [from, to); `fn` returns false to stop. */
function forEachRun(inlines: readonly Inline[], from: number, to: number, fn: (run: Run) => boolean): void {
  let pos = 0;
  let stopped = false;
  const walk = (list: readonly Inline[]) => {
    for (const inline of list) {
      if (stopped || pos >= to) return;
      const length = inlineLength(inline);
      if (inline.kind === 'run') {
        if (length > 0 && pos + length > from && !fn(inline)) stopped = true;
        pos += length;
      } else if (inline.kind === 'raw') {
        pos += length;
      } else if (inline.kind === 'wrapper' && (inline.shell.name === 'w:del' || inline.shell.name === 'w:moveFrom')) {
        // Deleted text (tracked changes) doesn't set the look of the selection.
        pos += length;
      } else {
        walk(inline.children);
      }
    }
  };
  walk(inlines);
}

/** The run formatting typing at `offset` would get: the character before, else after, else the mark. */
function caretRunProperties(paragraph: Paragraph, offset: number, styles: StyleResolver, pending?: RunFormat | null): RunProperties {
  const paragraphStyle = styles.paragraph(paragraph.properties).style;
  let before = null as Run | null;
  let after = null as Run | null;
  let pos = 0;
  const walk = (list: readonly Inline[]) => {
    for (const inline of list) {
      if (after) return;
      const length = inlineLength(inline);
      if (inline.kind === 'run') {
        if (length > 0) {
          if (pos < offset && pos + length >= offset) before = inline;
          else if (pos >= offset && !after) after = inline;
        }
        pos += length;
      } else if (inline.kind === 'raw' || (inline.kind === 'wrapper' && (inline.shell.name === 'w:del' || inline.shell.name === 'w:moveFrom'))) {
        pos += length;
      } else walk(inline.children);
      if (before && pos >= offset) return;
    }
  };
  walk(paragraph.children);
  const run = before ?? after;
  const direct = run ? run.properties : (paragraph.properties.runProperties ?? {});
  return styles.run(paragraphStyle, pending ? withFormat(direct, pending) : direct);
}

/** One value, or "mixed" once two differ. */
class Agreement<T> {
  value: T | undefined;
  first: T | undefined;
  mixed = false;
  private seen = false;

  add(value: T): void {
    if (!this.seen) {
      this.seen = true;
      this.value = this.first = value;
    } else if (!this.mixed && value !== this.value) {
      this.mixed = true;
      this.value = undefined;
    }
  }
}

class Accumulator {
  runs = 0;

  constructor(private readonly styles: StyleResolver) {}

  private readonly marks = new Map<Mark, boolean>(MARKS.map((m) => [m, true]));
  private readonly font = new Agreement<string>();
  private readonly size = new Agreement<number>();
  private readonly color = new Agreement<string | null>();
  private readonly highlight = new Agreement<string | null>();
  private readonly style = new Agreement<string | undefined>();
  private readonly align = new Agreement<Alignment>();
  private readonly list = new Agreement<ListKind | null>();
  /** One agreement per Paragraph dialog field. */
  private readonly para = new Map<keyof ParagraphChoice, Agreement<string | number | boolean>>();

  private agree(key: keyof ParagraphChoice, value: string | number | boolean): void {
    let agreement = this.para.get(key);
    if (!agreement) this.para.set(key, (agreement = new Agreement()));
    agreement.add(value);
  }

  run(props: RunProperties): void {
    this.runs++;
    const on: Record<Mark, boolean> = {
      bold: !!props.bold,
      italic: !!props.italic,
      underline: !!props.underline?.val && props.underline.val !== 'none',
      strikethrough: !!(props.strike || props.doubleStrike),
      superscript: props.vertAlign === 'superscript',
      subscript: props.vertAlign === 'subscript',
      code: isCode(props),
    };
    for (const mark of MARKS) if (!on[mark]) this.marks.set(mark, false);
    this.font.add(this.fontName(props));
    this.size.add((props.size ?? DEFAULT_HALF_POINTS) / 2);
    const color = props.color?.val;
    this.color.add(color && color !== 'auto' ? `#${color.toUpperCase()}` : null);
    this.highlight.add(props.highlight && props.highlight !== 'none' ? props.highlight : null);
  }

  private fontName(props: RunProperties): string {
    return this.styles.font(props.fonts) ?? FALLBACK_FAMILY;
  }

  paragraph(paragraph: Paragraph): void {
    const { styles } = this;
    const props = styles.paragraph(paragraph.properties);
    this.style.add(styleName(styles, props.style));
    this.align.add(alignment(props.justification));
    const { indent, spacing } = props;
    this.agree('left', indent?.left ?? indent?.start ?? 0);
    this.agree('right', indent?.right ?? indent?.end ?? 0);
    const hanging = indent?.hanging ?? 0;
    const firstLine = indent?.firstLine ?? 0;
    this.agree('special', hanging ? 'hanging' : firstLine ? 'firstLine' : 'none');
    this.agree('by', hanging || firstLine);
    this.agree('before', spacing?.before ?? 0);
    this.agree('after', spacing?.after ?? 0);
    this.agree('lineRule', spacing?.lineRule ?? 'auto');
    this.agree('line', spacing?.line ?? 240);
    this.agree('keepNext', !!props.keepNext);
    this.agree('keepLines', !!props.keepLines);
    this.agree('pageBreakBefore', !!props.pageBreakBefore);
    this.agree('widowControl', props.widowControl !== false);
    const id = props.numbering?.id;
    const level = id ? styles.listLevel(id, props.numbering?.level ?? 0) : undefined;
    this.list.add(!level || level.format === 'none' ? null : level.format === 'bullet' ? 'bullet' : 'number');
  }

  result(): FormatState {
    const marks: Partial<Record<Mark, boolean>> = {};
    for (const mark of MARKS) marks[mark] = this.runs > 0 && this.marks.get(mark)!;
    const paragraph: Record<string, string | number | boolean> = {};
    for (const [key, agreement] of this.para) if (agreement.value !== undefined) paragraph[key] = agreement.value;
    const aligned = this.align.value;
    if (aligned) paragraph.align = aligned;
    return {
      paragraph: paragraph as ParagraphChoice,
      marks,
      // Never blank: a mixed selection shows its start's font and size.
      font: this.font.value ?? this.font.first ?? FALLBACK_FAMILY,
      size: this.size.value ?? this.size.first ?? DEFAULT_HALF_POINTS / 2,
      style: this.style.value,
      align: this.align.value,
      list: this.list.mixed ? undefined : (this.list.value ?? null),
      color: this.color.mixed ? undefined : (this.color.value ?? null),
      highlight: this.highlight.mixed ? undefined : (this.highlight.value ?? null),
    };
  }
}

function alignment(justification: string | undefined): Alignment {
  switch (justification) {
    case 'center':
      return 'center';
    case 'right':
    case 'end':
      return 'right';
    case 'both':
    case 'distribute':
    case 'lowKashida':
    case 'mediumKashida':
    case 'highKashida':
    case 'thaiDistribute':
      return 'justify';
    default:
      return 'left';
  }
}

/** A style's display name: Word stores built-in names in lower case ("heading 1"). */
function styleName(styles: StyleResolver, id: string | undefined): string | undefined {
  const style = styles.style(id);
  const name = style?.name ?? id;
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : undefined;
}
