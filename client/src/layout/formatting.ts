// Formatting from the menus and toolbars (bold, fonts, alignment, lists…) as editor commands.
//
// The chrome's actions say what the user wants ("make it bold", "Heading 1"); what that means
// depends on the document: whether the style already makes the text bold (then turning bold
// off has to say so), whether the document has a Heading 1 style yet (else one is added),
// which list to continue. This works that out against the open document and the formatting
// at the selection, and hands the editor commands it can apply as one undoable step.

import { paragraphLength, StyleResolver, type AbstractNumbering, type NumberingLevel, type Paragraph, type RunProperties, type Style, type WordDocument } from '@golemdocs/docx';
import type { Command, Editor, ParagraphFormat, TableEdit } from '@golemdocs/editor';
import type { Operation, RunFormat } from '@golemdocs/ops';
import { styleFor, TASK_GLYPHS } from '../formats/markdownStyles.ts';
import type { Action, CaseChange, FormatState, Mark } from '../ui/actions.ts';

/** The actions that change formatting (the worker applies these; see WireCommand). */
export type FormatAction = Extract<
  Action,
  {
    kind:
      | 'toggleMark'
      | 'setFont'
      | 'setFontSize'
      | 'growFont'
      | 'shrinkFont'
      | 'setColor'
      | 'setHighlight'
      | 'changeCase'
      | 'clearFormatting'
      | 'insertTable'
      | 'insertHorizontalRule'
      | 'insertCodeBlock'
      | 'table'
      | 'formatPainter'
      | 'setStyle'
      | 'setAlignment'
      | 'setLineSpacing'
      | 'setParagraph'
      | 'toggleList'
      | 'indent';
  }
>;

export const FORMAT_ACTIONS = new Set<FormatAction['kind']>([
  'toggleMark',
  'setFont',
  'setFontSize',
  'growFont',
  'shrinkFont',
  'setColor',
  'setHighlight',
  'changeCase',
  'clearFormatting',
  'insertTable',
  'insertHorizontalRule',
  'insertCodeBlock',
  'table',
  'formatPainter',
  'setStyle',
  'setAlignment',
  'setLineSpacing',
  'setParagraph',
  'toggleList',
  'indent',
]);

/** Font sizes Grow Font and Shrink Font step through, points (Word's list). */
const SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];
/** Word's size when nothing sets one, half-points. */
const DEFAULT_HALF_POINTS = 20;
/** One indent step, twips (half an inch). */
const INDENT_STEP = 720;
const MONO = 'Courier New';

/** The Table menu's operations the editor can do. */
export const TABLE_EDITS = new Set<string>(['insertRowAbove', 'insertRowBelow', 'insertColumnLeft', 'insertColumnRight', 'deleteRows', 'deleteColumns', 'deleteTable', 'selectTable', 'mergeCells', 'splitCells']);

/** Word's highlight colors by name, as the toolbar's palette shows them. */
const HIGHLIGHT_NAMES: Record<string, string> = {
  FFFF00: 'yellow',
  '00FF00': 'green',
  '00FFFF': 'cyan',
  FF00FF: 'magenta',
  '0000FF': 'blue',
  FF0000: 'red',
  '000080': 'darkBlue',
  '008080': 'darkCyan',
  '008000': 'darkGreen',
  '800080': 'darkMagenta',
  '800000': 'darkRed',
  '808000': 'darkYellow',
  '808080': 'darkGray',
  C0C0C0: 'lightGray',
  '000000': 'black',
  FFFFFF: 'white',
};

