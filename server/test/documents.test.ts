// The document API's thumbnails end to end: the real worker against a fake R2 and per-user D1
// databases (node:sqlite running the real migrations behind a stubbed Cloudflare REST API).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, test } from 'node:test';
import type { Env } from '../src/cf.ts';
import { USER_MIGRATIONS } from '../src/schema.ts';
import worker from '../src/worker.ts';

const ORIGIN = 'https://app.example.com';
const realFetch = globalThis.fetch;

function fakeDirectory(): any {
  const db = new DatabaseSync(':memory:');
  for (const file of ['0001_users.sql', '0002_auth.sql']) db.exec(readFileSync(new URL(`../migrations/directory/${file}`, import.meta.url), 'utf8'));
  const statement = (sql: string, params: unknown[]): any => ({
    bind: (...values: unknown[]) => statement(sql, values),
    first: async () => (db.prepare(sql).get(...(params as any[])) as any) ?? null,
    run: async () => {
      db.prepare(sql).run(...(params as any[]));
      return { results: [], success: true, meta: {} };
    },
    all: async () => ({ results: db.prepare(sql).all(...(params as any[])), success: true, meta: {} }),
  });
  return { prepare: (sql: string) => statement(sql, []) };
}

/** Objects by key. */
let objects: Map<string, { bytes: ArrayBuffer; contentType?: string }>;
let userDatabases: Map<string, DatabaseSync>;
let env: Env;

function fakeBucket(): any {
  return {
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
}

beforeEach(() => {
  objects = new Map();
  userDatabases = new Map();
  env = { DIRECTORY: fakeDirectory(), FILES: fakeBucket(), CF_ACCOUNT_ID: 'acct', CF_API_TOKEN: 'tok', DEV_USER: 'dev@example.com' };
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
    if (query) {
      const rows = userDatabases.get(query[1]!)!.prepare(body.sql).all(...body.params);
      return ok([{ results: rows }]);
    }
    throw new Error(`unexpected request to ${url}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const call = (method: string, path: string, init: { body?: BodyInit; type?: string } = {}) =>
  worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      body: init.body,
      headers: { origin: ORIGIN, ...(init.type ? { 'content-type': init.type } : {}) },
    }),
    env,
  );

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const create = async () => (await (await call('POST', '/api/documents?name=Doc.docx', { body: new Uint8Array([1, 2, 3]), type: DOCX })).json()) as any;

test('migration 2 adds thumb_at', () => {
  const db = new DatabaseSync(':memory:');
  for (const statements of USER_MIGRATIONS) for (const sql of statements) db.exec(sql);
  assert.ok((db.prepare('PRAGMA table_info(documents)').all() as { name: string }[]).some((c) => c.name === 'thumb_at'));
});

test('a new document has no thumbnail until one is uploaded', async () => {
  const doc = await create();
  assert.equal(doc.thumbAt, null);
  assert.equal((await call('GET', `/api/documents/${doc.id}/thumbnail`)).status, 404);
  assert.equal((await (await call('GET', '/api/documents')).json() as any[])[0].thumbAt, null);
});

test('uploading a thumbnail records when, and serves it back with a long cache for versioned URLs', async () => {
  const doc = await create();
  const image = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
  const put = await call('PUT', `/api/documents/${doc.id}/thumbnail`, { body: image, type: 'image/webp' });
  assert.equal(put.status, 200);
  const updated = (await put.json()) as any;
  assert.equal(typeof updated.thumbAt, 'number');
  assert.equal(updated.updatedAt, doc.updatedAt, 'the document itself is unchanged');
  assert.equal(((await (await call('GET', '/api/documents')).json()) as any[])[0].thumbAt, updated.thumbAt);

  const got = await call('GET', `/api/documents/${doc.id}/thumbnail?v=${updated.thumbAt}`);
  assert.equal(got.headers.get('content-type'), 'image/webp');
  assert.match(got.headers.get('cache-control')!, /immutable/);
  assert.deepEqual([...new Uint8Array(await got.arrayBuffer())], [...image]);
  assert.doesNotMatch((await call('GET', `/api/documents/${doc.id}/thumbnail`)).headers.get('cache-control')!, /immutable/);
});

test('only small images are accepted as thumbnails', async () => {
  const doc = await create();
  const path = `/api/documents/${doc.id}/thumbnail`;
  assert.equal((await call('PUT', path, { body: new Uint8Array([1]), type: 'text/html' })).status, 415);
  assert.equal((await call('PUT', path, { body: new Uint8Array(600 * 1024), type: 'image/png' })).status, 413);
  assert.equal((await call('PUT', path, { body: new Uint8Array(0), type: 'image/png' })).status, 400);
  assert.equal((await call('POST', path, { body: new Uint8Array([1]), type: 'image/png' })).status, 405);
});

test('deleting a document deletes its thumbnail too', async () => {
  const doc = await create();
  await call('PUT', `/api/documents/${doc.id}/thumbnail`, { body: new Uint8Array([1]), type: 'image/png' });
  assert.equal([...objects.keys()].filter((k) => k.endsWith('.thumb')).length, 1);
  assert.equal((await call('DELETE', `/api/documents/${doc.id}`)).status, 204);
  assert.equal(objects.size, 0);
});

test('thumbnails of unknown documents are 404, and need a session', async () => {
  assert.equal((await call('GET', '/api/documents/00000000-0000-4000-8000-000000000000/thumbnail')).status, 404);
  delete env.DEV_USER;
  assert.equal((await call('GET', '/api/documents/00000000-0000-4000-8000-000000000000/thumbnail')).status, 401);
});
