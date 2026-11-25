// Links that open a note of the vault in the app from somewhere else: a chat, a terminal, another notes app, a browser.
//
//   golemdocs://open?vault=<name or path>&file=<path in the vault>[&heading=<heading>][&line=<n>]
//
// The desktop shell is the scheme's handler (desktop/src-tauri/src/link.rs): it keeps each link it is given and the page
// takes them (`linkBridge` in bridge.ts). A Markdown file opened in the app (Open With, a double-click once the app is the
// default) arrives the same way, as `file` with an absolute path. Everything here is pure: the page decides what to open.

import { folderPaths, type CloudFolder } from './vaultPlan.ts';

export const LINK_SCHEME = 'golemdocs';

export interface VaultLink {
  /** The vault's folder name or its full path (`~` for the home folder); left out, the app's own vault. */
  vault?: string;
  /** The file: a path inside the vault (`/` between names), or a full path on this computer. */
  file: string;
  /** A heading in the note, by its text or as a `#slug`; matched loosely (see `headingKey`). */
  heading?: string;
  /** A line of the file, from 1. */
  line?: number;
}

/** Reads a `golemdocs://` link. Null for anything that is not one with a file to open. */
export function parseLink(text: string): VaultLink | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol === 'file:') {
    const file = decodeURIComponent(url.pathname);
    return file ? { file } : null;
  }
  if (url.protocol !== `${LINK_SCHEME}:`) return null;
  // `golemdocs://open?…` has `open` as its host; `golemdocs:open?…` and `golemdocs:///open?…` say the same.
  const action = (url.host || url.pathname.replace(/^\/+/, '')).toLowerCase();
  if (action !== 'open' && action !== '') return null;
  const q = url.searchParams;
  const file = q.get('file') ?? q.get('path') ?? '';
  // `…&file=Note.md#Heading` works too, as an Obsidian or Markdown link would write it (a `#` in a file name is `%23`).
  let heading = q.get('heading') ?? undefined;
  if (!heading && url.hash.length > 1) {
    try {
      heading = decodeURIComponent(url.hash.slice(1));
    } catch {
      heading = url.hash.slice(1);
    }
  }
  if (!file.trim()) return null;
  const vault = q.get('vault')?.trim() || undefined;
  const lineText = q.get('line');
  const line = lineText && /^\d+$/.test(lineText) && Number(lineText) > 0 ? Number(lineText) : undefined;
  return { file, ...(vault && { vault }), ...(heading?.trim() && { heading: heading.trim() }), ...(line && { line }) };
}

