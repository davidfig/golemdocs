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
  const target = bar < 0 ? body : body.slice(0, bar);
  const hash = target.indexOf('#');
  return (hash < 0 ? target : target.slice(0, hash)).trim();
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
      } else if (inline.kind === 'wrapper') walk(inline.children);
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
