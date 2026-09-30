// The assistant's tools, run through the layout worker on real documents: what they read, how
// they edit (as ordinary undoable edits), and what they refuse.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { agent, convert, decode, openMarkdown, run, selection, startWorker, stopWorker } from './workerHarness.ts';

before(startWorker);
after(stopWorker);

const md = async (doc: number) => decode(await convert(doc, 'md')).trim();
const DOC = '# Title\n\nFirst paragraph here.\n\nSecond paragraph, with **bold** words.\n\nThird.\n';

// --- reading ----------------------------------------------------------------------------------

test('read_document numbers the paragraphs and reports a window of a longer document', async () => {
  const doc = await openMarkdown(DOC);
  const all = await agent(doc, 'read_document');
  assert.match(all, /^Paragraphs 0 to 3 of 4\./);
  assert.match(all, /\[0\] .*Title/);
  assert.match(all, /\[2\] Second paragraph, with bold words\./);
  const part = await agent(doc, 'read_document', { start: 1, count: 1 });
  assert.match(part, /^Paragraphs 1 to 1 of 4\. More follows: call again with start=2\./);
  assert.match(await agent(doc, 'read_document', { start: 99 }), /nothing at 99/);
});

test('read_document keeps one call from filling the conversation', async () => {
  const doc = await openMarkdown(Array.from({ length: 60 }, (_, i) => `Paragraph ${i} ${'word '.repeat(80)}`).join('\n\n'));
  const out = await agent(doc, 'read_document', { count: 100 });
  assert.ok(out.length < 9000, `${out.length} characters`);
  assert.match(out, /More follows: call again with start=\d+/);
});

test('get_selection reports the selected text and paragraphs, or the caret', async () => {
  const doc = await openMarkdown(DOC);
  assert.match(await agent(doc, 'get_selection'), /Nothing is selected\. The caret is in paragraph 0/);
  await run(doc, { kind: 'select', paragraph: 1, from: 6, to: 15 });
  assert.equal(await agent(doc, 'get_selection'), 'Selected, in paragraphs 1 to 1:\nparagraph');
});

test('find_text lists matches with their paragraph, ignoring case unless asked', async () => {
  const doc = await openMarkdown(DOC);
  const found = await agent(doc, 'find_text', { text: 'PARAGRAPH' });
  assert.match(found, /^2 matches:/);
  assert.match(found, /\[1\] …First paragraph here\.…/);
  assert.equal(await agent(doc, 'find_text', { text: 'PARAGRAPH', match_case: true }), 'No matches.');
});

// --- editing ----------------------------------------------------------------------------------

