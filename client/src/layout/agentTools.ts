// The tools the assistant edits a document with (their descriptions are in server/src/assistantTools.ts;
// names and arguments must match). They run in the layout worker against the open document, and
// change it only through the same editor commands typing and the menus use, so every change can be
// undone, laid out and shared with a collaboration room like any other.
//
// Each tool answers with text for the model: what it found or did, or why it couldn't. Paragraphs
// are numbered from 0 in document order, as `Editor.paragraphs()` has them.

import { mathInline, OBJECT_CHAR, paragraphLength, paragraphText, parseLatex, type DocumentProperties, type Inline, type Paragraph } from '@golemdocs/docx';
import { pictureForModel } from '../formats/imageForModel.ts';
import { sniffImage } from '../formats/images.ts';
import type { FormatState, Mark, TableOp } from '../ui/actions.ts';
import type { WireCommand } from './protocol.ts';

/** The part of the editor the tools read. */
export interface AgentEditor {
  paragraphs(): Paragraph[];
  ordered(): [{ paragraph: Paragraph; offset: number }, { paragraph: Paragraph; offset: number }];
  selectedText(limit?: number): string;
  /** The selection is in a table. */
  inTable(): boolean;
  /** The page setup of the section the selection is in (twips). */
  sectionPage(): SectionPage;
  /** Every comment and reply, in order. */
  comments(): { id: string; author: string; text: string; parentId?: string; resolved?: boolean }[];
  doc: { properties: DocumentProperties; /** The bytes of a package part (a picture). */ media(part: string): Promise<Uint8Array> };
}

export interface SectionPage {
  width: number;
  height: number;
  landscape: boolean;
  top: number;
  bottom: number;
  left: number;
  right: number;
  gutter: number;
  header: number;
  footer: number;
}

export interface AgentEnv {
  editor: AgentEditor;
  /** The document can't be edited (opened read-only, or shown as a PDF). */
  readOnly: boolean;
  /** Applies a command and settles once it has taken effect (fonts loaded, layout started). */
  run(command: WireCommand): Promise<void>;
  /** The formatting at the selection. */
  format(): FormatState;
  /** Hands the model pictures to look at (data: URIs); they reach it after the tool's answer. */
  show(images: string[]): void;
}

/** The most a reading tool returns, in characters, so one call can't fill the conversation. */
export const MAX_READ_CHARS = 8000;
const MAX_MATCHES = 20;
const AUTHOR = 'Clip';

class ToolError extends Error {}

type TableAction = Extract<Extract<WireCommand, { kind: 'format' }>['action'], { kind: 'table' }>;

const object = (v: unknown, what: string): Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new ToolError(`${what} must be an object`);
  return v as Record<string, unknown>;
};
const text = (args: Record<string, unknown>, key: string, required = true): string => {
  const v = args[key];
  if (typeof v === 'string') return v;
  if (v === undefined && !required) return '';
  throw new ToolError(`\`${key}\` must be text`);
};
const int = (args: Record<string, unknown>, key: string, fallback?: number): number => {
  const v = args[key];
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new ToolError(`\`${key}\` must be a whole number`);
  return v;
};
const flag = (args: Record<string, unknown>, key: string): boolean | undefined => {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw new ToolError(`\`${key}\` must be true or false`);
  return v;
};

const shown = (paragraph: Paragraph): string => paragraphText(paragraph).replaceAll(OBJECT_CHAR, '[object]');

/** Where `needle` first appears in `haystack`: exactly, or else ignoring case. -1 if it doesn't. */
const locate = (haystack: string, needle: string, matchCase: boolean): number => (matchCase ? haystack.indexOf(needle) : haystack.toLowerCase().indexOf(needle.toLowerCase()));

/** How many times `needle` appears in `haystack`, not overlapping. */
function count(haystack: string, needle: string, matchCase: boolean): number {
  const h = matchCase ? haystack : haystack.toLowerCase();
  const n = matchCase ? needle : needle.toLowerCase();
  let found = 0;
  for (let at = h.indexOf(n); at !== -1; at = h.indexOf(n, at + n.length)) found++;
  return found;
}

function paragraphAt(env: AgentEnv, args: Record<string, unknown>, key = 'paragraph'): { index: number; paragraph: Paragraph } {
  const list = env.editor.paragraphs();
  const index = int(args, key);
  const paragraph = list[index];
  if (!paragraph) throw new ToolError(`There is no paragraph ${index}; the document has paragraphs 0 to ${list.length - 1}.`);
  return { index, paragraph };
}

const editable = (env: AgentEnv): void => {
  if (env.readOnly) throw new ToolError('This document cannot be edited.');
};

const select = (env: AgentEnv, paragraph: number, from: number, to: number) => env.run({ kind: 'select', paragraph, from, to });

/** Types lines of text at the caret, each after the first in a new paragraph. */
async function type(env: AgentEnv, lines: string[]): Promise<void> {
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) await env.run({ kind: 'insertParagraph' });
    if (lines[i]) await env.run({ kind: 'insertText', text: lines[i]! });
  }
}

const linesOf = (value: string): string[] => value.replace(/\r\n?/g, '\n').split('\n');

/** The style of a paragraph that a new one after it shouldn't inherit. */
const isHeading = (paragraph: Paragraph): boolean => /^(heading|title|subtitle)/i.test(paragraph.properties.style ?? '');

