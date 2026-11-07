// What the Font, Borders and Shading, Tabs, Bullets and Numbering and Styles dialogs show and set, in the document model's
// terms: reading the formatting that applies, and turning a choice into what is stored. Stored is only what differs from what
// the style underneath would give, so a document stays free of formatting that says nothing. Pure, for the tests.

import { bookmarkRanges, paragraphLength, StyleResolver, type Border, type NumberingLevel, type Paragraph, type ParagraphProperties, type RunProperties, type Style, type TabStop } from '@golemdocs/docx';
import { withFormat, type ParagraphFormat } from '@golemdocs/editor';
import type { RunFormat } from '@golemdocs/ops';
import type { BorderSide, BordersChoice, DocumentInfo, FontChoice, ListFormat, ParagraphChoice, StyleEdit, StyleInfo, TabChoice } from '../ui/actions.ts';

/** Word's size when nothing sets one, half-points. */
const DEFAULT_HALF_POINTS = 20;
export const BORDER_SIDES = ['top', 'left', 'bottom', 'right'] as const;

// --- Font ------------------------------------------------------------------------------------

/** What a run's resolved properties mean to the Font dialog. */
export function fontOf(props: RunProperties, family: string | undefined): FontChoice {
  const color = props.color?.val;
  const underline = props.underline?.val;
  return {
    family,
    bold: !!props.bold,
    italic: !!props.italic,
    size: (props.size ?? DEFAULT_HALF_POINTS) / 2,
    color: color && color !== 'auto' ? `#${color.toUpperCase()}` : null,
    underline: underline || 'none',
    underlineColor: props.underline?.color && props.underline.color !== 'auto' ? `#${props.underline.color.toUpperCase()}` : null,
    strike: !!props.strike,
    doubleStrike: !!props.doubleStrike,
    superscript: props.vertAlign === 'superscript',
    subscript: props.vertAlign === 'subscript',
    smallCaps: !!props.smallCaps,
    caps: !!props.caps,
    hidden: !!props.vanish,
    spacing: props.spacing ?? 0,
    position: props.position ?? 0,
  };
}

/** The run formatting for a choice, over what the style underneath already gives (`base`). What was left out of the choice stays as it is. */
export function fontFormat(choice: FontChoice, base: RunProperties, current?: RunProperties): RunFormat {
  const format: RunFormat = {};
  const flag = (value: boolean | undefined, inBase: boolean | undefined, ...keys: ('bold' | 'boldCs' | 'italic' | 'italicCs' | 'strike' | 'doubleStrike' | 'smallCaps' | 'caps' | 'vanish')[]) => {
    if (value === undefined) return;
    for (const key of keys) format[key] = value === !!inBase ? null : value;
  };
  if (choice.family) format.fonts = { ascii: choice.family, hAnsi: choice.family, eastAsia: choice.family, cs: choice.family };
  if (choice.size !== undefined) {
    const size = Math.round(Math.min(Math.max(choice.size, 1), 1638) * 2);
    format.size = format.sizeCs = size;
  }
  flag(choice.bold, base.bold, 'bold', 'boldCs');
  flag(choice.italic, base.italic, 'italic', 'italicCs');
  flag(choice.strike, base.strike, 'strike');
  flag(choice.doubleStrike, base.doubleStrike, 'doubleStrike');
  flag(choice.smallCaps, base.smallCaps, 'smallCaps');
  flag(choice.caps, base.caps, 'caps');
  flag(choice.hidden, base.vanish, 'vanish');
  if (choice.color !== undefined) {
    const inBase = base.color?.val && base.color.val !== 'auto';
    format.color = choice.color ? { val: choice.color.replace('#', '').toUpperCase() } : inBase ? { val: 'auto' } : null;
  }
  if (choice.underline !== undefined || choice.underlineColor !== undefined) {
    const val = choice.underline ?? current?.underline?.val ?? base.underline?.val ?? 'none';
    const color = choice.underlineColor === undefined ? current?.underline?.color : (choice.underlineColor?.replace('#', '').toUpperCase() ?? undefined);
    if (val === 'none') format.underline = base.underline?.val && base.underline.val !== 'none' ? { val: 'none' } : null;
    else format.underline = { val, ...(color && { color }) };
  }
  if (choice.superscript !== undefined || choice.subscript !== undefined) {
    if (choice.superscript) format.vertAlign = 'superscript';
    else if (choice.subscript) format.vertAlign = 'subscript';
    else format.vertAlign = base.vertAlign && base.vertAlign !== 'baseline' ? 'baseline' : null;
  }
  if (choice.spacing !== undefined) format.spacing = choice.spacing === (base.spacing ?? 0) ? null : choice.spacing;
  if (choice.position !== undefined) format.position = choice.position === (base.position ?? 0) ? null : choice.position;
  return format;
}

