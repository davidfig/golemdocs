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
