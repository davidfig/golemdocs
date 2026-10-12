// Typing Markdown shortcuts into a Markdown document (see layout/autoformat.ts): `*` works like `-`.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { command, convert, decode, openMarkdown, run, startWorker, stopWorker } from './workerHarness.ts';

before(startWorker);
after(stopWorker);

const md = async (doc: number) => decode(await convert(doc, 'md'));

/** Types text one character at a time, as the keyboard does. */
async function type(doc: number, text: string): Promise<void> {
  for (const ch of text) await run(doc, { kind: 'insertText', text: ch });
}

test('"* " at the start of an empty line starts a bullet list', async () => {
  const doc = await openMarkdown('');
  command(doc, { kind: 'autoFormat', on: true });
  await type(doc, '* hi');
  assert.equal((await md(doc)).trim(), '- hi');
});

test('*word* and **word** make italic and bold as you type', async () => {
  const doc = await openMarkdown('');
  command(doc, { kind: 'autoFormat', on: true });
  await type(doc, '1 *it* and **bold** 2');
  assert.equal((await md(doc)).trim(), '1 *it* and **bold** 2');
});
