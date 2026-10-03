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

// --- formatting and layout ----------------------------------------------------------------------

test('format_text also sets font, size, color, highlight and strikethrough', async () => {
  const doc = await openMarkdown('Plain words here.\n');
  assert.equal(await agent(doc, 'format_text', { paragraph: 0, find: 'words', strikethrough: true, color: '#ff0000', size: 20, font: 'Arial' }), 'Formatted "words" in paragraph 0.');
  const out = await md(doc);
  assert.match(out, /~~words~~/);
  assert.match(await agent(doc, 'format_text', { paragraph: 0, color: 'red' }), /not a color/);
  assert.match(await agent(doc, 'format_text', { paragraph: 0 }), /Say what to change/);
});

test('change_case and clear_formatting work on a phrase', async () => {
  const doc = await openMarkdown('Make this **loud** please.\n');
  assert.match(await agent(doc, 'change_case', { paragraph: 0, find: 'loud', to: 'upper' }), /Changed the case/);
  assert.match(await md(doc), /\*\*LOUD\*\*/);
  await agent(doc, 'clear_formatting', { paragraph: 0, find: 'LOUD' });
  assert.equal(await md(doc), 'Make this LOUD please.');
  assert.match(await agent(doc, 'change_case', { paragraph: 0, to: 'shout' }), /^Error: `to` must be/);
});

test('format_paragraph makes bullets for a range, and turns them off again', async () => {
  const doc = await openMarkdown('One\n\nTwo\n\nThree\n');
  assert.equal(await agent(doc, 'format_paragraph', { paragraph: 0, last: 1, list: 'bullet' }), 'Formatted paragraphs 0 to 1.');
  assert.equal(await md(doc), '- One\n- Two\n\nThree');
  await agent(doc, 'format_paragraph', { paragraph: 0, last: 1, list: 'none' });
  assert.equal(await md(doc), 'One\n\nTwo\n\nThree');
  assert.match(await agent(doc, 'format_paragraph', { paragraph: 0 }), /Say what to change/);
  assert.match(await agent(doc, 'format_paragraph', { paragraph: 2, last: 1, align: 'center' }), /must not be before/);
});

test('format_paragraph makes check box lists, written as Markdown task lists', async () => {
  const doc = await openMarkdown('One\n\nTwo\n\nThree\n');
  await agent(doc, 'format_paragraph', { paragraph: 0, list: 'task' });
  await agent(doc, 'format_paragraph', { paragraph: 1, list: 'task_done' });
  assert.equal(await md(doc), '- [ ] One\n- [x] Two\n\nThree');
  await agent(doc, 'format_paragraph', { paragraph: 0, last: 1, list: 'none' });
  assert.equal(await md(doc), 'One\n\nTwo\n\nThree');
});

test('insert_link and remove_link', async () => {
  const doc = await openMarkdown('See the docs for more.\n');
  assert.match(await agent(doc, 'insert_link', { paragraph: 0, find: 'docs', url: 'https://example.com/' }), /Linked "docs"/);
  assert.match(await md(doc), /\[docs\]\(https:\/\/example\.com\/\)/);
  await agent(doc, 'remove_link', { paragraph: 0, find: 'docs' });
  assert.equal(await md(doc), 'See the docs for more.');
});

test('insert_link to another document is written as an Obsidian link in Markdown', async () => {
  const doc = await openMarkdown('See the plan for more.\n');
  await agent(doc, 'insert_link', { paragraph: 0, find: 'plan', url: 'doc:Project Plan' });
  assert.equal(await md(doc), 'See the [[Project Plan|plan]] for more.');
});