/** The nearest of Word's highlight colors to a CSS #rrggbb color. */
export function highlightName(color: string): string {
  const hex = color.replace('#', '').toUpperCase();
  if (HIGHLIGHT_NAMES[hex]) return HIGHLIGHT_NAMES[hex];
  const rgb = (h: string) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [r, g, b] = rgb(hex);
  let best = 'yellow';
  let bestDistance = Infinity;
  for (const [key, name] of Object.entries(HIGHLIGHT_NAMES)) {
    const [r2, g2, b2] = rgb(key);
    const distance = (r - r2) ** 2 + (g - g2) ** 2 + (b - b2) ** 2;
    if (distance < bestDistance) {
      best = name;
      bestDistance = distance;
    }
  }
  return best;
}

/** How each mark is stored in run properties. */
const MARK_KEYS: Record<Mark, (keyof RunProperties)[]> = {
  bold: ['bold', 'boldCs'],
  italic: ['italic', 'italicCs'],
  underline: ['underline'],
  strikethrough: ['strike', 'doubleStrike'],
  superscript: ['vertAlign'],
  subscript: ['vertAlign'],
  code: ['style', 'fonts'],
};

function markOn(mark: Mark, props: RunProperties): boolean {
  switch (mark) {
    case 'bold':
      return !!props.bold;
    case 'italic':
      return !!props.italic;
    case 'underline':
      return !!props.underline?.val && props.underline.val !== 'none';
    case 'strikethrough':
      return !!(props.strike || props.doubleStrike);
    case 'superscript':
      return props.vertAlign === 'superscript';
    case 'subscript':
      return props.vertAlign === 'subscript';
    case 'code':
      return isCode(props);
  }
}

export const isCode = (props: RunProperties): boolean =>
  props.style === 'InlineCode' || /courier|consolas|mono|menlo|monaco|source code|lucida console/i.test(props.fonts?.ascii ?? '');

/** The formatting that turns a mark on. */
function markFormat(mark: Mark): RunFormat {
  switch (mark) {
    case 'bold':
      return { bold: true };
    case 'italic':
      return { italic: true };
    case 'underline':
      return { underline: { val: 'single' } };
    case 'strikethrough':
      return { strike: true, doubleStrike: null };
    case 'superscript':
      return { vertAlign: 'superscript' };
    case 'subscript':
      return { vertAlign: 'subscript' };
    case 'code':
      return { style: 'InlineCode', fonts: { ascii: MONO, hAnsi: MONO, eastAsia: MONO, cs: MONO } };
  }
}

/** The formatting that turns a mark off, when the style underneath would still show it. */
function markOffOverStyle(mark: Mark): RunFormat {
  switch (mark) {
    case 'bold':
      return { bold: false };
    case 'italic':
      return { italic: false };
    case 'underline':
      return { underline: { val: 'none' } };
    case 'strikethrough':
      return { strike: false, doubleStrike: null };
    case 'superscript':
    case 'subscript':
      return { vertAlign: 'baseline' };
    case 'code':
      return { style: null, fonts: null };
  }
}

/** A Word style name as the style box shows it ("Heading 1"), to the document's style, if it has one. */
function findStyle(doc: WordDocument, name: string): Style | undefined {
  const key = name.toLowerCase().replace(/\s+/g, '');
  return doc.styles.styles.find((s) => s.type === 'paragraph' && ((s.name ?? '').toLowerCase().replace(/\s+/g, '') === key || s.id.toLowerCase() === key));
}

