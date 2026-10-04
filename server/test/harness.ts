// A fake Cloudflare for testing the real worker: R2, the directory D1 and per-user D1 databases
// (node:sqlite running the real migrations behind a stubbed Cloudflare REST API).

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { Env } from '../src/cf.ts';
import worker from '../src/worker.ts';

export const ORIGIN = 'https://app.example.com';
export const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const realFetch = globalThis.fetch;

function fakeDirectory(): { db: DatabaseSync; binding: any } {
  const db = new DatabaseSync(':memory:');
  for (const file of ['0001_users.sql', '0002_auth.sql', '0003_sharing.sql', '0004_feedback.sql', '0005_feedback_resolved.sql', '0006_subscriptions.sql', '0007_assistant_usage.sql', '0008_picture.sql', '0009_catalogue_cache.sql', '0010_doc_index.sql', '0011_owners_backfilled.sql', '0012_catalogue_version.sql', '0013_assistant_reserved_at.sql']) db.exec(readFileSync(new URL(`../migrations/directory/${file}`, import.meta.url), 'utf8'));
  const statement = (sql: string, params: unknown[]): any => ({
    bind: (...values: unknown[]) => statement(sql, values),
    first: async () => (db.prepare(sql).get(...(params as any[])) as any) ?? null,
    run: async () => {
      const result = db.prepare(sql).run(...(params as any[]));
      return { results: [], success: true, meta: { changes: Number(result.changes) } };
    },
    all: async () => ({ results: db.prepare(sql).all(...(params as any[])), success: true, meta: {} }),
  });
  // Like D1's batch: all or none, in order.
  const batch = async (statements: any[]) => {
    const results = [];
    db.exec('BEGIN');
    try {
      for (const s of statements) results.push(await s.run());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return results;
  };
  return { db, binding: { prepare: (sql: string) => statement(sql, []), batch } };
}

export interface World {
  env: Env;
  directory: DatabaseSync;
  /** R2 objects by key. */
  objects: Map<string, { bytes: ArrayBuffer; contentType?: string; etag?: string; customMetadata?: Record<string, string> }>;
  /** A request to the worker, signed in as `as` (the DEV_USER identity; null: not signed in). */
  call(as: string | null, method: string, path: string, init?: { body?: BodyInit; type?: string; headers?: Record<string, string> }): Promise<Response>;
  /**
   * Makes an identity known (so it can be shared with by email); returns its user id. With
   * `subscribed`, they also have an active subscription.
   */
  signUp(email: string, name?: string, options?: { subscribed?: boolean }): Promise<string>;
  /** What reached the (fake) room objects: [document id, path, headers]. */
  roomCalls: { doc: string; path: string; headers: Headers }[];
  /** Work the worker left running after a response (`waitUntil`); a test awaits it to see the end state. */
  background: Promise<unknown>[];
  /** What the fake rooms answer to /state. */
  room: { maySave: boolean };
  restore(): void;
}

/** `local`: as `pnpm dev --local` runs it, with no Cloudflare API to call (any call to it fails the test). `background`: gives the worker an execution context, so what it defers runs after the response, as in production. */
export function world(options: { local?: boolean; background?: boolean } = {}): World {
  const background: Promise<unknown>[] = [];
  const objects: World['objects'] = new Map();
  const userDatabases = new Map<string, DatabaseSync>();
  const databaseNames = new Map<string, string>();
  const directory = fakeDirectory();
  // Each write gets a new etag, as in R2, so a conditional put can tell whether it is still current.
  let writes = 0;
  const bucket: any = {
    async get(key: string) {
      const o = objects.get(key);
      return o && { body: new Blob([o.bytes]).stream(), size: o.bytes.byteLength, httpEtag: `"${o.etag}"`, httpMetadata: { contentType: o.contentType }, customMetadata: o.customMetadata };
    },
    async head(key: string) {
      const o = objects.get(key);
      return o ? { etag: o.etag } : null;
    },
    async put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string>; onlyIf?: { etagMatches?: string } }) {
      const match = options?.onlyIf?.etagMatches;
      if (match !== undefined && objects.get(key)?.etag !== match) return null;
      objects.set(key, { bytes: value, contentType: options?.httpMetadata?.contentType, customMetadata: options?.customMetadata, etag: `etag-${++writes}` });
      return {};
    },
    async list({ prefix }: { prefix: string }) {
      return { objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })), truncated: false };
    },
    async delete(keys: string | string[]) {
      // A real delete is a request to R2, so work deferred past the response (background) finishes
      // after the response is seen, not within the same few microtasks.
      if (options.background) await new Promise((resolve) => setTimeout(resolve, 0));
      for (const key of [keys].flat()) objects.delete(key);
    },
  };
  const roomCalls: World['roomCalls'] = [];
  const room = { maySave: true };
  const rooms: any = {
    idFromName: (name: string) => name,
    get: (doc: string) => ({
      async fetch(request: Request) {
        const path = new URL(request.url).pathname;
        roomCalls.push({ doc, path, headers: request.headers });
        return path === '/state' ? Response.json({ maySave: room.maySave }) : (path === '/document' ? new Response('room') : new Response(null, { status: 204 }));
      },
    }),
  };
  const env: Env = options.local
    ? { DIRECTORY: directory.binding, FILES: bucket, ROOMS: rooms, ENVIRONMENT: 'local', CF_ACCOUNT_ID: '', CF_API_TOKEN: '' }
    : { DIRECTORY: directory.binding, FILES: bucket, ROOMS: rooms, CF_ACCOUNT_ID: 'acct', CF_API_TOKEN: 'tok' };

  // Cloudflare's REST API: create a database, run a query in one.
  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    const url = new URL(String(input));
    if (options.local) throw new Error(`local mode must not call ${url}`);
    const body = init?.body ? JSON.parse(init.body) : {};
    const ok = (result: unknown) => new Response(JSON.stringify({ success: true, errors: [], result }));
    if (url.pathname.endsWith('/d1/database')) {
      // Names are unique, as Cloudflare's are: making one again fails, and it is found by name instead.
      if (!init?.body) {
        const name = url.searchParams.get('name');
        return ok([...databaseNames].filter(([n]) => n === name).map(([n, uuid]) => ({ name: n, uuid })));
      }
      if (databaseNames.has(body.name)) return new Response(JSON.stringify({ success: false, errors: [{ code: 7502, message: 'database already exists' }] }), { status: 400 });
      const uuid = `db-${userDatabases.size + 1}`;
      userDatabases.set(uuid, new DatabaseSync(':memory:'));
      databaseNames.set(body.name, uuid);
      return ok({ uuid });
    }
    const query = /\/d1\/database\/([^/]+)\/query$/.exec(url.pathname);
    if (query) {
      const db = userDatabases.get(query[1]!)!;
      // `batch` runs its statements as one transaction, as D1 does.
      if (body.batch) {
        db.exec('BEGIN');
        try {
          const results = body.batch.map((q: { sql: string; params: unknown[] }) => ({ results: db.prepare(q.sql).all(...q.params) }));
          db.exec('COMMIT');
          return ok(results);
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      }
      return ok([{ results: db.prepare(body.sql).all(...body.params) }]);
    }
    throw new Error(`unexpected request to ${url}`);
  }) as typeof fetch;

  return {
    env,
    directory: directory.db,
    objects,
    roomCalls,
    background,
    room,
    call: (as, method, path, init = {}) =>
      worker.fetch(
        new Request(`${ORIGIN}${path}`, { method, body: init.body, headers: { origin: ORIGIN, ...(init.type ? { 'content-type': init.type } : {}), ...init.headers } }),
        { ...env, DEV_USER: as ?? undefined },
        options.background ? { waitUntil: (work) => void background.push(work) } : undefined,
      ),
    async signUp(email, name, options = {}) {
      const { userIdFor } = await import('../src/auth.ts');
      const userId = await userIdFor(email);
      directory.db
        .prepare('INSERT INTO identities (provider, subject, user_id, email, email_verified, name, created_at, last_login_at) VALUES (?, ?, ?, ?, 1, ?, 0, 0)')
        .run('dev', email, userId, email, name ?? email);
      if (options.subscribed) {
        directory.db
          .prepare("INSERT INTO subscriptions (user_id, polar_id, status, current_period_end, cancel_at_period_end, modified_at, updated_at) VALUES (?, 'sub_test', 'active', ?, 0, 0, 0)")
          .run(userId, Date.now() + 365 * 86400_000);
      }
      return userId;
    },
    restore() {
      globalThis.fetch = realFetch;
    },
  };
}
