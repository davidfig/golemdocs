// Which personal key new encrypted things are made with (src/encryption/session.ts, docs/encrypted-folders.md): only one known to be the
// person's, so a key typed in while nothing encrypted could be checked (offline, say) never starts a second set beside the first. In a file
// of its own: it needs a session that has not seen anything encrypted yet.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeIndexedDB } from './fakeIndexedDB.ts';

(globalThis as { indexedDB: unknown }).indexedDB = fakeIndexedDB();
const session = await import('../src/encryption/session.ts');
const { newPersonalKey, newItemKey } = await import('../src/encryption/crypto.ts');

test('a key typed in while nothing encrypted is known makes no new keys until it is seen to be the person’s', async () => {
  const personal = await newPersonalKey();
  const { wrapped } = await newItemKey(personal);
  const wrong = await newPersonalKey();
  // Nothing encrypted is known yet, so any well-formed key is let in, but not used to encrypt with.
  assert.equal(await session.unlock(wrong.text), 1);
  assert.equal(session.isUnlocked(), true);
  assert.equal(session.currentKey(), null);
  await assert.rejects(session.newKey(), session.LockedError);
  // Once what they encrypted is known, it is not theirs: still none to encrypt with.
  session.knowKey(wrapped);
  assert.equal(await session.confirmKeys(), false);
  await assert.rejects(session.newKey(), session.LockedError);
  // Their own key opens it, and is the one used from then on, though typed in second.
  assert.ok((await session.unlock(personal.text)) > 0);
  assert.equal(session.currentKey()?.text, personal.text);
  const made = await session.newKey();
  assert.ok(await newItemKey(personal).then(() => session.keysOf(made)));
  session.lock();
});

test('a key made here, or typed in with nothing encrypted anywhere, is the person’s once that is known', async () => {
  // A new key (setup) is theirs at once.
  const made = await session.createKey();
  assert.equal(session.currentKey(), made);
  session.lock();
  assert.equal(session.currentKey(), null, 'forgotten when the session locks');
});