test('insert_table fills the cells, edit_table changes it, and neither works where it makes no sense', async () => {
  const doc = await openMarkdown('Before\n\nAfter\n');
  assert.match(
    await agent(doc, 'insert_table', {
      after: 0,
      rows: 2,
      columns: 2,
      cells: [
        ['A', 'B'],
        ['C', 'D'],
      ],
    }),
    /Added a table of 2 rows and 2 columns/,
  );
  const out = await md(doc);
  assert.match(out, /\| A\s*\| B\s*\|/);
  assert.match(out, /\| C\s*\| D\s*\|/);
  const list = await agent(doc, 'read_document');
  const cell = Number(/\[(\d+)\] A/.exec(list)![1]);
  assert.match(await agent(doc, 'edit_table', { paragraph: cell, op: 'insert_row_below' }), /Done/);
  assert.match(await agent(doc, 'edit_table', { paragraph: 0, op: 'delete_rows' }), /is not in a table/);
  assert.match(await agent(doc, 'edit_table', { paragraph: cell, op: 'explode' }), /^Error: `op` must be one of/);
  assert.match(await agent(doc, 'insert_table', { after: 0, rows: 0, columns: 2 }), /^Error: A table has/);
});

test('insert_break, set_columns, count_words, undo and redo', async () => {
  const doc = await openMarkdown('Alpha beta\n\nGamma\n');
  assert.match(await agent(doc, 'insert_break', { after: 0, type: 'page' }), /Added a page break/);
  assert.match(await agent(doc, 'set_columns', { count: 2 }), /Set 2 columns/);
  assert.match(await agent(doc, 'set_columns', { count: 40 }), /^Error: `count` must be/);
  assert.match(await agent(doc, 'count_words'), /^3 words, 14 characters/);
  await agent(doc, 'replace_text', { find: 'Gamma', replace: 'Delta' });
  assert.equal(await agent(doc, 'undo'), 'Undid the last change.');
  assert.match(await md(doc), /Gamma/);
  assert.equal(await agent(doc, 'redo'), 'Redid the last change.');
  assert.match(await md(doc), /Delta/);
});

test('insert_equation puts LaTeX in a paragraph, and refuses LaTeX that does not parse', async () => {
  const doc = await openMarkdown('Energy is\n\nDone\n');
  assert.match(await agent(doc, 'insert_equation', { paragraph: 0, latex: 'E=mc^2' }), /Inserted the equation at the end in paragraph 0/);
  assert.match(await md(doc), /Energy is.*E\s*=\s*mc/s);
  assert.match(await agent(doc, 'insert_equation', { paragraph: 0, latex: '' }), /must not be empty/);
});

test('set_page changes orientation, size and margins, and refuses margins that leave no room', async () => {
  const doc = await openMarkdown('Page\n');
  assert.match(await agent(doc, 'set_page', { orientation: 'landscape', size: 'a4', margins: 0.5 }), /11\.69 x 8\.27 inches \(landscape\), margins 0\.5\/0\.5\/0\.5\/0\.5/);
  assert.match(await agent(doc, 'set_page', { size: 'tabloid' }), /17\.00 x 11\.00 inches \(landscape\)/);
  assert.match(await agent(doc, 'set_page', { size: 'huge' }), /^Error: `size` must be one of/);
  assert.match(await agent(doc, 'set_page', { left: 9, right: 9 }), /^Error: The margins leave no room/);
});

test('comments can be listed, replied to, changed, resolved and deleted', async () => {
  const doc = await openMarkdown('Alpha beta\n');
  assert.equal(await agent(doc, 'list_comments'), 'There are no comments.');
  await agent(doc, 'add_comment', { paragraph: 0, find: 'beta', text: 'Check this' });
  const listed = await agent(doc, 'list_comments');
  const id = /\[([^\]]+)\]/.exec(listed)![1]!;
  assert.match(listed, /Check this/);
  assert.match(await agent(doc, 'reply_comment', { id, text: 'Done' }), /Replied/);
  assert.match(await agent(doc, 'list_comments'), /reply to .*Done/s);
  assert.match(await agent(doc, 'edit_comment', { id, text: 'Check that' }), /Changed/);
  assert.match(await agent(doc, 'resolve_comment', { id }), /Resolved/);
  assert.match(await agent(doc, 'list_comments'), /\(resolved\)/);
  assert.match(await agent(doc, 'delete_comment', { id }), /Deleted/);
  assert.equal(await agent(doc, 'list_comments'), 'There are no comments.');
  assert.match(await agent(doc, 'resolve_comment', { id: 'nope' }), /^Error: There is no comment nope/);
});