/** Definitions for the built-in styles the style box offers, for documents that lack them. */
function builtInStyle(name: string): Style | undefined {
  const id = name.replace(/\s+/g, '');
  const known = styleFor(id);
  if (known) return known;
  const light = { ascii: 'Calibri Light', hAnsi: 'Calibri Light', eastAsia: 'Calibri Light', cs: 'Times New Roman' };
  switch (id) {
    case 'Normal':
      return { type: 'paragraph', id, name: 'Normal', isDefault: true, attrs: {} };
    case 'NoSpacing':
      return { type: 'paragraph', id, name: 'No Spacing', basedOn: 'Normal', paragraphProperties: { spacing: { after: 0, line: 240, lineRule: 'auto' } }, attrs: {} };
    case 'Title':
      return {
        type: 'paragraph',
        id,
        name: 'Title',
        basedOn: 'Normal',
        next: 'Normal',
        paragraphProperties: { spacing: { after: 0, line: 240, lineRule: 'auto' }, contextualSpacing: true },
        runProperties: { fonts: light, kern: 28, size: 56, sizeCs: 56 },
        attrs: {},
      };
    case 'Subtitle':
      return {
        type: 'paragraph',
        id,
        name: 'Subtitle',
        basedOn: 'Normal',
        next: 'Normal',
        runProperties: { color: { val: '5A5A5A' }, spacing: 15, size: 22, sizeCs: 22 },
        attrs: {},
      };
    case 'IntenseQuote':
      return {
        type: 'paragraph',
        id,
        name: 'Intense Quote',
        basedOn: 'Normal',
        next: 'Normal',
        paragraphProperties: {
          spacing: { before: 360, after: 360 },
          indent: { left: 864, right: 864 },
          justification: 'center',
          borders: { top: { val: 'single', sz: 4, space: 10, color: '4472C4' }, bottom: { val: 'single', sz: 4, space: 10, color: '4472C4' } },
        },
        runProperties: { italic: true, color: { val: '4472C4' } },
        attrs: {},
      };
  }
  return undefined;
}

/** Nine list levels, all bullets or all numbers, indented half an inch per level. */
const GLYPHS: readonly string[] = Object.values(TASK_GLYPHS);

function listLevels(bullet: boolean, glyph?: string): NumberingLevel[] {
  const bullets = ['•', 'o', '▪'];
  const formats = ['decimal', 'lowerLetter', 'lowerRoman'];
  const levels: NumberingLevel[] = [];
  for (let l = 0; l < 9; l++) {
    levels.push({
      level: l,
      start: 1,
      format: bullet ? 'bullet' : formats[l % 3],
      suffix: 'tab',
      text: bullet ? (glyph ?? bullets[l % 3]) : `%${l + 1}.`,
      justification: 'left',
      paragraphProperties: { indent: { left: INDENT_STEP * (l + 1), hanging: 360 } },
      attrs: {},
    });
  }
  return levels;
}

