import assert from 'node:assert/strict';
import { test } from 'node:test';
import { footerSegments, type FooterInfo } from '../src/ui/footer.ts';
import type { WordStats } from '../src/layout/protocol.ts';

const stats = (words: number, selection = false): WordStats => ({ pages: 1, words, charactersWithSpaces: 0, charactersWithoutSpaces: 0, paragraphs: 1, lines: 1, selection });
const base: FooterInfo = { kind: 'docx', page: { current: 2, count: 5 }, zoom: 1.25, words: stats(1200), selection: null, picture: null };
const keys = (info: FooterInfo) => footerSegments(info).map((s) => s.key);

test('footer: gives a text document its page, words and zoom', () => {
  assert.deepEqual(footerSegments(base), [
    { key: 'panels.footer.page', params: { current: 2, count: 5 } },
    { key: 'panels.footer.words', params: { count: 1200 } },
    { key: 'panels.footer.zoom', params: { percent: 125 } },
  ]);
});

test('footer: counts the selection against the whole document', () => {
  const [, words] = footerSegments({ ...base, selection: stats(30, true) });
  assert.deepEqual(words, { key: 'panels.footer.selection', params: { count: 1200, selected: 30 } });
});

test('footer: leaves out the words of a PDF, and the page of reflowed text', () => {
  assert.deepEqual(keys({ ...base, kind: 'pdf', words: null }), ['panels.footer.page', 'panels.footer.zoom']);
  assert.deepEqual(keys({ ...base, page: null }), ['panels.footer.words', 'panels.footer.zoom']);
});

test('footer: gives a picture its size in pixels, and no pages or words', () => {
  const info: FooterInfo = { ...base, kind: 'png', picture: { width: 640, height: 480 } };
  assert.deepEqual(footerSegments(info)[0], { key: 'panels.footer.pixels', params: { width: 640, height: 480 } });
  assert.deepEqual(keys(info), ['panels.footer.pixels', 'panels.footer.zoom']);
  assert.deepEqual(keys({ ...info, picture: null }), ['panels.footer.zoom']);
});

test('footer: gives a CSV its rows and columns in place of its words', () => {
  const info: FooterInfo = { ...base, kind: 'csv', page: null, words: { ...stats(40), table: { rows: 10, columns: 4 } } };
  assert.deepEqual(keys(info), ['panels.footer.table', 'panels.footer.zoom']);
  assert.deepEqual(footerSegments(info)[0].params, { rows: 10, columns: 4 });
});
