// Who is signed in (auth.ts): asked of the server, and remembered for when it can't be asked.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { currentUser } from '../src/auth.ts';

const store = new Map<string, string>();
const realFetch = globalThis.fetch;
const realStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
beforeEach(() => {
  store.clear();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  });
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realStorage) Object.defineProperty(globalThis, 'localStorage', realStorage);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
});
const serve = (response: () => Response) => {
  globalThis.fetch = (async () => response()) as typeof fetch;
};
const ann = { id: 'u1', email: 'ann@example.com', name: 'Ann' };

test('the signed-in user is remembered, and offline (or with the server down) is still who it was', async () => {
  serve(() => Response.json({ user: ann }));
  assert.deepEqual(await currentUser(), ann);
  globalThis.fetch = (async () => {
    throw new TypeError('offline');
  }) as typeof fetch;
  assert.deepEqual(await currentUser(), ann);
  serve(() => new Response('down', { status: 503 }));
  assert.deepEqual(await currentUser(), ann);
});

test('an answer that is not the server’s (a captive portal’s page) counts as offline, not as an error', async () => {
  serve(() => Response.json({ user: ann }));
  await currentUser();
  serve(() => new Response('<html>Log in to the Wi-Fi</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
  assert.deepEqual(await currentUser(), ann);
});

test('signed out is remembered too', async () => {
  serve(() => Response.json({ user: ann }));
  await currentUser();
  serve(() => new Response('{}', { status: 401 }));
  assert.equal(await currentUser(), null);
  globalThis.fetch = (async () => {
    throw new TypeError('offline');
  }) as typeof fetch;
  assert.equal(await currentUser(), null);
});
