// Files the system hands to the phone app: putting a file's pieces together, and taking each file out of the shell's list.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { droppedFromFiles } from '../src/storage/droppedFiles.ts';
import { joinChunks, takeIncoming, type IncomingBridge } from '../src/desktop/incoming.ts';

test('joinChunks puts the base64 pieces back together and stops at the empty one', async () => {
  const bytes = Uint8Array.from({ length: 2500 }, (_, i) => (i * 7) % 256);
  const pieces = [bytes.subarray(0, 999), bytes.subarray(999, 2001), bytes.subarray(2001)].map((p) => Buffer.from(p).toString('base64'));
  const seen: number[] = [];
  const joined = await joinChunks((index) => {
    seen.push(index);
    return pieces[index] ?? '';
  });
  assert.deepEqual(joined, bytes);
  assert.deepEqual(seen, [0, 1, 2, 3]);
  assert.deepEqual(await joinChunks(() => ''), new Uint8Array());
});

test('takeIncoming reads each file, tells the shell it has it, and leaves one that cannot be read', async () => {
  const done: string[] = [];
  const bridge: IncomingBridge = {
    pending: async () => [
      { id: 'a', name: 'a.docx', type: 'application/x', size: 3 },
      { id: 'b', name: 'b.md', type: '', size: 2 },
      { id: 'c', name: 'c.txt', type: 'text/plain', size: 1 },
    ],
    read: async (id) => {
      if (id === 'b') throw new Error('gone');
      return Uint8Array.of(...Buffer.from(id.repeat(3)));
    },
    done: async (id) => void done.push(id),
  };
  const files = await takeIncoming(bridge);
  assert.deepEqual(files.map((f) => f.name), ['a.docx', 'c.txt']);
  assert.equal(await files[0]!.text(), 'aaa');
  assert.equal(files[1]!.type, 'text/plain');
  assert.deepEqual(done, ['a', 'c']);
});

test('one incoming file opens as it is, several are imported, none is nothing', () => {
  const file = (name: string) => new File(['x'], name);
  assert.equal(droppedFromFiles([]), null);
  assert.equal(droppedFromFiles([file('a.docx')])?.kind, 'file');
  const many = droppedFromFiles([file('a.docx'), file('b.md')]);
  assert.equal(many?.kind, 'import');
  assert.equal(many?.kind === 'import' ? many.name : '', 'a.docx, b.md');
});
