// What an action fetches from a site it named in `meta.network` (docs/live-blocks.md §8), made by the app. Small and static:
// the app makes the request, not the live chunk.

/** A request an action makes of a site, and what came back, as plain data. */
export interface ScriptFetch {
  method: string;
  headers: Record<string, string>;
  body: string | null;
}
export interface ScriptResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** The most a response may be (its text). */
export const MAX_FETCH_CHARS = 5_000_000;

/** Fetches for a script with the platform's `fetch`: no cookies, no redirects (which could lead to another site), 20 s at most. */
export async function fetchForScript(url: string, init: ScriptFetch, fetcher: typeof fetch = fetch): Promise<ScriptResponse> {
  const response = await fetcher(url, {
    method: init.method,
    headers: init.headers,
    body: init.body ?? undefined,
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  }).catch((e: unknown) => {
    throw new Error(`${new URL(url).hostname} could not be reached (${(e as Error).message}); a site must allow requests from other pages (CORS) for scripts in the app to use it`);
  });
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => (headers[key] = value));
  return { status: response.status, headers, body: await response.text() };
}
