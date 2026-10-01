import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dropSlot, moveTarget } from '../src/ui/pageOrder.ts';

test('a pointer above a page\'s middle drops before it, below drops after it', () => {
  const centers = [50, 150, 250];
  assert.equal(dropSlot(centers, 0), 0);
  assert.equal(dropSlot(centers, 49), 0);
  assert.equal(dropSlot(centers, 51), 1);
  assert.equal(dropSlot(centers, 160), 2);
  assert.equal(dropSlot(centers, 999), 3, 'below the last page is after it');
  assert.equal(dropSlot([], 10), 0);
});

test('dropping a page into a gap gives its index in the new order', () => {
  assert.equal(moveTarget(0, 3), 2, 'first page to the end');
  assert.equal(moveTarget(2, 0), 0, 'last page to the start');
  assert.equal(moveTarget(1, 1), 1, 'into the gap above itself: no change');
  assert.equal(moveTarget(1, 2), 1, 'into the gap below itself: no change');
  assert.equal(moveTarget(1, 3), 2);
});
