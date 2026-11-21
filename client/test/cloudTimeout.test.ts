// A request that never gets an answer (a connection that went dead under a sleeping computer) gives up instead of waiting for ever.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchWithin } from '../src/cloud.ts';

/** A `fetch` that never answers, but stops when its signal aborts, as the real one does. */
function silentFetch(t: { mock: { method: typeof test.mock.method } }) {
  t.mock.method(globalThis, 'fetch', (_input: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
  );
}

test('a request with no answer gives up as if offline (a TypeError)', async (t) => {
  silentFetch(t);
  await assert.rejects(fetchWithin('/api/documents', undefined, 20), (error: unknown) => error instanceof TypeError && /no answer from the server/.test(error.message));
});

test("the caller's own signal still aborts the request, and is not taken for a timeout", async (t) => {
  silentFetch(t);
  const controller = new AbortController();
  const request = fetchWithin('/api/documents', { signal: controller.signal }, 60_000);
  controller.abort();
  await assert.rejects(request, (error: unknown) => !(error instanceof TypeError));
});

test('an answer that comes in time is returned', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('ok'));
  assert.equal(await (await fetchWithin('/api/documents', undefined, 1000)).text(), 'ok');
});