async function readDocument(env: AgentEnv, args: Record<string, unknown>): Promise<string> {
  const list = env.editor.paragraphs();
  const start = Math.max(0, int(args, 'start', 0));
  const wanted = Math.min(100, Math.max(1, int(args, 'count', 40)));
  if (start >= list.length) return `The document has ${list.length} paragraphs (0 to ${list.length - 1}); there is nothing at ${start}.`;
  const out: string[] = [];
  let size = 0;
  let k = start;
  for (; k < Math.min(list.length, start + wanted); k++) {
    const p = list[k]!;
    const line = `[${k}]${p.properties.style ? ` (${p.properties.style})` : ''} ${shown(p)}`;
    // Always return at least one paragraph, however long.
    if (size + line.length > MAX_READ_CHARS && out.length) break;
    out.push(line.length > MAX_READ_CHARS ? `${line.slice(0, MAX_READ_CHARS)}… (cut short)` : line);
    size += line.length;
  }
  const more = k < list.length ? ` More follows: call again with start=${k}.` : '';
  return `Paragraphs ${start} to ${k - 1} of ${list.length}.${more}\n${out.join('\n')}`;
}

function getSelection(env: AgentEnv): string {
  const [start, end] = env.editor.ordered();
  const list = env.editor.paragraphs();
  const from = list.indexOf(start.paragraph);
  const to = list.indexOf(end.paragraph);
  const selected = env.editor.selectedText(MAX_READ_CHARS);
  if (!selected) return `Nothing is selected. The caret is in paragraph ${from}.`;
  return `Selected, in paragraphs ${from} to ${to}:\n${selected.length >= MAX_READ_CHARS ? `${selected.slice(0, MAX_READ_CHARS)}… (cut short)` : selected}`;
}

function findText(env: AgentEnv, args: Record<string, unknown>): string {
  const needle = text(args, 'text');
  if (!needle) throw new ToolError('`text` must not be empty');
  const matchCase = flag(args, 'match_case') ?? false;
  const out: string[] = [];
  let total = 0;
  env.editor.paragraphs().forEach((p, k) => {
    const line = paragraphText(p);
    const h = matchCase ? line : line.toLowerCase();
    const n = matchCase ? needle : needle.toLowerCase();
    for (let at = h.indexOf(n); at !== -1; at = h.indexOf(n, at + n.length)) {
      total++;
      if (out.length < MAX_MATCHES) out.push(`[${k}] …${line.slice(Math.max(0, at - 30), at + needle.length + 30).replaceAll(OBJECT_CHAR, '')}…`);
    }
  });
  if (!total) return 'No matches.';
  return `${total} match${total === 1 ? '' : 'es'}${total > out.length ? ` (first ${out.length} shown)` : ''}:\n${out.join('\n')}`;
}

async function replaceParagraph(env: AgentEnv, args: Record<string, unknown>): Promise<string> {
  editable(env);
  const { index, paragraph } = paragraphAt(env, args);
  const value = text(args, 'text');
  if (paragraphText(paragraph).includes(OBJECT_CHAR)) {
    return `Paragraph ${index} holds a picture, comment or other object that replacing it would destroy. Use replace_text to change its words instead.`;
  }
  await select(env, index, 0, paragraphLength(paragraph));
  if (paragraphLength(paragraph)) await env.run({ kind: 'delete', direction: 'forward' });
  await type(env, linesOf(value));
  return `Replaced paragraph ${index}.`;
}

async function insertParagraph(env: AgentEnv, args: Record<string, unknown>): Promise<string> {
  editable(env);
  const list = env.editor.paragraphs();
  const after = int(args, 'after');
  if (after < -1 || after >= list.length) throw new ToolError(`\`after\` must be from -1 to ${list.length - 1}.`);
  const style = args.style === undefined ? undefined : text(args, 'style');
  const lines = linesOf(text(args, 'text'));
  const previous = after >= 0 ? list[after]! : null;
  if (previous) await select(env, after, paragraphLength(previous), paragraphLength(previous));
  else await select(env, 0, 0, 0);
  await env.run({ kind: 'insertParagraph' });
  // At the very start the new empty paragraph is the one above the caret; go up into it.
  if (!previous) await select(env, 0, 0, 0);
  await type(env, lines);
  const first = after + 1;
  const wantsStyle = style ?? (previous && isHeading(previous) ? 'Normal' : undefined);
  if (wantsStyle) {
    for (let k = 0; k < lines.length; k++) {
      await select(env, first + k, 0, 0);
      await env.run({ kind: 'format', action: { kind: 'setStyle', style: wantsStyle } });
    }
  }
  return `Added ${lines.length === 1 ? 'paragraph' : `${lines.length} paragraphs`} at ${first}${lines.length > 1 ? ` to ${first + lines.length - 1}` : ''}.`;
}

