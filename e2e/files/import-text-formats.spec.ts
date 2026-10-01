// File ▸ Import… with every text and markup format: the file chooser, the resulting text, the
// format the document is edited as, and the title.

import { expect, test } from './fixtures';
import { formatLabel, hasItem, importFile, menuContents, status, text } from './helpers';

interface Case {
  file: ReturnType<typeof text>;
  label: string;
  text: string;
}

const CASES: Case[] = [
  { file: text('notes.md', '---\ntitle: T\n---\n# Heading\n\nHello **bold** and *it*.\n\n- one\n- two\n'), label: 'Markdown', text: 'Heading\nHello bold and it.\none\ntwo' },
  { file: text('plain.txt', 'line one\nline two'), label: 'Plain Text', text: 'line one\nline two' },
  { file: text('page.html', '<html><head><title>T</title></head><body><h1>Head</h1><p>Para <b>bold</b></p></body></html>'), label: 'Web Page', text: 'Head\nPara bold' },
  { file: text('memo.rtf', '{\\rtf1\\ansi Hello {\\b bold} world\\par Second\\par}'), label: 'Rich Text Format', text: 'Hello bold world\nSecond' },
  { file: text('mail.eml', 'From: a@b.c\nTo: d@e.f\nSubject: Hi there\nContent-Type: text/plain\n\nBody text\n'), label: 'Email Message', text: 'Hi there\nFrom: a@b.c\nTo: d@e.f\n\nBody text' },
  {
    file: text('nb.ipynb', JSON.stringify({ cells: [{ cell_type: 'markdown', source: ['# NB\n', 'text'] }, { cell_type: 'code', source: ['print(1)'], outputs: [], execution_count: null }], metadata: {}, nbformat: 4, nbformat_minor: 5 })),
    label: 'Jupyter Notebook',
    text: 'NB\ntext\nprint(1)',
  },
  { file: text('paper.tex', '\\documentclass{article}\\begin{document}\\section{Intro}Hello \\textbf{bold}.\\end{document}'), label: 'LaTeX', text: 'Intro\nHello bold.' },
  { file: text('todo.org', '* Heading\nHello *bold* text\n'), label: 'Org Mode', text: 'Heading\nHello bold text' },
  { file: text('guide.adoc', '= Title\n\n== Sec\n\nHello *bold* text\n'), label: 'AsciiDoc', text: 'Title\nSec\nHello bold text' },
  { file: text('readme.rst', 'Title\n=====\n\nHello **bold** text\n'), label: 'reStructuredText', text: 'Title\nHello bold text' },
  { file: text('page.textile', 'h1. Head\n\nHello *bold* text\n'), label: 'Textile', text: 'Head\nHello bold text' },
  { file: text('page.wiki', "= Head =\nHello '''bold''' text\n"), label: 'MediaWiki Markup', text: 'Head\nHello bold text' },
  { file: text('paper.typ', '#set page(paper: "a4")\n= Head\n\nHello *bold* text\n'), label: 'Typst', text: 'Head\nHello bold text' },
  { file: text('guide.dbk', '<article xmlns="http://docbook.org/ns/docbook" version="5.0"><title>Head</title><para>Hello <emphasis role="bold">bold</emphasis> text</para></article>'), label: 'DocBook', text: 'Head\nHello bold text' },
  // DocBook and JATS files are usually just .xml: the root element says which they are.
  { file: text('paper.xml', '<article dtd-version="1.3"><front><article-meta><title-group><article-title>Head</article-title></title-group></article-meta></front><body><p>Hello <bold>bold</bold> text</p></body></article>'), label: 'JATS', text: 'Head\nHello bold text' },
  { file: text('book.fb2', '<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"><body><section><title><p>Head</p></title><p>Hello <strong>bold</strong> text</p></section></body></FictionBook>'), label: 'FictionBook', text: 'Head\nHello bold text' },
  { file: text('plan.opml', '<opml version="2.0"><head><title>Head</title></head><body><outline text="one"><outline text="two"/></outline></body></opml>'), label: 'OPML', text: 'Head\none\ntwo' },
];

