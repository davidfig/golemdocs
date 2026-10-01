// The tools the assistant edits a document with (their descriptions are in server/src/assistantTools.ts;
// names and arguments must match). They run in the layout worker against the open document, and
// change it only through the same editor commands typing and the menus use, so every change can be
// undone, laid out and shared with a collaboration room like any other.
//
// Each tool answers with text for the model: what it found or did, or why it couldn't. Paragraphs
// are numbered from 0 in document order, as `Editor.paragraphs()` has them.

import { OBJECT_CHAR, paragraphLength, paragraphText, type Paragraph } from '@golemdocs/docx';
import type { FormatState, Mark } from '../ui/actions.ts';
import type { WireCommand } from './protocol.ts';

/** The part of the editor the tools read. */
export interface AgentEditor {
  paragraphs(): Paragraph[];
  ordered(): [{ paragraph: Paragraph; offset: number }, { paragraph: Paragraph; offset: number }];
  selectedText(limit?: number): string;
}

export interface AgentEnv {
  editor: AgentEditor;
  /** The document can't be edited (opened read-only, or shown as a PDF). */
  readOnly: boolean;
  /** Applies a command and settles once it has taken effect (fonts loaded, layout started). */
  run(command: WireCommand): Promise<void>;
  /** The formatting at the selection. */
  format(): FormatState;
}

/** The most a reading tool returns, in characters, so one call can't fill the conversation. */
export const MAX_READ_CHARS = 8000;
const MAX_MATCHES = 20;
const AUTHOR = 'Clip';

class ToolError extends Error {}

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

async function formatText(env: AgentEnv, args: Record<string, unknown>): Promise<string> {
  editable(env);
  const { index, paragraph } = paragraphAt(env, args);
  const find = args.find === undefined ? undefined : text(args, 'find');
  const wanted: [Mark, boolean | undefined][] = [
    ['bold', flag(args, 'bold')],
    ['italic', flag(args, 'italic')],
    ['underline', flag(args, 'underline')],
  ];
  if (wanted.every(([, on]) => on === undefined)) throw new ToolError('Say what to change: bold, italic or underline.');
  const problem = await selectRange(env, index, paragraph, find);
  if (problem) return problem;
  for (const [mark, on] of wanted) {
    if (on === undefined) continue;
    const now = env.format().marks?.[mark] === true;
    if (now !== on) await env.run({ kind: 'format', action: { kind: 'toggleMark', mark } });
  }
  return `Formatted ${find ? `"${find}" in ` : ''}paragraph ${index}.`;
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
  get_selection: getSelection,
  find_text: findText,
  replace_paragraph: replaceParagraph,
  insert_paragraph: insertParagraph,
  delete_paragraph: deleteParagraph,
  replace_text: replaceText,
  set_style: setStyle,
  format_text: formatText,
  add_comment: addComment,
};

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
