// Built-in blocks (docs/live-blocks.md §7): live blocks worked out from the notes of a folder rather than from one file, set up
// with Insert › Live Block or written by hand. The address says what and where, with options after `?`:
//
//   @list:Characters?columns=role,status&sort=-status&where=status:alive   the notes of a folder (and its subfolders), one row
//                                                                          each: its title, then front matter fields
//   @count:Novel?of=words&goal=50000                                       words of a document or a folder's notes, or the
//                                                                          number of notes in a folder; with a goal, "n / goal"
//   @timeline:History?date=date&columns=place                              notes with a date in their front matter, in order
//
// Like every producer, a result depends only on the files, never on the device or its language: numbers are written as
// 41,200, headers are the field names and the folder's name, and sorting compares the same way everywhere.

import { paragraphText, paragraphsIn } from '@golemdocs/docx';
import type { LiveResult } from './result.ts';
import { MAX_ROWS } from './result.ts';
import type { SourceFile, SourceLookup } from './sources.ts';
import { frontMatterField, readStoredText } from './textSource.ts';
import { parseBuiltin } from './builtinAddress.ts';

/** A note as the blocks read it. */
interface Note {
  title: string;
  frontMatter: string;
  words: number;
}

const stem = (name: string): string => name.replace(/\.[A-Za-z0-9]+$/, '');
const list = (s: string | undefined): string[] => (s ?? '').split(',').map((c) => c.trim()).filter(Boolean);
/** Numbers as every device writes them: 41,200, 3.5. */
const formatNumber = (n: number): string => {
  const [whole, fraction] = String(Math.abs(n)).split('.');
  return `${n < 0 ? '-' : ''}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction ? `.${fraction}` : ''}`;
};
const NUMERIC = /^\s*-?[\d,]*\.?\d+\s*$/;
const asNumber = (s: string): number => Number(s.replace(/,/g, ''));
/** The same order on every device: numbers as numbers, text by its letters (English rules, ignoring case). */
const compare = (a: string, b: string): number => {
  if (NUMERIC.test(a) && NUMERIC.test(b)) return asNumber(a) - asNumber(b);
  if (!a !== !b) return a ? -1 : 1; // Empty last.
  return a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true }) || (a < b ? -1 : a > b ? 1 : 0);
};

async function readNote(file: SourceFile): Promise<Note | null> {
  const stored = await readStoredText(file.bytes, file.name, false).catch(() => null);
  if (!stored) return null;
  let words = 0;
  for (const p of paragraphsIn(stored.doc.body)) words += paragraphText(p).match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu)?.length ?? 0;
  return { title: stem(file.name.split('/').pop() ?? file.name), frontMatter: stored.extensions.md?.frontMatter ?? '', words };
}

async function notesIn(lookup: SourceLookup, path: string): Promise<Note[] | null> {
  const files = await lookup.folder?.(path).catch(() => null);
  if (!files) return null;
  const notes = await Promise.all(files.map(readNote));
  return notes.filter((n): n is Note => n !== null).sort((a, b) => compare(a.title, b.title));
}

const field = (note: Note, key: string): string => (key.toLowerCase() === 'title' ? note.title : (frontMatterField(note.frontMatter, key) ?? ''));

/** `where=status:reading` keeps the notes whose status is reading; `where=status` those that have one. */
function matches(note: Note, where: string | undefined): boolean {
  if (!where) return true;
  const colon = where.indexOf(':');
  const value = field(note, colon < 0 ? where : where.slice(0, colon)).trim();
  return colon < 0 ? value !== '' : value.toLowerCase() === where.slice(colon + 1).trim().toLowerCase();
}

/** A folder's name as a column heading (its last part; the vault's top level has none). */
const folderLabel = (path: string): string => path.split('/').filter((s) => s.trim()).pop()?.trim() ?? '';

function table(rows: string[][]): LiveResult {
  const columns = rows[0]?.length ?? 0;
  const align = Array.from({ length: columns }, (_, c) => {
    const values = rows.slice(1).map((r) => r[c] ?? '').filter((v) => v.trim());
    return values.length && values.every((v) => NUMERIC.test(v)) ? ('right' as const) : ('left' as const);
  });
  return { kind: 'table', rows: rows.slice(0, MAX_ROWS + 1), header: true, align };
}

function sortBy(notes: Note[], key: string | undefined): Note[] {
  if (!key) return notes;
  const desc = key.startsWith('-');
  const name = desc ? key.slice(1) : key;
  return [...notes].sort((a, b) => (desc ? -1 : 1) * compare(field(a, name), field(b, name)) || compare(a.title, b.title));
}

/** A date in front matter, as something that sorts: `2026-11-11`, `2026-11`, `2026`, or a date and time. */
function dateKey(text: string): string | null {
  const m = /^\s*(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?(?:[T\s](\d{1,2}:\d{2}))?/.exec(text);
  if (!m) return null;
  return `${m[1]}-${(m[2] ?? '0').padStart(2, '0')}-${(m[3] ?? '0').padStart(2, '0')} ${m[4]?.padStart(5, '0') ?? ''}`;
}

/** What a built-in block shows. */
export async function builtinResult(source: string, lookup: SourceLookup): Promise<LiveResult> {
  const block = parseBuiltin(source);
  if (!block) return { kind: 'error', code: 'unsupported' };
  const { kind, target, options } = block;
  if (kind === 'count') {
    const of = (options.get('of') || 'words').toLowerCase();
    const goal = options.get('goal');
    let count: number | null = null;
    // A document's words, when the target names one; else the folder's notes.
    if (of === 'words') {
      const file = target ? await lookup(target).catch(() => null) : null;
      const note = file && !file.cycle ? await readNote(file) : null;
      if (note) count = note.words;
    }
    if (count === null) {
      const notes = await notesIn(lookup, target);
      if (!notes) return { kind: 'error', code: 'missing', detail: target };
      const wanted = notes.filter((n) => matches(n, options.get('where')));
      count = of === 'notes' ? wanted.length : of === 'words' ? wanted.reduce((sum, n) => sum + n.words, 0) : null;
      if (count === null) return { kind: 'error', code: 'unsupported' };
    }
    const target_ = goal && NUMERIC.test(goal) ? asNumber(goal) : null;
    return { kind: 'value', text: target_ === null ? formatNumber(count) : `${formatNumber(count)} / ${formatNumber(target_)}` };
  }
  const notes = await notesIn(lookup, target);
  if (!notes) return { kind: 'error', code: 'missing', detail: target };
  const wanted = notes.filter((n) => matches(n, options.get('where')));
  const columns = list(options.get('columns'));
  if (kind === 'list') {
    if (!wanted.length) return { kind: 'error', code: 'empty' };
    const rows = sortBy(wanted, options.get('sort')).map((n) => [n.title, ...columns.map((c) => field(n, c))]);
    return table([[folderLabel(target), ...columns], ...rows]);
  }
  // A timeline: the notes that have a date, oldest first (or newest, with order=desc).
  const date = options.get('date') || 'date';
  const dated = wanted.flatMap((n) => {
    const text = field(n, date);
    const key = dateKey(text);
    return key ? [{ n, text, key }] : [];
  });
  if (!dated.length) return { kind: 'error', code: 'empty' };
  dated.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : compare(a.n.title, b.n.title)));
  if ((options.get('order') ?? '').toLowerCase() === 'desc') dated.reverse();
  return table([[date, folderLabel(target), ...columns], ...dated.map(({ n, text }) => [text.trim(), n.title, ...columns.map((c) => field(n, c))])]);
}
