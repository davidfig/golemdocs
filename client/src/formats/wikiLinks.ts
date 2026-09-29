// Links from one document to another stored document, the way a wiki links pages: by title. A link
// is an ordinary hyperlink whose address is `doc:` and the title (`doc:Project Plan`, with `#Section`
// after it when it points into the page). Titles, not ids, so a link means the same in the wiki
// text it was written in, in Markdown (`[plan](doc:Project Plan)`), and after the document is moved
// to another browser or account. The app resolves a title against the documents it has stored.

export const DOC_SCHEME = 'doc:';

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

/** A title as pages are compared: underscores as spaces, runs of spaces as one, case ignored. */
export const normalizeTitle = (title: string): string => title.replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLocaleLowerCase();

/** A document's file name without its extension: the title other documents link to it by. */
export const titleOfName = (name: string): string => name.replace(/\.[A-Za-z0-9]{1,8}$/, '');

/**
 * The stored document a title names: the first whose name, less its extension, is that title (or, failing
 * that, whose whole name is). `names` are in order of preference, most recent first.
 */
export function findByTitle<T extends { name: string }>(title: string, documents: readonly T[]): T | undefined {
  const wanted = normalizeTitle(title);
  return documents.find((d) => normalizeTitle(titleOfName(d.name)) === wanted) ?? documents.find((d) => normalizeTitle(d.name) === wanted);
}
