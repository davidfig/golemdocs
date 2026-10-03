// The address bar: which document it names (`?doc=…`, or a built-in page's own path), setting it as
// documents open (a step Back returns from, or a correction of the current one), and the document
// this browser last had open, to carry on with.

const LAST_DOC_KEY = 'golemdocs.lastDoc';

/** The document last open in this browser (`local:<id>`), to carry on with when the address names none. */
export function lastDoc(): string | null {
  try {
    return localStorage.getItem(LAST_DOC_KEY);
  } catch {
    return null;
  }
}

/** Remembers the document open now as the one to carry on with. */
export function rememberLastDoc(doc: string): void {
  try {
    localStorage.setItem(LAST_DOC_KEY, doc);
  } catch {
    // Storage unavailable: the next visit starts from the newest saved document instead.
  }
}

/** The built-in documents with an address of their own (the welcome text and changelog); the app is at `/` for everything else. (`/privacy` and `/terms` redirect to the plain pages under `/home`, see public/_redirects.) */
const PAGE_PATHS: Record<string, string> = { welcome: '/welcome', changelog: '/changelog' };

/** The built-in document whose own path `path` is, if any. */
export const builtInPageAt = (path: string): string | undefined => Object.keys(PAGE_PATHS).find((id) => PAGE_PATHS[id] === path);

/** The document the address asks for: `?doc=…`, or a page's path. */
export const wantedDoc = (params: URLSearchParams): string | null => params.get('doc') ?? builtInPageAt(location.pathname) ?? null;

/** The document the address names now (`?doc=…` or a page's path), so Back knows whether a step in history changes it. */
let urlDoc: string | null = null;

/** The document the address names now. */
export const addressDoc = (): string | null => urlDoc;

/** Back or Forward already put `doc` in the address: it is what the address names now. */
export function noteAddressDoc(doc: string): void {
  urlDoc = doc;
}

/**
 * Sets the address to `params` at the app's root, or at a page's path when it holds only that built-in document.
 * `push` makes it a step Back returns from (opening another document); otherwise it only corrects the current one.
 * Leaving the Documents screen to open something replaces its history entry, so Back doesn't land on it.
 */
export function setUrl(params: URLSearchParams, push = false): void {
  const doc = params.get('doc');
  const path = doc ? PAGE_PATHS[doc] : undefined;
  if (path) params.delete('doc');
  const url = `${path ?? '/'}${params.size ? `?${params}` : ''}`;
  urlDoc = doc;
  const changed = url !== location.pathname + location.search;
  if (push && history.state?.dashboard) history.replaceState(null, '', url);
  else if (push && changed) history.pushState(null, '', url);
  else history.replaceState(history.state, '', url);
}
