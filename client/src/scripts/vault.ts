// What a script asks the app for, answered from the vault and checked against what it asked for in `meta` (docs/live-blocks.md
// §8): notes in a folder, one note, a sheet's range, another producer's result, and, for an action, documents to change. An
// action's edits are applied here, to the stored documents, once the run has ended: through the document model, so a note
// keeps its formatting, lists and front matter around what changed.

import { paragraphText, paragraphsIn } from '@golemdocs/docx';
import type { Block, WordDocument } from '@golemdocs/docx';
import { adoptBlocks } from '../formats/embeds.ts';
import { documentToMarkdown, markdownToDocument } from '../formats/markdown.ts';
import type { LiveResult } from '../live/result.ts';
import { frontMatterField, readStoredText } from '../live/textSource.ts';
import type { StoredText } from '../live/textSource.ts';
import { normalizeFolder, within } from './host.ts';
import type { ScriptMeta } from './host.ts';
import { isScriptPath } from './link.ts';
import type { RunMode, ScriptEdit, ScriptEditOp } from './runtime.ts';
import { MAX_FETCH_CHARS } from './fetch.ts';
import type { ScriptFetch, ScriptResponse } from './fetch.ts';

export type { ScriptFetch, ScriptResponse } from './fetch.ts';

export interface VaultFile {
  /** Its path in the vault: its folders and name, `Books/Dune.md`. */
  path: string;
  bytes: Uint8Array;
}

/** The vault as scripts see it, from the app (or a folder on disk, for the command line). */
export interface ScriptVault {
  /** The documents in a folder and its subfolders ('' for the whole vault); null when there is no such folder. */
  list(folder: string): Promise<VaultFile[] | null>;
  /** The document at a path, or null. */
  file(path: string): Promise<VaultFile | null>;
  /** What a live block of this address shows (a range of a sheet, another script's result). */
  produce(address: string): Promise<LiveResult>;
  /** Fetches from a site (an action that asked for it); missing where scripts can't use the network. */
  fetch?(url: string, init: ScriptFetch): Promise<ScriptResponse>;
}


/** A note as a script sees it. */
export interface NoteData {
  path: string;
  title: string;
  /** Its text as Markdown (front matter left out). */
  text: string;
  /** Its front matter's fields, as text. */
  fields: Record<string, string>;
}

const stem = (path: string): string => path.split('/').pop()!.replace(/\.[^.]+$/, '');