// --- Paragraph -------------------------------------------------------------------------------

/** What the Paragraph dialog's choice changes of a paragraph's own properties. */
export function paragraphFormat(props: ParagraphProperties, choice: ParagraphChoice): ParagraphFormat {
  const { align, left, right, special, by, before, after, line, lineRule, keepNext, keepLines, pageBreakBefore, widowControl } = choice;
  const change: ParagraphFormat = {};
  if (align) change.justification = align === 'justify' ? 'both' : align;
  if (left !== undefined || right !== undefined || special) {
    const indent = { ...props.indent };
    if (left !== undefined) indent.left = left;
    if (right !== undefined) indent.right = right;
    if (special) {
      delete indent.firstLine;
      delete indent.hanging;
      if (special === 'firstLine') indent.firstLine = by ?? 0;
      else if (special === 'hanging') indent.hanging = by ?? 0;
    }
    change.indent = indent;
  }
  if (before !== undefined || after !== undefined || line !== undefined) {
    const spacing = { ...props.spacing };
    if (before !== undefined) spacing.before = before;
    if (after !== undefined) spacing.after = after;
    if (line !== undefined) {
      spacing.line = line;
      spacing.lineRule = lineRule ?? 'auto';
    }
    change.spacing = spacing;
  }
  if (keepNext !== undefined) change.keepNext = keepNext;
  if (keepLines !== undefined) change.keepLines = keepLines;
  if (pageBreakBefore !== undefined) change.pageBreakBefore = pageBreakBefore;
  if (widowControl !== undefined) change.widowControl = widowControl;
  return change;
}

/** A paragraph's resolved properties as the Paragraph dialog shows them. */
export function paragraphChoiceOf(props: ParagraphProperties): ParagraphChoice {
  const { indent, spacing, justification } = props;
  const hanging = indent?.hanging ?? 0;
  const firstLine = indent?.firstLine ?? 0;
  return {
    align: justification === 'center' ? 'center' : justification === 'right' || justification === 'end' ? 'right' : justification === 'both' || justification === 'distribute' ? 'justify' : 'left',
    left: indent?.left ?? indent?.start ?? 0,
    right: indent?.right ?? indent?.end ?? 0,
    special: hanging ? 'hanging' : firstLine ? 'firstLine' : 'none',
    by: hanging || firstLine,
    before: spacing?.before ?? 0,
    after: spacing?.after ?? 0,
    line: spacing?.line ?? 240,
    lineRule: spacing?.lineRule ?? 'auto',
    keepNext: !!props.keepNext,
    keepLines: !!props.keepLines,
    pageBreakBefore: !!props.pageBreakBefore,
    widowControl: props.widowControl !== false,
  };
}

// --- Borders and shading ---------------------------------------------------------------------

const showing = (b: Border | undefined): boolean => !!b?.val && b.val !== 'nil' && b.val !== 'none';

export function bordersOf(props: ParagraphProperties): BordersChoice {
  const out: BordersChoice = { shading: props.shading?.fill && props.shading.fill !== 'auto' ? `#${props.shading.fill.toUpperCase()}` : null };
  for (const side of BORDER_SIDES) {
    const b = props.borders?.[side];
    out[side] = showing(b) ? { style: b!.val!, width: b!.sz ?? 4, color: b!.color && b!.color !== 'auto' ? `#${b!.color.toUpperCase()}` : null, space: b!.space ?? (side === 'top' || side === 'bottom' ? 1 : 4) } : null;
  }
  return out;
}

/** The paragraph's own borders and shading for a choice, over what its style gives (`base`). A side turned off over a style's says so. */
export function bordersFormat(own: ParagraphProperties, base: ParagraphProperties, choice: BordersChoice): ParagraphFormat {
  const borders = { ...own.borders };
  for (const side of BORDER_SIDES) {
    const wanted = choice[side];
    if (wanted === undefined) continue;
    if (wanted) borders[side] = { val: wanted.style, sz: wanted.width, space: wanted.space, color: wanted.color ? wanted.color.replace('#', '').toUpperCase() : 'auto' };
    else if (showing(base.borders?.[side])) borders[side] = { val: 'nil' };
    else delete borders[side];
  }
  const change: ParagraphFormat = { borders: Object.keys(borders).length ? borders : undefined };
  if (choice.shading !== undefined) {
    const inBase = !!base.shading?.fill && base.shading.fill !== 'auto';
    change.shading = choice.shading ? { val: 'clear', color: 'auto', fill: choice.shading.replace('#', '').toUpperCase() } : inBase ? { val: 'clear', color: 'auto', fill: 'auto' } : undefined;
  }
  return change;
}

