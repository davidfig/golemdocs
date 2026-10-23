// A full account (server/src/storage.ts): the refusal reaches the person in their own words, saying how much an account may keep.
// Run: node --test test/*.test.ts

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACCOUNT_STORAGE_GB } from '@golemdocs/ops';
import { CloudError, createDocument } from '../src/cloud.ts';

function refuseWith(code: string) {
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'your account is full', code }), { status: 507, headers: { 'content-type': 'application/json' } })) as typeof fetch;
}

test('a full account is explained, with its limit', async () => {
  refuseWith('storage-full');
  await assert.rejects(createDocument('Doc.docx', new Uint8Array([1])), (error: unknown) => {
    assert.ok(error instanceof CloudError);
    assert.equal(error.status, 507);
    assert.equal(error.code, 'storage-full');
    assert.match(error.message, new RegExp(`${ACCOUNT_STORAGE_GB} GB`));
    assert.match(error.message, /trash/);
    return true;
  });
});

test("a full owner's account says so, not that yours is full", async () => {
  refuseWith('owner-storage-full');
  await assert.rejects(createDocument('Doc.docx', new Uint8Array([1])), /owner’s account is full/);
});