/** The fields of front matter, as text (a list's items joined by commas, as blocks show them). */
export function frontMatterFields(frontMatter: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of frontMatter.split(/\r?\n/)) {
    const m = /^([^\s:#][^:]*):/.exec(line);
    if (!m) continue;
    const key = m[1].trim();
    const value = frontMatterField(frontMatter, key);
    if (value !== null && !(key in fields)) fields[key] = value;
  }
  return fields;
}

/** A stored document as a note a script reads; null when it is not a text document. */
export async function noteData(file: VaultFile): Promise<NoteData | null> {
  const stored = await readStoredText(file.bytes, file.path.split('/').pop()!, false).catch(() => null);
  if (!stored) return null;
  return { path: file.path, title: stem(file.path), text: documentToMarkdown(stored.doc), fields: frontMatterFields(stored.extensions.md?.frontMatter ?? '') };
}

/** A result as plain data for a script: a table's rows, a value's text. */
function plainResult(result: LiveResult): unknown {
  switch (result.kind) {
    case 'table':
      return { kind: 'table', rows: result.rows, header: result.header };
    case 'value':
      return { kind: 'value', text: result.text };
    case 'blocks':
      return { kind: 'text', text: paragraphsIn(result.blocks).map(paragraphText).join('\n') };
    case 'picture':
      return { kind: 'picture', width: result.width, height: result.height };
    case 'error':
      throw new Error(result.detail ? `${result.code}: ${result.detail}` : result.code);
  }
}

/** Answers one run's requests; `read` records what it read (a producer's block depends on it). */
export class ScriptRequests {
  /** The folders and files the run read, and the scripts whose results it used. */
  readonly read = new Set<string>();

  constructor(
    private readonly vault: ScriptVault,
    private readonly mode: RunMode,
  ) {}

  private canRead(path: string, meta: ScriptMeta): void {
    if (!within(path, [...meta.reads, ...meta.writes])) throw new Error(`${meta.name} did not ask to read ${path || 'the whole vault'}: add it to \`reads\` in its meta`);
  }

  async handle(op: string, args: unknown[], meta: ScriptMeta): Promise<unknown> {
    const arg = typeof args[0] === 'string' ? args[0] : '';
    switch (op) {
      case 'notes': {
        const folder = normalizeFolder(arg);
        this.canRead(folder, meta);
        this.read.add(`${folder}/`);
        const files = await this.vault.list(folder);
        if (!files) throw new Error(`There is no folder ${folder}`);
        // Scripts are code, not notes.
        const notes = await Promise.all(files.filter((f) => !isScriptPath(f.path)).map(noteData));
        return notes.filter((n): n is NoteData => n !== null).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      }
      case 'read': {
        const path = normalizeFolder(arg);
        this.canRead(path, meta);
        this.read.add(path);
        const file = await this.vault.file(path);
        return file ? noteData(file) : null;
      }
      case 'sheet': {
        const path = normalizeFolder(arg.split('#')[0]);
        this.canRead(path, meta);
        this.read.add(path);
        return plainResult(await this.vault.produce(arg));
      }
      case 'result': {
        const path = normalizeFolder(arg);
        if (!isScriptPath(path)) throw new Error(`${path} is not a script`);
        this.read.add(path);
        return plainResult(await this.vault.produce(path));
      }
      case 'fetch': {
        if (this.mode !== 'act') throw new Error('A producer cannot use the network: its block must show the same for the same files');
        let url: URL;
        try {
          url = new URL(arg);
        } catch {
          throw new Error(`${arg} is not an address`);
        }
        if (url.protocol !== 'https:') throw new Error(`Scripts fetch only https:// addresses, not ${arg}`);
        if (!(meta.network ?? []).includes(url.hostname.toLowerCase())) throw new Error(`${meta.name} did not ask to fetch from ${url.hostname}: add it to \`network\` in its meta`);
        if (!this.vault.fetch) throw new Error('Scripts cannot use the network here');
        const raw = (args[1] && typeof args[1] === 'object' ? args[1] : {}) as Partial<ScriptFetch>;
        const headers = Object.fromEntries(Object.entries(raw.headers && typeof raw.headers === 'object' ? raw.headers : {}).map(([k, v]) => [String(k), String(v)]));
        const response = await this.vault.fetch(url.href, { method: typeof raw.method === 'string' ? raw.method.toUpperCase() : 'GET', headers, body: typeof raw.body === 'string' ? raw.body : null });
        if (response.body.length > MAX_FETCH_CHARS) throw new Error(`${url.hostname} sent back more than a script may read`);
        return response;
      }
      case 'open': {
        if (this.mode !== 'act') throw new Error('A producer cannot open documents to change them');
        const path = normalizeFolder(arg);
        if (!within(path, meta.writes)) throw new Error(`${meta.name} did not ask to change ${path}: add its folder to \`writes\` in its meta`);
        const file = await this.vault.file(path);
        if (file) {
          const note = await noteData(file);
          if (!note) throw new Error(`${path} is not a text document`);
          return { ...note, exists: true };
        }
        if (!args[1]) throw new Error(`There is no document ${path}`);
        if (!/\.md$/i.test(path)) throw new Error(`A new document is a Markdown note: ${path} should end in .md`);
        return { path, title: stem(path), text: '', fields: {}, exists: false };
      }
    }
    throw new Error(`Scripts cannot ${op}`);
  }
}

// --- Applying an action's edits -------------------------------------------------------------

/** Front matter with a field set (or removed, for null), the rest as it was. */
export function setFrontMatterField(frontMatter: string, key: string, value: string | null): string {
  const lines = frontMatter ? frontMatter.split(/\r?\n/) : [];
  const wanted = key.trim().toLowerCase();
  const start = lines.findIndex((l) => {
    const m = /^([^\s:#][^:]*):/.exec(l);
    return m !== null && m[1].trim().toLowerCase() === wanted;
  });
  const written = value === null ? [] : [`${key.trim()}: ${/^[\w .,/@+-]*$/.test(value) && value.trim() === value && value !== '' ? value : JSON.stringify(value)}`];
  if (start < 0) return [...lines, ...written].join('\n');
  // The field's own lines: its line and the indented ones under it.
  let end = start + 1;
  while (end < lines.length && /^(\s+\S|-\s)/.test(lines[end])) end++;
  return [...lines.slice(0, start), ...written, ...lines.slice(end)].join('\n');
}

/** Where a heading's section is in the body: the heading's index and the index after its last block; null when it is not there. */
function sectionOf(doc: WordDocument, heading: string): { at: number; end: number } | null {
  const wanted = heading.trim().replace(/^#+\s*/, '').toLowerCase();
  // As sections are found for a block's address (embeds.ts sectionOf): by the heading styles.
  const level = (block: Block): number | null => (block.kind === 'paragraph' ? Number(/^Heading([1-6])$/.exec(block.properties.style ?? '')?.[1] ?? 0) || null : null);
  const at = doc.body.findIndex((b) => level(b) !== null && paragraphText(b as Extract<Block, { kind: 'paragraph' }>).trim().toLowerCase() === wanted);
  if (at < 0) return null;
  const own = level(doc.body[at])!;
  let end = at + 1;
  while (end < doc.body.length) {
    const l = level(doc.body[end]);
    if (l !== null && l <= own) break;
    end++;
  }
  return { at, end };
}

async function blocksFor(markdown: string, into: WordDocument): Promise<Block[]> {
  const from = await markdownToDocument(markdown);
  return adoptBlocks(from, from.body, into) ?? [];
}

/** A list's kind at its first level: bullets or numbers (by the format), or null for a paragraph not in a list. */
function listKind(doc: WordDocument, block: Block | undefined): string | null {
  if (block?.kind !== 'paragraph' || !block.properties.numbering?.id) return null;
  const instance = doc.numbering.instances.find((n) => n.id === block.properties.numbering!.id);
  const abstract = doc.numbering.abstracts.find((a) => a.id === instance?.abstractId);
  const format = abstract?.levels.find((l) => l.level === 0)?.format ?? 'bullet';
  return format === 'bullet' ? 'bullet' : 'number';
}

/** Puts blocks in at `at`; a list that starts them goes on with a list of the same kind just before (`- two` under `- one`). */
function insertBlocks(doc: WordDocument, at: number, blocks: Block[]): void {
  const before = doc.body[at - 1];
  const kind = listKind(doc, before);
  const first = blocks[0];
  if (kind && kind === listKind(doc, first) && before.kind === 'paragraph' && first.kind === 'paragraph') {
    const from = first.properties.numbering!.id;
    const to = before.properties.numbering!.id;
    for (const block of blocks) if (block.kind === 'paragraph' && block.properties.numbering?.id === from) block.properties = { ...block.properties, numbering: { ...block.properties.numbering, id: to } };
  }
  doc.body.splice(at, 0, ...blocks);
}

/** Applies an action's changes to one stored document, in order. */
export async function applyOps(stored: StoredText, ops: readonly ScriptEditOp[], path: string): Promise<void> {
  const doc = stored.doc;
  for (const op of ops) {
    switch (op.op) {
      case 'append':
        insertBlocks(doc, doc.body.length, await blocksFor(op.markdown, doc));
        break;
      case 'prepend':
        doc.body.unshift(...(await blocksFor(op.markdown, doc)));
        break;
      case 'replace':
        doc.body = await blocksFor(op.markdown, doc);
        break;
      case 'setField': {
        if (!stored.extensions.md && !/\.md$/i.test(path)) throw new Error(`${path}: only a Markdown note has fields`);
        const md = stored.extensions.md ?? {};
        stored.extensions.md = { ...md, frontMatter: setFrontMatterField(md.frontMatter ?? '', op.key, op.value) };
        break;
      }
      case 'appendToSection':
      case 'replaceSection': {
        const section = sectionOf(doc, op.heading);
        if (!section) throw new Error(`${path} has no heading “${op.heading}”`);
        const blocks = await blocksFor(op.markdown, doc);
        if (op.op === 'appendToSection') insertBlocks(doc, section.end, blocks);
        else doc.body.splice(section.at + 1, section.end - section.at - 1, ...blocks);
        break;
      }
    }
  }
  if (!doc.body.length) doc.body.push({ kind: 'paragraph', properties: {}, children: [], attrs: {} });
}

/** One document an action changed: what it was (null when the run made it) and what it is now. */
export interface ChangedFile {
  path: string;
  before: Uint8Array | null;
  after: Uint8Array;
}

/**
 * The new bytes of every document an action changed, its edits checked against what it asked for. Nothing is written here:
 * the caller stores them all, or none when one fails.
 */
export async function editedFiles(edits: readonly ScriptEdit[], meta: ScriptMeta, vault: Pick<ScriptVault, 'file'>): Promise<ChangedFile[]> {
  const out: ChangedFile[] = [];
  for (const edit of edits) {
    const path = normalizeFolder(edit.path);
    if (!within(path, meta.writes)) throw new Error(`${meta.name} did not ask to change ${path}`);
    if (!edit.ops.length && !edit.create) continue;
    const existing = await vault.file(path);
    if (!existing && !edit.create) throw new Error(`There is no document ${path}`);
    if (!existing && !/\.md$/i.test(path)) throw new Error(`A new document is a Markdown note: ${path} should end in .md`);
    const name = path.split('/').pop()!;
    const stored = await readStoredText(existing?.bytes ?? new Uint8Array(), name, false);
    if (!stored) throw new Error(`${path} is not a text document`);
    await applyOps(stored, edit.ops, path);
    out.push({ path, before: existing?.bytes ?? null, after: await stored.store(await stored.doc.write()) });
  }
  return out;
}

/** A script's result as a live block's: a `markdown` result becomes blocks; others are checked. */
export async function scriptResult(value: unknown): Promise<LiveResult> {
  const result = (value && typeof value === 'object' ? value : { kind: 'value', text: value === null || value === undefined ? '' : String(value) }) as Record<string, unknown>;
  if (result.kind === 'table' && Array.isArray(result.rows)) {
    const rows = (result.rows as unknown[]).map((r) => (Array.isArray(r) ? r.map((c) => (c === null || c === undefined ? '' : String(c))) : [String(r)]));
    if (!rows.length) return { kind: 'error', code: 'empty' };
    const columns = rows.reduce((m, r) => Math.max(m, r.length), 0);
    const numeric = (c: number) => rows.slice(result.header ? 1 : 0).every((r) => !r[c] || /^\s*-?[\d,]*\.?\d+\s*$/.test(r[c]));
    return { kind: 'table', rows, header: result.header === true, align: Array.from({ length: columns }, (_, c) => (numeric(c) ? 'right' : 'left')) };
  }
  if (result.kind === 'value') return { kind: 'value', text: String(result.text ?? '') };
  if (result.kind === 'markdown') {
    const from = await markdownToDocument(String(result.markdown ?? ''));
    return from.body.length ? { kind: 'blocks', blocks: from.body, from, pictures: {} } : { kind: 'error', code: 'empty' };
  }
  return { kind: 'error', code: 'unsupported', detail: 'a script gives table(), value(), markdown() or list()' };
}