test('replace_paragraph swaps the words and keeps the paragraph’s place and style', async () => {
  const doc = await openMarkdown(DOC);
  assert.equal(await agent(doc, 'replace_paragraph', { paragraph: 1, text: 'A brand new opening.' }), 'Replaced paragraph 1.');
  const out = await md(doc);
  assert.match(out, /^# Title\n\nA brand new opening\.\n\nSecond paragraph/);
  assert.ok(!out.includes('First paragraph'));
});

test('replace_paragraph with several lines makes several paragraphs', async () => {
  const doc = await openMarkdown('One\n\nTwo\n\nThree\n');
  await agent(doc, 'replace_paragraph', { paragraph: 1, text: 'Two-a\nTwo-b' });
  assert.equal(await md(doc), 'One\n\nTwo-a\n\nTwo-b\n\nThree');
});

test('an edit is one ordinary edit: it can be undone', async () => {
  const doc = await openMarkdown('Alpha\n\nBeta\n');
  await agent(doc, 'replace_text', { find: 'Beta', replace: 'Gamma' });
  assert.equal(await md(doc), 'Alpha\n\nGamma');
  assert.equal((await selection(doc)).canUndo, true);
  await run(doc, { kind: 'undo' });
  assert.equal(await md(doc), 'Alpha\n\nBeta');
});

test('insert_paragraph adds after a paragraph, at the very start, and at the end', async () => {
  const doc = await openMarkdown('One\n\nThree\n');
  assert.match(await agent(doc, 'insert_paragraph', { after: 0, text: 'Two' }), /Added paragraph at 1\./);
  assert.equal(await md(doc), 'One\n\nTwo\n\nThree');
  await agent(doc, 'insert_paragraph', { after: -1, text: 'Zero' });
  assert.equal(await md(doc), 'Zero\n\nOne\n\nTwo\n\nThree');
  await agent(doc, 'insert_paragraph', { after: 3, text: 'Four' });
  assert.equal(await md(doc), 'Zero\n\nOne\n\nTwo\n\nThree\n\nFour');
});

test('a paragraph added under a heading is body text, not another heading, unless a style is asked for', async () => {
  const doc = await openMarkdown('# Title\n\nBody\n');
  await agent(doc, 'insert_paragraph', { after: 0, text: 'Intro' });
  assert.equal(await md(doc), '# Title\n\nIntro\n\nBody');
  await agent(doc, 'insert_paragraph', { after: 2, text: 'Next part', style: 'Heading 2' });
  assert.equal(await md(doc), '# Title\n\nIntro\n\nBody\n\n## Next part');
});

test('delete_paragraph removes a paragraph from the middle, the start and the end', async () => {
  const doc = await openMarkdown('One\n\nTwo\n\nThree\n\nFour\n');
  assert.equal(await agent(doc, 'delete_paragraph', { paragraph: 1 }), 'Deleted paragraph 1.');
  assert.equal(await md(doc), 'One\n\nThree\n\nFour');
  await agent(doc, 'delete_paragraph', { paragraph: 0 });
  assert.equal(await md(doc), 'Three\n\nFour');
  await agent(doc, 'delete_paragraph', { paragraph: 1 });
  assert.equal(await md(doc), 'Three');
  assert.match(await agent(doc, 'delete_paragraph', { paragraph: 0 }), /only paragraph/);
});

test('replace_text replaces every occurrence and says how many', async () => {
  const doc = await openMarkdown('cat and Cat and cat\n');
  assert.equal(await agent(doc, 'replace_text', { find: 'cat', replace: 'dog' }), 'Replaced 3 occurrences.');
  assert.equal(await md(doc), 'dog and dog and dog');
  assert.equal(await agent(doc, 'replace_text', { find: 'cow', replace: 'pig' }), 'No matches, so nothing was changed.');
});

test('replace_text keeps the formatting around the words it changes', async () => {
  const doc = await openMarkdown('one **two** three\n');
  await agent(doc, 'replace_text', { find: 'two', replace: 'TWO' });
  assert.equal(await md(doc), 'one **TWO** three');
});

test('set_style gives a paragraph a heading style, and says so when the style does not exist', async () => {
  const doc = await openMarkdown('Plain\n\nMore\n');
  assert.equal(await agent(doc, 'set_style', { paragraph: 0, style: 'Heading 1' }), 'Paragraph 0 is now Heading 1.');
  assert.equal(await md(doc), '# Plain\n\nMore');
  assert.match(await agent(doc, 'set_style', { paragraph: 1, style: 'Fancy Nonsense' }), /is not available/);
});

test('format_text sets bold on a phrase or a whole paragraph, and only changes what differs', async () => {
  const doc = await openMarkdown('make this bold please\n\nalready **bold** here\n');
  await agent(doc, 'format_text', { paragraph: 0, find: 'this', bold: true });
  assert.equal(await md(doc), 'make **this** bold please\n\nalready **bold** here');
  // Asking for bold where it already is does not turn it off.
  await agent(doc, 'format_text', { paragraph: 1, find: 'bold', bold: true });
  assert.equal(await md(doc), 'make **this** bold please\n\nalready **bold** here');
  await agent(doc, 'format_text', { paragraph: 1, find: 'bold', bold: false });
  assert.equal(await md(doc), 'make **this** bold please\n\nalready bold here');
  await agent(doc, 'format_text', { paragraph: 0, italic: true });
  assert.match(await md(doc), /^\*\*?_?/);
});

test('add_comment attaches a comment to a phrase, credited to Clip', async () => {
  const doc = await openMarkdown('Check this claim carefully.\n');
  assert.match(await agent(doc, 'add_comment', { paragraph: 0, find: 'claim', text: 'Source needed?' }), /Commented on "claim" in paragraph 0\./);
  const s = await selection(doc);
  assert.equal(s.comments.length, 1);
  assert.equal(s.comments[0]!.author, 'Clip');
  assert.equal(s.comments[0]!.text, 'Source needed?');
});

// --- refusals and bad input -------------------------------------------------------------------

test('a paragraph number that does not exist is explained, not guessed at', async () => {
  const doc = await openMarkdown('One\n\nTwo\n');
  assert.match(await agent(doc, 'replace_paragraph', { paragraph: 5, text: 'x' }), /^Error: There is no paragraph 5; the document has paragraphs 0 to 1\./);
  assert.match(await agent(doc, 'insert_paragraph', { after: 9, text: 'x' }), /^Error: `after` must be from -1 to 1\./);
  assert.equal(await md(doc), 'One\n\nTwo', 'nothing changed');
});

test('bad arguments and unknown tools come back as errors for the model to correct', async () => {
  const doc = await openMarkdown('One\n');
  assert.match(await agent(doc, 'replace_paragraph', '{"paragraph": "zero", "text": "x"}'), /^Error: `paragraph` must be a whole number/);
  assert.match(await agent(doc, 'replace_paragraph', '{"paragraph": 0}'), /^Error: `text` must be text/);
  assert.match(await agent(doc, 'replace_paragraph', '{oops'), /^Error: the arguments were not valid JSON/);
  assert.match(await agent(doc, 'replace_paragraph', '[1]'), /^Error: the arguments must be an object/);
  assert.match(await agent(doc, 'rm_rf', {}), /^Error: there is no tool called rm_rf/);
  assert.match(await agent(doc, 'format_text', { paragraph: 0 }), /^Error: Say what to change/);
  assert.match(await agent(doc, 'format_text', { paragraph: 0, find: 'zzz', bold: true }), /does not appear in paragraph 0/);
  assert.equal(await md(doc), 'One');
});

test('a tool name from Object.prototype is not a tool, and an empty style is refused', async () => {
  const doc = await openMarkdown('One\n');
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) assert.match(await agent(doc, name, {}), new RegExp(`^Error: there is no tool called ${name}`));
  assert.match(await agent(doc, 'set_style', { paragraph: 0, style: '  ' }), /^Error: `style` must not be empty/);
  assert.equal(await md(doc), 'One');
});

test('no document open is an error, not a hang', async () => {
  assert.match(await agent(9999, 'read_document'), /^Error: no document is open/);
});
