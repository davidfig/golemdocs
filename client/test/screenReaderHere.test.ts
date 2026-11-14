import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SCREEN_READER_KEY, screenReaderHere, screenReaderOn, setScreenReader } from '../src/ui/screenReader.ts';

test('a host turning Screen Reader Mode on for its page leaves the person’s own setting as it was', () => {
  const stored = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v) };
  setScreenReader(true);
  setScreenReader(false);
  assert.equal(localStorage.getItem(SCREEN_READER_KEY), 'off');
  screenReaderHere();
  assert.equal(screenReaderOn(), true);
  assert.equal(localStorage.getItem(SCREEN_READER_KEY), 'off', 'not stored, so it does not follow the account into the app');
  setScreenReader(false);
  delete (globalThis as { localStorage?: unknown }).localStorage;
});
