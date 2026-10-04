import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TextMark } from '../src/layout/protocol.ts';
import { TextSpell } from '../src/textEditor/spell.ts';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function setup(enabled = true) {
  const asked: string[][] = [];
  let redraws = 0;
  const spell = new TextSpell({
    enabled: () => (enabled ? { spelling: true, grammar: false } : null),
    check: async (texts) => {
      asked.push(texts);
      return { marks: texts.map((t): TextMark[] => (t.includes('teh') ? [{ start: t.indexOf('teh'), end: t.indexOf('teh') + 3, kind: 0 }] : [])), issue: null, loading: false };
    },
    redraw: () => void redraws++,
  });
  spell.reset('a.txt', 'teh sample');
  return { spell, asked, redraws: () => redraws };
}

test('lines are asked for together a moment after they are first seen, and then known', async () => {
  const { spell, asked, redraws } = setup();
  assert.equal(spell.marksOf('teh cat'), undefined);
  assert.equal(spell.marksOf('a dog'), undefined);
  assert.equal(spell.marksOf('teh cat'), undefined);
  await wait(300);
  assert.deepEqual(asked, [['teh cat', 'a dog']]);
  assert.deepEqual(spell.marksOf('teh cat'), [{ start: 0, end: 3, kind: 0 }]);
  assert.deepEqual(spell.marksOf('a dog'), []);
  assert.equal(redraws(), 1);
  spell.marksOf('teh cat');
  await wait(200);
  assert.equal(asked.length, 1);
});

test('data lines, long lines, and a file that is not checked are never asked for', async () => {
  const { spell, asked } = setup();
  assert.equal(spell.marksOf('12345 67890'), undefined);
  assert.equal(spell.marksOf('x'.repeat(2500)), undefined);
  await wait(250);
  assert.deepEqual(asked, []);
  const off = setup(false);
  assert.equal(off.spell.active, false);
  assert.equal(off.spell.marksOf('teh cat'), undefined);
  await wait(250);
  assert.deepEqual(off.asked, []);
});

test('resetting forgets the answers and ignores an answer that arrives late', async () => {
  const { spell, asked } = setup();
  spell.marksOf('teh cat');
  await wait(300);
  assert.ok(spell.marksOf('teh cat'));
  spell.reset('a.txt');
  assert.equal(spell.marksOf('teh cat'), undefined);
  await wait(300);
  assert.equal(asked.length, 2);
});