async function deleteParagraph(env: AgentEnv, args: Record<string, unknown>): Promise<string> {
  editable(env);
  const { index, paragraph } = paragraphAt(env, args);
  const before = env.editor.paragraphs().length;
  if (before === 1) {
    await select(env, 0, 0, paragraphLength(paragraph));
    await env.run({ kind: 'delete', direction: 'forward' });
    return 'That was the only paragraph, so it was emptied.';
  }
  await select(env, index, 0, paragraphLength(paragraph));
  if (paragraphLength(paragraph)) await env.run({ kind: 'delete', direction: 'forward' });
  // Now empty: take away its paragraph mark by merging it into its neighbour.
  await env.run({ kind: 'delete', direction: index > 0 ? 'backward' : 'forward' });
  const after = env.editor.paragraphs().length;
  return after < before ? `Deleted paragraph ${index}.` : `Cleared paragraph ${index}, but it could not be removed (it may be in a table).`;
}

async function replaceText(env: AgentEnv, args: Record<string, unknown>): Promise<string> {
  editable(env);
  const find = text(args, 'find');
  if (!find) throw new ToolError('`find` must not be empty');
  const replacement = text(args, 'replace');
  const matchCase = flag(args, 'match_case') ?? false;
  let matches = 0;
  for (const p of env.editor.paragraphs()) matches += count(paragraphText(p), find, matchCase);
  if (!matches) return 'No matches, so nothing was changed.';
  await env.run({ kind: 'replaceAll', text: find, with: replacement, matchCase });
  return `Replaced ${matches} occurrence${matches === 1 ? '' : 's'}.`;
}

async function setStyle(env: AgentEnv, args: Record<string, unknown>): Promise<string> {
  editable(env);
  const { index } = paragraphAt(env, args);
  const style = text(args, 'style').trim();
  if (!style) throw new ToolError('`style` must not be empty');
  await select(env, index, 0, 0);
  await env.run({ kind: 'format', action: { kind: 'setStyle', style } });
  const now = env.format().style;
  return now && now.toLowerCase() === style.toLowerCase() ? `Paragraph ${index} is now ${now}.` : `The style "${style}" is not available${now ? `; the paragraph is still ${now}` : ''}.`;
}

/** Selects `find` in a paragraph (or all of it) and says where. */
async function selectRange(env: AgentEnv, index: number, paragraph: Paragraph, find: string | undefined): Promise<string | null> {
  const line = paragraphText(paragraph);
  if (find) {
    let at = locate(line, find, true);
    if (at === -1) at = locate(line, find, false);
    if (at === -1) return `"${find}" does not appear in paragraph ${index}.`;
    await select(env, index, at, at + find.length);
  } else {
    if (!paragraphLength(paragraph)) return `Paragraph ${index} is empty.`;
    await select(env, index, 0, paragraphLength(paragraph));
  }
  return null;
}

const MARKS: Mark[] = ['bold', 'italic', 'underline', 'strikethrough', 'superscript', 'subscript', 'code'];

/** A CSS color, as the formatting commands take it (#rrggbb). */
function colorOf(value: string): string {
  const hex = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  if (!hex) throw new ToolError(`"${value}" is not a color; use a hex code like #1f4e79.`);
  return `#${hex[1]!.toLowerCase()}`;
}

async function formatText(env: AgentEnv, args: Record<string, unknown>): Promise<string> {
  editable(env);
  const { index, paragraph } = paragraphAt(env, args);
  const find = args.find === undefined ? undefined : text(args, 'find');
  const marks = MARKS.map((mark): [Mark, boolean | undefined] => [mark, flag(args, mark)]);
  const font = args.font === undefined ? undefined : text(args, 'font').trim();
  const size = args.size === undefined ? undefined : int(args, 'size');
  const color = args.color === undefined ? undefined : text(args, 'color').trim();
  const highlight = args.highlight === undefined ? undefined : text(args, 'highlight').trim();
  if (size !== undefined && (size < 1 || size > 1638)) throw new ToolError('`size` is in points, from 1 to 1638.');
  const none = (v: string | undefined) => v !== undefined && /^(none|auto|automatic|)$/i.test(v);
  const colorValue = color === undefined ? undefined : none(color) ? null : colorOf(color);
  const highlightValue = highlight === undefined ? undefined : none(highlight) ? null : colorOf(highlight);
  if (marks.every(([, on]) => on === undefined) && !font && size === undefined && colorValue === undefined && highlightValue === undefined) {
    throw new ToolError('Say what to change: bold, italic, underline, strikethrough, superscript, subscript, code, font, size, color or highlight.');
  }
  const problem = await selectRange(env, index, paragraph, find);
  if (problem) return problem;
  for (const [mark, on] of marks) {
    if (on === undefined) continue;
    const now = env.format().marks?.[mark] === true;
    if (now !== on) await env.run({ kind: 'format', action: { kind: 'toggleMark', mark } });
  }
  if (font) await env.run({ kind: 'format', action: { kind: 'setFont', family: font } });
  if (size !== undefined) await env.run({ kind: 'format', action: { kind: 'setFontSize', points: size } });
  if (colorValue !== undefined) await env.run({ kind: 'format', action: { kind: 'setColor', color: colorValue } });
  if (highlightValue !== undefined) await env.run({ kind: 'format', action: { kind: 'setHighlight', color: highlightValue } });
  return `Formatted ${find ? `"${find}" in ` : ''}paragraph ${index}.`;
}

