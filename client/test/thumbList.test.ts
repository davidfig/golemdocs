// The pages panel's list: where items sit, worked out from page sizes, and which a scrolled-to band holds.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { itemTops, itemsBetween } from '../src/ui/thumbList.ts';

const letter = { width: 612, height: 792 };
const landscape = { width: 792, height: 612 };

test('items are stacked from the page sizes: a thumbnail of the page\'s shape plus what is around it', () => {
  const tops = itemTops([letter, landscape, letter], 100, 36, 10);
  const tall = (100 * 792) / 612 + 36;
  const wide = (100 * 612) / 792 + 36;
  assert.equal(tops[0], 10);
  assert.ok(Math.abs(tops[1] - (10 + tall)) < 1e-9);
  assert.ok(Math.abs(tops[2] - (10 + tall + wide)) < 1e-9);
  assert.ok(Math.abs(tops[3] - (10 + 2 * tall + wide)) < 1e-9, 'and where the last ends');
});

test('the array is reused while it is long enough, so pages arriving make no garbage', () => {
  const first = itemTops([letter, letter], 100, 36, 10);
  assert.equal(itemTops([letter, letter, letter], 100, 36, 10, first), first);
  const many = Array.from({ length: first.length + 5 }, () => letter);
  assert.notEqual(itemTops(many, 100, 36, 10, first), first, 'a longer list gets a new one');
});

test('the items in a band are the ones any part of lies in it', () => {
  const pages = Array.from({ length: 1000 }, () => letter);
  const tops = itemTops(pages, 100, 36, 10);
  const step = tops[1] - tops[0];
  // A band from the middle of item 10 to the middle of item 12.
  assert.deepEqual(itemsBetween(tops, 1000, tops[10] + step / 2, tops[12] + step / 2), { first: 10, last: 13 });
  assert.deepEqual(itemsBetween(tops, 1000, -500, 0), { first: 0, last: 0 }, 'above the list: none');
  assert.deepEqual(itemsBetween(tops, 1000, tops[998], 1e9), { first: 998, last: 1000 }, 'to the end');
  assert.deepEqual(itemsBetween(tops, 0, 0, 100), { first: 0, last: 0 }, 'no pages');
});
