// Links from one document to another stored document, the way a wiki links pages: by title. A link
// is an ordinary hyperlink whose address is `doc:` and the title (`doc:Project Plan`, with `#Section`
// after it when it points into the page). Titles, not ids, so a link means the same in the wiki
// text it was written in, in Markdown (`[plan](doc:Project Plan)`), and after the document is moved
// to another browser or account. The app resolves a title against the documents it has stored.
// The address helpers are in @golemdocs/docx, which the search index reads links with.

import { DOC_SCHEME, MAX_TAG_CHARS, docAddress, parseDocAddress, readTag, tagAddress } from '@golemdocs/docx';

export { DOC_SCHEME, docAddress, parseDocAddress };

/** A title as pages are compared: underscores as spaces, runs of spaces as one, case ignored. */
export const normalizeTitle = (title: string): string => title.replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLocaleLowerCase();

/** A document's file name without its extension: the title other documents link to it by. */
export const titleOfName = (name: string): string => name.replace(/\.[A-Za-z0-9]{1,8}$/, '');

/** Where documents are kept, for links that name a folder: each document's folders from the top level down, and where the linking document is. */
export interface LinkPlaces<T> {
  folderNames(document: T): readonly string[];
  /** The folders of the document the link is in (empty: the top level). */
  from?: readonly string[];
}

/**
 * What a link's title says about where its document is: the `name`, and the `folders` it is in. When `exact`, those run from the top
 * level (`/Notes/Plan`, `../Plan`); otherwise they only have to end the document's folder path (`Notes/Plan`). `from` is the linking
 * document's folders.
 */
export function splitLink(title: string, from: readonly string[] = []): { name: string; folders: string[]; exact: boolean } {
  const parts = title.split('/').map((p) => p.trim());
  const name = parts.pop() ?? '';
  let base: string[] | null = null;
  if (parts.length && parts[0] === '') {
    base = [];
    parts.shift();
  } else if (parts[0] === '.' || parts[0] === '..') {
    base = [...from];
  }
  const folders = base ?? [];
  for (const part of parts) {
    if (part === '..' && base) folders.pop();
    else if (part && !(part === '.' && base)) folders.push(part);
  }
  return { name, folders, exact: base !== null };
}

/**
 * The stored document a link names. A plain title (`Note`) is the first document of that name wherever it is kept, the one in the
 * linking document's folder before one elsewhere, then the one nearest the top level. A title with folders (`Notes/Note`) is the
 * document of that name in a folder path that ends with them (Obsidian's way), `/Notes/Note` one at exactly that path from the top
 * level, and `./Note` or `../Note` are relative to the linking document's folder. `documents` are in order of preference,
 * most recent first.
 */
export function findByTitle<T extends { name: string }>(title: string, documents: readonly T[], places?: LinkPlaces<T>): T | undefined {
  const from = places?.from ?? [];
  const { name, folders, exact } = splitLink(title, from);
  const wanted = normalizeTitle(name);
  const norm = (names: readonly string[]) => names.map(normalizeTitle);
  const folderOf = (d: T) => norm(places?.folderNames(d) ?? []);
  const sameFolder = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  const fits = (d: T): boolean => {
    if (!folders.length && !exact) return true;
    const have = folderOf(d);
    const need = norm(folders);
    return exact ? sameFolder(have, need) : have.length >= need.length && sameFolder(have.slice(have.length - need.length), need);
  };
  const named = (test: (d: T) => boolean) => {
    const matches = documents.filter((d) => test(d) && fits(d));
    if (matches.length < 2) return matches[0];
    // Of several, the one beside the link, else the one nearest the top (ties stay in the order given).
    const here = norm(from);
    return matches.find((d) => sameFolder(folderOf(d), here)) ?? matches.reduce((best, d) => (folderOf(d).length < folderOf(best).length ? d : best));
  };
  return named((d) => normalizeTitle(titleOfName(d.name)) === wanted) ?? named((d) => normalizeTitle(d.name) === wanted);
}

/**
 * An Obsidian-style link at `at` in `text`: `[[Title]]`, `[[Title#Section]]` or `[[Title|label]]`, and the same after a `!` (an embed,
 * which here is a link to the note too). Null when it isn't one: no `]]` on the line, no title, or a Markdown link's text (`[[1]](url)`).
 * `shown` is what the link reads as (the label, else the target as written).
 */