async function clearFormatting(env: AgentEnv, args: Record<string, unknown>): Promise<string> {
  editable(env);
  const { index, paragraph } = paragraphAt(env, args);
  const find = args.find === undefined ? undefined : text(args, 'find');
  const problem = await selectRange(env, index, paragraph, find);
  if (problem) return problem;
  await env.run({ kind: 'format', action: { kind: 'clearFormatting' } });
  return `Cleared the formatting of ${find ? `"${find}" in ` : ''}paragraph ${index}.`;
}

async function changeCase(env: AgentEnv, args: Record<string, unknown>): Promise<string> {
  editable(env);
  const { index, paragraph } = paragraphAt(env, args);
  const to = text(args, 'to');
  if (to !== 'sentence' && to !== 'lower' && to !== 'upper' && to !== 'title' && to !== 'toggle') throw new ToolError('`to` must be sentence, lower, upper, title or toggle.');
  const find = args.find === undefined ? undefined : text(args, 'find');
  const problem = await selectRange(env, index, paragraph, find);
  if (problem) return problem;
  await env.run({ kind: 'format', action: { kind: 'changeCase', to } });
  return `Changed the case of ${find ? `"${find}" in ` : ''}paragraph ${index} (${to}).`;
}

/** The paragraphs from `paragraph` to `last` (default: the same one). */
function paragraphRange(env: AgentEnv, args: Record<string, unknown>): number[] {
  const { index } = paragraphAt(env, args);
  const last = args.last === undefined ? index : paragraphAt(env, args, 'last').index;
  if (last < index) throw new ToolError('`last` must not be before `paragraph`.');
  if (last - index >= MAX_RANGE) throw new ToolError(`At most ${MAX_RANGE} paragraphs at a time.`);
  return Array.from({ length: last - index + 1 }, (_, k) => index + k);
}

const MAX_RANGE = 200;
const TWIPS_PER_POINT = 20;

async function formatParagraph(env: AgentEnv, args: Record<string, unknown>): Promise<string> {
  editable(env);
  const list = args.list === undefined ? undefined : text(args, 'list');
  if (list !== undefined && list !== 'bullet' && list !== 'number' && list !== 'task' && list !== 'task_done' && list !== 'none') throw new ToolError('`list` must be bullet, number, task, task_done or none.');
  const align = args.align === undefined ? undefined : text(args, 'align');
  if (align !== undefined && align !== 'left' && align !== 'center' && align !== 'right' && align !== 'justify') throw new ToolError('`align` must be left, center, right or justify.');
  const indent = args.indent === undefined ? undefined : text(args, 'indent');
  if (indent !== undefined && indent !== 'increase' && indent !== 'decrease') throw new ToolError('`indent` must be increase or decrease.');
  const number = (key: string, max: number): number | undefined => {
    const v = args[key];
    if (v === undefined) return undefined;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > max) throw new ToolError(`\`${key}\` must be a number from 0 to ${max}.`);
    return v;
  };
  const lineSpacing = number('line_spacing', 10);
  const before = number('space_before', 500);
  const after = number('space_after', 500);
  const keepNext = flag(args, 'keep_with_next');
  const pageBreakBefore = flag(args, 'page_break_before');
  const paragraphs = paragraphRange(env, args);
  if (!align && !list && !indent && lineSpacing === undefined && before === undefined && after === undefined && keepNext === undefined && pageBreakBefore === undefined) {
    throw new ToolError('Say what to change: align, line_spacing, space_before, space_after, list, indent, keep_with_next or page_break_before.');
  }
  for (const k of paragraphs) {
    await select(env, k, 0, 0);
    if (align) await env.run({ kind: 'format', action: { kind: 'setAlignment', align } });
    if (lineSpacing !== undefined && lineSpacing > 0) await env.run({ kind: 'format', action: { kind: 'setLineSpacing', lines: lineSpacing } });
    if (before !== undefined || after !== undefined || keepNext !== undefined || pageBreakBefore !== undefined) {
      await env.run({
        kind: 'format',
        action: {
          kind: 'setParagraph',
          ...(before !== undefined && { before: Math.round(before * TWIPS_PER_POINT) }),
          ...(after !== undefined && { after: Math.round(after * TWIPS_PER_POINT) }),
          ...(keepNext !== undefined && { keepNext }),
          ...(pageBreakBefore !== undefined && { pageBreakBefore }),
        },
      });
    }
    if (list) {
      const now = env.format().list ?? null;
      // Choosing the list a paragraph is in turns it off; choosing the other one switches.
      if (list === 'task' || list === 'task_done') await env.run({ kind: 'format', action: { kind: 'toggleList', list: list === 'task' ? 'task' : 'taskDone', force: true } });
      else if (list === 'none' ? now : now !== list) await env.run({ kind: 'format', action: { kind: 'toggleList', list: list === 'none' ? now! : list } });
    }
    if (indent) await env.run({ kind: 'format', action: { kind: 'indent', direction: indent } });
  }
  return `Formatted ${paragraphs.length === 1 ? `paragraph ${paragraphs[0]}` : `paragraphs ${paragraphs[0]} to ${paragraphs.at(-1)}`}.`;
}

