/** An error the Worker reports to the client as `{ error }` with this status. */
export class HttpError extends Error {
  status: number;
  /** Sent as `code` beside the message, when the client needs to tell this refusal from others. */
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Shared by the routes: answers, names, and the lists of ids a batch request carries.

/** A JSON answer, never cached. */
export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
}

/** A name as given, trimmed and at most 255 characters; null when nothing is left. */
export function cleanName(raw: string | null): string | null {
  const name = raw?.trim().slice(0, 255);
  return name ? name : null;
}

/** The ids clients make (UUIDs). */
export const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Most items one batch request may name (BATCH_ITEMS in client/src/cloud.ts). */
export const MAX_BATCH = 500;

/** One item of a batch that did not go through. */
export interface Failure {
  id: string;
  error: string;
}

export const failure = (id: string, error: unknown): Failure => ({ id, error: error instanceof HttpError ? error.message : 'internal error' });

/** The `ids` of a batch request: a list of ids (at most MAX_BATCH), without repeats. */
export function idList(body: unknown, key = 'ids', optional = false): string[] {
  const ids = (body as Record<string, unknown> | null)?.[key];
  if (optional && ids === undefined) return [];
  if (!Array.isArray(ids) || ids.length > MAX_BATCH || !ids.every((id) => typeof id === 'string' && ID.test(id))) throw new HttpError(400, `expected { ${key}: [...] } of at most ${MAX_BATCH} ids`);
  return [...new Set(ids as string[])];
}

/** D1 allows 100 bound values in a statement (developers.cloudflare.com/d1/platform/limits). */
export const IDS_PER_QUERY = 90;

/** `sql` with `(?,?,…)` for each chunk of `ids`, as statements for one `runAll`. */
export const perChunk = (ids: readonly string[], sql: (marks: string) => string, before: unknown[] = []) =>
  Array.from({ length: Math.ceil(ids.length / IDS_PER_QUERY) }, (_, n) => {
    const chunk = ids.slice(n * IDS_PER_QUERY, (n + 1) * IDS_PER_QUERY);
    return { sql: sql(chunk.map(() => '?').join(',')), params: [...before, ...chunk] };
  });
