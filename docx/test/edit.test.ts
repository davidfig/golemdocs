import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bookmarkEnd,
  bookmarkMarkerOffsets,
  bookmarkRanges,
  bookmarkStart,
  fieldChar,
  fieldContents,
  hasPageField,
  pageNumberParagraph,
  validBookmarkName,
  withoutPageFields,
  deleteText,
  findContainer,
  insertBlockAfter,
  insertItem,
  insertText,
  mergeParagraphs,
  paragraphLength,
  paragraphText,
  plainText,
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

test('text put at either end of a link stays out of it, in the link\'s font but not its style; text inside it stays in', () => {
  const link = (): Inline => ({ kind: 'hyperlink', url: 'https://example.com', attrs: {}, children: [{ kind: 'run', properties: { style: 'Hyperlink', bold: true }, attrs: {}, content: [{ kind: 'text', text: 'link' }] }] } as unknown as Inline);
  const p = para(link());
  insertText(p, 4, ' after');
  insertText(p, 0, 'before ');
  insertText(p, 9, 'X');
  assert.deepEqual(p.children.map((c) => c.kind), ['run', 'hyperlink', 'run']);
  assert.equal(plainText(p), 'before liXnk after');
  const [before, , after] = p.children as Run[];
  assert.deepEqual(before.properties, { bold: true });
  assert.deepEqual(after.properties, { bold: true });
});

test('plainText leaves out a page break, unless asked for what stands for it', () => {
  const p = para(run('first'), { kind: 'run', properties: {}, attrs: {}, content: [{ kind: 'break', type: 'page' }] }, run('second'));
  assert.equal(plainText(p), 'firstsecond');
  assert.equal(plainText(p, 0, Infinity, '\n'), 'first\nsecond');
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

// --- Bookmarks and page number fields ----------------------------------------------------------

const inPara = (children: Paragraph['children']): Paragraph => ({ kind: 'paragraph', properties: {}, children, attrs: {} });
const textRun = (s: string): Paragraph['children'][number] => ({ kind: 'run', properties: {}, content: [{ kind: 'text', text: s }], attrs: {} });

test('bookmarks are found by their markers, in order, without Word’s hidden ones', () => {
  const p = inPara([bookmarkStart('1', 'First'), textRun('abc'), bookmarkEnd('1'), bookmarkStart('2', '_Toc123'), bookmarkEnd('2')]);
  const q = inPara([bookmarkStart('3', 'Open'), textRun('x')]);
  const ranges = bookmarkRanges([p, q]);
  assert.deepEqual(ranges.map((r) => r.name), ['First', 'Open']);
  assert.equal(ranges[0].start.offset, 1);
  assert.equal(ranges[0].end.offset, 4);
  assert.equal(ranges[1].end.offset, 1, 'no end: it ends where it starts');
});

test('a bookmark across paragraphs, and where its markers are', () => {
  const p = inPara([textRun('ab'), bookmarkStart('7', 'Span')]);
  const q = inPara([textRun('cd'), bookmarkEnd('7')]);
  const [range] = bookmarkRanges([p, q]);
  assert.equal(range.start.paragraph, p);
  assert.equal(range.end.paragraph, q);
  assert.equal(range.end.offset, 2);
  assert.deepEqual(bookmarkMarkerOffsets(p, '7'), [2]);
  assert.deepEqual(bookmarkMarkerOffsets(q, '7'), [2]);
  assert.deepEqual(bookmarkMarkerOffsets(q, 'other'), []);
});

test('bookmark names follow Word’s rules', () => {
  for (const good of ['a', 'Chapter_1', 'été2', 'x'.repeat(40)]) assert.ok(validBookmarkName(good), good);
  for (const bad of ['', '1st', '_hidden', 'two words', 'dash-ed', 'x'.repeat(41)]) assert.ok(!validBookmarkName(bad), bad);
});

test('a page number paragraph is a PAGE field, and can be taken out again', () => {
  const p = pageNumberParagraph('center');
  assert.equal(p.properties.justification, 'center');
  assert.ok(hasPageField(p));
  const { found, paragraph } = withoutPageFields(p);
  assert.ok(found);
  assert.equal(paragraph.children.length, 0);
});

test('taking out a page number leaves the words around it and other fields', () => {
  const field = (name: string): Paragraph['children'][number] => ({ kind: 'run', properties: {}, content: fieldContents(name, [{ kind: 'text', text: '9' }]), attrs: {} });
  const p = inPara([textRun('Page '), field('PAGE'), textRun(' of '), field('NUMPAGES')]);
  const { found, paragraph } = withoutPageFields(p);
  assert.ok(found);
  const items = paragraph.children.flatMap((c) => (c.kind === 'run' ? c.content : []));
  assert.deepEqual(items.filter((i) => i.kind === 'text').map((i) => (i as { text: string }).text), ['Page ', ' of ', '9']);
  assert.ok(items.some((i) => i.kind === 'instrText' && i.text.includes('NUMPAGES')));
  assert.ok(!hasPageField(paragraph));
  assert.equal(withoutPageFields(inPara([textRun('plain')])).found, false);
});

test('a field split over runs, and a simple field, count too', () => {
  const split = inPara([
    { kind: 'run', properties: {}, content: [fieldChar('begin')], attrs: {} },
    { kind: 'run', properties: {}, content: [{ kind: 'instrText', text: ' PA' }, { kind: 'instrText', text: 'GE ' }], attrs: {} },
    { kind: 'run', properties: {}, content: [fieldChar('separate')], attrs: {} },
    textRun('3'),
    { kind: 'run', properties: {}, content: [fieldChar('end')], attrs: {} },
    textRun('after'),
  ]);
  const out = withoutPageFields(split);
  assert.ok(out.found);
  assert.deepEqual(out.paragraph.children.flatMap((c) => (c.kind === 'run' ? c.content : [])).map((i) => (i as { text?: string }).text), ['after']);
  const simple = inPara([{ kind: 'wrapper', shell: { name: 'w:fldSimple', attrs: { 'w:instr': 'PAGE' }, children: [] }, contentElement: null, children: [textRun('1')] }]);
  assert.ok(hasPageField(simple));
  assert.equal(withoutPageFields(simple).paragraph.children.length, 0);
});

test('text put at either end of a locked content control stays out of it; an unlocked one takes it', () => {
  const control = (lock: boolean): Inline => ({
    kind: 'wrapper',
    shell: { name: 'w:sdt', attrs: {}, children: [{ name: 'w:sdtPr', attrs: {}, children: lock ? [{ name: 'w:lock', attrs: { 'w:val': 'sdtContentLocked' }, children: [] }] : [] }] },
    contentElement: 'w:sdtContent',
    children: [run('2740')],
  });
  const locked = para(run('Total '), control(true), run(' so far'));
  insertText(locked, 10, 'X');
  insertText(locked, 6, 'Y');
  assert.equal(shape(locked), 'Total Y|2740|X so far');
  assert.equal((locked.children[1] as { children: Inline[] }).children.length, 1);
  const open = para(run('Total '), control(false), run(' so far'));
  insertText(open, 10, 'X');
  assert.equal(shape(open), 'Total |2740X| so far');
});