async function insertRule(env: AgentEnv, args: Record<string, unknown>): Promise<string> {
  editable(env);
  const { index, paragraph } = paragraphAt(env, args, 'after');
  await select(env, index, paragraphLength(paragraph), paragraphLength(paragraph));
  const before = env.editor.paragraphs().length;
  await env.run({ kind: 'format', action: { kind: 'insertHorizontalRule' } });
  return env.editor.paragraphs().length > before ? `Added a horizontal rule after paragraph ${index}.` : 'A horizontal rule could not be added here.';
}

async function formatCodeBlock(env: AgentEnv, args: Record<string, unknown>): Promise<string> {
  editable(env);
  const on = flag(args, 'on') ?? true;
  const paragraphs = paragraphRange(env, args);
  for (const k of paragraphs) {
    await select(env, k, 0, 0);
    if ((env.format().style === 'Code') !== on) await env.run({ kind: 'format', action: { kind: 'insertCodeBlock' } });
  }
  const now = env.format().style === 'Code';
  if (now !== on) return `This kind of document has no code blocks (the Code style is ${on ? 'not available' : 'still applied'}).`;
  return `${on ? 'Made' : 'Made plain text of'} ${paragraphs.length === 1 ? `paragraph ${paragraphs[0]}` : `paragraphs ${paragraphs[0]} to ${paragraphs.at(-1)}`}${on ? ' a code block' : ''}.`;
}

async function insertLink(env: AgentEnv, args: Record<string, unknown>): Promise<string> {
  editable(env);
  const { index, paragraph } = paragraphAt(env, args);
  const url = text(args, 'url').trim();
  if (!url) throw new ToolError('`url` must not be empty');
  const find = args.find === undefined ? undefined : text(args, 'find');
  const problem = await selectRange(env, index, paragraph, find);
  if (problem) return problem;
  const shownText = find ?? paragraphText(paragraph);
  await env.run({ kind: 'setLink', url, text: shownText });
  return `Linked ${find ? `"${find}" in ` : ''}paragraph ${index} to ${url}.`;
}

async function removeLink(env: AgentEnv, args: Record<string, unknown>): Promise<string> {
  editable(env);
  const { index, paragraph } = paragraphAt(env, args);
  const find = args.find === undefined ? undefined : text(args, 'find');
  const problem = await selectRange(env, index, paragraph, find);
  if (problem) return problem;
  await env.run({ kind: 'removeLink' });
  return `Removed the link in paragraph ${index}.`;
}

async function insertBreak(env: AgentEnv, args: Record<string, unknown>): Promise<string> {
  editable(env);
  const { index, paragraph } = paragraphAt(env, args, 'after');
  const kind = text(args, 'type');
  if (kind !== 'page' && kind !== 'column' && kind !== 'line') throw new ToolError('`type` must be page, column or line.');
  await select(env, index, paragraphLength(paragraph), paragraphLength(paragraph));
  await env.run(kind === 'line' ? { kind: 'insertLineBreak' } : { kind: 'insertLineBreak', type: kind });
  return `Added a ${kind} break after paragraph ${index}.`;
}

async function insertTable(env: AgentEnv, args: Record<string, unknown>): Promise<string> {
  editable(env);
  const { index, paragraph } = paragraphAt(env, args, 'after');
  const rows = int(args, 'rows');
  const columns = int(args, 'columns');
  if (rows < 1 || rows > MAX_TABLE || columns < 1 || columns > MAX_TABLE) throw new ToolError(`A table has 1 to ${MAX_TABLE} rows and columns.`);
  const cells = args.cells;
  if (cells !== undefined && (!Array.isArray(cells) || cells.some((row) => !Array.isArray(row) || row.some((c) => typeof c !== 'string')))) throw new ToolError('`cells` must be a list of rows, each a list of text.');
  const grid = (cells ?? []) as string[][];
  if (grid.length > rows || grid.some((row) => row.length > columns)) throw new ToolError(`\`cells\` has more than ${rows} rows or ${columns} columns.`);
  const before = env.editor.paragraphs().length;
  await select(env, index, paragraphLength(paragraph), paragraphLength(paragraph));
  await env.run({ kind: 'format', action: { kind: 'insertTable', rows, columns } });
  if (env.editor.paragraphs().length === before) return 'A table cannot be added here (it may be inside another table).';
  // The caret is in the first cell: type each cell, Tab on to the next (but not past the last, which would add a row).
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const value = grid[r]?.[c];
      if (value) await env.run({ kind: 'insertText', text: value.replace(/\s*\n\s*/g, ' ') });
      if (r < rows - 1 || c < columns - 1) await env.run({ kind: 'tab', backward: false });
    }
  }
  return `Added a table of ${rows} rows and ${columns} columns after paragraph ${index}.`;
}

const MAX_TABLE = 50;
const TABLE_OPS = ['insert_row_above', 'insert_row_below', 'insert_column_left', 'insert_column_right', 'delete_rows', 'delete_columns', 'delete_table', 'split_cells', 'merge_cells'] as const;
const TABLE_ACTIONS: Record<string, TableOp> = {
  insert_row_above: 'insertRowAbove',
  insert_row_below: 'insertRowBelow',
  insert_column_left: 'insertColumnLeft',
  insert_column_right: 'insertColumnRight',
  delete_rows: 'deleteRows',
  delete_columns: 'deleteColumns',
  delete_table: 'deleteTable',
  split_cells: 'splitCells',
  merge_cells: 'mergeCells',
};