// encodeURIComponent leaves ' ( ) ! * as they are; a link pasted into a shell, between single quotes, or into Markdown is safer without them.
const encode = (text: string) => encodeURIComponent(text).replace(/['()!*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** The link that opens `file` of the vault `vault` (its folder name), at `heading` or `line` if given. */
export function makeLink(link: VaultLink): string {
  const parts = [...(link.vault ? [`vault=${encode(link.vault)}`] : []), `file=${encode(link.file)}`];
  if (link.heading) parts.push(`heading=${encode(link.heading)}`);
  if (link.line) parts.push(`line=${link.line}`);
  return `${LINK_SCHEME}://open?${parts.join('&')}`;
}

/** The last name of a folder path. */
export const folderName = (path: string): string => path.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? path;

const trimSlash = (path: string) => (path.length > 1 ? path.replace(/\/+$/, '') : path);

/** The home folder of a vault path (`/Users/me/…` → `/Users/me`), for `~` in a link. Null when it can't be told. */
function homeOf(root: string): string | null {
  const match = /^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)/.exec(root);
  return match ? match[1] : null;
}

/** Whether a link's `vault` names the vault at `root`: its folder name, or its full path (`~/` allowed). Names are compared without regard to case. */
export function vaultMatches(wanted: string | undefined, root: string): boolean {
  if (!wanted) return true;
  const home = homeOf(root);
  const path = trimSlash(wanted.startsWith('~/') && home ? `${home}${wanted.slice(1)}` : wanted);
  if (path.includes('/') || path.includes('\\')) return path === trimSlash(root) || path.toLowerCase() === trimSlash(root).toLowerCase();
  return path.toLowerCase() === folderName(root).toLowerCase();
}

/**
 * The path inside the vault at `root` that a link's `file` names, or null when it is outside it (or tries to leave it).
 * A full path must be under the vault; a relative one has its leading `/` and `./` dropped.
 */
export function pathInVault(file: string, root: string): string | null {
  const base = trimSlash(root);
  const home = homeOf(root);
  let path = file.startsWith('~/') && home ? `${home}${file.slice(1)}` : file;
  if (path === base || path.toLowerCase().startsWith(`${base.toLowerCase()}/`)) path = path.slice(base.length);
  else if (path.startsWith(`${home ?? '\u0000'}/`)) return null; // a full path somewhere else on this computer
  const parts = path.split('/').filter((p) => p && p !== '.');
  if (!parts.length || parts.some((p) => p === '..')) return null;
  return parts.join('/');
}

/** The entry of `entries` for a vault path: the same path, or failing that one that differs only in case or by the `.md` left off. */
export function findInManifest<T extends { path: string }>(entries: readonly T[], path: string): T | null {
  const exact = entries.find((e) => e.path === path);
  if (exact) return exact;
  const lower = path.toLowerCase();
  const loose = (e: T) => e.path.toLowerCase() === lower || e.path.toLowerCase() === `${lower}.md`;
  return entries.find(loose) ?? null;
}

/**
 * The headings a link's section may mean, best first: `Budget`, or `Costs#Budget` (Obsidian's way to name a heading under
 * another), which is its last heading, else the text as a whole. Empty for no section, or a block (`^id`), which is not a heading.
 */
export function sectionHeadings(section: string): string[] {
  const whole = section.replace(/^#+/, '').trim();
  const last = whole.slice(whole.lastIndexOf('#') + 1).trim();
  if (!last || last.startsWith('^')) return [];
  return last === whole ? [whole] : [last, whole];
}

/**
 * What a heading is compared by: its letters and digits, lower case. So `Key Findings`, `#key-findings` (a GitHub or
 * Obsidian anchor) and `key findings:` are the same heading.
 */
export function headingKey(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Which of `headings` (in order) a link's heading means: the first whose key is the same, else the first that starts with it. -1: none. */
export function findHeading(headings: readonly string[], wanted: string): number {
  const key = headingKey(wanted);
  if (!key) return -1;
  const keys = headings.map(headingKey);
  const exact = keys.indexOf(key);
  return exact >= 0 ? exact : keys.findIndex((k) => k.startsWith(key));
}

/**
 * The text a Markdown line shows, for finding its paragraph in the opened note: the heading, list and quote marks, emphasis
 * and link syntax taken off. Empty for a line that shows nothing (blank, a rule, a fence).
 */
export function shownText(line: string): string {
  let text = line.trim();
  if (/^(```|~~~|---+$|\*\*\*+$|___+$|\|?\s*:?-{3,})/.test(text)) return '';
  text = text
    .replace(/^#{1,6}\s+/, '')
    .replace(/^(>\s*)+/, '')
    .replace(/^([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, '')
    .replace(/!?\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
    .replace(/!?\[\[([^\]]*)\]\]/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|==|`)/g, '')
    .replace(/(^|\W)[*_](\S[^*_]*?)[*_](?=\W|$)/g, '$1$2');
  return text.replace(/\s+/g, ' ').trim();
}

/** Lines of a Markdown file before `line` (from 1) that a heading starts, nearest first: where to go when the line itself is not found. */
export function headingsAbove(source: string, line: number): string[] {
  const lines = source.split(/\r?\n/).slice(0, line);
  const out: string[] = [];
  let fenced = false;
  const found: string[] = [];
  for (const l of lines) {
    if (/^\s*(```|~~~)/.test(l)) fenced = !fenced;
    else if (!fenced && /^#{1,6}\s+\S/.test(l)) found.push(shownText(l));
  }
  for (let i = found.length - 1; i >= 0; i--) out.push(found[i]);
  return out;
}

/**
 * The paragraph a link goes to in the opened note (-1: none found). `text`: a paragraph that shows it (from `line`), looked
 * for first; `headings`: headings by name, the first one found wins. `paragraphs` is what each paragraph shows, `heads` the
 * note's headings in order (`paragraph` is an index into `paragraphs`).
 */
export function placeIndex(paragraphs: readonly string[], heads: readonly { text: string; paragraph: number }[], place: { text?: string; headings?: readonly string[] }): number {
  const key = place.text ? headingKey(place.text) : '';
  if (key) {
    const exact = paragraphs.findIndex((p) => headingKey(p) === key);
    if (exact >= 0) return exact;
    // A long line may be cut short or reworded by the conversion: its start is enough.
    const start = key.length >= 8 ? paragraphs.findIndex((p) => headingKey(p).startsWith(key.slice(0, 40))) : -1;
    if (start >= 0) return start;
  }
  for (const wanted of place.headings ?? []) {
    const at = findHeading(heads.map((h) => h.text), wanted);
    if (at >= 0) return heads[at].paragraph;
  }
  return -1;
}

/** The heading the paragraph at `index` is under (the last one at or before it), or null. */
export function headingAt(heads: readonly { text: string; paragraph: number }[], index: number): string | null {
  let found: string | null = null;
  for (const h of heads) {
    if (h.paragraph > index) break;
    found = h.text;
  }
  return found;
}

/**
 * Where "Show in Finder" points for a document or folder: a document's file as the last sync recorded it (`entries`, by any
 * of its `ids`), else the folder it is filed in; a folder's path as the sync spells it. "" is the vault itself.
 */
export function revealPath(
  entries: readonly { id: string; path: string }[],
  folders: readonly CloudFolder[],
  item: { ids: readonly (string | null | undefined)[]; folderId: string | null } | { folderId: string },
): string {
  if ('ids' in item) {
    const found = entries.find((e) => item.ids.includes(e.id));
    if (found) return found.path;
  }
  return item.folderId ? (folderPaths(folders).get(item.folderId) ?? '') : '';
}
