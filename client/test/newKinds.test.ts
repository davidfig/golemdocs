import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { NEW_KINDS, blankSource, lastNewKind, newKindOrder, rememberNewKind } from '../src/ui/newKinds.ts';

const store = new Map<string, string>();
const real = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
beforeEach(() => {
  store.clear();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
  });
});
afterEach(() => {
  if (real) Object.defineProperty(globalThis, 'localStorage', real);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
});

test('new documents start as Word, then the other types as listed', () => {
  assert.equal(lastNewKind(), 'docx');
  assert.deepEqual(newKindOrder(), [...NEW_KINDS]);
});

test('the last used type comes first, the others in order of use', () => {
  rememberNewKind('md');
  rememberNewKind('txt');
  rememberNewKind('md');
  assert.equal(lastNewKind(), 'md');
  assert.deepEqual(newKindOrder().slice(0, 3), ['md', 'txt', 'docx']);
  assert.equal(newKindOrder().length, NEW_KINDS.length);
});

test('types a document cannot be converted to are not remembered', () => {
  rememberNewKind('largetext');
  assert.equal(lastNewKind(), 'docx');
});

test('text types open straight from an empty file, the others are converted from a blank Word document', () => {
  assert.deepEqual(blankSource('docx', 'Document1'), { source: { kind: 'blank', name: 'Document1' }, converted: false });
  const md = blankSource('md', 'Notes');
  assert.equal(md.source.kind, 'md');
  assert.equal(md.converted, false);
  assert.deepEqual(blankSource('odt', 'Letter'), { source: { kind: 'blank', name: 'Letter' }, converted: true });
});

test('every type a document can be converted to can be made', () => {
  for (const kind of ['odt', 'rtf', 'csv', 'epub', 'pdf', 'svg', 'png']) assert.ok(NEW_KINDS.includes(kind as never), kind);
});
