// SPDX-License-Identifier: MIT
// Links from one document to another stored document, the way a wiki links pages: by title. A link
// is an ordinary hyperlink whose address is `doc:` and the title (`doc:Project Plan`, with `#Section`
// after it when it points into the page). Titles, not ids, so a link means the same in the wiki
// text it was written in, in Markdown (`[plan](doc:Project Plan)`), and after the document is moved
// to another browser or account. The app resolves a title against the documents it has stored.
//
// The search index lists the titles each document links to (see `DocIndex.l`), so that renaming or
// moving a document can find the documents whose links to update without reading them.

import type { Inline, Paragraph } from '../model/types.ts';

export const DOC_SCHEME = 'doc:';

/** What an embedded picture's name (and an embedded note's content control's tag) starts with: `embed:<what was written between the brackets>`. */
export const EMBED_PREFIX = 'embed:';

/**
 * What a live block's content control's tag starts with: `live:<source> stamp=<hash>`, where the source is a document's title
 * and maybe `#` and a part of it (`Budget.xlsx#Expenses`). A live block shows a result computed from that document and kept up
 * to date, so the document counts as linked to (and a rename of it rewrites the tag).
 */
export const LIVE_PREFIX = 'live:';

/**
 * The title a live block's source names: what comes before its part (`#Expenses`) and its options (`?where=…`). A built-in
 * block (`@list:Characters?columns=role`) names no document, so the whole address stands for it.
 */
export function sourceTitle(source: string): string {
  if (/^\s*@/.test(source)) return source.trim();
  const end = source.search(/[#?]/);
  return (end < 0 ? source : source.slice(0, end)).trim();
}

/** The title a live block's tag names, or null when the text is no live block's tag. */
export function liveTitle(tag: string | undefined): string | null {
  if (!tag?.startsWith(LIVE_PREFIX)) return null;
  return sourceTitle(tag.slice(LIVE_PREFIX.length).replace(/ stamp=[0-9a-z]*$/, '')) || null;
}

/** The tag of a content control (a Word sdt), or undefined. */
export function sdtTag(shell: { name: string; children: (string | { name: string; attrs: Record<string, string>; children: unknown[] })[] }): string | undefined {
  if (shell.name !== 'w:sdt') return undefined;
  for (const c of shell.children) {
    if (typeof c === 'string' || c.name !== 'w:sdtPr') continue;
    for (const t of c.children as typeof shell.children) if (typeof t !== 'string' && t.name === 'w:tag') return t.attrs['w:val'];
  }
  return undefined;
}

/** The address of a link to the document called `title`. */
export function docAddress(title: string, section?: string): string {
  return `${DOC_SCHEME}${title}${section ? `#${section}` : ''}`;
}

/** The title and section a `doc:` address names, or null when it is any other kind of address. */
export function parseDocAddress(url: string): { title: string; section: string } | null {
  if (!url.toLowerCase().startsWith(DOC_SCHEME)) return null;
  // Other formats may have escaped spaces and the like in the address (Markdown's %20).
  let rest = url.slice(DOC_SCHEME.length);
  try {
    rest = decodeURIComponent(rest);
  } catch {
    // Not escaped: as written.
  }
  const hash = rest.indexOf('#');
  const title = (hash < 0 ? rest : rest.slice(0, hash)).trim();
  return title ? { title, section: hash < 0 ? '' : rest.slice(hash + 1) } : null;
}

/** The title an embed's body (`Note#Heading|300`, as written between the brackets) names. */
export function embedTitle(body: string): string {
  const bar = body.indexOf('|');
  return sourceTitle(bar < 0 ? body : body.slice(0, bar));
}

/** The titles of the documents a paragraph's inline live blocks show, each once, in order. */
export function liveInlineTitles(paragraph: Paragraph): string[] {
  const found = new Set<string>();
  const walk = (inlines: readonly Inline[]) => {
    for (const inline of inlines) {
      if (inline.kind === 'wrapper') {
        const live = liveTitle(sdtTag(inline.shell));
        if (live) found.add(live);
        else walk(inline.children);
      } else if (inline.kind === 'hyperlink') walk(inline.children);
    }
  };
  walk(paragraph.children);
  return [...found];
}

/** The titles of the documents a paragraph links to (hyperlinks to `doc:` addresses and embedded pictures), each once, in order. */
export function docLinkTitles(paragraph: Paragraph): string[] {
  const found = new Set<string>();
  const walk = (inlines: readonly Inline[]) => {
    for (const inline of inlines) {
      if (inline.kind === 'hyperlink') {
        const doc = inline.url ? parseDocAddress(inline.url) : null;
        if (doc) found.add(doc.title);
        walk(inline.children);
      } else if (inline.kind === 'wrapper') {
        const live = liveTitle(sdtTag(inline.shell));
        if (live) found.add(live);
        walk(inline.children);
      }
      else if (inline.kind === 'run') {
        for (const item of inline.content) {
          if (item.kind !== 'drawing' || !item.name?.startsWith(EMBED_PREFIX)) continue;
          const title = embedTitle(item.name.slice(EMBED_PREFIX.length));
          if (title) found.add(title);
        }
      }
    }
  };
  walk(paragraph.children);
  return [...found];
}

/** An embed's address that only a live block can show (kept in step with isLiveSourceName in the client's live/liveMarks.ts). */
const LIVE_ONLY = /\.(xlsx|xlsm|csv|tsv)\s*(?:[#?]|$)|#\s*(?:table|chart|field):|\.pdf\s*#\s*page:|^\s*@(?:list|count|timeline|run):|^\s*\/?Scripts\/[^?#]+\.m?[tj]s\s*(?:\?|$)/i;

const TEXT_LINK = /!?\[\[([^\]\n]+)\]\]|\]\((doc:[^)\n]+)\)|<!-- golem:live (.+?) -->|data-golem-live="([^"]+)"/gi;

/**
 * The titles a line of a file kept as plain text links to, as it is written there: `[[Title]]` and `![[Title]]` (wiki links and
 * embeds), Markdown's `[words](doc:Title)`, and live block markers (Markdown's comments, HTML's attribute). A Markdown file not
 * yet saved by the app is kept as the text it was uploaded as, so this is how the index knows what it links to.
 */
export function textLinkTitles(line: string): string[] {
  return textTitles(line, false);
}

/** The titles a line of a file kept as plain text names in live block markers (Markdown's comments, HTML's attribute). */
export function textLiveTitles(line: string): string[] {
  return /golem|!\[\[/.test(line) ? textTitles(line, true) : [];
}

function textTitles(line: string, liveOnly: boolean): string[] {
  if (!line.includes('[[') && !line.includes('doc:') && !line.includes('golem')) return [];
  const found = new Set<string>();
  for (const m of line.matchAll(TEXT_LINK)) {
    // A plain embed is a live block's source only when only a live block can show it (Markdown reads it as one).
    if (liveOnly && m[3] === undefined && m[4] === undefined && !(m[1] !== undefined && m[0].startsWith('!') && LIVE_ONLY.test(m[1].split('|')[0]))) continue;
    const title = m[1] !== undefined ? embedTitle(m[1]) : m[2] !== undefined ? parseDocAddress(m[2])?.title : liveTitle(LIVE_PREFIX + (m[3] ?? m[4]).replace(/&amp;/g, '&').replace(/&quot;/g, '"'));
    if (title) found.add(title);
  }
  return [...found];
}
