// Accessibility choices that follow the account (settingsSync.ts): a value from the account applies live, read from
// storage, and is never written straight back.

import assert from 'node:assert/strict';
import { test } from 'node:test';

const store = new Map<string, string>();
const writes: string[] = [];
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => {
    writes.push(k);
    store.set(k, v);
  },
  removeItem: (k: string) => void store.delete(k),
};

const sr = await import('../src/ui/screenReader.ts');
const caret = await import('../src/ui/accessibilityOptions.ts');

test('Screen Reader Mode from the account turns the mode on and off without writing it back', () => {
  const heard: boolean[] = [];
  sr.onScreenReaderChange((on) => heard.push(on));
  assert.equal(sr.screenReaderOn(), false);
  store.set(sr.SCREEN_READER_KEY, 'on');
  sr.rereadScreenReader();
  assert.equal(sr.screenReaderOn(), true);
  sr.rereadScreenReader();
  store.set(sr.SCREEN_READER_KEY, 'off');
  sr.rereadScreenReader();
  assert.equal(sr.screenReaderOn(), false);
  assert.deepEqual(heard, [true, false], 'listeners hear only real changes');
  assert.deepEqual(writes, []);
});

test('the caret options from the account apply live without writing them back', () => {
  let calls = 0;
  caret.onAccessibilityChange(() => calls++);
  store.set(caret.CARET_WIDTH_KEY, '3');
  store.set(caret.CARET_BLINK_KEY, 'off');
  caret.rereadCaretOptions();
  assert.equal(caret.caretWidth(), 3);
  assert.equal(caret.caretBlinks(), false);
  assert.ok(calls > 0);
  store.set(caret.CARET_WIDTH_KEY, 'junk');
  caret.rereadCaretOptions();
  assert.equal(caret.caretWidth(), 1);
  assert.deepEqual(writes, []);
});