async function editTable(env: AgentEnv, args: Record<string, unknown>): Promise<string> {
  editable(env);
  const { index } = paragraphAt(env, args);
  const op = text(args, 'op');
  if (!Object.hasOwn(TABLE_ACTIONS, op)) throw new ToolError(`\`op\` must be one of ${TABLE_OPS.join(', ')}.`);
  await select(env, index, 0, 0);
  if (!env.editor.inTable()) return `Paragraph ${index} is not in a table.`;
  if (op === 'merge_cells') {
    // The cells from the one `paragraph` is in to the one `to_paragraph` is in (and all between, as a block).
    const to = paragraphAt(env, args, 'to_paragraph').index;
    if (to === index) return 'Those cells could not be merged (they must be two or more different cells of one table).';
    const cells = env.editor.paragraphs();
    await env.run({ kind: 'select', paragraph: index, from: 0, to: 0, until: to });
    await env.run({ kind: 'format', action: { kind: 'table', op: 'mergeCells' } });
    // Merging rebuilds the table: its paragraphs are new ones. A merge that did nothing (one cell, or two tables) leaves them as they were.
    const merged = env.editor.paragraphs().some((p, k) => p !== cells[k]);
    return merged ? `Merged the cells from paragraph ${index} to paragraph ${to}.` : 'Those cells could not be merged (they must be two or more different cells of one table).';
  }
  const action: TableAction = { kind: 'table', op: TABLE_ACTIONS[op]! };
  if (op === 'split_cells') {
    action.columns = int(args, 'columns', 2);
    action.rows = int(args, 'rows', 1);
    if (action.columns < 1 || action.rows < 1 || action.columns > MAX_TABLE || action.rows > MAX_TABLE) throw new ToolError(`Split into 1 to ${MAX_TABLE} rows and columns.`);
  }
  await env.run({ kind: 'format', action });
  return `Done: ${op.replaceAll('_', ' ')} at paragraph ${index}.`;
}

async function setColumns(env: AgentEnv, args: Record<string, unknown>): Promise<string> {
  editable(env);
  const count = int(args, 'count');
  if (count < 1 || count > 12) throw new ToolError('`count` must be from 1 to 12.');
  const scope = args.scope === undefined ? 'document' : text(args, 'scope');
  if (scope !== 'document' && scope !== 'section' && scope !== 'forward') throw new ToolError('`scope` must be document, section or forward.');
  if (scope !== 'document') {
    const { index } = paragraphAt(env, args);
    await select(env, index, 0, 0);
  }
  const space = args.space === undefined ? 720 : Math.round(Number(args.space) * TWIPS_PER_POINT);
  if (!Number.isFinite(space) || space < 0) throw new ToolError('`space` is the gap between columns in points.');
  await env.run({ kind: 'setColumns', count, space, sep: flag(args, 'line_between') ?? false, scope });
  return `Set ${count} column${count === 1 ? '' : 's'} (${scope === 'document' ? 'whole document' : scope === 'section' ? 'that section' : 'from that paragraph on'}).`;
}

async function insertEquation(env: AgentEnv, args: Record<string, unknown>): Promise<string> {
  editable(env);
  const { index, paragraph } = paragraphAt(env, args);
  const latex = text(args, 'latex').trim();
  if (!latex) throw new ToolError('`latex` must not be empty');
  const display = flag(args, 'display') ?? false;
  const { equation, errors } = parseLatex(latex, display);
  if (errors.length) throw new ToolError(`The LaTeX has errors: ${errors.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('; ')}`);
  const find = args.find === undefined ? undefined : text(args, 'find');
  if (find) {
    const problem = await selectRange(env, index, paragraph, find);
    if (problem) return problem;
  } else {
    await select(env, index, paragraphLength(paragraph), paragraphLength(paragraph));
  }
  await env.run({ kind: 'insertContent', content: [mathInline(equation)] });
  return `Inserted the equation ${find ? `in place of "${find}" ` : 'at the end '}in paragraph ${index}.`;
}

const PAGE_SIZES: Record<string, [number, number]> = {
  letter: [12240, 15840],
  legal: [12240, 20160],
  tabloid: [15840, 24480],
  a3: [16838, 23811],
  a4: [11906, 16838],
  a5: [8392, 11906],
};
const TWIPS_PER_INCH = 1440;

