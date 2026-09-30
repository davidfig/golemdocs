import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLatex } from '@word/docx';
import { insertKey, PALETTE, PALETTE_TABS } from '../src/ui/mathPalette.ts';

const key = (tab: keyof typeof PALETTE, tip: string) => PALETTE[tab].find((k) => k.tip === tip)!;

test('a structure key puts the caret in its first slot; selected text goes in the slot', () => {
  const frac = key('structures', '\\frac');
  assert.deepEqual(insertKey('x + ', 4, 4, frac), { value: 'x + \\frac{}{}', caret: 10 });
  assert.deepEqual(insertKey('a+b', 0, 3, frac), { value: '\\frac{a+b}{}', caret: 9 });
  // A symbol key has no slot: the caret goes after it.
  const alpha = key('greek', '\\alpha');
  assert.deepEqual(insertKey('x', 1, 1, alpha), { value: 'x\\alpha ', caret: 8 });
});

test('every key inserts LaTeX that parses without errors, alone and in a slot', () => {
  for (const tab of PALETTE_TABS) {
    assert.ok(PALETTE[tab].length > 5, tab);
    for (const k of PALETTE[tab]) {
      const filled = insertKey('', 0, 0, k).value;
      assert.deepEqual(parseLatex(filled).errors, [], `${tab} ${k.tip}: ${filled}`);
      // With something typed inside it as well.
      assert.deepEqual(parseLatex(insertKey('a', 0, 1, k).value).errors, [], `${tab} ${k.tip} around a`);
    }
  }
});

test('symbol keys show their character, with the command as the tooltip', () => {
  const pi = key('greek', '\\pi');
  assert.equal(pi.label, 'π');
  assert.equal(pi.insert, '\\pi ');
  assert.equal(key('arrows', '\\rightarrow').label, '→');
});