export function readWikiLink(text: string, at: number): { address: string; shown: string; end: number; embed: boolean } | null {
  const embed = text[at] === '!';
  const start = embed ? at + 1 : at;
  if (text[start] !== '[' || text[start + 1] !== '[') return null;
  // The link ends at the first bracket; looking no further than a title can be long keeps a run of "[[" from being searched again and again.
  let close = start + 2;
  while (close < text.length && close < start + 400 && text[close] !== ']' && text[close] !== '[' && text[close] !== '\n') close++;
  if (text[close] !== ']' || text[close + 1] !== ']') return null;
  const body = text.slice(start + 2, close);
  const next = text[close + 2];
  if (next === '(' || next === '[') return null;
  const bar = body.indexOf('|');
  const target = (bar < 0 ? body : body.slice(0, bar)).trim();
  const label = bar < 0 ? '' : body.slice(bar + 1).trim();
  const hash = target.indexOf('#');
  const title = (hash < 0 ? target : target.slice(0, hash)).trim();
  if (!title) return null;
  return { address: docAddress(title, hash < 0 ? undefined : target.slice(hash + 1).trim() || undefined), shown: label || target, end: close + 2, embed };
}

/**
 * How a link to a stored document is written as an Obsidian link, or null when it can't be (it isn't a document link, or its
 * title or label holds a character that would end the link early).
 */
export function wikiLinkText(address: string, label: string): string | null {
  const doc = parseDocAddress(address);
  if (!doc || /[[\]|#\n]/.test(doc.title) || /[[\]|\n]/.test(doc.section) || /[[\]|\n]/.test(label)) return null;
  const target = `${doc.title}${doc.section ? `#${doc.section}` : ''}`;
  return label === target ? `[[${target}]]` : `[[${target}|${label}]]`;
}

/**
 * The address of the Markdown link in `source` that covers `offset`: `[[Note]]`, `[text](url)` or an embed. For a paragraph that is
 * showing its Markdown, whose links are characters and not links, so that they can still be followed.
 */
export function linkInSource(source: string, offset: number): string | null {
  const tag = tagInSource(source, offset);
  if (tag) return tag;
  for (let i = source.indexOf('['); i >= 0 && i <= offset; i = source.indexOf('[', i + 1)) {
    const start = source[i - 1] === '!' ? i - 1 : i;
    const wiki = readWikiLink(source, start);
    if (wiki) {
      if (offset < wiki.end) return wiki.address;
      i = wiki.end - 1;
      continue;
    }
    const m = /^\[[^\]\n]*\]\(<?([^)\s>]+)>?\)/.exec(source.slice(i));
    if (m && offset < i + m[0].length) return m[1];
  }
  return null;
}

/** The `tag:` address of the `#tag` that covers `offset` in `source`, or null when it is in a code span or in a `[text](url)` (which is its own link). */
function tagInSource(source: string, offset: number): string | null {
  const from = Math.max(0, offset - MAX_TAG_CHARS - 1);
  const at = source.lastIndexOf('#', offset);
  if (at < from || at < 0) return null;
  const tag = readTag(source, at);
  if (!tag || offset >= tag.end) return null;
  // Inside a code span (an odd number of backticks on the line before it) or a Markdown link or its address.
  const line = source.slice(source.lastIndexOf('\n', at - 1) + 1, at);
  if (((line.match(/`/g) ?? []).length & 1) === 1) return null;
  for (let i = line.indexOf('['), end = source.indexOf('\n', at); i >= 0; i = line.indexOf('[', i + 1)) {
    const rest = source.slice(source.lastIndexOf('\n', at - 1) + 1 + i, end < 0 ? source.length : end);
    const m = /^\[[^\]\n]*\]\([^)\n]*\)/.exec(rest);
    if (m && source.lastIndexOf('\n', at - 1) + 1 + i + m[0].length > at) return null;
  }
  if (/<[^>\n]*$/.test(line) || /\]\([^)\n]*$/.test(line)) return null;
  return tagAddress(tag.name);
}