test('set_properties merges into the document properties', async () => {
  const doc = await openMarkdown('Text\n');
  assert.equal(await agent(doc, 'get_properties'), 'No properties are set.');
  assert.equal(await agent(doc, 'set_properties', { title: 'My Title', author: 'Ann' }), 'Set title, author.');
  await agent(doc, 'set_properties', { subject: 'Notes' });
  assert.equal(await agent(doc, 'get_properties'), 'title: My Title\nsubject: Notes\nauthor: Ann');
  assert.match(await agent(doc, 'set_properties', {}), /^Error: Say what to set/);
});

test('insert_horizontal_rule adds a rule between paragraphs, and format_code_block toggles code', async () => {
  const doc = await openMarkdown('One\n\nTwo\n\nThree\n');
  assert.equal(await agent(doc, 'insert_horizontal_rule', { after: 0 }), 'Added a horizontal rule after paragraph 0.');
  assert.equal(await md(doc), 'One\n\n---\n\nTwo\n\nThree');
  await run(doc, { kind: 'select', paragraph: 2, from: 3, to: 3 });
  await run(doc, { kind: 'format', action: { kind: 'insertHorizontalRule' } });
  assert.equal(await md(doc), 'One\n\n---\n\nTwo\n\n---\n\nThree');
  assert.match(await agent(doc, 'format_code_block', { paragraph: 4, last: 4 }), /Made paragraph 4 a code block/);
  assert.match(await md(doc), /```\nThree\n```/);
  assert.match(await agent(doc, 'format_code_block', { paragraph: 4, on: false }), /Made plain text of paragraph 4/);
  assert.ok(!(await md(doc)).includes('```'));
  assert.match(await agent(doc, 'insert_horizontal_rule', { after: 99 }), /^Error: There is no paragraph 99/);
});

test('the Insert menu’s rule and code block act at the caret: a rule in an empty paragraph takes its place', async () => {
  const doc = await openMarkdown('Alpha\n');
  await run(doc, { kind: 'move', to: 'documentEnd' });
  await run(doc, { kind: 'insertParagraph' });
  await run(doc, { kind: 'format', action: { kind: 'insertHorizontalRule' } });
  assert.equal(await md(doc), 'Alpha\n\n---');
  const code = await openMarkdown('Alpha\n');
  await run(code, { kind: 'format', action: { kind: 'insertCodeBlock' } });
  assert.equal(await md(code), '```\nAlpha\n```');
  await run(code, { kind: 'format', action: { kind: 'insertCodeBlock' } });
  assert.equal(await md(code), 'Alpha');
});

test('edit_table merge_cells merges a block of cells, keeping their text, and says when it cannot', async () => {
  const doc = await openMarkdown('Top\n');
  await agent(doc, 'insert_table', { after: 0, rows: 2, columns: 3, cells: [['A', 'B', 'C'], ['D', 'E', 'F']] });
  const list = await agent(doc, 'read_document');
  const at = (t: string) => Number(new RegExp(`\\[(\\d+)\\] ${t}\\b`).exec(list)![1]);
  assert.match(await agent(doc, 'edit_table', { paragraph: at('A'), op: 'merge_cells', to_paragraph: at('E') }), /Merged the cells/);
  const after = await agent(doc, 'read_document');
  assert.match(after, /A\b/);
  assert.match(after, /B\b/);
  assert.match(after, /D\b/);
  assert.match(after, /E\b/);
  assert.match(after, /\bC\b/);
  assert.match(await agent(doc, 'edit_table', { paragraph: at('F'), op: 'merge_cells', to_paragraph: at('F') }), /could not be merged/);
  assert.match(await agent(doc, 'edit_table', { paragraph: at('F'), op: 'merge_cells' }), /^Error: `to_paragraph` must be a whole number/);
  assert.match(await agent(doc, 'edit_table', { paragraph: 0, op: 'merge_cells', to_paragraph: 1 }), /is not in a table/);
});