function changeCase(text: string, to: CaseChange): string {
  // Only changes that keep each character one UTF-16 unit are made (positions stay put).
  // `chars` are code points (a surrogate pair is one), so `chars[i - 1]` is the one before, even after an emoji.
  const chars = [...text];
  const each = (fn: (c: string, i: number) => string) => chars.map((c, i) => { const d = fn(c, i); return d.length === c.length ? d : c; }).join('');
  switch (to) {
    case 'upper':
      return each((c) => c.toUpperCase());
    case 'lower':
      return each((c) => c.toLowerCase());
    case 'toggle':
      return each((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()));
    case 'title':
      return each((c, i) => (i === 0 || /[\s\-–—(["'“]/.test(chars[i - 1]) ? c.toUpperCase() : c.toLowerCase()));
    case 'sentence': {
      let start = true;
      return each((c) => {
        const out = start && /\p{L}/u.test(c) ? c.toUpperCase() : c.toLowerCase();
        if (/\p{L}|\p{N}/u.test(c)) start = false;
        else if (/[.!?]/.test(c)) start = true;
        return out;
      });
    }
  }
}

/**
 * The editor command for a formatting action, or null if there's nothing to do. `format` is
 * the formatting at the selection (for toggles); `fonts` collects fonts it starts using.
 */
export function formatCommand(action: FormatAction, editor: Editor, format: FormatState, fonts: Set<string>): Command | null {
  const doc = editor.doc;
  const styles = new StyleResolver(doc.styles, doc.theme, doc.numbering);
  /** What a run looks like with its direct formatting and its paragraph's style. */
  const resolved = (run: RunProperties, p: Paragraph) => styles.run(styles.paragraph(p.properties).style, run);
  /** A run's look from its style alone (without the given direct properties). */
  const fromStyle = (run: RunProperties, p: Paragraph, keys: (keyof RunProperties)[]) => {
    const rest = { ...run };
    for (const key of keys) delete rest[key];
    return resolved(rest, p);
  };

  switch (action.kind) {
    case 'toggleMark': {
      const { mark } = action;
      const on = !format.marks?.[mark];
      if (mark === 'code') {
        const define = defineStyle(doc, 'InlineCode');
        if (on) fonts.add(MONO);
        return { kind: 'formatText', format: on ? markFormat('code') : { style: null, fonts: null }, define };
      }
      const keys = MARK_KEYS[mark];
      return {
        kind: 'formatText',
        format: (run, p) => {
          if (on) return markFormat(mark);
          const clear: RunFormat = Object.fromEntries(keys.map((k) => [k, null]));
          return markOn(mark, fromStyle(run, p, keys)) ? markOffOverStyle(mark) : clear;
        },
      };
    }
    case 'setFont': {
      const f = action.family;
      fonts.add(f);
      return { kind: 'formatText', format: { fonts: { ascii: f, hAnsi: f, eastAsia: f, cs: f } } };
    }
    case 'setFontSize': {
      const size = Math.round(Math.min(Math.max(action.points, 1), 1638) * 2);
      return { kind: 'formatText', format: { size, sizeCs: size } };
    }
    case 'growFont':
    case 'shrinkFont': {
      const grow = action.kind === 'growFont';
      return {
        kind: 'formatText',
        format: (run, p) => {
          const points = (resolved(run, p).size ?? DEFAULT_HALF_POINTS) / 2;
          const next = grow ? (SIZES.find((s) => s > points) ?? Math.min(Math.ceil(points / 10) * 10 + 10, 1638)) : ([...SIZES].reverse().find((s) => s < points) ?? Math.max(Math.floor(points) - 1, 1));
          return { size: Math.round(next * 2), sizeCs: Math.round(next * 2) };
        },
      };
    }
    case 'setColor': {
      const { color } = action;
      if (color) return { kind: 'formatText', format: { color: { val: color.replace('#', '').toUpperCase() } } };
      // Automatic: over a style's color, say so; otherwise just drop the direct color.
      return { kind: 'formatText', format: (run, p) => (fromStyle(run, p, ['color']).color?.val && fromStyle(run, p, ['color']).color?.val !== 'auto' ? { color: { val: 'auto' } } : { color: null }) };
    }
    case 'setHighlight':
      return { kind: 'formatText', format: { highlight: action.color ? highlightName(action.color) : null } };
    case 'changeCase': {
      const to = action.to;
      return { kind: 'changeCase', change: (text) => changeCase(text, to) };
    }
    case 'clearFormatting':
      // Character formatting goes; links keep their look.
      return {
        kind: 'formatText',
        format: (run) => {
          const keys = Object.keys(run).filter((k) => !(k === 'style' && run.style === 'Hyperlink'));
          return keys.length ? Object.fromEntries(keys.map((k) => [k, null])) : null;
        },
      };
    case 'insertTable':
      return action.rows && action.columns ? { kind: 'insertTable', rows: action.rows, columns: action.columns, define: defineStyle(doc, 'TableGrid') } : null;
    case 'insertHorizontalRule': {
      // A rule is an empty paragraph with a bottom border (what Markdown, HTML and the other formats read and write as one).
      const rule: Paragraph = { kind: 'paragraph', properties: { borders: { bottom: { val: 'single', sz: 6, space: 1, color: 'A6A6A6' } } }, children: [], attrs: {} };
      const plain = (): Paragraph => ({ kind: 'paragraph', properties: {}, children: [], attrs: {} });
      const border = { bottom: { val: 'single' as const, sz: 6, space: 1, color: 'A6A6A6' } };
      const [, caret] = editor.ordered();
      const list = editor.paragraphs();
      const last = list[list.length - 1] === caret.paragraph;
      const length = paragraphLength(caret.paragraph);
      // An empty paragraph becomes the rule (with a new one after it if it was the last); otherwise the rule goes after the text before the caret, and the text after it follows.
      if (length === 0 && !last) return { kind: 'formatParagraphs', change: () => ({ borders: border }) };
      if (length === 0) return { kind: 'pasteContent', blocks: [rule, plain()] };
      return { kind: 'pasteContent', blocks: caret.offset < length || last ? [plain(), rule, plain()] : [plain(), rule] };
    }
    case 'insertCodeBlock':
      // The selected paragraphs become code (or, if they all are, plain text again).
      return formatCommand({ kind: 'setStyle', style: format.style === 'Code' ? 'Normal' : 'Code' }, editor, format, fonts);
    case 'table':
      // Table Properties isn't there yet.
      if (action.op === 'splitCells') return action.columns && action.rows ? { kind: 'splitCells', columns: action.columns, rows: action.rows } : null;
      return TABLE_EDITS.has(action.op) ? { kind: 'tableEdit', edit: action.op as TableEdit } : null;
    // Handled by the worker, which holds what was picked up (see OpenDocument.applyPainter).
    case 'formatPainter':
      return null;
    case 'setStyle': {
      const existing = findStyle(doc, action.style);
      const define: Operation[] = [];
      let id = existing?.id;
      if (!existing) {
        const style = builtInStyle(action.style);
        if (!style) return null;
        id = style.id;
        define.push({ type: 'setStyle', id: style.id, style });
        for (const run of [style.runProperties, style.paragraphProperties?.runProperties]) if (run?.fonts?.ascii) fonts.add(run.fonts.ascii);
        if (style.basedOn) define.push(...defineStyle(doc, style.basedOn));
      }
      const normal = styles.chain(undefined, 'paragraph')[0];
      const value = normal && normal.id === id ? undefined : id;
      return { kind: 'formatParagraphs', define, change: (p) => (p.properties.style === value ? null : { style: value }) };
    }
    case 'setAlignment': {
      const justification = action.align === 'justify' ? 'both' : action.align;
      return { kind: 'formatParagraphs', change: (p) => (p.properties.justification === justification ? null : { justification }) };
    }
    case 'setLineSpacing': {
      const line = Math.round(action.lines * 240);
      return { kind: 'formatParagraphs', change: (p) => ({ spacing: { ...p.properties.spacing, line, lineRule: 'auto' } }) };
    }
    case 'setParagraph': {
      const { kind: _kind, align, left, right, special, by, before, after, line, lineRule, ...flags } = action;
      return {
        kind: 'formatParagraphs',
        change: (p) => {
          const change: ParagraphFormat = {};
          if (align) change.justification = align === 'justify' ? 'both' : align;
          if (left !== undefined || right !== undefined || special) {
            const indent = { ...p.properties.indent };
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
            const spacing = { ...p.properties.spacing };
            if (before !== undefined) spacing.before = before;
            if (after !== undefined) spacing.after = after;
            if (line !== undefined) {
              spacing.line = line;
              spacing.lineRule = lineRule ?? 'auto';
            }
            change.spacing = spacing;
          }
          for (const key of ['keepNext', 'keepLines', 'pageBreakBefore', 'widowControl'] as const) if (flags[key] !== undefined) change[key] = flags[key];
          return change;
        },
      };
    }
    case 'indent': {
      const increase = action.direction === 'increase';
      return {
        kind: 'formatParagraphs',
        change: (p) => {
          const numbering = p.properties.numbering;
          if (numbering?.id) {
            // A list item moves a level in or out.
            const level = Math.min(Math.max((numbering.level ?? 0) + (increase ? 1 : -1), 0), 8);
            return level === (numbering.level ?? 0) ? null : { numbering: { ...numbering, level } };
          }
          const current = styles.paragraph(p.properties).indent?.left ?? 0;
          const left = increase ? (Math.floor(current / INDENT_STEP) + 1) * INDENT_STEP : Math.max(Math.ceil(current / INDENT_STEP) - 1, 0) * INDENT_STEP;
          return left === current ? null : { indent: { ...p.properties.indent, left } };
        },
      };
    }
    case 'toggleList':
      if (action.list === 'task' || action.list === 'taskDone') return listCommand(true, !action.force && format.list === 'task', editor, styles, TASK_GLYPHS[action.list]);
      return listCommand(action.list === 'bullet', format.list === action.list, editor, styles);
  }
}

/** Operations adding a style the document doesn't have yet (and the styles it's based on). */
function defineStyle(doc: WordDocument, id: string): Operation[] {
  if (doc.styles.styles.some((s) => s.id === id)) return [];
  const style = styleFor(id) ?? builtInStyle(id);
  if (!style) return [];
  return [...(style.basedOn ? defineStyle(doc, style.basedOn) : []), { type: 'setStyle', id, style }];
}

/** The numbering instance whose first level's bullet is `glyph`, if the document has one. */
function existingList(doc: WordDocument, glyph: string): number | undefined {
  const abstract = doc.numbering.abstracts.find((a) => a.levels[0]?.format === 'bullet' && a.levels[0].text === glyph);
  return abstract && doc.numbering.instances.find((n) => n.abstractId === abstract.id)?.id;
}

/** Bullets or numbering on the selected paragraphs, or off if they already have them. */
function listCommand(bullet: boolean, off: boolean, editor: Editor, styles: StyleResolver, glyph?: string): Command {
  const doc = editor.doc;
  const isList = (p: Paragraph | undefined) => {
    const id = p?.properties.numbering?.id;
    const level = id ? styles.listLevel(id, p!.properties.numbering?.level ?? 0) : undefined;
    return !!level && level.format !== 'none' && (level.format === 'bullet') === bullet && (glyph ? level.text === glyph : !GLYPHS.includes(level.text ?? ''));
  };
  if (off) {
    return {
      kind: 'formatParagraphs',
      change: (p) => ({ numbering: styles.paragraph({ style: p.properties.style }).numbering?.id ? { id: 0 } : undefined, ...(p.properties.style === 'ListParagraph' && { style: undefined }) }),
    };
  }
  // Right after a list of the same kind: continue it. Otherwise start a new one.
  const selected = editor.selectedParagraphs();
  const all = editor.paragraphs();
  const before = all[all.indexOf(selected[0]) - 1];
  const define: Operation[] = [];
  let id: number;
  // One list of check boxes of each kind serves the whole document (bullets are not counted).
  const reuse = isList(before) ? before.properties.numbering!.id! : glyph ? existingList(doc, glyph) : undefined;
  if (reuse !== undefined) id = reuse;
  else {
    const taken = new Set([...doc.numbering.instances.map((n) => n.id), ...doc.numbering.abstracts.map((a) => a.id)]);
    // Random, so two people starting lists at once don't collide.
    do id = 1000 + Math.floor(Math.random() * 1_000_000);
    while (taken.has(id));
    const abstract: AbstractNumbering = { id, multiLevelType: 'hybridMultilevel', levels: listLevels(bullet, glyph), attrs: {} };
    define.push({ type: 'setList', id, list: { instance: { id, abstractId: id, overrides: [], attrs: {} }, abstract } });
  }
  define.push(...defineStyle(doc, 'ListParagraph'));
  return {
    kind: 'formatParagraphs',
    define,
    change: (p) => ({
      numbering: { id, level: p.properties.numbering?.id ? (p.properties.numbering.level ?? 0) : 0 },
      ...(!p.properties.style && { style: 'ListParagraph' }),
    }),
  };
}
