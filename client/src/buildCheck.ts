// Finds out whether the site has been updated since this page was loaded. The build writes
// `build.json` (`{ "id": "<build id>" }`) next to the page, and the page was built knowing its own id
// (`__BUILD_ID__`, empty in development, where nothing is checked).

/** How often an open page asks, and the least time between two asks (a tab coming back to the front asks at once, unless it just did). */
export const CHECK_EVERY_MS = 10 * 60 * 1000;
export const CHECK_MIN_GAP_MS = 60 * 1000;

/** The id of the build the site serves now; null when it can't be told (offline, a server error, or a reply that isn't the file). */
export async function fetchBuildId(fetcher: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await fetcher('/build.json', { cache: 'no-store' });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const id = typeof body === 'object' && body !== null ? (body as { id?: unknown }).id : undefined;
    return typeof id === 'string' && id !== '' ? id : null;
  } catch {
    return null; // the single-page fallback answers a missing file with the page itself, which isn't JSON
  }
}

/** True when the site serves a different build than `running`. A page with no id (development) is never out of date. */
export async function isOutOfDate(running: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  if (running === '') return false;
  const latest = await fetchBuildId(fetcher);
  return latest !== null && latest !== running;
}

/**
 * What each browser says when a script can't be loaded: WebKit, Chromium and Firefox for a page in place of a script (the single-page
 * fallback answers a chunk that is gone with the page), and Vite for a chunk's stylesheet. A worker whose own script can't be loaded often says nothing at all.
 */
const SCRIPT_LOAD_FAILURE = /not a valid JavaScript MIME type|Importing a module script failed|dynamically imported module|Expected a JavaScript|disallowed MIME type|Unable to preload CSS/i;

/**
 * True when `message` is a script failing to load and the site has moved on from `running`: the page is asking for a chunk the deploy removed,
 * and only the new version can help. The check of the site tells this from being offline, which reads the same in some browsers.
 */
export async function isChunkOfOldBuild(message: string, running: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  if (message !== '' && !SCRIPT_LOAD_FAILURE.test(message)) return false;
  return isOutOfDate(running, fetcher);
}

/**
 * What update to tell the person about: a new version of the desktop app (installing it restarts the app, which loads the current
 * site too, so it is the one message), the site alone (a reload), or none. `appUpdate` is absent in a browser; one that can't be asked
 * (offline, say) counts as no update of the app.
 */
export async function updateToOffer(running: string, appUpdate?: () => Promise<boolean>, fetcher: typeof fetch = fetch): Promise<'app' | 'site' | null> {
  if (appUpdate && (await appUpdate().catch(() => false))) return 'app';
  return (await isOutOfDate(running, fetcher)) ? 'site' : null;
}
