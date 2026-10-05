// The assistant's tools for a PDF shown as its own pages (their descriptions are in
// server/src/assistantTools.ts; names and arguments must match). A PDF has no paragraphs to
// number: pages are numbered from 1, text is found by what it says, and places are in points
// from the top left of a page. Like the text tools, these change the PDF only through the
// commands the page's own tools use, so every change can be undone.

import type { PdfAnnotator } from './pdfAnnotator.ts';
import type { PdfCharacter } from '../formats/pdfPages.ts';
import type { WireCommand, WireField } from './protocol.ts';
import { MAX_READ_CHARS } from './agentTools.ts';

export interface PdfAgentEnv {
  annotator: PdfAnnotator;
  pageCount: number;
  /** Characters of a page (0-based), for finding text. */
  characters(index: number): PdfCharacter[];
  /** A page's current id (they change as pages are laid out again), or undefined if it is not laid out yet. */
  pageId(index: number): number | undefined;
  /** A page's size in points. */
  pageSize(index: number): { width: number; height: number } | undefined;
  /** The form fields, as the page sees them. */
  fields(): WireField[];
  run(command: WireCommand): Promise<void>;
  /** Changes the pages (done once the new file is shown). */
  /** Why the PDF can't be changed now (someone else holds it, say), or null if it can. */
  readonly readOnly: string | null;
  pageOp(index: number, op: 'delete' | 'rotateLeft' | 'rotateRight' | 'moveUp' | 'moveDown' | 'duplicate' | 'insert'): Promise<void>;
  /** Picks the text at a point of a page to edit it in place (done once it is picked). */
  pick(index: number, x: number, y: number): Promise<void>;
}

class ToolError extends Error {}

type Args = Record<string, unknown>;

