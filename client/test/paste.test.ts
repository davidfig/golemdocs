// Pasting formatted text: clipboard HTML made into blocks for a document (src/formats/paste.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paragraphText, paragraphsIn, WordDocument, type Hyperlink, type Paragraph } from '@golemdocs/docx';
import { htmlToPaste } from '../src/formats/paste.ts';

const texts = (blocks: { kind: string }[]) => paragraphsIn(blocks as Paragraph[]).map(paragraphText);
const runs = (p: Paragraph) => p.children.flatMap((c) => (c.kind === 'run' ? [c] : c.kind === 'hyperlink' ? c.children.filter((r) => r.kind === 'run') : []));

test('paragraphs, character formatting and links come across; unsafe links keep only their text', async () => {
  const target = await WordDocument.create();
  const pasted = (await htmlToPaste('<p>Hello <b>bold</b> <i>slanted</i> <a href="https://example.com/x">link</a> <a href="javascript:alert(1)">bad</a></p><p>Second</p>', target))!;
  assert.deepEqual(texts(pasted.blocks), ['Hello bold slanted link bad', 'Second']);
  const [first] = paragraphsIn(pasted.blocks);
  const properties = (text: string) => runs(first).find((r) => r.content.some((c) => c.kind === 'text' && c.text.trim() === text))!.properties;
  assert.equal(properties('bold').bold, true);
  assert.equal(properties('slanted').italic, true);
  const links = first.children.filter((c): c is Hyperlink => c.kind === 'hyperlink');
  assert.deepEqual(links.map((l) => l.url), ['https://example.com/x'], 'the javascript: link is gone');
  for (const p of paragraphsIn(pasted.blocks)) assert.equal(p.attrs['w14:paraId'], undefined, 'ids are made where it is pasted');
});

test('styles and list definitions the blocks use are carried over, under ids the target does not have', async () => {
  const target = await WordDocument.create();
  target.numbering.instances.push({ id: 7, abstractId: 3, overrides: [], attrs: {} });
  target.numbering.abstracts.push({ id: 3, levels: [], attrs: {} });
  const pasted = (await htmlToPaste('<h5>Small heading</h5><blockquote><p>Quoted</p></blockquote><ul><li>one</li><li>two</li></ul><p>after</p>', target))!;
  const [heading, quote] = paragraphsIn(pasted.blocks);
  assert.equal(heading.properties.style, 'Heading5');
  assert.equal(quote.properties.style, 'Quote');
  const styles = pasted.define.filter((op) => op.type === 'setStyle').map((op) => (op as { id: string }).id);
  // The ones a blank document lacks, each once (Heading 2 and List Paragraph it has already).
  assert.deepEqual([...styles].sort(), ['Heading5', 'Quote']);
  const lists = pasted.define.filter((op) => op.type === 'setList') as Extract<(typeof pasted.define)[number], { type: 'setList' }>[];
  assert.equal(lists.length, 1, 'one list');
  assert.ok(lists[0].id > 7 && lists[0].list!.abstract.id > 3, 'new ids');
  const items = paragraphsIn(pasted.blocks).filter((p) => p.properties.numbering);
  assert.equal(items.length, 2);
  assert.ok(items.every((p) => p.properties.numbering!.id === lists[0].id), 'both items are in that list');
  assert.equal(paragraphsIn(pasted.blocks).at(-1)!.properties.numbering, undefined);
  // Once the target has them, they are not defined again.
  target.styles.styles.push(...pasted.define.filter((op) => op.type === 'setStyle').map((op) => (op as { style: never }).style));
  assert.equal((await htmlToPaste('<h5>Again</h5>', target))!.define.length, 0);
});

test('fonts asked for by name are listed, tables come as tables, and nothing to paste is null', async () => {
  const target = await WordDocument.create();
  const pasted = (await htmlToPaste('<p><span style="font-family: Georgia">serif</span></p><table><tr><td>a</td><td>b</td></tr></table>', target))!;
  assert.ok([...pasted.fonts].some((f) => /georgia/i.test(f)), 'Georgia');
  assert.equal(pasted.blocks.filter((b) => b.kind === 'table').length, 1);
  assert.equal(await htmlToPaste('', target), null);
  assert.equal(await htmlToPaste('<p></p><p> </p>', target), null, 'only empty lines');
});