async function setPage(env: AgentEnv, args: Record<string, unknown>): Promise<string> {
  editable(env);
  const scope = args.scope === undefined ? 'document' : text(args, 'scope');
  if (scope !== 'document' && scope !== 'section' && scope !== 'forward') throw new ToolError('`scope` must be document, section or forward.');
  if (scope !== 'document') await select(env, paragraphAt(env, args).index, 0, 0);
  const now = env.editor.sectionPage();
  let { width, height } = now;
  let landscape = now.landscape;
  const size = args.size === undefined ? undefined : text(args, 'size').toLowerCase();
  if (size !== undefined) {
    if (!Object.hasOwn(PAGE_SIZES, size)) throw new ToolError(`\`size\` must be one of ${Object.keys(PAGE_SIZES).join(', ')}.`);
    [width, height] = PAGE_SIZES[size]!;
    if (landscape) [width, height] = [height, width];
  }
  const orientation = args.orientation === undefined ? undefined : text(args, 'orientation');
  if (orientation !== undefined) {
    if (orientation !== 'portrait' && orientation !== 'landscape') throw new ToolError('`orientation` must be portrait or landscape.');
    if ((orientation === 'landscape') !== landscape) [width, height] = [height, width];
    landscape = orientation === 'landscape';
  }
  const margin = (key: string, was: number): number => {
    const v = args[key];
    if (v === undefined) return was;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 10) throw new ToolError(`\`${key}\` is in inches, from 0 to 10.`);
    return Math.round(v * TWIPS_PER_INCH);
  };
  const all = args.margins;
  const top = margin(all === undefined ? 'top' : 'margins', now.top);
  const bottom = margin(all === undefined ? 'bottom' : 'margins', now.bottom);
  const left = margin(all === undefined ? 'left' : 'margins', now.left);
  const right = margin(all === undefined ? 'right' : 'margins', now.right);
  if (left + right >= width || top + bottom >= height) throw new ToolError('The margins leave no room for text.');
  await env.run({ kind: 'setPage', ...now, width, height, landscape, top, bottom, left, right, scope });
  return `Page setup: ${(width / TWIPS_PER_INCH).toFixed(2)} x ${(height / TWIPS_PER_INCH).toFixed(2)} inches${landscape ? ' (landscape)' : ''}, margins ${top / TWIPS_PER_INCH}/${right / TWIPS_PER_INCH}/${bottom / TWIPS_PER_INCH}/${left / TWIPS_PER_INCH} inches (top/right/bottom/left).`;
}

function listComments(env: AgentEnv): string {
  const comments = env.editor.comments();
  if (!comments.length) return 'There are no comments.';
  const lines = comments.map((c) => `[${c.id}]${c.parentId ? ` (reply to ${c.parentId})` : ''}${c.resolved ? ' (resolved)' : ''} ${c.author}: ${c.text}`);
  return `${comments.length} comment${comments.length === 1 ? '' : 's'} and replies:\n${lines.join('\n')}`.slice(0, MAX_READ_CHARS);
}

function commentOf(env: AgentEnv, args: Record<string, unknown>) {
  const id = text(args, 'id');
  const found = env.editor.comments().find((c) => c.id === id);
  if (!found) throw new ToolError(`There is no comment ${id}; use list_comments.`);
  return found;
}

async function editComment(env: AgentEnv, args: Record<string, unknown>): Promise<string> {
  editable(env);
  const { id } = commentOf(env, args);
  const value = text(args, 'text').trim();
  if (!value) throw new ToolError('`text` must not be empty');
  await env.run({ kind: 'editComment', id, text: value });
  return `Changed comment ${id}.`;
}

async function replyComment(env: AgentEnv, args: Record<string, unknown>): Promise<string> {
  editable(env);
  const { id } = commentOf(env, args);
  const value = text(args, 'text').trim();
  if (!value) throw new ToolError('`text` must not be empty');
  await env.run({ kind: 'replyComment', id, text: value, author: AUTHOR });
  return `Replied to comment ${id}.`;
}

async function resolveComment(env: AgentEnv, args: Record<string, unknown>): Promise<string> {
  editable(env);
  const { id } = commentOf(env, args);
  const resolved = flag(args, 'resolved') ?? true;
  await env.run({ kind: 'resolveComment', id, resolved });
  return resolved ? `Resolved comment ${id}.` : `Reopened comment ${id}.`;
}

async function deleteComment(env: AgentEnv, args: Record<string, unknown>): Promise<string> {
  editable(env);
  const { id } = commentOf(env, args);
  await env.run({ kind: 'deleteComment', id });
  return `Deleted comment ${id} and its replies.`;
}

const PROPERTY_KEYS = ['title', 'subject', 'author', 'keywords', 'comments', 'category', 'company', 'manager'] as const;

function getProperties(env: AgentEnv): string {
  const p = env.editor.doc.properties;
  const lines = PROPERTY_KEYS.filter((k) => p[k]).map((k) => `${k}: ${p[k]}`);
  return lines.length ? lines.join('\n') : 'No properties are set.';
}

async function setProperties(env: AgentEnv, args: Record<string, unknown>): Promise<string> {
  editable(env);
  const change: DocumentProperties = {};
  for (const key of PROPERTY_KEYS) if (args[key] !== undefined) change[key] = text(args, key);
  if (!Object.keys(change).length) throw new ToolError(`Say what to set: ${PROPERTY_KEYS.join(', ')}.`);
  await env.run({ kind: 'setProperties', properties: { ...env.editor.doc.properties, ...change } });
  return `Set ${Object.keys(change).join(', ')}.`;
}

function countWords(env: AgentEnv): string {
  const list = env.editor.paragraphs();
  let words = 0;
  let characters = 0;
  let spaces = 0;
  for (const p of list) {
    const line = paragraphText(p).replaceAll(OBJECT_CHAR, '');
    words += line.split(/\s+/).filter(Boolean).length;
    characters += line.replace(/\s/g, '').length;
    spaces += line.length;
  }
  return `${words} words, ${characters} characters (${spaces} with spaces), ${list.length} paragraphs.`;
}

async function undoRedo(env: AgentEnv, kind: 'undo' | 'redo'): Promise<string> {
  editable(env);
  await env.run({ kind });
  return kind === 'undo' ? 'Undid the last change.' : 'Redid the last change.';
}

