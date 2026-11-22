// Encrypted folders' cryptography (src/encryption/crypto.ts) and the sealed format it shares with the server (@golemdocs/ops sealed.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSealed, isSealedName, paddedLength, sealedKeyId, wrappedKeyId } from '@golemdocs/ops';
import { formatKey, KeyError, newItemKey, newPersonalKey, openFile, openName, openPersonalKey, parseKey, rewrapItemKey, sealFile, sealName, SealError, unwrapItemKey } from '../src/encryption/crypto.ts';

const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);

test('a personal key is written with its prefix and a checksum, and read back however it is spaced or cased', async () => {
  const raw = Uint8Array.from({ length: 32 }, (_, i) => i * 7);
  const text = await formatKey(raw);
  assert.match(text, /^golem-key-1-([0-9A-HJKMNP-TV-Z]{4}-){14}[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.deepEqual(await parseKey(text), raw);
  assert.deepEqual(await parseKey(`  ${text.toLowerCase().replace(/-/g, ' ')}  `), raw);
  // Crockford's look-alikes are read as digits.
  const prefix = 'golem-key-1-';
  const withLookalikes = prefix + text.slice(prefix.length).replace(/0/g, 'O').replace(/1/g, 'l');
  assert.notEqual(withLookalikes, text, 'the key has a 0 or 1 to swap');
  assert.deepEqual(await parseKey(withLookalikes), raw);
});

test('a mistyped, shortened or foreign key is refused, saying which', async () => {
  const text = await formatKey(Uint8Array.from({ length: 32 }, (_, i) => i));
  const at = text.length - 12;
  const typo = text.slice(0, at) + (text[at] === 'A' ? 'B' : 'A') + text.slice(at + 1);
  await assert.rejects(parseKey(typo), (e: unknown) => e instanceof KeyError && e.problem === 'checksum');
  await assert.rejects(parseKey(text.slice(0, -5)), (e: unknown) => e instanceof KeyError && e.problem === 'format');
  await assert.rejects(parseKey('correct horse battery staple'), (e: unknown) => e instanceof KeyError && e.problem === 'format');
});

test('an item key opens only with the personal key that wrapped it, and its id travels with it', async () => {
  const mine = await newPersonalKey();
  const theirs = await newPersonalKey();
  const { wrapped, keys } = await newItemKey(mine);
  assert.ok((await unwrapItemKey(await openPersonalKey(mine.text), wrapped)) !== null, 'the same key, typed in again');
  assert.equal(await unwrapItemKey(theirs, wrapped), null);
  assert.equal(await unwrapItemKey(mine, 'not!base64'), null);
  assert.equal(wrappedKeyId(wrapped), keys.keyId);
  assert.equal(wrapped.length, 75);
  // Sealed with the keys from creation, opened with the keys unwrapped later.
  const again = (await unwrapItemKey(mine, wrapped))!;
  assert.deepEqual(await openFile(again, await sealFile(keys, bytes(10))), bytes(10));
});

test('a sealed file round-trips, says which key opens it, and hides its exact size', async () => {
  const { keys } = await newItemKey(await newPersonalKey());
  for (const size of [0, 1, 4092, 4093, 100_000, 1_000_000]) {
    const plain = bytes(size, size % 251);
    const sealed = await sealFile(keys, plain);
    assert.ok(isSealed(sealed));
    assert.equal(sealedKeyId(sealed), keys.keyId);
    assert.equal(sealed.byteLength, 4 + 16 + 12 + paddedLength(size) + 16);
    assert.deepEqual(await openFile(keys, sealed), plain);
  }
  // Two saves of the same bytes look different.
  assert.notDeepEqual(await sealFile(keys, bytes(50)), await sealFile(keys, bytes(50)));
});

test('a sealed file that was changed, or relabelled as another key’s, does not open', async () => {
  const me = await newPersonalKey();
  const { keys } = await newItemKey(me);
  const { keys: other } = await newItemKey(me);
  const sealed = await sealFile(keys, bytes(100));
  const flipped = sealed.slice();
  flipped[60]! ^= 1;
  await assert.rejects(openFile(keys, flipped), SealError);
  await assert.rejects(openFile(other, sealed), SealError, 'another item’s keys');
  // Relabelled as the other key's: the key id is authenticated, so it still does not open.
  const relabelled = sealed.slice();
  relabelled.set((await sealFile(other, bytes(1))).subarray(4, 20), 4);
  await assert.rejects(openFile(other, relabelled), SealError);
  await assert.rejects(openFile(keys, bytes(200)), SealError, 'not sealed at all');
});

test('a sealed name round-trips, is in the shape the server accepts, and hides its exact length', async () => {
  const { keys } = await newItemKey(await newPersonalKey());
  for (const name of ['', 'Plan.docx', 'Résumé – 2027 (final).docx', '日本語のファイル名.md', 'x'.repeat(255)]) {
    const sealed = await sealName(keys, name);
    assert.ok(isSealedName(sealed), sealed);
    assert.ok(!sealed.includes(name) || name === '');
    assert.equal(await openName(keys, sealed), name);
  }
  assert.equal((await sealName(keys, 'a')).length, (await sealName(keys, 'abcdefghij')).length, 'short names look alike');
  await assert.rejects(openName(keys, 'Plan.docx'), SealError);
});

test('changing the key: an item key rewrapped by a new personal key opens with it, and the files it sealed still open', async () => {
  const old = await newPersonalKey();
  const next = await newPersonalKey();
  const { wrapped, keys } = await newItemKey(old);
  const sealed = await sealFile(keys, bytes(30));
  const rewrapped = (await rewrapItemKey(old, next, wrapped))!;
  assert.equal(await unwrapItemKey(old, rewrapped), null);
  assert.deepEqual(await openFile((await unwrapItemKey(next, rewrapped))!, sealed), bytes(30));
  assert.equal(await rewrapItemKey(next, old, wrapped), null, 'only the key that wrapped it can rewrap it');
});

test('the padded length: 4 KiB at least, then 16 steps per doubling', () => {
  assert.equal(paddedLength(0), 4096);
  assert.equal(paddedLength(4092), 4096);
  assert.equal(paddedLength(4093), 4352);
  for (const n of [5000, 70_000, 3_000_000]) {
    const padded = paddedLength(n);
    assert.ok(padded >= n + 4 && padded <= (n + 4) * 1.0625 + 1, `${n} → ${padded}`);
  }
});