for (const c of CASES) {
  test(`importing ${c.file.name} opens it as ${c.label}`, async ({ app }) => {
    await app.goto('?doc=welcome');
    await importFile(app, c.file);
    expect(await app.text()).toBe(c.text);
    expect(await formatLabel(app.page)).toBe(c.label);
    await expect(app.page).toHaveTitle(`${c.file.name} - Golem Docs`);
    // Ready, or already saved (the autosave's message replaces it a moment later).
    expect(await status(app.page)).toMatch(new RegExp(`${c.file.name.replace('.', '\\.')}: ready|Saved “${c.file.name.replace('.', '\\.')}” in this browser`));
  });
}

test('a CSV opens as a table: one cell per value, quoted commas kept together', async ({ app }) => {
  await app.goto('?doc=welcome');
  await importFile(app, text('people.csv', 'name,city\n"Smith, J",Paris\nBob,"New ""York"""\n'));
  expect(await formatLabel(app.page)).toBe('CSV (Comma-Separated)');
  expect(await app.text()).toBe('name\ncity\nSmith, J\nParis\nBob\nNew "York"\n');
  // A grid of text: the Table menu is offered, and there is no font or picture formatting.
  const table = await menuContents(app, 'Table');
  expect(table).not.toBeNull();
  expect(await menuContents(app, 'Format').then((m) => m?.items ?? [])).toEqual(['Change Case']);
  expect(hasItem(await menuContents(app, 'Insert'), 'Picture')).toBe(false);
});

test('a TSV opens as a table', async ({ app }) => {
  await app.goto('?doc=welcome');
  await importFile(app, text('grid.tsv', 'x\ty\n1\t2\n'));
  expect(await formatLabel(app.page)).toBe('TSV (Tab-Separated)');
  expect(await app.text()).toBe('x\ny\n1\n2\n');
  expect(await menuContents(app, 'Table')).not.toBeNull();
});

test('a Markdown table becomes a table and its front matter stays out of the text', async ({ app }) => {
  await app.goto('?doc=welcome');
  await importFile(app, text('t.md', '---\nauthor: Me\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |\n'));
  const body = await app.text();
  expect(body).toBe('a\nb\n1\n2');
  expect(body).not.toContain('author');
});

test('a file with an unfamiliar extension opens as text when it is text', async ({ app }) => {
  await app.goto('?doc=welcome');
  await importFile(app, text('settings.xyz', 'key = value\nother = 2'));
  expect(await formatLabel(app.page)).toBe('Plain Text');
  expect(await app.text()).toBe('key = value\nother = 2');
  await expect(app.page).toHaveTitle('settings.xyz - Golem Docs');
});

test('a binary file of an unknown type is refused with a message', async ({ app }) => {
  await app.goto('?doc=welcome');
  const [chooser] = await Promise.all([app.page.waitForEvent('filechooser'), app.menu('File', 'Import…')]);
  await chooser.setFiles({ name: 'blob.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([0, 1, 2, 3, 0, 255, 254, 0, 0, 7]) });
  await expect.poll(() => status(app.page)).toContain('Opening BIN files isn’t supported yet (blob.bin)');
  // The welcome document is still what is open.
  await expect(app.page).toHaveTitle(/Welcome to Golem Docs/);
  expect(await app.text()).toContain('Welcome to Golem Docs');
});

test('importing a second file replaces the first in the editor', async ({ app }) => {
  await app.goto('?doc=welcome');
  await importFile(app, text('one.txt', 'first'));
  expect(await app.text()).toBe('first');
  await importFile(app, text('two.md', 'second'));
  expect(await app.text()).toBe('second');
  expect(await formatLabel(app.page)).toBe('Markdown');
});

test('an imported file is kept: it is in the recent list and survives a reload', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await importFile(app, text('keep.md', '# Kept\n\nstill here'));
  await expect.poll(() => page.url()).toContain('doc=local%3A');
  await page.reload();
  await app.ready();
  expect(await app.text()).toBe('Kept\nstill here');
  await expect(page).toHaveTitle('keep.md - Golem Docs');
});
