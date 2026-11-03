// Admin > Feedback folds a resolved entry down to its sender, date and first line.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { firstLine } from '../src/ui/feedback.ts';

test('firstLine is the first line with something on it, trimmed', () => {
  assert.equal(firstLine('Hello there\nsecond line'), 'Hello there');
  assert.equal(firstLine('\n  \n  Indented start  \nmore'), 'Indented start');
});

test('firstLine is empty for an empty message', () => {
  assert.equal(firstLine(''), '');
  assert.equal(firstLine('\n \n'), '');
});
