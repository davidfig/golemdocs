// The menus and toolbars follow what the open format can express: a Word document gets everything,
// Markdown a subset, plain text almost nothing, a PDF only annotations, a picture its own tools.

import { expect, test } from './fixtures';
import { blankWith, buildPng, convertTo, hasItem, importFile, menuContents, text } from './helpers';

const exact = (app: { page: import('@playwright/test').Page }, name: string) => app.page.getByRole('toolbar').getByRole('button', { name, exact: true });

test('Word document: every menu is offered in full', async ({ app }) => {
  await app.blank();
  const insert = await menuContents(app, 'Insert');
  for (const item of ['Break', 'Page Numbers', 'Comment', 'Footnote', 'Picture', 'Text Box', 'Table', 'Horizontal Line', 'Hyperlink', 'Bookmark', 'Equation']) expect(hasItem(insert, item), item).toBe(true);
  expect(hasItem(insert, 'Code Block')).toBe(false);
  const format = await menuContents(app, 'Format');
  for (const item of ['Font', 'Paragraph', 'Bullets and Numbering', 'Borders and Shading', 'Columns', 'Tabs', 'Styles']) expect(hasItem(format, item), item).toBe(true);
  expect(hasItem(await menuContents(app, 'File'), 'Page Setup')).toBe(true);
});

test('Markdown: structure and links, but no pictures, comments or page layout', async ({ app }) => {
  await app.goto('?doc=welcome');
  await importFile(app, text('a.md', '# H\n\nhello'));
  const insert = await menuContents(app, 'Insert');
  for (const item of ['Table', 'Horizontal Line', 'Code Block', 'Hyperlink']) expect(hasItem(insert, item), item).toBe(true);
  for (const item of ['Picture', 'Comment', 'Footnote', 'Page Numbers', 'Text Box', 'Equation']) expect(hasItem(insert, item, true), item).toBe(false);
  const format = await menuContents(app, 'Format');
  expect(hasItem(format, 'Styles')).toBe(true);
  expect(hasItem(format, 'Borders and Shading', true)).toBe(false);
  expect(hasItem(format, 'Columns', true)).toBe(false);
  expect(hasItem(await menuContents(app, 'File'), 'Page Setup', true)).toBe(false);
});

test('HTML: pictures and code blocks, but no comments or footnotes', async ({ app }) => {
  await app.goto('?doc=welcome');
  await importFile(app, text('a.html', '<p>hi</p>'));
  const insert = await menuContents(app, 'Insert');
  for (const item of ['Picture', 'Table', 'Code Block', 'Hyperlink']) expect(hasItem(insert, item), item).toBe(true);
  for (const item of ['Comment', 'Footnote', 'Page Numbers']) expect(hasItem(insert, item, true), item).toBe(false);
});

test('plain text: no formatting at all, and no tables or pictures', async ({ app }) => {
  await app.goto('?doc=welcome');
  await importFile(app, text('a.txt', 'hello'));
  const insert = await menuContents(app, 'Insert');
  for (const item of ['Table', 'Picture', 'Hyperlink', 'Horizontal Line', 'Code Block', 'Comment']) expect(hasItem(insert, item, true), item).toBe(false);
  expect(hasItem(insert, 'Date and Time')).toBe(true);
  expect((await menuContents(app, 'Format'))?.items).toEqual(['Change Case']);
  expect(await menuContents(app, 'Table')).toBeNull();
  // The menus still open documents, find text and download.
  for (const item of ['Download', 'Convert To', 'Print']) expect(hasItem(await menuContents(app, 'File'), item)).toBe(true);
  expect(hasItem(await menuContents(app, 'Edit'), 'Find')).toBe(true);
});

test('CSV: a grid has tables and nothing else', async ({ app }) => {
  await app.goto('?doc=welcome');
  await importFile(app, text('a.csv', 'a,b\n1,2\n'));
  const insert = await menuContents(app, 'Insert');
  expect(hasItem(insert, 'Table')).toBe(true);
  for (const item of ['Picture', 'Hyperlink', 'Code Block']) expect(hasItem(insert, item, true), item).toBe(false);
  expect((await menuContents(app, 'Format'))?.items).toEqual(['Change Case']);
  expect(await menuContents(app, 'Table')).not.toBeNull();
});

test('markup formats (LaTeX) keep structure and simple marks only', async ({ app }) => {
  await app.goto('?doc=welcome');
  await importFile(app, text('a.tex', 'hello'));
  const insert = await menuContents(app, 'Insert');
  for (const item of ['Table', 'Code Block', 'Hyperlink']) expect(hasItem(insert, item), item).toBe(true);
  for (const item of ['Picture', 'Comment', 'Footnote']) expect(hasItem(insert, item, true), item).toBe(false);
  expect(hasItem(await menuContents(app, 'File'), 'Page Setup', true)).toBe(false);
});

test('a picture document has the Picture menu and no text formatting', async ({ app }) => {
  await app.goto('?doc=welcome');
  await importFile(app, { name: 'p.png', buffer: buildPng(30, 30) });
  expect(await menuContents(app, 'Format')).toBeNull();
  expect(await menuContents(app, 'Table')).toBeNull();
  const edit = await menuContents(app, 'Edit');
  expect(hasItem(edit, 'Cut', true)).toBe(false);
  expect(hasItem(edit, 'Paste', true)).toBe(false);
  expect(hasItem(edit, 'Copy', true)).toBe(true);
  expect(hasItem(await menuContents(app, 'Picture'), 'Rotate Left')).toBe(true);
});

test('a PDF can only be marked up: a Format menu with characters only, annotation buttons, and no Table menu', async ({ app }) => {
  await blankWith(app, 'Some words');
  await convertTo(app, 'PDF (.pdf)', 'PDF');
  const file = await app.download(() => app.menu('File', 'Download'));
  await importFile(app, { name: 'p.pdf', buffer: file.bytes });
  expect((await menuContents(app, 'Format'))?.items).toEqual(['Character']);
  expect(await menuContents(app, 'Table')).toBeNull();
  const edit = await menuContents(app, 'Edit');
  expect(hasItem(edit, 'Cut', true)).toBe(false);
  expect(hasItem(edit, 'Copy', true)).toBe(false);
  expect(hasItem(edit, 'Select All', true)).toBe(false);
  expect(hasItem(edit, 'Find')).toBe(true);
  await expect(exact(app, 'Underline')).toBeVisible();
  await expect(exact(app, 'Strikethrough')).toBeVisible();
  await expect(exact(app, 'Highlight')).toBeVisible();
});

test('toolbar buttons follow the format too (no underline or highlight in plain text)', async ({ app }) => {
  await app.goto('?doc=welcome');
  await importFile(app, text('a.txt', 'hello'));
  await expect(exact(app, 'Copy')).toBeVisible();
  await expect(exact(app, 'Underline')).toHaveCount(0);
  await expect(exact(app, 'Highlight')).toHaveCount(0);
});