async function addComment(env: AgentEnv, args: Record<string, unknown>): Promise<string> {
  editable(env);
  const { index, paragraph } = paragraphAt(env, args);
  const comment = text(args, 'text').trim();
  if (!comment) throw new ToolError('`text` must not be empty');
  const find = args.find === undefined ? undefined : text(args, 'find');
  const problem = await selectRange(env, index, paragraph, find);
  if (problem) return problem;
  await env.run({ kind: 'addComment', text: comment, author: AUTHOR });
  return `Commented on ${find ? `"${find}" in ` : ''}paragraph ${index}.`;
}

const TOOLS: Record<string, (env: AgentEnv, args: Record<string, unknown>) => string | Promise<string>> = {
  read_document: readDocument,
  list_pictures: listPictures,
  view_picture: viewPicture,
  get_selection: getSelection,
  find_text: findText,
  replace_paragraph: replaceParagraph,
  insert_paragraph: insertParagraph,
  delete_paragraph: deleteParagraph,
  replace_text: replaceText,
  set_style: setStyle,
  format_text: formatText,
  add_comment: addComment,
  clear_formatting: clearFormatting,
  change_case: changeCase,
  format_paragraph: formatParagraph,
  insert_horizontal_rule: insertRule,
  format_code_block: formatCodeBlock,
  insert_link: insertLink,
  remove_link: removeLink,
  insert_break: insertBreak,
  insert_table: insertTable,
  edit_table: editTable,
  set_columns: setColumns,
  insert_equation: insertEquation,
  set_page: setPage,
  list_comments: listComments,
  edit_comment: editComment,
  reply_comment: replyComment,
  resolve_comment: resolveComment,
  delete_comment: deleteComment,
  get_properties: getProperties,
  set_properties: setProperties,
  count_words: countWords,
  undo: (env) => undoRedo(env, 'undo'),
  redo: (env) => undoRedo(env, 'redo'),
};

// --- pictures ---------------------------------------------------------------------------------

/** The pictures in the document, in order, each with the paragraph it is in. */
function documentPictures(paragraphs: Paragraph[]): { part: string; paragraph: number; name: string }[] {
  const found: { part: string; paragraph: number; name: string }[] = [];
  const inlines = (list: readonly Inline[], paragraph: number): void => {
    for (const inline of list) {
      if (inline.kind === 'run') {
        for (const item of inline.content) if (item.kind === 'drawing' && item.image) found.push({ part: item.image, paragraph, name: item.description || item.name || '' });
      } else if (inline.kind === 'hyperlink' || inline.kind === 'wrapper') inlines(inline.children, paragraph);
    }
  };
  paragraphs.forEach((p, i) => inlines(p.children, i));
  return found;
}

const MAX_LISTED_PICTURES = 50;

function listPictures(env: AgentEnv): string {
  const pictures = documentPictures(env.editor.paragraphs());
  if (!pictures.length) return 'The open document has no pictures.';
  const lines = pictures.slice(0, MAX_LISTED_PICTURES).map((p, i) => `[${i}] in paragraph ${p.paragraph}${p.name ? `: ${p.name.slice(0, 120)}` : ''}`);
  return `The open document has ${pictures.length} picture${pictures.length === 1 ? '' : 's'}:\n${lines.join('\n')}${pictures.length > MAX_LISTED_PICTURES ? `\n(${pictures.length - MAX_LISTED_PICTURES} more not listed)` : ''}`;
}

async function viewPicture(env: AgentEnv, args: Record<string, unknown>): Promise<string> {
  if (args.source !== 'document') throw new ToolError('`source` must be "document" or "library"');
  const pictures = documentPictures(env.editor.paragraphs());
  const number = int(args, 'number', 0);
  const picture = pictures[number];
  if (!picture) throw new ToolError(pictures.length ? `there is no picture ${number}; the document has ${pictures.length} (0 to ${pictures.length - 1})` : 'the document has no pictures');
  const bytes = await env.editor.doc.media(picture.part).catch(() => new Uint8Array(0));
  const image = sniffImage(bytes);
  if (!image) throw new ToolError('that picture is in a format that cannot be shown');
  env.show([await pictureForModel(bytes).catch(() => { throw new ToolError('that picture could not be prepared to show'); })]);
  return `Showing picture ${number} (${image.width} by ${image.height} pixels, ${image.type}).`;
}

/** Runs one tool for the model. `argumentsJson` is what the model wrote. Never throws: problems are the answer. */
export async function runAgentTool(env: AgentEnv, name: string, argumentsJson: string): Promise<string> {
  // Own tools only: a name like "constructor" or "toString" mustn't reach Object.prototype.
  const tool = Object.hasOwn(TOOLS, name) ? TOOLS[name] : undefined;
  if (!tool) return `Error: there is no tool called ${name}.`;
  try {
    const args = object(argumentsJson.trim() ? JSON.parse(argumentsJson) : {}, 'the arguments');
    return await tool(env, args);
  } catch (e) {
    if (e instanceof ToolError) return `Error: ${e.message}`;
    if (e instanceof SyntaxError) return 'Error: the arguments were not valid JSON.';
    console.error(e);
    return 'Error: that did not work.';
  }
}
