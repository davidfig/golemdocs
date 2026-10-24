// The room protocol's shared constants (the message types themselves are checked by the compiler).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ROOM_CLOSE } from '../src/multiplayer.ts';

test('room close codes are in the WebSocket application range, distinct, and fixed (they are wire values)', () => {
  const codes = Object.values(ROOM_CLOSE);
  for (const code of codes) assert.ok(code >= 4000 && code <= 4999, `${code} is an application close code`);
  assert.equal(new Set(codes).size, codes.length, 'each reason has its own code');
  assert.deepEqual({ ...ROOM_CLOSE }, { stale: 4002, handoffFailed: 4001, revoked: 4003, badMessage: 4004, replaced: 4005 });
});
