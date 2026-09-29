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
  for (const file of ['0001_users.sql', '0002_auth.sql', '0003_sharing.sql']) db.exec(readFileSync(new URL(`../migrations/directory/${file}`, import.meta.url), 'utf8'));
  const statement = (sql: string, params: unknown[]): any => ({
    bind: (...values: unknown[]) => statement(sql, values),
    first: async () => (db.prepare(sql).get(...(params as any[])) as any) ?? null,
    run: async () => {
      db.prepare(sql).run(...(params as any[]));
      return { results: [], success: true, meta: {} };
    },
    all: async () => ({ results: db.prepare(sql).all(...(params as any[])), success: true, meta: {} }),
  });
  return { db, binding: { prepare: (sql: string) => statement(sql, []) } };
}

export interface World {
  env: Env;
  directory: DatabaseSync;
  /** R2 objects by key. */
  objects: Map<string, { bytes: ArrayBuffer; contentType?: string }>;
  /** A request to the worker, signed in as `as` (the DEV_USER identity; null: not signed in). */
  call(as: string | null, method: string, path: string, init?: { body?: BodyInit; type?: string }): Promise<Response>;
  /** Makes an identity known (so it can be shared with by email); returns its user id. */
  signUp(email: string, name?: string): Promise<string>;
  restore(): void;
}

export function world(): World {
  const objects: World['objects'] = new Map();
  const userDatabases = new Map<string, DatabaseSync>();
  const directory = fakeDirectory();
  const bucket: any = {
    async get(key: string) {
      const o = objects.get(key);
      return o && { body: new Blob([o.bytes]).stream(), size: o.bytes.byteLength, httpEtag: '"etag"', httpMetadata: { contentType: o.contentType } };
    },
    async put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string } }) {
      objects.set(key, { bytes: value, contentType: options?.httpMetadata?.contentType });
    },
    async delete(keys: string | string[]) {
      for (const key of [keys].flat()) objects.delete(key);
    },
  };
  const env: Env = { DIRECTORY: directory.binding, FILES: bucket, CF_ACCOUNT_ID: 'acct', CF_API_TOKEN: 'tok' };

  // Cloudflare's REST API: create a database, run a query in one.
  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(init.body) : {};
    const ok = (result: unknown) => new Response(JSON.stringify({ success: true, errors: [], result }));
    if (url.pathname.endsWith('/d1/database')) {
      const uuid = `db-${userDatabases.size + 1}`;
      userDatabases.set(uuid, new DatabaseSync(':memory:'));
      return ok({ uuid });
    }
    const query = /\/d1\/database\/([^/]+)\/query$/.exec(url.pathname);
    if (query) return ok([{ results: userDatabases.get(query[1]!)!.prepare(body.sql).all(...body.params) }]);
    throw new Error(`unexpected request to ${url}`);
  }) as typeof fetch;

  return {
    env,
    directory: directory.db,
    objects,
    call: (as, method, path, init = {}) =>
      worker.fetch(
        new Request(`${ORIGIN}${path}`, { method, body: init.body, headers: { origin: ORIGIN, ...(init.type ? { 'content-type': init.type } : {}) } }),
        { ...env, DEV_USER: as ?? undefined },
      ),
    async signUp(email, name) {
      const { userIdFor } = await import('../src/auth.ts');
      const userId = await userIdFor(email);
      directory.db
        .prepare('INSERT INTO identities (provider, subject, user_id, email, email_verified, name, created_at, last_login_at) VALUES (?, ?, ?, ?, 1, ?, 0, 0)')
        .run('dev', email, userId, email, name ?? email);
      return userId;
    },
    restore() {
      globalThis.fetch = realFetch;
    },
  };
}
