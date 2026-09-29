import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  deleteText,
  findContainer,
  insertBlockAfter,
  insertItem,
  insertText,
  mergeParagraphs,
  paragraphLength,
  paragraphText,
  removeBlock,
  splitParagraph,
  WordDocument,
  type Inline,
  type Paragraph,
  type Run,
  type RunProperties,
} from '../src/index.ts';

const run = (text: string, properties: RunProperties = {}): Run => ({ kind: 'run', properties, content: [{ kind: 'text', text }], attrs: {} });
const para = (...children: Inline[]): Paragraph => ({ kind: 'paragraph', properties: {}, children, attrs: {} });
const bold = { bold: true };

/** Text with run boundaries marked "|" and bold runs in [brackets]. */
function shape(p: Paragraph): string {
  const out: string[] = [];
  const walk = (inlines: Inline[]) => {
    for (const i of inlines) {
      if (i.kind === 'run') {
        const text = i.content.map((c) => (c.kind === 'text' ? c.text : c.kind === 'tab' ? '→' : c.kind === 'break' ? '↵' : '?')).join('');
        out.push(i.properties.bold ? `[${text}]` : text);
      } else if (i.kind === 'hyperlink') {
        out.push('<');
        walk(i.children);
        out.push('>');
      } else if (i.kind === 'wrapper') walk(i.children);
    }
  };
  walk(p.children);
  return out.join('|');
}

test('model offsets count text units and one position per other item', () => {
  const p = para(run('ab'), { kind: 'run', properties: {}, attrs: {}, content: [{ kind: 'tab' }, { kind: 'text', text: 'c' }] });
  assert.equal(paragraphLength(p), 4);
  assert.equal(paragraphText(p), 'ab￼c');
});

test('insertText takes the formatting of the text before it', () => {
  const p = para(run('Hello '), run('world', bold));
  insertText(p, 6, 'big ');
  assert.equal(shape(p), 'Hello big |[world]');
  insertText(p, 11, 'X');
  assert.equal(shape(p), 'Hello big |[wXorld]');
  insertText(p, 0, '>');
  assert.equal(shape(p), '>Hello big |[wXorld]');
  insertText(p, paragraphLength(p), '!');
  assert.equal(shape(p), '>Hello big |[wXorld!]');
});

test('insertText into an empty paragraph uses the paragraph mark formatting', () => {
  const p = para();
  p.properties.runProperties = { italic: true };
  insertText(p, 0, 'abc');
  assert.equal(p.children.length, 1);
  assert.deepEqual((p.children[0] as Run).properties, { italic: true });
  assert.equal(paragraphText(p), 'abc');
});

test('insertText into a hyperlink and around tabs', () => {
  const p = para(run('a'), { kind: 'hyperlink', url: 'https://x', children: [run('link')], attrs: {} });
  insertText(p, 3, 'X');
  assert.equal(shape(p), 'a|<|liXnk|>');
  const q = para({ kind: 'run', properties: {}, attrs: {}, content: [{ kind: 'tab' }] });
  insertText(q, 1, 'after');
  insertText(q, 0, 'before');
  assert.equal(shape(q), 'before→after');
});

test('deleteText across runs merges what is left and returns what it removed', () => {
  const p = para(run('Hello '), run('bold', bold), run(' world'));
  const removed = deleteText(p, 3, 12);
  assert.equal(shape(p), 'Helorld');
  assert.equal(shape(para(...removed)), 'lo |[bold]| w');
  const q = para(run('only', bold));
  q.properties.runProperties = { bold: true };
  deleteText(q, 0, 4);
  assert.equal(paragraphLength(q), 0);
  insertText(q, 0, 'new');
  assert.equal(shape(q), '[new]', 'typing takes the paragraph mark formatting');
});

test('deleting between two same-format runs joins them', () => {
  const p = para(run('ab'), run('X', bold), run('cd'));
  deleteText(p, 2, 3);
  assert.equal(shape(p), 'abcd');
  assert.equal(p.children.length, 1);
});

test('splitParagraph and mergeParagraphs are inverse', () => {
  const p = para(run('Hello '), run('world', bold));
  p.attrs['w14:paraId'] = '1234ABCD';
  const body: Paragraph[] = [p];
  const second = splitParagraph(p, 8);
  insertBlockAfter(body, p, second);
  assert.equal(shape(p), 'Hello |[wo]');
  assert.equal(shape(second), '[rld]');
  assert.equal(second.attrs['w14:paraId'], undefined, 'paragraph ids stay unique');
  mergeParagraphs(p, second);
  removeBlock(body, second);
  assert.equal(shape(p), 'Hello |[world]');
  assert.equal(body.length, 1);
});

test('splitting at the end keeps formatting for the new paragraph and moves the section break', () => {
  const p = para(run('Title', bold));
  p.properties = { style: 'Heading1', keepNext: true, section: { headers: [], footers: [] } as never };
  const styles = { styles: [{ type: 'paragraph' as const, id: 'Heading1', next: 'Normal', attrs: {} }] };
  const next = splitParagraph(p, 5, styles);
  assert.equal(next.properties.style, 'Normal');
  assert.equal(next.properties.keepNext, undefined);
  assert.ok(next.properties.section && !p.properties.section);
  insertText(next, 0, 'body');
  assert.equal(shape(next), '[body]', 'typing continues in the formatting at the split');
});

test('insertItem adds tabs and breaks where text would go', () => {
  const p = para(run('ab'));
  insertItem(p, 1, { kind: 'tab' });
  insertItem(p, 3, { kind: 'break' });
  assert.equal(shape(p), 'a→b↵');
  assert.equal(paragraphLength(p), 4);
});

test('edited documents write and read back', async () => {
  const doc = await WordDocument.create();
  const p = para(run('Hello world'));
  doc.body = [p];
  insertText(p, 5, ',');
  insertText(p, 12, '  with spaces ');
  const second = splitParagraph(p, 6);
  insertBlockAfter(doc.body, p, second);
  deleteText(second, 0, 1);
  const reread = await WordDocument.read(await doc.write());
  const texts = reread.body.filter((b): b is Paragraph => b.kind === 'paragraph').map(paragraphText);
  assert.deepEqual(texts, ['Hello,', 'world  with spaces ']);
  assert.equal(findContainer(doc.body, second), doc.body);
});