const text = (args: Args, key: string): string => {
  const v = args[key];
  if (typeof v === 'string') return v;
  throw new ToolError(`\`${key}\` must be text`);
};
const num = (args: Args, key: string): number => {
  const v = args[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ToolError(`\`${key}\` must be a number`);
  return v;
};
const flag = (args: Args, key: string): boolean | undefined => {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw new ToolError(`\`${key}\` must be true or false`);
  return v;
};

/** A page number from 1 (as the person counts) as an index. */
function pageIndex(env: PdfAgentEnv, args: Args, key = 'page'): number {
  const v = args[key];
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new ToolError(`\`${key}\` must be a whole number`);
  if (v < 1 || v > env.pageCount) throw new ToolError(`There is no page ${v}; the PDF has pages 1 to ${env.pageCount}.`);
  return v - 1;
}

function pageIdOf(env: PdfAgentEnv, index: number): number {
  const id = env.pageId(index);
  if (id === undefined) throw new ToolError(`Page ${index + 1} is not ready yet; try again in a moment.`);
  return id;
}

/** A page's text as one string (lines joined by a space), and which character each position of it is (-1: a joint). */
function flatText(chars: readonly PdfCharacter[]): { value: string; at: number[] } {
  let value = '';
  const at: number[] = [];
  let line = chars[0]?.line;
  chars.forEach((c, i) => {
    if (c.line !== line) {
      line = c.line;
      if (!/\s$/.test(value)) {
        value += ' ';
        at.push(-1);
      }
    }
    for (const unit of c.text) {
      value += unit;
      for (let k = 0; k < unit.length; k++) at.push(i);
    }
  });
  return { value, at };
}

/** The first match of `needle` on a page: the first and last characters it covers. */
function locate(chars: readonly PdfCharacter[], needle: string, matchCase: boolean): { first: number; last: number } | null {
  if (!needle.trim()) throw new ToolError('`text` must not be empty');
  const { value, at } = flatText(chars);
  const h = matchCase ? value : value.toLowerCase();
  const n = (matchCase ? needle : needle.toLowerCase()).replace(/\s+/g, ' ').trim();
  const start = h.replace(/\s+/g, ' ').indexOf(n);
  if (start === -1) return null;
  // The flat text may hold runs of spaces the needle's single spaces stand for: walk to the real offsets.
  let seen = 0;
  let from = -1;
  let to = -1;
  let lastSpace = false;
  for (let i = 0; i < h.length; i++) {
    const space = /\s/.test(h[i]!);
    if (space && lastSpace) continue;
    lastSpace = space;
    if (seen === start) from = i;
    if (seen === start + n.length - 1) {
      to = i;
      break;
    }
    seen++;
  }
  if (from < 0 || to < 0) return null;
  const first = at.slice(from).find((k) => k >= 0);
  const last = [...at.slice(0, to + 1)].reverse().find((k) => k >= 0);
  return first === undefined || last === undefined ? null : { first, last };
}

function pageText(chars: readonly PdfCharacter[]): string {
  return flatText(chars)
    .value.replace(/ +/g, ' ')
    .trim();
}

const readPage = (env: PdfAgentEnv, args: Args): string => {
  const index = pageIndex(env, args);
  const size = env.pageSize(index);
  const body = pageText(env.characters(index));
  const head = `Page ${index + 1} of ${env.pageCount}${size ? ` (${Math.round(size.width)} x ${Math.round(size.height)} points)` : ''}.`;
  if (!body) return `${head} It has no text.`;
  return `${head}\n${body.length > MAX_READ_CHARS ? `${body.slice(0, MAX_READ_CHARS)}… (cut short)` : body}`;
};

function find(env: PdfAgentEnv, args: Args): string {
  const needle = text(args, 'text');
  const matchCase = flag(args, 'match_case') ?? false;
  const out: string[] = [];
  for (let k = 0; k < env.pageCount; k++) {
    const chars = env.characters(k);
    const hit = locate(chars, needle, matchCase);
    if (!hit) continue;
    const flat = flatText(chars);
    const start = flat.at.indexOf(hit.first);
    out.push(`Page ${k + 1}: …${flat.value.slice(Math.max(0, start - 30), start + needle.length + 30)}…`);
  }
  return out.length ? `Found on ${out.length} page${out.length === 1 ? '' : 's'} (first match on each):\n${out.join('\n')}` : 'No matches.';
}

async function markup(env: PdfAgentEnv, args: Args): Promise<string> {
  const index = pageIndex(env, args);
  const kind = text(args, 'kind');
  if (kind !== 'highlight' && kind !== 'underline' && kind !== 'strikeout' && kind !== 'note') throw new ToolError('`kind` must be highlight, underline, strikeout or note.');
  const color = args.color === undefined ? undefined : text(args, 'color');
  if (color !== undefined && !/^#[0-9a-f]{6}$/i.test(color)) throw new ToolError('`color` must be like #ffeb3b.');
  const note = args.note === undefined ? undefined : text(args, 'note');
  if (kind === 'note' && !note?.trim()) throw new ToolError('A note needs `note`, the words it says.');
  const hit = locate(env.characters(index), text(args, 'text'), flag(args, 'match_case') ?? false);
  if (!hit) return `That text is not on page ${index + 1}.`;
  env.annotator.deselect();
  env.annotator.selectChars(index, hit.first, hit.last);
  await env.run({ kind: 'annotate', annotation: kind, ...(color && { color }), ...(kind === 'note' && { text: note }) });
  return kind === 'note' ? `Added a note on page ${index + 1}.` : `Marked the text on page ${index + 1} (${kind}).`;
}

async function editText(env: PdfAgentEnv, args: Args): Promise<string> {
  const index = pageIndex(env, args);
  const needle = text(args, 'find');
  const replacement = text(args, 'replace');
  const chars = env.characters(index);
  const hit = locate(chars, needle, true);
  if (!hit) return `"${needle}" is not on page ${index + 1} (the match is exact, including case).`;
  const middle = chars[Math.floor((hit.first + hit.last) / 2)]!;
  await env.pick(index, (middle.x0 + middle.x1) / 2, (middle.top + middle.bottom) / 2);
  const picked = env.annotator.picked;
  if (!picked) return `The text on page ${index + 1} cannot be edited in place.`;
  const at = picked.text.indexOf(needle);
  if (at === -1) {
    await env.run({ kind: 'pdfPutDown' });
    return `"${needle}" is part of a text block that reads differently from the page's text (${JSON.stringify(picked.text.slice(0, 80))}); use read_pdf_page and edit it with a phrase inside one line.`;
  }
  await env.run({ kind: 'pdfText', text: picked.text.slice(0, at) + replacement + picked.text.slice(at + needle.length) });
  await env.run({ kind: 'pdfPutDown' });
  return `Changed "${needle}" to "${replacement}" on page ${index + 1}.`;
}

/** A box on a page, in points from its top left, checked to be on it. */
function boxOn(env: PdfAgentEnv, index: number, args: Args): { x: number; y: number; width: number; height: number } {
  const size = env.pageSize(index);
  const x = num(args, 'x');
  const y = num(args, 'y');
  const width = args.width === undefined ? 0 : num(args, 'width');
  const height = args.height === undefined ? 0 : num(args, 'height');
  if (x < 0 || y < 0 || width < 0 || height < 0 || (size && (x + width > size.width || y + height > size.height))) {
    throw new ToolError(`That is off the page${size ? ` (page ${index + 1} is ${Math.round(size.width)} x ${Math.round(size.height)} points)` : ''}.`);
  }
  return { x, y, width, height };
}

async function addText(env: PdfAgentEnv, args: Args): Promise<string> {
  const index = pageIndex(env, args);
  const { x, y } = boxOn(env, index, args);
  const value = text(args, 'text');
  if (!value) throw new ToolError('`text` must not be empty');
  const before = env.annotator.edits.length;
  await env.run({ kind: 'pdfAddText', page: pageIdOf(env, index), x, y, text: value });
  await env.run({ kind: 'pdfPutDown' });
  return env.annotator.edits.length > before ? `Added the text to page ${index + 1}.` : `The text could not be added to page ${index + 1}.`;
}

async function addShape(env: PdfAgentEnv, args: Args): Promise<string> {
  const index = pageIndex(env, args);
  const shape = text(args, 'shape');
  if (!['rect', 'ellipse', 'line', 'checkbox', 'cross', 'whiteout', 'redact'].includes(shape)) throw new ToolError('`shape` must be rect, ellipse, line, check, cross, whiteout or redact.');
  const box = boxOn(env, index, args);
  if (box.width <= 0 || box.height <= 0) throw new ToolError('`width` and `height` must be more than 0.');
  await env.run({ kind: 'pdfAddShape', page: pageIdOf(env, index), shape: shape as 'rect', box });
  await env.run({ kind: 'pdfPutDown' });
  return shape === 'redact' ? `Redacted that area of page ${index + 1}: what is under it is removed when the PDF is saved.` : `Added a ${shape} to page ${index + 1}.`;
}

const PAGE_OPS = {
  delete: 'delete',
  rotate_left: 'rotateLeft',
  rotate_right: 'rotateRight',
  move_up: 'moveUp',
  move_down: 'moveDown',
  duplicate: 'duplicate',
  insert_blank_after: 'insert',
} as const;

async function pageOp(env: PdfAgentEnv, args: Args): Promise<string> {
  const index = pageIndex(env, args);
  const op = text(args, 'op');
  if (!Object.hasOwn(PAGE_OPS, op)) throw new ToolError(`\`op\` must be one of ${Object.keys(PAGE_OPS).join(', ')}.`);
  if (op === 'delete' && env.pageCount < 2) return 'The only page cannot be deleted.';
  const before = env.pageCount;
  await env.pageOp(index, PAGE_OPS[op as keyof typeof PAGE_OPS]);
  return `Done: ${op.replaceAll('_', ' ')} on page ${index + 1}. The PDF now has ${env.pageCount} page${env.pageCount === 1 ? '' : 's'}${env.pageCount === before ? '' : ` (was ${before})`}.`;
}

function listFields(env: PdfAgentEnv): string {
  const fields = env.fields();
  if (!fields.length) return 'The PDF has no form fields.';
  const names = new Map<string, WireField[]>();
  for (const f of fields) names.set(f.name, [...(names.get(f.name) ?? []), f]);
  const lines = [...names].map(([name, group]) => {
    const f = group[0]!;
    const options = f.options?.length ? ` options: ${f.options.map((o) => o.label || o.value).join(' | ')}` : '';
    const on = f.kind === 'checkbox' || f.kind === 'radio' ? ` (on value ${group.map((g) => g.onState).filter(Boolean).join(' / ') || 'Yes'})` : '';
    return `${name} [${f.kind}${f.readOnly ? ', read-only' : ''}, page ${f.page + 1}]${on} = ${JSON.stringify(f.value)}${options}`;
  });
  return `${names.size} field${names.size === 1 ? '' : 's'}:\n${lines.join('\n')}`.slice(0, MAX_READ_CHARS);
}

async function fillField(env: PdfAgentEnv, args: Args): Promise<string> {
  const name = text(args, 'name');
  const value = args.value;
  if (typeof value !== 'string' && typeof value !== 'boolean') throw new ToolError('`value` must be text, or true or false for a check box.');
  const fields = env.fields();
  const group = fields.filter((f) => f.name === name);
  if (!group.length) throw new ToolError(`There is no field called "${name}"; use list_pdf_fields.`);
  const first = group[0]!;
  if (first.readOnly) throw new ToolError(`The field "${name}" is read-only.`);
  let next: string;
  if (first.kind === 'checkbox' || first.kind === 'radio') {
    const on = first.kind === 'radio' && typeof value === 'string' ? value : first.onState || 'Yes';
    const off = value === false || value === '' || (typeof value === 'string' && /^(false|no|off)$/i.test(value));
    if (!off && first.kind === 'radio' && !group.some((g) => g.onState === on)) throw new ToolError(`"${name}" is a choice of ${group.map((g) => g.onState).join(', ')}.`);
    next = off ? '' : on;
  } else {
    next = String(value);
    if (first.options?.length && !first.options.some((o) => o.value === next || o.label === next)) throw new ToolError(`"${name}" is a choice of ${first.options.map((o) => o.label || o.value).join(', ')}.`);
    const option = first.options?.find((o) => o.label === next);
    if (option) next = option.value;
    if (first.maxLength && next.length > first.maxLength) throw new ToolError(`"${name}" takes at most ${first.maxLength} characters.`);
  }
  await env.run({ kind: 'setFields', fields: fields.map((f) => (f.name === name ? { ...f, value: next } : f)) });
  return `Set "${name}" to ${JSON.stringify(next)}.`;
}

async function undoRedo(env: PdfAgentEnv, kind: 'undo' | 'redo'): Promise<string> {
  await env.run({ kind });
  return kind === 'undo' ? 'Undid the last change.' : 'Redid the last change.';
}

const TOOLS: Record<string, (env: PdfAgentEnv, args: Args) => string | Promise<string>> = {
  read_pdf_page: readPage,
  find_pdf_text: find,
  pdf_markup: markup,
  pdf_edit_text: editText,
  pdf_add_text: addText,
  pdf_add_shape: addShape,
  pdf_page: pageOp,
  list_pdf_fields: listFields,
  fill_pdf_field: fillField,
  undo: (env) => undoRedo(env, 'undo'),
  redo: (env) => undoRedo(env, 'redo'),
};

/** The tools that only read the PDF: the others change it. */
const READING = new Set(['read_pdf_page', 'find_pdf_text', 'list_pdf_fields']);

/** The text tools name a PDF would be asked for by mistake: they need paragraphs, which a PDF page doesn't have. */
const TEXT_TOOLS = /^(read_document|get_selection|find_text|replace_paragraph|insert_paragraph|delete_paragraph|replace_text|set_style|format_text|add_comment|clear_formatting|change_case|format_paragraph|insert_link|remove_link|insert_break|insert_table|edit_table|set_columns|set_page|insert_equation|list_comments|edit_comment|reply_comment|resolve_comment|delete_comment|count_words)$/;

/** Runs one tool for the model on a PDF shown as its pages. Never throws: problems are the answer. */
export async function runPdfTool(env: PdfAgentEnv, name: string, argumentsJson: string): Promise<string> {
  const tool = Object.hasOwn(TOOLS, name) ? TOOLS[name] : undefined;
  if (!tool) {
    return TEXT_TOOLS.test(name)
      ? `Error: ${name} works on a document with paragraphs, and this is a PDF shown as pages. Use read_pdf_page, find_pdf_text, pdf_markup, pdf_edit_text, pdf_add_text, pdf_add_shape, pdf_page, list_pdf_fields and fill_pdf_field, or convert_document to edit it as Word (which reflows its text).`
      : `Error: there is no tool called ${name}.`;
  }
  if (env.readOnly && !READING.has(name)) return `Error: ${env.readOnly}`;
  try {
    const parsed: unknown = argumentsJson.trim() ? JSON.parse(argumentsJson) : {};
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new ToolError('the arguments must be an object');
    return await tool(env, parsed as Args);
  } catch (e) {
    if (e instanceof ToolError) return `Error: ${e.message}`;
    if (e instanceof SyntaxError) return 'Error: the arguments were not valid JSON.';
    console.error(e);
    return 'Error: that did not work.';
  }
}
