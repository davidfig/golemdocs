// Remembering each document's scroll position and zoom (src/viewMemory.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { forgetView, loadView, MAX_VIEWS, readViews, saveView, withView, type SavedView } from '../src/viewMemory.ts';

const view = (y = 2000): SavedView => ({ camera: { x: 10, y, zoom: 1.5, reflow: false }, caret: { page: 3, x: 72, y: 100 } });

/** A Storage stand-in. */
function memory(initial?: string) {
  let value = initial ?? null;
  return { getItem: () => value, setItem: (_: string, v: string) => void (value = v) };
}

test('a saved view comes back for the same document and not another', () => {
  const store = memory();
  saveView('local:a', view(), store);
  assert.deepEqual(loadView('local:a', store), view());
  assert.equal(loadView('local:b', store), null);
});

test('saving again replaces the earlier view and puts it first', () => {
  const store = memory();
  saveView('local:a', view(), store);
  saveView('local:b', view(5), store);
  saveView('local:a', view(99), store);
  assert.deepEqual(readViews(store).map(([key]) => key), ['local:a', 'local:b']);
  assert.equal(loadView('local:a', store)?.camera?.y, 99);
});

test('only the most recent views are kept', () => {
  let views: [string, SavedView][] = [];
  for (let i = 0; i < 5; i++) views = withView(views, `local:${i}`, view(), 3);
  assert.deepEqual(views.map(([key]) => key), ['local:4', 'local:3', 'local:2']);
  assert.ok(MAX_VIEWS > 0);
});

test('damaged or missing storage reads as nothing remembered', () => {
  assert.deepEqual(readViews(memory('not json')), []);
  assert.deepEqual(readViews(memory('{"a":1}')), []);
  assert.deepEqual(readViews(memory(JSON.stringify([['x', { camera: { x: 1, y: 2, zoom: 0, reflow: false } }], ['y', { caret: { page: 'a' } }], ['z', view()]]))).map(([k]) => k), ['z']);
  assert.equal(loadView('local:a', null), null);
  assert.doesNotThrow(() => saveView('local:a', view(), null));
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('full'); } };
  assert.equal(loadView('local:a', broken), null);
  assert.doesNotThrow(() => saveView('local:a', view(), broken));
});

test('a view with only a caret, or only a camera, keeps just that part', () => {
  const store = memory();
  saveView('local:a', { caret: { page: 0, x: 1, y: 2 } }, store);
  saveView('local:b', { camera: { x: 0, y: 5, zoom: 1, reflow: true } }, store);
  assert.deepEqual(loadView('local:a', store), { caret: { page: 0, x: 1, y: 2 } });
  assert.deepEqual(loadView('local:b', store), { camera: { x: 0, y: 5, zoom: 1, reflow: true } });
  assert.deepEqual(readViews(memory(JSON.stringify([['k', { camera: { x: 1, y: 2, zoom: 1, reflow: true }, caret: { page: -1, x: 0, y: 0 } }]]))), [['k', { camera: { x: 1, y: 2, zoom: 1, reflow: true } }]]);
});

test('a forgotten view is gone', () => {
  const store = memory();
  saveView('local:a', view(), store);
  forgetView('local:a', store);
  assert.equal(loadView('local:a', store), null);
});
