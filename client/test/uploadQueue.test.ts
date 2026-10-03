// The upload queue (src/uploadQueue.ts): one at a time, kept for later when the account can't be
// reached, and never the same copy by two routes at once (a ZIP import's batch and an ordinary upload).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CloudError } from '../src/cloud.ts';
import { UploadQueue, type UploadHost } from '../src/uploadQueue.ts';

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function queue(send: (id: string) => Promise<void> = async () => {}, over: Partial<UploadHost> = {}) {
  const sent: string[] = [];
  const events: string[] = [];
  const host: UploadHost = {
    enabled: () => true,
    send: async (id) => {
      sent.push(id);
      await send(id);
    },
    settled: () => {},
    noSync: () => events.push('noSync'),
    retry: () => events.push('retry'),
    changed: () => {},
    ...over,
  };
  return { q: new UploadQueue(host, { delayMs: 5, offlineRetryMs: 10 }), sent, events };
}

test('a scheduled upload goes once editing pauses, once however often it was saved, one at a time', async () => {
  let running = 0;
  let most = 0;
  const { q, sent } = queue(async () => {
    most = Math.max(most, ++running);
    await tick(2);
    running--;
  });
  q.schedule('a');
  q.schedule('a');
  q.schedule('b');
  assert.deepEqual(sent, [], 'not before the pause');
  await tick(10);
  await q.flush();
  assert.deepEqual(sent, ['a', 'b']);
  assert.equal(most, 1);
});

test('unreachable, a copy stays queued, the queue says it is offline, and asks to try again later', async () => {
  const { q, sent, events } = queue(async () => {
    throw new TypeError('fetch failed');
  });
  q.add('a', 'b');
  await q.flush();
  assert.deepEqual(sent, ['a'], 'the rest wait too');
  assert.equal(q.offline, true);
  assert.ok(q.pending('a') && q.pending('b'));
  await tick(20);
  assert.deepEqual(events, ['retry']);
});

test('signed out elsewhere, copies wait; refused, the reason is kept; no sync, the app is told', async () => {
  const outcome: Record<string, Error> = { a: new CloudError(401, 'signed out'), b: new CloudError(500, 'disk full'), c: new CloudError(402, 'no sync') };
  const signedOut = queue(async (id) => {
    throw outcome[id]!;
  });
  signedOut.q.add('a', 'b');
  await signedOut.q.flush();
  assert.equal(signedOut.q.signedOut, true);
  assert.ok(signedOut.q.pending('a'));

  const refused = queue(async (id) => {
    throw outcome[id]!;
  });
  refused.q.add('b', 'c');
  await refused.q.flush();
  assert.equal(refused.q.failures.get('b'), 'disk full');
  assert.deepEqual(refused.events, ['noSync']);
});

test('copies held for a batch are not uploaded on their own meanwhile; what the batch did not take goes afterwards', async () => {
  const { q, sent } = queue();
  q.hold('a');
  q.hold('b');
  await q.flush(); // the tab was hidden, say
  assert.deepEqual(sent, [], 'both would make the same document');
  await q.sendBatch(['a', 'b'], async () => ['a']);
  await q.flush();
  assert.deepEqual(sent, ['b']);
});

test('a copy deleted while it waits for its batch is left out of it', async () => {
  const { q } = queue();
  q.hold('a');
  q.hold('b');
  await q.forget(['a']);
  let batched: string[] = [];
  await q.sendBatch(['a', 'b'], async (ids) => ((batched = ids), ids));
  assert.deepEqual(batched, ['b']);
});

test('deleting a copy that is uploading waits for that upload to finish, and nothing starts it again', async () => {
  let finish!: () => void;
  const { q, sent } = queue(() => new Promise<void>((resolve) => (finish = resolve)));
  q.add('a');
  void q.flush();
  await tick();
  assert.equal(q.uploading, 'a');
  let forgotten = false;
  const forgetting = q.forget(['a']).then(() => (forgotten = true));
  await tick();
  assert.equal(forgotten, false);
  finish();
  await forgetting;
  q.add(); // nothing
  await q.flush();
  assert.deepEqual(sent, ['a']);
});
