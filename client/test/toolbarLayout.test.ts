import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { cloneLayout, DEFAULT_LAYOUT, loadLayout, saveLayout, SEPARATOR, toolbarTitle } from '../src/ui/toolbarLayout.ts';

const store = new Map<string, string>();
let broken = false;
const real = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
beforeEach(() => {
  store.clear();
  broken = false;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => {
        if (broken) throw new Error('blocked');
        return store.get(k) ?? null;
      },
      setItem: (k: string, v: string) => {
        if (broken) throw new Error('blocked');
        store.set(k, v);
      },
    },
  });
});
afterEach(() => {
  if (real) Object.defineProperty(globalThis, 'localStorage', real);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
});

const all = () => true;

test('with nothing saved, the default layout comes back as copies', () => {
  const layout = loadLayout(all);
  assert.deepEqual(layout, DEFAULT_LAYOUT);
  layout[0].items.push('x');
  assert.ok(!DEFAULT_LAYOUT[0].items.includes('x'), 'editing the loaded layout leaves the defaults alone');
});

test('a saved layout is loaded back', () => {
  const layout = cloneLayout(DEFAULT_LAYOUT);
  layout[0].items = ['file.new', SEPARATOR, 'file.open'];
  layout[1].visible = false;
  saveLayout(layout);
  const loaded = loadLayout(all);
  assert.deepEqual(loaded[0].items, ['file.new', SEPARATOR, 'file.open']);
  assert.equal(loaded[1].visible, false);
});

test('ids that no longer exist are dropped, but separators stay', () => {
  saveLayout([{ name: 'Standard', visible: true, items: ['file.new', 'gone.command', SEPARATOR, 'file.open'] }]);
  assert.deepEqual(loadLayout((id) => id !== 'gone.command')[0].items, ['file.new', SEPARATOR, 'file.open']);
});

test('toolbars added since the layout was saved appear with their defaults', () => {
  saveLayout([{ name: 'Standard', visible: false, items: ['file.new'] }]);
  const loaded = loadLayout(all);
  assert.equal(loaded.length, DEFAULT_LAYOUT.length);
  assert.equal(loaded[0].visible, false);
  assert.deepEqual(loaded[1], DEFAULT_LAYOUT[1]);
});

test('damaged saved data falls back to the defaults', () => {
  store.set('word.toolbars.v1', '{not json');
  assert.deepEqual(loadLayout(all), DEFAULT_LAYOUT);
  store.set('word.toolbars.v1', JSON.stringify([{ name: 'Standard', items: 'oops' }, null, 7]));
  assert.deepEqual(loadLayout(all), DEFAULT_LAYOUT);
  store.set('word.toolbars.v1', JSON.stringify([{ name: 'Standard', items: ['file.new', 5, null] }]));
  assert.deepEqual(loadLayout(all)[0].items, ['file.new'], 'non-string ids are dropped');
});

test('blocked storage neither throws nor loses the defaults', () => {
  broken = true;
  assert.doesNotThrow(() => saveLayout(DEFAULT_LAYOUT));
  assert.deepEqual(loadLayout(all), DEFAULT_LAYOUT);
});

test('toolbar names show translated; unknown names show as they are', () => {
  assert.equal(toolbarTitle('Standard'), 'Standard');
  assert.equal(toolbarTitle('Formatting'), 'Formatting');
  assert.equal(toolbarTitle('My bar'), 'My bar');
});
