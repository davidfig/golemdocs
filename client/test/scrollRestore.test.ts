// The Files sidebar's place across reloads (ui/scrollRestore.ts): the saved scroll waits for rows tall enough to reach it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFilesView, ScrollRestore } from '../src/ui/scrollRestore.ts';

test('the saved position waits until the list can reach it, then is applied once', () => {
  const restore = new ScrollRestore(300);
  const el = { scrollTop: 0, scrollHeight: 200, clientHeight: 100 };
  assert.equal(restore.apply(el), false);
  assert.equal(el.scrollTop, 0);
  assert.equal(restore.pending, true);
  el.scrollHeight = 500;
  assert.equal(restore.apply(el), true);
  assert.equal(el.scrollTop, 300);
  assert.equal(restore.pending, false);
  el.scrollTop = 40;
  assert.equal(restore.apply(el), false);
  assert.equal(el.scrollTop, 40);
});

test('a hidden list is not scrolled, and the person scrolling first cancels it', () => {
  const restore = new ScrollRestore(50);
  assert.equal(restore.apply({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 }), false);
  restore.cancel();
  const el = { scrollTop: 0, scrollHeight: 1000, clientHeight: 100 };
  assert.equal(restore.apply(el), false);
  assert.equal(el.scrollTop, 0);
});

test('nothing to restore at the top or for a bad value', () => {
  for (const target of [null, 0, -5, Number.NaN]) assert.equal(new ScrollRestore(target).pending, false);
});

test('the saved view is read leniently', () => {
  assert.deepEqual(parseFilesView(null), { trash: false, treeScroll: 0, trashScroll: 0 });
  assert.deepEqual(parseFilesView('not json'), { trash: false, treeScroll: 0, trashScroll: 0 });
  assert.deepEqual(parseFilesView('null'), { trash: false, treeScroll: 0, trashScroll: 0 });
  assert.deepEqual(parseFilesView('{"trash":true,"treeScroll":120,"trashScroll":"x"}'), { trash: true, treeScroll: 120, trashScroll: 0 });
});