/** One border side as the dialog's sample draws it. */
export const sameSide = (a: BorderSide | null | undefined, b: BorderSide | null | undefined): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// --- Tabs ------------------------------------------------------------------------------------

const tabAlign = (val: TabStop['val']): TabChoice['align'] => (val === 'center' || val === 'right' || val === 'decimal' ? val : val === 'end' ? 'right' : 'left');
const tabLeader = (leader: TabStop['leader']): TabChoice['leader'] => (leader === 'dot' || leader === 'hyphen' || leader === 'underscore' ? leader : leader === 'heavy' ? 'underscore' : leader === 'middleDot' ? 'dot' : 'none');

/** The tab stops that apply, in order. */
export function tabsOf(props: ParagraphProperties): TabChoice[] {
  return (props.tabs ?? [])
    .filter((tab) => tab.pos !== undefined && tab.val !== 'clear' && tab.val !== 'bar' && tab.val !== 'num')
    .map((tab) => ({ pos: tab.pos!, align: tabAlign(tab.val), leader: tabLeader(tab.leader) }))
    .sort((a, b) => a.pos - b.pos);
}

/** The paragraph's own tab stops to end up with `tabs`, over its style's: what the style gives isn't repeated, and one taken away says so. */
export function tabsFormat(base: ParagraphProperties, tabs: readonly TabChoice[]): TabStop[] | undefined {
  const inherited = tabsOf(base);
  const same = (a: TabChoice, b: TabChoice) => a.pos === b.pos && a.align === b.align && a.leader === b.leader;
  const own: TabStop[] = tabs.filter((tab) => !inherited.some((i) => same(i, tab))).map((tab) => ({ val: tab.align, pos: tab.pos, ...(tab.leader !== 'none' && { leader: tab.leader }) }));
  for (const tab of inherited) if (!tabs.some((t) => t.pos === tab.pos)) own.push({ val: 'clear', pos: tab.pos });
  own.sort((a, b) => a.pos! - b.pos!);
  return own.length ? own : undefined;
}

// --- Lists -----------------------------------------------------------------------------------

export function listFormatOf(level: NumberingLevel | undefined): ListFormat | null {
  if (!level || level.format === 'none') return null;
  const indent = level.paragraphProperties?.indent;
  const base = { level: level.level, start: level.start ?? 1, left: indent?.left ?? indent?.start ?? 720, hanging: indent?.hanging ?? 360 };
  return level.format === 'bullet' ? { kind: 'bullet', glyph: level.text ?? '•', ...base } : { kind: 'number', format: level.format ?? 'decimal', pattern: level.text ?? '%1.', ...base };
}

/** Level `level` of a list made to this format. */
export function withListFormat(level: NumberingLevel, list: ListFormat): NumberingLevel {
  const indent = { ...level.paragraphProperties?.indent, ...(list.left !== undefined && { left: list.left }), ...(list.hanging !== undefined && { hanging: list.hanging }) };
  return {
    ...level,
    start: list.start ?? level.start ?? 1,
    format: list.kind === 'bullet' ? 'bullet' : (list.format ?? 'decimal'),
    text: list.kind === 'bullet' ? (list.glyph ?? '•') : (list.pattern ?? `%${level.level + 1}.`),
    paragraphProperties: { ...level.paragraphProperties, indent },
  };
}

// --- Styles ----------------------------------------------------------------------------------

const hasFlag = (style: Style, name: string): boolean => (style.extra ?? []).some((e) => e.xml.name === name);

function styleInfo(style: Style, resolver: StyleResolver, defined: boolean): StyleInfo {
  const paragraph = style.type === 'paragraph' ? resolver.paragraph({ style: style.id }) : resolver.paragraph({});
  const run = style.type === 'paragraph' ? resolver.run(style.id, {}) : resolver.run(undefined, { style: style.id });
  return {
    id: style.id,
    name: style.name ? style.name.charAt(0).toUpperCase() + style.name.slice(1) : style.id,
    type: style.type === 'character' ? 'character' : 'paragraph',
    basedOn: style.basedOn,
    next: style.next,
    custom: !!style.customStyle,
    isDefault: !!style.isDefault,
    defined,
    font: fontOf(run, resolver.font(run.fonts)),
    paragraph: paragraphChoiceOf(paragraph),
    borders: bordersOf(paragraph),
    tabs: tabsOf(paragraph),
  };
}

/** The styles a person can pick: the document's, then what the style box offers that the document doesn't have yet (`builtIn`). */
export function stylesOf(sheet: { styles: readonly Style[] }, resolver: StyleResolver, builtIn: readonly Style[]): StyleInfo[] {
  const usable = sheet.styles.filter((s) => (s.type === 'paragraph' || s.type === 'character') && !hasFlag(s, 'w:semiHidden') && !hasFlag(s, 'w:hidden'));
  const names = new Set(usable.map((s) => (s.name ?? s.id).toLowerCase().replace(/\s+/g, '')));
  const missing = builtIn.filter((s) => !names.has((s.name ?? s.id).toLowerCase().replace(/\s+/g, '')));
  return [...usable.map((s) => styleInfo(s, resolver, true)), ...missing.map((s) => styleInfo(s, new StyleResolver({ ...sheetOf(sheet), styles: [...sheet.styles, s] }, undefined, undefined), false))].sort((a, b) => a.name.localeCompare(b.name));
}

const sheetOf = (sheet: { styles: readonly Style[] }) => sheet as unknown as ConstructorParameters<typeof StyleResolver>[0];

/** A new style's id, from its name. */
export function styleIdFor(name: string, taken: ReadonlySet<string>): string {
  const base = name.replace(/[^\p{L}\p{N}]/gu, '') || 'Style';
  let id = base;
  for (let n = 1; taken.has(id); n++) id = `${base}${n}`;
  return id;
}

/** A style with an edit made to it. Only what the edit changes is stored (the dialog sends only what was changed). */
export function editedStyle(existing: Style | undefined, edit: StyleEdit, id: string, resolver: StyleResolver): Style {
  const style: Style = existing ? structuredClone(existing) : { type: edit.type, id, name: edit.name, customStyle: true, attrs: {} };
  style.name = edit.name;
  if (edit.basedOn !== undefined) {
    if (edit.basedOn) style.basedOn = edit.basedOn;
    else delete style.basedOn;
  }
  if (edit.next !== undefined) {
    if (edit.next) style.next = edit.next;
    else delete style.next;
  }
  const baseRun = edit.type === 'paragraph' ? resolver.run(style.basedOn, {}) : resolver.run(undefined, style.basedOn ? { style: style.basedOn } : {});
  const basePara = edit.type === 'paragraph' ? resolver.paragraph(style.basedOn ? { style: style.basedOn } : {}) : {};
  if (edit.font) {
    const run = withFormat(style.runProperties ?? {}, fontFormat(edit.font, baseRun, style.runProperties));
    if (Object.keys(run).length) style.runProperties = run;
    else delete style.runProperties;
  }
  if (edit.type === 'paragraph') {
    const props: ParagraphProperties = { ...style.paragraphProperties };
    const apply = (change: ParagraphFormat) => {
      for (const [key, value] of Object.entries(change)) {
        if (value === undefined) delete (props as Record<string, unknown>)[key];
        else (props as Record<string, unknown>)[key] = value;
      }
    };
    if (edit.paragraph) apply(paragraphFormat(props, edit.paragraph));
    if (edit.borders) apply(bordersFormat(props, basePara, edit.borders));
    if (edit.tabs) apply({ tabs: tabsFormat(basePara, edit.tabs) });
    if (Object.keys(props).length) style.paragraphProperties = props;
    else delete style.paragraphProperties;
  }
  return style;
}

// --- What the dialogs ask the worker for -----------------------------------------------------

const BOOKMARK_TEXT = 40;

/** The text a bookmark is on, or the start of its paragraph, to tell it from the others. */
function bookmarkText(paragraph: Paragraph, from: number, to: number): string {
  let out = '';
  let at = 0;
  const walk = (inlines: Paragraph['children']) => {
    for (const inline of inlines) {
      if (inline.kind === 'raw') at++;
      else if (inline.kind === 'run') {
        for (const item of inline.content) {
          if (item.kind === 'text') {
            const a = Math.max(from - at, 0);
            const b = to - at;
            if (b > a) out += item.text.slice(a, b);
            at += item.text.length;
          } else at++;
        }
      } else walk(inline.children);
    }
  };
  walk(paragraph.children);
  return out;
}

export function bookmarksOf(paragraphs: readonly Paragraph[]): DocumentInfo['bookmarks'] {
  return bookmarkRanges(paragraphs).map((range) => {
    const same = range.start.paragraph === range.end.paragraph && range.end.offset > range.start.offset;
    const text = same ? bookmarkText(range.start.paragraph, range.start.offset, range.end.offset) : bookmarkText(range.start.paragraph, range.start.offset, paragraphLength(range.start.paragraph));
    return { name: range.name, text: text.trim().slice(0, BOOKMARK_TEXT) };
  });
}
